# Tier 1 — implementation plan

The build order for `INTERCEPT.md` (measured base rates). That file is the *what
and why*; this is the *how*, in the order the work should land.

Nothing here is speculative — every line number was checked against the tree at
the time of writing. Re-check them if the branch has moved.

---

## Sequencing principle

Steps 1–2 are **pure logic plus wiring with no behaviour change**, verifiable by
the existing 1,764-line ranking suite. Steps 3–5 are the instrumentation, which
is where the real risk lives (`INTERCEPT.md` §3, the population trap). Land 1–2
first so that when the counters arrive there is already a tested consumer for
them, and any score drift is unambiguously the counters' fault.

| # | Step | Files | Behaviour change |
|---|---|---|---|
| 1 | Pure estimator | `base-rates.ts` (new) + test | none |
| 2 | Ranking wiring | `ranking.ts` | none (identity at zero counters) |
| 3 | Counters + `impressed` | `signals.ts` | none to ranking |
| 4 | Impression call site | `TimelineForYouItem.vue` | none to ranking |
| 5 | Injection | `feed.ts` | **rates go live** |
| 6 | Preference gate | `settings/definition.ts`, settings page | gates step 5 |
| 7 | Debug output | `for-you-debug.post.ts`, `feed.ts` | dev only |

---

## Step 1 — `app/composables/for-you/base-rates.ts` (new, pure)

No imports from the signals store, no Nuxt, no reactivity — same discipline as
`ranking.ts`, so it is unit-testable standalone.

```ts
export const BASE_RATE_PRIOR_STRENGTH = 500

export function measuredBaseRates(
  counters: ForYouCounters | undefined,
  shipped: Record<keyof ActionProbabilities, number> = BASE_RATES,
  s: number = BASE_RATE_PRIOR_STRENGTH,
): Record<keyof ActionProbabilities, number>
```

Implements `INTERCEPT.md` §5 and §6:

1. per head, `B̂ = (k + s·B₀) / (n + s)`, where `n` is the **eligible**
   denominator for conditionally-gated heads (`openLink` → `eligible.hasLink`;
   `photoExpand`/`videoOpen` → `eligible.hasMedia`; `followAuthor` →
   `eligible.outOfNetwork`) and `impressions` otherwise;
2. heads with no signal (`share`, `vqv`, `blockAuthor`, `report`) keep `B₀`,
   rescaled by the aggregate factor their own side moved by;
3. guardrail: recompute `N/P` from the weights; if it leaves `[0.1, 0.4]`,
   **return `shipped` unchanged** and flag it.

Return `shipped` by identity (`===`) when `counters` is undefined or
`impressions === 0`, so step 2's cold path is provably free.

**Tests** (`tests/unit/for-you-base-rates.test.ts`, new):
- zero/undefined counters ⇒ returns the `shipped` object itself;
- `s → 0` recovers `k/n`; `n → 0` recovers `B₀`;
- conditional heads divide by `eligible`, not `impressions` — the regression
  that would otherwise silently deflate `openLink`/`photoExpand`/`videoOpen`;
- guardrail trips and falls back when `N/P` is driven out of band;
- unmeasurable heads move only via the §6 rescale, never on their own.

## Step 2 — `ranking.ts` wiring

Three small edits, no logic change:

- add `baseRates?: Partial<Record<keyof ActionProbabilities, number>>` to
  `RankingContext` (the interface at `ranking.ts:443`);
- add `resolveBaseRates(ctx)` next to `resolveParams` (`ranking.ts:470`),
  following the same merge-over-defaults shape;
- `predictActions`: `const B = BASE_RATES` (`ranking.ts:1010`) becomes
  `const B = resolveBaseRates(ctx)`.

That is the **only** line inside `predictActions` that changes. Every head keeps
reading `B.favorite`, `B.reply`, … unchanged.

**Verification:** `pnpm vitest tests/unit/for-you-ranking.test.ts` must pass
untouched. The suite pins concrete scores, so any drift fails immediately — this
is the byte-identity guarantee, and it costs nothing to obtain.

## Step 3 — `signals.ts` counters and the `impressed` set

The largest step, and the one carrying the population trap.

- add `counters: ForYouCounters` and `impressed: string[]` to
  `ForYouSignalsStore` (`signals.ts:112`);
- `createEmptySignals` (`:358`) seeds zeros and `[]`;
- `normalizeSignals` (`:473`) defaults absent counters to 0 and **preserves them
  across the `stale` branch** — they are raw observations, unlike the affinity
  maps that are deliberately dropped on a version change;
- bump `SIGNALS_VERSION` 2 → 3 (`:42`);
- new `recordForYouImpression(status)`: appends to `impressed` (deduped, evicted
  oldest-first at `MAX_SEEN`, mirroring `markSeenInSignals` at `:850`) and
  increments `impressions` plus whichever `eligible` counters apply;
- action counters increment inside the existing chokepoints — `recordSignal`
  (`:572`), `markNotInterested` (`:1270`), `muteAuthorForYou` (`:1294`) — each
  **gated on `impressed` membership**;
- decrements in `forgetSignal` (`:588`), `forgetFollow` (`:1040`) and
  `forgetNotInterested` (`:1287`), floored at 0.

**The ids already agree** — `candidateKey` (`candidates.ts:176`) is
`status.reblog?.id ?? status.id`, `getEngagementTarget().statusId`
(`signals.ts:535`) is `(status.reblog ?? status).id`, and `routes.ts:98` uses
the same. So membership lookup needs no id-normalization layer. It also means
ids alone cannot distinguish a For You impression from a status-detail
navigation, which is exactly why `impressed` has to be a separate array rather
than a filter over `seen`.

**Tests** (extend `tests/unit/for-you-signals.test.ts`): the five population
cases in `INTERCEPT.md` §9 — `routes.ts`-style `markSeen` moves nothing, actions
on non-`impressed` posts do not count *but still record their signal normally*,
retractions decrement, counters floor at 0, `impressed` evicts at `MAX_SEEN`,
counters survive a version bump.

## Step 4 — `TimelineForYouItem.vue`

One call beside the existing `markSeen`, inside the same latched
`isMeaningfullyVisible` branch (`:110`):

```ts
markSeen([candidateKey(status)])
recordForYouImpression(status)
```

The component already holds the status, so `hasLink`/`hasMedia`/`outOfNetwork`
are read there rather than threaded through `markSeen` — which must stay
untouched, because `masto/routes.ts:98` also calls it.

**Extend** `tests/nuxt/timeline-for-you-item.test.ts`: the impression fires once
per post (latched), and only on genuine visibility.

## Step 5 — `feed.ts` injection

- widen `options.ranking`'s `Pick<RankingContext, 'weights' | 'params'>`
  (`feed.ts:363`) to include `'baseRates'`;
- in `buildRankingContext` (`:494`), pass
  `baseRates: measuredBaseRates(signals.counters)` — behind the step 6
  preference, defaulting to `undefined` when off.

This is where rates go live. Everything before it is inert.

## Step 6 — preference gate

Add to `PreferencesSettings` (`settings/definition.ts:15`) alongside the
existing For You entries, **default off**, surfaced on
`app/pages/settings/preferences/index.vue` where the For You toggles already
live. One switch governs Tier 1 and, later, Tier 2 (`TIER-2.md` §5).

Locale strings go in `locales/en.json` only — other locales are
community-translated (`AGENTS.md`).

## Step 7 — debug output

Extend the `for-you-debug` sink (`server/api/for-you-debug.post.ts`, dev-only)
with one line per ranked page: shipped vs measured per head, `n`, and the `N/P`
ratio. This is how the **1-week rate checkpoint** (`TIER-2.md` §3) gets read —
the cheapest kill gate in the plan, and the first real evidence about whether
`BASE_RATES` was ever right.

---

## What the estimator does on its own — do not hand-freeze heads

`INTERCEPT.md` §4's "14 of 18 measurable" is about *signal availability*, not
statistical usefulness. At `n = 3000` the two diverge sharply:

| head | expected k | relative CI | shrunk value if the prior is true |
|---|---|---|---|
| `notDwelled` | 660 | 7% | 0.22 |
| `favorite` | 90 | 20% | 0.03 |
| `click` | 90 | 20% | 0.03 |
| `retweet` | 54 | 26% | 0.018 |
| `profileClick` | 15 | 50% | 0.005 |
| `reply` | 10.5 | 60% | 0.0035 |
| `quote` / `followAuthor` | 1.8 | 146% | 0.0006 |
| `notInterested` | 0.4 | 327% | 0.00012 |
| `muteAuthor` | 0.1 | 800% | 0.00002 |

The Beta-Binomial shrinkage is **self-regulating**: a head with `k ≈ 0.1` and
`s = 500` cannot move off its prior, while `favorite` at `k = 90` moves freely.
So no head needs hand-classifying as measurable or not — the estimator already
does the right thing, and adding a manual freeze list would be redundant surface
area.

## Attribution gaps to accept, not solve

Two heads have no status to gate membership on:

- **`muteAuthor`** takes an `accountId` and is reachable from
  `relationship.ts`'s account-wide mute/block (any surface) as well as
  `TimelineForYouItem.vue`'s "show less from author". Count only the For You
  call site: it is the only one that passes a `statusId`, and
  `bumpActionCounter`'s gate rejects the rest for free. **Accepted as-is.**
- **`followAuthor`** is a `recordFollow(account)` from `relationship.ts:83`,
  with a synthetic `follow:<id>` key and no post at all. **This one was not
  accepted**, and the reasoning above turned out to be wrong for it.

The argument for accepting both was that they "sit at ≥146% relative CI, so the
shrinkage pins them to their priors regardless". That holds for `muteAuthor`,
whose counter can move — a `k` of two or three over thousands of impressions
genuinely cannot shift the estimate, which is shrinkage working as designed.

It does not hold for `followAuthor`, because its counter could not move *at
all*. A structurally-zero `k` over a climbing `n` is not a pinned prior, it is
`s·B₀/(n + s)` decaying toward zero without bound, and at weight 4.0 that is the
largest positive head in the table quietly going to nothing. "Cheap to count
correctly" was the right rule applied to the wrong premise: the head was not
expensive to count, it was being counted against the wrong population.

The fix is `impressedAuthors` — authors For You showed out of network — gated by
`counterGateFor` in `signals.ts`. It needs no change to any follow button,
because it asks about the author rather than the post. What it does *not* catch:
a viewer who sees an author, waits until they fall out of the 1000-author
recency window, and only then follows them. That is the same shape of miss
`impressed` already has for posts at `MAX_SEEN`, and it *is* worth accepting.

The general rule survives, sharpened: **count what is cheap to count correctly,
and let the estimator ignore the rest — but first check the head can produce a
non-zero numerator at all.** A head that cannot is not being ignored by the
estimator, it is being driven to zero by it.

## Done when

1. `pnpm test:unit:ci`, `pnpm test:typecheck` and `pnpm lint` all pass.
2. `tests/unit/for-you-ranking.test.ts` passes **unmodified** — the identity
   guarantee.
3. With the preference off, ranking is byte-identical to today.
4. With it on and zero counters, ranking is byte-identical to today.
5. `pnpm dev` shows the step 7 debug line with `n` climbing as you scroll.

Note what this does *not* establish: that measured rates are **better** than the
shipped ones. That is the 1-week checkpoint's job, not the suite's. Steps 1–7
deliver a correct instrument; the verdict comes from reading it.

## Not in Tier 1

The `α` model, the feature-vector impression log, IndexedDB, propensity, the
random-exposure slot, and any ML dependency. All Tier 2 (`TIER-2.md`), all
gated, all deferred.
