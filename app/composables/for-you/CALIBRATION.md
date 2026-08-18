# For You ranker calibration

`ranking.ts` is a transcription of X's `home-mixer` heavy ranker. The *shape* of
that computation transfers to Mastodon; its *numbers* do not. They describe a
platform where a good post gets 100k likes, retweets are about a fifth as common
as likes, and video is a first-class format.

This file records what was measured, what was changed, what was deliberately
left alone, and — importantly — which numbers here are measurements and which
are judgment calls wearing the same typeface.

Reproduce with `pnpm for-you:calibrate`. Check the effect of a change with
`pnpm for-you:replay --set someParam=value`.

---

## Samples

Collected **2026-08-17** against the live public API, unauthenticated.

| sample | n | instances | how |
|---|---|---|---|
| general population | 4,800 | 8 | each instance's own local timeline, seeked back ≥72h via snowflake `max_id` so counts have settled. Local posts are authoritative on their home instance. |
| observed | 2,466 | 5 | federated timeline (`remote=true`), same age seek. This is the distribution the ranker actually consumes. |
| trending | 405 unique (1,064 raw) | 15 | `/api/v1/trends/statuses`, deduped across observers keeping the best-federated copy |
| paired coverage | 186 | 6 observers | each remote trending post re-fetched from its **home** instance and compared |

Instances: fosstodon.org, hachyderm.io, mstdn.social, universeodon.com, mas.to,
techhub.social, chaos.social, social.tchncs.de (+ mastodon.social,
infosec.exchange, mastodon.world, mstdn.jp, troet.cafe, mastodon.online,
toot.community for trending).

Independent corroboration: [Buffer's 2026 engagement report](https://buffer.com/resources/state-of-social-media-engagement-2026/)
(52M posts) puts Mastodon's median at ~3 interactions per post — same order of
magnitude as the measured median of 1, from a completely different sampling frame.

---

## Finding 0 — the three engagement counts do not federate equally

The one that reordered everything else. `extractRankingFeatures` used to do:

```ts
const totalEngagement = favourites + reblogs + replies
```

which treats all three as equally observable. Measured two ways:

**Paired — same post, home instance vs. observing instance (n=186):**

| count | observed/home median | mean | p10 |
|---|---|---|---|
| favourites | **0.60** | 0.51 | **0.00** |
| boosts | 0.93 | 0.88 | 0.66 |
| replies | 1.00 | 0.98 | 0.91 |

**Unpaired — remote posts as a client actually sees them (n=2,466):**

| | share with ≥1 | fav : boost : reply |
|---|---|---|
| remote (observed) | fav **4.0%**, boost 32.8%, reply 12.7% | 1 : **1.755** : 0.603 |
| local (authoritative) | fav 52.6%, boost 35.0%, reply 24.7% | 1 : 0.465 : 0.119 |

**96% of remote posts report zero favourites, and boosts outnumber favourites —
the exact inverse of the truth.** Favourites federate only to the author's and
the favouriter's instances; a boost is itself a delivery event, so it travels
with the post. The paired figure (0.60) is the *optimistic* bound: it was
measured on trending posts, which trended because they propagated well.

Between-observer variance is large — boost/fav ranges 0.998 to 5.159 across the
5 observing instances — because it depends on federation topology.

→ `favouriteCoverageRemote` / `reblogCoverageRemote` / `replyCoverageRemote`,
applied to remote counts only.

**What this does not do.** It corrects the scale, not the post. Dividing zero by
0.6 is still zero, and the p10 of 0.00 says a tenth of remote posts have nothing
to correct. The earlier revision that removed a flat federation multiplier was
right that no multiplier recovers a favourite that never arrived; what it got
wrong was assuming coverage is unmeasurable. It is measurable, and it is three
different numbers, not one.

---

## Measured

### Engagement scale

| metric | measured | old constant |
|---|---|---|
| median total interactions (local) | 1 | — |
| p99 / max, local | 68 / 769 | `ENGAGEMENT_SATURATION = 1_000_000` |
| p99 / max, remote-observed | 13 / 395 | ” |
| max, trending | 1,343 | ” |
| velocity p99 / max (int./hr) | 34.3 / 155.5 | `VELOCITY_SATURATION = 500` |
| max replies on any post | 44 | `REPLY_SATURATION = 100` |
| zero-engagement posts | 36.4% local, **59.3% remote** | — |

At 1,000,000 the entire fediverse range occupied 0.05–0.52 of a feature meant to
span 0–1, so `lift(engagementSignal, 8)` delivered **3.31× of its intended 8×**
for a median trending post.

**`engagementSaturation` is now 10,000, not the 2,000 the data naively fits.**
The 1,343 ceiling comes only from `/trends/statuses`, which is algorithmically
ranked *and* moderator-gated on many instances; no genuinely viral post from a
large account was ever sampled, so the true ceiling is higher than anything here.
10,000 keeps most of the dynamic-range gain (median trending post 3.31× → 3.77×,
top of sample 5.7× → 6.6×) while leaving ~7× headroom before clipping. It is the
least certain constant in the file and the first thing to sweep.

**The other four saturation points were already about right** and are unchanged.
Worth recording: the X-scale problem was specific to total engagement, not
general to the file.

### Action mix

Boost/favourite, three estimates that disagree — and the spread is itself the finding:

| estimator | boost/fav |
|---|---|
| authoritative local posts | 0.465 |
| implied by per-count coverage (0.465 × 0.93/0.60) | 0.721 |
| federated timelines as observed | 1.755 |

The For You pool mixes local and remote sources, so the effective value sits
between the first two. `BASE_RATES.retweet` 0.006 → **0.018** (0.6 × the
favourite rate). Reply was already right: 0.003 → 0.0035 against a measured
0.119 ratio.

Caveat that matters: `BASE_RATES` is P(*this viewer* acts | impression), while
what was measured is aggregate counts per post. Boosts inflate their own
impression denominator — a boost is what generates the impressions. The ratio is
used directionally, not as a literal transfer.

### Content priors

Reach-controlled **and within-instance**. Both controls are necessary: mean
engagement varies **7.5×** across instances (techhub.social 1.46, chaos.social
10.95) and bot share ranges **0–49%**, so a pooled effect that doesn't reproduce
inside each instance is an artifact of instance selection.

| prior | pooled | within-instance | reproduces in |
|---|---|---|---|
| bot author | 0.23× | 0.16–0.43× | 6 of 7 testable |
| link card | 0.68× | 0.61–0.80× | 7 of 8 |
| media (humans) | 1.25× | — | — |
| hashtags (humans) | 1.29× | — | — |

Bot and link-card are two effects, not one seen twice: P(bot ∧ card) is only
1.16× what independence predicts, and the card effect is unchanged with bots
removed (0.68× → 0.67×).

**These are measurements of *crowd* engagement, so they are faded out as
observed engagement grows** (`priorStrength = 1 - popularity`). Applying them at
full strength on top of a visible count is the same effect twice — a post with
media already *has* the extra favourites the media earned it. They earn their
keep where the counts are silent, which on the fediverse is most of the time.

`botEngagementPrior` ships at **0.4**, the conservative end of its range, for two
reasons: the measurement comes from local public timelines where bots are far
over-represented relative to a For You pool, and below ~0.4 the discount pushes a
zero-engagement bot post under `NEGATIVE_SCORES_OFFSET` — into the band that
means "the viewer rejected this". Predicted-low-engagement should rank a post
last, not mark it rejected.

Related fix: bot-ness used to *also* inflate `notInterested` (×1.8) and
`muteAuthor` (×2). That was the same signal counted on both sides at once,
against the file's own one-signal-one-place rule, and it is what broke the
negative-band invariant. Those two multipliers are gone; bot-ness now lives on
the positive heads only, where it is measured.

---

## Judgment, not measurement

`MASTODON_WEIGHTS` is a product decision. Nothing measures what a favourite is
*worth* relative to a boost, and X's table is a considered answer from a platform
with real training data. So the deltas are deliberately few:

| head | X | Mastodon | reason |
|---|---|---|---|
| `quote` | 5.0 | 1.0 | closer to a bug fix. The head is derived as `retweet * 0.12`, so at 5.0 it adds 0.60 per unit of P(boost) against the real boost head's 1.0 — a 60% surcharge for an action most fediverse software cannot perform. |
| `share` | 2.0 | 0.5 | X folds `share_via_dm` (5.0) and `share_via_copy_link` (20.0) into this one head; neither has a fediverse analogue. |

**Left alone deliberately:**

- `retweet` stays 1.0. Boosting being the only distribution mechanism is a real
  argument for valuing it higher, but `BASE_RATES` already raises boost's
  contribution 3× on measured grounds. Moving the weight too compounds to ~4.5×,
  with the second factor resting on nothing.
- `BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST` stays 15.0 — but see the section
  below. It has now been measured, and the reason to leave it alone is not that
  it is harmless.
- The CW/spoiler `click` lift (×1.8). Only 1% of the sample carried a content
  warning — far too few to conclude anything.
- `vqv`, `MIN_VIDEO_DURATION_MS`, `MAX_FOLLOWERS_THRESHOLD`. Video is **1.1%** of
  posts, so this machinery serves almost nothing and the follower gate is X
  creator-monetization logic with no fediverse meaning — but removing it is churn
  worth ~1.6% of contribution against a file whose value is being a faithful
  transcription. Recorded, not changed.

---

## What each stage actually did

From `pnpm for-you:replay` on an 800-candidate synthetic pool shaped to the
measured corpus. Each row is that change alone, against the shipped defaults.

| change | Kendall tau | top-20 churn | effect on the top 20 |
|---|---|---|---|
| `engagementSaturation` 1e6 → 10k | 0.949 | 0/20 | none — reorders the body, not the head |
| federation coverage correction | 0.981 | 1/20 | remote posts 40% → **45%** |
| all content priors | 0.779 | 2/20 | bots 10% → **5%**, link cards 35% → **25%** |

The saturation result is worth stating plainly because it tempers the headline:
it improves discrimination across the body of the feed but does **not** change
what surfaces first. The content priors are what move the head of the ranking.

---

## The mutual-follow reply boost — dormant, and a trap

`BIDIRECTIONAL_FOLLOW_REPLY_WEIGHT_BOOST = 15.0` adds to the `reply` weight for
an original post by a mutual follow, making the effective weight **20.0 — the
largest number anywhere in the ranker**.

**It never fires in production.** It is gated on `ctx.mutualAuthorIds`, and
nothing in `app/` populates that: `buildRankingContext` in `feed.ts` does not set
it, and `ForYouFeedOptions.ranking` is typed
`Pick<RankingContext, 'weights' | 'params'>`, so a caller cannot supply it
either. Today it is inert.

### Measured on real pools: it barely does anything

Two pools captured with `scripts/for-you-capture.ts` — real viewers, real follow
graphs, real mutuals (intersecting each viewer's actual following and followers),
real posts from the same timelines the candidate sources use:

| viewer | pool | mutuals in pool | top-20 churn, boost 15 → 0 | mutuals in top 20 | tau |
|---|---|---|---|---|---|
| davep@fosstodon.org | 571 | 15% | **1/20** | 5% → 0% | 0.986 |
| eigengott@mstdn.social | 620 | 7% | **0/20** | 0% → 0% | 0.997 |

**An earlier version of this document reported that the boost hands mutuals 60%
of the top 20. That was wrong.** It came from the synthetic pool, and it is a
good illustration of how a synthetic pool lies. The reason is visible in the
real pool's engagement by source:

| source | n | median engagement | mean | max |
|---|---|---|---|---|
| home (in-network) | 236 | **0** | 70.8 | 8,932 |
| federated | 160 | **0** | 0.3 | 3 |
| local | 159 | 1 | 3.1 | 42 |
| trending | 16 | **148.5** | 189.9 | 765 |

The head of a real ranking is dominated by the handful of genuinely high-engagement
posts — trending, plus the occasional in-network outlier. Posts by mutuals sit in
the median-zero mass, and a reply-weight boost applied to a tiny P(reply) does not
lift them into contention. The synthetic pool drew engagement for every source
from one distribution, which made in-network posts competitive at the top and let
the boost matter. Real pools are not shaped like that.

Note the `federated` row as an aside — median 0, **max 3** across 160 posts. That
is Finding 0 in the wild.

**Why it is still 15.0:** it is dormant, and now also measured to be nearly
inert if woken. The value stays at X's and is sweepable via
`RankingParams.bidirectionalFollowReplyWeightBoost`.

**If you do wire it up** — `candidates.ts` already calls
`client.v1.accounts.relationships.fetch(...)` and keeps only
`relationship.following`, discarding `followedBy` from the same payload, so
populating `mutualAuthorIds` is close to a two-line change — re-run the capture
and sweep rather than trusting either table here. Both real pools came from
tech-instance viewers with modest follow graphs (60 and 60 follows, 21 and 11
mutuals); a viewer whose follows post high-engagement content could plausibly
see more movement than these two did.

## Replication

`pnpm for-you:calibrate --quick` was run as an independent second collection —
a fresh sample about a fifth the size, taken separately. It reproduces every
load-bearing finding:

| quantity | original | replication (`--quick`) |
|---|---|---|
| federation coverage, favourites | 0.60 | 0.70 |
| federation coverage, boosts | 0.93 | 0.89 |
| federation coverage, replies | 1.00 | 1.00 |
| p10 coverage, favourites | 0.00 | 0.00 |
| remote posts with ≥1 favourite | 4.0% | 4% |
| remote zero-engagement | 59.3% | 59.3% |
| fav:boost:reply, local | 1 : 0.465 : 0.119 | 1 : 0.44 : 0.09 |
| fav:boost:reply, observed | 1 : 1.755 : 0.603 | 1 : 1.41 : 0.55 |
| bot lift | 0.23× | 0.26× |
| link-card lift (humans) | 0.68× | 0.63× |
| hashtag lift | 1.29× | 1.31× |
| media lift | 1.25× | 1.11× |
| largest post seen | 1,343 | 1,120 |

The count-coverage ordering (favourites < boosts < replies), the inversion of
the fav:boost ratio between authoritative and observed data, and the absence of
anything within an order of magnitude of `engagementSaturation` all hold.

The weakest of the four content priors is **media** — 1.25× originally, 1.11× on
replication, from n=85. Treat it as the one most likely to be noise; the bot,
link-card and hashtag priors replicate tightly.

## Known biases in this calibration

Stated so the next person can weigh them rather than rediscover them:

- **Instance selection is tech-skewed.** fosstodon, hachyderm, techhub,
  infosec.exchange are developer/infosec communities. No large art or
  general-interest instance is represented (pawoo.net returned nothing).
- **Engagement varies 7.5× across the 8 instances** sampled, and bot share
  0–49%. Pooled percentiles turn out robust (pooled p99 = 68 vs
  median-of-instances = 66), but the bot *share* figure is a property of the
  instance list, not of the fediverse.
- **Trending is moderator-gated** on many instances and algorithmically ranked on
  all of them, so it is a biased estimate of the ceiling — a lower bound.
- **One moment in time.** Re-run `pnpm for-you:calibrate` before trusting any of
  it a year from now.
