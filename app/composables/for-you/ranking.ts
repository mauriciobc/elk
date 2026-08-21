import type { mastodon } from 'masto'
import type { ActionProbabilities, ForYouSignals, PostCandidate, ScoreReason } from './types'

/**
 * The heavy ranker.
 *
 * This is the Elk analogue of `home-mixer/scorers/ranking_scorer.rs` in
 * xai-org/x-algorithm. The shape of the computation is copied faithfully:
 *
 *   1. a model predicts P(action) for every action the viewer could take,
 *   2. those predictions are combined by a fixed weighted sum —
 *      `Final Score = Σ (weight_i × P(action_i))` — splitting the terms into a
 *      positive and a negative sum,
 *   3. three post-scoring adjustments run over the whole slate: new-author
 *      boost, author diversity, out-of-network discount.
 *
 * Step 1 is where we necessarily diverge. X has Phoenix, a learned model
 * trained on the viewer's engagement sequence against a global engagement
 * graph. Mastodon exposes no such graph: the only per-post numbers we get are
 * `favouritesCount`, `reblogsCount` and `repliesCount` as the viewer's own
 * instance happens to have federated them, plus static metadata. So
 * `predictActions` below is a hand-written heuristic model over those
 * observables.
 *
 * ## The one rule that governs the estimator layer
 *
 * **Every signal the transcribed machinery already handles is handled there
 * and nowhere else.** The scorer applies the follow graph exactly once, as the
 * 0.75 out-of-network multiplier in `applyAdjustments`; it therefore must not
 * reappear as a per-head lift. Same for freshness and language: they are
 * single, visible multipliers, not factors smeared across nine heads. An
 * earlier revision of this file broke that rule and the result was a
 * reverse-chronological home timeline wearing a ranker's clothes — the
 * out-of-network ceiling sat below the in-network floor, so no amount of
 * engagement could ever surface a post from outside the follow graph. The
 * per-head estimators are for signals X gets from *data* (engagement shape,
 * media, affinity), not for signals the pipeline already encodes.
 *
 * Everything here is a pure function taking `signals` and `ctx` as arguments —
 * no Nuxt, no composables, no module-level mutable state — so it can be unit
 * tested directly.
 */

// #region weights

/**
 * X's production weights, transcribed from `home-mixer/params/param.rs`
 * (the defaults in the `param!` macro calls; per the repo README a cron job
 * keeps those defaults in sync with the primary production values).
 *
 *   FavoriteWeight      0.5      NotInterestedWeight  -43.2
 *   ReplyWeight         5.0      BlockAuthorWeight    -31.2
 *   RetweetWeight       1.0      MuteAuthorWeight     -58.8
 *   QuoteWeight         5.0      ReportWeight        -234.0
 *   ShareWeight         2.0      NotDwelledWeight      -0.02
 *   ClickWeight         0.4
 *   OpenLinkWeight      0.2
 *   ProfileClickWeight  0.0
 *   PhotoExpandWeight   0.05
 *   VideoOpenWeight     0.05
 *   VqvWeight           0.05
 *   DwellWeight         0.0
 *   FollowAuthorWeight  4.0
 *
 * Two of these are genuinely 0.0 in production (`ProfileClickWeight`,
 * `DwellWeight`) — the heads are still predicted, they just contribute
 * nothing to the sum right now. They are kept at their real values rather
 * than invented; the estimators for them are still written honestly so that
 * flipping the weight is all it takes to use them.
 *
 * Heads X has that `ActionProbabilities` does not model, and why they are not
 * here: `share_via_dm` (5.0) and `share_via_copy_link` (20.0) are folded into
 * the single `share` head; `quoted_click` (0.05) and `quoted_vqv` (0.0) need
 * quote posts, which most of the fediverse does not have; `post_unexplored`
 * (0.02) has no analogue; the continuous heads `cont_dwell_time` (0.004),
 * `cont_click_dwell_time` (0.0) and `cont_active_secs_5m_residual_norm` (0.0)
 * are watch-time regressions, not probabilities, and the client has no dwell
 * instrumentation to feed them.
 */
export const X_WEIGHTS: Record<keyof ActionProbabilities, number> = {
  favorite: 0.5,
  reply: 5.0,
  retweet: 1.0,
  quote: 5.0,
  share: 2.0,
  click: 0.4,
  openLink: 0.2,
  profileClick: 0.0,
  photoExpand: 0.05,
  videoOpen: 0.05,
  vqv: 0.05,
  dwell: 0.0,
  followAuthor: 4.0,
  notInterested: -43.2,
  muteAuthor: -58.8,
  blockAuthor: -31.2,
  report: -234.0,
  notDwelled: -0.02,
}

/**
 * What the ranker actually resolves. {@link X_WEIGHTS} stays above, unchanged,
 * as the documented reference this was derived from.
 *
 * **These are judgment, not measurement.** Everything else recalibrated in this
 * file — the saturation points, the boost base rate, the federation coverage,
 * the bot and link-card lifts — is a number measured off the live fediverse
 * and reproducible with `scripts/for-you-calibrate.ts`. Nothing measures what a
 * favourite is *worth* relative to a boost; that is a product decision, and X's
 * table is a considered answer to it from a platform with real training data.
 * So the deltas here are deliberately few, and heads with no argument against
 * them keep X's value even where it looks surprising.
 *
 * Two changes:
 *
 * - `quote` 5.0 → 1.0. Closer to a bug fix than a judgment call. The head is
 *   derived as `retweet * 0.12`, so at weight 5.0 it contributes `0.12 x 5.0 =
 *   0.60` per unit of P(boost) against the real boost head's 1.0 — a 60%
 *   surcharge on every boost prediction, for an action most fediverse software
 *   cannot perform at all.
 * - `share` 2.0 → 0.5. X's 2.0 is the small half of its sharing story:
 *   `share_via_dm` (5.0) and `share_via_copy_link` (20.0) carry the rest, and
 *   `ActionProbabilities` folds all three into this one head. Mastodon has no
 *   quote-DM and no first-class share surface, so the folded head is worth
 *   much less than the sum it stands in for.
 *
 * Left alone on purpose:
 *
 * - `retweet` stays 1.0. Boosting being Mastodon's only distribution mechanism
 *   is a real argument for valuing it more, but {@link BASE_RATES} already
 *   raises boost's contribution 3x on measured grounds. Moving the weight too
 *   would compound to ~4.5x, and the second factor would be resting on nothing.
 * - `BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST` stays 15.0, though it is the
 *   most suspect number in the system here: it makes the effective mutual
 *   reply weight 20.0, the largest weight anywhere in the ranker, on a platform
 *   whose follow graph already has its own tab. The hypothesis is that it
 *   collapses For You into Following-with-extra-steps — but it *is* a
 *   hypothesis, and `scripts/for-you-replay.ts` can test it against a real
 *   candidate pool. Changing it blind is how this file got its X-scale
 *   constants in the first place.
 */
export const MASTODON_WEIGHTS: Record<keyof ActionProbabilities, number> = {
  ...X_WEIGHTS,
  quote: 1.0,
  share: 0.5,
}

/**
 * X's own sums, over its *full* head table (`ScoringWeights::from_params`,
 * ranking_scorer.rs:105-128 — which includes `share_via_dm` 5.0,
 * `share_via_copy_link` 20.0, `quoted_click` 0.05, `quoted_vqv` 0.0 and
 * `post_unexplored` 0.02):
 *
 *   positive_sum 43.32 · negative_sum 367.22 · total_sum 410.54
 *
 * {@link weightSums} computes the same three numbers over *our* reduced head
 * table, which necessarily gives different values (18.25 / 367.22 / 385.47).
 * They are recorded here so nobody mistakes ours for X's.
 */
export const X_WEIGHT_SUMS = { positiveSum: 43.32, negativeSum: 367.22, totalSum: 410.54 } as const

/**
 * `BidirectionalFollowReplyWeightBoost` (param.rs, default **15.0**): X adds
 * this to the reply weight for original posts by mutual follows — by far the
 * largest single weight in the system. `docs/BIDIRECTIONAL_BOOST_CHANGE.md`
 * in the X repo tracks it. Applied here only when the caller can tell us who
 * the viewer's mutuals are (`ctx.mutualAuthorIds`).
 */
export const BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST = 15.0

/** `BidirectionalFollowDwellWeightBoost` (param.rs) — 0.0 in production. */
export const BIDIRECTIONAL_FOLLOW_DWELL_WEIGHT_BOOST = 0.0

/** `NEGATIVE_SCORES_OFFSET` from `home-mixer/params/config.rs`. */
export const NEGATIVE_SCORES_OFFSET = 0.001

/** `MAX_POST_AGE` from `home-mixer/params/config.rs` — the `AgeFilter` cap. */
export const MAX_POST_AGE_MS = 48 * 60 * 60 * 1000

/** `MinVideoDurationMs` (param.rs) — below this, `vqv_weight()` returns 0.0. */
export const MIN_VIDEO_DURATION_MS = 10_000

/**
 * `MAX_FOLLOWERS_THRESHOLD` (candidates_util.rs:4) — `vqv_weight()` also
 * returns 0.0 when the *viewer* has this many followers or more.
 */
export const MAX_FOLLOWERS_THRESHOLD = 10_000

/**
 * Post-scoring parameters, transcribed from `param.rs` / `config.rs`.
 * All of them are overridable through `ctx.params` so tests (and a future
 * settings panel) can move them without touching this file.
 */
export interface RankingParams {
  /** `EnableAuthorDiversity` — true. */
  enableAuthorDiversity: boolean
  /** `AuthorDiversityDecay` — 0.5. */
  authorDiversityDecay: number
  /** `AuthorDiversityFloor` — 0.25. */
  authorDiversityFloor: number
  /** `OonWeightFactor` — 0.75. The *only* place the follow graph enters. */
  oonWeightFactor: number
  /** `EnableOonRescoreForInNetworkRepliesRetweets` — true. */
  oonRescoreInNetworkRepliesReblogs: boolean
  /** `NEW_USER_OON_WEIGHT_FACTOR` from config.rs — 0.00001. */
  newUserOonWeightFactor: number
  /** `NEW_USER_MIN_FOLLOWING` from config.rs — 5. */
  newUserMinFollowing: number
  /** `NewUserAgeThresholdSecs` — 0, i.e. the new-user OON rule is off by default. */
  newUserAgeThresholdMs: number
  /** `EnableViewerColdStart` — true. */
  enableNewAuthorBoost: boolean
  /** Compared against {@link impressionProxy}; recalibrated, see that function. */
  coldStartImpressionThreshold: number
  /** `ColdStartFollowerCap` — 1000. */
  coldStartFollowerCap: number
  /** `ColdStartSlotMin` — 15. */
  coldStartSlotMin: number
  /** `ColdStartSlotMax` — 16. */
  coldStartSlotMax: number
  /** `ColdStartMaxPostAgeSecs` — 86400 (24h). */
  coldStartMaxPostAgeMs: number
  /** `LowImpressionsMaxPositionRatio` — 0.85. */
  coldStartMaxPositionRatio: number
  /** Recency: half-life of the freshness multiplier. Elk-specific, see below. */
  recencyHalfLifeMs: number
  /** Recency: the floor the freshness multiplier decays towards. Elk-specific. */
  recencyFloor: number
  /** Multiplier for a post in a language the viewer neither reads nor engages with. */
  languageMismatchPrior: number

  // Calibration constants. Elk-specific: X has no analogue because Phoenix
  // learns the shape of its own feature distributions from training data. Ours
  // are measured against the live fediverse — see `CALIBRATION.md` for the
  // samples, the percentiles, and the reasoning from each number to each
  // default. They live in params rather than at module scope so the replay
  // harness (`scripts/for-you-replay.ts`) can sweep them.

  /** {@link logNorm} saturation for the engagement composite. */
  engagementSaturation: number
  /** {@link logNorm} saturation for engagement per hour. */
  velocitySaturation: number
  /** {@link logNorm} saturation for the raw reply count. */
  replySaturation: number
  /** {@link logNorm} saturation for author follower count. */
  followerSaturation: number
  /** {@link logNorm} saturation for author status count. */
  authorVolumeSaturation: number
  /**
   * How much of a *remote* post's true favourite / boost / reply count this
   * instance can actually see, `0..1`. Local posts are authoritative and use
   * 1.0 implicitly; remote counts are divided by these to put both on the same
   * scale.
   *
   * Measured by fetching the same post from its home instance and from an
   * observing instance (n=186, 6 observers): favourites arrive at 0.60 of
   * their true value, boosts at 0.93, replies at 1.00. Favourites federate
   * only to the author's and the favouriter's instances; a boost is itself a
   * delivery event, so it propagates with the post.
   *
   * **This corrects the scale, not the post.** As the note in
   * {@link extractRankingFeatures} says, dividing zero by 0.6 is still zero,
   * and 10% of remote posts report zero favourites when the home instance has
   * some. The correction makes a remote post with *some* visible engagement
   * comparable to a local one; it cannot manufacture signal that never
   * federated.
   */
  favouriteCoverageRemote: number
  reblogCoverageRemote: number
  replyCoverageRemote: number

  /**
   * Content priors: measured, reach-controlled, within-instance multipliers on
   * how much engagement a post of this shape attracts. Applied to the positive
   * heads and faded out as observed engagement grows — see the note in
   * `predictActions`. 1.0 disables one.
   */
  botEngagementPrior: number
  /**
   * The bot discount on `followAuthor`, kept separate from
   * {@link RankingParams.botEngagementPrior} because it must **not** fade as
   * the post gets popular. The engagement priors fade on the reasoning that
   * observed counts already embody how much the crowd engaged, so a prior
   * about engagement is redundant where the evidence is visible. Following an
   * author is not that quantity: it is a judgment about the account, and a
   * viral bot post is still a bot you would not follow. Same measured
   * magnitude, different fade behaviour — hence its own parameter, sweepable
   * to 1.0 to disable.
   */
  botFollowPrior: number
  linkEngagementPrior: number
  mediaEngagementPrior: number
  hashtagEngagementPrior: number

  /**
   * Added to the `reply` weight for an original post by a mutual follow.
   * Defaults to X's {@link BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST} (15.0),
   * which makes the effective mutual reply weight 20.0 — the largest weight
   * anywhere in the ranker. In params so `scripts/for-you-replay.ts` can
   * measure what it actually does before anyone argues about it.
   */
  bidirectionalFollowReplyWeightBoost: number
}

export const DEFAULT_RANKING_PARAMS: RankingParams = {
  enableAuthorDiversity: true,
  authorDiversityDecay: 0.5,
  authorDiversityFloor: 0.25,
  oonWeightFactor: 0.75,
  oonRescoreInNetworkRepliesReblogs: true,
  newUserOonWeightFactor: 0.00001,
  newUserMinFollowing: 5,
  newUserAgeThresholdMs: 0,
  enableNewAuthorBoost: true,
  coldStartImpressionThreshold: 5000,
  coldStartFollowerCap: 1000,
  coldStartSlotMin: 15,
  coldStartSlotMax: 16,
  coldStartMaxPostAgeMs: 24 * 60 * 60 * 1000,
  coldStartMaxPositionRatio: 0.85,
  // Elk-specific. X does not decay by age in the scorer at all: it hard-cuts
  // at 48h in `AgeFilter` and lets Phoenix learn freshness from training data.
  // We have no training data, so freshness is one explicit multiplier applied
  // once (see `contextMultiplier`). With a 12h half-life and a 0.12 floor the
  // real exchange rate is: a post needs 1.11x the score to win from 2h back,
  // 1.48x from 8h, 1.79x from 12h, 2.94x from 24h and 4.83x from 40h. That is
  // deliberately beatable in the 6-12h band — a For You feed whose best post
  // from this morning can never surface has no reason to exist next to the
  // home timeline — and deliberately steep past a day.
  recencyHalfLifeMs: 12 * 60 * 60 * 1000,
  recencyFloor: 0.12,
  // Mild, because `status.language` is set by the posting client and is
  // frequently wrong. One mislabelled field must not annihilate a post.
  languageMismatchPrior: 0.6,

  // See `CALIBRATION.md`. Measured 2026-08-17 over 4,800 mature local posts
  // (8 instances), 2,466 remote posts as observed (5 instances), 186 paired
  // home-vs-observed fetches, and 405 unique trending posts (15 instances).
  // Only this one was badly wrong. At 1,000,000 the entire fediverse range
  // occupied 0.05-0.52 of a 0-1 feature. The largest post in the sample
  // totalled 1,343 interactions and the p99 of ordinary local posts is 68, so
  // the naive fit would be ~2,000 — but that ceiling comes from
  // `/trends/statuses`, which is algorithmically ranked *and* moderator-gated,
  // and no genuinely viral post from a large account was ever sampled. 10,000
  // keeps most of the dynamic-range gain (a median trending post's engagement
  // lift goes 3.31x -> 3.77x of its intended 8x, the top of the sample
  // 5.7x -> 6.6x) while leaving 7x headroom above anything observed before
  // the transform starts clipping. Sweep it with `scripts/for-you-replay.ts`.
  engagementSaturation: 10_000,
  // These four were already about right for the fediverse, which is worth
  // recording: the X-scale problem was specific to total engagement.
  // Measured maxima: 155.5 interactions/hour, 44 replies, and author
  // followers/statuses whose p95 sits well inside these points.
  velocitySaturation: 500,
  replySaturation: 100,
  followerSaturation: 50_000,
  authorVolumeSaturation: 50_000,
  favouriteCoverageRemote: 0.6,
  reblogCoverageRemote: 0.93,
  replyCoverageRemote: 1,

  // Measured 0.16-0.43x (bot), 0.61-0.80x (link card), 1.25x (media) and
  // 1.29x (hashtags), each reproducing within-instance. `botEngagementPrior`
  // sits at the conservative end of its range — see the note at its use site.
  botEngagementPrior: 0.4,
  botFollowPrior: 0.4,
  linkEngagementPrior: 0.7,
  mediaEngagementPrior: 1.25,
  hashtagEngagementPrior: 1.3,

  bidirectionalFollowReplyWeightBoost: BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST,
}

// #endregion

// #region context

/**
 * How the ranker reads the viewer's affinity for an author, tag or language.
 *
 * `signals.ts` owns the storage and is being restructured around a
 * timestamped, per-engagement-type history, so the ranker deliberately does
 * not reach into `ForYouSignals` directly when a resolver is supplied: pass
 * `ctx.affinity` and the recency weighting, per-type weighting and negative
 * signal all live where the history does. The default implementation
 * ({@link defaultAffinityResolver}) is the fallback over the plain scalar maps.
 *
 * Contract: the returned value is **signed**, in `[-1, 1]`. Positive means the
 * viewer engages with this more than with the rest of their history, 0 means
 * no information, and negative means an explicit negative signal — a
 * "not interested", a dismissal, a mute. Discarding the negative half is a bug;
 * the negative heads below consume it.
 */
export interface AffinityResolver {
  author: (accountId: string) => number
  tag: (tag: string) => number
  language: (code: string) => number
  /**
   * "Whose boosts do I engage with." Boosting is the distribution mechanism on
   * Mastodon, so for a boosted post the *booster* is a real signal that has no
   * analogue on X. Signed, `[-1, 1]`, and 0 for a post that is not a boost.
   */
  booster: (accountId: string) => number
  /**
   * How hard the viewer has pushed back on this AUTHOR as a whole, `0..1`: an
   * explicit mute, or (via the caller's wiring) the decayed evidence of
   * dismissals of the author's *other* posts. Separate from `author` because
   * the derived affinity maps only carry positive weight — a dismissal is
   * recorded as its own event, not as a negative counter.
   *
   * This is deliberately account-scoped, not post-scoped: it is the floor
   * `predictActions` applies to `muteAuthor`, and muting is a verdict on the
   * account* — flooring it from a single dismissed post would conflate "I
   * don't want to see this one again" with "mute this whole author". See
   * {@link postPenalty} for the post-scoped half of the split, and the note
   * above `notInterested`/`muteAuthor` in `predictActions` for why they used
   * to be the same number and why that was a bug.
   *
   * The default reads only what `ForYouSignals` itself exposes: a muted
   * author scores 1, everyone else 0. `signals.ts` also exports
   * `authorPenaltyIn`, which additionally counts *decayed* dismissals of the
   * author's other posts; the caller wires that in with
   * `ctx.affinity = { authorPenalty: id => authorPenaltyIn(signals, id, now) }`
   * rather than this file importing it, so the scorer stays free of the
   * reactive store.
   */
  authorPenalty: (accountId: string) => number
  /**
   * How hard the viewer has pushed back on this specific POST, `0..1`: an
   * explicit "not interested" dismissal of this exact status id. This is the
   * floor `predictActions` applies to `notInterested` — dismissing one post
   * is a verdict on that post, not (by itself) on the author, so it must not
   * also floor `muteAuthor`. See {@link authorPenalty}.
   *
   * The default reads `ForYouSignals.notInterested`. `signals.ts` has no
   * decayed equivalent for this one — a dismissal either is or isn't this
   * exact post — so most callers can leave it at the default.
   */
  postPenalty: (statusId: string) => number
}

/**
 * Everything the ranker needs to know about the viewer and the moment.
 * Passed in rather than read from composables so the scorer stays pure.
 */
export interface RankingContext {
  /** Epoch ms treated as "now". Injected so tests are deterministic. */
  now: number
  /** The viewer's account id, used to recognise self-posts and self-replies. */
  viewerId?: string
  /** The viewer's preferred language codes, most-preferred first. */
  viewerLanguages?: string[]
  /** How many accounts the viewer follows — feeds the new-user OON rule. */
  viewerFollowingCount?: number
  /** How many followers the viewer has — feeds X's vqv follower gate. */
  viewerFollowerCount?: number
  /** Age of the viewer's own account in ms — feeds the new-user OON rule. */
  viewerAccountAgeMs?: number
  /**
   * Author ids that follow the viewer back. Mastodon does not put this in the
   * status payload, so it is optional; when present it unlocks X's
   * bidirectional-follow reply weight boost.
   */
  mutualAuthorIds?: ReadonlySet<string>
  /** Overrides the default affinity reading. See {@link AffinityResolver}. */
  affinity?: Partial<AffinityResolver>
  /** Per-action weight overrides, merged over {@link MASTODON_WEIGHTS}. */
  weights?: Partial<Record<keyof ActionProbabilities, number>>
  /** Parameter overrides, merged over {@link DEFAULT_RANKING_PARAMS}. */
  params?: Partial<RankingParams>
  /**
   * Per-head base rate overrides, merged over {@link BASE_RATES}.
   *
   * This is how measured rates reach the model: `base-rates.ts` estimates
   * P(action | shown in For You) from the viewer's own lifetime counters and
   * shrinks it toward the shipped constant, and `feed.ts` passes the result
   * through here. Absent (the default, and the cold path) the ranker reads
   * {@link BASE_RATES} exactly as it always has. See `INTERCEPT.md` §5.
   */
  baseRates?: Partial<Record<keyof ActionProbabilities, number>>
}

function resolveParams(ctx: RankingContext): RankingParams {
  return ctx.params ? { ...DEFAULT_RANKING_PARAMS, ...ctx.params } : DEFAULT_RANKING_PARAMS
}

function resolveWeights(ctx: RankingContext): Record<keyof ActionProbabilities, number> {
  return ctx.weights ? { ...MASTODON_WEIGHTS, ...ctx.weights } : MASTODON_WEIGHTS
}

// `resolveBaseRates` belongs in this cluster and is deliberately not here:
// `BASE_RATES` is not declared until the model region below, and
// `ts/no-use-before-define` rejects the forward reference even though it is
// runtime-safe. It sits immediately above `predictActions` instead.

// #endregion

// #region math helpers

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value))
    return min
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/**
 * Scales one federated count back up by how much of it actually reaches an
 * observing instance. Local counts are authoritative and never come here.
 *
 * The guard is not defensive padding: `scripts/for-you-calibrate.ts` sweeps
 * these coverages, and `--set favouriteCoverageRemote=0` is a reachable
 * input. Dividing by it yields `Infinity`, which `logNorm` clamps to
 * popularity 1.0 for *every* remote post at once — the ranking collapses
 * silently rather than failing. A non-positive coverage means "no measurement
 * for this count", so the honest degradation is the raw count.
 */
function coverageCorrected(count: number, coverage: number): number {
  return coverage > 0 ? count / coverage : count
}

/**
 * Heavy-tail normalizer. Engagement counts on any social network are
 * power-law distributed: the difference between 0 and 10 favourites says far
 * more about a post than the difference between 1000 and 1010. `log1p`
 * compresses that tail; dividing by `log1p(saturation)` puts the result on a
 * 0..1 scale where `saturation` maps to 1.
 *
 * **The saturation point is load-bearing.** Set it near the middle of the
 * corpus and the transform stops being a normalizer and becomes a constant:
 * everything interesting clips to 1.0 and engagement drops out of the ordering
 * entirely. It must sit at the top of the realistic range, not the middle —
 * see `RankingParams.engagementSaturation` and `CALIBRATION.md`.
 */
export function logNorm(count: number, saturation: number): number {
  if (!(count > 0) || !(saturation > 0))
    return 0
  return clamp01(Math.log1p(count) / Math.log1p(saturation))
}

/**
 * Turns a signed `[-1, 1]` signal into a multiplicative factor.
 *
 * `lift(0, …) === 1` always, so a missing signal is always a no-op — important
 * because most of our signals are missing most of the time. A signal of `+1`
 * gives `max`; a signal of `-1` gives `min`, which defaults to 1 so callers
 * that only care about the positive half are unaffected. Passing `max < 1`
 * makes the positive half a penalty.
 */
export function lift(signal: number, max: number, min = 1): number {
  const s = clamp(signal, -1, 1)
  return s >= 0 ? 1 + (max - 1) * s : 1 + (1 - min) * s
}

/**
 * Signed, rank-based normalization of an affinity map.
 *
 * The obvious implementation — divide by the largest value in the map — is
 * winner-take-all: as the viewer's history grows, the top author's counter
 * runs away and everybody else is crushed towards zero, so personalization
 * degenerates into a single-author bonus. This uses the mid-rank empirical CDF
 * over the entries of the same sign instead, which is invariant to however
 * `signals.ts` scales or decays its counters *and* keeps discriminating across
 * the whole distribution: an author in the 70th percentile of your history
 * scores 0.7 whether the leader sits at 20 or at 20,000.
 *
 * Negative entries are read as an explicit negative signal and returned as a
 * negative value in `[-1, 0)`, ranked among the other negatives. Silently
 * dropping them — as `value > 0 ? … : 0` does — throws away every
 * "not interested" the viewer has ever given.
 *
 * The ranking is recomputed on every call rather than cached: `signals.ts`
 * owns these maps and may mutate them in place, and a stale cache would
 * silently mis-rank. The maps are small enough that it does not matter.
 */
export function affinitySignal(map: Record<string, number> | undefined, key: string | undefined | null): number {
  if (!map || !key)
    return 0
  const value = map[key]
  if (!value || !Number.isFinite(value))
    return 0

  const positive = value > 0
  let below = 0
  let equal = 0
  let total = 0
  for (const k in map) {
    const v = map[k]
    if (!v || !Number.isFinite(v) || (v > 0) !== positive)
      continue
    total++
    const a = Math.abs(v)
    const b = Math.abs(value)
    if (a < b)
      below++
    else if (a === b)
      equal++
  }
  if (total === 0)
    return 0

  const percentile = (below + equal / 2) / total
  return positive ? percentile : -percentile
}

/** Reads affinity straight off the scalar maps in {@link ForYouSignals}. */
export function defaultAffinityResolver(signals: ForYouSignals): AffinityResolver {
  // `boosterAffinity` lives on the signals *store*, one layer below the
  // contract type, so it is read optionally rather than required.
  const boosterAffinity = (signals as { boosterAffinity?: Record<string, number> }).boosterAffinity
  const muted = signals.mutedForYou
  const dismissedPosts = signals.notInterested
  return {
    author: id => affinitySignal(signals.authorAffinity, id),
    tag: tag => affinitySignal(signals.tagAffinity, tag),
    language: code => affinitySignal(signals.languageAffinity, code),
    booster: id => affinitySignal(boosterAffinity, id),
    authorPenalty: accountId => (accountId && muted?.includes(accountId)) ? 1 : 0,
    postPenalty: statusId => (statusId && dismissedPosts?.includes(statusId)) ? 1 : 0,
  }
}

function resolveAffinity(signals: ForYouSignals, ctx: RankingContext): AffinityResolver {
  const fallback = defaultAffinityResolver(signals)
  if (!ctx.affinity)
    return fallback
  return {
    author: ctx.affinity.author ?? fallback.author,
    tag: ctx.affinity.tag ?? fallback.tag,
    language: ctx.affinity.language ?? fallback.language,
    booster: ctx.affinity.booster ?? fallback.booster,
    authorPenalty: ctx.affinity.authorPenalty ?? fallback.authorPenalty,
    postPenalty: ctx.affinity.postPenalty ?? fallback.postPenalty,
  }
}

// #endregion

// #region features

/**
 * Recency multiplier in `(recencyFloor, 1]`, hitting 0 past the 48h
 * `AgeFilter` cap so a stale candidate that slipped through the candidate
 * stage can never win.
 *
 * The curve deliberately reuses the shape of X's own author-diversity
 * multiplier — `(1 - floor) * decay^exponent + floor`. It is applied **once**,
 * in {@link contextMultiplier}, not folded into the individual heads: an
 * earlier revision multiplied it into all thirteen positive estimators, which
 * made age unbeatable by any amount of engagement.
 */
export function recencyMultiplier(ageMs: number, params: RankingParams = DEFAULT_RANKING_PARAMS): number {
  const age = Math.max(0, ageMs)
  if (age > MAX_POST_AGE_MS)
    return 0
  const halfLives = age / params.recencyHalfLifeMs
  return (1 - params.recencyFloor) * 0.5 ** halfLives + params.recencyFloor
}

/**
 * Below this age we stop dividing by age, so a 1-minute-old post isn't
 * infinitely fast.
 *
 * The {@link logNorm} saturation points that used to live here are now
 * `engagementSaturation` / `velocitySaturation` / `replySaturation` /
 * `followerSaturation` / `authorVolumeSaturation` on {@link RankingParams},
 * so the replay harness can sweep them. Their previous values assumed X-scale
 * engagement — `ENGAGEMENT_SATURATION` was 1,000,000, on the theory that a
 * post is only "maximally engaging" at ~1M interactions.
 *
 * Measured against the live fediverse, that is off by three orders of
 * magnitude: the single most-engaged post in a 15-instance trending sweep
 * totalled 1,343 interactions, and the p99 of ordinary local posts is 68. The
 * effect was that the entire fediverse range occupied 0.05–0.52 of a feature
 * meant to span 0–1, so `lift(engagementSignal, 8)` delivered 3.31x of its
 * intended 8x for a median trending post.
 *
 * The guard that motivated the old value is still real and still respected:
 * a saturation of a few hundred would make every post on a busy instance clip
 * to 1.0 and remove engagement from the ordering. The current defaults are
 * chosen so the measured maximum approaches but never reaches 1.0. See
 * `CALIBRATION.md`, including why `engagementSaturation` is the least certain
 * of them.
 */
const MIN_VELOCITY_AGE_HOURS = 0.25

/** Everything the estimators read, computed once per candidate. */
export interface RankingFeatures {
  /** Age of the *content* — for a boost, the age of the boosted post. */
  ageMs: number
  ageHours: number
  freshness: number
  favourites: number
  reblogs: number
  replies: number
  /** Raw observed sum, exactly as the instance reported it. */
  totalEngagement: number
  /**
   * `totalEngagement` with each count divided by how much of it federates, so
   * a remote post is on the same scale as a local one. Equal to
   * `totalEngagement` for local posts. This is what `popularity` and
   * `velocity` are computed from.
   */
  engagementEstimate: number
  /** 0..1 absolute reach of the post. */
  popularity: number
  /** 0..1 engagement per hour — lets a fresh post compete with an old hit. */
  velocity: number
  /** Blend of the two, the main "the crowd engaged with this" term. */
  engagementSignal: number
  /** Share of engagement that is replies — high means conversational/divisive. */
  replyDensity: number
  /** Share of engagement that is boosts — high means broadcast-worthy. */
  reblogDensity: number
  /** Signed, -1..1, from the viewer's positive engagement history. */
  authorAffinity: number
  tagAffinity: number
  /** How many hashtags the post carries. Presence is a measured engagement prior. */
  tagCount: number
  languageAffinity: number
  /** Signed affinity for whoever boosted this, 0 when it is not a boost. */
  boosterAffinity: number
  /** 0..1, how hard the viewer has pushed back on this AUTHOR (mute, or decayed dismissals of their other posts). Floors `muteAuthor` only. */
  authorPenalty: number
  /** 0..1, how hard the viewer has pushed back on this specific POST (a "not interested" on this exact status). Floors `notInterested` only. */
  postPenalty: number
  languagePrior: number
  languageMismatch: boolean
  /** 0..1 author follower count, log-normalized. */
  authorReach: number
  /** 0..1 spamminess: follows far more accounts than follow back, no bio, etc. */
  spamminess: number
  /** 0..1 how prolific the author is — the thing muting is actually about. */
  authorVolume: number
  verified: boolean
  bot: boolean
  hasImage: boolean
  imageCount: number
  hasVideo: boolean
  videoDurationMs?: number
  hasLink: boolean
  hasCardImage: boolean
  hasPoll: boolean
  hasSpoiler: boolean
  sensitive: boolean
  isReply: boolean
  isSelfReply: boolean
  isBoost: boolean
  hasQuestion: boolean
  textLength: number
  inNetwork: boolean
}

/**
 * The status whose *content* is being judged. For a boost, that is the boosted
 * post — its counts, media, text, author and **age** are what the viewer is
 * actually being shown. Reading counts from the inner status but age from the
 * outer one makes every boost look infinitely fast; a two-year-old post
 * boosted a minute ago would score as the most viral thing in the slate.
 */
function contentStatus(candidate: PostCandidate): mastodon.v1.Status {
  return candidate.status.reblog ?? candidate.status
}

/** Age of the content in ms, clamped at 0 for clock skew / future-dated posts. */
function contentAgeMs(candidate: PostCandidate, now: number): number {
  const status = contentStatus(candidate)
  const createdAt = Date.parse(status.createdAt ?? candidate.status.createdAt ?? '')
  return Number.isNaN(createdAt) ? 0 : Math.max(0, now - createdAt)
}

/**
 * Duration of the first video/gifv attachment in ms, or undefined. Mastodon
 * types `meta.original` as image-meta | video-meta, so the `in` narrowing is
 * how we ask "is this actually a video?".
 */
function videoDurationMs(status: mastodon.v1.Status): number | undefined {
  const video = (status.mediaAttachments ?? []).find(m => m.type === 'video' || m.type === 'gifv')
  const original = video?.meta?.original
  if (!original || !('duration' in original) || typeof original.duration !== 'number')
    return undefined
  return original.duration * 1000
}

const HTML_TAG_RE = /<[^>]*>/g
const WHITESPACE_RE = /\s+/g

function plainTextLength(status: mastodon.v1.Status): number {
  const html = status.content ?? ''
  return html.replace(HTML_TAG_RE, ' ').replace(WHITESPACE_RE, ' ').trim().length
}

export function extractRankingFeatures(
  candidate: PostCandidate,
  signals: ForYouSignals,
  ctx: RankingContext,
): RankingFeatures {
  const params = resolveParams(ctx)
  const affinity = resolveAffinity(signals, ctx)
  const outer = candidate.status
  const status = contentStatus(candidate)
  const account = status.account

  const ageMs = contentAgeMs(candidate, ctx.now)
  const ageHours = ageMs / 3_600_000
  const freshness = recencyMultiplier(ageMs, params)

  // A previous revision multiplied remote posts' counts by a single constant
  // to "correct" for federation under-counting, and a later one removed that
  // on the grounds that the API exposes no per-instance coverage estimate.
  //
  // The removal reasoning was half right, and the half that was right still
  // holds: on a single-user instance a remote post's counts are 0 or 1, and
  // 3 x 0 is still 0. No multiplier recovers a favourite that never arrived.
  // What was wrong is the premise that coverage is unmeasurable. It is — fetch
  // the same post from its home instance and compare — and it is not one
  // number but three very different ones, because the three counts federate by
  // different mechanisms. That measurement is what `*CoverageRemote` encodes
  // and what the composite below applies. See `CALIBRATION.md`.
  const favourites = status.favouritesCount ?? 0
  const reblogs = status.reblogsCount ?? 0
  const replies = status.repliesCount ?? 0
  const totalEngagement = favourites + reblogs + replies

  // The three counts do not federate equally, so summing them as if they were
  // one number lets whichever happened to arrive dominate. Measured by
  // re-fetching the same post from its home instance (n=186): favourites reach
  // an observing instance at 0.60 of their true value, boosts at 0.93, replies
  // at 1.00. On a federated timeline the practical effect is stark — 96% of
  // remote posts report *zero* favourites, and boosts outnumber favourites
  // 1.755:1, the exact inverse of the 1:0.465 measured on authoritative local
  // posts.
  //
  // Left uncorrected this does two things: it makes the composite a lottery on
  // federation topology, and it puts remote posts on a systematically deflated
  // scale versus local ones — which the 0.75 out-of-network factor then
  // discounts *again*. So remote counts are divided by their measured coverage
  // and local counts are used as-is.
  //
  // `totalEngagement` stays the raw observed sum: it is what the instance
  // actually reported, it is what the densities below are shares of, and
  // `impressionProxy` needs the honest number.
  const remote = (account?.acct ?? '').includes('@')
  const correctedFavourites = remote ? coverageCorrected(favourites, params.favouriteCoverageRemote) : favourites
  const correctedReblogs = remote ? coverageCorrected(reblogs, params.reblogCoverageRemote) : reblogs
  const correctedReplies = remote ? coverageCorrected(replies, params.replyCoverageRemote) : replies
  const engagementEstimate = correctedFavourites + correctedReblogs + correctedReplies

  const popularity = logNorm(engagementEstimate, params.engagementSaturation)
  const velocity = logNorm(
    engagementEstimate / Math.max(MIN_VELOCITY_AGE_HOURS, Math.min(ageHours, 48)),
    params.velocitySaturation,
  )
  // Half absolute reach, half rate. Rate alone would hand the feed to
  // five-minute-old posts with two favourites; reach alone would hand it to
  // last week's viral post.
  const engagementSignal = 0.5 * popularity + 0.5 * velocity
  // Densities are shares of the *corrected* composite, not of the raw sum.
  // The three counts federate unequally, so a raw share hands the ratio to
  // whichever count happened to arrive: with favourites at 0.60 coverage and
  // replies at 1.00, an ordinary remote post reads as far more reply-heavy
  // than it is, and `lift(f.replyDensity, 2.5)` then multiplies that artifact
  // straight into `reply`. The sharpest case is the common one — 96% of
  // remote posts report zero favourites, so equal observed boosts and replies
  // read 50/50 when the true post is boost-heavy, boosts having federated at
  // 0.93 against replies' 1.00. See `CALIBRATION.md`.
  const replyDensity = engagementEstimate > 0 ? correctedReplies / engagementEstimate : 0
  const reblogDensity = engagementEstimate > 0 ? correctedReblogs / engagementEstimate : 0

  const authorAffinity = account?.id ? affinity.author(account.id) : 0
  const authorPenalty = clamp01(affinity.authorPenalty(account?.id ?? ''))
  const postPenalty = clamp01(affinity.postPenalty(outer.id ?? ''))
  const boosterAffinity = outer.reblog ? affinity.booster(outer.account?.id ?? '') : 0
  let tagAffinity = 0
  for (const tag of status.tags ?? []) {
    const name = tag.name?.toLowerCase()
    if (!name)
      continue
    const value = affinity.tag(name)
    if (Math.abs(value) > Math.abs(tagAffinity))
      tagAffinity = value
  }

  const language = status.language ?? undefined
  const languageAffinity = language ? affinity.language(language) : 0
  const known = !language || !ctx.viewerLanguages?.length || ctx.viewerLanguages.includes(language)
  const languageMismatch = !known && languageAffinity <= 0
  // Applied once, in `contextMultiplier`, and applied mildly: `status.language`
  // is whatever the posting client felt like sending.
  const languagePrior = languageMismatch
    ? params.languageMismatchPrior
    : lift(languageAffinity, 1.15, params.languageMismatchPrior)

  const followers = account?.followersCount ?? 0
  const following = account?.followingCount ?? 0
  const authorReach = logNorm(followers, params.followerSaturation)
  // Classic follow-spam shape: follows many, followed by few. Only meaningful
  // once the account follows a non-trivial number of people.
  const followRatio = following > 20 ? followers / following : 1
  const spamminess = clamp01(
    (followRatio < 0.1 ? 0.6 : followRatio < 0.5 ? 0.3 : 0)
    + (account?.note ? 0 : 0.15)
    + (account?.statusesCount === 0 ? 0.1 : 0),
  )
  const authorVolume = logNorm(account?.statusesCount ?? 0, params.authorVolumeSaturation)
  const verified = (account?.fields ?? []).some(field => !!field.verifiedAt)

  const media = status.mediaAttachments ?? []
  const images = media.filter(m => m.type === 'image')
  const video = media.find(m => m.type === 'video' || m.type === 'gifv')

  return {
    ageMs,
    ageHours,
    freshness,
    favourites,
    reblogs,
    replies,
    totalEngagement,
    engagementEstimate,
    popularity,
    velocity,
    engagementSignal,
    replyDensity,
    reblogDensity,
    authorAffinity,
    tagAffinity,
    tagCount: (status.tags ?? []).length,
    languageAffinity,
    boosterAffinity,
    authorPenalty,
    postPenalty,
    languagePrior,
    languageMismatch,
    authorReach,
    spamminess,
    authorVolume,
    verified,
    bot: !!account?.bot,
    hasImage: images.length > 0,
    imageCount: images.length,
    hasVideo: !!video,
    videoDurationMs: videoDurationMs(status),
    hasLink: !!status.card,
    hasCardImage: !!status.card?.image,
    hasPoll: !!status.poll,
    hasSpoiler: !!status.spoilerText,
    sensitive: !!status.sensitive,
    isReply: !!status.inReplyToId,
    isSelfReply: !!status.inReplyToAccountId && status.inReplyToAccountId === account?.id,
    isBoost: !!outer.reblog,
    hasQuestion: (status.content ?? '').includes('?'),
    textLength: plainTextLength(status),
    inNetwork: candidate.inNetwork,
  }
}

// #endregion

// #region the model

/**
 * Base rates: roughly the unconditional probability of each action on a post
 * that has actually been shown to a viewer. They set the *scale* of every
 * head so the weighted sum has the same balance X's does — in particular so
 * that `report`'s -234.0 weight, multiplied by a genuinely tiny base rate,
 * lands well below `favorite`'s 0.5 x ~3%.
 *
 * The negative rates are calibrated so that the whole negative side of an
 * ordinary post sums to roughly a fifth of its positive side. That matters
 * more than it looks: `offsetScore`'s negative branch compresses everything
 * below zero into a 0.1%-wide band just under 0.001, so any post that lands
 * there is effectively unordered. In X that valve almost never opens because
 * Phoenix's probabilities are tiny; here it has to be kept shut by
 * construction.
 */
export const BASE_RATES: Record<keyof ActionProbabilities, number> = {
  favorite: 0.03,
  reply: 0.0035,
  // 3x X's rate. On X a retweet is roughly a fifth as common as a favourite;
  // on Mastodon boosting is the only way a post travels, so it runs much
  // closer to parity. The three estimates of boost/favourite disagree, and the
  // spread is itself informative:
  //
  //   0.465  authoritative local posts (n=4,800) — the true ratio
  //   0.721  implied by per-count federation coverage (0.465 x 0.93/0.60)
  //   1.755  federated timelines as observed (n=2,466)
  //
  // The For You pool mixes local and remote sources, so the effective value
  // sits between the first two; 0.6 x the favourite rate is the midpoint.
  // (The third is inflated by the federated firehose's different population,
  // not by coverage alone, so it is not a candidate.)
  //
  // Note this is a directional transfer, not a literal one: `BASE_RATES` is
  // P(*this viewer* acts | impression), while what was measured is aggregate
  // counts per post — and boosts inflate their own impression denominator,
  // since a boost is what generates the impressions. See `CALIBRATION.md`.
  retweet: 0.018,
  // Unused: the `quote` head is derived from `retweet` below rather than from
  // a base rate. Kept at its X value so the head table stays complete.
  quote: 0.0006,
  share: 0.001,
  click: 0.03,
  openLink: 0.012,
  profileClick: 0.005,
  photoExpand: 0.02,
  videoOpen: 0.02,
  vqv: 0.02,
  dwell: 0.5,
  followAuthor: 0.0006,
  notInterested: 0.00012,
  muteAuthor: 0.00002,
  blockAuthor: 0.000015,
  report: 0.000003,
  notDwelled: 0.22,
}

/**
 * Merges `ctx.baseRates` over {@link BASE_RATES}, the same shape
 * {@link resolveParams} and {@link resolveWeights} use. Returns the module
 * constant itself when nothing is overridden, so the cold path allocates
 * nothing and stays byte-identical to the pre-measurement ranker.
 */
function resolveBaseRates(ctx: RankingContext): Record<keyof ActionProbabilities, number> {
  return ctx.baseRates ? { ...BASE_RATES, ...ctx.baseRates } : BASE_RATES
}

/**
 * The Phoenix substitute. Each head is `base rate x independent multiplicative
 * lifts`, which is a log-linear model with hand-set coefficients — the same
 * functional family a logistic regression would land in, minus the training.
 *
 * Rules of the road for every estimator below:
 *  - engagement counts are *never* used raw, only through `logNorm`;
 *  - a missing signal must produce a lift of exactly 1, never 0;
 *  - **no head reads `inNetwork`, freshness or language.** Those are applied
 *    once each, by the pipeline: the follow graph as `oonWeightFactor` in
 *    `applyAdjustments`, freshness and language as `contextMultiplier`. The
 *    sole exception is `followAuthor`, which is gated on `inNetwork` because
 *    following someone you already follow is not an action that exists — a
 *    logical impossibility, not a preference;
 *  - `notDwelled` is the one head that *rises* with age, which is a genuine
 *    per-head effect on the negative side and so does not double-count the
 *    freshness multiplier on the positive side.
 */
export function predictActions(
  candidate: PostCandidate,
  signals: ForYouSignals,
  ctx: RankingContext,
): ActionProbabilities {
  const f = extractRankingFeatures(candidate, signals, ctx)
  const params = resolveParams(ctx)
  const B = resolveBaseRates(ctx)

  // ── measured content priors ─────────────────────────────────────────────
  // Multiplicative effects measured off the live fediverse, applied to the
  // heads that predict engagement. Each survived a *within-instance* control,
  // which is the check that matters here: mean engagement varies 7.5x across
  // instances and bot share ranges 0-49%, so a pooled effect that does not
  // reproduce inside each instance separately is an artifact of which servers
  // happened to be sampled. See `CALIBRATION.md`.
  //
  //   bot author  0.16-0.43x  reproduces in 6 of 7 testable instances
  //   link card   0.61-0.80x  reproduces in 7 of 8
  //   media 1.25x, hashtags 1.29x (humans only)
  //
  // Bot and link-card are two effects, not one seen twice: P(bot & card) is
  // only 1.16x what independence predicts, and the card effect is unchanged
  // with bots removed (0.68x -> 0.67x). Both are applied.
  //
  // 0.3 for bots is the midpoint of a wide credible range, not a point
  // estimate — and it is deliberately not lower. Bots are 23% of a local
  // public timeline but a much smaller share of a For You pool, whose
  // candidate sources lean on the follow graph and trending.
  // These are measurements of how much *the crowd* engaged, which means that
  // where the crowd's engagement is already visible they are redundant — the
  // counts embody them. Applying them at full strength on top of an observed
  // count is the same effect twice: a post with media already has whatever
  // extra favourites the media earned it.
  //
  // They earn their keep where the counts are silent, which on the fediverse
  // is most of the time — 59% of remote posts show no engagement at all, and
  // 36% of local ones. So they fade out as observed engagement grows, and a
  // post with real measured traction is judged on that traction instead.
  const priorStrength = 1 - f.popularity
  const shrink = (prior: number) => 1 + (prior - 1) * priorStrength

  // `botEngagementPrior` ships at 0.4, the conservative end of the measured
  // 0.16-0.43 range, for two reasons: the measurement comes from local public
  // timelines, where bots are far over-represented (0-49% by instance)
  // compared with a For You pool that leans on the follow graph and trending;
  // and below ~0.4 the discount gets strong enough to push a zero-engagement
  // bot post under `NEGATIVE_SCORES_OFFSET`, into the band that means "the
  // viewer said no". Predicted-low-engagement should rank a post last, not
  // mark it rejected.
  const botPrior = shrink(f.bot ? params.botEngagementPrior : 1)
  const linkPrior = shrink(f.hasLink ? params.linkEngagementPrior : 1)
  const mediaPrior = shrink(f.hasImage || f.hasVideo ? params.mediaEngagementPrior : 1)
  const hashtagPrior = shrink(f.tagCount > 0 ? params.hashtagEngagementPrior : 1)

  // ── favorite ────────────────────────────────────────────────────────────
  // The action Mastodon's counters speak to most directly, and the one the
  // viewer's author affinity predicts best: people favourite the same handful
  // of accounts over and over. The engagement lift carries most of the
  // dynamic range (1x to 8x) because it is the only head input that is
  // genuinely measured rather than assumed.
  const favorite = clamp01(
    B.favorite
    * lift(f.engagementSignal, 8)
    * lift(f.authorAffinity, 3, 0.4)
    * lift(f.tagAffinity, 1.6, 0.7)
    // Boosting is how content travels on Mastodon, so "whose boosts do I
    // engage with" is a real, X-less signal — a curator you trust is close to
    // an author you trust. Weaker than direct author affinity because the
    // booster only chose the post, they did not write it.
    * lift(f.boosterAffinity, 1.8, 0.7)
    * (f.isBoost ? 0.9 : 1)
    * botPrior
    * linkPrior
    * mediaPrior
    * hashtagPrior,
  )

  // ── reply ───────────────────────────────────────────────────────────────
  // Weight 5.0, so this head matters ~10x more per unit probability than a
  // favourite — which makes its *base* rate the largest flat term in the sum,
  // and therefore the thing most able to make a post with no signal at all
  // look good. It is deliberately tied to engagement as well as to reply
  // density so that a post nobody has engaged with does not collect 5.0 x
  // base for free. Replies remain a relationship action: author affinity has
  // the widest range here of any head.
  const reply = clamp01(
    B.reply
    * lift(f.engagementSignal, 3)
    * lift(f.replyDensity, 2.5)
    * lift(f.authorAffinity, 5, 0.3)
    * lift(f.tagAffinity, 1.4, 0.8)
    * (f.hasQuestion ? 1.4 : 1)
    * (f.hasPoll ? 1.3 : 1)
    * (f.isBoost ? 0.5 : 1)
    * botPrior,
  )

  // ── retweet (boost) ─────────────────────────────────────────────────────
  // Boosting is endorsement-for-an-audience, so it keys on how much the post
  // is *already* being boosted as well as on overall engagement. Boosting a
  // boost, or a reply, is rare.
  const retweet = clamp01(
    B.retweet
    * lift(f.engagementSignal, 6)
    * lift(f.reblogDensity, 2.5)
    * lift(f.authorAffinity, 2.5, 0.5)
    * lift(f.boosterAffinity, 1.6, 0.8)
    * (f.isBoost ? 0.5 : 1)
    * (f.isReply ? 0.6 : 1)
    * botPrior,
  )

  // ── quote ───────────────────────────────────────────────────────────────
  // Weight 5.0 but almost no fediverse server implements quote posts yet
  // (Mastodon 4.4+ only, and off by default), so this is deliberately
  // conservative: a small fraction of the boost propensity, lifted by how
  // discussion-heavy the post is, since quoting is commentary.
  const QUOTE_GIVEN_RETWEET = 0.12
  const quote = clamp01(retweet * QUOTE_GIVEN_RETWEET * lift(f.replyDensity, 2))

  // ── share ───────────────────────────────────────────────────────────────
  // Elk exposes share/copy-link. Nothing observable predicts it, so this is
  // the weakest positive head: the prior plus "things people send to friends"
  // — links, media, and posts with reach.
  const share = clamp01(
    B.share
    * lift(f.popularity, 4)
    // X boosts this 1.6x for links, on the reasoning that a link is the thing
    // people forward. On Mastodon link posts measurably under-perform —
    // 0.61-0.80x, reach-controlled, in 7 of 8 instances — so the lift points
    // the wrong way and becomes the same `linkPrior` the other heads use.
    * linkPrior
    * (f.hasImage || f.hasVideo ? 1.2 : 1),
  )

  // ── click (open the post) ───────────────────────────────────────────────
  // You tap into a post to read what's hidden: a thread (reply count), a
  // content warning (curiosity gap), or text the timeline truncated.
  const click = clamp01(
    B.click
    * lift(logNorm(f.replies, params.replySaturation), 3)
    * (f.hasSpoiler ? 1.8 : 1)
    * lift(clamp01((f.textLength - 280) / 700), 1.5)
    * lift(f.authorAffinity, 2, 0.6),
  )

  // ── openLink ────────────────────────────────────────────────────────────
  // Strictly conditional: no preview card, no link to open. A card image
  // roughly doubles click-through in every published study of link previews.
  const openLink = f.hasLink
    ? clamp01(
        B.openLink
        * lift(f.popularity, 3)
        * (f.hasCardImage ? 1.3 : 1)
        * lift(f.tagAffinity, 1.5, 0.7),
      )
    : 0

  // ── profileClick ────────────────────────────────────────────────────────
  // Weight is 0.0 in production so this is inert today. It does *not* read
  // `inNetwork` even though "you check strangers' profiles more" is true —
  // the follow graph belongs to the OON multiplier.
  const profileClick = clamp01(
    B.profileClick
    * lift(f.popularity, 2)
    * lift(f.authorAffinity, 1.5, 0.8),
  )

  // ── photoExpand ─────────────────────────────────────────────────────────
  // Conditional on an image existing. Galleries and CW-hidden images pull
  // more taps than a single visible photo.
  const photoExpand = f.hasImage
    ? clamp01(
        B.photoExpand
        * (f.imageCount > 1 ? 1.3 : 1)
        * (f.hasSpoiler || f.sensitive ? 1.4 : 1)
        * lift(f.authorAffinity, 1.5, 0.8),
      )
    : 0

  // ── videoOpen ───────────────────────────────────────────────────────────
  const videoOpen = f.hasVideo
    ? clamp01(B.videoOpen * lift(f.popularity, 2) * lift(f.authorAffinity, 1.5, 0.8))
    : 0

  // ── vqv (video quality view) ────────────────────────────────────────────
  // Conditional on opening the video and then staying. X gates the *weight*
  // on `MinVideoDurationMs` and on the viewer's follower count; we gate it
  // there too (see `effectiveWeights`), and keep the probability honest here.
  const VQV_GIVEN_OPEN = 0.45
  const vqv = clamp01(videoOpen * VQV_GIVEN_OPEN)

  // ── dwell ───────────────────────────────────────────────────────────────
  // Weight 0.0 in production, and Elk has no dwell instrumentation, so this
  // is a pure content-shape prior: long text, media and threads hold you.
  const dwell = clamp01(
    B.dwell
    * lift(clamp01(f.textLength / 500), 1.4)
    * (f.hasImage || f.hasVideo ? 1.15 : 1)
    * lift(f.authorAffinity, 1.3, 0.85),
  )

  // ── followAuthor ────────────────────────────────────────────────────────
  // Weight 4.0. Structurally out-of-network only: you cannot follow an account
  // you already follow, so this is a hard logical gate, not a preference — the
  // one place `inNetwork` legitimately appears in an estimator.
  //
  // It is worth being clear about what this head does and does not do: at
  // realistic probabilities it contributes roughly a tenth of a strong
  // out-of-network post's score. It is a tilt, not a counterweight. What
  // actually lets good out-of-network content win is that nothing else in the
  // model reads the follow graph, so the only handicap such a post carries is
  // the single 0.75 multiplier.
  const followAuthor = f.inNetwork
    ? 0
    : clamp01(
        B.followAuthor
        * lift(f.engagementSignal, 6)
        * lift(f.authorAffinity, 4, 0.3)
        * lift(f.tagAffinity, 2, 0.6)
        * lift(f.authorReach, 1.5)
        * (f.verified ? 1.5 : 1)
        // Not `botPrior`: that one fades with popularity, and this one must
        // not. See {@link RankingParams.botFollowPrior}.
        * (f.bot ? params.botFollowPrior : 1)
        * (f.isReply ? 0.7 : 1),
      )

  // ── notInterested ───────────────────────────────────────────────────────
  // Weight -43.2. Driven by bots, spam-shaped accounts, and — through the
  // signed affinity — the viewer having explicitly dismissed this author
  // before. Language does *not* appear: it is already a prior, and applying it
  // here as well is what turned one mislabelled `status.language` field into a
  // 100x score collapse.
  //
  // The dismissal penalty enters here rather than as a filter or a subtracted
  // constant, and that placement is the point: -43.2 is a weight on a
  // *probability*, so "the viewer has told us they do not want this" belongs
  // as P(notInterested) ≈ 1, not as a counter somewhere. `Math.max` rather
  // than a product, because the penalty is already the posterior — it should
  // not be diluted by an author looking otherwise fine.
  //
  // Floored by *both* halves of the split (`postPenalty` OR `authorPenalty`):
  // dismissing this exact post is obviously evidence against showing this
  // exact post again, and so is the author being muted outright. What must
  // NOT floor this — see `muteAuthor` below — is the reverse: a mute should
  // not need to be re-litigated per post, but a single dismissed post must
  // not read as "mute the whole author".
  const notInterested = clamp01(Math.max(
    B.notInterested
    * lift(-f.authorAffinity, 4, 0.25)
    // No bot term here. Bot-ness is handled once, as `botPrior` on the
    // positive heads, where it is measured (0.16-0.43x engagement). Having it
    // *also* inflate the negative heads was the same signal counted twice on
    // both sides at once, and it pushed an ordinary never-dismissed bot post
    // below `NEGATIVE_SCORES_OFFSET` — into the band that is supposed to mean
    // "the viewer said no", where ordering is compressed to nothing. Low
    // engagement is a reason to rank a post last; it is not a rejection.
    * lift(f.spamminess, 2.5)
    * (f.sensitive ? 1.2 : 1),
    Math.max(f.postPenalty, f.authorPenalty),
  ))

  // ── muteAuthor ──────────────────────────────────────────────────────────
  // Weight -58.8, the largest negative after report. Muting is about volume:
  // a high-output account flooding your feed.
  //
  // Floored by `authorPenalty` ONLY, never `postPenalty`. This is the fix for
  // the defect where a single dismissed post and a genuine author mute used
  // to produce byte-identical scores: both fed the same undifferentiated
  // `authorPenalty` scalar into `Math.max` here. Muting is a verdict on the
  // *account* (explicit mute, or the decayed weight of dismissals across
  // several of the author's *other* posts via `authorPenaltyIn` — see
  // `AffinityResolver.authorPenalty`); a post-level "not interested" on one
  // post says nothing about the rest of what that author writes and must not
  // force P(muteAuthor) to 1 for it.
  const muteAuthor = clamp01(Math.max(
    B.muteAuthor
    * lift(-f.authorAffinity, 5, 0.2)
    * lift(f.authorVolume, 2)
    // See `notInterested` above: bot-ness lives on the positive heads only.
    // `authorVolume` already carries what muting is actually about here.
    * lift(f.spamminess, 2),
    f.authorPenalty,
  ))

  // ── blockAuthor ─────────────────────────────────────────────────────────
  // Weight -31.2. Blocking is about the account, not the volume: spam shape
  // and unflagged sensitive content.
  const blockAuthor = clamp01(
    B.blockAuthor
    * lift(-f.authorAffinity, 5, 0.2)
    * lift(f.spamminess, 3)
    * (f.sensitive && !f.hasSpoiler ? 2 : 1),
  )

  // ── report ──────────────────────────────────────────────────────────────
  // Weight -234.0, by far the largest magnitude in the table. As the X source
  // comments at length, that is because the *base rate* is ~1000x lower than a
  // like, not because one report outweighs hundreds of likes.
  const report = clamp01(
    B.report
    * lift(-f.authorAffinity, 3, 0.3)
    * lift(f.spamminess, 4)
    * (f.sensitive && !f.hasSpoiler ? 3 : 1),
  )

  // ── notDwelled ──────────────────────────────────────────────────────────
  // Weight -0.02, tiny, but it applies at a ~22% base rate, so it is the
  // negative head that actually fires on ordinary posts. This is the only head
  // where age pushes the probability *up*: a stale post is exactly the one you
  // scroll past. Capped so it can never swamp the sum.
  const notDwelled = clamp(
    B.notDwelled
    * (1 + f.ageHours / 24)
    * lift(-f.authorAffinity, 1.6, 0.6)
    * (f.hasImage || f.hasVideo ? 0.8 : 1)
    * (f.textLength < 40 ? 1.2 : 1),
    0,
    0.95,
  )

  return {
    favorite,
    reply,
    retweet,
    quote,
    share,
    click,
    openLink,
    profileClick,
    photoExpand,
    videoOpen,
    vqv,
    dwell,
    followAuthor,
    notInterested,
    muteAuthor,
    blockAuthor,
    report,
    notDwelled,
  }
}

// #endregion

// #region the weighted sum

/**
 * Per-candidate weights, mirroring `ScoringWeights::effective_head_weights`.
 * Two heads have candidate-dependent weights in X:
 *  - `reply` gets `BidirectionalFollowReplyWeightBoost` on original posts by
 *    mutual follows (`bidirectional_boost_eligible`: not a reply, not a
 *    repost, mutual author);
 *  - `vqv` is zeroed unless the video is longer than `MinVideoDurationMs`
 *    and* the viewer has fewer than `MAX_FOLLOWERS_THRESHOLD` followers
 *    (`candidates_util::vqv_weight`).
 *
 * These are used for the *numerator* only. The `offsetScore` denominator is
 * computed from the base weights, once per request, exactly as X does in
 * `ScoringWeights::from_params` — otherwise a mutual-follow post would be
 * normalised against a different denominator than its neighbours in the same
 * slate.
 */
export function effectiveWeights(
  candidate: PostCandidate,
  ctx: RankingContext,
): Record<keyof ActionProbabilities, number> {
  const base = resolveWeights(ctx)
  const params = resolveParams(ctx)
  const status = contentStatus(candidate)
  const outer = candidate.status

  const bidirectionalEligible
    = !status.inReplyToId
      && !outer.reblog
      && !!ctx.mutualAuthorIds?.has(status.account?.id ?? '')

  const durationMs = videoDurationMs(status)
  const vqvEligible
    = durationMs !== undefined
      && durationMs > MIN_VIDEO_DURATION_MS
      && (ctx.viewerFollowerCount ?? 0) < MAX_FOLLOWERS_THRESHOLD

  if (!bidirectionalEligible && vqvEligible)
    return base

  return {
    ...base,
    reply: bidirectionalEligible ? base.reply + params.bidirectionalFollowReplyWeightBoost : base.reply,
    dwell: bidirectionalEligible ? base.dwell + BIDIRECTIONAL_FOLLOW_DWELL_WEIGHT_BOOST : base.dwell,
    vqv: vqvEligible ? base.vqv : 0,
  }
}

/**
 * `ScoringWeights::from_params` computes `positive_sum`, `negative_sum` and
 * `total_sum` **once per request** from the base params; `offset_score` uses
 * them to map a negative combined score into `(0, NEGATIVE_SCORES_OFFSET)`.
 * See {@link X_WEIGHT_SUMS} for the values over X's full head table.
 */
export interface WeightSums {
  positiveSum: number
  negativeSum: number
  totalSum: number
}

export function weightSums(weights: Record<keyof ActionProbabilities, number>): WeightSums {
  let positiveSum = 0
  let negativeSum = 0
  for (const key of Object.keys(weights) as (keyof ActionProbabilities)[]) {
    const w = weights[key]
    if (w >= 0)
      positiveSum += w
    else
      negativeSum -= w
  }
  return { positiveSum, negativeSum, totalSum: positiveSum + negativeSum }
}

/**
 * `RankingScorer::offset_score`, transcribed exactly:
 *
 * ```rust
 * if w.total_sum == 0.0 { combined.max(0.0) }
 * else if combined < 0.0 { (combined + w.negative_sum) / w.total_sum * NEGATIVE_SCORES_OFFSET }
 * else { combined + NEGATIVE_SCORES_OFFSET }
 * ```
 *
 * Note the shape of the negative branch: it squeezes the entire range
 * `(-negativeSum, 0)` into a band of width `negativeSum/totalSum x 0.001`,
 * which for the real weights is under a thousandth of a point. Everything that
 * lands there is, for practical purposes, unordered. That is fine in X, where
 * it essentially never fires; here the base rates are calibrated to keep
 * ordinary posts out of it (see {@link BASE_RATES}).
 */
export function offsetScore(combined: number, sums: WeightSums): number {
  if (sums.totalSum === 0)
    return Math.max(combined, 0)
  if (combined < 0)
    return (combined + sums.negativeSum) / sums.totalSum * NEGATIVE_SCORES_OFFSET
  return combined + NEGATIVE_SCORES_OFFSET
}

/**
 * The single multiplier carrying every signal that is a property of the
 * situation* rather than of an action: how old the post is, and whether the
 * viewer can read it. Applied once, to the positive part of the sum.
 *
 * The mechanism copies X's MPN scoring path (`ranking_scorer.rs:819-827`),
 * which applies its scalar multiplier the same way — to the net score when the
 * net is non-negative, leaving negatives alone so that decaying a bad post
 * cannot make it look better.
 */
export function contextMultiplier(
  candidate: PostCandidate,
  signals: ForYouSignals,
  ctx: RankingContext,
): number {
  const f = extractRankingFeatures(candidate, signals, ctx)
  return f.freshness * f.languagePrior
}

/** How small a term has to be before it is left out of the debug trace. */
const REASON_EPSILON = 1e-6

/**
 * `Final Score = Σ (weight_i × P(action_i))`, times the context multiplier.
 *
 * Faithful to `RankingScorer::compute_weighted_parts` + `offset_score`: the
 * terms are accumulated into a positive and a negative bucket (by the sign of
 * the *term*, not of the weight), combined as `pos - neg`, scaled by the
 * context multiplier when non-negative, and then offset. Returns a new
 * candidate; the input is not mutated.
 */
export function scoreCandidate(
  candidate: PostCandidate,
  signals: ForYouSignals,
  ctx: RankingContext,
): PostCandidate {
  const features = extractRankingFeatures(candidate, signals, ctx)
  const probabilities = predictActions(candidate, signals, ctx)
  const weights = effectiveWeights(candidate, ctx)
  // Denominator from the *base* weights, once per request, as X does.
  const sums = weightSums(resolveWeights(ctx))

  let pos = 0
  let neg = 0
  const reasons: ScoreReason[] = []

  for (const key of Object.keys(probabilities) as (keyof ActionProbabilities)[]) {
    const term = probabilities[key] * weights[key]
    if (term >= 0)
      pos += term
    else
      neg -= term

    if (Math.abs(term) >= REASON_EPSILON)
      reasons.push({ label: key, value: term })
  }

  reasons.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  const context = features.freshness * features.languagePrior
  const net = pos - neg
  const scaled = net >= 0 ? context * net : net

  reasons.push({ label: 'freshness', value: features.freshness })
  if (features.languagePrior !== 1)
    reasons.push({ label: 'language', value: features.languagePrior })

  return {
    ...candidate,
    probabilities,
    rawScore: offsetScore(scaled, sums),
    reasons,
  }
}

// #endregion

// #region post-scoring adjustments

/**
 * `RankingScorer::diversity_multiplier`:
 * `(1 - floor) * decay^k + floor`, where `k` is how many higher-scoring posts
 * by the same author are already in the slate. With the production values
 * (decay 0.5, floor 0.25) an author's posts are scaled 1.0, 0.625, 0.4375,
 * 0.34…, converging on 0.25 — a demotion, never a removal.
 */
export function diversityMultiplier(k: number, decay: number, floor: number): number {
  return (1 - floor) * decay ** k + floor
}

/**
 * The account author diversity is keyed on: the author of the **content**, not
 * of the boost. On Mastodon boosting is the distribution mechanism, so keying
 * on the booster lets five different people boost the same post and each take
 * a `k = 0` slot — the exact "same post five times" failure that algorithmic
 * feeds are complained about for.
 */
function diversityKey(candidate: PostCandidate): string {
  return contentStatus(candidate).account?.id ?? ''
}

/**
 * `RankingScorer::effective_oon_weight`. Normally `OonWeightFactor` (0.75);
 * for accounts younger than `NewUserAgeThresholdSecs` that already follow at
 * least `NEW_USER_MIN_FOLLOWING` accounts it collapses to
 * `NEW_USER_OON_WEIGHT_FACTOR` (0.00001) — effectively "show new users only
 * what they asked for". The age threshold ships as 0, so this is off by
 * default; it is here because it is real.
 */
export function effectiveOonFactor(ctx: RankingContext): number {
  const params = resolveParams(ctx)
  const isNewUser
    = params.newUserAgeThresholdMs > 0
      && ctx.viewerAccountAgeMs !== undefined
      && ctx.viewerAccountAgeMs < params.newUserAgeThresholdMs
      && (ctx.viewerFollowingCount ?? 0) >= params.newUserMinFollowing
  return isNewUser ? params.newUserOonWeightFactor : params.oonWeightFactor
}

/**
 * `oon_applies` in `RankingScorer::score`: out-of-network posts always, and —
 * because `EnableOonRescoreForInNetworkRepliesRetweets` defaults to true —
 * replies and reposts from accounts the viewer *does* follow as well. That
 * second clause is the one that stops a followed account's reply thread from
 * taking over the feed.
 *
 * This is the **only** place the follow graph enters the score.
 */
export function oonApplies(candidate: PostCandidate, params: RankingParams): boolean {
  if (!candidate.inNetwork)
    return true
  if (!params.oonRescoreInNetworkRepliesReblogs)
    return false
  return !!candidate.status.reblog || !!candidate.status.inReplyToId
}

/** How many impressions we assume each observed interaction implies. */
const IMPRESSIONS_PER_ENGAGEMENT = 25

/**
 * Our stand-in for `view_count`. Mastodon publishes no impression counter, so
 * reach is proxied by the author's follower base (the mechanical source of
 * impressions on Mastodon) plus a multiple of the engagement the post actually
 * collected.
 *
 * The threshold it is compared against is deliberately **not** X's 1000.
 * `ColdStartFollowerCap` is also 1000, so with a threshold of 1000 the
 * follower term alone exhausts the budget: the impression test would be
 * strictly implied by the follower cap, and any small author whose post had
 * started to do well (40 followers + 40 favourites = 1040) would be ruled
 * ineligible — leaving the exploration slot to posts with essentially no
 * engagement, which is random insertion rather than exploration. The default
 * is 5x the follower cap so the engagement term has room to discriminate.
 */
export function impressionProxy(candidate: PostCandidate): number {
  const status = contentStatus(candidate)
  const engagement
    = (status.favouritesCount ?? 0) + (status.reblogsCount ?? 0) + (status.repliesCount ?? 0)
  return (status.account?.followersCount ?? 0) + IMPRESSIONS_PER_ENGAGEMENT * engagement
}

/**
 * `AuthorColdStart::apply` / `apply_cold_start` — the New-Author Boost.
 *
 * Faithful details worth stating, because they are easy to get wrong:
 *  - exactly **one** post per request is lifted, not every eligible post;
 *  - the lift is `max(score, target)`, never additive, so it can only raise;
 *  - the target is the score currently sitting at slot `ColdStartSlotMin`
 *    (15) — with `ColdStartSlotMax` 16 the random range `[15, 16)` is a point,
 *    so this is deterministic;
 *  - if the slate has fewer than 16 scored posts, `lo >= hi` and the whole
 *    adjustment is skipped;
 *  - eligibility is original posts only (no replies, no reposts) by authors
 *    under `ColdStartFollowerCap` (1000) whose current position is inside the
 *    top `LowImpressionsMaxPositionRatio` (0.85) of the non-zero slate.
 *
 * One deliberate deviation: X only applies `ColdStartMaxPostAgeSecs` (24h) in
 * the MoE treatment arm, which has no analogue here. We apply it always,
 * because lifting a 40-hour-old post to slot 15 would undo the recency work
 * the rest of this file does.
 *
 * **A second, load-bearing deviation: the pick among eligible posts.** X's
 * `pick_by_score` takes the *highest-scoring* eligible post. That is sound on
 * X's own scale, where `ColdStartFollowerCap` (1000 followers) is itself a
 * small-account cutoff and the eligible set on any given slate is a genuine
 * handful of small/new accounts — picking the best of a small, already-novel
 * set is a reasonable explore/exploit trade.
 *
 * On Mastodon, 1000 followers is not a small-account cutoff, it is close to
 * "everyone": almost the whole slate clears `coldStartFollowerCap` and
 * `coldStartImpressionThreshold`, so "eligible" stops meaning "novel" and
 * starts meaning "most of the slate". Once that happens, `pick_by_score`
 * degenerates into "give another boost to whichever eligible post already
 * has the most engagement" — the opposite of exploration, and it means a
 * post from a genuinely unseen author (a handful of followers, one or two
 * favourites) loses every time to an established-but-still-small account
 * that simply has more favourites. Reproduction: a 21-post slate of 20
 * in-network filler posts under 1000 followers (which all clear the
 * eligibility bar) plus one truly obscure new author picked the busiest
 * filler, never the obscure author, under `pick_by_score`.
 *
 * We keep the eligibility gates exactly as X calibrated them (follower cap,
 * impression threshold, position-ratio, age) — those still do useful work
 * filtering out large/established/stale/over-exposed accounts — and instead
 * change what "best" means among the posts that pass: the post with the
 * least estimated reach (`impressionProxy`, the same reach estimate the
 * eligibility check itself uses), tie-broken by score. That is the
 * deliberate deviation from X's absolute-threshold-tuned `pick_by_score`:
 * where X can rely on eligibility alone to keep the candidate pool small and
 * genuinely novel, Mastodon's flatter follower distribution means the *pick*
 * has to do the discriminating that eligibility can no longer do — the slot
 * goes to whoever the algorithm has had the least chance to already show the
 * viewer, not to whoever within the (now much larger) eligible pool happens
 * to be doing best.
 */
export function applyNewAuthorBoost(
  candidates: PostCandidate[],
  scores: number[],
  ctx: RankingContext,
): { scores: number[], boostedIndex: number, target: number } {
  const params = resolveParams(ctx)
  const noop = { scores, boostedIndex: -1, target: Number.NaN }
  if (!params.enableNewAuthorBoost)
    return noop

  // cold_start_target: sample from the score at rank [slotMin, slotMax).
  const ranked = [...scores].sort((a, b) => b - a)
  const hi = Math.min(params.coldStartSlotMax, ranked.length)
  const lo = Math.min(params.coldStartSlotMin, hi)
  if (lo >= hi)
    return noop
  const slot = lo + Math.floor(Math.random() * (hi - lo))
  const target = ranked[slot]!

  // positions_among_nonzero: rank only the candidates with a non-zero score.
  const order = scores
    .map((score, index) => ({ score, index }))
    .filter(entry => entry.score !== 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const positions = Array.from<number>({ length: scores.length }).fill(Number.POSITIVE_INFINITY)
  order.forEach((entry, position) => {
    positions[entry.index] = position
  })
  const maxSlot = params.coldStartMaxPositionRatio * order.length

  // pick_by_score, recalibrated for Mastodon's flatter follower distribution
  // (see the "second, load-bearing deviation" note above): among the
  // eligible posts, prefer the one with the *least* estimated reach rather
  // than the highest score, so the slot actually explores instead of just
  // re-confirming whichever eligible post is already doing best. Tie-broken
  // by score — X's own criterion — because equally-unseen posts still
  // deserve the more promising one to be lifted.
  let bestIndex = -1
  let bestExposure = Number.POSITIVE_INFINITY
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    const status = contentStatus(candidate)
    const followers = status.account?.followersCount ?? 0
    const exposure = impressionProxy(candidate)

    const eligible
      = !status.inReplyToId
        && !candidate.status.reblog
        && followers <= params.coldStartFollowerCap
        && contentAgeMs(candidate, ctx.now) <= params.coldStartMaxPostAgeMs
        && positions[i]! < maxSlot
        && exposure < params.coldStartImpressionThreshold

    if (!eligible)
      continue
    if (
      bestIndex === -1
      || exposure < bestExposure
      || (exposure === bestExposure && scores[i]! > scores[bestIndex]!)
    ) {
      bestIndex = i
      bestExposure = exposure
    }
  }

  if (bestIndex === -1)
    return noop

  const next = [...scores]
  next[bestIndex] = Math.max(next[bestIndex]!, target)
  return { scores: next, boostedIndex: bestIndex, target }
}

/**
 * The three post-scoring adjustments, in X's order (`RankingScorer::score`,
 * the non-MPN path, which is the production default since `EnableMpnScoring`
 * ships false):
 *
 *   1. **New-Author Boost** — `author_cold_start.apply(weighted_scores)`
 *   2. **Author Diversity** — slate contexts are computed from the
 *      cold-start-adjusted scores, then `score * ((1-floor)*decay^k + floor)`
 *   3. **Out-of-Network Discount** — `score * oon_factor` where it applies
 *
 * Reads `rawScore` and writes `score`; returns new candidate objects in the
 * input order (sorting is `rankCandidates`' job).
 */
export function applyAdjustments(candidates: PostCandidate[], ctx: RankingContext): PostCandidate[] {
  const params = resolveParams(ctx)
  const oonFactor = effectiveOonFactor(ctx)
  const base = candidates.map(c => c.rawScore ?? 0)

  // 1. new-author boost
  const boost = applyNewAuthorBoost(candidates, base, ctx)
  const adjusted = boost.scores

  // 2. author diversity — `compute_slate_contexts` walks the slate in
  //    descending score order and gives each post `k` = how many posts by the
  //    same author it has already passed.
  const multipliers = Array.from<number>({ length: candidates.length }).fill(1)
  if (params.enableAuthorDiversity) {
    const order = adjusted
      .map((score, index) => ({ score, index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const seen = new Map<string, number>()
    for (const entry of order) {
      const authorId = diversityKey(candidates[entry.index]!)
      const k = seen.get(authorId) ?? 0
      multipliers[entry.index] = diversityMultiplier(
        k,
        params.authorDiversityDecay,
        params.authorDiversityFloor,
      )
      seen.set(authorId, k + 1)
    }
  }

  return candidates.map((candidate, i) => {
    const reasons = candidate.reasons ? [...candidate.reasons] : []

    if (boost.boostedIndex === i)
      reasons.push({ label: 'newAuthorBoost', value: boost.target })

    let score = adjusted[i]! * multipliers[i]!
    if (multipliers[i] !== 1)
      reasons.push({ label: 'authorDiversity', value: multipliers[i]! })

    // 3. out-of-network discount
    if (oonApplies(candidate, params)) {
      score *= oonFactor
      reasons.push({ label: 'outOfNetwork', value: oonFactor })
    }

    return { ...candidate, score, reasons }
  })
}

// #endregion

// #region pipeline

/**
 * The whole heavy-ranking pipeline: predict → weighted sum → three
 * adjustments → sort. Returns a new array, highest score first, with ties
 * broken by status id descending (newer first) so the order is stable.
 */
export function rankCandidates(
  candidates: PostCandidate[],
  signals: ForYouSignals,
  ctx: RankingContext,
): PostCandidate[] {
  const scored = candidates.map(candidate => scoreCandidate(candidate, signals, ctx))
  const adjusted = applyAdjustments(scored, ctx)
  return adjusted.sort((a, b) => {
    const delta = (b.score ?? 0) - (a.score ?? 0)
    if (delta !== 0)
      return delta
    return b.status.id.localeCompare(a.status.id)
  })
}

// #endregion

/**
 * ## Where this model is weakest versus Phoenix
 *
 * 1. **No collaborative signal.** Phoenix knows that people who engaged like
 *    you also engaged with this post. We have no cross-user graph at all: our
 *    only personalization is the viewer's own history. A brand new Elk user
 *    gets a model with every affinity term at 0, i.e. pure popularity plus
 *    recency.
 * 2. **Counts, not predictions.** Phoenix predicts *your* P(favorite);
 *    `engagementSignal` is other people's realised favourites, which is a
 *    popularity prior wearing a probability's clothes. It cannot distinguish
 *    "widely liked" from "liked by people like you", so the feed has a
 *    structural pull towards consensus content.
 * 3. **Federation under-counting is unmodelled.** A remote post's counts are
 *    only the subset the viewer's instance federated, and the size of that
 *    subset depends on who on that instance follows whom. A single-user
 *    instance may see 1 favourite where there are 200. This systematically
 *    under-ranks out-of-network content, and it is *not* fixable with a
 *    constant multiplier — the error is additive and its magnitude is
 *    anti-correlated with what a constant would do. A real fix needs a
 *    per-instance coverage estimate the API does not expose.
 * 4. **Three heads are guesses.** `share`, `dwell` and `profileClick` have no
 *    Mastodon observable behind them at all — they are priors shaped by
 *    content type. (Two of the three carry weight 0.0 in production, which
 *    limits the damage.)
 * 5. **The negative heads are unvalidated.** Nobody has ever measured
 *    P(report | post) on Mastodon. Their base rates set the balance against
 *    -234.0 and -58.8, and — because `offsetScore`'s negative branch is a
 *    near-flat floor — getting them too high does not merely mis-score a post,
 *    it removes it from the ordering entirely. They are set low deliberately.
 * 6. **No calibration.** Phoenix's outputs are calibrated probabilities, so
 *    the weights mean what they say. Ours are multiplicative fictions clamped
 *    to [0, 1]; the *ordering* they produce is the useful part, the absolute
 *    numbers are not.
 * 7. **The lift coefficients are hand-set.** Every `lift(x, k)` in this file
 *    is a judgement call. They are at least all judgements about signals we
 *    can actually see, and the pipeline-level signals (follow graph,
 *    freshness, language) are each applied exactly once so they can be tuned
 *    in one place — but none of them has been fit to anything.
 */
