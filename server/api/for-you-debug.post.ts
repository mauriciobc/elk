/**
 * Dev-only sink for the For You ranker's trace, so the ranking can be read from
 * the dev-server terminal instead of the browser console. `feed.ts` POSTs every
 * ranked page here when running in development; this route logs it to stdout
 * and otherwise does nothing. It is inert in production builds.
 */
/* eslint-disable no-console */

interface ForYouDebugReason {
  label: string
  value: number
}

interface ForYouDebugPost {
  id: string
  acct: string
  text: string
  score: number
  rawScore: number
  relevance?: string
  reasons: ForYouDebugReason[]
}

/** One head's row of `INTERCEPT.md` §5/§6's shipped-vs-measured comparison. */
interface ForYouDebugBaseRateHead {
  head: string
  shipped: number
  measured: number
  k: number
  n: number
}

/**
 * The Step 7 payload (`INTERCEPT-BUILD.md`) — what the 1-week rate checkpoint
 * (`TIER-2.md` §3) is meant to be read from. `enabled` is whether the §6
 * preference is on (the ranker is actually using any of this); `applied` is
 * whether the measurement itself was used rather than falling back to
 * shipped rates — false both while cold (no data yet) and when the §6
 * guardrail tripped on real data. The two are reported separately so a
 * tripped guardrail — measurement present, preference on, but silently
 * serving shipped rates anyway — is visible rather than looking identical to
 * "personalization is just off."
 */
interface ForYouDebugBaseRates {
  enabled: boolean
  applied: boolean
  ratio: number
  perHead: ForYouDebugBaseRateHead[]
}

const IN_BAND_MIN = 0.1
const IN_BAND_MAX = 0.4

function logBaseRates(baseRates: ForYouDebugBaseRates | undefined): void {
  if (!baseRates)
    return

  const { enabled, applied, ratio, perHead } = baseRates
  const status = !enabled
    ? 'preference off — not personalizing'
    : applied
      ? 'applied'
      : `GUARDRAIL TRIPPED — serving shipped rates (N/P outside [${IN_BAND_MIN}, ${IN_BAND_MAX}])`

  console.log(`[for-you] base rates — ${status}, N/P = ${ratio.toFixed(3)}`)

  if (!perHead.length)
    return

  const headWidth = Math.max(4, ...perHead.map(row => row.head.length))
  console.log(`  ${'head'.padEnd(headWidth)}   shipped   measured         k         n`)
  for (const row of perHead) {
    console.log(
      `  ${row.head.padEnd(headWidth)}  ${row.shipped.toFixed(4).padStart(8)}  ${row.measured.toFixed(4).padStart(8)}  ${row.k.toFixed(1).padStart(8)}  ${row.n.toFixed(1).padStart(8)}`,
    )
  }
}

export default defineEventHandler(async (event) => {
  if (!import.meta.dev)
    return { ok: false }

  const body = await readBody<{ round: number, posts: ForYouDebugPost[], baseRates?: ForYouDebugBaseRates } | null>(event).catch(() => null)
  if (!body?.posts?.length)
    return { ok: true }

  const width = String(body.posts.length).length
  console.log(`\n[for-you] ranked page — round ${body.round}, ${body.posts.length} posts`)
  for (let i = 0; i < body.posts.length; i++) {
    const p = body.posts[i]!
    const terms = p.reasons.map(r => `${r.label} ${r.value.toFixed(4)}`).join(', ')
    const text = p.text ? `"${p.text}"` : ''
    console.log(
      `  #${String(i + 1).padStart(width)}  ${p.score.toFixed(4)}  ${(p.relevance ?? 'none').padEnd(9)}  @${p.acct.padEnd(24)}  ${text}${text ? '  ' : ''}${terms}`,
    )
  }

  logBaseRates(body.baseRates)

  return { ok: true }
})
