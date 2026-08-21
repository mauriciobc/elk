# For You — local training of `predictActions` (decision record)

Status: **GO on Tier 1 (measured base rates). CONDITIONAL GO on Tier 2 (`α`
personalization), which most likely returns a null result.** The originally
proposed path is a NO-GO, for reasons B1–B6 below. This record exists so the
next person does not re-derive any of this.

Date: 2026-08-20. **Revision 5.** Revision 1 contained four errors of its own
("Corrections to revision 1"); revision 3 folded in the cross-phase review
("Corrections from the phase review"); revision 4 restructured the work around
the **intercept** rather than the slopes ("Why the intercept"); revision 5 adds
the population trap found while planning the Tier 1 build (below). Do not cite
revision 1.

Specs: `INTERCEPT.md` (Tier 1 — measured base rates, ships alone),
`INTERCEPT-BUILD.md` (the Tier 1 build plan) and `TIER-2.md` (the `α` work,
consolidated). There is no Tier 3 spec and there should not be one.

---

## Verdict

| Tier | Work | Call | Gate |
|---|---|---|---|
| **1** | Measured base rates (`INTERCEPT.md`) | **GO** | None. Ships alone; no new store, no dependency, exact cold start. |
| **2** | `α` personalization (`TIER-2.md`) | CONDITIONAL GO, deferred | Only in the B1 formulation, only the heads in B3, only if the gate in `TIER-2.md` §4 passes. Most likely a null result. |
| 3 | FM / LightGBM / EBM | NO-GO | Data does not exist; single viewer, no cross-user graph. |
| — | Approach 5 (LinUCB) | Defer | W4. |
| — | Approach 6 (personal priors) | NO-GO | Trades a controlled measurement for a confounded one (W2). |
| — | Approach 7 (Platt/isotonic) | **Close** | Its motivation was the clamp, which per-head calibration does not recover, and W1 shows it perturbs the DPP. Tier 1 addresses the real scale problem instead. |

---

## Why the intercept

The work was aimed at the **slope** — the `αᵢ` on the lift factors — and at
single-viewer scale the slope is the hardest thing in the model to learn and the
least valuable once learned. The **intercept** is unmeasured, far better
determined, and load-bearing:

| target | params | data it uses | precision |
|---|---|---|---|
| `favorite` base rate | 1 | all impressions (n≈3000) | **±20% relative CI** |
| `favorite` `αᵢ` | 4 | discrimination from ~90 positives | 22 events/param (floor 10) |

And Elk already records both sides of the ratio — `markSeen` for impressions,
`recordEngagement` for actions — so Tier 1 needs no new store at all, only
lifetime counters alongside the capped arrays (the caps are what currently make
`|engaged[kind]| / |seen|` saturate at `50/3000`). See `INTERCEPT.md` §3.

Two things this fixes that the `α` work never could: the boost:favourite ratio
`CALIBRATION.md` explicitly could not settle, and the risk that `offsetScore`'s
negative-branch valve — kept shut *by assumption* — is already opening on real
feeds.

**Scope honesty.** Tier 1 closes the *calibration* half of the Phoenix gap.
Neither tier closes the *personalization* half at single-viewer scale — and Elk
is not missing personalization anyway: `authorAffinity`, `tagAffinity` and
`boosterAffinity` already read the viewer's history. The gap was "hand-set
strength on personalization that already works, over a never-measured scale."
Tier 1 fixes the scale; Tier 2 attempts the strength and probably cannot beat a
reasonable guess.

---

## What holds up

- **Approach 1 (online learning) as core, Approach 2 (offline fit) as
  validation** is the right shape.
- The pipeline separation is genuinely clean: `scoreCandidate`
  (`ranking.ts:1479`) consumes `probabilities` opaquely, so `applyAdjustments`,
  author diversity, the vm-ranker DPP, the OON discount and the new-author boost
  need no changes. Only `predictActions` does.
- **Cold-start fallback to hand-set weights is right**, and B1's formulation
  makes it *exact* rather than approximate — which turns out to matter far more
  than revision 1 credited (see B1).

---

## Blockers

### B1 — the proposed reparametrization is wrong, and the right one is the whole project

"The ranker is already log-linear, so `lift_i = exp(w_i·x_i)`" is a
substitution, not an identity. `lift()` (`ranking.ts:520`) is piecewise-linear
in the signal: `1 + (max - 1)·s`. Its log is `log(1 + (max - 1)·s)`, not `w·s`.
Swapping in `exp(w·x)` discards the bounded `[min, max]` range with its
asymmetric negative arm, and lets one runaway affinity signal dominate a head.

**Corrected formulation — learn a per-factor exponent on the log-lift:**

```
log P(action) = log B + Σ αᵢ · log liftᵢ(sᵢ)     features zᵢ = log liftᵢ(sᵢ)
```

Since `liftᵢ^αᵢ` maps `[min, max]` to `[min^α, max^α]`, every bound survives and
the kink at `s = 0` is preserved; `α` rescales the strength of a factor without
changing its shape. The model stays linear in `α`, and **`α = 1` reproduces the
shipped model byte-identically.**

That last property is not cosmetic, and revision 1 undersold it. Fit `α` with a
**ridge penalty centred on 1**, not on 0. Then:

- with no data, every `α` sits at 1 and the viewer gets today's ranker exactly;
- with data in some directions of feature space and none in others, the
  unsupported directions *stay* at 1 rather than extrapolating;
- the regularization strength is the single knob that trades personalization
  against the hand-set calibration, and it can be annealed as labels accumulate.

This is the mechanism that makes B3 (few labels) and B4 (unsupported regions)
survivable rather than fatal. It is why Tier 2 is a conditional GO in this
revision and was a flat NO-GO in revision 1.

Caveat: the `αᵢ` are not identifiable independently where their features are
collinear — `engagementSignal`, `popularity` and `replyDensity` all move
together. The ridge handles it numerically; do not read individual `α` values as
causal.

### B2 — `clamp01` and the log link (bounded problem, not a blocker)

Heads are `clamp01(B × Π lift)`, and `favorite` reaches 2.07 with all four of
its signals maxed, so the clamp is reachable and `∂L/∂α = 0` there. But it is a
corner, not the operating region. Over the `engagement × authorAffinity` grid
with tag and booster affinity at zero, the head tops out at **0.720**:

```
            a=0    a=.3   a=.6   a=.9   a=1
   e=0.3   0.093  0.149  0.205  0.260  0.279
   e=0.5   0.135  0.216  0.297  0.378  0.405
   e=0.7   0.177  0.283  0.389  0.496  0.531
   e=0.9   0.219  0.350  0.482  0.613  0.657
   e=1.0   0.240  0.384  0.528  0.672  0.720
```

Clamping needs engagement, author affinity, tag affinity *and* booster affinity
all high simultaneously. Fit in the unclamped log space and clamp only at
prediction time and it costs nothing.

The log-vs-logit link is the sharper half: `log p ≈ logit p` holds for
`favorite` (B = 0.03) and `reply` (0.0035), but is ~0.69 nats wrong at
`dwell` (0.5) and `notDwelled` (0.22). Those two heads carry weights of 0.0 and
−0.02 respectively, so they are not worth training anyway — which is the same
conclusion B3 reaches by another route.

### B3 — parameter count vs. label budget

`predictActions` carries 40 `lift()` calls + 20 boolean gates ≈ 60 coefficients.
The binding constraint is not storage (see the correction below) but the
*arrival rate of labels for heads that matter*:

- `notInterested` B = 0.00012, `muteAuthor` B = 0.00002, `blockAuthor`
  B = 0.000015, `report` B = 0.000003. A single viewer generates **zero** report
  labels, essentially ever, and a handful of dismissals. Yet those heads carry
  the largest magnitudes in the model (−43.2 / −58.8 / −31.2 / −234.0), so a
  noisy learned coefficient there swings the score more than the entire positive
  side combined.
- Heads with weight 0.0 in production (`profileClick`, `dwell`) cannot affect
  ranking no matter what is learned.

**→ Freeze every negative head and every zero-weight head.** The trainable
surface is `favorite`, `retweet`, `reply`, `click` — roughly 15 `α`. That is a
tractable target for a ridge-to-1 fit within weeks of ordinary use, where 60
free coefficients would not be.

**Amendment (revision 3): `reply` is not viable and `retweet` is marginal.** At
ten events per variable, and at the shipped base rates over a 3000-impression
log, `favorite` gets ~90 positives for 4 params, `click` ~90 for 3, `retweet`
~54 for 4, and `reply` **~10 for 4**. Only `favorite` gates; `click` is
comfortably fit; `retweet` is secondary until the log roughly doubles; `reply`
is fit and reported but must never gate anything. See `TIER-2.md` §2.

### B4 — the training distribution is the ranker's own output

Labels come only from posts the ranker chose to show, and the model is then
applied to the full candidate pool. Precisely stated, this is **covariate shift
and lack of support**, not label bias: `P(action | features, impression)` is
what both the labels and the heads describe, so selection *on modelled features*
is ignorable. The damage is in the regions of feature space the current ranker
never surfaces, where the fit is unconstrained and free to extrapolate anything.

Two consequences:

- B1's ridge-to-1 is the primary mitigation — unsupported directions hold at the
  hand-set value instead of extrapolating. This is a real fix, not a hedge.
- It is not a complete fix, so some exogenous exposure is still wanted. **The
  cold-start slot cannot be borrowed as-is:** its selection rule
  (`ranking.ts:1711-1714`) is deterministic — followers ≤ 1000, age ≤ 24 h,
  exposure < 5000 — so it is selection *on author reach*, exactly the covariate
  you would want unconfounded. Randomizing *within* the slot's eligible set, and
  logging the selection probability, is the cheap version.

### B5 — the replay harness cannot exercise the features being learned

`scripts/for-you-replay.ts:179-180` runs `rankCandidates(pool, EMPTY_SIGNALS,
…)`, and `for-you-capture.ts` states in its own header that it cannot reproduce
viewer engagement signals. So `authorAffinity`, `tagAffinity` and
`boosterAffinity` are identically zero in replay — the only features
personalization can learn. "Fit on captured pairs via a for-you-replay-style
script" measures nothing as written.

Tier 2 capture must produce a **logged-in labelled impression log**, a different
artifact from the public-endpoint pool.

### B6 — the capture work is understated

`server/api/for-you-debug.post.ts` emits `reasons` = weighted *score terms*, not
the *features*; `RankingFeatures` is never serialized anywhere. A new emitter is
required.

Storage: `useUserLocalStorage` (`signals.ts:954`) works against a ~5 MB origin
budget already shared with users, drafts and the instance cache, and ~40
features × 3000 impressions is ≈ 1.2 MB of JSON. The training log belongs in
**IndexedDB with a retention policy**, separate from the signals store.

---

## Wrong as stated (in the original plan)

- **W1 — Approach 7 is not a no-op, which is the opposite of the risk revision 1
  claimed.** A monotone map leaves a pure score *sort* alone, but the feed is
  not a pure score sort: the vm-ranker DPP normalises `q_i = score_i / max_score`
  and uses `2·alpha·q_i` as the quality term (`diversity.ts:16-18, 900-901`), and
  author diversity decays scores multiplicatively. Both consume score
  *magnitude*, so any nonlinear recalibration reshapes the quality/diversity
  trade-off across the whole page. Approach 7 therefore *does* something — and
  what it does is change diversity behaviour as a side effect of a change sold as
  cosmetic. Treat it as a separate experiment with its own before/after on
  diversity metrics, not as a free win. It still does not address the stated
  motivation: no monotone map recovers information `clamp01` already destroyed.
- **W2 — Approach 6 is a downgrade.** `botEngagementPrior` et al. survived
  within-instance controls across 7–8 instances (`ranking.ts:1020-1030`).
  Replacing them with one viewer's counts substitutes a confounded small-n
  estimate for a controlled measurement — and `shrink()` already fades them out
  as popularity rises, so they are not free coefficients anyway.
- **W3 — `@wlearn/*` are real but all at 0.2.0** (verified on npm: `liblinear`,
  `xlearn`, `lightgbm`, `ebm`). Pre-1.0 WASM in a PWA where bundle size is a
  review criterion is a hard sell upstream, and per `AGENTS.md` any client-only
  dependency needs an SSR mock in `nuxt.config.ts`. **Keep every ML dependency
  script/build-time only.** The B1 formulation needs no dependency at all — a
  ridge fit over ~15 features is a few dozen lines.
- **W4 — Approach 5 (LinUCB) is not cheap here.** Its cost is not the matrix
  inverse — it is deliberately showing worse posts in a feed the user opted
  into, against a ~3 % reward rate. Defer.

---

## Corrections to revision 1

Revision 1 of this record got four things wrong. They are recorded because two
of them changed the verdict.

1. **W1 was backwards.** It asserted Platt/isotonic on the final score "changes
   zero positions" because `offsetScore` ordering is monotone-invariant. That
   ignores the DPP, which consumes `score_i / max_score`. Recalibration moves the
   feed. Verdict on Approach 7: no-op → real effect, so handle with care.
2. **B3's arithmetic conflated two stores.** It cited
   `MAX_SIGNALS_PER_KIND = 50` (`signals.ts:215`) as the label budget. That
   constant truncates the *engagement signal* arrays that `deriveAffinities`
   reads — it bounds feature memory, not labels. The training log is a new
   IndexedDB store (B6) and is not subject to it. The label budget is set by
   engagement rate over time, which is materially larger than 50. B3's
   conclusion survives on the rate argument for the negative heads, not on the
   cap.
3. **B2 was overstated.** "The clamp zeroes the gradient exactly where
   personalization lives" is not supported: over the realistic
   engagement × author-affinity grid the favorite head peaks at 0.720. The clamp
   needs all four signals high at once. Blocker → bounded design note.
4. **B1 and B4 were treated as independent.** They are not: ridge-to-1 on the
   `α` parametrization is the direct mitigation for both the low-label regime and
   the unsupported-region regime. Recognising this is what moves Tier 2 from
   NO-GO to conditional GO.

---

## Corrected approach

**Tier 1 — measure the intercept (`INTERCEPT.md`).** Lifetime counters on the
existing signals store; per-viewer base rates by Beta-Binomial shrinkage toward
the shipped values (`s = 500` pseudo-impressions), with the both-sides rescaling
constraint so the `offsetScore` valve stays shut. Zero counters ⇒ byte-identical
to today. No new store, no dependency, no gate. This is the feature.

**Tier 2 — attempt the slopes (`PHASE-0/1/2.md`).** Train only `favorite`,
`retweet`, `reply` and `click`, as per-factor exponents `αᵢ` on
`log liftᵢ(sᵢ)`, fit in unclamped log space with a ridge centred on `α = 1`,
negative and zero-weight heads frozen. Fit offline against a logged-in labelled
impression log; ship only if `TIER-2.md` §4's gate passes. Tier 1 builds most of
what Tier 2 needs and gives it an honest baseline — a measured intercept rather
than a fictional one — so attempting Tier 2 afterwards is cheap and a null
result is a cheap, publishable outcome rather than a wasted quarter.

## To-dos, ordered

0. **Ship Tier 1 first (`INTERCEPT.md`).** It has no gate and no prerequisite,
   and it is the only part of this work with a high prior of delivering a
   measurable, defensible change.
1. **Set the success metric and kill gate before writing any Tier 2 capture code.**
   AUC on held-out favourite/reblog labels with a bootstrap CI; ship only if the
   lower bound beats hand-set. Pre-register the label count at which the gate is
   first evaluated.
2. Implement B1: per-factor `αᵢ` on `log lift`, ridge centred on 1, `α = 1 ≡`
   current model. Add a unit test asserting byte-identical scores at `α = 1`
   against the existing `tests/unit/for-you-ranking.test.ts` fixtures.
3. Freeze all negative heads and all zero-weight heads. Trainable set:
   `favorite`, `retweet`, `reply`, `click` — of which only `favorite` gates
   (B3 amendment).
4. **Cheap switch, worth flipping early; not a project gate.** Randomize
   *within* `applyNewAuthorBoost`'s existing eligible set
   (`ranking.ts:1700-1723`) — recommended form: uniform over its lowest-exposure
   quartile — and log `propensity = 1/|quartile|`. That slot already spends an
   impression on a non-top-ranked post, so no *extra* impression is spent; only
   *which* post fills it is currently deterministic. Do not treat the existing
   slot as exogenous as-is, and do not add a second random slot.

   Two corrections to how this was previously written down. First, the cost is
   not zero: it is imperceptible to the viewer, but argmin `impressionProxy`
   exists to surface the *least-seen* post, so randomizing dilutes the
   new-author boost's mission — the quartile variant is what recovers most of
   it. Second, the yield is small and slow: ~1 impression in 20 is randomizable,
   so a full retention window gives ~150 randomized impressions and ~5 favourite
   positives. It cannot power Tier 2's fit. Its value is as a **drift audit**
   once positives accumulate (~110/year at ordinary usage, since stratified
   retention never evicts them).

   Consequently `TIER-2.md` §5 no longer gates shipping on it. What bounds
   closed-loop drift is the regularizer — `α ∈ [0.5, 1.5]`, ridge centred on 1 —
   not the slot. Definition: `propensity` stores `P(shown)`, and examples are
   weighted by `1/propensity`. Storing the reciprocal inverts the correction.
5. Emit `RankingFeatures` (not `reasons`); put the training log in IndexedDB
   with a retention policy, separate from the signals store.
6. Build a logged-in labelled-impression capture. The public-endpoint pool
   cannot substitute (B5).
7. Per-account weight isolation keyed on `currentUserHandle`, plus a
   user-visible reset. A poisoned local model with no escape hatch is a support
   burden.
8. If Approach 7 is pursued, measure its effect on diversity/DPP output
   explicitly (W1) — it is not a cosmetic change.

## Corrections from the phase review

The cross-phase review found **nine defects** in the Tier 2 specs. All are fixed
and enumerated in `TIER-2.md` §6, which is the canonical list; they are not
repeated here. Two of them changed *this* record rather than only the specs:

- **`reply` is not viable** — ~10 positives for 4 params. See the B3 amendment
  above.
- **The random-exposure slot was mis-scaled in both directions** — first a local
  capture preference, then (revision 3) a project-defining gate. It is neither.
  See to-do #4 below.

Also corrected here: the "zero incremental UX cost" claim for the slot. The cost
is invisible to the viewer but real for small authors, since argmin
`impressionProxy` exists to surface the *least-seen* post; the
lowest-exposure-quartile variant recovers most of it.

**Approach 7** (per-head calibration) is now **closed**, not merely unowned: its
motivation was the `clamp01` problem, which per-head calibration does not
recover, and W1 shows it perturbs the DPP. Tier 1 addresses the real scale
problem instead.

## The population trap (Tier 1, found while planning the build)

`BASE_RATES` is P(action | *shown in For You*), so a measured rate is only valid
if numerator and denominator cover the same posts. **Neither of Elk's existing
hooks does**, and the naive implementation is biased rather than merely noisy:

- `markSeen` has two call sites. `TimelineForYouItem.vue:110` is a real For You
  impression; `masto/routes.ts:98` fires when the viewer opens a status detail
  page from *any* surface. Incrementing inside `markSeen` puts non-For-You views
  in the denominator, and `signals.seen` cannot serve as the impression set
  because `routes.ts` populates it deliberately — correctly, for
  `PreviouslySeenPostsFilter`.
- `recordEngagement` is wired globally at `masto/status.ts:88`, so it fires for
  every action anywhere in the app. Dividing all engagement by For You
  impressions overstates every rate, and the contamination is **correlated**: a
  post the viewer deliberately navigated to has a much higher action rate than
  one that scrolled past.

The fix is an explicit `impressed: string[]` set written only from the For You
call site, with action counters gated on membership — plus decrements on the
three retraction paths (`forgetEngagement`, `forgetFollow`,
`forgetNotInterested`), which are all wired and would otherwise leave phantom
positives. See `INTERCEPT.md` §3.

This does not change Tier 1's verdict or its cost in any material way; it
changes the *implementation*, and it is the one detail that silently invalidates
the measurement if missed.

## Honest prior

Given B3 and B4, the most likely Tier 2 outcome is still *"learned does not
beat hand-set at any usable confidence."* The ridge-to-1 design makes that
outcome **safe** rather than merely likely — at worst the viewer keeps today's
ranker — which is why the path is worth walking. Budget it as a **time-boxed
experiment with a kill gate**, not as a feature with a ship date.
