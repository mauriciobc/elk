/**
 * Scores one fixed pool of candidates twice — once under the shipped ranking
 * params, once under an override — and diffs the two rankings.
 *
 *   node scripts/for-you-replay.ts
 *   node scripts/for-you-replay.ts --set engagementSaturation=2000
 *   node scripts/for-you-replay.ts --set engagementSaturation=2000 --set velocitySaturation=200
 *   node scripts/for-you-replay.ts --pool path/to/pool.json
 *
 * Why this exists: the constants in `ranking.ts` were recalibrated from
 * measured fediverse data, but a measurement tells you what a number *is*, not
 * what changing it *does* to a feed. Fifteen constants moving at once with
 * "the feed looks less chronological" as the check is not a check. This gives
 * every constant change an attributable before/after.
 *
 * `rankCandidates` is pure — it takes `signals` and `ctx` as arguments and
 * touches no composable, no Nuxt runtime and no module state — so this runs as
 * a plain script.
 *
 * With no `--pool`, it generates a synthetic pool whose shape matches the
 * measured fediverse (see `CALIBRATION.md`): mostly-zero engagement, a long
 * tail, ~23% bots, ~29% link cards, a local/remote mix. That is enough to see
 * the direction of a change. To check a real one, capture a pool from a live
 * session and pass `--pool`.
 */

import type { RankingContext, RankingParams } from '../app/composables/for-you/ranking.ts'
import type { PostCandidate } from '../app/composables/for-you/types.ts'

import { rankCandidates } from '../app/composables/for-you/ranking.ts'
import { EMPTY_SIGNALS } from '../app/composables/for-you/types.ts'

const NOW = Date.now()
const TOP_N = 20

const args = process.argv.slice(2)
const overrides: Partial<RankingParams> = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') {
    const [key, value] = (args[++i] ?? '').split('=')
    if (!key || value === undefined) {
      console.error('--set expects key=value')
      process.exit(1)
    }
    ;(overrides as Record<string, unknown>)[key] = Number(value)
  }
}
const poolIndex = args.indexOf('--pool')
const poolPath = poolIndex === -1 ? null : args[poolIndex + 1]

/**
 * A pool shaped like the measured corpus rather than like a uniform sample:
 * 36% of local posts and 59% of remote ones carry no engagement at all, the
 * tail is long and thin, and bots are a fifth of the volume.
 */
function syntheticPool(size = 800): PostCandidate[] {
  // Deterministic LCG — a replay that shuffles between runs is not a replay.
  let seed = 42
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296

  return Array.from({ length: size }, (_, i) => {
    const remote = rand() < 0.6
    const bot = rand() < 0.23
    const silent = rand() < (remote ? 0.59 : 0.36)
    // Long tail: most posts in single digits, a few in the hundreds.
    const scale = bot ? 0.25 : 1
    const total = silent ? 0 : Math.floor(Math.exp(rand() * 6.5) * scale)
    const boostShare = 0.3 + rand() * 0.2
    const replyShare = 0.1 * rand()
    const reblogs = Math.floor(total * boostShare)
    const replies = Math.floor(total * replyShare)
    const favourites = Math.max(0, total - reblogs - replies)
    const ageHours = rand() * 47

    const account = {
      id: `a${i % 220}`,
      acct: remote ? `user${i % 220}@remote${i % 7}.example` : `user${i % 220}`,
      followersCount: Math.floor(Math.exp(rand() * 9)),
      followingCount: Math.floor(Math.exp(rand() * 7)),
      statusesCount: Math.floor(Math.exp(rand() * 9)),
      bot,
      note: rand() < 0.85 ? 'bio' : '',
      fields: [],
      createdAt: new Date(NOW - 3e10).toISOString(),
    }

    return {
      status: {
        id: String(1e6 - i),
        createdAt: new Date(NOW - ageHours * 3_600_000).toISOString(),
        content: '<p>post</p>',
        account,
        favouritesCount: favourites,
        reblogsCount: reblogs,
        repliesCount: replies,
        mediaAttachments: rand() < 0.29 ? [{ type: 'image', meta: {} }] : [],
        tags: rand() < 0.43 ? [{ name: 'topic' }] : [],
        card: rand() < 0.285 ? { url: 'https://example.com', image: null } : null,
        language: 'en',
        visibility: 'public',
        sensitive: false,
        spoilerText: '',
        inReplyToId: rand() < 0.1 ? 'x' : null,
        inReplyToAccountId: null,
        poll: null,
      },
      sources: new Set([remote ? 'federated' : 'local'] as const),
      inNetwork: !remote && rand() < 0.5,
    } as unknown as PostCandidate
  })
}

function kendallTau(a: string[], b: string[]): number {
  const rank = new Map(b.map((id, i) => [id, i]))
  const seq = a.map(id => rank.get(id)!).filter(r => r !== undefined)
  let concordant = 0
  let discordant = 0
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      if (seq[i]! < seq[j]!)
        concordant++
      else if (seq[i]! > seq[j]!)
        discordant++
    }
  }
  const total = concordant + discordant
  return total === 0 ? 1 : (concordant - discordant) / total
}

const captured = poolPath
  ? JSON.parse(await (await import('node:fs/promises')).readFile(poolPath, 'utf8'))
  : null

const pool: PostCandidate[] = captured
  ? (Array.isArray(captured) ? captured : captured.candidates)
      .map((c: PostCandidate) => ({ ...c, sources: new Set(c.sources ?? ['home']) }))
  : syntheticPool()

/**
 * Mutual follows. The bidirectional reply boost is gated on
 * `ctx.mutualAuthorIds`, so a harness that leaves it empty silently measures
 * nothing at all — which is what happened before this existed.
 *
 * A captured pool carries the viewer's *real* mutuals (see
 * `scripts/for-you-capture.ts`). The synthetic fallback assumes half the
 * accounts the viewer follows follow back, which is a guess and is labelled as
 * one in the output.
 */
const mutualAuthorIds: Set<string> = captured && !Array.isArray(captured) && captured.mutualAuthorIds
  ? new Set<string>(captured.mutualAuthorIds)
  : new Set<string>(
      [...new Set(pool.filter(c => c.inNetwork).map(c => c.status.account?.id).filter(Boolean) as string[])]
        .sort()
        .filter((_, i) => i % 2 === 0),
    )

function shareOf(posts: PostCandidate[], predicate: (c: PostCandidate) => boolean) {
  return `${((100 * posts.filter(predicate).length) / posts.length).toFixed(0)}%`
}

function profile(ranked: PostCandidate[], label: string) {
  const top = ranked.slice(0, TOP_N)
  const share = (predicate: (c: PostCandidate) => boolean) => shareOf(top, predicate)
  const ages = top.map(c => (NOW - Date.parse(c.status.createdAt)) / 3_600_000)
  const engagement = top.map(c =>
    (c.status.favouritesCount ?? 0) + (c.status.reblogsCount ?? 0) + (c.status.repliesCount ?? 0))

  console.log(`\n${label}`)
  console.log(`  remote in top ${TOP_N}    ${share(c => String(c.status.account?.acct ?? '').includes('@'))}`)
  console.log(`  bots in top ${TOP_N}      ${share(c => !!c.status.account?.bot)}`)
  console.log(`  link cards in top ${TOP_N} ${share(c => !!c.status.card)}`)
  console.log(`  in-network           ${share(c => c.inNetwork)}`)
  console.log(`  mutual-follow posts  ${share(c => mutualAuthorIds.has(c.status.account?.id ?? ''))}`)
  console.log(`  median age (h)       ${ages.sort((x, y) => x - y)[Math.floor(ages.length / 2)]?.toFixed(1)}`)
  console.log(`  median engagement    ${engagement.sort((x, y) => x - y)[Math.floor(engagement.length / 2)]}`)
}

const base: RankingContext = { now: NOW, viewerLanguages: ['en'], mutualAuthorIds }
const before = rankCandidates(pool, EMPTY_SIGNALS, base)
const after = rankCandidates(pool, EMPTY_SIGNALS, { ...base, params: overrides })

const realMutuals = !!(captured && !Array.isArray(captured) && captured.mutualAuthorIds)
console.log(`pool: ${pool.length} candidates${poolPath ? ` from ${poolPath}` : ' (synthetic, matched to CALIBRATION.md)'}`)
if (captured?.viewer)
  console.log(`viewer: ${captured.viewer}, captured ${captured.capturedAt}`)
console.log(`mutuals: ${mutualAuthorIds.size} author ids (${realMutuals ? 'real, from the capture' : 'assumed — synthetic pool'})`)
console.log(`pool baseline: ${shareOf(pool, c => c.inNetwork)} in-network, `
  + `${shareOf(pool, c => mutualAuthorIds.has(c.status.account?.id ?? ''))} by mutuals, `
  + `${shareOf(pool, c => !!c.status.account?.bot)} bots, `
  + `${shareOf(pool, c => String(c.status.account?.acct ?? '').includes('@'))} remote`)
console.log(`override: ${Object.keys(overrides).length ? JSON.stringify(overrides) : '(none — both sides are the shipped defaults)'}`)

const beforeIds = before.map(c => c.status.id)
const afterIds = after.map(c => c.status.id)
const beforeTop = new Set(beforeIds.slice(0, TOP_N))
const churn = afterIds.slice(0, TOP_N).filter(id => !beforeTop.has(id)).length

console.log(`\nKendall tau (full ranking)  ${kendallTau(beforeIds, afterIds).toFixed(4)}`)
console.log(`top-${TOP_N} churn                 ${churn}/${TOP_N} posts changed`)

profile(before, 'BEFORE (shipped defaults)')
profile(after, 'AFTER (with override)')

if (Object.keys(overrides).length === 0)
  console.log('\nNo --set given, so both sides are identical by construction. Pass one to see a real diff.')
