import type { mastodon } from 'masto'
import type { Ref } from 'vue'
import type { CandidateSource, ForYouSignals, PostCandidate } from './types'
import { EMPTY_SIGNALS } from './types'

/**
 * Candidate sourcing and pre-scoring filtering for the "For You" feed.
 *
 * X's home-mixer fans out to several retrieval systems and merges the results:
 * `thunder` (recent in-network posts, held in memory), `phoenix` retrieval
 * (posts whose embedding is nearest the viewer's), `simclusters` (engagement
 * clusters) and `tweet_mixer` (follow-graph expansion). Their per-source
 * `max_results` are large on purpose — 1200 / 1000 / 800 / 800, roughly 3,800
 * candidates retrieved to serve about 35. That ~100:1 selection ratio *is* the
 * algorithm: a ranker handed 40 candidates for a 20-post viewport cannot
 * express a preference, it can only reorder a timeline that was already
 * chosen for it.
 *
 * So this module is built around a **pool**, not around a request. Each source
 * is walked several pages deep, bounded by page count and by its own age
 * horizon; the merged result is held in a module-scoped pool that callers page
 * through and that refills in the background as it drains. `feed.ts` consumes
 * the pool API at the bottom of this file.
 *
 * | X source            | our analog                                            |
 * | ------------------- | ----------------------------------------------------- |
 * | `thunder`           | `home` — accounts the viewer follows, walked deep      |
 * | (no equivalent)     | `list` — hand-curated lists, the highest precision     |
 * | `phoenix` retrieval | `tag` — followed tags, engaged tags, *and* trend tags  |
 * | `simclusters`       | `trending` — the instance's own engagement signal      |
 * | `tweet_mixer`       | `network2hop` — `/api/v2/suggestions`, friends-of-…    |
 * | (no equivalent)     | `federated` / `local` — the instance's firehoses       |
 *
 * That `tweet_mixer` row needs a caveat: `EnableTweetMixerSource` defaults to
 * `false` in `home-mixer/params/param.rs`, so production X currently runs
 * with that source disabled. `network2hop`'s justification is its own — see
 * the comment on `resolveTwoHopAccounts` — not "X does this too."
 *
 * Every source is individually fault-tolerant and individually time-boxed.
 * Plenty of instances disable the federated timeline, run trends off, or 404 on
 * tag timelines; a dead *or slow* source must cost us its candidates and
 * nothing else.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** `AgeFilter` in home-mixer drops anything older than 48 hours. */
export const MAX_CANDIDATE_AGE_MS = 48 * 60 * 60 * 1000

/**
 * Trending posts are the one genuinely curated out-of-network source we have,
 * and they are curated precisely *because* engagement accumulated on them over
 * days. X's simclusters candidates arrive pre-filtered near the 48h mark; ours
 * do not, and a flat 48h cutoff throws most of the trending page away. Hence a
 * per-source horizon rather than one constant.
 */
export const TRENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** The horizon used when the result-size floor forces the age filter open. */
export const RELAXED_MAX_AGE_MS = TRENDING_MAX_AGE_MS

export const SOURCE_MAX_AGE_MS: Record<CandidateSource, number> = {
  home: MAX_CANDIDATE_AGE_MS,
  list: MAX_CANDIDATE_AGE_MS,
  federated: MAX_CANDIDATE_AGE_MS,
  local: MAX_CANDIDATE_AGE_MS,
  tag: MAX_CANDIDATE_AGE_MS,
  network2hop: MAX_CANDIDATE_AGE_MS,
  trending: TRENDING_MAX_AGE_MS,
}

/** The 2-hop follow-graph expansion — X's `tweet_mixer`. */
const TWO_HOP_SOURCE: CandidateSource = 'network2hop'
/** Hand-curated list timelines. */
const LIST_SOURCE: CandidateSource = 'list'

/**
 * Sources that are in-network by construction, with no lookup required.
 *
 * The home timeline is the definition of in-network, and a Mastodon list can
 * only contain accounts the viewer already follows — the API refuses to add
 * anyone else. Both therefore skip the relationships round trip, and both seed
 * the follow set for the out-of-network sources.
 */
const IN_NETWORK_SOURCES = new Set<CandidateSource>(['home', 'list'])

/** Page size asked of each timeline. Mastodon caps most of these at 40. */
export const DEFAULT_SOURCE_LIMIT = 40

/** How deep to walk each source. Bounded again by the age horizon. */
export const DEFAULT_SOURCE_PAGES: Record<string, number> = {
  home: 5,
  federated: 4,
  local: 4,
  trending: 2,
  tag: 2,
  list: 1,
  twohop: 1,
}

/** How many tag timelines to query. */
export const DEFAULT_TAG_FANOUT = 5
/** How many curated lists to pull. */
export const DEFAULT_LIST_FANOUT = 3
/** How many 2-hop accounts to pull statuses from. */
export const DEFAULT_TWO_HOP_FANOUT = 8

/** Per-page wait before we give up on a source and keep what it already gave. */
export const DEFAULT_PAGE_TIMEOUT_MS = 8000

/** Sockets we are willing to hold open against one instance at once. */
export const DEFAULT_CONCURRENCY = 8

/** What a healthy pool holds. X retrieves ~3,800 for ~35 served. */
export const POOL_TARGET = 800
/** Below this the pool refills in the background. */
export const POOL_REFILL_FLOOR = 120
/** A pool older than this is refetched rather than resumed. */
export const POOL_STALE_MS = 5 * 60 * 1000
/** Served ids remembered so a refill cannot resurrect them. */
const MAX_SERVED_MEMORY = 5000

/** `ResultSizeFilter` analog: never hand back less than a viewport. */
export const PRE_SCORING_FLOOR = 24

/**
 * Rate budget. A full fill costs ~40 requests plus relationship batches, out of
 * the 300-per-5-minutes Mastodon allows *for the whole app* — the rest of Elk
 * shares it. So two guards:
 *
 * - a minimum interval between fills, so reloading, switching accounts or
 *   flipping tabs a few times a minute cannot spend the budget on refetching
 *   what we already have;
 * - a hard backoff once the server actually says 429, respected regardless of
 *   pool state, because at that point we have been told to stop.
 */
export const MIN_FILL_INTERVAL_MS = 10_000
export const RATE_LIMIT_BACKOFF_MS = 60_000
/** However long a server claims, we retry within the hour. */
export const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60_000

/** Relationships are batched; Mastodon accepts comfortably more than this. */
export const RELATIONSHIP_BATCH_SIZE = 40
/** Authors we are willing to resolve relationships for in one fill. */
export const MAX_RELATIONSHIP_LOOKUPS = 400
export const FOLLOW_CACHE_TTL_MS = 10 * 60 * 1000

/** Visibilities a discovery feed may show. `direct` is never eligible. */
const OPEN_VISIBILITIES = new Set<mastodon.v1.StatusVisibility>(['public', 'unlisted'])

/** Tags arrive with or without their `#`, depending on where they came from. */
const LEADING_HASH_RE = /^#/

// ---------------------------------------------------------------------------
// Pure helpers — no Nuxt, no network, unit-testable on their own.
// ---------------------------------------------------------------------------

/**
 * The post a candidate *really* is. A boost is a wrapper around someone else's
 * status, the way a retweet in home-mixer carries `retweeted_tweet_id`.
 */
export function underlyingStatus(status: mastodon.v1.Status): mastodon.v1.Status {
  return status.reblog ?? status
}

/**
 * The identity two candidates are compared on.
 *
 * This collapses `DropDuplicatesFilter` (same post from two sources) and
 * `RetweetDeduplicationFilter` (a post and any number of boosts of it) into a
 * single key, because on Mastodon they are the same problem: the federated and
 * home timelines routinely hand back the same status wrapped differently.
 */
export function candidateKey(status: mastodon.v1.Status): string {
  return status.reblog?.id ?? status.id
}

/** Every id a candidate occupies — both the boost and the post it wraps. */
function candidateIds(status: mastodon.v1.Status): string[] {
  return status.reblog ? [status.id, status.reblog.id] : [status.id]
}

export function createCandidate(
  status: mastodon.v1.Status,
  source: CandidateSource,
  inNetwork = false,
): PostCandidate {
  return { status, sources: new Set([source]), inNetwork }
}

function toSet(ids: Iterable<string> | undefined): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids ?? [])
}

interface MergeSlot {
  sources: Set<CandidateSource>
  inNetwork: boolean
  first: PostCandidate
  bareOriginal?: PostCandidate
  inNetworkBoost?: PostCandidate
}

/**
 * Merges candidates that are the same post.
 *
 * The merged candidate keeps *every* source that produced it — that a post
 * showed up in the home timeline **and** in trends **and** under a tag the
 * viewer follows is exactly the kind of corroboration the ranker wants.
 *
 * Which copy represents the group is not cosmetic, and this is a deliberate
 * departure from X. There, `RetweetDeduplicationFilter` runs *after*
 * `OONRetweetReplyFilter`, so an out-of-network retweet is already gone by the
 * time dedup happens and the original survives on its own. We collapse both
 * filters into one pass at the head of the chain, so a naive "first wins" rule
 * would let an out-of-network boost represent the group and then take the
 * original down with it when the OON filter fires. The preference order below
 * avoids that:
 *
 * 1. an **in-network boost** — someone the viewer follows vouched for it, which
 *    is real signal and is what Elk should render;
 * 2. a **bare original** — neutral, and never dropped by the OON filter;
 * 3. whatever arrived first.
 */
export function dedupeCandidates(candidates: PostCandidate[]): PostCandidate[] {
  const slots = new Map<string, MergeSlot>()

  for (const candidate of candidates) {
    if (!candidate?.status)
      continue

    const key = candidateKey(candidate.status)
    const isBoost = !!candidate.status.reblog

    let slot = slots.get(key)
    if (!slot) {
      slot = { sources: new Set(), inNetwork: false, first: candidate }
      slots.set(key, slot)
    }

    for (const source of candidate.sources)
      slot.sources.add(source)

    // In-network is a property of the *post*, not of the copy we happened to
    // see first: if any source proved the viewer follows the author, it holds.
    slot.inNetwork ||= candidate.inNetwork

    if (isBoost) {
      if (!slot.inNetworkBoost && candidate.inNetwork)
        slot.inNetworkBoost = candidate
    }
    else if (!slot.bareOriginal) {
      slot.bareOriginal = candidate
    }
  }

  return Array.from(slots.values(), (slot) => {
    const chosen = slot.inNetworkBoost ?? slot.bareOriginal ?? slot.first
    return { ...chosen, sources: slot.sources, inNetwork: slot.inNetwork }
  })
}

/**
 * `CoreDataHydrationFilter`: posts whose text and metadata failed to load.
 *
 * Masto.js hands us fully hydrated statuses, so this is only ever a guard
 * against a malformed payload from a non-Mastodon fediverse server.
 */
export function filterUnhydrated(candidates: PostCandidate[]): PostCandidate[] {
  return candidates.filter((candidate) => {
    const status = candidate.status
    return !!status?.id && !!status.account?.id && !!status.createdAt
  })
}

/** The age horizon that applies to a candidate, given where it came from. */
export function maxAgeForCandidate(candidate: PostCandidate, override?: number): number {
  if (override != null)
    return override
  let max = 0
  for (const source of candidate.sources)
    max = Math.max(max, SOURCE_MAX_AGE_MS[source] ?? MAX_CANDIDATE_AGE_MS)
  return max || MAX_CANDIDATE_AGE_MS
}

/**
 * `AgeFilter`: posts past their source's horizon (48h, or a week for trends).
 *
 * Measured on the candidate itself rather than the post it wraps, which is what
 * home-mixer does (it reads the timestamp out of the retweet's own snowflake
 * id). A boost is a fresh event even when the post it carries is not.
 */
export function filterByAge(
  candidates: PostCandidate[],
  now: number = Date.now(),
  maxAgeMs?: number,
): PostCandidate[] {
  return candidates.filter((candidate) => {
    const createdAt = Date.parse(candidate.status.createdAt)
    if (Number.isNaN(createdAt))
      return false
    // Clocks across the fediverse are not synchronised; a slightly future
    // timestamp is not a reason to drop an otherwise fresh post.
    return now - createdAt <= maxAgeForCandidate(candidate, maxAgeMs)
  })
}

/**
 * `SelfTweetFilter`: the viewer's own posts.
 *
 * Like home-mixer, this looks at the *candidate's* author, so it also removes
 * the viewer's own boosts, while someone else boosting the viewer's post stays
 * eligible — being boosted is a legitimate thing to surface.
 */
export function filterSelfPosts(
  candidates: PostCandidate[],
  viewerAccountId: string | undefined,
): PostCandidate[] {
  if (!viewerAccountId)
    return candidates
  return candidates.filter(candidate => candidate.status.account?.id !== viewerAccountId)
}

export interface NetworkContext {
  viewerAccountId?: string
  followedAccountIds?: ReadonlySet<string>
  /** When true, out-of-network boosts survive (floor relaxation only). */
  keepOonReblogs?: boolean
  /**
   * When true, an out-of-network reply is no longer dropped outright — it is
   * judged by `isReplyContextAvailable` exactly like an in-network reply
   * already is, so it survives when its parent is reachable. Floor relaxation
   * only, and the last resort: a reply whose context genuinely cannot be
   * placed stays dropped regardless of this flag.
   */
  relaxOonReplyContext?: boolean
}

/**
 * Whether a reply arrives with enough context to be worth showing —
 * home-mixer's `ancestors.is_empty()` test.
 *
 * X gets the ancestor chain for free: thunder ships it alongside the post. We
 * would have to spend one `GET /statuses/:id/context` per reply to know, which
 * is an unacceptable N+1 on a feed load. So we approximate "we can show this in
 * context" from what the status already tells us:
 *
 * - the parent is somewhere in this batch (Elk's `reorderTimeline` will thread
 *   them together)
 * - it is a self-reply, i.e. the author continuing their own thread
 * - it replies to the viewer
 * - it replies to someone the viewer follows, so the conversation is in-network
 *
 * Anything else is a reply dropped into the feed with its other half missing,
 * which is precisely what the X filter exists to prevent — and that verdict
 * itself is never relaxed, at any level: see `applyPreScoringFilters`. What
 * is relaxable is who gets judged by it. Strictly, only an in-network
 * reply reaches this check at all; `filterOonRetweetsAndReplies`'s
 * `relaxOonReplyContext` extends the same test to an out-of-network reply as
 * the pool's last resort, rather than dropping every stranger-to-stranger
 * reply unconditionally regardless of whether its parent sits right there in
 * the same batch.
 */
export function isReplyContextAvailable(
  status: mastodon.v1.Status,
  batchIds: ReadonlySet<string>,
  context: NetworkContext = {},
): boolean {
  const parentId = status.inReplyToId
  if (!parentId)
    return true
  if (batchIds.has(parentId))
    return true

  const parentAuthorId = status.inReplyToAccountId
  if (!parentAuthorId)
    return false
  if (parentAuthorId === status.account?.id)
    return true
  if (context.viewerAccountId && parentAuthorId === context.viewerAccountId)
    return true

  return toSet(context.followedAccountIds).has(parentAuthorId)
}

/**
 * `OONRetweetReplyFilter`: boosts and replies from accounts the viewer does not
 * follow, plus any reply whose parent we cannot place.
 *
 * The rationale carries over unchanged: an out-of-network boost is a stranger
 * vouching for a stranger, and an out-of-network reply is half a conversation
 * between two people the viewer has no relationship with.
 *
 * This filter is only as good as `inNetwork`, which is why that flag is
 * resolved against the real relationships endpoint rather than guessed.
 *
 * `keepOonReblogs` and `relaxOonReplyContext` are the two floor-relaxation
 * escape hatches this filter offers — see the ladder in
 * `applyPreScoringFilters`.
 */
export function filterOonRetweetsAndReplies(
  candidates: PostCandidate[],
  context: NetworkContext = {},
): PostCandidate[] {
  const batchIds = new Set(candidates.flatMap(candidate => candidateIds(candidate.status)))

  return candidates.filter((candidate) => {
    const status = candidate.status
    const isReblog = !!status.reblog
    // A boost is not itself a reply, even when the post it wraps is one.
    const isReply = !isReblog && !!status.inReplyToId

    if (!candidate.inNetwork) {
      if (isReblog && !context.keepOonReblogs)
        return false
      if (isReply && !context.relaxOonReplyContext)
        return false
    }

    return !isReply || isReplyContextAvailable(status, batchIds, context)
  })
}

/**
 * `OONNsfwSimclustersFilter`: adult content from accounts the viewer does not
 * follow. **Off by default**, and deliberately so — but not because the X
 * filter is dormant. Checked against `home-mixer/params/param.rs`:
 * `EnableSimclustersSource` defaults to **true**, so `oon_nsfw_simclusters_filter`
 * runs unconditionally in production X. (It is `EnableTweetMixerSource` that
 * defaults to **false** — the source `network2hop` is modeled on is the one
 * that is dark by default; see `resolveTwoHopAccounts` below.)
 *
 * The Rust is narrower than it first looks for a different reason: it requires
 * all three of `served_type == ForYouSimclusters`, `in_network == Some(false)`
 * and `nsfw_author == Some(true)` to remove anything at all. `nsfw_author` is
 * also an *account-level ML label* out of `agatha`/`pnsfwmedia`, not a
 * per-post flag.
 *
 * Mastodon's `sensitive` is a different animal: per-post, self-applied, set by
 * default on any post with a content warning, and used fediverse-wide as
 * courtesy for spoilers, eye contact, food, alcohol and politics. Treating it
 * as an adult-content label would delete exactly the out-of-network content an
 * art or photography instance's feed is made of.
 *
 * So: opt-in, and scoped to the simclusters analog (`trending`) only, matching
 * the `served_type` condition rather than blanketing every OON source.
 */
export function filterOonSensitive(candidates: PostCandidate[]): PostCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.inNetwork)
      return true
    // served_type == ForYouSimclusters: only candidates that came *solely* from
    // the trending source, which is our simclusters stand-in.
    if (!(candidate.sources.size === 1 && candidate.sources.has('trending')))
      return true
    return !underlyingStatus(candidate.status).sensitive
  })
}

/**
 * `IneligibleSubscriptionFilter`: posts the viewer cannot really access.
 *
 * Mastodon has no subscriber-only tier, but it does have restricted
 * visibilities, and the same principle applies: a discovery feed must not
 * amplify something its author scoped narrowly. `direct` is never eligible;
 * `private` (followers-only) only when the viewer follows the author, which is
 * the sole case where the server would have handed it to us at all.
 */
export function filterIneligibleVisibility(candidates: PostCandidate[]): PostCandidate[] {
  return candidates.filter((candidate) => {
    const visibility = underlyingStatus(candidate.status).visibility
    if (!visibility)
      return true
    if (OPEN_VISIBILITIES.has(visibility))
      return true
    return visibility === 'private' && candidate.inNetwork
  })
}

/**
 * `PreviouslySeenPostsFilter` (and its Backup / PreviouslyServed siblings,
 * which are the same idea over a second impression store).
 *
 * X uses bloom filters over impression ids; we use the capped ring buffer in
 * `signals.seen`. Both the boost and the post it wraps are checked, mirroring
 * home-mixer's `related_post_ids_iter`.
 *
 * This is the one filter that can empty the feed permanently — `seen` is a
 * 3000-entry FIFO with no TTL while candidates expire at 48h, so on a small
 * instance the reachable pool eventually fits inside what the viewer has
 * already scrolled. `applyPreScoringFilters` relaxes this first when the
 * result-size floor is not met.
 */
export function filterSeen(
  candidates: PostCandidate[],
  isSeenFn: (id: string) => boolean,
): PostCandidate[] {
  return candidates.filter(candidate => !candidateIds(candidate.status).some(isSeenFn))
}

/**
 * The impressions that may **never** be replayed, however empty the feed gets.
 *
 * `signals.seen` is ordered by last impression (`pushCapped` moves a re-seen id
 * to the end), so its tail is what the viewer just scrolled past. Re-showing
 * that is the single failure mode a user notices fastest — the feed visibly
 * loops — so the tail is exempt from relaxation entirely.
 *
 * It has to be a *share* of the log rather than a flat count: a viewer three
 * minutes into their first session has a 5-entry log, and protecting a flat 100
 * would protect all of it and hand back an empty feed — trading a visible loop
 * for a visibly broken feed. A quarter of the log, capped, always leaves the
 * older three quarters available to replay.
 */
export const RECENTLY_SEEN_PROTECTED = 100
export const RECENTLY_SEEN_PROTECTED_SHARE = 0.25

/** How much of the impression tail is off limits, given its length. */
export function protectedSeenCount(logLength: number, cap = RECENTLY_SEEN_PROTECTED): number {
  return Math.min(cap, Math.floor(logLength * RECENTLY_SEEN_PROTECTED_SHARE))
}

/**
 * The bounded form of relaxing `PreviouslySeenPostsFilter`.
 *
 * Dropping the seen filter outright would replay the viewer's whole history the
 * moment the pool drains, which on a small instance is most of the time. So
 * instead: unseen candidates always come first, and only enough *already-seen*
 * ones are re-admitted to reach the floor — oldest impression first, and never
 * the last `RECENTLY_SEEN_PROTECTED` of them.
 *
 * `seenRank` gives the position of an id in the impression log (lower = longer
 * ago); ids with no rank are treated as least-recently-seen.
 */
export function relaxSeen(
  candidates: PostCandidate[],
  isSeenFn: (id: string) => boolean,
  budget: number,
  seenRank?: (id: string) => number | undefined,
  protectedIds?: ReadonlySet<string>,
): PostCandidate[] {
  const unseen: PostCandidate[] = []
  const replayable: { candidate: PostCandidate, rank: number }[] = []

  for (const candidate of candidates) {
    const idsForCandidate = candidateIds(candidate.status)
    if (!idsForCandidate.some(isSeenFn)) {
      unseen.push(candidate)
      continue
    }
    if (budget <= 0)
      continue
    // Just-scrolled-past posts never come back, at any relaxation level.
    if (protectedIds && idsForCandidate.some(id => protectedIds.has(id)))
      continue
    const ranks = idsForCandidate.map(id => seenRank?.(id)).filter((r): r is number => r != null)
    replayable.push({ candidate, rank: ranks.length ? Math.min(...ranks) : -1 })
  }

  if (budget <= 0 || replayable.length === 0)
    return unseen

  replayable.sort((a, b) => a.rank - b.rank)
  return [...unseen, ...replayable.slice(0, budget).map(entry => entry.candidate)]
}

/**
 * `AuthorSocialgraphFilter`: posts from accounts the viewer blocks or mutes.
 *
 * Mastodon applies real blocks and mutes server-side before we ever see a
 * timeline, so the work left for us is the feed-local mute list
 * (`signals.mutedForYou`) plus any ids the caller hands us. Both the booster
 * and the original author are checked, the way home-mixer also checks
 * `retweeted_user_id` and `quoted_user_id`.
 */
export function filterBlockedAuthors(
  candidates: PostCandidate[],
  blockedOrMutedAccountIds: Iterable<string>,
): PostCandidate[] {
  const blocked = toSet(blockedOrMutedAccountIds)
  if (blocked.size === 0)
    return candidates

  return candidates.filter((candidate) => {
    const status = candidate.status
    const authorIds = [status.account?.id, status.reblog?.account?.id]
    return !authorIds.some(id => !!id && blocked.has(id))
  })
}

/**
 * Posts the viewer explicitly dismissed.
 *
 * X has no pre-scoring filter for this — "not interested" is a *label* there,
 * fed back into training and carrying a large negative ranking weight. We have
 * no model to retrain, so a dismissal has to act as a hard drop as well as the
 * affinity penalty `signals.ts` applies. Never relaxed by the floor logic.
 */
export function filterNotInterested(
  candidates: PostCandidate[],
  notInterestedIds: Iterable<string>,
): PostCandidate[] {
  const dismissed = toSet(notInterestedIds)
  if (dismissed.size === 0)
    return candidates

  return candidates.filter(candidate => !candidateIds(candidate.status).some(id => dismissed.has(id)))
}

/**
 * Recomputes `inNetwork` against the follow set, mirroring
 * `InNetworkCandidateHydrator` — which keys on the candidate's own author, so a
 * boost is in-network when the *booster* is followed.
 *
 * Returns a new array; nothing in this module mutates candidates in place.
 */
export function hydrateInNetwork(
  candidates: PostCandidate[],
  followedAccountIds: ReadonlySet<string>,
): PostCandidate[] {
  if (followedAccountIds.size === 0)
    return candidates

  return candidates.map((candidate) => {
    const authorId = candidate.status.account?.id
    if (candidate.inNetwork || !authorId || !followedAccountIds.has(authorId))
      return candidate
    return { ...candidate, inNetwork: true }
  })
}

/**
 * Last-resort follow set, inferred from the candidates themselves.
 *
 * Only used when the relationships endpoint is unavailable. It is a poor
 * substitute — everything the home timeline returned is from an account the
 * viewer follows, but a viewer following 500 accounts sees perhaps 20 distinct
 * authors in one page, biased toward high-volume posters, and every miss is a
 * false negative that gets an account the viewer *does* follow treated as a
 * stranger. Prefer `resolveFollowedAccountIds`.
 */
export function deriveFollowedAccountIds(candidates: PostCandidate[]): Set<string> {
  const followed = new Set<string>()
  for (const candidate of candidates) {
    const authorId = candidate.status.account?.id
    if (candidate.inNetwork && authorId)
      followed.add(authorId)
  }
  return followed
}

// ---------------------------------------------------------------------------
// The real follow set
// ---------------------------------------------------------------------------

interface FollowCache {
  owner: string
  following: Map<string, boolean>
  at: number
}

let followCache: FollowCache | undefined

function ownerKey(): string {
  try {
    return currentUser.value?.account?.acct ?? '[anonymous]'
  }
  catch {
    return '[anonymous]'
  }
}

function getFollowCache(now: number): FollowCache {
  const owner = ownerKey()
  if (!followCache || followCache.owner !== owner || now - followCache.at > FOLLOW_CACHE_TTL_MS)
    followCache = { owner, following: new Map(), at: now }
  return followCache
}

/** Drops the memoized follow set — call on logout or account switch. */
export function resetFollowCache() {
  followCache = undefined
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

export interface ResolveFollowOptions {
  now?: number
  /** Cap on ids resolved in one go; the rest fall back to `deriveFollowed…`. */
  max?: number
  concurrency?: number
  onError?: (error: unknown) => void
}

/**
 * Resolves which of `accountIds` the viewer actually follows, exactly.
 *
 * `GET /api/v1/accounts/relationships?id[]=…` is a **batch** endpoint returning
 * a `following` boolean per account — this is the same call
 * `masto/relationship.ts` already makes for the UI, and the direct analog of
 * home-mixer's `FollowedUserIdsQueryHydrator`, which X runs on every request at
 * 500M-user scale. We only ever need it for the few hundred distinct authors in
 * a candidate batch, in chunks of 40, after the fan-out and off its critical
 * path. There is no excuse for guessing.
 *
 * Results are memoized per account for `FOLLOW_CACHE_TTL_MS`, and the cache is
 * warmed from whatever the UI already fetched.
 */
export async function resolveFollowedAccountIds(
  client: mastodon.rest.Client,
  accountIds: Iterable<string>,
  options: ResolveFollowOptions = {},
): Promise<Set<string>> {
  const now = options.now ?? Date.now()
  const cache = getFollowCache(now)
  const viewerId = (() => {
    try {
      return currentUser.value?.account?.id
    }
    catch {
      return undefined
    }
  })()

  const wanted: string[] = []
  for (const id of accountIds) {
    if (!id || id === viewerId || cache.following.has(id))
      continue
    // Reuse anything the UI already resolved for this account.
    try {
      const known = getCachedRelationship(id)
      if (known) {
        cache.following.set(id, !!known.following)
        continue
      }
    }
    catch {
      // relationship.ts unavailable (bare unit test); fall through to fetching.
    }
    if (!wanted.includes(id))
      wanted.push(id)
  }

  const limited = wanted.slice(0, options.max ?? MAX_RELATIONSHIP_LOOKUPS)
  const fetchRelationships = client?.v1?.accounts?.relationships?.fetch
  if (limited.length && typeof fetchRelationships === 'function') {
    const limit = createLimiter(options.concurrency ?? DEFAULT_CONCURRENCY)
    await Promise.allSettled(chunk(limited, RELATIONSHIP_BATCH_SIZE).map(ids => limit(async () => {
      try {
        const relationships = await client.v1.accounts.relationships.fetch({ id: ids })
        for (const relationship of relationships)
          cache.following.set(relationship.id, !!relationship.following)
      }
      catch (error) {
        options.onError?.(error)
      }
    })))
  }

  const followed = new Set<string>()
  for (const [id, following] of cache.following) {
    if (following)
      followed.add(id)
  }
  return followed
}

// ---------------------------------------------------------------------------
// Pre-scoring filters
// ---------------------------------------------------------------------------

export interface PreScoringContext {
  /** Defaults to the logged-in account. */
  viewerAccountId?: string
  /** The exact follow set. Falls back to `deriveFollowedAccountIds`. */
  followedAccountIds?: Iterable<string>
  /** Extra ids to drop on top of Mastodon's own server-side block/mute pass. */
  blockedAccountIds?: Iterable<string>
  now?: number
  /** Overrides the per-source age horizon. */
  maxAgeMs?: number
  /** Defaults to `signals.seen`, falling back to the live `isSeen()`. */
  isSeen?: (id: string) => boolean
  /** Impression-log position of an id; defaults to the index in `signals.seen`. */
  seenRank?: (id: string) => number | undefined
  /** Ids relaxation may never replay; defaults to the tail of `signals.seen`. */
  protectedSeenIds?: Iterable<string>
  /** How much of the impression tail is protected. Defaults to 100. */
  recentlySeenProtected?: number
  /** Set false in unit tests, where there is no Nuxt app to read settings from. */
  useMastodonFilters?: boolean
  /** `OONNsfwSimclustersFilter` analog. Off by default — see the filter. */
  dropOonSensitive?: boolean
  filterContext?: mastodon.v1.FilterContext
  /** `ResultSizeFilter` analog: relax rather than return less than this. */
  floor?: number
  /** Reports how far the chain had to be relaxed to meet the floor. */
  onRelax?: (level: FilterRelaxation, kept: number) => void
}

/**
 * How far the chain has been opened up to meet the result-size floor.
 *
 * X keeps result size up with `ResultSizeFilter` plus `quality_factor`
 * backpressure on the sources. We cannot turn a knob on a Mastodon instance, so
 * the equivalent is to drop the *discretionary* constraints in order of how
 * little they cost the viewer. User intent and safety — self posts, blocks,
 * mutes, dismissals, keyword filters, visibility — are never relaxed.
 *
 * 0. strict — every filter below runs at full strength.
 * 1. bounded replay of already-seen posts (`relaxSeen`).
 * 2. the age horizon opens to a week (`RELAXED_MAX_AGE_MS`).
 * 3. out-of-network boosts survive (`keepOonReblogs`).
 * 4. out-of-network replies are judged by `isReplyContextAvailable` instead
 *    of being dropped outright (`relaxOonReplyContext`) — the last resort,
 *    because on a typical federated/local/tag fan-out a large share of the
 *    content *is* replies between strangers, and until this level none of it
 *    could ever reach the pool no matter how badly the floor was missed.
 *
 * Reply reachability itself is never relaxed at any level, including this
 * one: a reply whose parent cannot be placed anywhere is unreadable and stays
 * dropped. Level 4 only widens *who* gets tested by that reachability check.
 */
export type FilterRelaxation = 0 | 1 | 2 | 3 | 4

function resolveViewerAccountId(context: PreScoringContext): string | undefined {
  if (context.viewerAccountId)
    return context.viewerAccountId
  try {
    return currentUser.value?.account?.id
  }
  catch {
    return undefined
  }
}

function resolveSeenFn(signals: ForYouSignals, context: PreScoringContext) {
  if (context.isSeen)
    return context.isSeen

  const seen = new Set(signals?.seen ?? [])
  return (id: string) => {
    if (seen.has(id))
      return true
    // `isSeen()` reads the live per-account ref, which is the source of truth
    // inside the app and simply unavailable in a bare unit test.
    try {
      return isSeen(id)
    }
    catch {
      return false
    }
  }
}

/**
 * `MutedKeywordFilter`, delegated to the server and to Elk.
 *
 * Mastodon evaluates the viewer's keyword filters itself and returns the
 * verdict on each status as `filtered[]`, so there is no tokenizer to port —
 * `removeFilteredItems` already reads exactly that. `removeUserPreferenceItems`
 * then applies the viewer's own "hide boosts / hide replies" settings, so the
 * For You feed obeys the same preferences as every other Elk timeline.
 */
function applyMastodonFilters(
  candidates: PostCandidate[],
  filterContext: mastodon.v1.FilterContext,
): PostCandidate[] {
  const byStatus = new Map<mastodon.v1.Status, PostCandidate>()
  for (const candidate of candidates)
    byStatus.set(candidate.status, candidate)

  const pick = (statuses: mastodon.v1.Status[]) =>
    statuses.map(status => byStatus.get(status)).filter((c): c is PostCandidate => !!c)

  let kept = candidates
  try {
    kept = pick(removeFilteredItems(kept.map(c => c.status), filterContext))
  }
  catch {
    // No Nuxt app (unit tests): leave the batch alone rather than lose it.
  }
  try {
    kept = pick(removeUserPreferenceItems(kept.map(c => c.status), filterContext))
  }
  catch {}

  return kept
}

/** Position in the impression log; lower means the viewer saw it longer ago. */
function seenRankOf(signals: ForYouSignals, context: PreScoringContext) {
  if (context.seenRank)
    return context.seenRank
  const ranks = new Map<string, number>()
  const log = signals?.seen ?? []
  for (let i = 0; i < log.length; i++)
    ranks.set(log[i]!, i)
  return (id: string) => ranks.get(id)
}

/** The tail of the impression log, which relaxation must never replay. */
function protectedSeenIds(signals: ForYouSignals, context: PreScoringContext): ReadonlySet<string> {
  if (context.protectedSeenIds)
    return toSet(context.protectedSeenIds)
  const log = signals?.seen ?? []
  const keep = protectedSeenCount(log.length, context.recentlySeenProtected ?? RECENTLY_SEEN_PROTECTED)
  return new Set(keep > 0 ? log.slice(-keep) : [])
}

function runFilterChain(
  deduped: PostCandidate[],
  signals: ForYouSignals,
  context: PreScoringContext,
  viewerAccountId: string | undefined,
  followedAccountIds: ReadonlySet<string>,
  relaxation: FilterRelaxation,
  seenBudget: number,
): PostCandidate[] {
  // CoreDataHydrationFilter
  let kept = filterUnhydrated(deduped)
  kept = hydrateInNetwork(kept, followedAccountIds)

  // AgeFilter — level 2 opens the horizon to a week.
  kept = filterByAge(kept, context.now, relaxation >= 2 ? RELAXED_MAX_AGE_MS : context.maxAgeMs)

  // SelfTweetFilter — never relaxed.
  kept = filterSelfPosts(kept, viewerAccountId)

  // OONRetweetReplyFilter — level 3 keeps out-of-network boosts. Level 4
  // stops dropping out-of-network replies unconditionally and instead judges
  // them by isReplyContextAvailable, same as an in-network reply always was —
  // so a reply whose parent is reachable (in the same batch, a self-reply, or
  // addressed to the viewer/a followed account) can survive even though its
  // author is a stranger. A reply with no reachable parent at all stays
  // dropped at every level: it really is unreadable.
  kept = filterOonRetweetsAndReplies(kept, {
    viewerAccountId,
    followedAccountIds,
    keepOonReblogs: relaxation >= 3,
    relaxOonReplyContext: relaxation >= 4,
  })

  // OONNsfwSimclustersFilter — opt-in.
  if (context.dropOonSensitive ?? false)
    kept = filterOonSensitive(kept)

  // IneligibleSubscriptionFilter — never relaxed.
  kept = filterIneligibleVisibility(kept)

  // PreviouslySeenPostsFilter — the filter that can empty the feed permanently,
  // so it is the first to give. From level 1 it is *bounded*, not dropped: only
  // `seenBudget` already-seen posts come back, oldest impression first, and
  // never the ones the viewer just scrolled past. See `relaxSeen`.
  const seenFn = resolveSeenFn(signals, context)
  kept = relaxation < 1
    ? filterSeen(kept, seenFn)
    : relaxSeen(kept, seenFn, seenBudget, seenRankOf(signals, context), protectedSeenIds(signals, context))

  // MutedKeywordFilter — never relaxed.
  if (context.useMastodonFilters ?? true)
    kept = applyMastodonFilters(kept, context.filterContext ?? 'home')

  // AuthorSocialgraphFilter — never relaxed.
  kept = filterBlockedAuthors(kept, [
    ...(signals?.mutedForYou ?? []),
    ...(context.blockedAccountIds ?? []),
  ])

  // "Not interested" — never relaxed.
  kept = filterNotInterested(kept, signals?.notInterested ?? [])

  return kept
}

/**
 * The pre-scoring filter chain, following home-mixer's order
 * (see the "Filtering" table in the x-algorithm README).
 *
 * One documented reordering: X runs `DropDuplicatesFilter` first and
 * `RetweetDeduplicationFilter` *after* `OONRetweetReplyFilter`. We run both at
 * the head as a single merge pass, because on Mastodon they are one problem —
 * see `dedupeCandidates` for how the representative is chosen so that the
 * reordering cannot drop a post along with an out-of-network boost of it.
 *
 * Ported: `DropDuplicates` + `RetweetDeduplication`, `CoreDataHydration`,
 * `Age`, `SelfTweet`, `OONRetweetReply`, `OONNsfwSimclusters` (opt-in),
 * `IneligibleSubscription`, `PreviouslySeen` (+ Backup + `PreviouslyServed`,
 * one store instead of three), `MutedKeyword`, `AuthorSocialgraph`,
 * `ResultSize` (as the floor/relaxation loop).
 *
 * Skipped, with reasons:
 * - `VideoFilter` — Elk never requests a video-only feed.
 * - `TopicIdsFilter` — Mastodon has no topic taxonomy. Hashtags are the closest
 *   thing and they are already a candidate *source*, not a filter dimension.
 * - `NewUserMinEngagementFilter` — needs a global engagement distribution to
 *   set the threshold against, which no single instance can see.
 * - `InventoryHoldoutFilter`, `AdAdjacentServedFilter`, `PushToHomeDedupFilter`,
 *   `Brazil2026ElectionFilter`, `InvalidConversationModuleFilter` — X-specific
 *   experiment plumbing, ads, push notifications and jurisdiction rules.
 * - `SelfReplyChainFilter`, `PopularTopicsAuthorDedupFilter`,
 *   `FollowingRetweetDeduplicationFilter` — author/conversation diversity;
 *   `diversity.ts` owns that.
 * - `VFFilter` / `AncillaryVFFilter` — X's visibility-filtering service is a
 *   whole subsystem of classifiers and account labels. Mastodon's equivalent
 *   already ran server-side; `applyMastodonFilters` carries what is left.
 */
export function applyPreScoringFilters(
  candidates: PostCandidate[],
  signals: ForYouSignals,
  context: PreScoringContext = {},
): PostCandidate[] {
  const viewerAccountId = resolveViewerAccountId(context)

  // DropDuplicatesFilter + RetweetDeduplicationFilter
  const deduped = dedupeCandidates(candidates)

  const followedAccountIds = context.followedAccountIds
    ? toSet(context.followedAccountIds)
    : deriveFollowedAccountIds(deduped)

  const floor = context.floor ?? PRE_SCORING_FLOOR
  let best: PostCandidate[] = []
  let strictCount = 0

  for (let relaxation = 0 as FilterRelaxation; relaxation <= 4; relaxation++) {
    // Only ever replay enough impressions to fill the gap the strict pass left.
    const seenBudget = relaxation < 1 ? 0 : Math.max(0, floor - strictCount)
    const kept = runFilterChain(
      deduped,
      signals,
      context,
      viewerAccountId,
      followedAccountIds,
      relaxation as FilterRelaxation,
      seenBudget,
    )
    if (relaxation === 0)
      strictCount = kept.length
    if (kept.length > best.length)
      best = kept
    if (kept.length >= floor || deduped.length === 0) {
      if (relaxation > 0)
        context.onRelax?.(relaxation as FilterRelaxation, kept.length)
      return kept
    }
  }

  context.onRelax?.(4, best.length)
  return best
}

// ---------------------------------------------------------------------------
// Fan-out plumbing
// ---------------------------------------------------------------------------

interface PaginatorLike<T> {
  values: () => AsyncIterableIterator<T[]>
}

/** Bounds how many sockets we hold open against one instance at a time. */
function createLimiter(max: number) {
  let active = 0
  const queue: (() => void)[] = []

  const release = () => {
    active--
    queue.shift()?.()
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max)
      await new Promise<void>(resolve => queue.push(resolve))
    active++
    try {
      return await fn()
    }
    finally {
      release()
    }
  }
}

class SourceTimeoutError extends Error {}

/**
 * Whether an error is the server telling us to back off.
 *
 * `MastoHttpError` carries `statusCode` but not the response headers, so there
 * is no `Retry-After` to read; we use a flat backoff. The shape checks are
 * deliberately loose so a plain `fetch` rejection or a wrapped error is still
 * recognised.
 */
const RATE_LIMIT_MESSAGE_RE = /\b429\b|too many requests/i

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { statusCode?: unknown, status?: unknown, message?: unknown }
  if (candidate.statusCode === 429 || candidate.status === 429)
    return true
  return typeof candidate.message === 'string' && RATE_LIMIT_MESSAGE_RE.test(candidate.message)
}

/**
 * How long the server asked us to wait, in ms, or `undefined`.
 *
 * Mastodon answers a 429 with `Retry-After` (seconds) and, on its API routes,
 * `X-RateLimit-Reset` (an ISO timestamp). `MastoHttpError` exposes neither
 * directly — it keeps `statusCode`, `description`, `details` and a loose
 * `additionalProperties` bag — so we probe the shapes an error might carry:
 * masto's bag, a raw `Response` on `response`/`cause`, or a plain header map
 * from a hand-rolled fetch. Anything unrecognised falls back to the flat
 * backoff, which is the safe direction.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined

  const bag = error as Record<string, any>
  const headerSources = [bag.headers, bag.response?.headers, bag.cause?.headers]
  const readHeader = (name: string): string | undefined => {
    for (const headers of headerSources) {
      if (!headers)
        continue
      const value = typeof headers.get === 'function' ? headers.get(name) : headers[name]
      if (value != null)
        return String(value)
    }
    const extra = bag.additionalProperties as Record<string, unknown> | undefined
    const fromBag = extra?.[name] ?? bag[name]
    return fromBag == null ? undefined : String(fromBag)
  }

  // `Retry-After` is delta-seconds, or an HTTP date.
  const retryAfter = readHeader('retry-after') ?? readHeader('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RATE_LIMIT_BACKOFF_MS)
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at))
      return Math.min(Math.max(0, at - now), MAX_RATE_LIMIT_BACKOFF_MS)
  }

  // Mastodon's own reset timestamp.
  const reset = readHeader('x-ratelimit-reset') ?? readHeader('X-RateLimit-Reset')
  if (reset) {
    const at = Date.parse(reset)
    if (!Number.isNaN(at))
      return Math.min(Math.max(0, at - now), MAX_RATE_LIMIT_BACKOFF_MS)
  }

  return undefined
}

/** Set when the instance returns 429; no source is queried until it passes. */
let rateLimitedUntil = 0
/** When the last fill started, for the minimum-interval guard. */
let lastFillStartedAt = 0

/** Whether we are currently backing off after a 429. */
export function isRateLimited(now: number = Date.now()): boolean {
  return now < rateLimitedUntil
}

/** Milliseconds until the rate-limit backoff expires; 0 when not limited. */
export function rateLimitRetryIn(now: number = Date.now()): number {
  return Math.max(0, rateLimitedUntil - now)
}

/** Clears the backoff and the fill throttle. For tests and manual retries. */
export function resetRateLimit() {
  rateLimitedUntil = 0
  lastFillStartedAt = 0
}

function noteRateLimit(now: number, backoffMs: number) {
  rateLimitedUntil = Math.max(rateLimitedUntil, now + backoffMs)
}

/**
 * `Promise.allSettled` waits for the slowest task, and tag timelines are
 * routinely the slowest uncached endpoint a Mastodon server has. Masto.js gives
 * us no per-call `AbortSignal`, so this is a soft timeout: we stop *waiting*
 * and keep whatever pages already landed. The request itself carries on and is
 * simply ignored.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (!ms || ms === Number.POSITIVE_INFINITY)
    return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SourceTimeoutError('source timed out')), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new SourceTimeoutError('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * One page, time-boxed. Used for the small lookups (followed tags, trend tags,
 * lists, suggestions) that seed the real fan-out.
 */
async function firstPage<T>(
  paginator: PaginatorLike<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const result = await withTimeout(paginator.values().next(), timeoutMs, signal)
  return (result.value as T[] | undefined) ?? []
}

interface DrainOptions {
  maxPages: number
  maxAgeMs: number
  now: number
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Walks a paginator several pages deep.
 *
 * Stops at whichever comes first: the page budget, a page that crosses the
 * source's age horizon (everything past it is stale by construction, since
 * timelines are ordered newest-first), a page that adds nothing new, an empty
 * page, or the per-page timeout. Whatever landed before the stop is kept.
 */
async function drainPaginator(
  paginator: PaginatorLike<mastodon.v1.Status>,
  options: DrainOptions,
): Promise<mastodon.v1.Status[]> {
  const collected: mastodon.v1.Status[] = []
  const seenIds = new Set<string>()
  const iterator = paginator.values()
  const oldestAcceptable = options.now - options.maxAgeMs

  for (let page = 0; page < options.maxPages; page++) {
    let statuses: mastodon.v1.Status[]
    try {
      const result = await withTimeout(iterator.next(), options.timeoutMs, options.signal)
      if (result.done)
        break
      statuses = result.value ?? []
    }
    catch (error) {
      // A source that never produced a page failed, and the caller should hear
      // about it. One that dies partway through has still done its job.
      if (page === 0)
        throw error
      break
    }

    if (!statuses.length)
      break

    let added = 0
    let crossedHorizon = false
    for (const status of statuses) {
      if (!status?.id || seenIds.has(status.id))
        continue
      const createdAt = Date.parse(status.createdAt)
      if (!Number.isNaN(createdAt) && createdAt < oldestAcceptable) {
        crossedHorizon = true
        continue
      }
      seenIds.add(status.id)
      collected.push(status)
      added++
    }

    // A page whose newest item is already stale means every later page is too.
    if (crossedHorizon || added === 0)
      break
  }

  return collected
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface FetchCandidatesOptions {
  /** Defaults to `useMastoClient()`. */
  client?: mastodon.rest.Client
  /** Page size per source. */
  limit?: number
  /** Per-source page budget, overriding `DEFAULT_SOURCE_PAGES`. */
  pages?: Partial<Record<string, number>>
  /** Resume points per source key, from a previous fetch. */
  cursors?: Record<string, string | undefined>
  /** How many tag timelines to query. */
  maxTags?: number
  /** How many curated lists to pull. */
  maxLists?: number
  /** How many 2-hop accounts to pull statuses from. */
  maxTwoHop?: number
  /** Explicit tags, bypassing followed / trending / engagement seeds. */
  tags?: string[]
  /** Restrict the fan-out, e.g. to refresh a single source. */
  sources?: CandidateSource[]
  /** Disable individual source families by key: 'list', 'twohop', 'tag', … */
  disable?: string[]
  /** Known follow set; skips the relationships round trip for these. */
  followedAccountIds?: Iterable<string>
  /** Resolve `inNetwork` exactly via the relationships endpoint. Default true. */
  resolveFollowSet?: boolean
  now?: number
  timeoutMs?: number
  concurrency?: number
  signal?: AbortSignal
  /** Fallback backoff when a 429 carries no `Retry-After`. */
  rateLimitBackoffMs?: number
  /** Fetch even while backing off from a 429. Only for an explicit user retry. */
  ignoreRateLimit?: boolean
  /** Called once per failed source. Defaults to a `console.warn`. */
  onSourceError?: (source: string, error: unknown) => void
}

export interface FetchCandidatesResult {
  candidates: PostCandidate[]
  /** Resume points to hand back on the next fetch. */
  cursors: Record<string, string | undefined>
  /** Source keys that returned nothing and should be skipped next time. */
  exhausted: string[]
  /** Raw candidate count per source key, for the debug panel. */
  counts: Record<string, number>
  /** The follow set actually used, exact when relationships resolved. */
  followedAccountIds: Set<string>
  errors: string[]
  /** True when the instance returned 429, or we were still backing off. */
  rateLimited: boolean
}

interface SourceTask {
  /** Cursor key. Distinct per tag / list / account. */
  key: string
  source: CandidateSource
  maxAgeMs: number
  pageBudget: number
  /** Trends has no `max_id`; such sources are re-read rather than resumed. */
  resumable: boolean
  build: (params: { limit: number, maxId?: string }) => PaginatorLike<mastodon.v1.Status>
}

let followedTagsCache: { owner: string, tags: string[], at: number } | undefined

/**
 * The tags we treat as the viewer's interest vector.
 *
 * Followed tags are an explicit statement of interest and `topTags()` is the
 * implicit one, decayed out of the viewer's engagement history — but seeding
 * from those two alone is a filter bubble by construction, which is the
 * opposite of what `phoenix_topics_source` does. `GET /api/v1/trends/tags`
 * supplies the exploration half.
 *
 * Followed tags are memoized: `TimelineHome.vue` already fetches them on every
 * home timeline mount, and there is no reason for the feed to ask again on each
 * refill.
 */
async function resolveSeedTags(
  client: mastodon.rest.Client,
  options: FetchCandidatesOptions,
  now: number,
): Promise<string[]> {
  const max = options.maxTags ?? DEFAULT_TAG_FANOUT
  if (max <= 0)
    return []

  if (options.tags)
    return dedupeTags(options.tags).slice(0, max)

  const owner = ownerKey()
  let followed: string[] = []
  if (followedTagsCache && followedTagsCache.owner === owner && now - followedTagsCache.at < FOLLOW_CACHE_TTL_MS) {
    followed = followedTagsCache.tags
  }
  else {
    try {
      const tags = await firstPage(
        client.v1.followedTags.list({ limit: 20 }),
        options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
        options.signal,
      )
      followed = tags.map(tag => tag.name)
      followedTagsCache = { owner, tags: followed, at: now }
    }
    catch {
      // Followed tags need Mastodon 4.0+; older servers and forks 404 here.
    }
  }

  let engaged: string[] = []
  try {
    engaged = topTags(max)
  }
  catch {
    // No signals store available (SSR, or a logged-out viewer).
  }

  let trending: string[] = []
  try {
    const tags = await firstPage(
      client.v1.trends.tags.list({ limit: 20 }),
      options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
      options.signal,
    )
    trending = tags.map(tag => tag.name)
  }
  catch {
    // Trends are commonly disabled; exploration is optional, not required.
  }

  // Interleave so no single seed kind can monopolise the fan-out.
  return dedupeTags(interleave(followed, engaged, trending)).slice(0, max)
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const name = tag?.trim().replace(LEADING_HASH_RE, '')
    if (!name)
      continue
    const key = name.toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    out.push(name)
  }
  return out
}

function interleave(...lists: string[][]): string[] {
  const out: string[] = []
  const longest = Math.max(0, ...lists.map(list => list.length))
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i < list.length)
        out.push(list[i]!)
    }
  }
  return out
}

/**
 * Accounts for the 2-hop expansion — modeled on X's `tweet_mixer`, though it
 * is worth being precise about what that means. `home-mixer/params/param.rs`
 * defaults `EnableTweetMixerSource` to **false**: X's real `tweet_mixer`
 * source is disabled in production. So `network2hop` is not mirroring a live
 * X system, it is modeled on a dormant one.
 *
 * That does not argue for downweighting it here. `network2hop` does not
 * depend on `tweet_mixer` being switched on somewhere else — it is its own
 * retrieval path against `GET /api/v2/suggestions`, a real, always-live
 * Mastodon endpoint, and it earns its keep the same way every other source
 * does: individually fault-tolerant, individually time-boxed, contributing
 * candidates a follow-graph-only feed would never surface. The X comparison
 * explains the *shape* of this source; it should not be read as a claim that
 * disabling it would bring Elk closer to production X, since production X
 * currently runs without it too.
 *
 * `GET /api/v2/suggestions` already computes the interesting half server-side:
 * its `friends_of_friends` source is literally "followed by people you follow",
 * and `similar_to_recently_followed` is a content-similarity neighbour. One
 * request instead of walking N following lists ourselves, so that is the
 * primary path; the manual walk (sample your follows, read *their* following)
 * is the fallback when suggestions are unavailable or too few.
 */
async function resolveTwoHopAccounts(
  client: mastodon.rest.Client,
  options: FetchCandidatesOptions,
  followedAccountIds: ReadonlySet<string>,
): Promise<string[]> {
  const max = options.maxTwoHop ?? DEFAULT_TWO_HOP_FANOUT
  if (max <= 0)
    return []

  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS
  const viewerId = resolveViewerAccountId({})
  const picked: string[] = []
  const add = (id: string | undefined) => {
    if (id && id !== viewerId && !followedAccountIds.has(id) && !picked.includes(id))
      picked.push(id)
  }

  try {
    const suggestions = await firstPage(client.v2.suggestions.list({ limit: 40 }), timeoutMs, options.signal)
    // Prefer the genuinely 2-hop reasons over "most followed", which is just
    // instance-wide popularity and is already covered by `trending`.
    const ranked = [...suggestions].sort((a, b) => twoHopScore(b) - twoHopScore(a))
    for (const suggestion of ranked)
      add(suggestion.account?.id)
  }
  catch {
    // Suggestions are optional; fall through to the manual walk.
  }

  if (picked.length < max) {
    const seeds = [...followedAccountIds].slice(0, 2)
    for (const seed of seeds) {
      if (picked.length >= max)
        break
      try {
        const accounts = await firstPage(
          client.v1.accounts.$select(seed).following.list({ limit: 20 }),
          timeoutMs,
          options.signal,
        )
        for (const account of accounts)
          add(account?.id)
      }
      catch {
        // Following lists are frequently hidden; that is fine.
      }
    }
  }

  return picked.slice(0, max)
}

function twoHopScore(suggestion: mastodon.v1.Suggestion): number {
  const sources = suggestion?.sources ?? []
  if (sources.includes('friends_of_friends'))
    return 3
  if (sources.includes('similar_to_recently_followed'))
    return 2
  if (sources.includes('most_interactions'))
    return 1
  return 0
}

/**
 * Fans out to every timeline the Mastodon API exposes, in parallel, several
 * pages deep.
 *
 * Returns raw candidates, one per (post, source) hit — deduping is
 * `dedupeCandidates`' job and it needs to see the duplicates to merge their
 * `sources`. Nothing here throws: a source that fails or hangs contributes what
 * it managed and the rest of the feed is unaffected.
 *
 * On already-seen posts: the README notes that `ThunderSource` is handed the
 * seen list and leaves those posts out, while the other sources rely on the
 * filters. Mastodon has no `exclude_ids` parameter on any timeline, so the
 * closest we get is the per-source `maxId` cursor — a refill resumes below the
 * oldest post already drained instead of re-reading pages the viewer has been
 * through. `filterSeen` remains the backstop.
 */
export async function fetchCandidates(options: FetchCandidatesOptions = {}): Promise<PostCandidate[]> {
  return (await fetchCandidatesDetailed(options)).candidates
}

/** As `fetchCandidates`, but also returns the cursors and per-source counts. */
export async function fetchCandidatesDetailed(
  options: FetchCandidatesOptions = {},
): Promise<FetchCandidatesResult> {
  const now = options.now ?? Date.now()
  const empty: FetchCandidatesResult = {
    candidates: [],
    cursors: {},
    exhausted: [],
    counts: {},
    followedAccountIds: new Set(),
    errors: [],
    rateLimited: false,
  }

  // Still backing off from a 429: spend nothing at all. The caller keeps
  // whatever it already has. Checked against wall-clock, not `options.now`.
  if (!options.ignoreRateLimit && isRateLimited())
    return { ...empty, rateLimited: true, errors: ['rate-limited'] }

  const client = options.client ?? (() => {
    try {
      return useMastoClient()
    }
    catch {
      return undefined
    }
  })()
  if (!client)
    return empty

  const limit = options.limit ?? DEFAULT_SOURCE_LIMIT
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS
  const cursors = options.cursors ?? {}
  const enabled = options.sources ? new Set(options.sources) : undefined
  const disabled = new Set(options.disable ?? [])
  const wants = (source: CandidateSource, family: string) =>
    (!enabled || enabled.has(source)) && !disabled.has(family)
  const errors: string[] = []
  let rateLimited = false
  const onError = (key: string, error: unknown) => {
    errors.push(key)
    // One 429 speaks for the whole instance: every remaining task is going to
    // hit the same wall, and each one it skips is budget left for the rest of
    // Elk. So the first 429 stops the fan-out dead.
    if (isRateLimitError(error)) {
      rateLimited = true
      // Wall-clock, deliberately: `options.now` reasons about how old a *post*
      // is and callers pin it in tests, but a backoff deadline is real time.
      const at = Date.now()
      const wait = retryAfterMs(error, at) ?? options.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS
      noteRateLimit(at, wait)
    }
    if (options.onSourceError)
      options.onSourceError(key, error)
    else
      console.warn(`[for-you] source "${key}" failed`, error)
  }

  const pageBudget = (family: string) =>
    options.pages?.[family] ?? DEFAULT_SOURCE_PAGES[family] ?? 1

  const limiter = createLimiter(options.concurrency ?? DEFAULT_CONCURRENCY)
  const counts: Record<string, number> = {}
  const nextCursors: Record<string, string | undefined> = {}
  const exhausted: string[] = []
  const collected: { source: CandidateSource, status: mastodon.v1.Status }[] = []

  const runTask = (task: SourceTask) => limiter(async () => {
    // Checked inside the limiter, so tasks still queued when the 429 lands are
    // abandoned rather than issued.
    if (rateLimited)
      return
    try {
      const maxId = task.resumable ? cursors[task.key] : undefined
      const paginator = task.build({ limit, maxId })
      const statuses = await drainPaginator(paginator, {
        maxPages: task.pageBudget,
        maxAgeMs: task.maxAgeMs,
        now,
        timeoutMs,
        signal: options.signal,
      })

      counts[task.key] = statuses.length
      if (!statuses.length) {
        exhausted.push(task.key)
      }
      else if (task.resumable) {
        // Timelines come back newest-first, so the last item is the resume point.
        nextCursors[task.key] = statuses.at(-1)!.id
      }

      for (const status of statuses)
        collected.push({ source: task.source, status })
    }
    catch (error) {
      onError(task.key, error)
    }
  })

  const timelineTask = (
    key: string,
    source: CandidateSource,
    family: string,
    build: SourceTask['build'],
    resumable = true,
  ): SourceTask => ({
    key,
    source,
    maxAgeMs: SOURCE_MAX_AGE_MS[source] ?? MAX_CANDIDATE_AGE_MS,
    pageBudget: pageBudget(family),
    resumable,
    build,
  })

  // --- Branch 1: the fixed timelines. Started immediately, so nothing that
  // --- needs a lookup first (tags, lists, 2-hop) can gate them.
  const fixed: SourceTask[] = []

  // thunder: in-network recency.
  if (wants('home', 'home')) {
    fixed.push(timelineTask('home', 'home', 'home', params =>
      client.v1.timelines.home.list({ limit: params.limit, maxId: params.maxId })))
  }

  // The instance's view of the wider fediverse.
  if (wants('federated', 'federated')) {
    fixed.push(timelineTask('federated', 'federated', 'federated', params =>
      client.v1.timelines.public.list({ limit: params.limit, maxId: params.maxId })))
  }

  // Same firehose, narrowed to the viewer's own instance.
  if (wants('local', 'local')) {
    fixed.push(timelineTask('local', 'local', 'local', params =>
      client.v1.timelines.public.list({ limit: params.limit, maxId: params.maxId, local: true })))
  }

  // simclusters analog: the instance's own engagement signal. Trends paginate
  // by offset, not by `max_id`, so this source is re-read rather than resumed.
  if (wants('trending', 'trending')) {
    fixed.push(timelineTask('trending', 'trending', 'trending', params =>
      client.v1.trends.statuses.list({ limit: params.limit }), false))
  }

  const fixedBranch = Promise.all(fixed.map(runTask))

  // --- Branch 2: phoenix-retrieval analog. Resolves its seeds concurrently
  // --- with branch 1 rather than in front of it.
  const tagBranch = (async () => {
    if (!wants('tag', 'tag'))
      return
    const tags = await resolveSeedTags(client, options, now).catch(() => [] as string[])
    await Promise.all(tags.map(tag => runTask(timelineTask(
      `tag:${tag.toLowerCase()}`,
      'tag',
      'tag',
      params => client.v1.timelines.tag.$select(tag).list({ limit: params.limit, maxId: params.maxId }),
    ))))
  })()

  // --- Branch 3: curated lists. Hand-picked accounts are the highest-precision
  // --- in-network source there is, and X has no equivalent at all.
  const listBranch = (async () => {
    if (!wants(LIST_SOURCE, 'list'))
      return
    let lists: mastodon.v1.List[] = []
    try {
      lists = await firstPage(client.v1.lists.list(), timeoutMs, options.signal)
    }
    catch {
      return
    }
    const picked = lists.slice(0, options.maxLists ?? DEFAULT_LIST_FANOUT)
    await Promise.all(picked.map(list => runTask(timelineTask(
      `list:${list.id}`,
      LIST_SOURCE,
      'list',
      params => client.v1.timelines.list.$select(list.id).list({ limit: params.limit, maxId: params.maxId }),
    ))))
  })()

  // --- Branch 4: tweet_mixer analog — 2-hop follow-graph expansion.
  const twoHopBranch = (async () => {
    if (!wants(TWO_HOP_SOURCE, 'twohop'))
      return
    const seedFollowed = toSet(options.followedAccountIds)
    const accounts = await resolveTwoHopAccounts(client, options, seedFollowed).catch(() => [] as string[])
    await Promise.all(accounts.map(accountId => runTask(timelineTask(
      `twohop:${accountId}`,
      TWO_HOP_SOURCE,
      'twohop',
      params => client.v1.accounts.$select(accountId).statuses.list({
        limit: Math.min(params.limit, 20),
        maxId: params.maxId,
        excludeReplies: true,
        excludeReblogs: true,
      }),
    ))))
  })()

  await Promise.allSettled([fixedBranch, tagBranch, listBranch, twoHopBranch])

  // Everything the home timeline returned is in-network by construction; the
  // rest has to be proven, exactly, against the relationships endpoint.
  const known = new Set(options.followedAccountIds ?? [])
  for (const { source, status } of collected) {
    if (IN_NETWORK_SOURCES.has(source) && status.account?.id)
      known.add(status.account.id)
  }

  let followedAccountIds = known
  if (options.resolveFollowSet ?? true) {
    const authorIds = new Set<string>()
    for (const { status } of collected) {
      const id = status.account?.id
      if (id && !known.has(id))
        authorIds.add(id)
    }
    try {
      const resolved = await resolveFollowedAccountIds(client, authorIds, {
        now,
        concurrency: options.concurrency,
        onError: error => onError('relationships', error),
      })
      followedAccountIds = new Set([...known, ...resolved])
    }
    catch (error) {
      onError('relationships', error)
    }
  }

  const candidates = collected.map(({ source, status }) =>
    createCandidate(status, source, IN_NETWORK_SOURCES.has(source) || followedAccountIds.has(status.account?.id ?? '')))

  return { candidates, cursors: nextCursors, exhausted, counts, followedAccountIds, errors, rateLimited }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export interface ForYouPoolStats {
  /** Raw (source, post) hits from the last fill. */
  fetched: number
  /** After merging duplicates. */
  deduped: number
  /** After the pre-scoring chain. */
  filtered: number
  /** Raw count per source key. */
  counts: Record<string, number>
  /** Source keys that failed on the last fill. */
  errors: string[]
  /** How far the filter chain had to be relaxed, if at all. */
  relaxation: FilterRelaxation
  /** The instance returned 429, or we declined to ask while backing off. */
  rateLimited: boolean
  /** Milliseconds until we will query the instance again. */
  retryInMs: number
}

export interface ForYouPoolState {
  /** Deduped, pre-scoring-filtered candidates the ranker can draw from. */
  candidates: PostCandidate[]
  /** Per-source resume points, to be handed back on the next refill. */
  cursors: Record<string, string | undefined>
  /** Source keys that came back empty. */
  exhausted: string[]
  status: 'empty' | 'filling' | 'ready' | 'error'
  filledAt: number
  /** Account the pool belongs to; it is reset when the viewer switches. */
  owner: string
  stats: ForYouPoolStats
}

function createEmptyPool(owner = ownerKey()): ForYouPoolState {
  return {
    candidates: [],
    cursors: {},
    exhausted: [],
    status: 'empty',
    filledAt: 0,
    owner,
    stats: { fetched: 0, deduped: 0, filtered: 0, counts: {}, errors: [], relaxation: 0, rateLimited: false, retryInMs: 0 },
  }
}

const pool = shallowRef<ForYouPoolState>(createEmptyPool())
/** Ids already handed to the viewer, so a refill cannot resurrect them. */
let servedIds = new Set<string>()
let inFlight: Promise<PostCandidate[]> | undefined

/**
 * The candidate pool.
 *
 * `feed.ts` owns fetch → rank → paginate; this ref is the "fetch" half's
 * output. Read `.candidates` to rank, call `consumeCandidates()` with what you
 * served, and call `ensureCandidatePool()` before each page — it is cheap when
 * the pool is healthy and refills in the background when it is not.
 */
export function useForYouCandidatePool(): Ref<ForYouPoolState> {
  const owner = ownerKey()
  if (pool.value.owner !== owner)
    resetCandidatePool()
  return pool
}

/**
 * Drops the pool and every cursor. Call on logout or account switch.
 *
 * Deliberately does *not* clear `lastFillStartedAt` or the 429 backoff: those
 * describe the network and the shared request budget, not the account. Resetting
 * them here would make account switching a way to bypass the throttle, which is
 * exactly the loop the throttle exists to stop. `resetRateLimit()` is the
 * explicit escape hatch.
 */
export function resetCandidatePool() {
  pool.value = createEmptyPool()
  servedIds = new Set()
  inFlight = undefined
  resetFollowCache()
  followedTagsCache = undefined
}

export interface PoolOptions extends FetchCandidatesOptions {
  signals?: ForYouSignals
  filters?: PreScoringContext
  /** Stop fetching once the pool holds this many candidates. */
  target?: number
  /** Below this, `ensureCandidatePool` refills in the background. */
  floor?: number
  /** Minimum gap between fills. Defaults to `MIN_FILL_INTERVAL_MS`. */
  minFillIntervalMs?: number
  /** Bypass the interval throttle — for an explicit pull-to-refresh only. */
  force?: boolean
}

function readSignals(options: PoolOptions): ForYouSignals {
  if (options.signals)
    return options.signals
  try {
    return useForYouSignals().value
  }
  catch {
    return { ...EMPTY_SIGNALS, seen: [], notInterested: [], mutedForYou: [] }
  }
}

async function runFill(options: PoolOptions, resume: boolean): Promise<PostCandidate[]> {
  const owner = ownerKey()
  if (pool.value.owner !== owner)
    resetCandidatePool()

  const previous = pool.value
  pool.value = { ...previous, owner, status: 'filling' }

  try {
    const signals = readSignals(options)
    const result = await fetchCandidatesDetailed({
      ...options,
      cursors: resume ? previous.cursors : undefined,
      followedAccountIds: options.followedAccountIds,
    })

    // A fill that fetched nothing *and* hit errors is a network failure, not an
    // empty fediverse. Replacing the pool with its result would turn one 429 —
    // or one offline moment — into an empty feed. Keep what we have.
    if (!result.candidates.length && result.errors.length && previous.candidates.length) {
      pool.value = {
        ...previous,
        owner,
        status: 'error',
        stats: { ...previous.stats, errors: result.errors },
      }
      return previous.candidates
    }

    // Merge with what the pool already holds so `sources` keeps accumulating
    // across refills, then drop anything already served. A *fresh* fill after a
    // failure still merges, for the same reason.
    const keepPrevious = resume || (!result.candidates.length && result.errors.length > 0)
    const merged = dedupeCandidates(keepPrevious ? [...previous.candidates, ...result.candidates] : result.candidates)
      .filter(candidate => !candidateIds(candidate.status).some(id => servedIds.has(id)))

    let relaxation: FilterRelaxation = 0
    const filtered = applyPreScoringFilters(merged, signals, {
      followedAccountIds: result.followedAccountIds.size ? result.followedAccountIds : undefined,
      ...options.filters,
      onRelax: (level, kept) => {
        relaxation = level
        options.filters?.onRelax?.(level, kept)
      },
    })

    pool.value = {
      candidates: filtered,
      cursors: { ...(resume ? previous.cursors : {}), ...result.cursors },
      exhausted: result.exhausted,
      status: result.rateLimited ? 'error' : 'ready',
      filledAt: Date.now(),
      owner,
      stats: {
        fetched: result.candidates.length,
        deduped: merged.length,
        filtered: filtered.length,
        counts: result.counts,
        errors: result.errors,
        relaxation,
        rateLimited: result.rateLimited,
        retryInMs: rateLimitRetryIn(),
      },
    }
    return filtered
  }
  catch (error) {
    console.warn('[for-you] pool fill failed', error)
    pool.value = { ...pool.value, status: 'error' }
    return pool.value.candidates
  }
}

function clearInFlight() {
  inFlight = undefined
}

/**
 * Whether we may spend the user's request budget on another fill right now.
 *
 * A full fill is ~40 requests plus relationship batches out of the 300 per five
 * minutes Mastodon allows *the whole app*. Reloading, flipping tabs or hopping
 * between accounts must not be able to spend that on refetching what is already
 * in the pool, so a fill inside `MIN_FILL_INTERVAL_MS` of the last one is
 * declined — unless the pool is empty, where the user has nothing and the
 * request is the point.
 */
function mayFill(options: PoolOptions, now: number): boolean {
  if (options.force)
    return true
  if (!options.ignoreRateLimit && isRateLimited(now))
    return false
  // Note there is no "…but the pool is empty" exemption. That looks humane and
  // is in fact the bypass: `resetCandidatePool()` empties the pool, so an
  // account switch — or any reload that clears it — would wave every fill
  // straight through. The interval alone is the gate, and `lastFillStartedAt`
  // starts at 0 so a genuine first fill is never delayed by it.
  const interval = options.minFillIntervalMs ?? MIN_FILL_INTERVAL_MS
  return now - lastFillStartedAt >= interval
}

function startFill(options: PoolOptions, resume: boolean): Promise<PostCandidate[]> {
  const now = Date.now()
  if (!mayFill(options, now))
    return Promise.resolve(pool.value.candidates)
  lastFillStartedAt = now
  inFlight ??= runFill(options, resume).finally(clearInFlight)
  return inFlight
}

/** Fetches a fresh pool from scratch, discarding cursors. */
export function fillCandidatePool(options: PoolOptions = {}): Promise<PostCandidate[]> {
  return startFill(options, false)
}

/** Tops the pool up, resuming each source from where it left off. */
export function refillCandidatePool(options: PoolOptions = {}): Promise<PostCandidate[]> {
  return startFill(options, true)
}

/**
 * The call `feed.ts` should make before serving a page.
 *
 * Awaits a fill only when the pool cannot serve at all; when it is merely
 * running low it returns immediately and tops up in the background, so
 * scrolling never blocks on the network.
 */
export function ensureCandidatePool(options: PoolOptions = {}): Promise<PostCandidate[]> {
  const owner = ownerKey()
  if (pool.value.owner !== owner)
    resetCandidatePool()

  const floor = options.floor ?? POOL_REFILL_FLOOR
  const stale = Date.now() - pool.value.filledAt > POOL_STALE_MS
  const current = pool.value.candidates

  if (!current.length || (stale && pool.value.status !== 'filling'))
    return current.length ? refillCandidatePool(options) : fillCandidatePool(options)

  if (current.length < floor && !inFlight)
    void refillCandidatePool(options)

  return Promise.resolve(current)
}

/**
 * Marks candidates as served: they leave the pool and can never come back,
 * even if a later refill re-fetches them.
 */
export function consumeCandidates(ids: Iterable<string>) {
  const consumed = toSet(ids)
  if (!consumed.size)
    return

  for (const id of consumed)
    servedIds.add(id)
  if (servedIds.size > MAX_SERVED_MEMORY)
    servedIds = new Set([...servedIds].slice(-MAX_SERVED_MEMORY))

  pool.value = {
    ...pool.value,
    candidates: pool.value.candidates.filter(candidate =>
      !candidateIds(candidate.status).some(id => consumed.has(id))),
  }
}

/** Whether the pool is running low enough to want a background refill. */
export function poolNeedsRefill(floor: number = POOL_REFILL_FLOOR): boolean {
  return pool.value.candidates.length < floor
}
