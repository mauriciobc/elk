import type { ForYouCounters } from '../../app/composables/for-you/types'
import { describe, expect, it } from 'vitest'
import {
  BASE_RATE_PRIOR_STRENGTH,
  denominatorFor,
  measuredBaseRates,
  measuredBaseRatesReport,
} from '../../app/composables/for-you/base-rates'
import { BASE_RATES } from '../../app/composables/for-you/ranking'

function counters(overrides: Partial<ForYouCounters> = {}): ForYouCounters {
  return {
    impressions: 0,
    eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 0 },
    actions: {},
    ...overrides,
  }
}

function headReport(report: ReturnType<typeof measuredBaseRatesReport>, head: keyof typeof BASE_RATES) {
  const row = report.perHead.find(r => r.head === head)
  if (!row)
    throw new Error(`no perHead row for ${head}`)
  return row
}

// ─────────────────────────────────────────────────────────────  cold path ──

describe('measuredBaseRates — cold path', () => {
  it('returns the shipped object itself when counters is undefined', () => {
    expect(measuredBaseRates(undefined)).toBe(BASE_RATES)
  })

  it('returns the shipped object itself when impressions is zero', () => {
    const c = counters({ impressions: 0, actions: { favourite: 5 } })
    expect(measuredBaseRates(c)).toBe(BASE_RATES)
  })

  it('respects a custom shipped default on the cold path, still by identity', () => {
    const shipped = { ...BASE_RATES, favorite: 0.5 }
    expect(measuredBaseRates(undefined, shipped)).toBe(shipped)
  })
})

// ───────────────────────────────────────────────────────  shrinkage math ──

describe('measuredBaseRatesReport — per-head shrinkage', () => {
  it('s → 0 recovers k/n exactly', () => {
    const c = counters({ impressions: 1000, actions: { favourite: 15 } })
    const report = measuredBaseRatesReport(c, BASE_RATES, 0)
    expect(headReport(report, 'favorite').measured).toBeCloseTo(15 / 1000, 12)
  })

  it('n === s lands exactly halfway between k/n and B0', () => {
    const s = BASE_RATE_PRIOR_STRENGTH
    const c = counters({ impressions: s, actions: { favourite: 100 } })
    const report = measuredBaseRatesReport(c, BASE_RATES, s)
    const kOverN = 100 / s
    const expected = (kOverN + BASE_RATES.favorite) / 2
    expect(headReport(report, 'favorite').measured).toBeCloseTo(expected, 12)
  })

  it('a head with no eligible impressions yet gets a denominator of 0, which recovers B0', () => {
    // `denominatorFor` is unreachable from `measuredBaseRatesReport` today —
    // all three conditionally-gated heads are unwired — so it is tested
    // directly. It has to stay correct: the moment a call site is added, this
    // is the function that keeps the head from being deflated by the share of
    // impressions that could never have produced the action.
    const c = counters({
      impressions: 5000,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 0 },
    })
    expect(denominatorFor('openLink', c)).toBe(0)

    // And with n = 0 the shrinkage collapses to B0 exactly, which is the
    // property that makes a not-yet-seen conditional head safe to serve.
    const s = BASE_RATE_PRIOR_STRENGTH
    expect((0 + s * BASE_RATES.openLink) / (0 + s)).toBe(BASE_RATES.openLink)
  })
})

// ────────────────────────────────────────────────────  eligible denominators ──

describe('measuredBaseRatesReport — conditional heads use the eligible denominator', () => {
  it('maps openLink to eligible.hasLink, never impressions', () => {
    // impressions is 100x eligible.hasLink — if the denominator bug crept in,
    // a wired `openLink` would read two orders of magnitude too small. Both
    // source docs call this the single most-likely regression.
    const c = counters({
      impressions: 5000,
      eligible: { hasLink: 50, hasMedia: 0, outOfNetwork: 0 },
    })
    expect(denominatorFor('openLink', c)).toBe(50)
    expect(denominatorFor('openLink', c)).not.toBe(5000)
  })

  it('maps photoExpand and videoOpen to eligible.hasMedia, never impressions', () => {
    const c = counters({
      impressions: 8000,
      eligible: { hasLink: 0, hasMedia: 40, outOfNetwork: 0 },
    })
    expect(denominatorFor('photoExpand', c)).toBe(40)
    expect(denominatorFor('videoOpen', c)).toBe(40)
    expect(denominatorFor('favorite', c)).toBe(8000)
  })

  it('does not shrink followAuthor at all — its numerator is structurally dead', () => {
    // `recordFollow` stores a synthetic `follow:<accountId>` key that can
    // never be in `impressed`, so the membership gate rejects every follow and
    // `actions.follow` is zero forever rather than merely under-sampled.
    // Shrinking `k = 0` over a growing `eligible.outOfNetwork` would decay the
    // head toward zero without bound (7x too small at n=3000, 61x at n=30000),
    // so the head is treated as unmeasurable instead. `INTERCEPT.md` §4 lists
    // it as measurable; this is a deliberate departure, documented on
    // `UNMEASURABLE_HEADS`.
    const c = counters({
      impressions: 6000,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 20 },
      // Even if a follow somehow were counted, it must not become a rate.
      actions: { follow: 1 },
    })
    const report = measuredBaseRatesReport(c)
    const row = headReport(report, 'followAuthor')
    expect(row.k).toBe(0)
    expect(row.n).toBe(0)
  })

  it('lets followAuthor move only by the §6 positive-side rescale', () => {
    // Same treatment as `share`/`vqv`: it tracks its side, never its own k/n.
    const c = counters({
      impressions: 3000,
      eligible: { hasLink: 300, hasMedia: 300, outOfNetwork: 3000 },
      actions: { favourite: 90, reblog: 54, open: 90, notDwelled: 660 },
    })
    const report = measuredBaseRatesReport(c)
    expect(report.applied).toBe(true)
    const ratioToShare = headReport(report, 'followAuthor').measured / headReport(report, 'share').measured
    const shippedRatio = BASE_RATES.followAuthor / BASE_RATES.share
    expect(ratioToShare).toBeCloseTo(shippedRatio, 12)
  })

  it('does not decay any unwired head as impressions pile up', () => {
    // The same structural-zero problem `followAuthor` has, for four more
    // heads: nothing in `app/` records a link click, photo expand, video open
    // or profile tap, so their counters are pinned at 0 while their
    // denominators climb. Measured on a realistic profile before the fix:
    // openLink/photoExpand/videoOpen 7x low at n=30000, profileClick 61x.
    // `N/P` stays in band throughout, so the §6.3 guardrail never fires — the
    // only thing standing between this and a silently deflated ranker is this
    // classification.
    const honest = (n: number) => {
      const media = Math.round(n / 10)
      return measuredBaseRatesReport(counters({
        impressions: n,
        eligible: { hasLink: media, hasMedia: media, outOfNetwork: n },
        // Exactly the signals that have a writer in the app today.
        actions: {
          favourite: n * BASE_RATES.favorite,
          reply: n * BASE_RATES.reply,
          reblog: n * BASE_RATES.retweet,
          quote: n * BASE_RATES.quote,
          open: n * BASE_RATES.click,
          dwell: n * BASE_RATES.dwell,
          notDwelled: n * BASE_RATES.notDwelled,
          dismiss: n * BASE_RATES.notInterested,
          mute: n * BASE_RATES.muteAuthor,
        },
      }))
    }

    for (const n of [3000, 30_000]) {
      const report = honest(n)
      expect(report.applied).toBe(true)
      for (const head of ['openLink', 'photoExpand', 'videoOpen', 'profileClick', 'followAuthor'] as const) {
        const row = headReport(report, head)
        // Never given a denominator, so never shrunk toward zero.
        expect(row.k).toBe(0)
        expect(row.n).toBe(0)
        expect(row.measured).toBeCloseTo(BASE_RATES[head], 12)
      }
    }
  })

  it('does not decay followAuthor as out-of-network impressions pile up', () => {
    // The regression this fix exists to prevent. Every measurable head is held
    // at exactly its shipped rate, so shrinkage is a no-op and both side sums
    // are unchanged — which pins the §6 rescale factors at 1 and leaves
    // `followAuthor` sitting on `B0` no matter how large `n` gets. Under the
    // old treatment (k=0 over a growing `eligible.outOfNetwork`) the same
    // fixture drove it 7x low at n=3000 and 61x low at n=30000.
    const at = (n: number) => {
      const media = Math.round(n / 10)
      return measuredBaseRatesReport(counters({
        impressions: n,
        eligible: { hasLink: media, hasMedia: media, outOfNetwork: n },
        actions: {
          favourite: n * BASE_RATES.favorite,
          reply: n * BASE_RATES.reply,
          reblog: n * BASE_RATES.retweet,
          quote: n * BASE_RATES.quote,
          open: n * BASE_RATES.click,
          profileClick: n * BASE_RATES.profileClick,
          dwell: n * BASE_RATES.dwell,
          notDwelled: n * BASE_RATES.notDwelled,
          dismiss: n * BASE_RATES.notInterested,
          mute: n * BASE_RATES.muteAuthor,
          openLink: media * BASE_RATES.openLink,
          photoExpand: media * BASE_RATES.photoExpand,
          videoOpen: media * BASE_RATES.videoOpen,
        },
      }))
    }

    const small = at(3000)
    const large = at(30_000)
    expect(small.applied).toBe(true)
    expect(large.applied).toBe(true)

    // Unchanged from shipped at both sizes, and identical to each other.
    expect(headReport(small, 'followAuthor').measured).toBeCloseTo(BASE_RATES.followAuthor, 12)
    expect(headReport(large, 'followAuthor').measured).toBeCloseTo(BASE_RATES.followAuthor, 12)
  })

  it('divides every other measurable head by impressions', () => {
    const c = counters({
      impressions: 3000,
      eligible: { hasLink: 999, hasMedia: 999, outOfNetwork: 999 },
      actions: { favourite: 90, reblog: 54, reply: 10 },
    })
    const report = measuredBaseRatesReport(c)
    expect(headReport(report, 'favorite').n).toBe(3000)
    expect(headReport(report, 'retweet').n).toBe(3000)
    expect(headReport(report, 'reply').n).toBe(3000)
  })
})

// ───────────────────────────────────────────────  unmeasurable heads (§6) ──

describe('measuredBaseRatesReport — unmeasurable heads move only via the §6 rescale', () => {
  it('preserves the shipped ratio between two heads on the same side', () => {
    // share and vqv are both unmeasurable and both on the positive side
    // (positive weight in MASTODON_WEIGHTS), so both must be scaled by the
    // exact same positiveFactor — their ratio to each other must be
    // untouched even though their absolute values move.
    const c = counters({
      impressions: 3000,
      eligible: { hasLink: 1000, hasMedia: 1500, outOfNetwork: 3000 },
      actions: {
        favourite: 200, // well above shipped k (90) to force a real move
        reblog: 54,
        reply: 10,
        quote: 2,
        open: 90,
        openLink: 12,
        profileClick: 15,
        photoExpand: 30,
        videoOpen: 30,
        dwell: 0,
        notDwelled: 660,
        follow: 2,
        dismiss: 0,
        mute: 0,
      },
    })
    const report = measuredBaseRatesReport(c)
    const share = headReport(report, 'share').measured
    const vqv = headReport(report, 'vqv').measured
    expect(share / vqv).toBeCloseTo(BASE_RATES.share / BASE_RATES.vqv, 10)

    // blockAuthor and report are both unmeasurable and both negative — same
    // invariant on the other side.
    const blockAuthor = headReport(report, 'blockAuthor').measured
    const reportHead = headReport(report, 'report').measured
    expect(blockAuthor / reportHead).toBeCloseTo(BASE_RATES.blockAuthor / BASE_RATES.report, 10)
  })

  it('never assigns an unmeasurable head its own k/n — it only ever moves as a multiple of B0', () => {
    const c = counters({
      impressions: 3000,
      eligible: { hasLink: 1000, hasMedia: 1500, outOfNetwork: 3000 },
      actions: { favourite: 200, reblog: 54 },
    })
    const report = measuredBaseRatesReport(c)
    for (const head of ['share', 'vqv', 'blockAuthor', 'report'] as const) {
      const row = headReport(report, head)
      expect(row.k).toBe(0)
      expect(row.n).toBe(0)
      // measured must be an exact multiple of the shipped value (the rescale
      // factor), never an independently-shrunk number.
      expect(row.measured / BASE_RATES[head]).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────  self-regulation ──

describe('measuredBaseRatesReport — shrinkage is self-regulating', () => {
  it('pins a near-zero-k head close to its prior while a well-observed head moves freely', () => {
    // Same n and s for both heads — the only difference is k. muteAuthor at
    // k=0 barely moves off B0 in absolute terms; favorite at k=200 (far off
    // its shipped implied count of 90 at n=3000) moves substantially. This is
    // the "no head needs hand-classifying" claim from INTERCEPT-BUILD.md.
    const c = counters({
      impressions: 3000,
      actions: { favourite: 200, mute: 0 },
    })
    const report = measuredBaseRatesReport(c)
    const mute = headReport(report, 'muteAuthor')
    const favorite = headReport(report, 'favorite')

    expect(Math.abs(mute.measured - BASE_RATES.muteAuthor)).toBeLessThan(0.0001)
    expect(Math.abs(favorite.measured - BASE_RATES.favorite)).toBeGreaterThan(0.01)
  })
})

// ──────────────────────────────────────────────────────────────  guardrail ──

describe('measuredBaseRatesReport — the §6.3 guardrail', () => {
  it('falls back to shipped by identity when N/P is driven out of [0.1, 0.4]', () => {
    // Blow up the measurable negative heads (muteAuthor, notInterested) far
    // past anything the prior would produce. The rescale then drags the
    // unmeasurable negatives (blockAuthor, report) up by the same factor, so
    // the negative side dwarfs the positive side and N/P blows past 0.4.
    const c = counters({
      impressions: 5000,
      actions: {
        favourite: 90,
        mute: 4000,
        dismiss: 4000,
      },
    })
    const report = measuredBaseRatesReport(c)
    expect(report.applied).toBe(false)
    expect(report.rates).toBe(BASE_RATES)
    expect(report.ratio).toBeGreaterThan(0.4)
  })

  it('leaves rates within band alone (applied) for a sample matching the shipped rates exactly', () => {
    // Every measurable head's k is set to exactly n * B0 (n = s = 500, so
    // each shrinks to precisely B0 regardless of the prior weight) — except
    // notInterested and muteAuthor, whose *expected* count at n=500 is a
    // fraction well under 1 (0.06 and 0.01), so the only honest integer
    // count for them is 0. That alone pulls the negative side down enough to
    // move the ratio without leaving the guardrail's band, which is exactly
    // the "no head needs hand-classifying" behaviour INTERCEPT-BUILD.md
    // describes: the two rarest negatives self-regulate instead of blowing
    // the valve open.
    const c = counters({
      impressions: 500,
      eligible: { hasLink: 500, hasMedia: 500, outOfNetwork: 500 },
      actions: {
        favourite: 15,
        reply: 1.75,
        reblog: 9,
        quote: 0.3,
        open: 15,
        openLink: 6,
        profileClick: 2.5,
        photoExpand: 10,
        videoOpen: 10,
        notDwelled: 110,
        follow: 0.3,
        dismiss: 0,
        mute: 0,
      },
    })
    const report = measuredBaseRatesReport(c)
    expect(report.applied).toBe(true)
    expect(report.rates).not.toBe(BASE_RATES)
    expect(report.ratio).toBeGreaterThanOrEqual(0.1)
    expect(report.ratio).toBeLessThanOrEqual(0.4)
    // The positive side matches shipped exactly by construction; only the
    // negative side (and the two unmeasurable heads it drags along) moved.
    expect(report.rates.favorite).toBeCloseTo(BASE_RATES.favorite, 12)
    expect(report.rates.muteAuthor).toBeLessThan(BASE_RATES.muteAuthor)
  })
})

// ────────────────────────────────────────────────  measuredBaseRates == report.rates ──

describe('measuredBaseRates', () => {
  it('is exactly measuredBaseRatesReport(...).rates', () => {
    const c = counters({ impressions: 3000, actions: { favourite: 90 } })
    expect(measuredBaseRates(c)).toEqual(measuredBaseRatesReport(c).rates)
  })
})
