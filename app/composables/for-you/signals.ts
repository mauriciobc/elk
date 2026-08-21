import type { mastodon } from 'masto'
import type { Ref } from 'vue'
import type { ForYouCounterAction, ForYouCounters, ForYouEngagementKindName, ForYouSignals } from './types'

/**
 * The viewer model for the "For You" feed.
 *
 * Phoenix represents a viewer by *what they interacted with*: the user tower
 * has no learned per-user id embedding, it encodes an engagement **sequence**
 * plus a coarse profile token. home-mixer materialises that sequence as
 * `EngagementSignal { tweet_id, author_id, engaged_at_ms }`, bucketed per
 * engagement type and `sort_dedup_truncate`d to a handful of the most recent
 * entries per type (`home-mixer/models/engagement_signals.rs`).
 *
 * Every field of that struct is observable in a Mastodon client, so the
 * sequence is the source of truth here too. The affinity maps the contract
 * exposes (`authorAffinity`, `tagAffinity`, `languageAffinity`) are a *derived
 * cache* recomputed from the sequence — counters are derivable from a
 * sequence, a sequence is not derivable from counters. Consequences worth
 * knowing:
 *
 * - decay is a property of each signal's age, not of a mutable running total,
 *   so it is path-independent and cannot be corrupted by a bad clock;
 * - no affinity ceiling, no trim-by-absolute-value heuristic — the sequence is
 *   already bounded at {@link MAX_SIGNALS_PER_KIND} per type;
 * - the whole derived layer is rebuildable after a bug: drop it and re-derive.
 *
 * Bookkeeping the home-mixer filters need lives alongside it:
 * `PreviouslySeenPostsFilter` -> `seen`, `AuthorSocialgraphFilter` ->
 * `mutedForYou`.
 *
 * Everything is per-account: Elk is multi-account and one viewer's taste must
 * never leak into another's feed. `useUserLocalStorage` keys by the current
 * user's `acct` and returns a plain ref on the server, so this module is
 * SSR-safe by construction.
 */

/** Storage key, kept local to the feature so it does not clutter `~/constants`. */
export const STORAGE_KEY_FOR_YOU_SIGNALS = 'elk-for-you-signals'

/** Bumped when the persisted shape changes; see {@link normalizeSignals}. */
export const SIGNALS_VERSION = 3

/**
 * The engagements we can observe from the client.
 *
 * `favourite`/`reblog`/`reply`/`quote`/`bookmark` are X's own
 * `EngagementSignalType`s; `follow` is `FollowAuthorWeight`; `photoExpand`,
 * `videoOpen`, `openLink`, `profileClick` and `open` are its click family;
 * `dwell`/`notDwelled` are the attention pair. `vote` has no X analogue — X
 * has no polls — and is treated as a deliberate interaction.
 */
export type ForYouEngagementKind
  = | 'favourite'
    | 'reblog'
    | 'reply'
    | 'quote'
    | 'bookmark'
    | 'follow'
    | 'vote'
    | 'open'
    | 'openLink'
    | 'profileClick'
    | 'photoExpand'
    | 'videoOpen'
    | 'dwell'
    | 'notDwelled'

export const ENGAGEMENT_KINDS: ForYouEngagementKind[] = [
  'favourite',
  'reblog',
  'reply',
  'quote',
  'bookmark',
  'follow',
  'vote',
  'open',
  'openLink',
  'profileClick',
  'photoExpand',
  'videoOpen',
  'dwell',
  'notDwelled',
]

/**
 * `types.ts` duplicates {@link ForYouEngagementKind} as
 * `ForYouEngagementKindName`, because it is the shared type root and must not
 * depend on this store. This is the assertion that the two agree — and it
 * checks *equality*, in both directions.
 *
 * One direction alone is not enough, which is why this is spelled out rather
 * than left to the `COUNTER_ACTION_KEYS` spread below: that spread only proves
 * `ForYouEngagementKind` is assignable *into* `ForYouCounterAction`, so adding
 * a kind here without adding it there fails, but adding a name *there* which
 * has no kind here passes silently — and `base-rates.ts` would then map a head
 * to a counter nothing can ever write.
 *
 * The `[T] extends [U]` bracketing is deliberate: bare `extends` on a naked
 * type parameter distributes over the union and would make this vacuously true.
 */
type EngagementKindsAgree
  = [ForYouEngagementKind] extends [ForYouEngagementKindName]
    ? [ForYouEngagementKindName] extends [ForYouEngagementKind] ? true : never
    : never
const _engagementKindsAgree: EngagementKindsAgree = true
void _engagementKindsAgree

/** One observed interaction, the client-side twin of X's `EngagementSignal`. */
export interface EngagementSignal {
  /** `tweet_id`. For a follow, a synthetic `follow:<accountId>` id. */
  statusId: string
  /** `author_id` — the *original* author, never the booster. */
  authorId?: string
  /** Whoever put this in front of the viewer, when it arrived as a boost. */
  boosterId?: string
  tags: string[]
  language?: string
  /** `engaged_at_ms`. */
  at: number
  /** The author follows the viewer back (`BidirectionalFollow*` boosts). */
  mutual?: boolean
  /**
   * Continuous magnitude, for kinds that have one. Only `dwell` sets it today
   * (seconds in view, normalized); everything else is a plain occurrence.
   */
  weight?: number
}

/**
 * What we persist. A superset of the {@link ForYouSignals} contract, so it can
 * be handed to `candidates.ts`/`ranking.ts` unchanged, with the sequence and
 * the negative history the contract has no field for.
 */
export interface ForYouSignalsStore extends ForYouSignals {
  version: number
  /** The engagement sequence, newest first, per type. */
  engaged: Partial<Record<ForYouEngagementKind, EngagementSignal[]>>
  /** Posts the viewer explicitly dismissed, with what they were about. */
  dismissed: EngagementSignal[]
  /** Derived, like the affinity maps: accountId -> weight for *boosters*. */
  boosterAffinity: Record<string, number>
  /**
   * Lifetime observation counts for measured base rates (`INTERCEPT.md` §3).
   *
   * Raw observations, not derived state: unlike the affinity maps above,
   * these are never decayed, never evicted, and must survive a
   * `SIGNALS_VERSION` bump — see the `stale` handling in
   * {@link normalizeSignals}. `|engaged[kind]| / |seen|` looks like the
   * estimator and is not one, because both sides are capped
   * (`MAX_SIGNALS_PER_KIND` over `MAX_SEEN`) and the numerator is also
   * decayed; these counters exist to be the honest ratio instead.
   */
  counters: ForYouCounters
  /**
   * Ids For You actually put on screen — the population `counters` measures
   * against. Bounded and evicted like `seen` (same {@link MAX_SEEN}), but a
   * genuinely separate array: `seen` is also written from
   * `masto/routes.ts`'s status-detail navigation, which is not a For You
   * impression and must never be mistaken for one (the "population trap",
   * `INTERCEPT.md` §3). Written only from {@link recordForYouImpression}.
   */
  impressed: string[]
  /**
   * Authors For You put on screen **out of network** — the population
   * `followAuthor`'s numerator is drawn from, and the one head that cannot use
   * {@link impressed}.
   *
   * A follow is not an action on a *post*: `toggleFollowAccount` fires from
   * profile pages, hover cards, account lists and the report modal, none of
   * which has a status in scope, and `recordFollow` stores a synthetic
   * `follow:<accountId>` key that can never be in `impressed`. Attributing by
   * author instead is what makes the head measurable at all — and it is the
   * right population, because `predictActions` gates `followAuthor` on
   * `!inNetwork` (following someone you already follow is not an action that
   * exists), which is exactly the `eligible.outOfNetwork` denominator this
   * pairs with.
   *
   * Raw observation like {@link impressed} and {@link counters}, but a recency
   * list rather than an append buffer: capped at {@link MAX_IMPRESSED_AUTHORS}
   * with a re-impression moving the author back to the front.
   */
  impressedAuthors: string[]
}

/**
 * How much *one observed action* moves affinity, on a count scale where a
 * favourite is 1.
 *
 * These are **not** the value-model weights from
 * `home-mixer/params/param.rs`, and they are not derived from them either.
 * Those weights multiply a *predicted probability*, and that file's own
 * comment block warns their ratios must not be read as count equivalences: a
 * large part of `ReplyWeight` 5.0 vs `FavoriteWeight` 0.5 is base-rate
 * normalization (replies are rarer than favourites), not ten times the value.
 * Spending 10x per reply in a counter store would commit exactly the fallacy
 * that comment rejects.
 *
 * What follows is therefore **a hand-set ordering with a monotone squash**,
 * not a derivation. `1 + log2(w / FavoriteWeight)` was the starting point
 * because it preserves X's ordering while compressing the spread, but it is
 * not honoured where judgement disagreed with it — three rows below depart
 * from it deliberately, and the squash cannot express the continuous or
 * negative signals at all. No claim is made that the residue is
 * "value net of base rate"; the honest claim is "same order, smaller spread,
 * rounded to legible numbers".
 *
 * | action       | X weight                  | squash | ours | why it differs      |
 * | ------------ | ------------------------- | -----: | ---: | ------------------- |
 * | follow       | `FollowAuthorWeight` 4.0  |   4.00 |    5 | only durable one    |
 * | reply        | `ReplyWeight` 5.0         |   4.32 |    4 | rounded down        |
 * | quote        | `QuoteWeight` 5.0         |   4.32 |    4 | rounded down        |
 * | bookmark     | `ShareWeight` 2.0         |   3.00 |    3 |                     |
 * | reblog       | `RetweetWeight` 1.0       |   2.00 |    2 |                     |
 * | favourite    | `FavoriteWeight` 0.5      |   1.00 |    1 | the unit            |
 * | vote         | (no analogue)             |      — |    1 | deliberate, ≈ a fav |
 * | open         | `ClickWeight` 0.4         |   0.68 |  0.5 | rounded down        |
 * | openLink     | `OpenLinkWeight` 0.2      |   0.00 |  0.5 | leaving the app     |
 * | profileClick | `ProfileClickWeight` 0.0  |     —  |  0.5 | see below           |
 * | photoExpand  | `PhotoExpandWeight` 0.05  |  -2.32 | 0.25 | squash goes < 0     |
 * | videoOpen    | `VideoOpenWeight` 0.05    |  -2.32 | 0.25 | squash goes < 0     |
 * | dwell        | `ContDwellTimeWeight` .004| undef. | 0.25 | continuous, scaled  |
 * | notDwelled   | `NotDwelledWeight` -0.02  | undef. |-0.05 | negative            |
 *
 * `profileClick` departs furthest: X weights it 0.0. In a global model that
 * reflects how weakly it predicts *anything* across billions of users; in a
 * per-viewer store with a handful of signals, "I went to look at who this is"
 * is real interest, so it is kept at the weight of a click.
 *
 * Ordering is what actually survives: `ranking.ts` rank-transforms these maps
 * into a within-sign percentile, so only the induced order matters downstream.
 * That makes {@link MIN_EVIDENCE} and {@link EVIDENCE_CAP} more load-bearing
 * than the numbers here.
 *
 * **On `openLink`/`profileClick`/`photoExpand`/`videoOpen` now being live.**
 * These four sat in this table with real weights while nothing in the app
 * called {@link recordEngagement} for them, so they contributed nothing. Their
 * writers are wired now (`StatusPreviewCard.vue`, `StatusAttachment.vue`,
 * `StatusCard.vue`), which means they feed **affinity**, not just the
 * measurement counters — and affinity is read by the ranker whether or not the
 * `personalizeForYouRanking` preference is on.
 *
 * That is deliberate, and it is not a new class of behaviour: `open` has been
 * wired globally at `masto/routes.ts:97` all along at this same 0.5, so the
 * feed has always taken weak click signals as evidence. These four are the
 * rest of the same family, at or below its weight, and the affinity maps decay
 * and are capped ({@link EVIDENCE_CAP}), so no amount of casual tapping can
 * dominate a favourite or a follow. Zero them here if that trade is ever
 * unwanted — the counters would keep working, because the population gate is
 * what governs those, not this table.
 */
export const ENGAGEMENT_STRENGTH: Record<ForYouEngagementKind, number> = {
  follow: 5,
  reply: 4,
  quote: 4,
  bookmark: 3,
  reblog: 2,
  favourite: 1,
  vote: 1,
  open: 0.5,
  openLink: 0.5,
  profileClick: 0.5,
  photoExpand: 0.25,
  videoOpen: 0.25,
  dwell: 0.25,
  notDwelled: -0.05,
}

/**
 * `BidirectionalFollowReplyWeightBoost` triples `ReplyWeight` (5.0 -> 15.0)
 * when the author follows the viewer back. Same multiplier, same reason: an
 * exchange with a mutual says more than one with a stranger.
 */
export const MUTUAL_MULTIPLIER = 3

/**
 * Penalty for an explicit dismissal, on the same count scale.
 *
 * X's `NotInterestedWeight` is -43.2. That number is calibrated against the
 * very low base rate of the *predicted* probability and belongs to the scorer,
 * not to a counter store — the same argument that made us compress the
 * positive ratios. One dismissal undoes four favourites: strongly negative,
 * still recoverable.
 */
export const NOT_INTERESTED_STRENGTH = -4

/** A post's tags and language are weaker evidence than its author. */
const TAG_SHARE = 0.5
const LANGUAGE_SHARE = 0.25
/** Boosting is Mastodon's discovery mechanism, but it is a weaker endorsement. */
const BOOSTER_SHARE = 0.5
/** Hashtag-stuffed posts must not spray affinity over a dozen tags. */
const MAX_TAGS_PER_SIGNAL = 5

/** `sort_dedup_truncate` per type. X keeps 15; a client can afford more. */
export const MAX_SIGNALS_PER_KIND = 50

/**
 * Follows are not an engagement sequence.
 *
 * X carries `followed_user_ids` in `UserFeatures` as a **complete set** and
 * applies `sort_dedup_truncate` only to the engagement history. Truncating
 * follows the same way would let fifty favourites evict a follow from three
 * months ago, which is backwards: a favourite is an event, a follow is a
 * standing statement that stays true until revoked. So follows get their own,
 * far larger bucket — the only bound is what we are willing to keep in
 * `localStorage` — and their own decay horizon (see {@link KIND_HALF_LIFE_MS}).
 */
export const MAX_FOLLOW_SIGNALS = 1000

export const MAX_SIGNALS_BY_KIND: Partial<Record<ForYouEngagementKind, number>> = {
  follow: MAX_FOLLOW_SIGNALS,
}

export function maxSignalsFor(kind: ForYouEngagementKind): number {
  return MAX_SIGNALS_BY_KIND[kind] ?? MAX_SIGNALS_PER_KIND
}

/**
 * How many signals of one kind can speak for a single author/tag/language.
 *
 * Without this the per-kind bucket sizes decide the outcome: fifty casual
 * opens of one spammy author derived to ~25, while one deliberate follow
 * derived to 5, so idle clicking outranked explicit endorsement 5:1. Capping
 * the *count* per source restores the intended order — repetition of a weak
 * signal saturates, it does not accumulate without limit. Signals are stored
 * newest first, so the cap keeps the most recent occurrences.
 */
export const EVIDENCE_CAP: Record<ForYouEngagementKind, number> = {
  // A follow is one statement per author by construction.
  follow: 1,
  // Deliberate acts: ten of them may legitimately outweigh a follow.
  favourite: 10,
  reblog: 10,
  reply: 10,
  quote: 10,
  bookmark: 10,
  vote: 10,
  // Passive or incidental: saturates fast, so 50 opens (2.0) < 1 follow (5).
  open: 4,
  openLink: 4,
  profileClick: 4,
  photoExpand: 4,
  videoOpen: 4,
  dwell: 4,
  notDwelled: 8,
}

/** Dismissals are deliberate, so they count like the deliberate kinds. */
const DISMISSAL_EVIDENCE_CAP = 10

/**
 * Evidence floor for a *positive* derived entry.
 *
 * `ranking.ts` rank-transforms each affinity map into a percentile within its
 * sign class, so magnitudes vanish and only membership and order survive. A
 * viewer with exactly one entry — say a single accidental `open` worth 0.5 —
 * would therefore see that author scored at the top of the positive class, a
 * "strong affinity" manufactured from one stray tap. Requiring three quarters
 * of a favourite before an entry exists at all means one incidental click,
 * photo expand or dwell never creates one; a second occurrence, or any one
 * deliberate act, does.
 *
 * Negative entries are exempt: `notDwelled` is deliberately tiny and is
 * supposed to accumulate at impression volume.
 */
export const MIN_EVIDENCE = 0.75

/** Dismissals are rarer, and we want them to outlive a scroll session. */
export const MAX_DISMISSED = 200
/** `PreviouslySeenPostsFilter` uses bloom filters; we use a capped ring buffer. */
export const MAX_SEEN = 3000
const MAX_NOT_INTERESTED = 500
/** `AuthorSocialgraphFilter`'s muted set, bounded like everything else here. */
export const MAX_MUTED = 500
/**
 * Authors seen out-of-network in For You — the population `followAuthor`'s
 * numerator is drawn from (see {@link recordForYouImpressionInSignals}).
 *
 * Smaller than {@link MAX_SEEN} on purpose: this is authors, not posts, and a
 * feed that shows the same stranger three times only adds one entry. It is a
 * **recency** list, not an observation buffer — a re-impression moves the author
 * back to the front — so at the cap it holds the most recent 1000 strangers,
 * which is a far longer window than the follow decision it has to survive.
 */
export const MAX_IMPRESSED_AUTHORS = 1000

/** Affinities halve every two weeks, so yesterday's binge does not ossify. */
export const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * A follow decays on a seasonal scale, not a fortnightly one.
 *
 * The half-life exists so a burst of attention fades; a follow is not a burst
 * of attention. Keeping it at the engagement half-life would silently undo the
 * complete-set treatment above — the entry would survive in the sequence but
 * contribute nothing after two months.
 */
export const FOLLOW_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000

export const KIND_HALF_LIFE_MS: Partial<Record<ForYouEngagementKind, number>> = {
  follow: FOLLOW_HALF_LIFE_MS,
}

export function halfLifeFor(kind: ForYouEngagementKind): number {
  return KIND_HALF_LIFE_MS[kind] ?? DECAY_HALF_LIFE_MS
}

/** Do not recompute on every navigation; derivation is exact regardless. */
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Past this many half-lives a signal contributes nothing measurable. */
const MAX_DECAY_HALF_LIVES = 13
/** Below this a derived entry is noise — do not persist it. */
const PRUNE_BELOW = 0.05

/**
 * Dwell accounting, per `ContDwellTimeWeight` (0.004/s) and `NotDwelledWeight`
 * (-0.02) with the `DwellRegretDwellFloor` of one second.
 *
 * Under {@link DWELL_MIN_MS} in view is "shown and ignored" and records a
 * `notDwelled`; at or over it, a `dwell` scaled continuously by how long,
 * saturating at {@link DWELL_SATURATION_MS} so one abandoned tab cannot
 * outweigh a viewer's whole history. `DWELL_REFERENCE_MS` is the duration
 * worth one full `dwell` strength — phoenix gates its own attentive-view label
 * at 10 seconds (`recsys_batch.py`), so we use the same figure.
 */
export const DWELL_MIN_MS = 2000
export const DWELL_REFERENCE_MS = 10_000
export const DWELL_SATURATION_MS = 60_000

/** What an engagement teaches us about the viewer. */
export interface EngagementTarget {
  statusId?: string
  authorId?: string
  boosterId?: string
  tags: string[]
  language?: string
  mutual?: boolean
  /**
   * Continuous multiplier on the kind's strength, for signals that have a
   * magnitude (dwell time). Defaults to 1.
   */
  weight?: number
}

// ---------------------------------------------------------------------------
// Pure core — no Nuxt, no reactivity, unit-testable on its own.
// ---------------------------------------------------------------------------

export function createEmptySignals(): ForYouSignalsStore {
  return {
    version: SIGNALS_VERSION,
    engaged: {},
    dismissed: [],
    authorAffinity: {},
    boosterAffinity: {},
    tagAffinity: {},
    languageAffinity: {},
    seen: [],
    notInterested: [],
    mutedForYou: [],
    lastDecay: 0,
    counters: {
      impressions: 0,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 0 },
      actions: {},
    },
    impressed: [],
    impressedAuthors: [],
  }
}

/** Every key {@link ForYouCounters.actions} can be indexed by. */
const COUNTER_ACTION_KEYS: ForYouCounterAction[] = [...ENGAGEMENT_KINDS, 'dismiss', 'mute']

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Repairs a persisted `counters` blob the same way the rest of the store is repaired. */
function normalizeCounters(value: unknown): ForYouCounters {
  const raw = isRecord(value) ? value : {}
  const rawEligible = isRecord(raw.eligible) ? raw.eligible : {}
  const rawActions = isRecord(raw.actions) ? raw.actions : {}

  const actions: Partial<Record<ForYouCounterAction, number>> = {}
  for (const key of COUNTER_ACTION_KEYS) {
    const n = nonNegativeNumber(rawActions[key])
    if (n > 0)
      actions[key] = n
  }

  return {
    impressions: nonNegativeNumber(raw.impressions),
    eligible: {
      hasLink: nonNegativeNumber(rawEligible.hasLink),
      hasMedia: nonNegativeNumber(rawEligible.hasMedia),
      outOfNetwork: nonNegativeNumber(rawEligible.outOfNetwork),
    },
    actions,
  }
}

/**
 * Which observed population a counter's numerator has to belong to.
 *
 * Almost everything is `{ post }`: the action happened *to a post*, and only
 * posts For You put on screen may count. `{ author }` exists for the one head
 * whose action is not about a post at all — `followAuthor` — see
 * {@link ForYouSignalsStore.impressedAuthors}.
 */
type CounterGate = { post: string | undefined } | { author: string | undefined }

/**
 * Adjusts one action counter, floored at 0 so a retraction can never drive it
 * negative. Deletes the key at zero rather than storing it, matching how
 * `engaged[kind]` only appears on the store when it is non-empty.
 *
 * **`gate` is the population check, and it is mandatory** — the single most
 * load-bearing rule of the whole measurement, so it lives here rather than
 * being re-asserted at each of the six call sites. A counter only moves when
 * the thing acted on was actually put on screen *by For You*:
 *
 *  - `recordEngagement` is wired globally (`masto/status.ts:88`, and now the
 *    click family in `StatusCard`/`StatusAttachment`/`StatusPreviewCard`) and
 *    fires anywhere in the app. Counting all of it over a For You-only
 *    denominator would overstate every rate with a *correlated* bias — a post
 *    the viewer deliberately navigated to has a far higher action rate than
 *    one that merely scrolled past (`INTERCEPT.md` §3);
 *  - `applyMuteToSignals` is reachable from `relationship.ts`'s account-wide
 *    mute/block, which has no post at all. Those callers pass `{ post:
 *    undefined }` and so are naturally never counted — that is the mechanism,
 *    not an oversight (`INTERCEPT-BUILD.md`, "Attribution gaps to accept");
 *  - retractions are symmetric: an un-favourite of a post that was never
 *    impressed never bumped the counter, so it must not decrement it either,
 *    or the floor-at-0 clamp would eat a *different* action's headroom the
 *    moment counts happen to cross.
 *
 * The gate only touches the counter. Signals and affinity are recorded exactly
 * as they always were, whether or not the post was impressed here.
 */
function bumpActionCounter(
  signals: ForYouSignalsStore,
  action: ForYouCounterAction,
  delta: number,
  gate: CounterGate,
) {
  const observed = 'post' in gate
    ? !!gate.post && signals.impressed.includes(gate.post)
    : !!gate.author && signals.impressedAuthors.includes(gate.author)
  if (!observed)
    return
  const next = Math.max(0, (signals.counters.actions[action] ?? 0) + delta)
  if (next > 0)
    signals.counters.actions[action] = next
  else
    delete signals.counters.actions[action]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value))
    return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || seen.has(entry))
      continue
    seen.add(entry)
    out.push(entry)
  }
  return out.length > max ? out.slice(out.length - max) : out
}

function normalizeAffinityMap(value: unknown): Record<string, number> {
  if (!isRecord(value))
    return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) >= PRUNE_BELOW)
      out[key] = raw
  }
  return out
}

function normalizeSignal(value: unknown): EngagementSignal | undefined {
  if (!isRecord(value))
    return undefined
  const { statusId, authorId, boosterId, tags, language, at, mutual, weight } = value
  if (typeof statusId !== 'string' || !statusId)
    return undefined
  if (typeof at !== 'number' || !Number.isFinite(at))
    return undefined
  return {
    statusId,
    authorId: typeof authorId === 'string' ? authorId : undefined,
    boosterId: typeof boosterId === 'string' ? boosterId : undefined,
    tags: normalizeStringList(tags, MAX_TAGS_PER_SIGNAL),
    language: typeof language === 'string' ? language : undefined,
    at,
    mutual: mutual === true ? true : undefined,
    weight: typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 ? weight : undefined,
  }
}

function normalizeSignalList(value: unknown, max: number): EngagementSignal[] {
  if (!Array.isArray(value))
    return []
  const parsed: EngagementSignal[] = []
  for (const entry of value) {
    const signal = normalizeSignal(entry)
    if (signal)
      parsed.push(signal)
  }
  return sortDedupTruncate(parsed, max)
}

/**
 * `sort_dedup_truncate` from `engagement_signals.rs`: newest first, one entry
 * per post, capped.
 */
export function sortDedupTruncate(signals: EngagementSignal[], max: number): EngagementSignal[] {
  const sorted = [...signals].sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  const out: EngagementSignal[] = []
  for (const signal of sorted) {
    if (seen.has(signal.statusId))
      continue
    seen.add(signal.statusId)
    out.push(signal)
    if (out.length >= max)
      break
  }
  return out
}

/**
 * Repairs anything the persisted blob is missing or has wrong.
 *
 * `useUserLocalStorage` hands back an existing entry *as-is* — it only merges
 * defaults when there is no entry at all — so a blob written by an older
 * version (or corrupted by hand) reaches us with fields missing, and
 * `mutedForYou.includes(...)` would throw. This runs on every read and is the
 * migration path: version 1 stored bare counters, a lossy projection of the
 * sequence that cannot be inverted, so its derived maps are dropped and
 * rebuilt from whatever the viewer does next. The bookkeeping lists (`seen`,
 * `notInterested`, `mutedForYou`) survive because they are not derived.
 *
 * Returns a well-formed store, and whether anything had to be changed. That
 * flag is a **deep** comparison: a blob whose outer shape is perfect but whose
 * hundredth `EngagementSignal` is missing its `tags` array is still `changed`,
 * because that is precisely the blob that makes `for (const tag of ...)`
 * throw later. Callers should not rely on it to decide whether to write back —
 * {@link useForYouSignals} assigns the repaired object unconditionally.
 */
export function normalizeSignals(raw: unknown): { signals: ForYouSignalsStore, changed: boolean } {
  const base = createEmptySignals()
  if (!isRecord(raw))
    return { signals: base, changed: true }

  const version = typeof raw.version === 'number' ? raw.version : 1
  const stale = version !== SIGNALS_VERSION

  const engaged: ForYouSignalsStore['engaged'] = {}
  const rawEngaged = isRecord(raw.engaged) ? raw.engaged : {}
  for (const kind of ENGAGEMENT_KINDS) {
    const list = normalizeSignalList(rawEngaged[kind], maxSignalsFor(kind))
    if (list.length)
      engaged[kind] = list
  }

  const signals: ForYouSignalsStore = {
    version: SIGNALS_VERSION,
    engaged,
    dismissed: normalizeSignalList(raw.dismissed, MAX_DISMISSED),
    // Derived maps are only trusted within the current version.
    authorAffinity: stale ? {} : normalizeAffinityMap(raw.authorAffinity),
    boosterAffinity: stale ? {} : normalizeAffinityMap(raw.boosterAffinity),
    tagAffinity: stale ? {} : normalizeAffinityMap(raw.tagAffinity),
    languageAffinity: stale ? {} : normalizeAffinityMap(raw.languageAffinity),
    seen: normalizeStringList(raw.seen, MAX_SEEN),
    notInterested: normalizeStringList(raw.notInterested, MAX_NOT_INTERESTED),
    mutedForYou: normalizeStringList(raw.mutedForYou, MAX_MUTED),
    lastDecay: typeof raw.lastDecay === 'number' && Number.isFinite(raw.lastDecay) ? raw.lastDecay : 0,
    // Raw observations, not derived: kept regardless of `stale`, unlike the
    // affinity maps above — a `SIGNALS_VERSION` bump must not silently reset
    // the calibration data (`INTERCEPT.md` §3, "Version discipline").
    counters: normalizeCounters(raw.counters),
    impressed: normalizeStringList(raw.impressed, MAX_SEEN),
    impressedAuthors: normalizeStringList(raw.impressedAuthors, MAX_IMPRESSED_AUTHORS),
  }

  return { signals, changed: !deepEqual(raw, signals) }
}

/** Structural equality over the JSON-ish values a persisted store can hold. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b)
    return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false
    return a.every((entry, i) => deepEqual(entry, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    // `undefined`-valued keys are absent once persisted, so ignore them.
    const keys = (value: Record<string, unknown>) =>
      Object.keys(value).filter(key => value[key] !== undefined)
    const aKeys = keys(a)
    const bKeys = keys(b)
    if (aKeys.length !== bKeys.length)
      return false
    return aKeys.every(key => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * Boosts always credit the *original* author, the way home-mixer attributes a
 * retweet to `retweeted_user_id` rather than to the retweeter — but we keep the
 * booster too, because on Mastodon boosting *is* the discovery mechanism and
 * "who shows me things I like" is worth its own map.
 */
export function getEngagementTarget(status: mastodon.v1.Status): EngagementTarget {
  const post = status.reblog ?? status
  return {
    statusId: post.id,
    authorId: post.account?.id,
    boosterId: status.reblog ? status.account?.id : undefined,
    tags: (post.tags ?? [])
      .map(tag => tag.name?.toLowerCase())
      .filter((name): name is string => !!name)
      .slice(0, MAX_TAGS_PER_SIGNAL),
    language: post.language || undefined,
  }
}

function toSignal(target: EngagementTarget, at: number): EngagementSignal | undefined {
  if (!target.statusId)
    return undefined
  return {
    statusId: target.statusId,
    authorId: target.authorId,
    boosterId: target.boosterId,
    // Tags are the one field a caller can hand us raw; normalize at the single
    // point where a signal enters the sequence.
    tags: [...new Set(target.tags.filter(Boolean).map(tag => tag.toLowerCase()))].slice(0, MAX_TAGS_PER_SIGNAL),
    language: target.language,
    at,
    mutual: target.mutual ? true : undefined,
    weight: typeof target.weight === 'number' && target.weight >= 0 && target.weight !== 1
      ? target.weight
      : undefined,
  }
}

/**
 * Appends one engagement to its type's sequence and refreshes the derived
 * affinity cache. Mutates and returns `signals`.
 */
export function recordSignal(
  signals: ForYouSignalsStore,
  kind: ForYouEngagementKind,
  target: EngagementTarget,
  now: number = Date.now(),
): ForYouSignalsStore {
  const signal = toSignal(target, now)
  if (!signal || !(kind in ENGAGEMENT_STRENGTH))
    return signals

  const list = signals.engaged[kind] ?? []
  signals.engaged[kind] = sortDedupTruncate([signal, ...list], maxSignalsFor(kind))

  // The signal above is recorded unconditionally; only the counter is gated on
  // this post — or, for a follow, this author — having been put on screen by
  // For You (see `bumpActionCounter` and `counterGateFor`).
  bumpActionCounter(signals, kind, 1, counterGateFor(kind, signal.statusId, signal.authorId))

  return deriveAffinities(signals, now)
}

/**
 * Which population gates this kind's counter.
 *
 * `follow` is the sole exception and it is a structural one, not a preference:
 * its `statusId` is the synthetic `follow:<accountId>` key {@link recordFollow}
 * mints, which can never appear in `impressed`, so gating it on posts pins the
 * counter at zero forever no matter how many follows the viewer makes. The
 * author it names *can* be in `impressedAuthors`, which is the same question
 * asked of the only identifier a follow actually has.
 */
function counterGateFor(
  kind: ForYouEngagementKind,
  statusId: string | undefined,
  authorId: string | undefined,
): CounterGate {
  return kind === 'follow' ? { author: authorId } : { post: statusId }
}

/** Undoes an engagement (un-favourite, un-follow…). Mutates and returns `signals`. */
export function forgetSignal(
  signals: ForYouSignalsStore,
  kind: ForYouEngagementKind,
  statusId: string,
  now: number = Date.now(),
): ForYouSignalsStore {
  const list = signals.engaged[kind]
  if (!list?.length)
    return signals
  // Captured before the filter: an un-follow arrives as the synthetic
  // `follow:<accountId>` key, and the author it was recorded against is the
  // only thing that can answer the gate below.
  const removed = list.find(signal => signal.statusId === statusId)
  const next = list.filter(signal => signal.statusId !== statusId)
  if (next.length === list.length)
    return signals
  signals.engaged[kind] = next

  // Symmetric with the increment in `recordSignal`, through the same gate.
  bumpActionCounter(signals, kind, -1, counterGateFor(kind, statusId, removed?.authorId))

  return deriveAffinities(signals, now)
}

/** Records an explicit "not interested". Mutates and returns `signals`. */
export function applyNotInterestedToSignals(
  signals: ForYouSignalsStore,
  statusId: string,
  target: EngagementTarget,
  now: number = Date.now(),
): ForYouSignalsStore {
  pushCapped(signals.notInterested, statusId, MAX_NOT_INTERESTED)
  markSeenInSignals(signals, [statusId])

  const signal = toSignal({ ...target, statusId }, now)
  if (signal)
    signals.dismissed = sortDedupTruncate([signal, ...signals.dismissed], MAX_DISMISSED)

  // A dismissal also retracts whatever positive history that post carried.
  for (const kind of ENGAGEMENT_KINDS) {
    const list = signals.engaged[kind]
    if (list?.some(entry => entry.statusId === statusId))
      signals.engaged[kind] = list.filter(entry => entry.statusId !== statusId)
  }

  bumpActionCounter(signals, 'dismiss', 1, { post: statusId })

  return deriveAffinities(signals, now)
}

/**
 * Undoes {@link applyNotInterestedToSignals} for one post. Mutates and
 * returns `signals`.
 *
 * A real deletion, the same way {@link forgetSignal} undoes an engagement:
 * the id comes out of `notInterested` and its entry comes out of `dismissed`,
 * rather than appending some compensating positive record to cancel the
 * penalty out. Appending would leave the original dismissal sitting in the
 * sequence forever — decayed, but never gone, and still one more entry for
 * `EVIDENCE_CAP` to spend on this author when the viewer dismisses something
 * else of theirs. A genuine "the viewer takes it back" has to mean the
 * sequence looks as if it never happened, which is exactly what
 * {@link forgetSignal} already does for `favourite`/`follow`/etc.
 */
export function forgetNotInterestedToSignals(
  signals: ForYouSignalsStore,
  statusId: string,
  now: number = Date.now(),
): ForYouSignalsStore {
  if (!statusId)
    return signals

  const at = signals.notInterested.indexOf(statusId)
  if (at !== -1)
    signals.notInterested.splice(at, 1)

  const before = signals.dismissed.length
  signals.dismissed = signals.dismissed.filter(signal => signal.statusId !== statusId)
  const dismissalRemoved = signals.dismissed.length !== before

  if (at === -1 && !dismissalRemoved)
    return signals

  // Mirrors the increment in `applyNotInterestedToSignals`: only decrement
  // when a dismissal actually existed to undo. The population gate and the
  // floor at 0 are both `bumpActionCounter`'s.
  if (dismissalRemoved)
    bumpActionCounter(signals, 'dismiss', -1, { post: statusId })

  return deriveAffinities(signals, now)
}

/**
 * Mutes an author for this feed only. Mutates and returns `signals`.
 *
 * `muteAuthor` has no post of its own to gate a counter on — it takes an
 * `accountId` — and this same function is reachable from three surfaces:
 * `TimelineForYouItem.vue`'s "show less from author" (a genuine For You
 * action) and `relationship.ts`'s account-wide mute/block (reachable from
 * anywhere, nothing to do with this feed). `INTERCEPT-BUILD.md`'s
 * "Attribution gaps to accept, not solve" calls for counting only the For
 * You call site rather than engineering a real fix, so `statusId` is
 * optional and *only* the For You call site passes one. `bumpActionCounter`'s
 * gate then does the rest: no `statusId` means no count, so the two
 * account-wide call sites naturally never move the counter.
 */
export function applyMuteToSignals(
  signals: ForYouSignalsStore,
  accountId: string,
  now: number = Date.now(),
  statusId?: string,
): ForYouSignalsStore {
  if (!accountId)
    return signals
  if (!signals.mutedForYou.includes(accountId))
    pushCapped(signals.mutedForYou, accountId, MAX_MUTED)
  bumpActionCounter(signals, 'mute', 1, { post: statusId })
  return deriveAffinities(signals, now)
}

function pushCapped(list: string[], id: string, max: number) {
  const at = list.indexOf(id)
  if (at !== -1)
    list.splice(at, 1)
  list.push(id)
  if (list.length > max)
    list.splice(0, list.length - max)
}

/**
 * Age -> decay factor, for a given half-life.
 *
 * Clamped at both ends: a signal timestamped in the future (clock skew, a
 * server clock ahead of ours) counts as brand new rather than as a weight
 * larger than its own strength, and one absurdly far in the past decays to
 * zero instead of underflowing. The floor is relative to the half-life, so a
 * follow is not written off on the engagement horizon.
 */
export function decayFactor(ageMs: number, halfLifeMs: number = DECAY_HALF_LIFE_MS): number {
  if (!(ageMs > 0))
    return 1
  if (ageMs >= halfLifeMs * MAX_DECAY_HALF_LIVES)
    return 0
  return 2 ** (-ageMs / halfLifeMs)
}

function add(record: Record<string, number>, key: string | undefined, weight: number) {
  if (!key || !weight)
    return
  record[key] = (record[key] ?? 0) + weight
}

/**
 * Drops entries that carry no information: anything below {@link PRUNE_BELOW}
 * in magnitude, and any *positive* entry that has not cleared the evidence
 * floor for its map. Negatives are exempt — `notDwelled` is meant to be tiny.
 */
function prune(record: Record<string, number>, share: number) {
  const floor = MIN_EVIDENCE * share
  for (const key of Object.keys(record)) {
    const value = record[key]!
    const enough = value > 0 ? value >= floor : Math.abs(value) >= PRUNE_BELOW
    if (!enough)
      delete record[key]
  }
}

/**
 * Rebuilds the affinity maps from the engagement sequence.
 *
 * This is the whole derived layer: every map is a saturating sum of
 * `strength(kind) x magnitude x decay(age, halfLife(kind))` over the sequence,
 * so it is a pure function of (sequence, now). Calling it twice changes
 * nothing; never calling it loses nothing a later call cannot recover.
 */
export function deriveAffinities(
  signals: ForYouSignalsStore,
  now: number = Date.now(),
): ForYouSignalsStore {
  const authorAffinity: Record<string, number> = {}
  const boosterAffinity: Record<string, number> = {}
  const tagAffinity: Record<string, number> = {}
  const languageAffinity: Record<string, number> = {}
  const muted = new Set(signals.mutedForYou)

  // How many signals of each kind have already spoken for each key, so that
  // repetition of a weak signal saturates instead of accumulating (EVIDENCE_CAP).
  const counted = new Map<string, number>()
  const within = (map: string, bucket: string, key: string, cap: number) => {
    const id = `${map}|${bucket}|${key}`
    const n = (counted.get(id) ?? 0) + 1
    counted.set(id, n)
    return n <= cap
  }

  const contribute = (
    signal: EngagementSignal,
    bucket: string,
    strength: number,
    cap: number,
    halfLife: number,
  ) => {
    const magnitude = signal.weight ?? 1
    const weight = strength * magnitude * decayFactor(now - signal.at, halfLife)
    if (!weight)
      return
    const { authorId, boosterId, language } = signal
    if (authorId && !muted.has(authorId) && within('author', bucket, authorId, cap))
      add(authorAffinity, authorId, weight)
    if (boosterId && !muted.has(boosterId) && within('booster', bucket, boosterId, cap))
      add(boosterAffinity, boosterId, weight * BOOSTER_SHARE)
    for (const tag of signal.tags) {
      if (within('tag', bucket, tag, cap))
        add(tagAffinity, tag, weight * TAG_SHARE)
    }
    if (language && within('language', bucket, language, cap))
      add(languageAffinity, language, weight * LANGUAGE_SHARE)
  }

  // Note that nothing is *deleted* here. A signal too old to contribute still
  // stays in the sequence: deriving is not allowed to destroy history, or a
  // clock briefly a year fast would take the viewer model with it. The
  // sequence is bounded by truncation, not by expiry.
  for (const kind of ENGAGEMENT_KINDS) {
    const list = signals.engaged[kind]
    if (!list?.length)
      continue
    const base = ENGAGEMENT_STRENGTH[kind]
    const cap = EVIDENCE_CAP[kind]
    const halfLife = halfLifeFor(kind)
    for (const signal of list)
      contribute(signal, kind, signal.mutual ? base * MUTUAL_MULTIPLIER : base, cap, halfLife)
  }

  // Dismissals are their own bucket: they are not an engagement kind, and a
  // viewer who dismisses ten posts by one author has said it ten times.
  for (const signal of signals.dismissed)
    contribute(signal, 'dismissed', NOT_INTERESTED_STRENGTH, DISMISSAL_EVIDENCE_CAP, DECAY_HALF_LIFE_MS)

  prune(authorAffinity, 1)
  prune(boosterAffinity, BOOSTER_SHARE)
  prune(tagAffinity, TAG_SHARE)
  prune(languageAffinity, LANGUAGE_SHARE)

  signals.authorAffinity = authorAffinity
  signals.boosterAffinity = boosterAffinity
  signals.tagAffinity = tagAffinity
  signals.languageAffinity = languageAffinity
  signals.lastDecay = now
  return signals
}

/**
 * Re-derives the affinity cache if enough time has passed, so the feed adapts
 * while the viewer is away. Returns whether anything was recomputed.
 *
 * Clock skew is handled explicitly, because `lastDecay` is wall-clock:
 * - `now` before `lastDecay` (clock moved back, or a device that syncs late)
 *   would otherwise wedge the throttle shut forever, so we repair `lastDecay`
 *   and recompute immediately;
 * - a clock far ahead cannot wipe the maps, because decay is recomputed from
 *   each signal's own timestamp and clamped by {@link decayFactor}; the maps
 *   come back on their own once the clock is correct.
 */
export function decaySignalsInPlace(
  signals: ForYouSignalsStore,
  now: number = Date.now(),
): boolean {
  const last = signals.lastDecay

  if (!last) {
    deriveAffinities(signals, now)
    return false
  }

  if (now < last) {
    // Backwards skew: repair rather than freeze.
    deriveAffinities(signals, now)
    return true
  }

  if (now - last < DECAY_INTERVAL_MS)
    return false

  deriveAffinities(signals, now)
  return true
}

/**
 * Appends `id` to a capped, deduped ring buffer, evicting the oldest first and
 * keeping `set` in sync incrementally. Returns whether the id was *new* — the
 * caller's cue that a first-time observation just happened.
 *
 * **Not the same as {@link pushCapped}.** That one moves an id already in the
 * list to the end, because `notInterested`/`mutedForYou` are recency lists
 * where a repeat is the newest evidence. This one leaves an existing id where
 * it is and reports `false`, because `seen`/`impressed` are *observation*
 * buffers where a repeat is a duplicate to be ignored. Do not unify them: the
 * impression counters depend on this one's dedupe being exact.
 */
function appendCappedUnique(list: string[], id: string, set: Set<string>, max: number): boolean {
  if (!id || set.has(id))
    return false
  set.add(id)
  list.push(id)
  if (list.length > max) {
    const evicted = list.splice(0, list.length - max)
    for (const gone of evicted)
      set.delete(gone)
  }
  return true
}

/**
 * Appends ids to the seen ring buffer, evicting the oldest first.
 *
 * `index`, when given, is kept in sync incrementally: this runs on the scroll
 * hot path, so it must not scan the buffer per id nor rebuild a 3000-entry Set
 * per batch. Mutates and returns `signals`.
 */
export function markSeenInSignals(
  signals: ForYouSignalsStore,
  ids: Iterable<string>,
  index?: Set<string>,
): ForYouSignalsStore {
  const set = index ?? new Set(signals.seen)
  for (const id of ids)
    appendCappedUnique(signals.seen, id, set, MAX_SEEN)
  return signals
}

/**
 * Eligibility flags for an impression's conditionally-gated heads
 * (`openLink`/`photoExpand`+`videoOpen`/`followAuthor`), computed once at the
 * impression call site.
 *
 * `hasLink`/`hasMedia` are structural — derivable from the status alone, the
 * same way `ranking.ts`'s `extractRankingFeatures` reads them. `outOfNetwork`
 * is not: it needs relationship context a bare `mastodon.v1.Status` does not
 * carry (`PostCandidate.inNetwork` lives on the *candidate*, one layer up), so
 * it has to be supplied by whoever has that context — `TimelineForYouItem.vue`
 * takes it from the feed rather than reconstructing it.
 */
export interface ForYouImpressionFlags {
  hasLink: boolean
  hasMedia: boolean
  outOfNetwork: boolean
  /**
   * The *content* author (the boosted post's, never the booster's), recorded
   * into {@link ForYouSignalsStore.impressedAuthors} when this impression is
   * out of network. Optional so a caller with only a bare status can still
   * record an impression; a missing author simply leaves `followAuthor`
   * unattributable for this one post.
   */
  authorId?: string
}

/**
 * What {@link recordForYouImpressionInSignals} accepts: a full status — from
 * which it derives `hasLink`/`hasMedia` itself, and treats as in-network
 * (undercounting `eligible.outOfNetwork` is the safer failure than guessing
 * from nothing) — or a caller-computed id-plus-flags object, for a caller
 * that has more context than a bare status carries.
 */
type ForYouImpressionInput = mastodon.v1.Status | ({ id: string } & ForYouImpressionFlags)

function isImpressionFlags(input: ForYouImpressionInput): input is { id: string } & ForYouImpressionFlags {
  return 'hasLink' in input && 'hasMedia' in input && 'outOfNetwork' in input
}

function resolveImpressionFlags(input: ForYouImpressionInput): { id: string } & ForYouImpressionFlags {
  if (isImpressionFlags(input))
    return input
  const content = input.reblog ?? input
  return {
    id: input.reblog?.id ?? input.id,
    hasLink: !!content.card,
    hasMedia: (content.mediaAttachments?.length ?? 0) > 0,
    outOfNetwork: false,
    authorId: content.account?.id,
  }
}

/**
 * Records a genuine For You impression: appends to `impressed` (deduped,
 * evicted oldest-first at {@link MAX_SEEN}, mirroring
 * {@link markSeenInSignals} above) and increments `counters.impressions` plus
 * whichever `eligible` counters this impression qualifies for.
 *
 * Only increments anything when the id was *not* already in `impressed` — a
 * re-impression of the same post (rapid scroll re-triggering the observer,
 * or the same post resurfacing on a later page) must not double-count,
 * exactly as {@link markSeenInSignals} dedupes. `index`, like there, lets the
 * hot path (one call per post that scrolls into view) avoid rebuilding a
 * few-thousand-entry `Set` on every call.
 */
export function recordForYouImpressionInSignals(
  signals: ForYouSignalsStore,
  input: ForYouImpressionInput,
  index?: Set<string>,
): ForYouSignalsStore {
  const flags = resolveImpressionFlags(input)
  if (!flags.id)
    return signals

  const set = index ?? new Set(signals.impressed)
  if (!appendCappedUnique(signals.impressed, flags.id, set, MAX_SEEN))
    return signals

  signals.counters.impressions++
  if (flags.hasLink)
    signals.counters.eligible.hasLink++
  if (flags.hasMedia)
    signals.counters.eligible.hasMedia++
  if (flags.outOfNetwork) {
    signals.counters.eligible.outOfNetwork++
    // `pushCapped`, not `appendCappedUnique`: this is a recency list, so a
    // stranger seen again moves back to the front rather than being ignored.
    // It is deliberately outside the impression dedupe's effect on *counters*
    // — a second impression of the same post does not reach here at all, but a
    // different post by the same author does, and refreshing the author is the
    // point.
    if (flags.authorId)
      pushCapped(signals.impressedAuthors, flags.authorId, MAX_IMPRESSED_AUTHORS)
  }

  return signals
}

/** Highest-affinity keys, strongest first, ignoring anything non-positive. */
export function topAffinityKeys(
  record: Record<string, number> | undefined,
  n: number,
  exclude?: Iterable<string>,
): string[] {
  if (!record || !(n > 0))
    return []
  const skip = exclude instanceof Set ? exclude : new Set(exclude ?? [])
  return Object.entries(record)
    .filter(([key, value]) => value > 0 && !skip.has(key))
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([key]) => key)
}

/**
 * How strongly the viewer has pushed back on an author, as 0..1.
 *
 * The affinity maps cannot carry this: `ranking.ts`'s `affinity01` returns 0
 * for any non-positive value, so a negative author affinity is invisible to
 * the scorer. This is the accessor the scorer should read instead.
 */
export function authorPenaltyIn(
  signals: ForYouSignals | ForYouSignalsStore,
  authorId: string | undefined | null,
  now: number = Date.now(),
): number {
  if (!authorId)
    return 0
  if (signals.mutedForYou?.includes(authorId))
    return 1

  let dismissals = 0
  for (const signal of (signals as ForYouSignalsStore).dismissed ?? []) {
    if (signal.authorId === authorId)
      dismissals += decayFactor(now - signal.at)
  }
  if (!dismissals)
    return 0

  // Saturating: the first dismissal carries most of the weight, three make it
  // near-total. Matches the shape of a probability, which is what consumes it.
  return Math.min(1, 1 - 2 ** -dismissals)
}

/** Every author the viewer has pushed back on, dismissals and mutes alike. */
export function dismissedAuthorIdsIn(signals: ForYouSignals | ForYouSignalsStore): Set<string> {
  const out = new Set(signals.mutedForYou ?? [])
  for (const signal of (signals as ForYouSignalsStore).dismissed ?? []) {
    if (signal.authorId)
      out.add(signal.authorId)
  }
  return out
}

// ---------------------------------------------------------------------------
// Reactive, per-account surface.
// ---------------------------------------------------------------------------

function signalsOwnerKey() {
  return currentUser.value?.account.acct ?? '[anonymous]'
}

/**
 * A memoized `Set` view over one of the store's plain id arrays.
 *
 * `seen` and `impressed` are plain arrays in storage, but both are asked "is
 * this id in here?" once per candidate (the ranker's `isSeen`) or once per post
 * that scrolls into view (the impression observer) — so neither can go
 * quadratic, and neither can afford to rebuild a few-thousand-entry `Set` per
 * call.
 *
 * The cache is keyed on the account *and* on the identity of the array it
 * indexes, so an account switch or a cross-tab write (which replaces the whole
 * object through the `storage` event, keeping the length identical at
 * saturation) invalidates it. Both conditions are subtle enough that having
 * them written out twice, once per array, was a standing invitation to fix one
 * and not the other.
 */
function createIdIndex(sourceOf: (signals: ForYouSignalsStore) => string[]) {
  let index: { key: string, source: string[], set: Set<string> } | undefined
  return {
    get(signals: ForYouSignalsStore): Set<string> {
      const key = signalsOwnerKey()
      const source = sourceOf(signals)
      if (!index || index.key !== key || index.source !== source)
        index = { key, source, set: new Set(source) }
      return index.set
    },
    invalidate() {
      index = undefined
    },
  }
}

const seenIndex = createIdIndex(signals => signals.seen)
const impressedIndex = createIdIndex(signals => signals.impressed)

/**
 * Stores whose shape has already been checked, keyed by object identity.
 *
 * `useForYouSignals()` is called once per candidate through `isSeen()`, and
 * validating a saturated store costs ~0.25ms — a 500-candidate page would burn
 * over a tenth of a second re-validating an object it validated microseconds
 * earlier. Validation is idempotent and the store only changes identity when
 * the account switches or another tab replaces it, so identity is exactly the
 * right cache key (the same trick `createIdIndex` uses above). A `WeakSet` means a
 * signed-out account's store is collectable.
 */
const validatedStores = new WeakSet<object>()

/**
 * The current user's signals, persisted per account.
 *
 * Both the shape guard and the decay pass run lazily here rather than on a
 * timer, so the first read of a session repairs whatever the last one left and
 * pays for however long the viewer was away. Neither runs twice for the same
 * store: the guard is identity-cached, and decay is throttled to a comparison.
 */
export function useForYouSignals(): Ref<ForYouSignalsStore> {
  // `useUserLocalStorage` keys by the current account and already falls back to
  // a plain ref on the server, so nothing here touches `localStorage` in SSR.
  const signals = useUserLocalStorage<ForYouSignalsStore>(STORAGE_KEY_FOR_YOU_SIGNALS, createEmptySignals)

  if (!import.meta.client)
    return signals

  const store = signals.value
  const identity = toRaw(store)
  if (validatedStores.has(identity)) {
    decaySignalsInPlace(store)
    return signals
  }

  validatedStores.add(identity)
  // Assign unconditionally rather than trusting a comparison to tell us
  // whether it was needed: the ref from `useUserLocalStorage` is a computed
  // with no setter, so this has to be an in-place merge either way.
  Object.assign(store, normalizeSignals(store).signals)
  seenIndex.invalidate()
  impressedIndex.invalidate()
  deriveAffinities(store)

  return signals
}

/** Re-derives the current user's affinities if enough time has passed. */
export function decaySignals(now: number = Date.now()): boolean {
  if (!import.meta.client)
    return false
  return decaySignalsInPlace(useForYouSignals().value, now)
}

/**
 * Is this author a mutual? Read from the relationship cache only — never
 * fetched, because an engagement must not cost a round trip.
 */
function isMutual(accountId: string | undefined): boolean | undefined {
  if (!accountId)
    return undefined
  try {
    return getCachedRelationship(accountId)?.followedBy || undefined
  }
  catch {
    return undefined
  }
}

/**
 * Fills in what only the live session knows: whether the author is a mutual,
 * and whether the author is the viewer themselves — `SelfTweetFilter` drops
 * the viewer's own posts from the feed, so author affinity for yourself is
 * dead weight that would crowd out real authors in `topAuthors()`. What the
 * viewer wrote about still counts, so tags and language are kept.
 */
function withViewerContext(target: EngagementTarget): EngagementTarget {
  if (target.authorId && target.authorId === currentUser.value?.account.id)
    return { ...target, authorId: undefined, mutual: undefined }
  return { ...target, mutual: isMutual(target.authorId) }
}

/** Records one engagement of the viewer with a status. */
export function recordEngagement(status: mastodon.v1.Status | undefined, kind: ForYouEngagementKind) {
  if (!import.meta.client || !status)
    return
  recordSignal(useForYouSignals().value, kind, withViewerContext(getEngagementTarget(status)))
}

/** Undoes an engagement the viewer took back (un-favourite, un-bookmark…). */
export function forgetEngagement(status: mastodon.v1.Status | undefined, kind: ForYouEngagementKind) {
  if (!import.meta.client || !status)
    return
  const { statusId } = getEngagementTarget(status)
  if (statusId)
    forgetSignal(useForYouSignals().value, kind, statusId)
}

/** `FollowAuthorWeight` — the strongest durable statement a viewer can make. */
export function recordFollow(account: mastodon.v1.Account | undefined) {
  if (!import.meta.client || !account?.id)
    return
  recordSignal(useForYouSignals().value, 'follow', {
    statusId: `follow:${account.id}`,
    authorId: account.id,
    tags: [],
    mutual: isMutual(account.id),
  })
}

export function forgetFollow(accountId: string | undefined) {
  if (!import.meta.client || !accountId)
    return
  forgetSignal(useForYouSignals().value, 'follow', `follow:${accountId}`)
}

// ---------------------------------------------------------------------------
// Attention: dwell / notDwelled
// ---------------------------------------------------------------------------

/**
 * Converts time-in-view into a signal.
 *
 * Dwell is the only signal every impression produces, which makes it both the
 * highest-volume evidence available and the only negative evidence obtainable
 * without an explicit tap: `seen` alone cannot tell "shown and read" from
 * "shown and scrolled past". X splits the same measurement in two —
 * `ContDwellTimeWeight` scales continuously with seconds, `NotDwelledWeight`
 * fires when the post was in front of the viewer and got nothing.
 *
 * Returns the kind and magnitude that {@link recordDwell} will store, or
 * `undefined` when the reading is too short to mean anything at all (a post
 * that flickered past during a fling is not evidence of disinterest).
 */
export function dwellSignalFor(visibleMs: number): { kind: ForYouEngagementKind, weight: number } | undefined {
  if (!(visibleMs > 0))
    return undefined
  if (visibleMs < DWELL_MIN_MS) {
    // Below the floor, but genuinely in view: "shown and ignored".
    return visibleMs >= 250 ? { kind: 'notDwelled', weight: 1 } : undefined
  }
  const capped = Math.min(visibleMs, DWELL_SATURATION_MS)
  return { kind: 'dwell', weight: capped / DWELL_REFERENCE_MS }
}

/**
 * Records how long a post was actually in front of the viewer.
 *
 * `visibleMs` is cumulative time the post was on screen, as measured by the
 * feed item's own visibility observer. Anything under {@link DWELL_MIN_MS}
 * records the negative half of the pair.
 */
export function recordDwell(status: mastodon.v1.Status | undefined, visibleMs: number) {
  if (!import.meta.client || !status)
    return
  const signal = dwellSignalFor(visibleMs)
  if (!signal)
    return
  const target = withViewerContext(getEngagementTarget(status))
  recordSignal(useForYouSignals().value, signal.kind, { ...target, weight: signal.weight })
}

/**
 * Is the document itself in front of the viewer right now?
 *
 * `undefined` `document` (SSR, or a plain-vitest run with no DOM) is treated
 * as visible — there is nothing to hide behind, so the tracker should behave
 * exactly as it did before this guard existed.
 */
function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Accumulating dwell timer for one post, for a component that can see it enter
 * and leave the viewport several times before it is unmounted.
 *
 * Time only accrues while the post is *both* intersecting *and* the document
 * is visible. An `IntersectionObserver` does not fire again when the browser
 * tab it lives in goes to the background — the post is still "intersecting"
 * by every measure the observer has — so without the second condition a post
 * left open in a backgrounded tab, or behind a locked screen, would bank the
 * entire time away as attentive reading. `document.visibilitychange` is what
 * turns "the user is in another tab" into what it actually is for this post:
 * not dwelled. Each accumulation step is additionally capped at
 * {@link DWELL_SATURATION_MS}, so the internal counter this class holds can
 * never itself become the "absurd duration" the eventual `dwellSignalFor`
 * saturation is guarding against — defense in depth against a stuck timer
 * (a laptop closed with the tab foregrounded, a suspended background render)
 * rather than a second place the cap is enforced for its own sake.
 *
 * ```ts
 * const dwell = createDwellTracker(() => status.value)
 * // IntersectionObserver: entry.isIntersecting ? dwell.enter() : dwell.exit()
 * onUnmounted(dwell.flush)
 * ```
 */
export function createDwellTracker(status: mastodon.v1.Status | (() => mastodon.v1.Status | undefined)) {
  let since: number | undefined
  let visibleMs = 0
  let flushed = false
  let intersecting = false

  const resolve = () => (typeof status === 'function' ? status() : status)

  const accumulate = (at: number) => {
    if (since === undefined)
      return
    visibleMs = Math.min(visibleMs + Math.max(0, at - since), DWELL_SATURATION_MS)
    since = undefined
  }

  const resume = (at: number) => {
    if (since === undefined && intersecting && isDocumentVisible())
      since = at
  }

  const enter = (at: number = Date.now()) => {
    intersecting = true
    resume(at)
  }

  const exit = (at: number = Date.now()) => {
    intersecting = false
    accumulate(at)
    return visibleMs
  }

  const onVisibilityChange = () => {
    const at = Date.now()
    if (isDocumentVisible())
      resume(at)
    else
      accumulate(at)
  }

  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', onVisibilityChange)

  /** Writes the accumulated time as a signal. Safe to call more than once. */
  const flush = (at: number = Date.now()) => {
    exit(at)
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibilityChange)
    if (flushed || !visibleMs)
      return
    flushed = true
    recordDwell(resolve(), visibleMs)
  }

  return {
    enter,
    exit,
    flush,
    get visibleMs() {
      return visibleMs
    },
  }
}

/**
 * The viewer published something. A reply is `ReplyWeight`, a quote is
 * `QuoteWeight`, both aimed at the post they answer.
 *
 * The tags come from what the viewer *wrote*, not from the post they answered:
 * choosing to type `#mastoart` is a stronger statement of interest than having
 * scrolled past it.
 */
export function recordComposedStatus(created: mastodon.v1.Status | undefined) {
  if (!import.meta.client || !created)
    return

  const tags = (created.tags ?? [])
    .map(tag => tag.name?.toLowerCase())
    .filter((name): name is string => !!name)
    .slice(0, MAX_TAGS_PER_SIGNAL)
  const language = created.language || undefined
  const signals = useForYouSignals().value

  if (created.inReplyToId) {
    recordSignal(signals, 'reply', withViewerContext({
      statusId: created.inReplyToId,
      authorId: created.inReplyToAccountId ?? undefined,
      tags,
      language,
    }))
  }

  const quote = created.quote
  if (quote) {
    const quoted = 'quotedStatus' in quote ? quote.quotedStatus : undefined
    const statusId = quoted?.id ?? ('quotedStatusId' in quote ? quote.quotedStatusId : undefined)
    if (statusId) {
      recordSignal(signals, 'quote', withViewerContext({
        statusId,
        authorId: quoted?.account?.id,
        tags,
        language,
      }))
    }
  }
}

/** Remembers posts already shown, mirroring `PreviouslySeenPostsFilter`. */
export function markSeen(ids: string[]) {
  if (!import.meta.client || !ids.length)
    return
  const signals = useForYouSignals().value
  markSeenInSignals(signals, ids, seenIndex.get(signals))
}

export function isSeen(id: string): boolean {
  if (!import.meta.client)
    return false
  return seenIndex.get(useForYouSignals().value).has(id)
}

/**
 * Records a genuine For You impression — `TimelineForYouItem.vue`'s latched
 * `isMeaningfullyVisible` observer, and *only* that: `masto/routes.ts:98`'s
 * `markSeen` call (a status-detail navigation, from anywhere) must never
 * reach this, or the numerator/denominator population match the whole
 * measurement depends on breaks (`INTERCEPT.md` §3, "the population trap").
 *
 * `flags` is supplied by the caller because `outOfNetwork` needs relationship
 * context a bare status does not carry — see {@link ForYouImpressionFlags}.
 */
export function recordForYouImpression(status: mastodon.v1.Status | undefined, flags: ForYouImpressionFlags) {
  if (!import.meta.client || !status)
    return
  const signals = useForYouSignals().value
  recordForYouImpressionInSignals(
    signals,
    { id: status.reblog?.id ?? status.id, ...flags },
    impressedIndex.get(signals),
  )
}

/** Explicit dismissal of a single post. */
export function markNotInterested(status: mastodon.v1.Status | undefined) {
  if (!import.meta.client || !status)
    return
  const signals = useForYouSignals().value
  const target = getEngagementTarget(status)
  applyNotInterestedToSignals(signals, target.statusId ?? status.id, target)
  seenIndex.invalidate()
}

/**
 * Undoes {@link markNotInterested} for one post. Mirrors
 * {@link unmuteAuthorForYou}: `seen` is left untouched — the post genuinely
 * was shown, undoing the dismissal does not change that — but the dismissal
 * itself, and the negative history it added, is removed outright rather than
 * offset. See {@link forgetNotInterestedToSignals} for why that has to be a
 * real deletion.
 */
export function forgetNotInterested(statusId: string) {
  if (!import.meta.client || !statusId)
    return
  forgetNotInterestedToSignals(useForYouSignals().value, statusId)
}

/**
 * Hides an author from this feed only, without muting them account-wide.
 *
 * `statusId`, when given, gates the `mute` counter's population match — see
 * {@link applyMuteToSignals}'s docblock for why this function has two other
 * call sites (`relationship.ts`'s account-wide mute/block) that must never
 * pass one.
 */
export function muteAuthorForYou(accountId: string, statusId?: string) {
  if (!import.meta.client || !accountId)
    return
  applyMuteToSignals(useForYouSignals().value, accountId, undefined, statusId)
}

/**
 * Undoes {@link muteAuthorForYou}. Used when an account-level mute or block is
 * lifted: the server-side list is the reason the local one exists, so they must
 * not drift apart.
 */
export function unmuteAuthorForYou(accountId: string) {
  if (!import.meta.client || !accountId)
    return
  const signals = useForYouSignals().value
  const at = signals.mutedForYou.indexOf(accountId)
  if (at === -1)
    return
  signals.mutedForYou.splice(at, 1)
  deriveAffinities(signals)
}

/** Seeds for candidate sourcing: the authors the viewer engages with most. */
export function topAuthors(n: number): string[] {
  const signals = useForYouSignals().value
  return topAffinityKeys(signals.authorAffinity, n, signals.mutedForYou)
}

/** Seeds for candidate sourcing: the tags the viewer engages with most. */
export function topTags(n: number): string[] {
  return topAffinityKeys(useForYouSignals().value.tagAffinity, n)
}

/**
 * Seeds for candidate sourcing: whose boosts the viewer keeps engaging with.
 * On Mastodon the boost is the discovery mechanism, so this is the closest
 * thing we have to "accounts whose taste predicts mine".
 */
export function topBoosters(n: number): string[] {
  const signals = useForYouSignals().value
  return topAffinityKeys(signals.boosterAffinity, n, signals.mutedForYou)
}

/**
 * 0..1 negative affinity for an author, for the scorer to fold into
 * `notInterested`/`muteAuthor`. See {@link authorPenaltyIn}.
 */
export function authorPenalty(accountId: string | undefined | null): number {
  if (!import.meta.client)
    return 0
  return authorPenaltyIn(useForYouSignals().value, accountId)
}

/** Every author the viewer pushed back on — dismissals and For-You mutes. */
export function dismissedAuthorIds(): Set<string> {
  if (!import.meta.client)
    return new Set()
  return dismissedAuthorIdsIn(useForYouSignals().value)
}

// `forYouAffinityResolver`, a partial `AffinityResolver` wiring
// `authorPenaltyIn`/`notInterested` for the ranker, used to live here. It was
// never wired into `feed.ts`'s `buildRankingContext`: `affinityResolver` in
// `feed.ts` covers the same ground (`authorPenaltyIn` for the author half,
// `notInterested` for the post half) *and* wires `booster`, which this did
// not, plus error-safe degradation, which this also lacked — and it is the
// one that matches `ranking.ts`'s current split `authorPenalty(accountId)` /
// `postPenalty(statusId)` contract, which this predated and never followed.
// Two resolvers computing the same thing is worse than one, so this one was
// deleted rather than updated; `feed.ts`'s `affinityResolver` is the source
// of truth for wiring `authorPenaltyIn` into the ranker.
