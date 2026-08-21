import type { mastodon } from 'masto'
import type { EngagementTarget, ForYouSignalsStore } from '../../app/composables/for-you/signals'
import { describe, expect, it, vi } from 'vitest'
import {
  applyMuteToSignals,
  applyNotInterestedToSignals,
  authorPenaltyIn,
  createDwellTracker,
  createEmptySignals,
  DECAY_HALF_LIFE_MS,
  decayFactor,
  decaySignalsInPlace,
  deriveAffinities,
  dismissedAuthorIdsIn,
  DWELL_MIN_MS,
  DWELL_REFERENCE_MS,
  DWELL_SATURATION_MS,
  dwellSignalFor,
  ENGAGEMENT_STRENGTH,
  EVIDENCE_CAP,
  FOLLOW_HALF_LIFE_MS,
  forgetNotInterestedToSignals,
  forgetSignal,
  getEngagementTarget,
  halfLifeFor,
  markSeenInSignals,
  MAX_DISMISSED,
  MAX_FOLLOW_SIGNALS,
  MAX_MUTED,
  MAX_SEEN,
  MAX_SIGNALS_PER_KIND,
  maxSignalsFor,
  MIN_EVIDENCE,
  MUTUAL_MULTIPLIER,
  normalizeSignals,
  NOT_INTERESTED_STRENGTH,
  recordForYouImpressionInSignals,
  recordSignal,
  SIGNALS_VERSION,
  sortDedupTruncate,
  topAffinityKeys,
} from '../../app/composables/for-you/signals'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

function status(id: string, options: {
  authorId?: string
  tags?: string[]
  language?: string
  reblog?: mastodon.v1.Status
  boosterId?: string
} = {}): mastodon.v1.Status {
  return {
    id,
    account: { id: options.boosterId ?? options.authorId ?? 'author-1' } as mastodon.v1.Account,
    tags: (options.tags ?? []).map(name => ({ name, url: '' })),
    language: options.language ?? null,
    reblog: options.reblog ?? null,
  } as unknown as mastodon.v1.Status
}

function target(overrides: Partial<EngagementTarget> = {}): EngagementTarget {
  return { statusId: 's1', authorId: 'a', tags: [], ...overrides }
}

/** A store with one engagement of each given kind, all at `at`. */
function withSignals(
  entries: Array<[Parameters<typeof recordSignal>[1], EngagementTarget]>,
  at = NOW,
): ForYouSignalsStore {
  const signals = createEmptySignals()
  entries.forEach(([kind, engagement], i) => {
    recordSignal(signals, kind, { ...engagement, statusId: engagement.statusId ?? `s${i}` }, at)
  })
  return signals
}

// ────────────────────────────────────────────────── engagement sequence ──

describe('for-you signals: the engagement sequence is the source of truth', () => {
  it('sorts newest first, dedupes on status id and truncates, like sort_dedup_truncate', () => {
    const out = sortDedupTruncate([
      { statusId: 'a', tags: [], at: 100 },
      { statusId: 'c', tags: [], at: 300 },
      { statusId: 'a', tags: [], at: 500 },
      { statusId: 'b', tags: [], at: 200 },
    ], 10)

    expect(out.map(s => s.statusId)).toEqual(['a', 'c', 'b'])
    expect(out[0]!.at).toBe(500)
    expect(sortDedupTruncate(out, 2).map(s => s.statusId)).toEqual(['a', 'c'])
  })

  it('keeps at most MAX_SIGNALS_PER_KIND entries per type, dropping the oldest', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < MAX_SIGNALS_PER_KIND + 20; i++)
      recordSignal(signals, 'favourite', target({ statusId: `s${i}`, authorId: `a${i}` }), NOW + i)

    const list = signals.engaged.favourite!
    expect(list.length).toBe(MAX_SIGNALS_PER_KIND)
    expect(list[0]!.statusId).toBe(`s${MAX_SIGNALS_PER_KIND + 19}`)
    expect(list.some(s => s.statusId === 's0')).toBe(false)
  })

  it('re-engaging the same post refreshes its timestamp instead of double counting', () => {
    const signals = createEmptySignals()
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW - DAY)
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)

    expect(signals.engaged.favourite!.length).toBe(1)
    expect(signals.engaged.favourite![0]!.at).toBe(NOW)
    expect(signals.authorAffinity.a).toBeCloseTo(ENGAGEMENT_STRENGTH.favourite, 10)
  })

  it('lets an undone engagement be removed again, and re-derives', () => {
    const signals = createEmptySignals()
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(signals.authorAffinity.a).toBe(1)

    forgetSignal(signals, 'favourite', 's1', NOW)

    expect(signals.engaged.favourite).toEqual([])
    expect(signals.authorAffinity.a).toBeUndefined()
  })

  it('rebuilds every derived map from the sequence alone', () => {
    const signals = withSignals([
      ['reply', target({ statusId: 's1', authorId: 'a', tags: ['vue'], language: 'en' })],
      ['favourite', target({ statusId: 's2', authorId: 'b', boosterId: 'c' })],
    ])
    const derived = {
      authorAffinity: { ...signals.authorAffinity },
      tagAffinity: { ...signals.tagAffinity },
      boosterAffinity: { ...signals.boosterAffinity },
    }

    // Corrupt the cache; the sequence must be enough to restore it exactly.
    signals.authorAffinity = { garbage: 99 }
    signals.tagAffinity = {}
    signals.boosterAffinity = { garbage: 99 }
    deriveAffinities(signals, NOW)

    expect(signals.authorAffinity).toEqual(derived.authorAffinity)
    expect(signals.tagAffinity).toEqual(derived.tagAffinity)
    expect(signals.boosterAffinity).toEqual(derived.boosterAffinity)
  })
})

// ────────────────────────────────────────────────────── action strengths ──

describe('for-you signals: per-action strengths', () => {
  it('keeps home-mixer ordering: follow > reply = quote > bookmark > reblog > favourite > open > dwell', () => {
    expect(ENGAGEMENT_STRENGTH.follow).toBeGreaterThan(ENGAGEMENT_STRENGTH.reply)
    expect(ENGAGEMENT_STRENGTH.reply).toBe(ENGAGEMENT_STRENGTH.quote)
    expect(ENGAGEMENT_STRENGTH.reply).toBeGreaterThan(ENGAGEMENT_STRENGTH.bookmark)
    expect(ENGAGEMENT_STRENGTH.bookmark).toBeGreaterThan(ENGAGEMENT_STRENGTH.reblog)
    expect(ENGAGEMENT_STRENGTH.reblog).toBeGreaterThan(ENGAGEMENT_STRENGTH.favourite)
    expect(ENGAGEMENT_STRENGTH.favourite).toBeGreaterThan(ENGAGEMENT_STRENGTH.open)
    expect(ENGAGEMENT_STRENGTH.open).toBeGreaterThan(ENGAGEMENT_STRENGTH.dwell)
  })

  it('compresses the probability-weight ratios instead of importing them as counts', () => {
    // param.rs weights are multipliers on predicted probabilities: reading
    // ReplyWeight 5.0 / FavoriteWeight 0.5 as "a reply is worth ten favourites"
    // is the count-equivalence fallacy that file explicitly warns about.
    expect(ENGAGEMENT_STRENGTH.reply / ENGAGEMENT_STRENGTH.favourite).not.toBe(10)

    // What we keep is 1 + log2(ratio), rounded.
    const compress = (ratio: number) => 1 + Math.log2(ratio)
    expect(ENGAGEMENT_STRENGTH.reply).toBeCloseTo(Math.round(compress(10)), 5)
    expect(ENGAGEMENT_STRENGTH.bookmark).toBeCloseTo(compress(4), 5)
    expect(ENGAGEMENT_STRENGTH.reblog).toBeCloseTo(compress(2), 5)
    expect(ENGAGEMENT_STRENGTH.favourite).toBeCloseTo(compress(1), 5)

    // And the negative side uses that same count scale, not -43.2.
    expect(NOT_INTERESTED_STRENGTH).toBe(-4 * ENGAGEMENT_STRENGTH.favourite)
  })

  it('gives the author full strength, tags half and language a quarter', () => {
    const signals = withSignals([
      ['favourite', target({ statusId: 's1', authorId: 'a', tags: ['Vue', 'nuxt'], language: 'en' })],
    ])

    expect(signals.authorAffinity.a).toBe(1)
    expect(signals.tagAffinity.vue).toBe(0.5)
    expect(signals.tagAffinity.nuxt).toBe(0.5)
    expect(signals.languageAffinity.en).toBe(0.25)
  })

  it('applies each action at its own strength and accumulates across posts', () => {
    const signals = withSignals([
      ['favourite', target({ statusId: 's1', authorId: 'liked' })],
      ['reply', target({ statusId: 's2', authorId: 'replied' })],
      ['quote', target({ statusId: 's3', authorId: 'quoted' })],
      ['reblog', target({ statusId: 's4', authorId: 'boosted' })],
      ['bookmark', target({ statusId: 's5', authorId: 'saved' })],
      ['follow', target({ statusId: 'follow:followed', authorId: 'followed' })],
      ['open', target({ statusId: 's6', authorId: 'opened' })],
      ['dwell', target({ statusId: 's7', authorId: 'dwelled' })],
    ])

    expect(signals.authorAffinity).toEqual({
      liked: ENGAGEMENT_STRENGTH.favourite,
      replied: ENGAGEMENT_STRENGTH.reply,
      quoted: ENGAGEMENT_STRENGTH.quote,
      boosted: ENGAGEMENT_STRENGTH.reblog,
      saved: ENGAGEMENT_STRENGTH.bookmark,
      followed: ENGAGEMENT_STRENGTH.follow,
      // `opened` and `dwelled` are absent on purpose: one incidental click or
      // glance is under MIN_EVIDENCE and must not become an affinity entry.
    })

    // Two different posts by the same author add up; the same post does not.
    recordSignal(signals, 'favourite', target({ statusId: 's8', authorId: 'liked' }), NOW)
    expect(signals.authorAffinity.liked).toBe(2)
  })

  it('triples a mutual exchange, like BidirectionalFollowReplyWeightBoost', () => {
    const stranger = withSignals([['reply', target({ statusId: 's1', authorId: 'a' })]])
    const mutual = withSignals([['reply', target({ statusId: 's1', authorId: 'a', mutual: true })]])

    expect(mutual.authorAffinity.a).toBe(stranger.authorAffinity.a! * MUTUAL_MULTIPLIER)
  })

  it('credits the original author of a boost and the booster separately', () => {
    const original = status('inner', { authorId: 'original', tags: ['art'], language: 'fr' })
    const boost = status('outer', { boosterId: 'booster', reblog: original })
    const engagement = getEngagementTarget(boost)

    expect(engagement).toMatchObject({
      statusId: 'inner',
      authorId: 'original',
      boosterId: 'booster',
      tags: ['art'],
      language: 'fr',
    })

    const signals = withSignals([['favourite', engagement]])
    expect(signals.authorAffinity.original).toBe(1)
    expect(signals.authorAffinity.booster).toBeUndefined()
    // Boosting is Mastodon's discovery mechanism: the booster earns its own map.
    expect(signals.boosterAffinity.booster).toBe(0.5)
    expect(signals.tagAffinity.art).toBe(0.5)
  })

  it('never accrues affinity for an author muted for this feed', () => {
    const signals = withSignals([['reply', target({ statusId: 's1', authorId: 'a' })]])
    expect(signals.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.reply)

    applyMuteToSignals(signals, 'a', NOW)
    expect(signals.authorAffinity.a).toBeUndefined()
    expect(signals.mutedForYou).toEqual(['a'])

    recordSignal(signals, 'reply', target({ statusId: 's2', authorId: 'a' }), NOW)
    expect(signals.authorAffinity.a).toBeUndefined()
    expect(topAffinityKeys(signals.authorAffinity, 5, signals.mutedForYou)).toEqual([])
  })

  it('caps the muted list', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < MAX_MUTED + 25; i++)
      applyMuteToSignals(signals, `a${i}`, NOW)

    expect(signals.mutedForYou.length).toBe(MAX_MUTED)
    expect(signals.mutedForYou.includes('a0')).toBe(false)
    expect(signals.mutedForYou.at(-1)).toBe(`a${MAX_MUTED + 24}`)
  })
})

// ───────────────────────────────────────────────────────── negative signal ──

describe('for-you signals: negative signal', () => {
  it('records a dismissal, drops the post history and penalises the author', () => {
    const signals = withSignals([['favourite', target({ statusId: '42', authorId: 'a' })]])
    applyNotInterestedToSignals(signals, '42', target({ statusId: '42', authorId: 'a', tags: ['spam'] }), NOW)

    expect(signals.notInterested).toEqual(['42'])
    expect(signals.seen).toContain('42')
    expect(signals.engaged.favourite).toEqual([])
    expect(signals.authorAffinity.a).toBe(NOT_INTERESTED_STRENGTH)
    expect(signals.tagAffinity.spam).toBe(NOT_INTERESTED_STRENGTH * 0.5)
  })

  it('exposes a saturating 0..1 author penalty the scorer can read', () => {
    const signals = createEmptySignals()
    expect(authorPenaltyIn(signals, 'a', NOW)).toBe(0)
    expect(authorPenaltyIn(signals, undefined, NOW)).toBe(0)

    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    const one = authorPenaltyIn(signals, 'a', NOW)
    expect(one).toBeCloseTo(0.5, 10)

    applyNotInterestedToSignals(signals, 's2', target({ statusId: 's2', authorId: 'a' }), NOW)
    const two = authorPenaltyIn(signals, 'a', NOW)
    expect(two).toBeGreaterThan(one)
    expect(two).toBeLessThan(1)

    // A For You mute is absolute.
    applyMuteToSignals(signals, 'a', NOW)
    expect(authorPenaltyIn(signals, 'a', NOW)).toBe(1)
  })

  it('decays the penalty like everything else', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)

    const fresh = authorPenaltyIn(signals, 'a', NOW)
    const later = authorPenaltyIn(signals, 'a', NOW + 4 * DECAY_HALF_LIFE_MS)
    expect(later).toBeGreaterThan(0)
    expect(later).toBeLessThan(fresh)
  })

  it('lists every author the viewer pushed back on', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    applyMuteToSignals(signals, 'b', NOW)

    expect(dismissedAuthorIdsIn(signals)).toEqual(new Set(['a', 'b']))
  })

  it('caps the dismissal history', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < MAX_DISMISSED + 10; i++)
      applyNotInterestedToSignals(signals, `s${i}`, target({ statusId: `s${i}`, authorId: `a${i}` }), NOW + i)

    expect(signals.dismissed.length).toBe(MAX_DISMISSED)
    expect(signals.dismissed.some(s => s.statusId === 's0')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────── decay ──

describe('for-you signals: decay', () => {
  it('halves a signal contribution every half-life', () => {
    const signals = withSignals([
      ['reply', target({ statusId: 's1', authorId: 'a', tags: ['vue'], language: 'en' })],
    ])
    const strength = ENGAGEMENT_STRENGTH.reply

    deriveAffinities(signals, NOW + DECAY_HALF_LIFE_MS)
    expect(signals.authorAffinity.a).toBeCloseTo(strength / 2, 10)
    expect(signals.tagAffinity.vue).toBeCloseTo(strength / 4, 10)
    expect(signals.languageAffinity.en).toBeCloseTo(strength / 8, 10)

    deriveAffinities(signals, NOW + 2 * DECAY_HALF_LIFE_MS)
    expect(signals.authorAffinity.a).toBeCloseTo(strength / 4, 10)

    // The factor itself is exact regardless of what survives the floor.
    expect(decayFactor(DECAY_HALF_LIFE_MS)).toBeCloseTo(0.5, 10)
    expect(decayFactor(3 * DECAY_HALF_LIFE_MS)).toBeCloseTo(0.125, 10)
  })

  it('is a pure function of (sequence, now), not of how often it runs', () => {
    const build = () => {
      const signals = createEmptySignals()
      for (let i = 0; i < 10; i++)
        recordSignal(signals, 'reply', target({ statusId: `s${i}`, authorId: 'a' }), NOW)
      return signals
    }
    const once = build()
    const stepwise = build()

    deriveAffinities(once, NOW + 4 * DECAY_HALF_LIFE_MS)
    for (let i = 1; i <= 40; i++)
      deriveAffinities(stepwise, NOW + (i / 10) * DECAY_HALF_LIFE_MS)

    expect(stepwise.authorAffinity.a).toBeCloseTo(once.authorAffinity.a!, 10)
    expect(once.authorAffinity.a).toBeCloseTo(10 * ENGAGEMENT_STRENGTH.reply / 16, 10)
  })

  it('lets a fresh interest overtake a stale one', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < 6; i++)
      recordSignal(signals, 'favourite', target({ statusId: `old${i}`, authorId: 'stale' }), NOW)
    recordSignal(signals, 'reply', target({ statusId: 'new', authorId: 'fresh' }), NOW + 60 * DAY)

    deriveAffinities(signals, NOW + 60 * DAY)
    // Two months on, six old favourites no longer clear the evidence floor at
    // all, while one fresh reply does: the feed moves on.
    expect(topAffinityKeys(signals.authorAffinity, 2)).toEqual(['fresh'])
    expect(signals.authorAffinity.stale).toBeUndefined()
  })

  it('skips the recompute when called again too soon, and does it once enough time passed', () => {
    const signals = withSignals([['favourite', target({ statusId: 's1', authorId: 'a' })]])
    expect(signals.lastDecay).toBe(NOW)

    expect(decaySignalsInPlace(signals, NOW + HOUR)).toBe(false)
    expect(signals.lastDecay).toBe(NOW)
    expect(signals.authorAffinity.a).toBe(1)

    expect(decaySignalsInPlace(signals, NOW + 7 * HOUR)).toBe(true)
    expect(signals.lastDecay).toBe(NOW + 7 * HOUR)
    expect(signals.authorAffinity.a).toBeLessThan(1)
  })

  it('derives on the very first pass instead of decaying from the epoch', () => {
    const signals = createEmptySignals()
    signals.engaged.favourite = [{ statusId: 's1', authorId: 'a', tags: [], at: NOW }]

    expect(signals.lastDecay).toBe(0)
    expect(decaySignalsInPlace(signals, NOW)).toBe(false)
    expect(signals.lastDecay).toBe(NOW)
    expect(signals.authorAffinity.a).toBe(1)
  })

  it('repairs a clock that moved backwards instead of freezing decay', () => {
    const signals = withSignals([['favourite', target({ statusId: 's1', authorId: 'a' })]])
    expect(signals.lastDecay).toBe(NOW)

    // Clock jumps back a year: the throttle must not wedge shut.
    expect(decaySignalsInPlace(signals, NOW - 365 * DAY)).toBe(true)
    expect(signals.lastDecay).toBe(NOW - 365 * DAY)

    // And it keeps working from there.
    expect(decaySignalsInPlace(signals, NOW - 365 * DAY + 7 * HOUR)).toBe(true)
  })

  it('treats a signal timestamped in the future as brand new, never as amplified', () => {
    expect(decayFactor(-DAY)).toBe(1)
    expect(decayFactor(0)).toBe(1)

    const signals = withSignals([['favourite', target({ statusId: 's1', authorId: 'a' })]], NOW + 365 * DAY)
    deriveAffinities(signals, NOW)
    expect(signals.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.favourite)
  })

  it('survives a clock far in the future: history is never destroyed, affinity comes back', () => {
    const signals = withSignals([['reply', target({ statusId: 's1', authorId: 'a', tags: ['vue'] })]])

    // A clock a year fast zeroes the derived maps...
    deriveAffinities(signals, NOW + 400 * DAY)
    expect(signals.authorAffinity.a).toBeUndefined()
    expect(signals.tagAffinity.vue).toBeUndefined()

    // ...but the sequence is intact, so a correct clock restores everything.
    expect(signals.engaged.reply!.length).toBe(1)
    deriveAffinities(signals, NOW)
    expect(signals.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.reply)
    expect(signals.tagAffinity.vue).toBe(ENGAGEMENT_STRENGTH.reply / 2)
  })
})

// ───────────────────────────────────────────────────────── seen ring buffer ──

describe('for-you signals: seen ring buffer', () => {
  it('keeps insertion order and evicts the oldest first', () => {
    const signals = createEmptySignals()
    markSeenInSignals(signals, Array.from({ length: MAX_SEEN + 500 }, (_, i) => `post-${i}`))

    expect(signals.seen.length).toBe(MAX_SEEN)
    expect(signals.seen[0]).toBe('post-500')
    expect(signals.seen.at(-1)).toBe(`post-${MAX_SEEN + 499}`)
    expect(signals.seen.includes('post-499')).toBe(false)
  })

  it('stays capped and deduped across many batches', () => {
    const signals = createEmptySignals()
    for (let batch = 0; batch < 20; batch++)
      markSeenInSignals(signals, Array.from({ length: 400 }, (_, i) => `b${batch}-${i}`))

    expect(signals.seen.length).toBe(MAX_SEEN)
    expect(new Set(signals.seen).size).toBe(MAX_SEEN)
  })

  it('keeps a caller-supplied index in sync incrementally, evictions included', () => {
    const signals = createEmptySignals()
    const index = new Set<string>()

    markSeenInSignals(signals, ['a', 'b', 'c'], index)
    expect(index).toEqual(new Set(['a', 'b', 'c']))

    // Re-seeing is a no-op, not a duplicate and not a reordering.
    markSeenInSignals(signals, ['a'], index)
    expect(signals.seen).toEqual(['a', 'b', 'c'])

    markSeenInSignals(signals, Array.from({ length: MAX_SEEN }, (_, i) => `x${i}`), index)
    expect(signals.seen.length).toBe(MAX_SEEN)
    expect(index.size).toBe(MAX_SEEN)
    // The evicted ids left the index too, so it cannot drift from the buffer.
    expect(index.has('a')).toBe(false)
    expect(index).toEqual(new Set(signals.seen))
  })

  it('ignores empty ids', () => {
    const signals = createEmptySignals()
    markSeenInSignals(signals, ['', 'a'])
    expect(signals.seen).toEqual(['a'])
  })
})

// ─────────────────────────────────────────────────────────── shape guard ──

describe('for-you signals: shape guard and migration', () => {
  it('repairs anything that is not a store at all', () => {
    for (const raw of [undefined, null, 42, 'nope', []]) {
      const { signals, changed } = normalizeSignals(raw)
      expect(changed).toBe(true)
      expect(signals).toEqual(createEmptySignals())
    }
  })

  it('fills in missing fields instead of throwing on them later', () => {
    const { signals, changed } = normalizeSignals({ version: SIGNALS_VERSION, authorAffinity: { a: 1 } })

    expect(changed).toBe(true)
    expect(signals.mutedForYou).toEqual([])
    expect(signals.notInterested).toEqual([])
    expect(signals.seen).toEqual([])
    expect(signals.dismissed).toEqual([])
    expect(signals.engaged).toEqual({})
    // Every downstream call that used to throw now works.
    expect(() => applyMuteToSignals(signals, 'a', NOW)).not.toThrow()
    expect(() => markSeenInSignals(signals, ['s1'])).not.toThrow()
    expect(() => deriveAffinities(signals, NOW)).not.toThrow()
  })

  it('drops malformed entries but keeps the good ones', () => {
    const { signals } = normalizeSignals({
      version: SIGNALS_VERSION,
      engaged: {
        favourite: [
          { statusId: 's1', authorId: 'a', tags: ['vue'], at: NOW },
          { statusId: 's2', at: 'yesterday' },
          { authorId: 'b', at: NOW },
          null,
          { statusId: 's3', tags: 'nope', at: NOW - 1 },
        ],
        nonsense: [{ statusId: 'x', tags: [], at: NOW }],
      },
      seen: ['a', 'a', 42, '', 'b'],
      mutedForYou: ['m', null],
      notInterested: [],
      dismissed: [],
      lastDecay: Number.NaN,
    })

    expect(signals.engaged.favourite!.map(s => s.statusId)).toEqual(['s1', 's3'])
    expect(signals.engaged.favourite![1]!.tags).toEqual([])
    expect((signals.engaged as Record<string, unknown>).nonsense).toBeUndefined()
    expect(signals.seen).toEqual(['a', 'b'])
    expect(signals.mutedForYou).toEqual(['m'])
    expect(signals.lastDecay).toBe(0)
  })

  it('migrates a v1 counter-only store: bookkeeping survives, derived maps do not', () => {
    const { signals, changed } = normalizeSignals({
      authorAffinity: { a: 12 },
      tagAffinity: { vue: 4 },
      languageAffinity: { en: 2 },
      seen: ['s1', 's2'],
      notInterested: ['s3'],
      mutedForYou: ['bad'],
      lastDecay: NOW,
    })

    expect(changed).toBe(true)
    expect(signals.version).toBe(SIGNALS_VERSION)
    // Counters are a lossy projection of a sequence and cannot be inverted.
    expect(signals.authorAffinity).toEqual({})
    expect(signals.tagAffinity).toEqual({})
    expect(signals.languageAffinity).toEqual({})
    // Bookkeeping is not derived, so it survives.
    expect(signals.seen).toEqual(['s1', 's2'])
    expect(signals.notInterested).toEqual(['s3'])
    expect(signals.mutedForYou).toEqual(['bad'])
  })

  it('leaves a healthy current-version store alone', () => {
    const stored = withSignals([['favourite', target({ statusId: 's1', authorId: 'a', tags: ['vue'] })]])
    markSeenInSignals(stored, ['s1'])

    const { signals, changed } = normalizeSignals(JSON.parse(JSON.stringify(stored)))
    expect(changed).toBe(false)
    expect(signals).toEqual(stored)
  })

  it('truncates oversized persisted lists', () => {
    const { signals } = normalizeSignals({
      version: SIGNALS_VERSION,
      engaged: {
        favourite: Array.from({ length: MAX_SIGNALS_PER_KIND + 30 }, (_, i) => ({
          statusId: `s${i}`,
          tags: [],
          at: NOW + i,
        })),
      },
      seen: Array.from({ length: MAX_SEEN + 40 }, (_, i) => `s${i}`),
      notInterested: [],
      mutedForYou: [],
      dismissed: [],
    })

    expect(signals.engaged.favourite!.length).toBe(MAX_SIGNALS_PER_KIND)
    expect(signals.seen.length).toBe(MAX_SEEN)
    // Oldest seen ids go first.
    expect(signals.seen[0]).toBe('s40')
  })
})

// ───────────────────────────────────────────────────────── retrieval seeds ──

describe('for-you signals: retrieval seeds', () => {
  it('returns the strongest positive affinities first', () => {
    const record = { a: 3, b: 9, c: -2, d: 5 }

    expect(topAffinityKeys(record, 2)).toEqual(['b', 'd'])
    expect(topAffinityKeys(record, 10)).toEqual(['b', 'd', 'a'])
    expect(topAffinityKeys(record, 0)).toEqual([])
    expect(topAffinityKeys(undefined, 5)).toEqual([])
  })

  it('accepts either a list or a set of exclusions', () => {
    const record = { a: 3, b: 9 }

    expect(topAffinityKeys(record, 5, ['b'])).toEqual(['a'])
    expect(topAffinityKeys(record, 5, new Set(['b']))).toEqual(['a'])
  })
})

// ──────────────────────────────────────────── follows are not a sequence ──

describe('for-you signals: follows are a set, not an engagement sequence', () => {
  it('does not evict follows at the engagement bucket size', () => {
    const signals = createEmptySignals()
    const count = MAX_SIGNALS_PER_KIND + 20
    for (let i = 0; i < count; i++) {
      recordSignal(signals, 'follow', {
        statusId: `follow:a${i}`,
        authorId: `a${i}`,
        tags: [],
      }, NOW + i)
    }

    expect(signals.engaged.follow!.length).toBe(count)
    // The very first follow is still there, and still counts.
    expect(signals.authorAffinity.a0).toBeCloseTo(ENGAGEMENT_STRENGTH.follow, 6)
    expect(maxSignalsFor('follow')).toBe(MAX_FOLLOW_SIGNALS)
    expect(maxSignalsFor('favourite')).toBe(MAX_SIGNALS_PER_KIND)
  })

  it('decays a follow on a seasonal horizon, not a fortnightly one', () => {
    const signals = withSignals([['follow', target({ statusId: 'follow:a', authorId: 'a' })]])

    deriveAffinities(signals, NOW + 100 * DAY)
    // Still most of its strength after three months.
    expect(signals.authorAffinity.a).toBeCloseTo(ENGAGEMENT_STRENGTH.follow * 2 ** (-100 / 180), 8)
    expect(signals.authorAffinity.a).toBeGreaterThan(3)

    expect(halfLifeFor('follow')).toBe(FOLLOW_HALF_LIFE_MS)
    expect(halfLifeFor('favourite')).toBe(DECAY_HALF_LIFE_MS)
  })

  it('lets one deliberate follow outrank fifty casual opens of a spammer', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < 50; i++)
      recordSignal(signals, 'open', target({ statusId: `s${i}`, authorId: 'spammer' }), NOW + i)
    recordSignal(signals, 'follow', { statusId: 'follow:friend', authorId: 'friend', tags: [] }, NOW)

    // Evidence saturates: four opens speak, the other forty-six do not.
    expect(signals.authorAffinity.spammer).toBe(EVIDENCE_CAP.open * ENGAGEMENT_STRENGTH.open)
    expect(signals.authorAffinity.friend).toBe(ENGAGEMENT_STRENGTH.follow)
    expect(topAffinityKeys(signals.authorAffinity, 2)).toEqual(['friend', 'spammer'])
  })

  it('still lets ten deliberate favourites outweigh one follow', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < 12; i++)
      recordSignal(signals, 'favourite', target({ statusId: `s${i}`, authorId: 'loved' }), NOW + i)
    recordSignal(signals, 'follow', { statusId: 'follow:friend', authorId: 'friend', tags: [] }, NOW)

    expect(signals.authorAffinity.loved).toBe(EVIDENCE_CAP.favourite * ENGAGEMENT_STRENGTH.favourite)
    expect(topAffinityKeys(signals.authorAffinity, 2)).toEqual(['loved', 'friend'])
  })
})

// ───────────────────────────────────────────────────────── evidence floor ──

describe('for-you signals: one incidental signal is not an affinity', () => {
  it('ignores a lone click, dwell or photo expand', () => {
    for (const kind of ['open', 'dwell', 'photoExpand', 'videoOpen', 'profileClick'] as const) {
      const signals = withSignals([[kind, target({ statusId: 's1', authorId: 'a', tags: ['vue'] })]])
      expect(signals.authorAffinity.a).toBeUndefined()
      expect(signals.tagAffinity.vue).toBeUndefined()
      // The evidence is kept, it just has not earned an entry yet.
      expect(signals.engaged[kind]!.length).toBe(1)
    }
  })

  it('counts a second occurrence, or any one deliberate act', () => {
    const twice = createEmptySignals()
    recordSignal(twice, 'open', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(twice.authorAffinity.a).toBeUndefined()
    recordSignal(twice, 'open', target({ statusId: 's2', authorId: 'a' }), NOW)
    expect(twice.authorAffinity.a).toBe(2 * ENGAGEMENT_STRENGTH.open)

    const deliberate = withSignals([['favourite', target({ statusId: 's1', authorId: 'b' })]])
    expect(deliberate.authorAffinity.b).toBe(ENGAGEMENT_STRENGTH.favourite)
  })

  it('does not apply the floor to negative evidence', () => {
    const signals = createEmptySignals()
    recordSignal(signals, 'notDwelled', target({ statusId: 's1', authorId: 'a' }), NOW)

    expect(ENGAGEMENT_STRENGTH.notDwelled).toBeLessThan(0)
    expect(signals.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.notDwelled)
    expect(MIN_EVIDENCE).toBeGreaterThan(Math.abs(ENGAGEMENT_STRENGTH.notDwelled))
  })
})

// ──────────────────────────────────────────────────────────────── dwell ──

describe('for-you signals: dwell', () => {
  it('classifies a reading by how long the post was in view', () => {
    // Too brief to mean anything — a fling, not a decision.
    expect(dwellSignalFor(0)).toBeUndefined()
    expect(dwellSignalFor(-5)).toBeUndefined()
    expect(dwellSignalFor(100)).toBeUndefined()

    // In view, but ignored: the negative half of the pair.
    expect(dwellSignalFor(500)).toEqual({ kind: 'notDwelled', weight: 1 })
    expect(dwellSignalFor(DWELL_MIN_MS - 1)).toEqual({ kind: 'notDwelled', weight: 1 })

    // Read: positive, and continuous in the duration.
    expect(dwellSignalFor(DWELL_MIN_MS)).toEqual({ kind: 'dwell', weight: 0.2 })
    expect(dwellSignalFor(DWELL_REFERENCE_MS)).toEqual({ kind: 'dwell', weight: 1 })
    expect(dwellSignalFor(2 * DWELL_REFERENCE_MS)).toEqual({ kind: 'dwell', weight: 2 })
  })

  it('saturates, so one abandoned tab cannot outweigh a history', () => {
    const capped = dwellSignalFor(24 * 60 * 60 * 1000)!
    expect(capped.kind).toBe('dwell')
    expect(capped.weight).toBe(DWELL_SATURATION_MS / DWELL_REFERENCE_MS)
  })

  it('scales the stored contribution by the magnitude', () => {
    const brief = withSignals([['dwell', target({ statusId: 's1', authorId: 'a', weight: 1 })]])
    const long = withSignals([['dwell', target({ statusId: 's1', authorId: 'a', weight: 6 })]])

    expect(brief.authorAffinity.a).toBeUndefined() // 0.25, under the floor
    expect(long.authorAffinity.a).toBe(6 * ENGAGEMENT_STRENGTH.dwell)
  })

  it('accumulates negative evidence at impression volume', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < 20; i++)
      recordSignal(signals, 'notDwelled', target({ statusId: `s${i}`, authorId: 'boring' }), NOW + i)

    // Capped, but decidedly negative: "shown twenty times, read never".
    expect(signals.authorAffinity.boring).toBeCloseTo(EVIDENCE_CAP.notDwelled * ENGAGEMENT_STRENGTH.notDwelled, 6)
    expect(topAffinityKeys(signals.authorAffinity, 5)).toEqual([])
  })
})

// ────────────────────────────────────────────────── dwell tracker, abuse ──

// `flush()` is deliberately left untested here: it calls `recordDwell`, which
// goes through `useForYouSignals()` and the rest of the Nuxt-only reactive
// surface. Everything worth asserting about the abuse guards — accumulation,
// the saturation cap, and the visibility pause — is observable through
// `enter`/`exit`/`.visibleMs` alone, which is the pure part of the tracker.
describe('for-you signals: createDwellTracker, the abuse guards', () => {
  it('accumulates across repeated enter/exit pairs', () => {
    const dwell = createDwellTracker(status('s1'))
    dwell.enter(NOW)
    dwell.exit(NOW + 3000)
    dwell.enter(NOW + 5000)
    dwell.exit(NOW + 9000)
    expect(dwell.visibleMs).toBe(3000 + 4000)
  })

  it('exit without a matching enter, or a repeated enter, does not corrupt the reading', () => {
    const dwell = createDwellTracker(status('s1'))
    // Never entered: nothing to accumulate, and no negative reading.
    expect(dwell.exit(NOW)).toBe(0)
    dwell.enter(NOW)
    // A second `enter` while already timing (two IntersectionObserver
    // callbacks in a row) must not restart the clock and drop the elapsed
    // time between them.
    dwell.enter(NOW + 1000)
    expect(dwell.exit(NOW + 2000)).toBe(2000)
  })

  it('caps a single accumulation at DWELL_SATURATION_MS, defense in depth against a stuck timer', () => {
    const dwell = createDwellTracker(status('s1'))
    dwell.enter(NOW)
    dwell.exit(NOW + 10 * DWELL_SATURATION_MS)
    expect(dwell.visibleMs).toBe(DWELL_SATURATION_MS)
  })

  it('never starts the timer while the tab is backgrounded', () => {
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      const dwell = createDwellTracker(status('s1'))
      // The post is "intersecting" by every measure the observer has, but the
      // document is hidden the whole time: none of it is attention.
      dwell.enter(NOW)
      expect(dwell.exit(NOW + 30_000)).toBe(0)
    }
    finally {
      if (original)
        Object.defineProperty(document, 'visibilityState', original)
    }
  })

  it('pauses on visibilitychange and resumes when the tab returns, banking neither the hidden stretch', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let hidden = false
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    try {
      const dwell = createDwellTracker(status('s1'))
      dwell.enter()

      // Visible for 5s, then the tab is backgrounded for a full minute — that
      // minute must not count, however long the post stays "intersecting".
      vi.setSystemTime(NOW + 5000)
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      vi.setSystemTime(NOW + 65_000)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))

      // Foregrounded again for 3 more seconds.
      vi.setSystemTime(NOW + 68_000)
      expect(dwell.exit()).toBe(5000 + 3000)
    }
    finally {
      if (original)
        Object.defineProperty(document, 'visibilityState', original)
      vi.useRealTimers()
    }
  })
})

// ───────────────────────────────────────── negative signal, wired for use ──

// `feed.ts`'s `affinityResolver` is what actually wires this into the
// ranker (`authorPenaltyIn` for the author half, `notInterested` for the
// post half, plus `booster` and error-safe degradation `authorPenaltyIn`
// alone does not need to provide) — `signals.ts` used to export a second,
// narrower resolver doing the same job under a stale 2-arg
// `authorPenalty(accountId, statusId)` shape; it was deleted as dead code
// rather than updated, since `feed.ts` already covers everything it did.
// What's left to unit-test at this layer is the primitive both would have
// shared: `authorPenaltyIn` itself.
describe('for-you signals: authorPenaltyIn, what the ranker\'s resolver wraps', () => {
  it('counts dismissals of an author\'s OTHER posts, which `notInterested` alone cannot', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    applyNotInterestedToSignals(signals, 's2', target({ statusId: 's2', authorId: 'a' }), NOW)

    // A post never itself dismissed, by the same repeatedly-dismissed author.
    expect(authorPenaltyIn(signals, 'a', NOW)).toBeGreaterThan(0.5)
    expect(authorPenaltyIn(signals, 'a', NOW)).toBeLessThan(1)
    // Someone else is unaffected.
    expect(authorPenaltyIn(signals, 'b', NOW)).toBe(0)
  })

  it('treats a For You mute as absolute', () => {
    const signals = createEmptySignals()
    applyMuteToSignals(signals, 'a', NOW)

    expect(authorPenaltyIn(signals, 'a', NOW)).toBe(1)
  })

  it('works on a bare ForYouSignals with no history at all', () => {
    const bare = { ...createEmptySignals() } as Record<string, unknown>
    delete bare.dismissed
    delete bare.notInterested

    expect(authorPenaltyIn(bare as never, 'a', NOW)).toBe(0)
  })
})

// ──────────────────────────────────────────────── undoing a dismissal ──

describe('for-you signals: forgetNotInterestedToSignals undoes a dismissal', () => {
  it('is a real deletion — the entry is gone from both lists, not offset by a compensating record', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)

    expect(signals.notInterested).toContain('s1')
    expect(signals.dismissed.some(entry => entry.statusId === 's1')).toBe(true)
    expect(signals.authorAffinity.a).toBeLessThan(0)

    forgetNotInterestedToSignals(signals, 's1', NOW)

    expect(signals.notInterested).not.toContain('s1')
    // Deleted, not merely outweighed: the sequence itself is shorter, there is
    // no second entry sitting alongside it.
    expect(signals.dismissed).toEqual([])
    expect(signals.authorAffinity.a).toBeUndefined()
  })

  it('leaves an author\'s other dismissals untouched', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    applyNotInterestedToSignals(signals, 's2', target({ statusId: 's2', authorId: 'a' }), NOW)

    forgetNotInterestedToSignals(signals, 's1', NOW)

    expect(signals.notInterested).toEqual(['s2'])
    expect(signals.dismissed.map(entry => entry.statusId)).toEqual(['s2'])
    // Still negative — one dismissal remains — just weaker than with both.
    expect(signals.authorAffinity.a).toBeLessThan(0)
  })

  it('does not touch `seen`: the post really was shown, undoing the dismissal does not change that', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(signals.seen).toContain('s1')

    forgetNotInterestedToSignals(signals, 's1', NOW)

    expect(signals.seen).toContain('s1')
  })

  it('is a no-op for a post that was never dismissed', () => {
    const signals = createEmptySignals()
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)
    const before = JSON.parse(JSON.stringify(signals))

    forgetNotInterestedToSignals(signals, 'never-dismissed', NOW)

    expect(signals).toEqual(before)
  })

  it('is a no-op for an empty statusId', () => {
    const signals = createEmptySignals()
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    const before = JSON.parse(JSON.stringify(signals))

    forgetNotInterestedToSignals(signals, '', NOW)

    expect(signals).toEqual(before)
  })
})

// ────────────────────────────────────────────── shape guard, deep version ──

describe('for-you signals: the shape guard compares deeply', () => {
  it('reports a malformed inner signal even when the outer shape is perfect', () => {
    const stored = withSignals([['favourite', target({ statusId: 's1', authorId: 'a' })]])
    const raw = JSON.parse(JSON.stringify(stored))
    // Exactly the blob that used to slip through and blow up on `signal.tags`.
    delete raw.engaged.favourite[0].tags

    const { signals, changed } = normalizeSignals(raw)

    expect(changed).toBe(true)
    expect(signals.engaged.favourite![0]!.tags).toEqual([])
    expect(() => deriveAffinities(signals, NOW)).not.toThrow()
  })

  it('reports an out-of-order or duplicated sequence', () => {
    const stored = withSignals([['favourite', target({ statusId: 's1', authorId: 'a' })]])
    const raw = JSON.parse(JSON.stringify(stored))
    raw.engaged.favourite.push({ ...raw.engaged.favourite[0] })

    expect(normalizeSignals(raw).changed).toBe(true)
    expect(normalizeSignals(raw).signals.engaged.favourite!.length).toBe(1)
  })

  it('is idempotent, which is what makes identity caching sound', () => {
    const stored = withSignals([
      ['favourite', target({ statusId: 's1', authorId: 'a', tags: ['vue'], language: 'en' })],
      ['dwell', target({ statusId: 's2', authorId: 'b', weight: 3 })],
    ])
    markSeenInSignals(stored, ['s1', 's2'])
    applyNotInterestedToSignals(stored, 's3', target({ statusId: 's3', authorId: 'c' }), NOW)

    const first = normalizeSignals(JSON.parse(JSON.stringify(stored)))
    const second = normalizeSignals(JSON.parse(JSON.stringify(first.signals)))

    expect(first.changed).toBe(false)
    expect(second.changed).toBe(false)
    expect(second.signals).toEqual(first.signals)
  })
})

// ──────────────────────────────── counters and the impression population ──
// INTERCEPT.md §3, "the population trap" — the regression tests that matter
// most: the numerator (`counters.actions`) and denominator
// (`counters.impressions`/`eligible`) must cover exactly the same set of
// posts, which is what `impressed` exists to guarantee.

describe('for-you signals: counters and the impression population (the population trap)', () => {
  it('markSeenInSignals — the masto/routes.ts style call — moves neither impressions nor impressed; the impression call does both', () => {
    const signals = createEmptySignals()

    // `masto/routes.ts:98`'s status-detail navigation goes through
    // `markSeenInSignals` alone, exactly like this.
    markSeenInSignals(signals, ['s1'])
    expect(signals.seen).toEqual(['s1'])
    expect(signals.counters.impressions).toBe(0)
    expect(signals.counters.eligible).toEqual({ hasLink: 0, hasMedia: 0, outOfNetwork: 0 })
    expect(signals.impressed).toEqual([])

    // The For You call site records both.
    recordForYouImpressionInSignals(signals, { id: 's2', hasLink: true, hasMedia: false, outOfNetwork: true })
    expect(signals.counters.impressions).toBe(1)
    expect(signals.counters.eligible).toEqual({ hasLink: 1, hasMedia: 0, outOfNetwork: 1 })
    expect(signals.impressed).toEqual(['s2'])
  })

  it('accepts a bare status too, deriving hasLink/hasMedia the way ranking.ts\'s extractRankingFeatures does', () => {
    const signals = createEmptySignals()
    const withCardAndMedia = {
      ...status('s1'),
      card: { url: 'https://example.com' },
      mediaAttachments: [{ type: 'image' }],
    } as unknown as mastodon.v1.Status

    recordForYouImpressionInSignals(signals, withCardAndMedia)

    expect(signals.impressed).toEqual(['s1'])
    expect(signals.counters.eligible.hasLink).toBe(1)
    expect(signals.counters.eligible.hasMedia).toBe(1)
    // A bare status carries no relationship context, so it is treated as
    // in-network rather than guessed at.
    expect(signals.counters.eligible.outOfNetwork).toBe(0)
  })

  it('eligible counters increment only for eligible impressions, and a repeated impression of the same post does not double-count', () => {
    const signals = createEmptySignals()
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: true, hasMedia: false, outOfNetwork: false })
    recordForYouImpressionInSignals(signals, { id: 's2', hasLink: false, hasMedia: true, outOfNetwork: true })
    // A rapid re-fire of the intersection latch for the same post.
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: true, hasMedia: false, outOfNetwork: false })

    expect(signals.impressed).toEqual(['s1', 's2'])
    expect(signals.counters.impressions).toBe(2)
    expect(signals.counters.eligible).toEqual({ hasLink: 1, hasMedia: 1, outOfNetwork: 1 })
  })

  it('an action on a status never impressed does not increment its counter, but still records the signal completely normally', () => {
    const signals = createEmptySignals()
    // No impression was ever recorded for 's1' — e.g. a favourite reached
    // through notifications or search, not the For You feed.
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)

    expect(signals.counters.actions.favourite).toBeUndefined()
    // The gate only touches the counter: affinity behaviour is unchanged.
    expect(signals.engaged.favourite!.length).toBe(1)
    expect(signals.engaged.favourite![0]!.statusId).toBe('s1')
    expect(signals.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.favourite)
  })

  it('increments an action counter only once the post has been impressed', () => {
    const signals = createEmptySignals()
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: false, hasMedia: false, outOfNetwork: false })
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)

    expect(signals.counters.actions.favourite).toBe(1)
  })

  it('forgetSignal decrements the matching counter, gated the same way the increment was', () => {
    const signals = createEmptySignals()
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: false, hasMedia: false, outOfNetwork: false })
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(signals.counters.actions.favourite).toBe(1)

    forgetSignal(signals, 'favourite', 's1', NOW)
    expect(signals.counters.actions.favourite).toBeUndefined()
  })

  it('floors at 0 rather than going negative when a retraction is gated-in but was never gated-in on the way up', () => {
    const signals = createEmptySignals()
    // Favourited *before* the impression was ever recorded: the increment in
    // `recordSignal` was correctly skipped.
    recordSignal(signals, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(signals.counters.actions.favourite).toBeUndefined()

    // The post becomes impressed afterwards (e.g. it resurfaces on a later
    // page), so `forgetSignal`'s gate now passes even though the matching
    // increment never happened.
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: false, hasMedia: false, outOfNetwork: false })
    forgetSignal(signals, 'favourite', 's1', NOW)

    expect(signals.counters.actions.favourite).toBeUndefined()
  })

  it('forgetNotInterestedToSignals decrements the dismiss counter, gated and floored the same way', () => {
    const signals = createEmptySignals()
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: false, hasMedia: false, outOfNetwork: false })
    applyNotInterestedToSignals(signals, 's1', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(signals.counters.actions.dismiss).toBe(1)

    forgetNotInterestedToSignals(signals, 's1', NOW)
    expect(signals.counters.actions.dismiss).toBeUndefined()

    // Undoing again is a no-op, not a negative counter.
    forgetNotInterestedToSignals(signals, 's1', NOW)
    expect(signals.counters.actions.dismiss).toBeUndefined()
  })

  it('gates the mute counter on an explicit statusId, so an account-wide mute/block (no statusId) never counts', () => {
    const signals = createEmptySignals()
    recordForYouImpressionInSignals(signals, { id: 's1', hasLink: false, hasMedia: false, outOfNetwork: false })

    // `relationship.ts`'s `toggleMuteAccount`/`toggleBlockAccount` call
    // `applyMuteToSignals` with no `statusId` — reachable from any surface,
    // nothing to do with this feed.
    applyMuteToSignals(signals, 'account-a', NOW)
    expect(signals.counters.actions.mute).toBeUndefined()

    // `TimelineForYouItem.vue`'s "show less from author" passes the post's
    // own key, which is impressed.
    applyMuteToSignals(signals, 'account-b', NOW, 's1')
    expect(signals.counters.actions.mute).toBe(1)
  })

  it('impressed evicts oldest-first at MAX_SEEN, like seen — but impressions itself is a lifetime count, never evicted', () => {
    const signals = createEmptySignals()
    for (let i = 0; i < MAX_SEEN + 500; i++)
      recordForYouImpressionInSignals(signals, { id: `p${i}`, hasLink: false, hasMedia: false, outOfNetwork: false })

    expect(signals.impressed.length).toBe(MAX_SEEN)
    expect(signals.impressed[0]).toBe('p500')
    expect(signals.impressed.includes('p499')).toBe(false)
    expect(signals.counters.impressions).toBe(MAX_SEEN + 500)
  })

  it('keeps a caller-supplied index in sync incrementally, evictions included, mirroring markSeenInSignals', () => {
    const signals = createEmptySignals()
    const index = new Set<string>()

    recordForYouImpressionInSignals(signals, { id: 'a', hasLink: false, hasMedia: false, outOfNetwork: false }, index)
    recordForYouImpressionInSignals(signals, { id: 'b', hasLink: false, hasMedia: false, outOfNetwork: false }, index)
    expect(index).toEqual(new Set(['a', 'b']))

    // Re-impressing is a no-op through the supplied index too.
    recordForYouImpressionInSignals(signals, { id: 'a', hasLink: false, hasMedia: false, outOfNetwork: false }, index)
    expect(signals.impressed).toEqual(['a', 'b'])
    expect(signals.counters.impressions).toBe(2)
  })

  it('counters and impressed survive a SIGNALS_VERSION bump; affinity maps still do not', () => {
    const stored = createEmptySignals()
    recordForYouImpressionInSignals(stored, { id: 's1', hasLink: true, hasMedia: false, outOfNetwork: true })
    recordSignal(stored, 'favourite', target({ statusId: 's1', authorId: 'a' }), NOW)
    expect(stored.counters.actions.favourite).toBe(1)
    expect(stored.authorAffinity.a).toBe(ENGAGEMENT_STRENGTH.favourite)

    // A blob written by an older version of the store.
    const raw = { ...JSON.parse(JSON.stringify(stored)), version: 1 }
    const { signals, changed } = normalizeSignals(raw)

    expect(changed).toBe(true)
    expect(signals.version).toBe(SIGNALS_VERSION)
    // Raw observations: kept.
    expect(signals.counters).toEqual(stored.counters)
    expect(signals.impressed).toEqual(stored.impressed)
    // Derived affinity maps: dropped, same as any other stale-version read.
    expect(signals.authorAffinity).toEqual({})
  })

  it('normalizeCounters coerces non-finite/negative values to 0 and drops unknown action keys', () => {
    const { signals } = normalizeSignals({
      version: SIGNALS_VERSION,
      counters: {
        impressions: -5,
        eligible: { hasLink: Number.NaN, hasMedia: 3, outOfNetwork: -1 },
        actions: { favourite: 4, bogus: 9, dismiss: -2 },
      },
      impressed: ['s1', 's1', ''],
    })

    expect(signals.counters.impressions).toBe(0)
    expect(signals.counters.eligible).toEqual({ hasLink: 0, hasMedia: 3, outOfNetwork: 0 })
    expect(signals.counters.actions).toEqual({ favourite: 4 })
    expect(signals.impressed).toEqual(['s1'])
  })

  it('defaults absent counters/impressed to zero/empty rather than throwing', () => {
    const { signals } = normalizeSignals({ version: SIGNALS_VERSION })

    expect(signals.counters).toEqual({
      impressions: 0,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 0 },
      actions: {},
    })
    expect(signals.impressed).toEqual([])
  })
})
