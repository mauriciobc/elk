import type { ActionProbabilities, ForYouCounterAction, ForYouCounters } from './types'
import { IN_BAND_MAX, IN_BAND_MIN } from '#shared/for-you'
import { BASE_RATES, MASTODON_WEIGHTS } from './ranking'

/**
 * Measured base rates (`INTERCEPT.md` §5, §6).
 *
 * {@link BASE_RATES} in `ranking.ts` is, by its own docblock, "roughly the
 * unconditional probability of each action on a post that has actually been
 * shown to a viewer" — a set of numbers nobody ever measured, transcribed from
 * X and hand-adjusted so the weighted sum keeps `offsetScore`'s negative-branch
 * valve shut. This module estimates the same quantity, per viewer, from the
 * `ForYouCounters` Elk already accumulates: lifetime impression and action
 * counts that survive `SIGNALS_VERSION` bumps, are never capped, and never
 * decay — unlike the affinity maps, which are built for recency and would be
 * the wrong instrument for a rate (see `INTERCEPT.md` §3, "the caps corrupt
 * the ratio").
 *
 * Deliberately pure: no imports from `signals.ts`, no Nuxt, no reactivity, no
 * `vue`. Same discipline as `ranking.ts`, and for the same reason — a
 * function this load-bearing has to be unit-testable without a store, a
 * component, or a browser. It imports `BASE_RATES` and `MASTODON_WEIGHTS`
 * from `ranking.ts` and nothing flows the other way; `ranking.ts` must never
 * import from this file, on pain of a circular import. The one other import,
 * `#shared/for-you`, is a leafless constants module reachable from the Nitro
 * side too — see its own docblock for why the guardrail band lives there.
 */

/**
 * Prior strength `s`, in pseudo-impressions (`INTERCEPT.md` §5, §10.1).
 *
 * `s` reads directly out of the shrinkage formula below: at `n = s` the
 * estimate sits exactly halfway between the shipped value and the viewer's
 * own data. 500 impressions is a few days of ordinary use — by then the
 * viewer's data carries half the weight; by a few thousand it dominates. At
 * `n = 0` the estimate collapses to `B₀` exactly, so a fresh account (or one
 * with the preference off) is served today's ranker, byte-for-byte.
 */
export const BASE_RATE_PRIOR_STRENGTH = 500

/** One of the 18 heads `ActionProbabilities`/`BASE_RATES` key on. */
type Head = keyof ActionProbabilities

/** Which `ForYouCounters.eligible` sub-count gates a conditional head, if any. */
type EligibleDenominator = keyof ForYouCounters['eligible']

/**
 * How one head relates to the counters (`INTERCEPT.md` §4).
 *
 * `counter` — a signal exists *and* something in the app writes it, so the
 * head shrinks toward `B₀` by its own `k/n`.
 *
 * `no-signal` — there is no signal concept anywhere in the client; nothing
 * could record it without inventing the event first. Keeps `B₀` and moves
 * only through the §6 rescale.
 *
 * `unwired` — the signal exists in `ForYouEngagementKind` but nothing writes
 * it, so its counter would be pinned at zero forever. **No head is in this
 * state today**, and the variant is kept anyway, because the state is easy to
 * re-enter (add a kind to `ForYouEngagementKind`, forget the call site) and
 * silent when it happens.
 *
 * Leaving such a head classified `counter` is not neutral, which is the whole
 * reason the distinction exists: shrinkage pins a head to `B₀` only when
 * numerator and denominator sample the same population. With `k` nailed to 0
 * and `n` climbing on every scroll, the estimate is `s·B₀ / (n + s)`, which
 * decays toward zero without bound. Five heads were in exactly that state —
 * measured on a realistic profile at `n = 30,000`: `openLink` 7x low,
 * `photoExpand`/`videoOpen` 7x, `profileClick` 61x, and `followAuthor`
 * structurally dead because `recordFollow`'s synthetic key can never match
 * `impressed`. `N/P` stays inside `[0.1, 0.4]` throughout, so the §6.3
 * guardrail does **not** catch it. Serving `B₀` is the honest answer while a
 * head is in this state (`INTERCEPT-BUILD.md`: "count what is cheap to count
 * correctly and let the estimator ignore the rest").
 *
 * Note what "unwired" is *not*: a head whose `k` is genuinely zero because the
 * viewer never took the action. That is ordinary evidence and shrinkage is
 * supposed to move on it. The distinction is whether a non-zero `k` is
 * **possible**, not whether it has happened.
 *
 * The `counter`/`unwired` split is deliberately *only* about whether a writer
 * exists — both carry the same `counter` key and the same `eligible`
 * denominator, so wiring a call site is a one-word edit here and nothing else.
 */
type HeadClass
  = | { kind: 'counter', counter: ForYouCounterAction, eligible?: EligibleDenominator }
    | { kind: 'no-signal' }
    | { kind: 'unwired', counter: ForYouCounterAction, eligible?: EligibleDenominator }

/**
 * Every head, classified. The one table this module reads for *all* three
 * questions it asks about a head: does it have a counter, which denominator
 * does that counter divide by, and may shrinkage touch it.
 *
 * Typed `Record<Head, …>` rather than a `Partial`, and split across no other
 * list: adding a 19th head to `ActionProbabilities` is a **compile error here
 * until it is classified**, instead of silently falling through every loop
 * below unshrunk, unrescaled and absent from the report. That is the same
 * argument {@link sideOf}'s docblock makes for reading the sign off
 * `MASTODON_WEIGHTS` instead of a hand-copied list, applied to the one place
 * that used to hand-copy it.
 *
 * Declared in `BASE_RATES` order so {@link HEADS} — and therefore the debug
 * report — reads in the order the shipped table declares. Nothing depends on
 * that order for correctness (`splitSums` is order-insensitive and
 * `buildPerHead` is display-only); it is a readability contract.
 *
 * `quote`, `dwell` and `profileClick` are measured despite carrying weight
 * 1.0, 0.0 and 0.0 today (`INTERCEPT.md` §10.3): it is cheap, and it leaves
 * the head ready the moment a weight changes.
 */
const HEAD_CLASS: Record<Head, HeadClass> = {
  favorite: { kind: 'counter', counter: 'favourite' },
  reply: { kind: 'counter', counter: 'reply' },
  retweet: { kind: 'counter', counter: 'reblog' },
  quote: { kind: 'counter', counter: 'quote' },
  share: { kind: 'no-signal' },
  click: { kind: 'counter', counter: 'open' },
  openLink: { kind: 'counter', counter: 'openLink', eligible: 'hasLink' },
  // No `eligible` gate: every impression could have produced an avatar tap,
  // so the denominator is plain `impressions`.
  profileClick: { kind: 'counter', counter: 'profileClick' },
  photoExpand: { kind: 'counter', counter: 'photoExpand', eligible: 'hasMedia' },
  videoOpen: { kind: 'counter', counter: 'videoOpen', eligible: 'hasMedia' },
  vqv: { kind: 'no-signal' },
  dwell: { kind: 'counter', counter: 'dwell' },
  // The one head whose action is not about a post: `recordFollow` mints a
  // synthetic `follow:<accountId>` key that can never be in `impressed`, so
  // this is gated on `impressedAuthors` instead (`signals.ts`'s `counterGateFor`).
  // Its denominator is `eligible.outOfNetwork` because `predictActions` gates
  // the head on `!inNetwork` — following someone you already follow is not an
  // action that exists, so in-network impressions were never eligible for it.
  followAuthor: { kind: 'counter', counter: 'follow', eligible: 'outOfNetwork' },
  notInterested: { kind: 'counter', counter: 'dismiss' },
  muteAuthor: { kind: 'counter', counter: 'mute' },
  blockAuthor: { kind: 'no-signal' },
  report: { kind: 'no-signal' },
  notDwelled: { kind: 'counter', counter: 'notDwelled' },
}

/**
 * All 18 heads, in {@link HEAD_CLASS} declaration order — drives every loop
 * below so the guardrail sums, the per-head report and the return value agree
 * on iteration order. Derived, never hand-written: a hand-copied list would
 * silently exclude a newly-added head from every sum and finiteness check.
 */
const HEADS = Object.keys(HEAD_CLASS) as Head[]

/**
 * The heads the §6 rescale moves: everything shrinkage is not allowed to
 * touch, because nothing can ever put a count in their numerator. They track
 * the aggregate move of their own side of `offsetScore`'s split instead of
 * sitting frozen while their measured neighbours move around them.
 *
 * Derived from {@link HEAD_CLASS}, like {@link HEADS}, so classifying a head
 * differently moves it in or out of this set with no second list to update.
 */
const RESCALE_HEADS = HEADS.filter(head => HEAD_CLASS[head].kind !== 'counter')

/**
 * The eligible denominator for a head (`INTERCEPT.md` §3, §4). Some heads are
 * conditionally gated — `openLink` only exists for a post with a card,
 * `photoExpand`/`videoOpen` only for a post with media, `followAuthor` only
 * for an author not already followed — so dividing them by raw `impressions`
 * silently deflates them by the share of impressions that could never have
 * produced the action. This is called out in both source docs as the single
 * most-likely regression, so it stays a named function rather than being
 * folded inline into the shrinkage loop.
 */
export function denominatorFor(head: Head, counters: ForYouCounters): number {
  const cls = HEAD_CLASS[head]
  const eligible = cls.kind === 'no-signal' ? undefined : cls.eligible
  return eligible ? counters.eligible[eligible] : counters.impressions
}

/**
 * Beta-Binomial shrinkage toward the shipped value (`INTERCEPT.md` §5):
 *
 *   B̂ = (k + s·B₀) / (n + s)
 *
 * Self-regulating by construction — a head with a tiny `k` (a handful of
 * mutes over thousands of impressions) cannot move off `B₀` regardless of
 * `n`, while a head with `k` in the dozens or hundreds (favourites, opens)
 * moves freely. See the table in `INTERCEPT-BUILD.md` ("What the estimator
 * does on its own"). No head needs hand-classifying as trustworthy or not —
 * this formula already does the right thing per head.
 */
function shrink(k: number, n: number, b0: number, s: number): number {
  return (k + s * b0) / (n + s)
}

/** Which side of `offsetScore`'s split (`INTERCEPT.md` §6) a head sits on. */
type Side = 'positive' | 'negative'

/**
 * Reads the sign directly off `MASTODON_WEIGHTS` rather than trusting a
 * memorized list — the weights are the source of truth for which heads are
 * penalties, and a hand-copied list would silently go stale the moment
 * `MASTODON_WEIGHTS` changes. A zero weight (`profileClick`, `dwell` today)
 * is treated as positive; it contributes nothing to either sum either way,
 * so the classification is a don't-care for the guardrail, but the heads
 * still need a bucket to sit in for the loop below.
 */
function sideOf(head: Head): Side {
  return MASTODON_WEIGHTS[head] < 0 ? 'negative' : 'positive'
}

/** `Σ wᵢ·rate` split into the positive and `|w|`-weighted negative side. */
function splitSums(rates: Record<Head, number>): { positive: number, negative: number } {
  let positive = 0
  let negative = 0
  for (const head of HEADS) {
    const w = MASTODON_WEIGHTS[head]
    if (w === 0)
      continue
    if (w > 0)
      positive += w * rates[head]
    else
      negative += -w * rates[head]
  }
  return { positive, negative }
}

/** One row of the diagnostic detail `measuredBaseRatesReport` returns. */
export interface BaseRateHeadReport {
  head: Head
  /** The shipped `BASE_RATES` value for this head. */
  shipped: number
  /** The value actually returned — shrunk for `counter` heads, rescaled for the rest. */
  measured: number
  /** Lifetime action count. `0` for `no-signal`/`unwired` heads — nothing moves their counter. */
  k: number
  /** The denominator used (`impressions` or the relevant `eligible.*`). `0` for `no-signal`/`unwired` heads and on the cold path. */
  n: number
}

/** Full return of {@link measuredBaseRatesReport}. */
export interface BaseRateReport {
  /** What `predictActions` should read as `B`. Identical (`===`) to `shipped` when nothing was measured or the guardrail tripped. */
  rates: Record<Head, number>
  /** `false` on the cold path or when the §6.3 guardrail fell back to `shipped`. */
  applied: boolean
  /** `N/P` recomputed from `rates` and `MASTODON_WEIGHTS`. In-band is `[0.1, 0.4]`. */
  ratio: number
  /** Per-head detail for the Step 7 debug sink. */
  perHead: BaseRateHeadReport[]
}

/**
 * `N/P` for `MASTODON_WEIGHTS` over the given rates. A bare `negative /
 * positive` — no guard against a zero or non-finite positive side, which is
 * deliberate: {@link measuredBaseRatesReport}'s guardrail checks
 * `Number.isFinite(ratio)` itself immediately after calling this, so a
 * `NaN`/`Infinity` result here is a signal the guardrail reads, not a case
 * this function needs to hide.
 */
function ratioOf(rates: Record<Head, number>): number {
  const { positive, negative } = splitSums(rates)
  return negative / positive
}

function buildPerHead(
  shipped: Record<Head, number>,
  measured: Record<Head, number>,
  k: Partial<Record<Head, number>>,
  n: Partial<Record<Head, number>>,
): BaseRateHeadReport[] {
  return HEADS.map(head => ({
    head,
    shipped: shipped[head],
    measured: measured[head],
    k: k[head] ?? 0,
    n: n[head] ?? 0,
  }))
}

/**
 * The full computation behind {@link measuredBaseRates}, also exposing the
 * per-head detail the Step 7 debug sink needs (shipped vs measured, the `n`
 * used, and the final `N/P`) without recomputing it a second time.
 *
 * Cold path first, and cheaply: `counters` undefined or `impressions === 0`
 * returns `shipped` by identity before touching the per-head loop at all, so
 * an unconfigured or fresh-account context pays nothing for this module
 * existing (`INTERCEPT-BUILD.md`, "Step 2's cold path must be provably
 * free").
 */
export function measuredBaseRatesReport(
  counters: ForYouCounters | undefined,
  shipped: Record<keyof ActionProbabilities, number> = BASE_RATES,
  s: number = BASE_RATE_PRIOR_STRENGTH,
): BaseRateReport {
  if (!counters || counters.impressions === 0) {
    return {
      rates: shipped,
      applied: false,
      ratio: ratioOf(shipped),
      perHead: buildPerHead(shipped, shipped, {}, {}),
    }
  }

  // ── per-head shrinkage ───────────────────────────────────────────────────
  // Only `counter` heads shrink toward B₀ by their own k/n. `no-signal` and
  // `unwired` heads are left at B₀ here — the both-sides rescale below is the
  // only thing allowed to move them (see {@link HeadClass} for why `unwired`
  // must not shrink on a numerator that is structurally zero).
  const preRescale: Record<Head, number> = { ...shipped }
  const k: Partial<Record<Head, number>> = {}
  const n: Partial<Record<Head, number>> = {}

  for (const head of HEADS) {
    const cls = HEAD_CLASS[head]
    if (cls.kind !== 'counter')
      continue
    const kHead = counters.actions[cls.counter] ?? 0
    const nHead = denominatorFor(head, counters)
    k[head] = kHead
    n[head] = nHead
    preRescale[head] = shrink(kHead, nHead, shipped[head], s)
  }

  // ── the both-sides constraint (§6) ──────────────────────────────────────
  // Compute P = Σ_positive wᵢ·Bᵢ and N = Σ_negative |wᵢ|·Bᵢ under both the
  // shipped rates and the pre-rescale ("measurable heads shrunk, unmeasurable
  // heads still at B₀") rates, then move each unmeasurable head by the
  // aggregate factor its own side moved by, so it stays in proportion with
  // its measured neighbours instead of sitting frozen while everything
  // around it moves.
  const shippedSums = splitSums(shipped)
  const measuredSums = splitSums(preRescale)

  const positiveFactor = shippedSums.positive === 0 ? 1 : measuredSums.positive / shippedSums.positive
  const negativeFactor = shippedSums.negative === 0 ? 1 : measuredSums.negative / shippedSums.negative

  const finalRates: Record<Head, number> = { ...preRescale }
  for (const head of RESCALE_HEADS) {
    const factor = sideOf(head) === 'positive' ? positiveFactor : negativeFactor
    finalRates[head] = shipped[head] * factor
  }

  // ── guardrail (§6.3) ────────────────────────────────────────────────────
  // Recompute N/P from the final rates, not the pre-rescale ones — the
  // rescale itself can push the ratio out of band even when the raw
  // shrinkage didn't. A calibration that opens offsetScore's valve is worse
  // than no calibration, so any out-of-band result — or any non-finite rate,
  // which a zero-impression eligible denominator can produce — discards the
  // measurement for this session and serves `shipped`, unchanged.
  const ratio = ratioOf(finalRates)
  const allFinite = HEADS.every(head => Number.isFinite(finalRates[head]))
  const inBand = Number.isFinite(ratio) && ratio >= IN_BAND_MIN && ratio <= IN_BAND_MAX

  if (!allFinite || !inBand) {
    // No dev-only warning here — this module claims "no Nuxt" in its own
    // docblock, and `import.meta.dev` is a Nuxt-injected macro. `applied:
    // false` and `ratio` already carry exactly what a warning would say;
    // `feed.ts`, which already gates its own dev logging on `import.meta.dev`,
    // is where that gets surfaced (`INTERCEPT-BUILD.md` Step 7).
    return {
      rates: shipped,
      applied: false,
      ratio,
      perHead: buildPerHead(shipped, finalRates, k, n),
    }
  }

  return {
    rates: finalRates,
    applied: true,
    ratio,
    perHead: buildPerHead(shipped, finalRates, k, n),
  }
}

/**
 * Per-viewer measured base rates (`INTERCEPT.md` §5, §6). See the module
 * docblock above for what this replaces and why.
 *
 * Returns `shipped` **by identity** (`===`, not a structurally-equal copy)
 * whenever nothing was measured — no counters, zero impressions, or the §6.3
 * guardrail tripped — so callers (`resolveBaseRates` in `ranking.ts`) can
 * treat "unchanged" as free to detect and the cold path stays provably cheap.
 */
export function measuredBaseRates(
  counters: ForYouCounters | undefined,
  shipped: Record<keyof ActionProbabilities, number> = BASE_RATES,
  s: number = BASE_RATE_PRIOR_STRENGTH,
): Record<keyof ActionProbabilities, number> {
  return measuredBaseRatesReport(counters, shipped, s).rates
}
