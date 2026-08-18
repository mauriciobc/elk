import type { mastodon } from 'masto'
import type { RankingContext } from '../../app/composables/for-you/ranking'
import type { ActionProbabilities, ForYouSignals, PostCandidate } from '../../app/composables/for-you/types'
import { describe, expect, it } from 'vitest'
import {
  affinitySignal,
  applyAdjustments,
  applyNewAuthorBoost,
  BASE_RATES,
  contextMultiplier,
  DEFAULT_RANKING_PARAMS,
  defaultAffinityResolver,
  diversityMultiplier,
  effectiveOonFactor,
  effectiveWeights,
  extractRankingFeatures,
  impressionProxy,
  lift,
  logNorm,
  MAX_FOLLOWERS_THRESHOLD,
  MAX_POST_AGE_MS,
  NEGATIVE_SCORES_OFFSET,
  offsetScore,
  oonApplies,
  predictActions,
  rankCandidates,
  recencyMultiplier,
  scoreCandidate,
  weightSums,
  X_WEIGHT_SUMS,
  X_WEIGHTS,
} from '../../app/composables/for-you/ranking'
import { EMPTY_SIGNALS } from '../../app/composables/for-you/types'

const NOW = Date.parse('2026-08-16T12:00:00.000Z')
const HOUR = 3_600_000

const ACTION_KEYS = Object.keys(X_WEIGHTS) as (keyof ActionProbabilities)[]

interface StatusOptions {
  id?: string
  authorId?: string
  acct?: string
  ageMs?: number
  favourites?: number
  reblogs?: number
  replies?: number
  content?: string
  language?: string | null
  followers?: number
  following?: number
  statuses?: number
  bot?: boolean
  verified?: boolean
  note?: string
  inReplyToId?: string | null
  spoilerText?: string
  sensitive?: boolean
  tags?: string[]
  card?: boolean
  cardImage?: boolean
  images?: number
  videoDurationSecs?: number
  poll?: boolean
}

function makeStatus(options: StatusOptions = {}): mastodon.v1.Status {
  const {
    id = 's1',
    authorId = 'a1',
    acct = 'alice',
    ageMs = HOUR,
    favourites = 0,
    reblogs = 0,
    replies = 0,
    content = '<p>hello world</p>',
    language = 'en',
    followers = 200,
    following = 200,
    statuses = 500,
    bot = false,
    verified = false,
    note = '<p>bio</p>',
    inReplyToId = null,
    spoilerText = '',
    sensitive = false,
    tags = [],
    card = false,
    cardImage = false,
    images = 0,
    videoDurationSecs,
    poll = false,
  } = options

  const mediaAttachments: mastodon.v1.MediaAttachment[] = []
  for (let i = 0; i < images; i++) {
    mediaAttachments.push({
      id: `m${i}`,
      type: 'image',
      previewUrl: '',
      meta: { original: { width: 100, height: 100, size: '100x100', aspect: 1 } },
    } as mastodon.v1.MediaAttachment)
  }
  if (videoDurationSecs !== undefined) {
    mediaAttachments.push({
      id: 'v0',
      type: 'video',
      previewUrl: '',
      meta: {
        original: {
          width: 100,
          height: 100,
          frameRate: '30',
          duration: videoDurationSecs,
          bitrate: 1000,
          aspect: 1,
        },
      },
    } as mastodon.v1.MediaAttachment)
  }

  return {
    id,
    createdAt: new Date(NOW - ageMs).toISOString(),
    content,
    language,
    favouritesCount: favourites,
    reblogsCount: reblogs,
    repliesCount: replies,
    inReplyToId,
    inReplyToAccountId: null,
    spoilerText,
    sensitive,
    mediaAttachments,
    tags: tags.map(name => ({ name, url: '' })),
    card: card ? ({ image: cardImage ? 'https://img' : null } as mastodon.v1.PreviewCard) : null,
    poll: poll ? ({ id: 'p1' } as mastodon.v1.Poll) : null,
    reblog: null,
    account: {
      id: authorId,
      acct,
      username: acct.split('@')[0],
      note,
      bot,
      followersCount: followers,
      followingCount: following,
      statusesCount: statuses,
      fields: verified ? [{ name: 'web', value: '', verifiedAt: '2024-01-01T00:00:00Z' }] : [],
    } as mastodon.v1.Account,
  } as mastodon.v1.Status
}

type CandidateOptions = StatusOptions & { inNetwork?: boolean, boostOf?: StatusOptions }

function makeCandidate(options: CandidateOptions = {}): PostCandidate {
  const { inNetwork = true, boostOf, ...statusOptions } = options
  let status = makeStatus(statusOptions)
  if (boostOf) {
    status = {
      ...status,
      content: '',
      reblog: makeStatus(boostOf),
    } as mastodon.v1.Status
  }
  return {
    status,
    sources: new Set(['home'] as const),
    inNetwork,
  }
}

function ctx(overrides: Partial<RankingContext> = {}): RankingContext {
  return { now: NOW, viewerLanguages: ['en'], ...overrides }
}

function signals(overrides: Partial<ForYouSignals> = {}): ForYouSignals {
  return { ...EMPTY_SIGNALS, ...overrides }
}

/** A candidate carrying a pre-set rawScore, for testing the adjustments alone. */
function preScored(rawScore: number, options: CandidateOptions = {}): PostCandidate {
  return { ...makeCandidate(options), rawScore }
}

function raw(candidate: PostCandidate, s: ForYouSignals = signals(), c: RankingContext = ctx()): number {
  return scoreCandidate(candidate, s, c).rawScore!
}

function final(candidate: PostCandidate, s: ForYouSignals = signals(), c: RankingContext = ctx()): number {
  return rankCandidates([candidate], s, c)[0]!.score!
}

/** Zero every weight, so a test can isolate one head. */
function onlyWeights(overrides: Partial<Record<keyof ActionProbabilities, number>>) {
  const zeroed = Object.fromEntries(ACTION_KEYS.map(k => [k, 0])) as Record<keyof ActionProbabilities, number>
  return { ...zeroed, ...overrides }
}

// ───────────────────────────────────────────────────────────────  weights ──

describe('x_WEIGHTS', () => {
  it('matches the production defaults in home-mixer/params/param.rs', () => {
    expect(X_WEIGHTS).toEqual({
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
    })
  })

  it('covers exactly the keys of ActionProbabilities', () => {
    const probabilities = predictActions(makeCandidate(), signals(), ctx())
    expect(Object.keys(probabilities).sort()).toEqual([...ACTION_KEYS].sort())
  })
})

describe('weightSums', () => {
  it('splits by sign the way ScoringWeights::from_params does', () => {
    const sums = weightSums(X_WEIGHTS)
    // 0.5 + 5 + 1 + 5 + 2 + 0.4 + 0.2 + 0 + 0.05 + 0.05 + 0.05 + 0 + 4
    expect(sums.positiveSum).toBeCloseTo(18.25, 10)
    // -(-43.2 + -58.8 + -31.2 + -234 + -0.02)
    expect(sums.negativeSum).toBeCloseTo(367.22, 10)
    expect(sums.totalSum).toBeCloseTo(385.47, 10)
  })

  it('is NOT X\'s own sums — those cover heads we do not model', () => {
    // X's full table adds share_via_dm 5.0, share_via_copy_link 20.0,
    // quoted_click 0.05, quoted_vqv 0.0 and post_unexplored 0.02.
    expect(X_WEIGHT_SUMS).toEqual({ positiveSum: 43.32, negativeSum: 367.22, totalSum: 410.54 })
    expect(X_WEIGHT_SUMS.positiveSum).not.toBeCloseTo(weightSums(X_WEIGHTS).positiveSum, 6)
    expect(X_WEIGHT_SUMS.negativeSum).toBeCloseTo(weightSums(X_WEIGHTS).negativeSum, 10)
  })
})

describe('offsetScore', () => {
  const sums = weightSums(X_WEIGHTS)

  it('adds the offset to a non-negative combined score', () => {
    expect(offsetScore(2, sums)).toBeCloseTo(2 + NEGATIVE_SCORES_OFFSET, 12)
    expect(offsetScore(0, sums)).toBeCloseTo(NEGATIVE_SCORES_OFFSET, 12)
  })

  it('maps a negative combined score into (0, offset)', () => {
    const scored = offsetScore(-10, sums)
    expect(scored).toBeCloseTo((-10 + sums.negativeSum) / sums.totalSum * NEGATIVE_SCORES_OFFSET, 12)
    expect(scored).toBeGreaterThan(0)
    expect(scored).toBeLessThan(NEGATIVE_SCORES_OFFSET)
  })

  it('is monotonic across the sign boundary', () => {
    expect(offsetScore(-1, sums)).toBeLessThan(offsetScore(0, sums))
    expect(offsetScore(-2, sums)).toBeLessThan(offsetScore(-1, sums))
  })

  it('clamps at zero when every weight is zero', () => {
    const zero = { positiveSum: 0, negativeSum: 0, totalSum: 0 }
    expect(offsetScore(-5, zero)).toBe(0)
    expect(offsetScore(5, zero)).toBe(5)
  })
})

// ───────────────────────────────────  the follow graph enters exactly once ──

describe('the follow graph is applied exactly once', () => {
  /**
   * The regression this guards is the whole reason the estimator layer was
   * rewritten: reading `inNetwork` in nine heads *and* applying X's 0.75
   * discount on top stacked the follow graph to a 2.77x in-network advantage,
   * which no amount of engagement could overcome.
   */
  it('predicts identical probabilities in and out of network, except followAuthor', () => {
    const options: CandidateOptions = { favourites: 120, reblogs: 30, replies: 12, images: 1, card: true }
    const inNet = predictActions(makeCandidate({ ...options, inNetwork: true }), signals(), ctx())
    const outNet = predictActions(makeCandidate({ ...options, inNetwork: false }), signals(), ctx())

    for (const key of ACTION_KEYS) {
      if (key === 'followAuthor')
        continue
      expect(inNet[key], key).toBeCloseTo(outNet[key], 12)
    }

    // followAuthor is the one legitimate exception: you cannot follow an
    // account you already follow.
    expect(inNet.followAuthor).toBe(0)
    expect(outNet.followAuthor).toBeGreaterThan(0)
  })

  it('gives in-network at most the 1/0.75 = 1.33x advantage the discount implies', () => {
    const options: CandidateOptions = { favourites: 80, replies: 6 }
    const inNet = final(makeCandidate({ ...options, inNetwork: true }))
    const outNet = final(makeCandidate({ ...options, inNetwork: false }))
    // followAuthor only fires out of network, so the gap is a little *under*
    // 1.33x — it must never be above it.
    expect(inNet / outNet).toBeLessThanOrEqual(1 / DEFAULT_RANKING_PARAMS.oonWeightFactor + 1e-9)
    expect(inNet / outNet).toBeGreaterThan(1)
  })

  it('lets an excellent out-of-network post outrank a mediocre in-network one', () => {
    // The exact comparison the review measured. Before the estimator rewrite
    // the banger scored 0.06274 and lost to the mediocre post's 0.09691.
    const banger = makeCandidate({
      id: 'oon',
      authorId: 'B',
      inNetwork: false,
      favourites: 240,
      reblogs: 80,
      replies: 30,
      ageMs: 2 * HOUR,
      followers: 5000,
    })
    const mediocre = makeCandidate({ id: 'in', authorId: 'A', inNetwork: true, favourites: 3, ageMs: HOUR })
    const oneReply = makeCandidate({ id: 'in2', authorId: 'C', inNetwork: true, replies: 1, ageMs: HOUR })

    expect(final(banger)).toBeGreaterThan(final(mediocre) * 1.5)
    expect(final(banger)).toBeGreaterThan(final(oneReply) * 1.5)
    expect(rankCandidates([mediocre, oneReply, banger], signals(), ctx())[0]!.status.id).toBe('oon')
  })

  it('has no out-of-network ceiling — more engagement keeps helping', () => {
    const at = (favourites: number) =>
      final(makeCandidate({ inNetwork: false, favourites, ageMs: 2 * HOUR }))

    const ladder = [1_000, 10_000, 100_000, 1_000_000].map(at)
    for (let i = 1; i < ladder.length; i++)
      expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!)

    // and the ceiling clears an unengaging in-network post by a wide margin
    const dullFollowed = final(makeCandidate({ inNetwork: true, favourites: 0, ageMs: HOUR }))
    expect(ladder[0]!).toBeGreaterThan(dullFollowed)
    expect(ladder[3]! / dullFollowed).toBeGreaterThan(3)
  })
})

// ─────────────────────────────────────────────────────────── weighted sum ──

describe('scoreCandidate — the weighted sum', () => {
  it('is exactly the sum of one head when the other weights are zeroed', () => {
    const context = ctx({ weights: onlyWeights({ favorite: 1 }) })
    const candidate = makeCandidate({ favourites: 40, ageMs: 0 })

    const scored = scoreCandidate(candidate, signals(), context)
    expect(scored.probabilities).toBeDefined()
    // freshness is 1 at age 0 and the language prior is 1, so the context
    // multiplier drops out and the raw score is the bare term.
    expect(contextMultiplier(candidate, signals(), context)).toBeCloseTo(1, 10)
    expect(scored.rawScore).toBeCloseTo(scored.probabilities!.favorite + NEGATIVE_SCORES_OFFSET, 12)
  })

  it('adds two heads linearly', () => {
    const context = ctx({ weights: onlyWeights({ favorite: 2, reply: 3 }) })
    const candidate = makeCandidate({ favourites: 40, replies: 10, ageMs: 0 })

    const scored = scoreCandidate(candidate, signals(), context)
    const p = scored.probabilities!
    expect(scored.rawScore).toBeCloseTo(2 * p.favorite + 3 * p.reply + NEGATIVE_SCORES_OFFSET, 12)
  })

  it('takes the negative branch when only a negative weight is active', () => {
    const context = ctx({ weights: onlyWeights({ report: -234 }) })
    const candidate = makeCandidate({ inNetwork: false })

    const scored = scoreCandidate(candidate, signals(), context)
    const combined = -234 * scored.probabilities!.report
    expect(combined).toBeLessThan(0)
    // the denominator comes from the resolved base weights for this request
    const sums = weightSums(onlyWeights({ report: -234 }))
    expect(scored.rawScore).toBeCloseTo(offsetScore(combined, sums), 12)
    expect(scored.rawScore!).toBeLessThan(NEGATIVE_SCORES_OFFSET)
  })

  it('normalises every candidate against the same denominator', () => {
    // X computes the sums once per request from the base params. If they were
    // computed from `effectiveWeights`, a mutual-follow post (reply weight
    // 5 + 15) would be divided by a different total than its neighbours.
    const mutuals = new Set(['a1'])
    const candidate = makeCandidate({ authorId: 'a1', inNetwork: false })
    const withBoost = scoreCandidate(candidate, signals(), ctx({ mutualAuthorIds: mutuals }))
    const without = scoreCandidate(candidate, signals(), ctx())

    const sums = weightSums(X_WEIGHTS)
    const context = contextMultiplier(candidate, signals(), ctx())
    for (const scored of [withBoost, without]) {
      const weights = effectiveWeights(candidate, ctx({ mutualAuthorIds: scored === withBoost ? mutuals : undefined }))
      let pos = 0
      let neg = 0
      for (const key of ACTION_KEYS) {
        const term = scored.probabilities![key] * weights[key]
        if (term >= 0)
          pos += term
        else
          neg -= term
      }
      const net = pos - neg
      expect(scored.rawScore).toBeCloseTo(offsetScore(net >= 0 ? context * net : net, sums), 12)
    }
    expect(withBoost.rawScore!).toBeGreaterThan(without.rawScore!)
  })

  it('collapses to zero when every weight is zero', () => {
    const scored = scoreCandidate(makeCandidate(), signals(), ctx({ weights: onlyWeights({}) }))
    expect(scored.rawScore).toBe(0)
  })

  it('does not mutate its input', () => {
    const candidate = makeCandidate()
    const scored = scoreCandidate(candidate, signals(), ctx())
    expect(candidate.rawScore).toBeUndefined()
    expect(candidate.probabilities).toBeUndefined()
    expect(scored).not.toBe(candidate)
  })

  it('records a reason per contributing head plus the context multipliers', () => {
    const scored = scoreCandidate(makeCandidate({ favourites: 50 }), signals(), ctx())
    const labels = scored.reasons!.map(r => r.label)
    expect(labels).toContain('favorite')
    expect(labels).toContain('reply')
    expect(labels).toContain('freshness')

    const contributions = scored.reasons!.filter(r => r.label !== 'freshness' && r.label !== 'language')
    for (let i = 1; i < contributions.length; i++)
      expect(Math.abs(contributions[i - 1]!.value)).toBeGreaterThanOrEqual(Math.abs(contributions[i]!.value))
  })
})

describe('effectiveWeights', () => {
  it('adds the bidirectional-follow reply boost only for mutual original posts', () => {
    const mutuals = new Set(['a1'])
    const original = makeCandidate({ authorId: 'a1' })
    expect(effectiveWeights(original, ctx({ mutualAuthorIds: mutuals })).reply).toBeCloseTo(5 + 15, 10)

    const reply = makeCandidate({ authorId: 'a1', inReplyToId: 'x' })
    expect(effectiveWeights(reply, ctx({ mutualAuthorIds: mutuals })).reply).toBeCloseTo(5, 10)

    const boost = makeCandidate({ authorId: 'a1', boostOf: { authorId: 'a1' } })
    expect(effectiveWeights(boost, ctx({ mutualAuthorIds: mutuals })).reply).toBeCloseTo(5, 10)

    const stranger = makeCandidate({ authorId: 'a9' })
    expect(effectiveWeights(stranger, ctx({ mutualAuthorIds: mutuals })).reply).toBeCloseTo(5, 10)
  })

  it('zeroes the vqv weight below MinVideoDurationMs', () => {
    expect(effectiveWeights(makeCandidate(), ctx()).vqv).toBe(0)
    expect(effectiveWeights(makeCandidate({ videoDurationSecs: 5 }), ctx()).vqv).toBe(0)
    expect(effectiveWeights(makeCandidate({ videoDurationSecs: 30 }), ctx()).vqv).toBeCloseTo(0.05, 10)
  })

  it('zeroes the vqv weight for viewers at or above MAX_FOLLOWERS_THRESHOLD', () => {
    const video = makeCandidate({ videoDurationSecs: 30 })
    expect(effectiveWeights(video, ctx({ viewerFollowerCount: MAX_FOLLOWERS_THRESHOLD - 1 })).vqv).toBeCloseTo(0.05, 10)
    expect(effectiveWeights(video, ctx({ viewerFollowerCount: MAX_FOLLOWERS_THRESHOLD })).vqv).toBe(0)
  })
})

// ────────────────────────────────────────── heavy-tail normalization ──

describe('logNorm — heavy-tail normalization', () => {
  it('is zero at zero and saturates at one', () => {
    expect(logNorm(0, 300)).toBe(0)
    expect(logNorm(-5, 300)).toBe(0)
    expect(logNorm(300, 300)).toBeCloseTo(1, 10)
    expect(logNorm(30_000, 300)).toBe(1)
  })

  it('is monotonically increasing', () => {
    let previous = 0
    for (const n of [1, 2, 5, 10, 50, 100, 299]) {
      const value = logNorm(n, 300)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('has strongly diminishing returns — the point of the transform', () => {
    const lowStep = logNorm(10, 10_000) - logNorm(0, 10_000)
    const highStep = logNorm(1010, 10_000) - logNorm(1000, 10_000)
    expect(lowStep).toBeGreaterThan(highStep * 100)
  })
})

describe('engagement keeps discriminating across the whole corpus', () => {
  const at = (favourites: number) => raw(makeCandidate({ favourites, ageMs: 2 * HOUR }))

  it('still separates 300 from 3,000 from 300,000', () => {
    // The failure this guards: a saturation point in the middle of the corpus
    // clipped everything interesting to 1.0, so on a busy instance engagement
    // dropped out of the ordering completely and the feed degenerated into
    // reverse-chron with a follow-graph tiebreak.
    expect(at(3_000)).toBeGreaterThan(at(300) * 1.1)
    expect(at(300_000)).toBeGreaterThan(at(3_000) * 1.1)
  })

  it('is strictly increasing over five orders of magnitude', () => {
    const ladder = [0, 3, 30, 300, 3_000, 30_000, 300_000].map(at)
    for (let i = 1; i < ladder.length; i++)
      expect(ladder[i]!, `step ${i}`).toBeGreaterThan(ladder[i - 1]!)
  })

  it('still has strongly diminishing returns', () => {
    expect(at(30) - at(0)).toBeGreaterThan(at(300_000) - at(30_000))
  })

  it('treats local and remote counts identically', () => {
    // A previous revision multiplied remote counts by a constant to "correct"
    // federation under-counting. Wrong functional form — see the comment in
    // extractRankingFeatures.
    const local = raw(makeCandidate({ acct: 'alice', favourites: 30 }))
    const remote = raw(makeCandidate({ acct: 'alice@remote.example', favourites: 30 }))
    expect(remote).toBeCloseTo(local, 12)
  })
})

// ───────────────────────────────────────────────────────────────  recency ──

describe('recencyMultiplier', () => {
  it('is 1 for a brand new post', () => {
    expect(recencyMultiplier(0)).toBeCloseTo(1, 10)
  })

  it('halves the above-floor part every half-life', () => {
    const floor = DEFAULT_RANKING_PARAMS.recencyFloor
    const halfLife = DEFAULT_RANKING_PARAMS.recencyHalfLifeMs
    expect(recencyMultiplier(halfLife) - floor).toBeCloseTo((1 - floor) * 0.5, 10)
    expect(recencyMultiplier(2 * halfLife) - floor).toBeCloseTo((1 - floor) * 0.25, 10)
  })

  it('decreases strictly across the whole 48h window', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let h = 0; h <= 48; h += 2) {
      const value = recencyMultiplier(h * HOUR)
      expect(value).toBeLessThan(previous)
      previous = value
    }
  })

  it('is zero past the 48h AgeFilter cap', () => {
    expect(recencyMultiplier(MAX_POST_AGE_MS)).toBeGreaterThan(0)
    expect(recencyMultiplier(MAX_POST_AGE_MS + 1)).toBe(0)
  })

  it('treats a future-dated post as brand new rather than blowing up', () => {
    expect(recencyMultiplier(-HOUR)).toBeCloseTo(1, 10)
  })
})

describe('recency is one multiplier, not a per-head factor', () => {
  it('scales the positive sum by exactly the freshness ratio', () => {
    // Two things are zeroed to isolate the multiplier: `notDwelled`, the one
    // head that legitimately varies with age, and engagement, because
    // `velocity` is engagement *per hour* and so also moves with age by
    // design. What is left must differ by exactly the freshness ratio.
    const context = ctx({ weights: { notDwelled: 0 } })
    const fresh = raw(makeCandidate({ favourites: 0, ageMs: 0 }), signals(), context) - NEGATIVE_SCORES_OFFSET
    const older = raw(makeCandidate({ favourites: 0, ageMs: 12 * HOUR }), signals(), context) - NEGATIVE_SCORES_OFFSET

    expect(older / fresh).toBeCloseTo(recencyMultiplier(12 * HOUR), 9)
  })

  it('puts freshness and the language prior in the context multiplier', () => {
    const candidate = makeCandidate({ ageMs: 12 * HOUR, language: 'ja' })
    expect(contextMultiplier(candidate, signals(), ctx())).toBeCloseTo(
      recencyMultiplier(12 * HOUR) * DEFAULT_RANKING_PARAMS.languageMismatchPrior,
      12,
    )
  })

  it('is beatable — engagement can win against an eight-hour age gap', () => {
    // The failure this guards: freshness multiplied into every positive head
    // while every head's engagement input was clipped, so NO engagement value
    // could ever beat a six-hour gap. A For You feed whose best post from this
    // morning can never surface has no reason to exist.
    expect(raw(makeCandidate({ favourites: 300, ageMs: 8 * HOUR })))
      .toBeGreaterThan(raw(makeCandidate({ favourites: 3, ageMs: 0 })))
    expect(raw(makeCandidate({ favourites: 3_000, ageMs: 6 * HOUR })))
      .toBeGreaterThan(raw(makeCandidate({ favourites: 2, ageMs: 0 })))
  })

  it('still keeps a day-and-a-half-old hit from beating a fresh post', () => {
    expect(raw(makeCandidate({ favourites: 3_000, ageMs: 40 * HOUR })))
      .toBeLessThan(raw(makeCandidate({ favourites: 3, ageMs: 0 })))
  })

  it('orders identical posts newest first', () => {
    const candidates = [36, 24, 12, 1].map(h =>
      makeCandidate({ id: `h${h}`, authorId: `a${h}`, ageMs: h * HOUR, favourites: 40 }),
    )
    expect(rankCandidates(candidates, signals(), ctx()).map(c => c.status.id))
      .toEqual(['h1', 'h12', 'h24', 'h36'])
  })

  it('drives a post past the 48h cap to the offset floor', () => {
    const expired = makeCandidate({ id: 'expired', authorId: 'a2', ageMs: 50 * HOUR, favourites: 5000, reblogs: 900 })
    const ordinary = makeCandidate({ id: 'ordinary', authorId: 'a1', ageMs: 20 * HOUR, favourites: 1 })

    const ranked = rankCandidates([expired, ordinary], signals(), ctx())
    expect(ranked[0]!.status.id).toBe('ordinary')
    expect(ranked[1]!.score!).toBeLessThanOrEqual(NEGATIVE_SCORES_OFFSET)
  })

  it('raises notDwelled with age — the one head age legitimately touches', () => {
    // At zero engagement the `velocity` term — engagement per hour, which
    // moves with age by design — drops out, so any remaining difference would
    // be a stray freshness factor inside a head.
    const fresh = predictActions(makeCandidate({ ageMs: HOUR, favourites: 0 }), signals(), ctx())
    const old = predictActions(makeCandidate({ ageMs: 36 * HOUR, favourites: 0 }), signals(), ctx())

    expect(old.notDwelled).toBeGreaterThan(fresh.notDwelled)
    for (const key of ACTION_KEYS) {
      if (key !== 'notDwelled')
        expect(old[key], key).toBeCloseTo(fresh[key], 12)
    }
  })
})

// ────────────────────────────────────────────────────────────── language ──

describe('language is a mild prior applied once', () => {
  it('costs well under 2x, not two orders of magnitude', () => {
    // `status.language` is set by the posting client and is often wrong. A
    // previous revision compounded a 0.25 factor across seven positive heads
    // and tripled notInterested, so one mislabelled field cost 102x.
    const readable = raw(makeCandidate({ favourites: 30, language: 'en' }))
    const foreign = raw(makeCandidate({ favourites: 30, language: 'ja' }))
    expect(foreign).toBeLessThan(readable)
    expect(readable / foreign).toBeLessThan(2)
  })

  it('is exactly the configured prior on the positive sum', () => {
    const context = ctx({ weights: { notDwelled: 0 } })
    const readable = raw(makeCandidate({ favourites: 30, language: 'en', ageMs: 0 }), signals(), context) - NEGATIVE_SCORES_OFFSET
    const foreign = raw(makeCandidate({ favourites: 30, language: 'ja', ageMs: 0 }), signals(), context) - NEGATIVE_SCORES_OFFSET
    expect(foreign / readable).toBeCloseTo(DEFAULT_RANKING_PARAMS.languageMismatchPrior, 9)
  })

  it('is lifted away by the viewer\'s own history', () => {
    const foreign = raw(makeCandidate({ favourites: 30, language: 'ja' }))
    const learned = raw(makeCandidate({ favourites: 30, language: 'ja' }), signals({ languageAffinity: { ja: 5 } }))
    expect(learned).toBeGreaterThan(foreign)
  })

  it('does not also inflate notInterested', () => {
    const readable = predictActions(makeCandidate({ language: 'en' }), signals(), ctx())
    const foreign = predictActions(makeCandidate({ language: 'ja' }), signals(), ctx())
    expect(foreign.notInterested).toBeCloseTo(readable.notInterested, 12)
  })
})

// ─────────────────────────────────────────────────────  the negative band ──

describe('the negative band stays ordered and stays empty of ordinary posts', () => {
  const penaltyCtx = (map: Record<string, number>) =>
    ctx({ affinity: { authorPenalty: (id: string) => map[id] ?? 0 } })

  it('keeps a realistic slate entirely off the floor', () => {
    // The failure this guards: 3 of 12 posts in a realistic slate landed in
    // offsetScore's negative branch, which squeezes everything below zero into
    // a band 0.14% wide — ordering destroyed, ties broken by status id.
    const slate = [
      makeCandidate({ id: 'p1', authorId: 'a', ageMs: 0.5 * HOUR }),
      makeCandidate({ id: 'p2', authorId: 'b', favourites: 2 }),
      makeCandidate({ id: 'p3', authorId: 'c', replies: 1, ageMs: 3 * HOUR }),
      makeCandidate({ id: 'p4', authorId: 'd', favourites: 12, reblogs: 3, ageMs: 5 * HOUR }),
      makeCandidate({ id: 'p5', authorId: 'e', inNetwork: false, favourites: 240, reblogs: 80, replies: 30, ageMs: 2 * HOUR }),
      makeCandidate({ id: 'p6', authorId: 'f', inNetwork: false, favourites: 1, ageMs: 9 * HOUR }),
      makeCandidate({ id: 'p7', authorId: 'g', bot: true, ageMs: 20 * HOUR }),
      makeCandidate({ id: 'p8', authorId: 'h', inNetwork: false, favourites: 5, ageMs: 30 * HOUR, language: 'de' }),
      makeCandidate({ id: 'p9', authorId: 'i', favourites: 40, replies: 8, ageMs: 7 * HOUR }),
      makeCandidate({ id: 'p10', authorId: 'j', inNetwork: false, followers: 5, following: 4000, note: '' }),
      makeCandidate({ id: 'p11', authorId: 'k', favourites: 900, reblogs: 200, ageMs: 26 * HOUR }),
      makeCandidate({ id: 'p12', authorId: 'l', favourites: 3, ageMs: 12 * HOUR }),
    ]
    const ranked = rankCandidates(slate, signals(), ctx())

    const onFloor = ranked.filter(c => c.rawScore! <= NEGATIVE_SCORES_OFFSET)
    expect(onFloor.map(c => c.status.id)).toEqual([])

    // and every score is distinct, i.e. nothing is tie-broken by id
    expect(new Set(ranked.map(c => c.score))).toHaveLength(ranked.length)
    expect(ranked[0]!.status.id).toBe('p5')
  })

  it('orders dismissed, muted and irredeemable strictly, all above the floor', () => {
    const context = penaltyCtx({ dismissed: 0.5, muted: 1, worst: 1 })
    const mediocre = raw(makeCandidate({ authorId: 'ok', favourites: 3 }), signals(), context)
    const spammyStranger = raw(
      makeCandidate({ authorId: 'spam', inNetwork: false, followers: 3, following: 9000, note: '', bot: true, sensitive: true }),
      signals(),
      context,
    )
    const dismissedOnce = raw(makeCandidate({ authorId: 'dismissed', favourites: 3 }), signals(), context)
    const muted = raw(makeCandidate({ authorId: 'muted', favourites: 3 }), signals(), context)
    const worst = raw(
      makeCandidate({ authorId: 'worst', inNetwork: false, followers: 3, following: 9000, note: '', bot: true, sensitive: true }),
      signals(),
      context,
    )

    // a strict total order, no plateaus
    expect(mediocre).toBeGreaterThan(spammyStranger)
    expect(spammyStranger).toBeGreaterThan(dismissedOnce)
    expect(dismissedOnce).toBeGreaterThan(muted)
    expect(muted).toBeGreaterThan(worst)
    expect(worst).toBeGreaterThan(0)

    // dismissal pushes hard: below every ordinary post, but not to the floor
    expect(dismissedOnce).toBeLessThan(NEGATIVE_SCORES_OFFSET)
    // …and a merely spam-shaped stranger is *not* pushed into the band at all
    expect(spammyStranger).toBeGreaterThan(NEGATIVE_SCORES_OFFSET)
  })

  it('reads the dismissal penalty into notInterested and muteAuthor', () => {
    const context = penaltyCtx({ d: 0.75 })
    const p = predictActions(makeCandidate({ authorId: 'd' }), signals(), context)
    expect(p.notInterested).toBeCloseTo(0.75, 10)
    expect(p.muteAuthor).toBeCloseTo(0.75, 10)
  })

  it('picks up mutedForYou and dismissed post ids without any wiring', () => {
    const muted = predictActions(makeCandidate({ authorId: 'm1' }), signals({ mutedForYou: ['m1'] }), ctx())
    expect(muted.notInterested).toBe(1)
    expect(muted.muteAuthor).toBe(1)

    const dismissedPost = predictActions(makeCandidate({ id: 'x1' }), signals({ notInterested: ['x1'] }), ctx())
    expect(dismissedPost.notInterested).toBe(1)
    // The defect this guards: `authorPenalty` used to be one undifferentiated
    // scalar (muted OR this post dismissed) fed as the Math.max floor into
    // BOTH notInterested and muteAuthor, so dismissing a single post forced
    // P(muteAuthor) = 1 for it too — the same as an actual author mute. A
    // post-level dismissal must not do that.
    expect(dismissedPost.muteAuthor).toBeLessThan(1)
  })

  it('does not let a single dismissed post score the same as an author mute', () => {
    // Independent reproduction of the conflation: before the fix these two
    // scenarios — one post dismissed vs. the whole author muted — produced
    // byte-identical scores, because the same scalar floored both heads.
    const dismissedPostOnly = makeCandidate({ id: 'post-x', authorId: 'fine-author', favourites: 3 })
    const mutedAuthorPost = makeCandidate({ id: 'post-y', authorId: 'muted-author', favourites: 3 })

    const dismissedActions = predictActions(dismissedPostOnly, signals({ notInterested: ['post-x'] }), ctx())
    const mutedActions = predictActions(mutedAuthorPost, signals({ mutedForYou: ['muted-author'] }), ctx())

    // Both are a hard "don't show me this post again"...
    expect(dismissedActions.notInterested).toBe(1)
    expect(mutedActions.notInterested).toBe(1)
    // ...but only the real mute is a verdict on the whole author.
    expect(dismissedActions.muteAuthor).toBeLessThan(1)
    expect(mutedActions.muteAuthor).toBe(1)

    const dismissedScore = raw(dismissedPostOnly, signals({ notInterested: ['post-x'] }), ctx())
    const mutedScore = raw(mutedAuthorPost, signals({ mutedForYou: ['muted-author'] }), ctx())
    expect(dismissedScore).not.toBeCloseTo(mutedScore, 6)
    expect(dismissedScore).toBeGreaterThan(mutedScore)
  })

  it('keeps a strict total order above the floor when post- and author-level penalties mix', () => {
    // Same shape as "orders dismissed, muted and irredeemable strictly"
    // above, but exercising the real post/author split end to end instead of
    // a single mocked accessor.
    const ordinary = raw(makeCandidate({ authorId: 'ordinary', favourites: 3 }), signals(), ctx())
    const dismissedPost = raw(
      makeCandidate({ id: 'dismissed-post', authorId: 'dismissed-author', favourites: 3 }),
      signals({ notInterested: ['dismissed-post'] }),
      ctx(),
    )
    const mutedAuthor = raw(
      makeCandidate({ authorId: 'muted-author', favourites: 3 }),
      signals({ mutedForYou: ['muted-author'] }),
      ctx(),
    )
    const worst = raw(
      makeCandidate({
        authorId: 'worst',
        inNetwork: false,
        followers: 3,
        following: 9000,
        note: '',
        bot: true,
        sensitive: true,
      }),
      signals({ mutedForYou: ['worst'] }),
      ctx(),
    )

    expect(ordinary).toBeGreaterThan(dismissedPost)
    expect(dismissedPost).toBeGreaterThan(mutedAuthor)
    expect(mutedAuthor).toBeGreaterThan(worst)
    expect(worst).toBeGreaterThan(0)
  })
})

// ───────────────────────────────────────────────────────  author diversity ──

describe('diversityMultiplier', () => {
  it('matches (1 - floor) * decay^k + floor', () => {
    const { authorDiversityDecay: d, authorDiversityFloor: f } = DEFAULT_RANKING_PARAMS
    expect(diversityMultiplier(0, d, f)).toBeCloseTo(1, 10)
    expect(diversityMultiplier(1, d, f)).toBeCloseTo(0.625, 10)
    expect(diversityMultiplier(2, d, f)).toBeCloseTo(0.4375, 10)
    expect(diversityMultiplier(20, d, f)).toBeCloseTo(f, 5)
  })

  it('never falls below the floor', () => {
    for (let k = 0; k < 50; k++)
      expect(diversityMultiplier(k, 0.5, 0.25)).toBeGreaterThanOrEqual(0.25)
  })
})

describe('applyAdjustments — author diversity', () => {
  const noOon = ctx({ params: { oonRescoreInNetworkRepliesReblogs: false } })

  it('demotes an author\'s 2nd and 3rd post but leaves the first alone', () => {
    const candidates = [
      preScored(10, { id: 's1', authorId: 'A' }),
      preScored(9, { id: 's2', authorId: 'B' }),
      preScored(8, { id: 's3', authorId: 'A' }),
      preScored(7, { id: 's4', authorId: 'A' }),
    ]
    const adjusted = applyAdjustments(candidates, noOon)

    expect(adjusted[0]!.score).toBeCloseTo(10, 10)
    expect(adjusted[1]!.score).toBeCloseTo(9, 10)
    expect(adjusted[2]!.score).toBeCloseTo(8 * 0.625, 10)
    expect(adjusted[3]!.score).toBeCloseTo(7 * 0.4375, 10)
  })

  it('counts k in score order, not array order', () => {
    const candidates = [
      preScored(5, { id: 's1', authorId: 'A' }),
      preScored(9, { id: 's2', authorId: 'B' }),
      preScored(10, { id: 's3', authorId: 'A' }),
    ]
    const adjusted = applyAdjustments(candidates, noOon)
    expect(adjusted[2]!.score).toBeCloseTo(10, 10)
    expect(adjusted[0]!.score).toBeCloseTo(5 * 0.625, 10)
  })

  it('keys on the CONTENT author, so five boosts of one post still decay', () => {
    // The failure this guards: keying on `status.account.id` reads the
    // *booster*, so five people boosting the same post each take a k=0 slot
    // and occupy the top of the feed. On Mastodon boosting is the distribution
    // mechanism, so this is the common case, not an edge case.
    const boosts = ['x1', 'x2', 'x3', 'x4', 'x5'].map((booster, i) =>
      preScored(10, { id: `b${i}`, authorId: booster, boostOf: { authorId: 'ORIGINAL' } }),
    )
    const other = preScored(9, { id: 'other', authorId: 'Z' })
    const adjusted = applyAdjustments([...boosts, other], noOon)

    expect(adjusted[0]!.score).toBeCloseTo(10, 10)
    expect(adjusted[1]!.score).toBeCloseTo(10 * 0.625, 10)
    expect(adjusted[2]!.score).toBeCloseTo(10 * 0.4375, 10)
    // the unrelated post beats all but the first boost
    const ranked = [...adjusted].sort((a, b) => b.score! - a.score!)
    expect(ranked[1]!.status.id).toBe('other')
  })

  it('can reorder the slate — a spammy author loses their run', () => {
    const candidates = [
      preScored(10, { id: 's1', authorId: 'A' }),
      preScored(9.5, { id: 's2', authorId: 'A' }),
      preScored(9, { id: 's3', authorId: 'A' }),
      preScored(7, { id: 's4', authorId: 'B' }),
    ]
    const ranked = applyAdjustments(candidates, noOon).sort((a, b) => b.score! - a.score!)
    expect(ranked.map(c => c.status.id)).toEqual(['s1', 's4', 's2', 's3'])
  })

  it('is a no-op when disabled', () => {
    const candidates = [
      preScored(10, { id: 's1', authorId: 'A' }),
      preScored(8, { id: 's2', authorId: 'A' }),
    ]
    const adjusted = applyAdjustments(candidates, ctx({
      params: { enableAuthorDiversity: false, oonRescoreInNetworkRepliesReblogs: false },
    }))
    expect(adjusted[1]!.score).toBeCloseTo(8, 10)
  })

  it('records the multiplier as a reason', () => {
    const candidates = [
      preScored(10, { id: 's1', authorId: 'A' }),
      preScored(8, { id: 's2', authorId: 'A' }),
    ]
    expect(applyAdjustments(candidates, noOon)[1]!.reasons)
      .toContainEqual({ label: 'authorDiversity', value: 0.625 })
  })
})

// ─────────────────────────────────────────────  out-of-network discount ──

describe('oonApplies', () => {
  const params = DEFAULT_RANKING_PARAMS

  it('is true for anything out of network', () => {
    expect(oonApplies(makeCandidate({ inNetwork: false }), params)).toBe(true)
  })

  it('is true for in-network replies and boosts', () => {
    expect(oonApplies(makeCandidate({ inNetwork: true, inReplyToId: 'x' }), params)).toBe(true)
    expect(oonApplies(makeCandidate({ inNetwork: true, boostOf: {} }), params)).toBe(true)
  })

  it('is false for an in-network original post', () => {
    expect(oonApplies(makeCandidate({ inNetwork: true }), params)).toBe(false)
  })

  it('spares in-network replies and boosts when the flag is off', () => {
    const off = { ...params, oonRescoreInNetworkRepliesReblogs: false }
    expect(oonApplies(makeCandidate({ inNetwork: true, inReplyToId: 'x' }), off)).toBe(false)
    expect(oonApplies(makeCandidate({ inNetwork: false }), off)).toBe(true)
  })
})

describe('applyAdjustments — out-of-network discount', () => {
  it('multiplies out-of-network posts by OonWeightFactor', () => {
    const adjusted = applyAdjustments([
      preScored(10, { id: 's1', authorId: 'A', inNetwork: true }),
      preScored(10, { id: 's2', authorId: 'B', inNetwork: false }),
    ], ctx())

    expect(adjusted[0]!.score).toBeCloseTo(10, 10)
    expect(adjusted[1]!.score).toBeCloseTo(10 * 0.75, 10)
  })

  it('also discounts replies and boosts from followed accounts', () => {
    const adjusted = applyAdjustments([
      preScored(10, { id: 's1', authorId: 'A', inNetwork: true }),
      preScored(10, { id: 's2', authorId: 'B', inNetwork: true, inReplyToId: 'x' }),
      preScored(10, { id: 's3', authorId: 'C', inNetwork: true, boostOf: { authorId: 'Z' } }),
    ], ctx())

    expect(adjusted[0]!.score).toBeCloseTo(10, 10)
    expect(adjusted[1]!.score).toBeCloseTo(7.5, 10)
    expect(adjusted[2]!.score).toBeCloseTo(7.5, 10)
  })

  it('honours a custom factor and records it as a reason', () => {
    const adjusted = applyAdjustments(
      [preScored(10, { id: 's1', authorId: 'A', inNetwork: false })],
      ctx({ params: { oonWeightFactor: 0.5 } }),
    )
    expect(adjusted[0]!.score).toBeCloseTo(5, 10)
    expect(adjusted[0]!.reasons).toContainEqual({ label: 'outOfNetwork', value: 0.5 })
  })
})

describe('effectiveOonFactor', () => {
  it('is OonWeightFactor by default — the new-user rule ships disabled', () => {
    expect(effectiveOonFactor(ctx({ viewerAccountAgeMs: 0, viewerFollowingCount: 100 }))).toBeCloseTo(0.75, 10)
  })

  it('collapses to NEW_USER_OON_WEIGHT_FACTOR for a new viewer with enough follows', () => {
    expect(effectiveOonFactor(ctx({
      viewerAccountAgeMs: HOUR,
      viewerFollowingCount: 10,
      params: { newUserAgeThresholdMs: 24 * HOUR },
    }))).toBeCloseTo(0.00001, 12)
  })

  it('does not apply to a new viewer who follows almost nobody', () => {
    expect(effectiveOonFactor(ctx({
      viewerAccountAgeMs: HOUR,
      viewerFollowingCount: 2,
      params: { newUserAgeThresholdMs: 24 * HOUR },
    }))).toBeCloseTo(0.75, 10)
  })
})

// ────────────────────────────────────────────────────── new-author boost ──

describe('impressionProxy', () => {
  it('combines follower reach with realised engagement', () => {
    expect(impressionProxy(makeCandidate({ followers: 80, favourites: 2, reblogs: 1, replies: 1 }))).toBe(80 + 25 * 4)
  })

  it('reads through a boost to the boosted post', () => {
    expect(impressionProxy(makeCandidate({ followers: 90_000, boostOf: { followers: 12 } }))).toBe(12)
  })
})

describe('applyNewAuthorBoost', () => {
  /** 20 in-network originals, distinct authors, descending scores 100…81. */
  function slate(overrides: Record<number, StatusOptions> = {}) {
    return Array.from({ length: 20 }, (_, i) => makeCandidate({
      id: `s${i}`,
      authorId: `a${i}`,
      followers: 50_000,
      ...overrides[i],
    }))
  }
  const scores = Array.from({ length: 20 }, (_, i) => 100 - i)

  it('lifts the best eligible low-reach author to the slot-15 score', () => {
    const candidates = slate({ 16: { followers: 30, favourites: 1 } })
    const result = applyNewAuthorBoost(candidates, scores, ctx())

    expect(result.boostedIndex).toBe(16)
    expect(result.target).toBe(85) // ranked[15]
    expect(result.scores[16]).toBe(85)
    result.scores.forEach((s, i) => {
      if (i !== 16)
        expect(s).toBe(scores[i])
    })
  })

  it('still explores an author whose post has started to do well', () => {
    // The failure this guards: with the threshold at 1000 and the follower cap
    // also at 1000, the follower term exhausted the budget on its own, so a
    // 40-follower author with 40 favourites was ruled ineligible and the
    // exploration slot went only to posts with no engagement at all — random
    // insertion rather than exploration.
    const candidates = slate({ 16: { followers: 40, favourites: 40 } })
    expect(impressionProxy(candidates[16]!)).toBeGreaterThan(1000)
    expect(applyNewAuthorBoost(candidates, scores, ctx()).boostedIndex).toBe(16)
  })

  it('lifts exactly one post even when several are eligible', () => {
    const candidates = slate({ 14: { followers: 30 }, 16: { followers: 30 }, 12: { followers: 30 } })
    const result = applyNewAuthorBoost(candidates, scores, ctx())
    expect(result.boostedIndex).toBe(12)
    expect(result.scores.filter((s, i) => s !== scores[i])).toHaveLength(0)
  })

  it('never lowers a score — the lift is max(score, target)', () => {
    expect(applyNewAuthorBoost(slate({ 2: { followers: 30 } }), scores, ctx()).scores[2]).toBe(98)
  })

  it('skips authors above the follower cap', () => {
    expect(applyNewAuthorBoost(slate({ 16: { followers: 5000 } }), scores, ctx()).boostedIndex).toBe(-1)
  })

  it('skips replies and boosts', () => {
    expect(applyNewAuthorBoost(slate({ 16: { followers: 30, inReplyToId: 'x' } }), scores, ctx()).boostedIndex).toBe(-1)
    expect(applyNewAuthorBoost(slate({ 16: { followers: 30, boostOf: { followers: 30 } } }), scores, ctx()).boostedIndex).toBe(-1)
  })

  it('skips authors already well past the impression threshold', () => {
    // 30 + 25 * 400 = 10030
    expect(applyNewAuthorBoost(slate({ 16: { followers: 30, favourites: 400 } }), scores, ctx()).boostedIndex).toBe(-1)
  })

  it('skips posts below the max position ratio', () => {
    // position 18 >= 0.85 * 20 = 17
    expect(applyNewAuthorBoost(slate({ 18: { followers: 30 } }), scores, ctx()).boostedIndex).toBe(-1)
  })

  it('skips posts whose CONTENT is older than the cold-start age cap', () => {
    expect(applyNewAuthorBoost(slate({ 16: { followers: 30, ageMs: 30 * HOUR } }), scores, ctx()).boostedIndex).toBe(-1)
  })

  it('does nothing when the slate is shorter than ColdStartSlotMax', () => {
    const short = slate({ 3: { followers: 30 } }).slice(0, 10)
    expect(applyNewAuthorBoost(short, scores.slice(0, 10), ctx()).boostedIndex).toBe(-1)
  })

  it('is a no-op when disabled', () => {
    const result = applyNewAuthorBoost(slate({ 16: { followers: 30 } }), scores, ctx({ params: { enableNewAuthorBoost: false } }))
    expect(result.boostedIndex).toBe(-1)
    expect(result.scores).toBe(scores)
  })

  it('actually lifts the post through applyAdjustments', () => {
    const candidates = slate({ 16: { followers: 30 } }).map((c, i) => ({ ...c, rawScore: scores[i]! }))
    expect(candidates[16]!.rawScore).toBe(84)

    const after = applyAdjustments(candidates, ctx({ params: { oonRescoreInNetworkRepliesReblogs: false } }))
    const boosted = after.find(c => c.status.id === 's16')!

    expect(boosted.score).toBeCloseTo(85, 10)
    expect(boosted.score!).toBeGreaterThan(boosted.rawScore!)
    expect(boosted.score!).toBeGreaterThan(after.find(c => c.status.id === 's17')!.score!)
    expect(boosted.reasons).toContainEqual({ label: 'newAuthorBoost', value: 85 })

    for (const candidate of after) {
      if (candidate.status.id !== 's16')
        expect(candidate.score).toBeCloseTo(candidate.rawScore!, 10)
    }
  })

  it('explores the genuinely obscure author instead of re-confirming the busiest filler, on a Mastodon-shaped slate', () => {
    // The defect: on X, ColdStartFollowerCap (1000) is itself a small-account
    // cutoff, so the eligible set on any slate is a genuine handful of small,
    // novel accounts and picking the highest-scoring one among them
    // (X's `pick_by_score`) is a reasonable explore/exploit trade. On
    // Mastodon almost every account is under 1000 followers, so the same
    // absolute cutoff admits nearly the whole slate — 20 unremarkable
    // in-network filler posts here, none of them large or spammy — and
    // picking "highest score among eligible" just re-confirms whichever
    // filler already has the most engagement. It never reaches the one
    // truly obscure new author sitting in the same eligible set.
    // 17 "healthy" filler posts, all comfortably small (<1000 followers) and
    // with real engagement (23-39 favourites) — the Mastodon-typical slate.
    // filler[0] is the busiest (39 favourites) and scores highest of the
    // whole eligible pool, so it is what X's `pick_by_score` would confirm.
    const healthyFiller = Array.from({ length: 17 }, (_, i) => makeCandidate({
      id: `f${i}`,
      authorId: `f${i}`,
      followers: 200 + i * 30, // 200..680
      favourites: 39 - i, // 39..23
    }))
    // 3 more filler posts that just underperformed and sit outside the
    // top-85% position window — present so the obscure author isn't
    // artificially last by construction, exactly as in a real slate where
    // some posts are simply dead weight.
    const laggingFiller = [5, 4, 3].map((favourites, i) => makeCandidate({
      id: `lag${i}`,
      authorId: `lag${i}`,
      followers: 50,
      favourites,
    }))
    const obscure = makeCandidate({ id: 'obscure', authorId: 'obscure', followers: 10, favourites: 1 })
    const candidates = [...healthyFiller, ...laggingFiller, obscure]

    // Scores are given directly, as elsewhere in this describe block:
    // healthyFiller descends 100..84, laggingFiller trails far behind at
    // 5/4/3, and the obscure author sits at 50 — below every healthy filler,
    // above the laggards, and squarely inside the top-85%-by-position
    // window (rank 17 of 21; the cutoff is rank < 17.85). This isolates the
    // PICK: eligibility and position are not what is under test here.
    const scores = [
      ...Array.from({ length: 17 }, (_, i) => 100 - i),
      5,
      4,
      3,
      50,
    ]

    // Sanity check the reproduction: everyone (including the laggards) is
    // eligible on the follower cap and impression-threshold gates X
    // calibrated for its own scale — Mastodon's flatter distribution means
    // those gates alone cannot keep the eligible pool small.
    expect(candidates.every(c => (c.status.account?.followersCount ?? 0) <= DEFAULT_RANKING_PARAMS.coldStartFollowerCap)).toBe(true)
    expect(candidates.every(c => impressionProxy(c) < DEFAULT_RANKING_PARAMS.coldStartImpressionThreshold)).toBe(true)
    // ...and the obscure author has by far the least estimated reach of
    // anyone actually eligible (the laggards are excluded by position, see below).
    expect(impressionProxy(obscure)).toBeLessThan(Math.min(...healthyFiller.map(c => impressionProxy(c))))

    const result = applyNewAuthorBoost(candidates, scores, ctx())

    // Before the fix this picked index 0 (score 100, the highest-scoring
    // eligible post — the busiest filler). The obscure author, last index,
    // stayed at its own score of 50 instead of being lifted to the target.
    const obscureIndex = candidates.length - 1
    expect(result.boostedIndex).toBe(obscureIndex)
    expect(result.target).toBe(85) // ranked[15], within the healthy-filler block
    expect(result.scores[obscureIndex]).toBe(85)
    expect(result.scores[0]).toBe(scores[0]) // the busiest filler is untouched
  })
})

// ────────────────────────────────────────────────────────────── boosts ──

describe('boosts are judged by their content, not by the boost event', () => {
  function boostOfAge(ageMs: number, favourites: number): PostCandidate {
    return makeCandidate({
      id: 'b',
      authorId: 'booster',
      ageMs: 0.1 * HOUR,
      boostOf: { id: 'inner', authorId: 'ORIGINAL', ageMs, favourites },
    })
  }

  it('uses the content\'s age for freshness and velocity', () => {
    // The failure this guards: counts came from the inner status but age from
    // the outer one, so every boost looked infinitely fast. A two-year-old
    // 9,000-favourite post boosted five minutes ago outranked a genuine
    // two-hour-old out-of-network hit.
    const zombie = boostOfAge(700 * 24 * HOUR, 9_000)
    const genuine = makeCandidate({ id: 'real', authorId: 'R', inNetwork: false, favourites: 300, ageMs: 2 * HOUR })

    expect(raw(zombie)).toBeLessThanOrEqual(NEGATIVE_SCORES_OFFSET)
    expect(raw(genuine)).toBeGreaterThan(raw(zombie) * 50)
    expect(extractRankingFeatures(zombie, signals(), ctx()).ageHours).toBeGreaterThan(1000)
  })

  it('scores a recent post boosted now on its own age', () => {
    const recent = boostOfAge(2 * HOUR, 300)
    expect(extractRankingFeatures(recent, signals(), ctx()).ageHours).toBeCloseTo(2, 6)
    expect(raw(recent)).toBeGreaterThan(raw(boostOfAge(30 * HOUR, 300)))
  })

  it('reads engagement, media and author from the boosted post', () => {
    const withEngagement = boostOfAge(2 * HOUR, 300)
    const without = boostOfAge(2 * HOUR, 0)
    expect(raw(withEngagement)).toBeGreaterThan(raw(without))
  })

  it('lifts a boost from a curator the viewer engages with', () => {
    const candidate = boostOfAge(2 * HOUR, 100)
    const cold = raw(candidate)
    const warm = raw(candidate, signals(), ctx({ affinity: { booster: () => 1 } }))
    expect(warm).toBeGreaterThan(cold)
    // and the booster signal does nothing on a post that is not a boost
    const original = makeCandidate({ favourites: 100, ageMs: 2 * HOUR })
    expect(raw(original, signals(), ctx({ affinity: { booster: () => 1 } }))).toBeCloseTo(raw(original), 12)
  })
})

// ─────────────────────────────────────────────────────────── estimators ──

describe('predictActions', () => {
  it('returns probabilities in [0, 1] for a wide range of inputs', () => {
    const cases = [
      makeCandidate(),
      makeCandidate({ favourites: 1e6, reblogs: 1e6, replies: 1e6 }),
      makeCandidate({ inNetwork: false, bot: true, followers: 0, following: 9999, note: '' }),
      makeCandidate({ ageMs: 47 * HOUR, sensitive: true, images: 4, videoDurationSecs: 60, card: true }),
      makeCandidate({ boostOf: { favourites: 500 } }),
    ]
    for (const candidate of cases) {
      const probabilities = predictActions(candidate, signals(), ctx())
      for (const key of ACTION_KEYS) {
        expect(probabilities[key], key).toBeGreaterThanOrEqual(0)
        expect(probabilities[key], key).toBeLessThanOrEqual(1)
      }
    }
  })

  it('gates the link and media heads on the media actually existing', () => {
    const plain = predictActions(makeCandidate(), signals(), ctx())
    expect(plain.openLink).toBe(0)
    expect(plain.photoExpand).toBe(0)
    expect(plain.videoOpen).toBe(0)
    expect(plain.vqv).toBe(0)

    const rich = predictActions(makeCandidate({ card: true, images: 2, videoDurationSecs: 30 }), signals(), ctx())
    expect(rich.openLink).toBeGreaterThan(0)
    expect(rich.photoExpand).toBeGreaterThan(0)
    expect(rich.videoOpen).toBeGreaterThan(0)
    expect(rich.vqv).toBeGreaterThan(0)
    expect(rich.vqv).toBeLessThan(rich.videoOpen)
  })

  it('lifts favourites and replies with author affinity', () => {
    const cold = predictActions(makeCandidate({ authorId: 'a1' }), signals(), ctx())
    const warm = predictActions(
      makeCandidate({ authorId: 'a1' }),
      signals({ authorAffinity: { a1: 10, other: 1 } }),
      ctx(),
    )
    expect(warm.favorite).toBeGreaterThan(cold.favorite)
    expect(warm.reply).toBeGreaterThan(cold.reply)
    expect(warm.notInterested).toBeLessThan(cold.notInterested)
  })

  it('does not give a zero-engagement post a large flat reply term', () => {
    // reply carries weight 5.0, so its base rate is the largest flat term in
    // the sum and the easiest way for a post with no signal to look good.
    const empty = predictActions(makeCandidate({ favourites: 0, replies: 0 }), signals(), ctx())
    const engaged = predictActions(makeCandidate({ favourites: 200, replies: 40 }), signals(), ctx())
    expect(engaged.reply).toBeGreaterThan(empty.reply * 2.5)
  })

  it('raises the negative heads for a spam-shaped stranger', () => {
    const normal = predictActions(makeCandidate({ inNetwork: false }), signals(), ctx())
    const spam = predictActions(
      makeCandidate({ inNetwork: false, followers: 3, following: 9000, note: '', sensitive: true }),
      signals(),
      ctx(),
    )
    expect(spam.notInterested).toBeGreaterThan(normal.notInterested)
    expect(spam.blockAuthor).toBeGreaterThan(normal.blockAuthor)
    expect(spam.report).toBeGreaterThan(normal.report)
  })

  it('keeps report several orders of magnitude below favorite, as X assumes', () => {
    const probabilities = predictActions(makeCandidate(), signals(), ctx())
    expect(probabilities.report).toBeLessThan(probabilities.favorite / 1000)
  })
})

describe('base rates', () => {
  it('is defined for every action', () => {
    expect(Object.keys(BASE_RATES).sort()).toEqual([...ACTION_KEYS].sort())
  })

  it('keeps the whole negative side well under the positive side on a bare post', () => {
    let pos = 0
    let neg = 0
    for (const key of ACTION_KEYS) {
      const term = BASE_RATES[key] * X_WEIGHTS[key]
      if (term >= 0)
        pos += term
      else
        neg -= term
    }
    expect(pos).toBeGreaterThan(neg * 4)
  })
})

// ─────────────────────────────────────────────────────────────── helpers ──

describe('lift', () => {
  it('is a no-op at zero signal and reaches max at one', () => {
    expect(lift(0, 4)).toBe(1)
    expect(lift(1, 4)).toBe(4)
    expect(lift(0.5, 3)).toBeCloseTo(2, 10)
  })

  it('works as a penalty when max < 1', () => {
    expect(lift(0, 0.25)).toBe(1)
    expect(lift(1, 0.25)).toBeCloseTo(0.25, 10)
  })

  it('ignores a negative signal unless a min is supplied', () => {
    expect(lift(-1, 4)).toBe(1)
    expect(lift(-1, 4, 0.25)).toBeCloseTo(0.25, 10)
    expect(lift(-0.5, 4, 0.5)).toBeCloseTo(0.75, 10)
  })

  it('clamps out-of-range signals', () => {
    expect(lift(5, 4)).toBe(4)
    expect(lift(-5, 4, 0.25)).toBeCloseTo(0.25, 10)
  })
})

describe('affinitySignal', () => {
  it('is rank-based, not winner-take-all', () => {
    // The failure this guards: dividing by the map maximum meant that as the
    // history grew the leader ran away with it and everyone else collapsed
    // towards zero, making personalization effectively binary.
    const map = { top: 200, a: 20, b: 15, c: 10, d: 5, e: 2 }
    const values = Object.keys(map).map(k => affinitySignal(map, k))
    expect(values[0]).toBeCloseTo(0.9166, 3)
    expect(values[1]).toBeCloseTo(0.75, 3)
    expect(values[2]).toBeCloseTo(0.5833, 3)

    // the runner-up is nowhere near zero despite being 10x behind the leader
    expect(affinitySignal(map, 'a')).toBeGreaterThan(0.5)
    // strictly ordered all the way down
    for (let i = 1; i < values.length; i++)
      expect(values[i]!).toBeLessThan(values[i - 1]!)
  })

  it('is invariant to how signals.ts scales its counters', () => {
    const small = { a: 2, b: 1.5, c: 1, d: 0.5 }
    const large = { a: 20_000, b: 15_000, c: 10_000, d: 5_000 }
    for (const key of Object.keys(small))
      expect(affinitySignal(small, key)).toBeCloseTo(affinitySignal(large, key), 12)
  })

  it('returns a negative value for a negative entry, ranked among the negatives', () => {
    const map = { good: 10, bad: -1, worse: -5 }
    expect(affinitySignal(map, 'good')).toBeGreaterThan(0)
    expect(affinitySignal(map, 'bad')).toBeLessThan(0)
    expect(affinitySignal(map, 'worse')).toBeLessThan(affinitySignal(map, 'bad'))
    expect(affinitySignal(map, 'worse')).toBeGreaterThanOrEqual(-1)
  })

  it('returns 0 for unknown, absent or non-finite keys', () => {
    expect(affinitySignal({ a: 10 }, 'z')).toBe(0)
    expect(affinitySignal({}, 'a')).toBe(0)
    expect(affinitySignal(undefined, 'a')).toBe(0)
    expect(affinitySignal({ a: 10 }, undefined)).toBe(0)
    expect(affinitySignal({ a: Number.NaN }, 'a')).toBe(0)
  })

  it('picks up in-place mutations of the map', () => {
    const map: Record<string, number> = { a: 10, b: 5 }
    const before = affinitySignal(map, 'b')
    map.c = 1
    expect(affinitySignal(map, 'b')).not.toBeCloseTo(before, 6)
  })
})

describe('defaultAffinityResolver', () => {
  it('reads the four channels off the plain contract type', () => {
    const resolver = defaultAffinityResolver(signals({
      authorAffinity: { a1: 10 },
      tagAffinity: { cats: 3 },
      languageAffinity: { ja: 2 },
      mutedForYou: ['m1'],
      notInterested: ['post9'],
    }))
    expect(resolver.author('a1')).toBeGreaterThan(0)
    expect(resolver.tag('cats')).toBeGreaterThan(0)
    expect(resolver.language('ja')).toBeGreaterThan(0)
    // authorPenalty is account-scoped: a muted author scores 1, an
    // unrelated account does not — regardless of any dismissed post.
    expect(resolver.authorPenalty('m1')).toBe(1)
    expect(resolver.authorPenalty('someone')).toBe(0)
    // postPenalty is post-scoped: a dismissed status id scores 1, any other
    // status id does not — regardless of who its author is.
    expect(resolver.postPenalty('post9')).toBe(1)
    expect(resolver.postPenalty('post1')).toBe(0)
  })

  it('reads boosterAffinity when the store provides it', () => {
    const withBoosters = { ...signals(), boosterAffinity: { curator: 5 } } as ForYouSignals
    expect(defaultAffinityResolver(withBoosters).booster('curator')).toBeGreaterThan(0)
    expect(defaultAffinityResolver(signals()).booster('curator')).toBe(0)
  })

  it('is overridable one channel at a time', () => {
    const context = ctx({ affinity: { author: () => 1 } })
    const warm = predictActions(makeCandidate({ authorId: 'nobody' }), signals(), context)
    const cold = predictActions(makeCandidate({ authorId: 'nobody' }), signals(), ctx())
    expect(warm.favorite).toBeGreaterThan(cold.favorite)
  })
})

describe('extractRankingFeatures', () => {
  it('reads engagement, media and author shape off the status', () => {
    const features = extractRankingFeatures(
      makeCandidate({
        favourites: 10,
        reblogs: 4,
        replies: 6,
        images: 2,
        card: true,
        cardImage: true,
        spoilerText: 'cw',
        verified: true,
        bot: true,
      }),
      signals(),
      ctx(),
    )

    expect(features.totalEngagement).toBe(20)
    expect(features.replyDensity).toBeCloseTo(0.3, 10)
    expect(features.reblogDensity).toBeCloseTo(0.2, 10)
    expect(features.imageCount).toBe(2)
    expect(features.hasLink).toBe(true)
    expect(features.hasCardImage).toBe(true)
    expect(features.hasSpoiler).toBe(true)
    expect(features.verified).toBe(true)
    expect(features.bot).toBe(true)
  })

  it('reports a video duration only for real videos', () => {
    expect(extractRankingFeatures(makeCandidate({ images: 1 }), signals(), ctx()).videoDurationMs).toBeUndefined()
    expect(extractRankingFeatures(makeCandidate({ videoDurationSecs: 12 }), signals(), ctx()).videoDurationMs).toBe(12_000)
  })

  it('survives a status with missing optional fields', () => {
    const bare = {
      id: 'bare',
      createdAt: new Date(NOW - HOUR).toISOString(),
      account: { id: 'a1', acct: 'bare' },
    } as mastodon.v1.Status
    const features = extractRankingFeatures({ status: bare, sources: new Set(['home']), inNetwork: true }, signals(), ctx())
    expect(features.totalEngagement).toBe(0)
    expect(features.textLength).toBe(0)
    expect(Number.isFinite(features.freshness)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────── pipeline ──

describe('rankCandidates', () => {
  it('returns candidates sorted by final score, descending', () => {
    const candidates = [
      makeCandidate({ id: 's1', authorId: 'A', favourites: 2 }),
      makeCandidate({ id: 's2', authorId: 'B', favourites: 200, replies: 30 }),
      makeCandidate({ id: 's3', authorId: 'C', favourites: 40 }),
    ]
    const ranked = rankCandidates(candidates, signals(), ctx())

    expect(ranked).toHaveLength(3)
    for (let i = 1; i < ranked.length; i++)
      expect(ranked[i - 1]!.score!).toBeGreaterThanOrEqual(ranked[i]!.score!)
    expect(ranked[0]!.status.id).toBe('s2')
  })

  it('populates probabilities, rawScore, score and reasons on every candidate', () => {
    const candidate = rankCandidates([makeCandidate()], signals(), ctx())[0]!
    expect(candidate.probabilities).toBeDefined()
    expect(candidate.rawScore).toBeGreaterThan(0)
    expect(candidate.score).toBeGreaterThan(0)
    expect(candidate.reasons!.length).toBeGreaterThan(0)
  })

  it('does not mutate the input array or its candidates', () => {
    const candidates = [
      makeCandidate({ id: 's1', authorId: 'A' }),
      makeCandidate({ id: 's2', authorId: 'B', favourites: 500 }),
    ]
    const snapshot = [...candidates]
    rankCandidates(candidates, signals(), ctx())
    expect(candidates).toEqual(snapshot)
    expect(candidates.every(c => c.score === undefined && c.rawScore === undefined)).toBe(true)
  })

  it('handles an empty slate', () => {
    expect(rankCandidates([], signals(), ctx())).toEqual([])
  })

  it('breaks exact ties deterministically', () => {
    const a = preScored(1, { id: 's1', authorId: 'A' })
    const b = preScored(1, { id: 's2', authorId: 'B' })
    const first = rankCandidates([a, b], signals(), ctx()).map(c => c.status.id)
    const second = rankCandidates([b, a], signals(), ctx()).map(c => c.status.id)
    expect(first).toEqual(second)
  })
})
