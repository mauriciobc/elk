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

// ──────────────────────────────────────────────────────  head coverage ──

describe('head classification', () => {
  // `HEAD_CLASS` is `Record<Head, …>`, so a head added to `ActionProbabilities`
  // is a compile error there until classified. This is the runtime half of the
  // same guarantee: that `HEADS` — and therefore every sum, the finiteness
  // check and the debug report — is derived from that table rather than
  // hand-copied, so it cannot silently omit a head. Order is asserted too,
  // because the report is read by a human against `BASE_RATES`.
  it('reports every head BASE_RATES declares, in BASE_RATES order', () => {
    const report = measuredBaseRatesReport(counters({ impressions: 500 }))
    expect(report.perHead.map(row => row.head)).toEqual(Object.keys(BASE_RATES))
  })

  it('reports every head on the cold path too', () => {
    expect(measuredBaseRatesReport(undefined).perHead.map(row => row.head))
      .toEqual(Object.keys(BASE_RATES))
  })
})

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

  it('divides followAuthor by out-of-network impressions, never by all of them', () => {
    // `followAuthor` is gated on `!inNetwork` in `predictActions` — following
    // someone you already follow is not an action that exists — so an
    // in-network impression was never eligible for it. Dividing by raw
    // `impressions` would deflate the head by the whole in-network share of
    // the feed, which on a follow-heavy account is most of it. Here only 20 of
    // 6000 impressions were out of network, so the two differ by 300x.
    const c = counters({
      impressions: 6000,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: 20 },
      actions: { follow: 1 },
    })
    const report = measuredBaseRatesReport(c)
    const row = headReport(report, 'followAuthor')
    expect(row.k).toBe(1)
    expect(row.n).toBe(20)
    expect(denominatorFor('followAuthor', c)).toBe(20)
  })

  it('lets followAuthor shrink on a genuinely observed zero, which is the whole point of wiring it', () => {
    // This is the case that used to be indistinguishable from the broken one.
    // A viewer who scrolled past 3000 strangers and followed none of them
    // really does follow less often than `B0` says, and the estimator is now
    // allowed to say so — `s·B0/(n + s)`, ordinary shrinkage, no special case.
    // What made the old behaviour wrong was not the decay, it was that `k`
    // *could not* be non-zero: `recordFollow`'s synthetic key never matched
    // `impressed`, so every viewer looked like this one.
    const s = BASE_RATE_PRIOR_STRENGTH
    const c = counters({
      impressions: 3000,
      eligible: { hasLink: 300, hasMedia: 300, outOfNetwork: 3000 },
      actions: { favourite: 90, reblog: 54, open: 90, notDwelled: 660 },
    })
    const row = headReport(measuredBaseRatesReport(c), 'followAuthor')
    expect(row.k).toBe(0)
    expect(row.n).toBe(3000)
    expect(row.measured).toBeCloseTo((s * BASE_RATES.followAuthor) / (3000 + s), 12)
    expect(row.measured).toBeLessThan(BASE_RATES.followAuthor)
  })

  it('reproduces B0 for a viewer who follows at exactly the shipped rate', () => {
    // The other half of the same property: a real numerator over the right
    // denominator lands back on `B0` rather than anywhere near zero.
    const oon = 20_000
    const c = counters({
      impressions: oon * 2,
      eligible: { hasLink: 0, hasMedia: 0, outOfNetwork: oon },
      actions: { follow: oon * BASE_RATES.followAuthor },
    })
    const row = headReport(measuredBaseRatesReport(c), 'followAuthor')
    expect(row.measured).toBeCloseTo(BASE_RATES.followAuthor, 12)
  })

  it('measures the click-family heads against their own eligible denominator, not raw impressions', () => {
    // These four were `unwired` — nothing in `app/` recorded a link click,
    // photo expand, video open or profile tap, so their counters were pinned
    // at 0 while their denominators climbed (7x low at n=30000, 61x for
    // `profileClick`). Their writers exist now (`StatusPreviewCard.vue`,
    // `StatusAttachment.vue`, `StatusCard.vue`, covered end-to-end by
    // `tests/nuxt/for-you-click-writers.test.ts`), so the risk moves to the
    // *denominator*: only a tenth of impressions carry a card or media here,
    // so dividing those heads by raw `impressions` would deflate them tenfold
    // — the regression both source docs warn about hardest.
    const n = 30_000
    const media = n / 10
    const report = measuredBaseRatesReport(counters({
      impressions: n,
      eligible: { hasLink: media, hasMedia: media, outOfNetwork: n },
      actions: {
        // Each conditional head observed at exactly its shipped rate *over its
        // own eligible population*, so a correct denominator reproduces `B0`
        // and a wrong one lands 10x low.
        openLink: media * BASE_RATES.openLink,
        photoExpand: media * BASE_RATES.photoExpand,
        videoOpen: media * BASE_RATES.videoOpen,
        profileClick: n * BASE_RATES.profileClick,
      },
    }))

    expect(headReport(report, 'openLink').n).toBe(media)
    expect(headReport(report, 'photoExpand').n).toBe(media)
    expect(headReport(report, 'videoOpen').n).toBe(media)
    // No eligibility gate: any impression could have produced an avatar tap.
    expect(headReport(report, 'profileClick').n).toBe(n)

    for (const head of ['openLink', 'photoExpand', 'videoOpen', 'profileClick'] as const)
      expect(headReport(report, head).measured).toBeCloseTo(BASE_RATES[head], 12)
  })

  it('does not decay any head as impressions pile up, when the viewer acts at exactly the shipped rate', () => {
    // The property the whole estimator rests on: every head observed at
    // exactly its own shipped rate, over its *own* denominator, must reproduce
    // `B0` at any sample size. Shrinkage is then a no-op, both side sums are
    // unchanged, and the §6 rescale factors sit at 1.
    //
    // It is also the sharpest test of the denominators, because a head divided
    // by the wrong population fails here and nowhere else: `openLink` and the
    // media pair are observed over a tenth of impressions and `followAuthor`
    // over the out-of-network share, so using raw `impressions` for any of
    // them drives it visibly low and further low as `n` grows.
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
          follow: n * BASE_RATES.followAuthor,
        },
      }))
    }

    const small = at(3000)
    const large = at(30_000)
    expect(small.applied).toBe(true)
    expect(large.applied).toBe(true)

    // Unchanged from shipped at both sizes, for every head that has a writer.
    for (const head of [
      'favorite',
      'reply',
      'retweet',
      'click',
      'openLink',
      'profileClick',
      'photoExpand',
      'videoOpen',
      'followAuthor',
      'notDwelled',
    ] as const) {
      expect(headReport(small, head).measured).toBeCloseTo(BASE_RATES[head], 12)
      expect(headReport(large, head).measured).toBeCloseTo(BASE_RATES[head], 12)
    }
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
