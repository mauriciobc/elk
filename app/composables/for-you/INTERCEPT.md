# For You — measured base rates (Tier 1)

Status: **draft spec — no code written.** This is the *primary* deliverable of
the local-training work, and it ships on its own. It learns nothing, adds no
dependency, adds no store, and needs nothing from the `α` work (`TIER-2.md`) —
neither its impression log nor its model.

Read next to `CALIBRATION.md` — this is the same genre of work, turning an
asserted constant into a measured one — and `LOCAL-TRAINING.md` for why the
intercept, not the slope, is the thing worth shipping.
`INTERCEPT-BUILD.md` is the ordered build plan for everything specified here.

---

## 1. What this is

`BASE_RATES` (`ranking.ts:944`) is described in its own docblock as "roughly the
unconditional probability of each action on a post that has actually been shown
to a viewer". They are better described as scale-setting fictions than as
empirical impression rates: transcribed from X and hand-adjusted so the weighted
sum balances. **Nothing has ever measured them.**

This spec measures them, per viewer, from signals Elk already records.

## 2. Why the intercept and not the `α` slopes

One parameter against every impression beats four parameters against the
positives alone, and it is not close:

| target | params | data it uses | precision |
|---|---|---|---|
| `favorite` base rate | 1 | all impressions (n≈3000) | **±20% relative CI** |
| `favorite` `αᵢ` | 4 | discrimination from ~90 positives | 22 events/param (floor 10) |

A rate estimate uses positives *and* negatives; the `α` fit draws its
discrimination almost entirely from the positives. The intercept converges in
days-to-weeks where the slopes need quarters, and it is robust where they are
fragile.

**The closed-loop objection (B4) largely does not apply here.** `BASE_RATES` is
*defined* as P(action | the post was shown). Measuring it on shown posts is
therefore correct by construction, not biased — the caveat is only that the
estimate is relative to the current ranker, and shifts if the ranker does.

### What it concretely fixes

1. **The boost:favourite ratio `CALIBRATION.md` could not settle.** Three
   irreconcilable estimates (0.465 authoritative local, 0.721 coverage-implied,
   1.755 as-observed) resolved to "0.6 x the favourite rate", flagged in the code
   as *"a directional transfer, not a literal one"* because what was measured is
   counts-per-post while what is needed is P(this viewer acts | impression).
   This measures the needed quantity directly.
2. **A latent ordering bug.** `BASE_RATES`'s docblock says the negative rates are
   calibrated so the negative side sums to ~1/5 of the positive side, because
   `offsetScore`'s negative branch compresses everything below zero into a
   sub-0.001 band where posts are "effectively unordered" — a valve that "has to
   be kept shut by construction." Kept shut *by assumption*. If the real
   favourite rate is 0.5% rather than 3%, that balance is off by 6x and the valve
   may already be opening on real feeds. Nothing today can tell you.

## 3. Elk already records both the numerator and the denominator

This is why Tier 1 is small — no new *store* is needed, only new fields on the
one that exists.

| quantity | already recorded | where |
|---|---|---|
| **impressions** | `markSeen` on genuine viewport entry, latched, deduped | `TimelineForYouItem.vue:110` → `signals.ts:1256`, into `signals.seen` |
| **actions** | `recordEngagement(status, kind)` for all 14 `ENGAGEMENT_KINDS` | `signals.ts:1013`, into `signals.engaged[kind]` |
| **dismissals** | `markNotInterested` | `signals.ts:1270`, into `signals.dismissed` |
| **mutes** | `muteAuthorForYou` | `signals.ts:1294`, into `signals.mutedForYou` |
| **retractions** | `forgetEngagement` / `forgetFollow` / `forgetNotInterested` | `status.ts:86`, `relationship.ts:81`, `TimelineForYouItem.vue:200` |
| per-account isolation | `useUserLocalStorage` keyed by `acct` | `signals.ts:954` |
| versioned normalize-on-read | `normalizeSignals` | `signals.ts:473` |

### The population trap: the two sides do not currently cover the same posts

**This is the single most important implementation constraint in this spec, and
getting it wrong biases every rate in the same direction.** `BASE_RATES` is
P(action | *shown in For You*), so the numerator and denominator must cover the
same set of posts. Neither hook does today.

**The denominator has two sources, and only one is a For You impression.**
`markSeen` is called from two places:

- `TimelineForYouItem.vue:110` — IntersectionObserver-gated, a genuine For You
  impression. **This one counts.**
- `masto/routes.ts:98` — fires when the viewer opens a *status detail page*,
  from any surface: notifications, search, a pasted link. **This one must not.**

So the increment goes at the For You call site, **never inside `markSeen`**. And
`signals.seen` cannot serve as the impression set, because `routes.ts` populates
it deliberately — a post read elsewhere should not resurface in For You, which is
correct behaviour for `PreviouslySeenPostsFilter` and must not change.

**The numerator is worse.** `recordEngagement` is wired globally at
`masto/status.ts:88`, so it fires for every favourite, boost and reply *anywhere
in the app*. Counting all engagement over For You impressions alone would
overstate every rate — and the contamination is **correlated, not noise**: a post
the viewer deliberately navigated to has a far higher action rate than one that
scrolled past. At the ±20% precision this spec exists to deliver, a ~10% biased
contamination is not tolerable.

**The fix: an explicit For You impression set.** Add `impressed: string[]`,
bounded and evicted exactly like `seen` (`MAX_SEEN`, ~60 KB of ids), written
*only* from the For You call site. An action counter increments only when the
post's id is in `impressed`. Numerator and denominator then cover the same
population by construction.

That bound has a consequence worth stating: an action taken on a post that
scrolled past more than `MAX_SEEN` impressions ago is not counted, so rates are
very slightly under-counted for viewers who engage with old posts. That is a far
smaller and *un*correlated error than the contamination it replaces.

### What is missing: the caps corrupt the ratio

`|engaged[kind]| / |seen|` looks like the estimator, and it is not, because both
sides are capped and the numerator is also decayed:

- `MAX_SEEN = 3000` (`signals.ts:291`), oldest evicted;
- `MAX_SIGNALS_PER_KIND = 50` (`signals.ts:215`), oldest evicted, plus decay.

At the assumed 3% favourite rate, 3000 impressions imply ~90 favourites — but
the cap is 50, so the ratio saturates at `50/3000 = 1.67%` and **systematically
understates every head whose true rate exceeds 1.67%**. The capped arrays are
built for affinity derivation, where recency and bounded size are correct; they
are the wrong instrument for a rate.

### The fix: lifetime counters

Add monotone counters alongside the capped arrays — never evicted, never
decayed:

```ts
/**
 * Lifetime observation counts. Raw observations, not derived state: unlike the
 * affinity maps, these must survive a SIGNALS_VERSION bump.
 */
interface ForYouCounters {
  impressions: number
  /** Impressions that were *eligible* for a conditionally-gated head. */
  eligible: { hasLink: number, hasMedia: number, outOfNetwork: number }
  actions: Partial<Record<ForYouEngagementKind | 'dismiss' | 'mute', number>>
}
```

plus the population set from the trap above, alongside `seen`:

```ts
interface ForYouSignalsStore {
  /** Ids For You actually put on screen. Bounded and evicted like `seen`. */
  impressed: string[]
  // …existing fields
}
```

That is ~20 integers and one bounded id array — the integers are negligible, and
the array roughly doubles what `seen` already costs, which the 5 MB budget
absorbs comfortably.

**Where the increments go:**

- `impressions` and the three `eligible` counters: the For You call site
  (`TimelineForYouItem.vue:110`), which already has the status to read
  `hasLink`/`hasMedia`/`outOfNetwork` off — **not** inside `markSeen`;
- action counters: inside the existing chokepoints (`recordSignal`,
  `markNotInterested`, `muteAuthorForYou`), each **gated on `impressed`
  membership**;
- **decrements on retraction.** `forgetEngagement`, `forgetFollow` and
  `forgetNotInterested` are all wired and reachable from the UI. Without a
  matching decrement an un-favourite leaves a phantom positive and every rate
  drifts upward for viewers who undo. Floor the counters at 0.

**Version discipline:** `normalizeSignals` drops derived maps when `version !==
SIGNALS_VERSION` but keeps raw sequences. Counters are raw observations and must
be **kept** across a version bump, or every bump silently resets the calibration.

## 4. Head ↔ signal coverage

Fourteen of eighteen heads are directly measurable from signals that exist today.

| head | signal | note |
|---|---|---|
| `favorite` | `favourite` | primary |
| `retweet` | `reblog` | settles the ratio in §2.1 |
| `reply` | `reply` | |
| `quote` | `quote` | measured rate can replace the `QUOTE_GIVEN_RETWEET` derivation |
| `click` | `open` | |
| `openLink` | `openLink` | rate per **`hasLink`-eligible** impression |
| `profileClick` | `profileClick` | weight 0.0 today |
| `photoExpand` | `photoExpand` | per **`hasMedia`-eligible** impression |
| `videoOpen` | `videoOpen` | per **`hasMedia`-eligible** impression |
| `dwell` | `dwell` | weight 0.0 today |
| `notDwelled` | `notDwelled` | |
| `followAuthor` | `follow` | per **out-of-network** impression (the head is `inNetwork`-gated) |
| `notInterested` | `dismissed[]` | |
| `muteAuthor` | `mutedForYou[]` | |
| `share` | — | **not measurable**, no signal exists |
| `vqv` | — | **not measurable**, derived from `videoOpen` |
| `blockAuthor` | — | **not measurable** |
| `report` | — | **not measurable**, and a single viewer produces zero, ever |

Conditional heads must be divided by their *eligible* impression count, not the
total, which is why §3's `eligible` counters exist. Getting this wrong deflates
`openLink`/`photoExpand`/`videoOpen` by the share of impressions that could
never have produced them.

**Every row above is gated on `impressed` membership** (§3). The signals in the
middle column all fire globally — `recordEngagement` from `masto/status.ts:88`,
`recordFollow` from `relationship.ts:83` — so an ungated count would include
actions on posts the For You feed never showed. `followAuthor` is the sharpest
case: a follow initiated from a profile page or search has nothing to do with
this feed, yet would land in the numerator over a For You denominator.

## 5. Estimator: Beta-Binomial shrinkage toward the shipped value

Same shape as ridge-to-1 for `α`, and for the same reason — exact cold start,
graceful degradation:

```
B̂ = (k + s·B₀) / (n + s)
```

- `B₀` = the shipped `BASE_RATES` value, `k` = lifetime action count,
  `n` = lifetime (eligible) impression count;
- `s` = prior strength **in pseudo-impressions**; default **500**.

`s` reads directly: at `n = s` the estimate sits halfway between the shipped
value and the viewer's own data. At 500 impressions — a few days of use — the
viewer's data carries half the weight; by a few thousand it dominates. At `n = 0`
the estimate *is* `B₀`, so a fresh account serves today's ranker exactly.

Unmeasurable heads (`share`, `vqv`, `blockAuthor`, `report`) keep `B₀`, rescaled
per §6.

## 6. The both-sides constraint (do not skip this)

Measuring only what is measurable would break the balance `BASE_RATES` was
deliberately calibrated to hold. `notInterested` and `muteAuthor` *are*
measurable, but `blockAuthor` and `report` are not — and they carry the two
largest magnitudes in the model (−31.2 and −234.0). If the measured positive
rates come in low and the two unmeasurable negatives stay at their fictional
values, the negative side gets relatively stronger and `offsetScore`'s valve
opens wider — the exact failure §2.2 exists to prevent.

So:

1. Compute `P = Σ_positive wᵢ·Bᵢ` and `N = Σ_negative |wᵢ|·Bᵢ` under both the
   shipped and the measured rates.
2. Scale each **unmeasurable** head by the aggregate factor its own side moved
   by, so it stays in proportion with its measured neighbours.
3. **Guardrail:** if the resulting `N/P` falls outside `[0.1, 0.4]` (shipped is
   ~0.2), discard the measurement for that session and serve `B₀`, with a
   dev-only warning. A calibration that opens the valve is worse than no
   calibration.

## 7. What this does *not* do

It closes the **calibration** half of the Phoenix gap — what this viewer's
action probabilities actually are. It does **not** close the personalization
half — P(action) conditioned on the specific post — which is what `α`
(`TIER-2.md`) attempts and probably cannot deliver at
single-viewer scale.

Worth stating plainly, because it is easy to overclaim: Elk is not missing
personalization. `authorAffinity`, `tagAffinity` and `boosterAffinity` already
read the viewer's history and already shape the ranking. The gap was never "no
personalization" — it is "hand-set *strength* on personalization that already
works", plus "never-measured *scale* underneath it." This spec fixes the second.

## 8. Deliverables

1. `ForYouCounters` **and `impressed: string[]`** on `ForYouSignalsStore`.
   Impressions increment at the For You call site
   (`TimelineForYouItem.vue:110`) — **not** inside `markSeen`, which
   `masto/routes.ts:98` also calls; action counters increment inside the
   existing chokepoints, gated on `impressed` membership, and **decrement** on
   the three retraction paths. `normalizeSignals` defaults absent counters to 0
   and preserves them across a `SIGNALS_VERSION` bump.
2. `app/composables/for-you/base-rates.ts` — pure: `measuredBaseRates(counters)`
   implementing §5 and §6, returning a full `Record<keyof ActionProbabilities,
   number>`.
3. `RankingContext.baseRates?`, resolved in `feed.ts` the way `weights`/`params`
   already are; `predictActions` reads it instead of the module constant.
4. The preference gate, shared with Tier 2 (`TIER-2.md` §5), default off.
5. A dev-only line in the `for-you-debug` sink: shipped vs measured per head,
   `n`, and the `N/P` ratio.

## 9. Tests

- Zero counters ⇒ `measuredBaseRates` returns `BASE_RATES` **byte-identically**,
  and `predictActions` output is unchanged — the same exact-cold-start guarantee
  `α = 1` gives Tier 2.
- Shrinkage: `k/n` recovered as `s → 0`; `B₀` recovered as `n → 0`.
- Conditional heads divide by `eligible`, not `impressions`.
- The §6 guardrail trips and falls back when `N/P` is driven out of band.
- Counters survive a `SIGNALS_VERSION` bump; affinity maps still do not.
- **Population matching (§3), the regression tests that matter most:**
  - `markSeen` from `masto/routes.ts` does **not** move `impressions` or add to
    `impressed`; the For You call site does both.
  - an action on a status never in `impressed` does **not** increment its
    counter, even though `recordEngagement` still records the signal normally
    (affinity behaviour must be unchanged);
  - `forgetEngagement` / `forgetFollow` / `forgetNotInterested` decrement, and
    counters floor at 0 rather than going negative;
  - `impressed` evicts oldest-first at `MAX_SEEN`, like `seen`.

## 10. Open decisions

1. **Prior strength `s`** — 500 pseudo-impressions by default. Lower personalises
   faster and is noisier.
2. **Counter horizon** — lifetime, or a long half-life (e.g. 12 months) so a
   viewer's habits from two years ago stop counting? Lifetime is simpler and
   converges better; a horizon tracks genuine behaviour change.
3. **Does `dwell`/`profileClick` get measured at all**, given both carry weight
   0.0 today? Cheap to measure, inert until a weight changes. Recommend measure.
4. **Ship Tier 1 before Tier 2, or hold both?** Recommend shipping alone: it
   stands on its own, and Tier 2's gate is more honest when its baseline is a
   measured intercept rather than a fictional one.
5. **`impressed` bound.** `MAX_SEEN` (3000) mirrors `seen` and roughly doubles
   its storage. A smaller bound saves space but under-counts actions on posts
   that scrolled past longer ago; a larger one costs `localStorage` budget that
   Tier 2 would rather spend on IndexedDB anyway. 3000 unless measurement says
   otherwise.
