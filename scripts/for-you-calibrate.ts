/**
 * Re-derives the For You ranker's calibration constants from the live
 * fediverse. Run it, read the summary, and compare against the defaults in
 * `app/composables/for-you/ranking.ts` and the recorded numbers in
 * `app/composables/for-you/CALIBRATION.md`.
 *
 *   node scripts/for-you-calibrate.ts
 *   node scripts/for-you-calibrate.ts --quick     # smaller sample, ~1 min
 *
 * It collects four samples, and the *fourth* is the one that matters most —
 * it is what turned up the finding that the three engagement counts do not
 * federate equally:
 *
 *   1. general population — each instance's own local timeline, seeked back to
 *      posts old enough that their counts have settled. Local posts are
 *      authoritative on their home instance, so this is ground truth.
 *   2. observed — the federated timeline, i.e. remote posts exactly as a
 *      client sees them. This is the distribution the ranker actually consumes.
 *   3. trending — `/api/v1/trends/statuses`, the top of the network. Note this
 *      is algorithmically ranked *and* moderator-gated on many instances, so
 *      it is a biased estimate of the ceiling. Treat it as a lower bound.
 *   4. paired — the same post fetched from its home instance and from an
 *      observing instance, which measures federation coverage directly.
 *
 * Known access quirks, current as of 2026-08:
 *   - `mastodon.social` and `infosec.exchange` return HTTP 422 on
 *     `timelines/public` without auth, but serve `trends/statuses` fine.
 *   - `remote=true` sweeps are slow; the timeouts here are deliberately loose.
 *   - Mastodon ids are snowflakes — `(epoch_ms << 16)` — which is how this
 *     seeks straight to a target age instead of paging from the present.
 */

const LOCAL_INSTANCES = [
  'fosstodon.org',
  'hachyderm.io',
  'mstdn.social',
  'universeodon.com',
  'mas.to',
  'techhub.social',
  'chaos.social',
  'social.tchncs.de',
]

const TRENDING_INSTANCES = [
  ...LOCAL_INSTANCES,
  'mastodon.social',
  'infosec.exchange',
  'mastodon.world',
  'mstdn.jp',
  'troet.cafe',
  'mastodon.online',
  'toot.community',
]

const QUICK = process.argv.includes('--quick')
const PER_INSTANCE = QUICK ? 120 : 600
const MATURE_AGE_HOURS = 72
const UA = 'elk-foryou-calibration/1.0 (+https://github.com/elk-zone/elk)'

interface Post {
  instance: string
  remote: boolean
  fav: number
  boost: number
  reply: number
  total: number
  ageHours: number
  velocity: number
  bot: boolean
  card: boolean
  media: boolean
  tags: number
  followers: number
}

async function getJson(url: string, tries = 3): Promise<any> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25_000) })
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }
    catch {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  return null
}

function toPost(status: any, instance: string): Post {
  const account = status.account ?? {}
  const ageHours = (Date.now() - Date.parse(status.created_at)) / 3_600_000
  const fav = status.favourites_count ?? 0
  const boost = status.reblogs_count ?? 0
  const reply = status.replies_count ?? 0
  const total = fav + boost + reply
  return {
    instance,
    remote: String(account.acct ?? '').includes('@'),
    fav,
    boost,
    reply,
    total,
    ageHours,
    velocity: total / Math.max(0.25, Math.min(ageHours, 48)),
    bot: !!account.bot,
    card: status.card != null,
    media: (status.media_attachments ?? []).length > 0,
    tags: (status.tags ?? []).length,
    followers: account.followers_count ?? 0,
  }
}

/** Mastodon snowflake for a moment in time: milliseconds shifted left 16 bits. */
function snowflakeAt(epochMs: number): bigint {
  return BigInt(Math.floor(epochMs)) << 16n
}

async function sweepTimeline(instance: string, remote: boolean): Promise<Post[]> {
  const out: Post[] = []
  let maxId = snowflakeAt(Date.now() - MATURE_AGE_HOURS * 3_600_000).toString()
  const scope = remote ? 'remote=true' : 'local=true'
  for (let page = 0; page < 30 && out.length < PER_INSTANCE; page++) {
    const batch = await getJson(`https://${instance}/api/v1/timelines/public?${scope}&limit=40&max_id=${maxId}`)
    if (!Array.isArray(batch) || batch.length === 0)
      break
    for (const status of batch) out.push(toPost(status, instance))
    maxId = batch.at(-1).id
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}

async function sweepTrending(instance: string): Promise<Post[]> {
  const out: Post[] = []
  for (let offset = 0; offset < (QUICK ? 20 : 80); offset += 20) {
    const batch = await getJson(`https://${instance}/api/v1/trends/statuses?limit=20&offset=${offset}`)
    if (!Array.isArray(batch) || batch.length === 0)
      break
    for (const status of batch) out.push(toPost(status, instance))
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}

/** Pulls the home instance and the status id out of a post's canonical URL. */
const STATUS_URL_RE = /^https:\/\/([^/]+)\/.*?\/(\d+)$/

/**
 * The measurement that produced Finding 0. For each *remote* trending post,
 * re-fetch it from the instance that actually owns it and compare counts.
 */
async function measureCoverage(observers: string[]) {
  const pairs: { fav: [number, number], boost: [number, number], reply: [number, number] }[] = []
  for (const observer of observers) {
    const batch = await getJson(`https://${observer}/api/v1/trends/statuses?limit=40`)
    if (!Array.isArray(batch))
      continue
    for (const status of batch) {
      const match = STATUS_URL_RE.exec(status.url ?? '')
      if (!match || match[1] === observer)
        continue
      const home = await getJson(`https://${match[1]}/api/v1/statuses/${match[2]}`, 2)
      if (!home || home.favourites_count == null)
        continue
      pairs.push({
        fav: [status.favourites_count, home.favourites_count],
        boost: [status.reblogs_count, home.reblogs_count],
        reply: [status.replies_count, home.replies_count],
      })
      await new Promise(r => setTimeout(r, 250))
    }
  }
  return pairs
}

function percentile(values: number[], p: number): number {
  if (values.length === 0)
    return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))]!
}
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN)
const median = (v: number[]) => percentile(v, 50)
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—')

function describe(label: string, posts: Post[]) {
  const totals = posts.map(p => p.total)
  const fav = posts.reduce((a, p) => a + p.fav, 0)
  const boost = posts.reduce((a, p) => a + p.boost, 0)
  const reply = posts.reduce((a, p) => a + p.reply, 0)
  console.log(`\n${label}  n=${posts.length}  instances=${new Set(posts.map(p => p.instance)).size}`)
  console.log(`  total engagement  median=${median(totals)}  mean=${f2(mean(totals))}  p90=${percentile(totals, 90)}  p99=${percentile(totals, 99)}  max=${Math.max(0, ...totals)}`)
  console.log(`  velocity /hr      median=${f2(median(posts.map(p => p.velocity)))}  p99=${f2(percentile(posts.map(p => p.velocity), 99))}  max=${f2(Math.max(0, ...posts.map(p => p.velocity)))}`)
  console.log(`  replies           p99=${percentile(posts.map(p => p.reply), 99)}  max=${Math.max(0, ...posts.map(p => p.reply))}`)
  console.log(`  fav:boost:reply   1 : ${f2(boost / (fav || 1))} : ${f2(reply / (fav || 1))}`)
  console.log(`  share with >=1    fav=${f2(posts.filter(p => p.fav > 0).length / posts.length)}  boost=${f2(posts.filter(p => p.boost > 0).length / posts.length)}  reply=${f2(posts.filter(p => p.reply > 0).length / posts.length)}`)
  console.log(`  zero engagement   ${f2((100 * totals.filter(t => t === 0).length) / posts.length)}%   bots ${f2((100 * posts.filter(p => p.bot).length) / posts.length)}%`)
}

/**
 * Reach-controlled, within-instance lift. Both controls matter: engagement
 * varies ~7x across instances and bot share ranges 0-49%, so an effect pooled
 * across instances can be an artifact of which servers were sampled.
 *
 * Also reports, per prior, how many of the *testable* instances reproduce the
 * effect's direction — an effect whose sign flips from server to server is not
 * real. This is where the "reproduces in N of M instances" figures quoted in
 * `CALIBRATION.md` come from.
 */
function lift(posts: Post[], label: string, predicate: (p: Post) => boolean) {
  let weighted = 0
  let n = 0
  const perInstance: { instance: string, lift: number }[] = []
  for (const instance of new Set(posts.map(p => p.instance))) {
    const group = posts.filter(p => p.instance === instance)
    let instanceWeighted = 0
    let instanceN = 0
    for (let bucket = 0; bucket <= 4; bucket++) {
      const inBucket = group.filter(p => Math.min(4, Math.floor(Math.log10(Math.max(p.followers, 1)))) === bucket)
      const yes = inBucket.filter(predicate).map(p => Math.log1p(p.total))
      const no = inBucket.filter(p => !predicate(p)).map(p => Math.log1p(p.total))
      if (yes.length >= 15 && no.length >= 15) {
        const w = yes.length * (mean(yes) / Math.max(mean(no), 1e-9))
        weighted += w
        n += yes.length
        instanceWeighted += w
        instanceN += yes.length
      }
    }
    if (instanceN > 0)
      perInstance.push({ instance, lift: instanceWeighted / instanceN })
  }
  const pooled = n ? weighted / n : Number.NaN
  const reproduces = perInstance.filter(p => (pooled < 1 ? p.lift < 1 : p.lift > 1)).length
  console.log(`  ${label.padEnd(22)} n=${String(n).padStart(5)}  lift=${n ? f2(pooled) : '—'}x  reproduces in ${reproduces} of ${perInstance.length} instances`)
}

const local: Post[] = []
const observed: Post[] = []
const trending: Post[] = []

console.log(`Collecting${QUICK ? ' (quick mode)' : ''}… this takes a few minutes.`)
for (const instance of LOCAL_INSTANCES) {
  local.push(...await sweepTimeline(instance, false))
  observed.push(...await sweepTimeline(instance, true))
  console.log(`  ${instance}: ${local.filter(p => p.instance === instance).length} local, ${observed.filter(p => p.instance === instance).length} remote`)
}
for (const instance of TRENDING_INSTANCES)
  trending.push(...await sweepTrending(instance))

// Trending federates, so the same post shows up on many instances. Keep the
// best-federated copy of each rather than counting it once per observer.
const bestByPost = new Map<string, Post>()
for (const post of trending) {
  const key = `${post.followers}:${post.ageHours.toFixed(3)}`
  const seen = bestByPost.get(key)
  if (!seen || post.total > seen.total)
    bestByPost.set(key, post)
}

describe('GENERAL POPULATION (local timelines, authoritative counts)', local)
describe('OBSERVED (remote posts, as a client actually sees them)', observed)
describe('TRENDING (deduped across observers)', [...bestByPost.values()])

console.log('\nREACH-CONTROLLED, WITHIN-INSTANCE LIFTS (local posts)')
lift(local, 'bot author', p => p.bot)
lift(local, 'has link card', p => p.card)
lift(local.filter(p => !p.bot), 'link card (humans)', p => p.card)
lift(local.filter(p => !p.bot), 'media (humans)', p => p.media)
lift(local.filter(p => !p.bot), 'hashtags (humans)', p => p.tags > 0)

console.log('\nFEDERATION COVERAGE (same post: observed / home instance)')
const pairs = await measureCoverage(LOCAL_INSTANCES.slice(0, QUICK ? 2 : 6))
if (pairs.length === 0) {
  console.log('  no pairs collected — trends may be empty or unreachable right now')
}
else {
  for (const key of ['fav', 'boost', 'reply'] as const) {
    const ratios = pairs.map(p => p[key]).filter(([, home]) => home > 0).map(([obs, home]) => obs / home)
    console.log(`  ${key.padEnd(6)} median=${f2(median(ratios))}  mean=${f2(mean(ratios))}  p10=${f2(percentile(ratios, 10))}  n=${ratios.length}`)
  }
  console.log('  -> these are RankingParams.favouriteCoverageRemote / reblogCoverageRemote / replyCoverageRemote')
}

const everything = [...local, ...observed, ...bestByPost.values()]
console.log('\nOBSERVED CEILINGS (what the saturation points have to clear)')
console.log(`  total engagement  p99=${percentile(everything.map(p => p.total), 99)}  max=${Math.max(...everything.map(p => p.total))}`)
console.log(`  velocity /hr      p99=${f2(percentile(everything.map(p => p.velocity), 99))}  max=${f2(Math.max(...everything.map(p => p.velocity)))}`)
console.log(`  replies           p99=${percentile(everything.map(p => p.reply), 99)}  max=${Math.max(...everything.map(p => p.reply))}`)
console.log('  The defaults sit above these on purpose — the trending sample is')
console.log('  moderator-gated, so the true ceiling is higher than anything here.')
console.log('\nRemember these are one sample from one moment. Compare against CALIBRATION.md before changing anything,')
console.log('and use scripts/for-you-replay.ts to see what a change actually does to a ranking.')
