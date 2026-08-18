import type { mastodon } from 'masto'
import type { InjectionKey, Ref } from 'vue'
import type { PoolOptions, PreScoringContext } from './candidates'
import type { DiversityRerankOptions } from './diversity'
import type { RankingContext } from './ranking'
import type { CandidateSource, ForYouSignals, PostCandidate } from './types'

/**
 * The orchestration layer of the "For You" feed.
 *
 * `candidates.ts`, `ranking.ts` and `diversity.ts` are the stages; this module
 * drives them, holds the session state that keeps the feed stable while the
 * viewer scrolls, and adapts the whole thing to the only feed interface Elk
 * knows how to render: a Masto.js paginator.
 *
 * ## Why a paginator
 *
 * `CommonPaginator` (and `TimelinePaginator` on top of it) already solves
 * infinite scroll, streaming updates, the end-anchor intersection check, the
 * "load more" button, the skeleton and the virtual scroller. All it asks for is
 * an object with `values()` returning an async iterator of pages, so the feed is
 * exactly that — `useForYouFeed().paginator` can be handed straight to
 * `CommonPaginator`, and the ranked feed renders through the same machinery as
 * every other timeline.
 *
 * ## Why the served set exists
 *
 * The ranker scores a *batch*: it needs the whole slate in hand to apply author
 * diversity, the cold-start slot and the MMR rerank. Re-running it over the
 * whole pool on every page would therefore reshuffle posts the viewer already
 * scrolled past. So a post, once emitted, leaves the candidate pool
 * (`consumeCandidates`) and is recorded in `servedKeys` — each page is a fresh
 * ranking of *only* what has not been shown yet, appended to what has.
 * Already-shown posts are never re-ordered, by construction.
 */

/** Posts emitted per page. Roughly two screens on a phone. */
export const DEFAULT_FOR_YOU_PAGE_SIZE = 20

/**
 * Below this on the very first page we stop pretending we have a feed and fall
 * back to the home timeline. Small instances, brand-new accounts and servers
 * with the federated timeline switched off all land here.
 */
export const MIN_VIABLE_FIRST_PAGE = 5

/** Consecutive empty rounds before the feed declares itself exhausted. */
const MAX_EMPTY_ROUNDS = 2

/**
 * Of a page's leading window (see {@link inNetworkFloorWindow}), this many
 * slots must be in-network — or the {@link isFloorEligible} equivalent — or
 * the floor promotes candidates from further down the ranking to fill it.
 *
 * Two, not one: a single guaranteed slot is easy for a viral out-of-network
 * pair to still crowd out visually (one followed post lost in a sea of
 * strangers still *reads* as "the algorithm buried my follows"). Two is the
 * smallest number that reliably registers as "some of this is people I
 * follow" without turning the window into a de-facto in-network quota.
 */
const IN_NETWORK_FLOOR_MIN = 2

/**
 * How many of a page's leading slots the in-network floor covers.
 *
 * X does not leave source balance to the scorer: home-mixer blends candidate
 * sources structurally, *before* ranking runs, so a source's presence in the
 * result is guaranteed rather than hoped for (see `candidates.ts`'s
 * `IN_NETWORK_SOURCES`). `ranking.ts`'s out-of-network discount is the only
 * structural pressure this pipeline has toward the follow graph, and it is a
 * multiplier, not a floor — a high-engagement stranger can still outscore a
 * modest post from a followed account outright. On Mastodon the follow graph
 * is the whole social contract, so the fix mirrors X's mixer at the one point
 * in this pipeline that plays the same role: this module, right before a page
 * is handed to the viewer.
 *
 * Scaled to a quarter of the page, floored at 3: enough that the opening
 * screen of a normal 20-post page (window 5) is never all strangers, and
 * small enough on a thin page (a 5-post slate scales to window 3) that the
 * floor cannot itself dominate what should be a tiny batch. Never larger than
 * the page itself.
 */
function inNetworkFloorWindow(pageSize: number): number {
  return Math.min(pageSize, Math.max(3, Math.ceil(pageSize * 0.25)))
}

/**
 * Whether a candidate counts toward the in-network floor.
 *
 * True in-network (`inNetwork`) always counts. `network2hop` — friends of the
 * viewer's follows — is out-of-network by definition but is, per
 * `candidates.ts`, "the highest-precision OON reach available on the
 * fediverse": closer to the follow graph than a federated-timeline stranger,
 * so it is allowed to help satisfy the floor rather than being treated
 * identically to a total stranger. {@link enforceInNetworkFloor} still prefers
 * true in-network when both are available — see its promotion order.
 */
function isFloorEligible(candidate: PostCandidate): boolean {
  return candidate.inNetwork || candidate.sources.has('network2hop')
}

/** A legible "why is this here" category, for the relevance chip. */
export type ForYouRelevanceReason = 'following' | 'network' | 'trending' | 'tag'

/**
 * A legible "why is this here" for the relevance chip `TimelineForYouItem.vue`
 * renders above a post — X's own "Because you follow this account" pattern,
 * which the feed had no equivalent of.
 *
 * Each category has to be something its mechanism can actually back up.
 * `network2hop` in particular is *only* "someone the viewer follows follows
 * this account" — `candidates.ts`'s `/api/v2/suggestions` retrieval has no
 * popularity or engagement threshold, so the chip must not claim one (an
 * earlier revision's copy read "Popular in your network," which the source
 * cannot support — a single-favourite post qualifies just as well as a
 * viral one). Likewise `tag`: it is seeded by `interleave(followed, engaged,
 * trending)` in `candidates.ts`, collapsing three different relationships to
 * the tag — followed, merely inferred from engagement, and instance-wide
 * trending — into one `CandidateSource`, with no way to tell them apart from
 * here. The chip's copy for `tag` therefore has to be true for *all three*,
 * which rules out "a tag you follow" (only true for one of them).
 *
 * Deliberately reads `PostCandidate.sources`/`inNetwork` rather than
 * `.reasons` (the scorer's numeric weighted-term breakdown — see
 * `scoreCandidate` in `ranking.ts`). `reasons`' labels are the scorer's own
 * internal vocabulary (action-probability keys, adjustment names), not a
 * stable public contract, and `ranking.ts` is being edited concurrently with
 * this file; a mapping keyed on those exact strings would silently go dark —
 * or mislabel — the moment that vocabulary shifts under it. `sources`/
 * `inNetwork` are the one part of `PostCandidate` that already *is* a stable,
 * typed, user-legible category: it is literally the field
 * {@link isFloorEligible} two lines up already trusts for a structural
 * decision, so trusting it here for a structural explanation is the same
 * boundary, not a new one.
 *
 * Priority mirrors how informative each category is to the viewer, not the
 * pipeline's fan-out order: in-network beats every out-of-network signal, and
 * `network2hop` (the highest-precision OON source, see `candidates.ts`) beats
 * the coarser `trending`/`tag`. `undefined` means nothing distinctive enough
 * to say — federated/local content with no other signal renders no chip,
 * which is the point: a chip on every post is clutter, not information.
 */
export function forYouRelevanceReason(candidate: PostCandidate): ForYouRelevanceReason | undefined {
  if (candidate.inNetwork)
    return 'following'
  if (candidate.sources.has('network2hop'))
    return 'network'
  if (candidate.sources.has('trending'))
    return 'trending'
  if (candidate.sources.has('tag'))
    return 'tag'
  return undefined
}

/**
 * How badly promoting `candidate` into the window would collide with what is
 * already there.
 *
 * `diversityRerank` already spread the page out along exactly this axis —
 * same author, near-duplicate content — before this function ever runs, so a
 * promotion that ignores it can walk right back into the clash the DPP pass
 * just paid to avoid. `embeddings` is built by the caller from
 * {@link embedCandidates} (see `enforceInNetworkFloor`) — the *corpus*-weighted
 * form, IDF-measured over every candidate the floor can see this round, which
 * is the same embedding definition (`embedFeatures` with IDF from
 * `computeTokenIdf`) `diversityRerank` itself uses. That still is not quite
 * "the same call": `diversityRerank`'s own MMR/DPP objective works over a
 * sparse CSR representation it builds internally and never calls
 * `cosineSimilarity`/`embedCandidate` directly, so this is the same
 * embedding space*, not literally the same code path. That distinction
 * matters here specifically because IDF is what makes token weight
 * language-neutral (see {@link embedCandidates}'s own doc) — the corpus-free
 * `embedCandidate` this function used before weighs every token identically
 * regardless of how common it is in the batch, which skews a bag-of-words
 * cosine toward whichever language dominates the page. A promotion decision
 * that runs once, over a small window, on already-ranked candidates cannot
 * afford to get that wrong for the sake of a cheaper embedding.
 *
 * Same author is an automatic, maximal collision regardless of content:
 * the embedding weights the author feature at 0.4 of the vector
 * (`WEIGHT_AUTHOR` in `diversity.ts`), diluted by tags/tokens/language/etc.,
 * so two very different posts by the same author can still land a low cosine.
 * The floor cannot rely on the embedding alone to catch that, so it checks
 * authorship directly — on the *underlying* post, so a boost collides with
 * its own original and with another boost of the same author, matching how
 * `extractCandidateFeatures` already attributes a reblog to its original
 * author.
 */
function floorCollisionScore(
  candidate: PostCandidate,
  window: readonly PostCandidate[],
  embeddings: ReadonlyMap<PostCandidate, Float64Array>,
): number {
  const embeddingOf = (entry: PostCandidate): Float64Array =>
    // `embeddings` is precomputed over the full `page + rest` corpus by
    // `enforceInNetworkFloor`, so every candidate this function ever sees is
    // already in it — the corpus-free fallback only guards a candidate this
    // call was not actually built to receive, rather than being an expected
    // path.
    embeddings.get(entry) ?? embedCandidate(entry)

  const author = underlyingStatus(candidate.status).account?.id
  let worst = 0
  for (const occupant of window) {
    if (occupant === candidate)
      continue
    if (author && author === underlyingStatus(occupant.status).account?.id)
      return Number.POSITIVE_INFINITY
    const similarity = cosineSimilarity(embeddingOf(candidate), embeddingOf(occupant))
    if (similarity > worst)
      worst = similarity
  }
  return worst
}

/**
 * Guarantees {@link IN_NETWORK_FLOOR_MIN} of the page's leading
 * {@link inNetworkFloorWindow} slots are floor-eligible, promoting into the
 * window when the natural ranking falls short.
 *
 * A safety net, not a quota: when the window already clears the floor on its
 * own, `page` and `rest` are returned untouched — this must never reorder a
 * ranking that already balances the follow graph. When it does not, the
 * worst-ranked non-eligible slots inside the window are swapped for the best
 * eligible candidates waiting to promote — ranked by floor tier first (true
 * in-network over `network2hop`), then by {@link floorCollisionScore} against
 * the window *as it stands after each swap*, so a second promotion in the
 * same call is scored against the first one's result rather than the
 * original, stale window. Promotion looks later in the *same page* first —
 * that content is already going out this round, so surfacing it earlier
 * costs nothing — and only reaches into `rest` (the next page's pool) if the
 * page itself cannot cover the floor. Every promotion is a swap, never an
 * insertion or a drop, so `page.length` and `rest.length` — and what they
 * collectively contain — are exactly what they were on the way in.
 *
 * Degrades honestly when the pool cannot support it: a viewer who follows
 * nobody, or a round where every followed account's posts already made the
 * page, has nothing left to promote, and this returns the input unchanged
 * rather than manufacturing representation that is not there. The same
 * honesty applies to collisions: if every eligible candidate collides with
 * the window, the floor still promotes the least-bad one rather than leaving
 * the structural guarantee unmet over a diversity preference.
 */
export function enforceInNetworkFloor(
  page: PostCandidate[],
  rest: PostCandidate[],
): { page: PostCandidate[], rest: PostCandidate[] } {
  const span = Math.min(inNetworkFloorWindow(page.length), page.length)
  if (span === 0)
    return { page, rest }

  const head = page.slice(0, span)
  let needed = IN_NETWORK_FLOOR_MIN - head.filter(isFloorEligible).length
  if (needed <= 0)
    return { page, rest }

  const tail = page.slice(span)
  const restCopy = [...rest]
  // IDF measured over every candidate the floor can see this round — `head`,
  // `tail` and `restCopy` between them are exactly `page` and `rest` — so
  // `floorCollisionScore`'s cosine similarity is language-neutral the same
  // way `diversityRerank`'s own embedding is. See that function's doc for why
  // the corpus-free `embedCandidate` is not an acceptable substitute here.
  const corpus = [...page, ...rest]
  const corpusVectors = embedCandidates(corpus)
  const embeddings = new Map<PostCandidate, Float64Array>(corpus.map((c, i) => [c, corpusVectors[i]!]))

  // Worst-ranked non-eligible slots inside the window — what a promotion
  // displaces, weakest first.
  const displaceableIndices = head
    .map((candidate, index) => ({ candidate, index }))
    .filter(entry => !isFloorEligible(entry.candidate))
    .sort((a, b) => b.index - a.index)
    .map(entry => entry.index)

  let displaceCursor = 0
  let changed = false

  const promoteFrom = (pool: PostCandidate[]) => {
    while (needed > 0 && displaceCursor < displaceableIndices.length) {
      // Greedy, re-evaluated per slot: `head` may already carry an earlier
      // promotion from this same call, and the next pick has to avoid
      // colliding with *that* too, not just the original window.
      let bestIndex = -1
      let bestTier = Number.POSITIVE_INFINITY
      let bestCollision = Number.POSITIVE_INFINITY
      for (let index = 0; index < pool.length; index++) {
        const candidate = pool[index]!
        if (!isFloorEligible(candidate))
          continue
        const tier = candidate.inNetwork ? 0 : 1
        if (tier > bestTier)
          continue
        if (tier < bestTier) {
          // A strictly better tier always wins outright — compute its
          // collision score once, so a later same-tier candidate has
          // something to compare against.
          bestIndex = index
          bestTier = tier
          bestCollision = floorCollisionScore(candidate, head, embeddings)
          continue
        }
        // Tied tier: the least-colliding candidate wins. Original (best
        // ranked) order breaks ties, since only a strict improvement moves
        // the pick — this scan never revisits an earlier, already-passed index.
        const collision = floorCollisionScore(candidate, head, embeddings)
        if (collision < bestCollision) {
          bestIndex = index
          bestCollision = collision
        }
      }
      if (bestIndex === -1)
        return

      const headIndex = displaceableIndices[displaceCursor++]!
      const displacedCandidate = head[headIndex]!
      // Swap in place: the promoted candidate takes the weak head slot, and
      // the displaced one takes exactly the slot the promoted one vacated —
      // so `pool`'s own length, and `head`'s, never change.
      head[headIndex] = pool[bestIndex]!
      pool[bestIndex] = displacedCandidate
      needed--
      changed = true
    }
  }

  promoteFrom(tail)
  promoteFrom(restCopy)

  if (!changed)
    return { page, rest }

  return { page: [...head, ...tail], rest: restCopy }
}

/**
 * The sources the first page is allowed to wait for.
 *
 * A pool fill resolves only when every source it was given has finished, so
 * making the first paint wait for the full fan-out would put it behind the
 * slowest tag timeline. The home timeline is the one request we know is cheap —
 * `TimelineHome` makes exactly it — so the first page ranks that alone and the
 * wide fan-out continues in the background, landing in time for page two.
 */
const FAST_SOURCES: CandidateSource[] = ['home']

export interface ForYouFeedOptions {
  /** Posts per page. Defaults to {@link DEFAULT_FOR_YOU_PAGE_SIZE}. */
  pageSize?: number
  /** Page size asked of each candidate source. */
  sourceLimit?: number
  /** How many tag timelines to fan out to. */
  maxTags?: number
  /** Defaults to `useMastoClient()`. Injected by tests. */
  client?: mastodon.rest.Client
  /** Injected by tests so ranking is deterministic. */
  now?: () => number
  /** Overrides for the pre-scoring filter chain. */
  prescoring?: PreScoringContext
  /** Overrides for the MMR rerank. */
  diversity?: DiversityRerankOptions
  /** Ranking overrides (weights, params). */
  ranking?: Pick<RankingContext, 'weights' | 'params'>
}

/**
 * What a refresh attempt did. `rateLimited` is a distinct outcome from "found
 * nothing": the first means the instance told us to back off and the viewer
 * should be told when to try again, the second means the fan-out genuinely
 * turned up nothing new. Collapsing them into one boolean makes a throttled
 * refresh look like a quiet timeline.
 */
export interface ForYouRefreshResult {
  updated: boolean
  /** True when the instance's 429 backoff blocked the attempt. */
  rateLimited?: boolean
  /** Milliseconds until the backoff expires, when `rateLimited`. */
  retryInMs?: number
}

export interface ForYouFeed {
  /**
   * A Masto.js-shaped paginator over ranked pages of statuses. Pass it to
   * `CommonPaginator` / `TimelinePaginator` like any other timeline.
   */
  paginator: mastodon.Paginator<mastodon.v1.Status[], mastodon.rest.v1.ListAccountStatusesParams>
  /** True once the feed has degraded to the chronological home timeline. */
  isFallback: Ref<boolean>
  /** Post keys emitted so far this session, in emission order. */
  served: Ref<string[]>
  /**
   * True once the pool has gone {@link POOL_STALE_MS} without a fill. Not a
   * live timer — recomputed on demand by {@link ForYouFeed.checkStale}, so the
   * caller (a component, which owns timers and visibility) decides how often
   * "on demand" is.
   */
  stale: Ref<boolean>
  /** Re-evaluates {@link ForYouFeed.stale} against the current time. */
  checkStale: () => void
  /**
   * Forces a fresh, top-of-timeline refill — new content, not a continuation
   * of where the pool's cursors left off — and reports whether anything not
   * already served came back. Does not touch what is currently rendered; the
   * caller decides what "updated" should do (see `TimelineForYou.vue`).
   */
  refresh: () => Promise<ForYouRefreshResult>
  /**
   * `status.id -> forYouRelevanceReason(candidate)` for every post emitted so
   * far — the data behind the "Because you follow this account" / "Popular
   * in your network" relevance chip. See {@link forYouRelevanceReason} for
   * why this reads `PostCandidate.sources`/`inNetwork` rather than the
   * scorer's own `.reasons`.
   */
  relevance: ReadonlyMap<string, ForYouRelevanceReason>
}

// ---------------------------------------------------------------------------
// Pure core — no network, no Nuxt. This is the part worth unit-testing.
// ---------------------------------------------------------------------------

export interface SelectPageOptions {
  pageSize: number
  /** Candidate keys already emitted this session. Never re-enter the pipeline. */
  servedKeys?: ReadonlySet<string>
  prescoring?: PreScoringContext
  diversity?: DiversityRerankOptions
}

export interface ForYouPageSelection {
  /** The page to emit, in final display order. */
  page: PostCandidate[]
  /** Everything ranked below the page. Stays in the pool for the next round. */
  rest: PostCandidate[]
}

/**
 * One turn of the pipeline: dedupe -> pre-scoring filters -> rank ->
 * conversation dedupe -> diversity rerank -> slice -> in-network floor.
 *
 * The pool has already been deduped and filtered once at fill time; running
 * both again here is idempotent and picks up everything that changed since —
 * most importantly the posts the viewer has just marked seen or dismissed,
 * which must not survive into the next page.
 *
 * Anything in `servedKeys` is dropped *before* scoring. That is what makes the
 * emitted prefix immutable: a post the viewer has already scrolled past cannot
 * be re-scored, so it cannot move.
 */
export function selectForYouPage(
  candidates: PostCandidate[],
  signals: ForYouSignals,
  ctx: RankingContext,
  options: SelectPageOptions,
): ForYouPageSelection {
  const served = options.servedKeys

  let pool = dedupeCandidates(candidates)
  if (served?.size)
    pool = pool.filter(candidate => !served.has(candidateKey(candidate.status)))

  pool = applyPreScoringFilters(pool, signals, options.prescoring)

  let ranked = rankCandidates(pool, signals, ctx)
  ranked = dedupeConversations(ranked)
  ranked = diversityRerank(ranked, options.diversity)

  const pageSize = Math.max(1, options.pageSize)
  return enforceInNetworkFloor(ranked.slice(0, pageSize), ranked.slice(pageSize))
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface FeedSession {
  /** Candidate keys already emitted, so they never come back. */
  servedKeys: Set<string>
  /** Emitted keys, in order, for `ForYouFeed.served`. */
  served: Ref<string[]>
  round: number
  emptyRounds: number
  isFallback: Ref<boolean>
  exhausted: boolean
  /**
   * `status.id -> forYouRelevanceReason(candidate)`, for the relevance chip.
   * A plain (non-reactive) `Map`: it is written once per status, synchronously,
   * before that status ever reaches `items` in `CommonPaginator` — by the time
   * a template reads it, the entry is already there, so there is nothing for
   * Vue's reactivity to need to track on the map itself.
   */
  relevance: Map<string, ForYouRelevanceReason>
}

function buildRankingContext(options: ForYouFeedOptions, signals: ForYouSignals): RankingContext {
  const now = options.now?.() ?? Date.now()
  const account = currentUser.value?.account
  const createdAt = account?.createdAt ? Date.parse(account.createdAt) : Number.NaN

  return {
    now,
    viewerId: account?.id,
    viewerLanguages: viewerLanguages(),
    viewerFollowingCount: account?.followingCount,
    viewerFollowerCount: account?.followersCount,
    viewerAccountAgeMs: Number.isNaN(createdAt) ? undefined : Math.max(0, now - createdAt),
    affinity: affinityResolver(signals, now),
    ...options.ranking,
  }
}

/**
 * Wires the affinity readings the scorer cannot derive on its own.
 *
 * `ranking.ts` deliberately does not import the signals store, so its default
 * `authorPenalty` can only see a *currently muted* author, and its default
 * `postPenalty` only a post whose own id is on the dismissal list. That makes
 * an account-level mute the only thing that generalizes: a "not interested" on
 * one post would otherwise score exactly as it did before on the author's next
 * post. Wiring `authorPenaltyIn` into `authorPenalty` is what turns a run of
 * dismissals into a decayed, saturating penalty on everything that author
 * posts — which is what the viewer meant — without ever touching
 * `postPenalty`, which stays scoped to the one post actually dismissed. See
 * `ranking.ts`'s `AffinityResolver` doc for why the two must not be merged:
 * `authorPenalty` alone floors `muteAuthor`, `postPenalty` alone floors
 * `notInterested`, and conflating them (the bug this replaced) made "not
 * interested" on a single post score identically to muting the whole account.
 *
 * The dismissed-post half of the default has to be carried over by hand, since
 * a partial resolver replaces each field rather than composing with it.
 */
export function affinityResolver(signals: ForYouSignals, now: number): RankingContext['affinity'] {
  const dismissedPosts = signals.notInterested
  const boosterAffinity = (signals as { boosterAffinity?: Record<string, number> }).boosterAffinity

  return {
    booster: id => affinitySignal(boosterAffinity, id),
    authorPenalty: accountId => authorPenaltyFor(signals, accountId, now),
    postPenalty: statusId => (statusId && dismissedPosts?.includes(statusId)) ? 1 : 0,
  }
}

/**
 * `authorPenaltyIn` walks the dismissal history and decays each entry, which
 * means it runs once per candidate per page over a store this module does not
 * own. A throw in there would take the entire feed down for a signal that is,
 * by design, an adjustment — so it degrades to the muted-authors check instead.
 */
function authorPenaltyFor(signals: ForYouSignals, accountId: string, now: number): number {
  try {
    return authorPenaltyIn(signals, accountId, now)
  }
  catch {
    return accountId && signals.mutedForYou?.includes(accountId) ? 1 : 0
  }
}

/** The viewer's preferred languages, most-preferred first, deduped. */
function viewerLanguages(): string[] {
  const languages: string[] = []
  try {
    const language = useUserSettings().value.language
    if (language)
      languages.push(language)
  }
  catch {
    // No Nuxt app (unit tests) — the ranker treats this as "no preference".
  }
  if (import.meta.client && typeof navigator !== 'undefined')
    languages.push(...(navigator.languages ?? []))

  return [...new Set(languages.filter(Boolean))]
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * The "For You" feed.
 *
 * Call once per timeline instance. The candidate pool it draws from is shared
 * per account and outlives the component, so switching tabs and coming back
 * resumes where the viewer left off instead of re-fetching; the per-session
 * state below (served posts, round counter, fallback flag) is what belongs to
 * this particular mount.
 */
export function useForYouFeed(options: ForYouFeedOptions = {}): ForYouFeed {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_FOR_YOU_PAGE_SIZE)

  const session: FeedSession = {
    servedKeys: new Set(),
    served: ref<string[]>([]),
    round: 0,
    emptyRounds: 0,
    isFallback: ref(false),
    exhausted: false,
    relevance: new Map(),
  }

  const signals = useForYouSignals()
  const poolState = useForYouCandidatePool()

  function resolveClient(): mastodon.rest.Client | undefined {
    if (options.client)
      return options.client
    try {
      return useMastoClient()
    }
    catch {
      return undefined
    }
  }

  function poolOptions(): PoolOptions {
    return {
      client: options.client,
      signals: signals.value,
      limit: options.sourceLimit,
      maxTags: options.maxTags,
      filters: {
        // `ResultSizeFilter`: on a quiet instance, relaxing the discretionary
        // filters beats handing back half a page.
        floor: pageSize,
        ...options.prescoring,
      },
    }
  }

  /**
   * Staleness and refresh.
   *
   * The fallback timeline has no "pool" to go stale — `fallbackPages` always
   * re-reads the chronological timelines fresh on every call — so staleness
   * only applies to the ranked path. `stale` is a plain ref, not a computed:
   * `Date.now()` is not a reactive dependency, so nothing would ever
   * re-evaluate a computed built on it. The component that renders this feed
   * owns timers and tab-visibility (`onActivated`/an interval), and calls
   * `checkStale()` when it wants a fresh answer — the same division of labour
   * `usePaginator.ts` already uses for its own 1s bounding-box poll.
   */
  const stale = ref(false)
  function checkStale(now: number = Date.now()) {
    stale.value = !session.isFallback.value
      && poolState.value.filledAt > 0
      && now - poolState.value.filledAt > POOL_STALE_MS
  }

  /**
   * Forces a fresh top-of-timeline refill and reports whether it turned up
   * anything the viewer has not already been served.
   *
   * `fillCandidatePool` (fresh: `resume=false`), not `refillCandidatePool`
   * (`resume=true`): the pool's cursors only ever walk *older*, since
   * `candidates.ts`'s source builders take `maxId` and nothing like `minId` —
   * resuming from them would fetch further into the past, which is the
   * opposite of "what's new." A fresh fill re-reads each source from its
   * true newest post, exactly what a manual refresh means.
   *
   * `force: true` bypasses our *own* minimum-interval throttle, which is a
   * self-imposed courtesy and exactly the thing an explicit user action should
   * override. `ignoreRateLimit` is deliberately **not** passed: that flag skips
   * the 429 backoff, and a 429 is the server telling us to stop. One refresh
   * costs a full fan-out (~40 requests plus relationship batches) against a
   * budget of 300 per 5 minutes that is shared with the *whole* of Elk — so
   * honouring it while rate-limited would let a viewer tapping "Show new posts"
   * degrade their own Following tab, notifications and everything else. When
   * the backoff is active we report it instead, and the caller tells the viewer
   * when to try again.
   *
   * `servedIds` (module-level in `candidates.ts`, shared with every mount)
   * already strips anything this session or a sibling mount has served from
   * the result, before this function ever sees it — so `fresh.length > 0` is
   * already the answer to "is there something new," with no need to
   * separately diff against `session.servedKeys`.
   *
   * Deliberately does not touch `session.servedKeys` or `session.round`:
   * clearing served keys on refresh would let a quiet instance's refresh
   * replay posts the viewer already scrolled past, which reads as broken, not
   * fresh — "new content" is the ask, not "start over." `round` stays put too,
   * since `MIN_VIABLE_FIRST_PAGE`'s fallback trigger is a one-time viability
   * verdict for the account, not something a single thin refresh batch
   * should be able to flip. What *does* reset is `exhausted`/`emptyRounds`,
   * since finding new content means the feed is no longer done, regardless of
   * whatever emptied it before.
   */
  async function refresh(): Promise<ForYouRefreshResult> {
    // Deliberately `Date.now()` and never `options.now`: that injected clock
    // reasons about how old a *post* is and tests pin it to a fixed instant,
    // but a backoff deadline is real elapsed time. `candidates.ts` draws the
    // same distinction in `noteRateLimit` for the same reason.
    //
    // Checked before the fallback branch too: `fallbackPages` re-reads the home
    // and local timelines, so a "refresh" there is still real network traffic
    // and still has to respect the backoff.
    const retryInMs = rateLimitRetryIn()
    if (retryInMs > 0)
      return { updated: false, rateLimited: true, retryInMs }

    if (session.isFallback.value) {
      // No pool to check ahead of time; the caller's remount re-runs
      // `fallbackPages`, which always re-reads fresh. Report "updated" so it
      // actually remounts rather than silently doing nothing.
      return { updated: true }
    }

    const fresh = await fillCandidatePool({ ...poolOptions(), force: true })
    const updated = fresh.length > 0
    if (updated) {
      session.exhausted = false
      session.emptyRounds = 0
    }
    // A fill that returned nothing may have been cut short by a 429 mid-fan-out
    // rather than genuinely finding nothing new — the two read very differently
    // to a viewer, so tell them apart.
    if (!updated) {
      const after = rateLimitRetryIn()
      if (after > 0)
        return { updated: false, rateLimited: true, retryInMs: after }
    }
    return { updated }
  }

  /**
   * The candidates to rank this round.
   *
   * Round zero is the one that decides how fast the feed paints, so it takes
   * the cheap in-network fill first and only waits for the wide fan-out when
   * the home timeline cannot fill a page on its own (a viewer who follows
   * nobody, or follows only quiet accounts).
   */
  async function loadCandidates(first: boolean): Promise<PostCandidate[]> {
    const opts = poolOptions()

    if (!first) {
      // A fill kicked off by the previous round is probably the wide one; join
      // it rather than serving a page from the in-network leftovers alone.
      if (poolState.value.status === 'filling')
        return refillCandidatePool(opts)
      return ensureCandidatePool(opts)
    }

    // A pool left warm by an earlier mount is already the wide one.
    if (poolState.value.candidates.length >= pageSize)
      return poolState.value.candidates

    const fast = await fillCandidatePool({ ...opts, sources: FAST_SOURCES })
    if (fast.length >= pageSize) {
      // Page one is served off the in-network fill; the rest of the fan-out
      // catches up in the background and lands in time for page two.
      void refillCandidatePool(opts)
      return fast
    }

    return refillCandidatePool(opts)
  }

  /** Marks a batch as emitted and returns the statuses to hand to the paginator. */
  function emit(candidates: PostCandidate[]): mastodon.v1.Status[] {
    const statuses: mastodon.v1.Status[] = []
    for (const candidate of candidates) {
      const key = candidateKey(candidate.status)
      if (session.servedKeys.has(key))
        continue
      session.servedKeys.add(key)
      session.served.value.push(key)
      statuses.push(candidate.status)

      // Keyed by the *rendered* status's own id (which `TimelineForYouItem`
      // receives as a prop), not `candidateKey` — a boost and the post it
      // wraps can carry different relevance if only one was actually sourced
      // in-network.
      const reason = forYouRelevanceReason(candidate)
      if (reason)
        session.relevance.set(candidate.status.id, reason)
    }

    if (statuses.length) {
      // Both ids: a boost and the post it wraps must not come back separately.
      consumeCandidates(statuses.flatMap(status => status.reblog
        ? [status.id, status.reblog.id]
        : [status.id]))
    }

    return statuses
  }

  function emitStatuses(statuses: mastodon.v1.Status[]): mastodon.v1.Status[] {
    return emit(statuses.map(status => ({ status, sources: new Set<CandidateSource>(), inNetwork: false })))
  }

  /**
   * The graceful-degradation path: a plain chronological home timeline, with
   * anything the ranked feed already served filtered out. If the viewer follows
   * nobody at all, their own instance's local timeline stands in — a brand-new
   * account must still see *something*.
   */
  async function* fallbackPages(
    client: mastodon.rest.Client,
  ): AsyncGenerator<mastodon.v1.Status[], undefined, unknown> {
    session.isFallback.value = true

    // Both sources are individually fault-tolerant, matching how `candidates.ts`
    // treats its fan-out. This is the *last* line of defence for the feed: it
    // runs precisely when the ranked pipeline could not deliver, which is
    // correlated with the instance being unhealthy — rate-limiting us, timing
    // out, or 404ing an endpoint it does not implement. An uncaught throw here
    // does not degrade the feed, it destroys it, surfacing a raw error where
    // the viewer should have seen a chronological timeline.
    let served = 0
    try {
      for await (const page of client.v1.timelines.home.list({ limit: pageSize }).values()) {
        const statuses = emitStatuses(filterAndReorderTimeline(page, 'home'))
        if (!statuses.length)
          continue
        served += statuses.length
        yield statuses
      }
    }
    catch (e) {
      console.warn('[for-you] home fallback failed', e)
    }

    if (served > 0)
      return undefined

    try {
      for await (const page of client.v1.timelines.public.list({ limit: pageSize, local: true }).values()) {
        const statuses = emitStatuses(filterAndReorderTimeline(page, 'public'))
        if (statuses.length)
          yield statuses
      }
    }
    catch (e) {
      console.warn('[for-you] local fallback failed', e)
    }

    return undefined
  }

  async function* rankedPages(
    client: mastodon.rest.Client,
  ): AsyncGenerator<mastodon.v1.Status[], undefined, unknown> {
    while (!session.exhausted) {
      const round = session.round++
      const candidates = await loadCandidates(round === 0)

      const { page } = selectForYouPage(
        candidates,
        signals.value,
        buildRankingContext(options, signals.value),
        {
          pageSize,
          servedKeys: session.servedKeys,
          prescoring: poolOptions().filters,
          diversity: options.diversity,
        },
      )
      const statuses = emit(page)

      // A first page this thin means the candidate pool itself is the problem —
      // a small instance, a dead federated timeline, or an account that follows
      // nobody. Show what we ranked, then hand over to the home timeline.
      if (round === 0 && statuses.length < MIN_VIABLE_FIRST_PAGE) {
        if (statuses.length)
          yield statuses
        yield* fallbackPages(client)
        return undefined
      }

      if (!statuses.length) {
        if (++session.emptyRounds > MAX_EMPTY_ROUNDS) {
          session.exhausted = true
          return undefined
        }
        // Nothing was consumed, so `ensureCandidatePool` would hand back the
        // same pool forever. Force the sources forward instead.
        await refillCandidatePool(poolOptions())
        continue
      }

      session.emptyRounds = 0
      yield statuses
    }

    return undefined
  }

  async function* pages(): AsyncGenerator<mastodon.v1.Status[], undefined, unknown> {
    const client = resolveClient()
    if (!client)
      return undefined

    if (session.isFallback.value)
      yield* fallbackPages(client)
    else
      yield* rankedPages(client)

    return undefined
  }

  const paginator: ForYouFeed['paginator'] = {
    values: () => pages(),
    getDirection: () => 'next',
    setDirection: () => paginator,
    [Symbol.asyncIterator]: () => pages(),
    // `Paginator` is `PromiseLike`, so awaiting one yields its first page.
    then<TResult1 = mastodon.v1.Status[], TResult2 = never>(
      onfulfilled?: ((value: mastodon.v1.Status[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return pages()
        .next()
        .then(result => result.value ?? [])
        .then(onfulfilled, onrejected)
    },
  }

  return {
    paginator,
    isFallback: session.isFallback,
    served: session.served,
    stale,
    checkStale,
    refresh,
    relevance: session.relevance,
  }
}

// ---------------------------------------------------------------------------
// UI glue
// ---------------------------------------------------------------------------

/**
 * Whether a stale pool should refresh itself without the viewer asking.
 *
 * True only at the very top of the feed, where there is nothing above the
 * fold to disturb — replacing what is rendered anywhere else would yank
 * content out from under someone mid-read, which is exactly what
 * `TimelineForYou.vue`'s "Show new posts" banner exists to let the viewer
 * choose instead. Pulled out as its own function so this one decision rule
 * — the crux of "does a refresh ever touch the screen without being asked" —
 * has a direct unit test, since the repo has no harness for mounting a
 * component and simulating scroll to test it any other way.
 */
export function shouldAutoRefreshForYou(stale: boolean, atTop: boolean): boolean {
  return stale && atTop
}

/**
 * Floor on how often the AUTOMATIC refresh path may fire, independent of
 * {@link shouldAutoRefreshForYou}.
 *
 * `stale` flips true every `POOL_STALE_MS` (5 minutes) and, per
 * `shouldAutoRefreshForYou`, a viewer who opens For You and leaves it idling
 * at the top satisfies both halves of that rule continuously — nothing about
 * it self-limits. One refresh is a full fan-out (~40 requests plus
 * relationship batches) against a 300-per-5-minute budget shared with the
 * whole* of Elk, so "every 5 minutes, forever, with zero interaction" is a
 * real cost, not a hypothetical one. This is that self-limit: a *separate*
 * cooldown that only the automatic path (never the explicit "Show new posts"
 * click — see `canAutoRefreshForYou`) has to clear.
 *
 * Deliberately the same order of magnitude as `POOL_STALE_MS` rather than
 * something shorter: the floor only has to be *at least* as patient as
 * staleness itself for a quiet instance to stop re-triggering every poll: see
 * {@link autoRefreshIntervalMs} for what makes it grow past that.
 */
export const AUTO_REFRESH_MIN_INTERVAL_MS = POOL_STALE_MS

/**
 * Ceiling the backoff below is not allowed to grow past, however many
 * consecutive automatic refreshes come back empty. An unbounded backoff would
 * eventually stop checking at all for a viewer who left a tab open for hours;
 * this keeps "the instance has been quiet a while" distinct from "stop
 * looking forever."
 */
export const AUTO_REFRESH_MAX_INTERVAL_MS = AUTO_REFRESH_MIN_INTERVAL_MS * 8

/**
 * How long the automatic path must wait since its last attempt, given how
 * many of its most recent attempts in a row found nothing new (`updated:
 * false`, including a rate-limited attempt — see `TimelineForYou.vue`'s
 * `performRefresh`).
 *
 * The first empty attempt costs nothing extra — it waits the same floor as a
 * fresh gate (`consecutiveEmpty` of 0 or 1 both resolve to
 * `AUTO_REFRESH_MIN_INTERVAL_MS`) — and interval doubles from the *second*
 * consecutive empty attempt onward, saturating at
 * {@link AUTO_REFRESH_MAX_INTERVAL_MS}: a quiet instance is asked about
 * exponentially less often instead of every `POOL_STALE_MS` forever, the same
 * shape `candidates.ts`'s own rate-limit backoff (`RATE_LIMIT_BACKOFF_MS`,
 * doubled per consecutive 429) already uses for the same reason — one empty
 * poll is unremarkable, but a *run* of them is the instance telling us to
 * slow down.
 */
export function autoRefreshIntervalMs(consecutiveEmpty: number): number {
  const doublings = Math.max(0, consecutiveEmpty - 1)
  return Math.min(AUTO_REFRESH_MAX_INTERVAL_MS, AUTO_REFRESH_MIN_INTERVAL_MS * 2 ** doublings)
}

/**
 * The automatic path's own memory, distinct from anything `feed.ts`'s session
 * tracks: how long ago it last attempted a refresh, and how many of the most
 * recent attempts in a row found nothing. Owned by the component (a plain
 * `ref`, like `stale` itself) rather than this module, since it is UI-timing
 * state, not feed data — resetting it on remount is fine, unlike
 * `session.servedKeys`.
 */
export interface AutoRefreshGate {
  /**
   * `Date.now()` of the last automatic attempt, or `undefined` if there has
   * not been one yet. Not `0` as the "never attempted" sentinel: an injected
   * clock (tests, or a `now` that starts counting from epoch) can genuinely
   * pass `0` as a real timestamp, which a numeric sentinel would collide with.
   */
  lastAttemptAt: number | undefined
  /** Consecutive automatic attempts in a row that did not find anything new. */
  consecutiveEmpty: number
}

/** A gate that has never fired — the automatic path's initial state. */
export function initialAutoRefreshGate(): AutoRefreshGate {
  return { lastAttemptAt: undefined, consecutiveEmpty: 0 }
}

/**
 * Whether the automatic path is allowed to attempt a refresh right now.
 *
 * Purely the cooldown/backoff rule — visibility and focus are DOM concerns
 * `TimelineForYou.vue` checks itself before ever calling this, and
 * {@link shouldAutoRefreshForYou}'s fold-safety rule (stale + at the top) is
 * a separate, already-tested gate this composes with rather than replaces.
 */
export function canAutoRefreshForYou(gate: AutoRefreshGate, now: number = Date.now()): boolean {
  if (gate.lastAttemptAt === undefined)
    return true
  return now - gate.lastAttemptAt >= autoRefreshIntervalMs(gate.consecutiveEmpty)
}

/**
 * The gate's next state after one automatic attempt. `updated` resets the
 * backoff to the floor — the instance is not quiet anymore, so the next
 * staleness cycle should be checked promptly again; anything else (including
 * a rate-limited attempt) extends it by one step.
 */
export function nextAutoRefreshGate(gate: AutoRefreshGate, updated: boolean, now: number = Date.now()): AutoRefreshGate {
  return {
    lastAttemptAt: now,
    consecutiveEmpty: updated ? 0 : gate.consecutiveEmpty + 1,
  }
}

export type ForYouDismissReason = 'not_interested' | 'author'

/**
 * The feedback actions a For You item offers to its descendants.
 *
 * Provided per post by `TimelineForYouItem` and consumed by
 * `StatusActionsMore`, so the shared status dropdown grows two extra entries
 * inside this feed and stays untouched everywhere else. An injection instead of
 * a prop because the dropdown sits three components deep inside `StatusCard`.
 */
export interface ForYouItemControls {
  /** "Not interested": dismiss this post and penalise its author/tags/language. */
  notInterested: () => void
  /** "Show less from this account": hide the author from this feed only. */
  showLessFromAuthor: () => void
}

export const forYouItemInjectionKey = Symbol('for-you-item') as InjectionKey<ForYouItemControls>

// Undoing a single-post dismissal (the "Undo" on the "Post hidden" toast) is
// `signals.ts`'s own `forgetNotInterested(statusId)` — called directly from
// `TimelineForYouItem.vue`, auto-imported like `markNotInterested`/
// `muteAuthorForYou` already are. This module previously carried a
// hand-rolled equivalent, built against only `signals.ts`'s public exports
// because `forgetNotInterested` did not exist yet; now that it does, one
// implementation is better than two that have to be kept in sync by hand.
