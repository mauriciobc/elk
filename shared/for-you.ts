/**
 * Constants the For You ranker and the dev-server debug sink must agree on.
 *
 * `app/composables/for-you/*` is the ranker's home and `server/api/for-you-debug
 * .post.ts` only formats what the ranker sends it, so nothing else belongs
 * here — but these two values genuinely span the boundary: `base-rates.ts`
 * decides with them and the debug route *names them in its output*. Copied
 * rather than shared, a drift would make the terminal report a band the
 * guardrail is not actually using, which is worse than no report at all.
 */

/**
 * The in-band range for `N/P` — `Σ|w|·B` over the negative heads divided by
 * the same sum over the positive ones (`INTERCEPT.md` §6.3).
 *
 * A measurement that lands outside it is discarded in favour of the shipped
 * rates. The band exists because `offsetScore`'s negative branch compresses
 * everything below zero into a sub-0.001 band where posts are effectively
 * unordered: a calibration that opens that valve is worse than no calibration.
 */
export const IN_BAND_MIN = 0.1
export const IN_BAND_MAX = 0.4
