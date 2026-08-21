/**
 * Captures a real candidate pool for `scripts/for-you-replay.ts`.
 *
 *   node scripts/for-you-capture.ts --viewer davep@fosstodon.org
 *   node scripts/for-you-capture.ts --viewer davep@fosstodon.org --out pool.json
 *
 * The replay harness has a `--pool` flag but nothing produced a file for it, so
 * every measurement ran against a synthetic pool. This builds a real one.
 *
 * ## Why this is not a logged-in session
 *
 * A true session needs OAuth credentials. What this does instead is pick a real
 * public account as the *viewer* and reconstruct the pool the ranker would see
 * for them, entirely from public endpoints:
 *
 *   - **in-network** — the accounts the viewer actually follows
 *     (`/accounts/:id/following`), and their recent posts. This is a real
 *     follow graph, not a coin flip.
 *   - **mutuals** — intersected with the viewer's actual followers
 *     (`/accounts/:id/followers`). Real mutuals, which is what the
 *     bidirectional reply boost is gated on.
 *   - **out-of-network** — the viewer's own instance's federated, local and
 *     trending timelines, which is where the OON candidate sources draw from.
 *
 * What it cannot reproduce: `list` and `network2hop` sources, personalised
 * `home` ordering, and the viewer's engagement signals (the replay runs with
 * `EMPTY_SIGNALS` either way, so affinity is neutral in both arms).
 *
 * Accounts that hide their follows, or instances that require auth on public
 * timelines, will yield a thinner pool — the script reports what it got.
 */

import { writeFile } from 'node:fs/promises'

const UA = 'elk-foryou-calibration/1.0 (+https://github.com/elk-zone/elk)'
const args = process.argv.slice(2)
function argOf(name: string) {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] ?? null
}

const viewerArg = argOf('--viewer')
const outPath = argOf('--out') ?? 'for-you-pool.json'
const followLimit = Number(argOf('--follows') ?? 60)

if (!viewerArg) {
  console.error('usage: node scripts/for-you-capture.ts --viewer user@instance [--out pool.json] [--follows 60]')
  process.exit(1)
}

const [viewerUser, viewerHost] = viewerArg.replace(/^@/, '').split('@')
if (!viewerUser || !viewerHost) {
  console.error('--viewer must look like user@instance')
  process.exit(1)
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
      await new Promise(r => setTimeout(r, 1200 * (attempt + 1)))
    }
  }
  return null
}

/** Trim a status to the fields the ranker reads, so pools stay reviewable. */
function slim(status: any) {
  const a = status.account ?? {}
  return {
    id: status.id,
    createdAt: status.created_at,
    content: status.content,
    language: status.language,
    visibility: status.visibility,
    sensitive: status.sensitive,
    spoilerText: status.spoiler_text,
    inReplyToId: status.in_reply_to_id,
    inReplyToAccountId: status.in_reply_to_account_id,
    favouritesCount: status.favourites_count,
    reblogsCount: status.reblogs_count,
    repliesCount: status.replies_count,
    mediaAttachments: (status.media_attachments ?? []).map((m: any) => ({ type: m.type, meta: m.meta })),
    tags: (status.tags ?? []).map((t: any) => ({ name: t.name })),
    card: status.card ? { url: status.card.url, image: status.card.image } : null,
    poll: status.poll ? {} : null,
    reblog: status.reblog ? slim(status.reblog) : null,
    account: {
      id: a.id,
      acct: a.acct,
      followersCount: a.followers_count,
      followingCount: a.following_count,
      statusesCount: a.statuses_count,
      bot: a.bot,
      note: a.note,
      fields: (a.fields ?? []).map((f: any) => ({ verifiedAt: f.verified_at })),
      createdAt: a.created_at,
    },
  }
}

console.log(`resolving @${viewerUser}@${viewerHost}…`)
const viewer = await getJson(`https://${viewerHost}/api/v1/accounts/lookup?acct=${viewerUser}`)
if (!viewer?.id) {
  console.error('could not resolve that account (instance may require auth on lookup)')
  process.exit(1)
}

const following = (await getJson(`https://${viewerHost}/api/v1/accounts/${viewer.id}/following?limit=${followLimit}`)) ?? []
const followers = (await getJson(`https://${viewerHost}/api/v1/accounts/${viewer.id}/followers?limit=200`)) ?? []
if (!Array.isArray(following) || following.length === 0) {
  console.error('this account exposes no follow list — pick another viewer')
  process.exit(1)
}

const followerIds = new Set((followers as any[]).map(a => a.id))
const mutualAuthorIds = (following as any[]).filter(a => followerIds.has(a.id)).map(a => a.id)
console.log(`  follows ${following.length}, followed back by ${mutualAuthorIds.length} of them`)

// In-network: what the accounts the viewer follows have actually posted.
const candidates: any[] = []
const seen = new Set<string>()
function push(status: any, source: string, inNetwork: boolean) {
  if (!status?.id || seen.has(status.id))
    return
  seen.add(status.id)
  candidates.push({ status: slim(status), sources: [source], inNetwork })
}

let done = 0
for (const account of following as any[]) {
  // A few posts each, not a full backfill: `home` is ~25% of a real pool, and
  // over-weighting it would flatter any in-network or mutual-follow effect.
  const statuses = await getJson(`https://${viewerHost}/api/v1/accounts/${account.id}/statuses?limit=4&exclude_replies=false`, 2)
  if (Array.isArray(statuses)) {
    for (const status of statuses) push(status, 'home', true)
  }
  if (++done % 10 === 0)
    console.log(`  in-network: ${done}/${following.length} accounts, ${candidates.length} posts`)
  await new Promise(r => setTimeout(r, 200))
}
const inNetworkCount = candidates.length

// Out-of-network: exactly the timelines the OON candidate sources draw from,
// paged to the same depth `candidates.ts` uses (`DEFAULT_SOURCE_PAGES`), so the
// captured source mix resembles a real pool rather than drowning in in-network
// posts. Each source paginates on its *own* last id — sharing a cursor across
// timelines silently truncates all but the first.
for (const [source, base, pages] of [
  ['federated', `https://${viewerHost}/api/v1/timelines/public?remote=true&limit=40`, 4],
  ['local', `https://${viewerHost}/api/v1/timelines/public?local=true&limit=40`, 4],
  ['trending', `https://${viewerHost}/api/v1/trends/statuses?limit=20`, 4],
] as const) {
  let cursor: string | null = null
  for (let page = 0; page < pages; page++) {
    const url = source === 'trending'
      ? `${base}&offset=${page * 20}`
      : `${base}${cursor ? `&max_id=${cursor}` : ''}`
    const batch = await getJson(url)
    if (!Array.isArray(batch) || batch.length === 0)
      break
    for (const status of batch) push(status, source, false)
    cursor = batch.at(-1)?.id ?? null
    await new Promise(r => setTimeout(r, 250))
  }
}

const pool = {
  capturedAt: new Date().toISOString(),
  viewer: `${viewerUser}@${viewerHost}`,
  mutualAuthorIds,
  candidates,
}
await writeFile(outPath, JSON.stringify(pool, null, 2))

const mutualSet = new Set(mutualAuthorIds)
const byMutual = candidates.filter(c => mutualSet.has(c.status.account.id)).length
const bots = candidates.filter(c => c.status.account.bot).length
const remote = candidates.filter(c => String(c.status.account.acct).includes('@')).length

console.log(`\nwrote ${outPath}`)
console.log(`  ${candidates.length} candidates — ${inNetworkCount} in-network, ${candidates.length - inNetworkCount} out-of-network`)
console.log(`  ${byMutual} by mutuals (${((100 * byMutual) / candidates.length).toFixed(0)}%), ${bots} bots (${((100 * bots) / candidates.length).toFixed(0)}%), ${remote} remote (${((100 * remote) / candidates.length).toFixed(0)}%)`)
console.log(`\nnow run:  node scripts/for-you-replay.ts --pool ${outPath} --set bidirectionalFollowReplyWeightBoost=0`)
