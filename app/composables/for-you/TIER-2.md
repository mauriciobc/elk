# For You — Tier 2: `α` personalization (consolidated spec)

Status: **CONDITIONAL GO, deferred, and most likely a null result.** Tier 2
attempts to learn the *strength* of the ranker's personalization factors from
the viewer's own behaviour. Ship **Tier 1 first** (`INTERCEPT.md`) — it stands
alone, has no gate, and is where the value is.

This file consolidates three earlier specs (`PHASE-0.md` capture, `PHASE-1.md`
offline fit, `PHASE-2.md` ship). Their implementation detail was dropped as
premature: it is only needed if Tier 1's result makes Tier 2 worth attempting,
and it is re-derivable from what is kept here. What is kept is the part that is
*not* re-derivable — why the honest prior is null, and the nine defects a review
found in the original specs.

Read next to `LOCAL-TRAINING.md` (the decision record, B1–B6/W1–W4) and
`INTERCEPT.md` (Tier 1).

---

## 1. The model (B1)

Learn a **per-factor exponent** on the log-lift, not a new model:

```
P(action) = clamp01( B_action · Π liftᵢ(sᵢ)^αᵢ · Π f_k )
```

- `B_action` is the **measured** intercept from `INTERCEPT.md` §5, frozen within
  this fit. Tier 1 ships it independently, which also makes Tier 2's gate fair:
  the `α = 1` baseline is a calibrated model rather than a fictional one.
- `f_k` are the frozen gates and content priors — a fixed per-example offset.
- `liftᵢ^αᵢ` maps `[min, max]` to `[min^α, max^α]`, so every bound in
  `CALIBRATION.md` survives and the kink at `s = 0` is preserved.

**Fit with a ridge centred on `α = 1`, never on 0.** This is the mechanism that
makes the whole idea survivable: with no data every `α` sits at 1 and the viewer
gets today's ranker exactly; where feature space is unsupported the `α` *stay*
at 1 instead of extrapolating; and the regularization strength is the single
knob trading personalization against the hand-set calibration. It is also what
bounds closed-loop drift (B4) — not the random-exposure slot.

**The product form is mandatory in the serving path.** `Math.pow(x, 1) === x`
exactly in IEEE754, which is *why* `α = 1` is byte-identical; `exp(log B + Σ αᵢ
log liftᵢ)` drifts ~1 ulp and would silently void the guarantee and start
failing the pinned scores in `tests/unit/for-you-ranking.test.ts`. Fitting may
use log space — AUC is rank-based and indifferent.

Serve `clamp01(...)`, **train on the unclamped logit** with log-loss of `σ(z)`:
`clamp01` zeroes the gradient at saturation. Both are monotone in `z`, so
ranking is unaffected.

Caveat: the `αᵢ` are not independently identifiable where features are collinear
(`engagementSignal`, `popularity` and `replyDensity` move together). The ridge
handles it numerically; do not read individual `α` as causal.

## 2. Why the prior is null

`predictActions` carries ~60 coefficients. Only a handful are trainable, and the
arrival rate of labels decides which:

| head | params | positives per 3000 impressions | verdict |
|---|---|---|---|
| `favorite` | 4 | ~90 | **gating** |
| `click` | 3 | ~90 | fit, reported |
| `retweet` | 4 | ~54 | secondary; marginal until the log doubles |
| `reply` | 4 | ~10 | fit but **never gating** — below EPV at any realistic size |

Everything else is **frozen**: all negative heads (`notInterested` −43.2,
`muteAuthor` −58.8, `blockAuthor` −31.2, `report` −234.0 — a single viewer
produces zero `report` labels, ever, yet these carry the largest magnitudes in
the model), and all zero-weight heads (`profileClick`, `dwell`).

The deeper reason the prior is null: **Elk is not missing personalization.**
`authorAffinity`, `tagAffinity` and `boosterAffinity` already read the viewer's
history and already shape the ranking. Tier 2's marginal value is only "how much
better than a reasonable guess is a tuning knob" — which is small. Tier 1, by
contrast, measures a scale nothing has ever measured.

## 3. What it would need (condensed)

Slopes need per-impression feature vectors; an intercept needs two counts. That
asymmetry is the whole reason Tier 2 is expensive and Tier 1 is not.

- **Feature retention.** `RankingFeatures` is computed in `scoreCandidate` and
  thrown away; the `for-you-debug` sink emits weighted *score terms*, not
  features. A new emitter is required, plumbed through `feed.ts` the way
  `relevance`/`debug` already are.
- **A labelled impression log in IndexedDB** (not `localStorage` — ~40 features ×
  3000 impressions ≈ 1.2 MB against a 5 MB budget already shared with users,
  drafts and the instance cache), per account, versioned, with a user-visible
  reset.
- **`outcomes: OutcomeRecord[]`, appended — never a single first-wins slot.**
  See defect 1 below.
- **Stratified retention:** labelled records are never evicted by the volume cap.
  See defect 2.
- **`propensity` stores `P(shown)`**, weight `1/propensity`. See defect 4.
- **A logged-in capture.** `scripts/for-you-replay.ts` runs with `EMPTY_SIGNALS`
  and `for-you-capture.ts` says in its own header that it cannot reproduce viewer
  engagement signals — so every affinity feature is identically zero there. The
  public-endpoint pool cannot substitute (B5).

**The 1-week rate checkpoint is the cheapest kill gate in the plan.** One week
after capture starts, report two numbers — For You impressions/day and observed
positive rate per head — and project the calendar time to reach the positives
floor. If that is measured in quarters, kill it having spent a week.

## 4. The gate

- **Fit:** per-head L2 logistic regression, IPS-weighted, ridge centred on 1.
  Hand-rolled, ~50 lines, no runtime dependency. (`@wlearn/*` are real but all
  at 0.2.0; pre-1.0 WASM in a PWA is a hard upstream sell, and per `AGENTS.md`
  any client-only dep needs an SSR mock. Build-time only, if ever.)
- **Split held out by time**, not random — engagement is non-stationary.
- **Drop the unsettled tail before splitting.** See defect 3.
- **Metric:** per-head AUC, primary `favorite`, with a bootstrap 95% CI.
- **Positives floor: ≥ 40 `favorite` positives.** Below that, report as
  underpowered rather than as a verdict.
- **Ship iff `CI_lower(AUC_learned) > AUC_handset` *and* diversity does not
  regress.** See defect 7 — AUC alone is not sufficient.

Anything else, including "the CI is too wide to conclude", is a **NO-GO with a
written result**. That is a legitimate and valuable outcome, and the most likely
one.

## 5. Shipping, if the gate passes

- **Periodic refit, not per-event SGD.** Reuse the same fitter; SGD reintroduces
  learning-rate and stability tuning for no accuracy gain at 15 params.
- **Bounds `αᵢ ∈ [0.5, 1.5]`.** `[0, 2]` was reachable within a day of use and an
  exponent of 2 on `lift(engagementSignal, 8)` is a 64x swing.
- **Preference gate, default off**, shared with Tier 1 (`INTERCEPT.md` §8). Reset
  is not a kill switch — it clears `α` and lets it re-learn immediately.
- **Serving is synchronous, the refit is not.** Serve the last persisted `α` from
  the sync per-account store; the IndexedDB refit resolves out of band. A cold
  profile serves `α = 1`.
- **Fallback:** non-finite or throwing fit ⇒ serve `α = 1` for the session. Never
  break the feed over a personalisation failure.
- **Random-exposure slot: a cheap switch, not a gate.** Randomizing within
  `applyNewAuthorBoost`'s existing eligible set (`ranking.ts:1700-1723`,
  recommended: its lowest-exposure quartile) spends no extra impression, but
  yields only ~150 randomized impressions and ~5 positives per retention window
  — too few to weight the fit. Its value is a **drift audit** ~110 positives/year
  out. Turn it on early because it is cheap; do not gate shipping on it.

## 6. The nine defects a review found in the original specs

Kept because they are the expensive part to re-derive.

1. **Single-outcome schema.** `outcome?: {kind, at}` written first-wins destroyed
   the best labels: `open` precedes `favourite`, so the record kept `open` and
   the fit scored that impression a *negative* for `favorite`. Bias ran in the
   worst direction and would have been invisible.
2. **Retention was a permanent ceiling.** A flat 3000-record cap evicts positives
   as fast as they are earned, fixing the training set at ~90 favourites forever.
3. **Unsettled tail in the test fold.** Time-based holdout puts the newest
   impressions in the test fold, and those have not cleared the 24 h flush
   window, so late positives score as negatives and bias AUC invisibly.
4. **Propensity was inverted across docs.** One defined the field as `1/P(shown)`
   while the other weighted by `1/propensity` — a double inversion that
   downweights exactly the rare randomly-exposed samples the slot exists to
   produce.
5. **`reply` is not viable** — ~10 positives for 4 params.
6. **"Byte-identical" meant two different things.** Product form is exact at
   `α = 1`; log form drifts ~1 ulp.
7. **The AUC gate is DPP-blind.** The vm-ranker DPP normalises
   `q_i = score_i / max_score` (`diversity.ts:16-18`, `900-901`) and author
   diversity decays scores multiplicatively — both read *magnitude*. A learned
   `α` can improve AUC while reshaping diversity unmeasured. The gate must also
   compare author entropy, mean pairwise cosine, and score-distribution shape at
   `α = 1` vs learned.
8. **The preference gate had been dropped.** Restored, default off.
9. **The slot decision was mis-scaled in both directions** — first a local
   preference, then a project-defining gate. It is neither; see §5.

## 7. Prerequisites

1. Tier 1 shipped (`INTERCEPT.md`), so the intercept is measured and Tier 2's
   baseline is honest.
2. The `α` refactor exists with its byte-identity test — that is data-free and
   confirms or kills B1 in an afternoon.
3. The 1-week rate checkpoint (§3) projects an acceptable calendar time to the
   positives floor.
4. Success metric and kill gate agreed *before* capture code is written, since
   they decide how the capture is shaped.
