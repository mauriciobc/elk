import type { mastodon } from 'masto'
import type { PreScoringContext } from '../../app/composables/for-you/candidates'
import type { RankingContext } from '../../app/composables/for-you/ranking'
import type { ForYouSignals, PostCandidate } from '../../app/composables/for-you/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCandidate, POOL_STALE_MS, resetCandidatePool, resetRateLimit, underlyingStatus } from '../../app/composables/for-you/candidates'
import {
  affinityResolver,
  AUTO_REFRESH_MAX_INTERVAL_MS,
  AUTO_REFRESH_MIN_INTERVAL_MS,
  autoRefreshIntervalMs,
  canAutoRefreshForYou,
  DEFAULT_FOR_YOU_PAGE_SIZE,
  enforceInNetworkFloor,
  forYouRelevanceReason,
  initialAutoRefreshGate,
  MIN_VIABLE_FIRST_PAGE,
  nextAutoRefreshGate,
  selectForYouPage,
  shouldAutoRefreshForYou,
  useForYouFeed,
} from '../../app/composables/for-you/feed'
import { EMPTY_SIGNALS } from '../../app/composables/for-you/types'

const NOW = Date.parse('2026-08-16T12:00:00.000Z')

function minutesAgo(minutes: number) {
  return new Date(NOW - minutes * 60_000).toISOString()
}

function status(id: string, options: {
  accountId?: string
  minutesAgo?: number
  favouritesCount?: number
  reblogsCount?: number
  content?: string
  tags?: string[]
} = {}): mastodon.v1.Status {
  return {
    id,
    uri: `https://example.com/${id}`,
    url: `https://example.com/${id}`,
    createdAt: minutesAgo(options.minutesAgo ?? 10),
    content: options.content ?? `<p>post ${id}</p>`,
    language: 'en',
    visibility: 'public',
    sensitive: false,
    spoilerText: '',
    inReplyToId: null,
    inReplyToAccountId: null,
    reblog: null,
    tags: (options.tags ?? []).map(name => ({ name, url: `https://example.com/tags/${name}` })),
    mentions: [],
    emojis: [],
    mediaAttachments: [],
    favouritesCount: options.favouritesCount ?? 0,
    reblogsCount: options.reblogsCount ?? 0,
    repliesCount: 0,
    account: {
      id: options.accountId ?? `author-${id}`,
      acct: options.accountId ?? `author-${id}`,
      followersCount: 100,
      followingCount: 100,
      statusesCount: 100,
      createdAt: minutesAgo(60 * 24 * 365),
    },
  } as unknown as mastodon.v1.Status
}

/** One candidate per id, each by its own author so author diversity is inert. */
function pool(count: number, prefix: string): PostCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    createCandidate(status(`${prefix}-${i}`, { minutesAgo: i + 1 }), 'federated', false))
}

function signals(overrides: Partial<ForYouSignals> = {}): ForYouSignals {
  return { ...EMPTY_SIGNALS, seen: [], notInterested: [], mutedForYou: [], ...overrides }
}

const ctx: RankingContext = { now: NOW, viewerId: 'viewer' }

/**
 * No Nuxt app in a unit test, so the Mastodon-side filters (which read the
 * viewer's settings) and the live `isSeen()` store are stubbed out. The floor
 * is disabled so the chain never relaxes underneath an assertion.
 */
const prescoring: PreScoringContext = {
  viewerAccountId: 'viewer',
  useMastodonFilters: false,
  isSeen: () => false,
  now: NOW,
  floor: 0,
}

function ids(candidates: PostCandidate[]) {
  return candidates.map(c => c.status.id)
}

describe('selectForYouPage', () => {
  it('emits at most a page and keeps the remainder for the next one', () => {
    const { page, rest } = selectForYouPage(pool(30, 'a'), signals(), ctx, { pageSize: 20, prescoring })

    expect(page).toHaveLength(20)
    expect(rest).toHaveLength(10)
    expect(new Set([...ids(page), ...ids(rest)]).size).toBe(30)
  })

  it('is deterministic — the same batch ranks the same way twice', () => {
    const batch = pool(30, 'a')
    const first = selectForYouPage(batch, signals(), ctx, { pageSize: 20, prescoring })
    const second = selectForYouPage(batch, signals(), ctx, { pageSize: 20, prescoring })

    expect(ids(first.page)).toEqual(ids(second.page))
  })

  it('never re-serves a post that has already been shown', () => {
    const first = selectForYouPage(pool(30, 'a'), signals(), ctx, { pageSize: 20, prescoring })
    const served = new Set(first.page.map(c => c.status.id))

    // Page two: the leftovers plus a fresh fan-out, re-ranked together.
    const second = selectForYouPage(
      [...first.rest, ...pool(15, 'b'), ...pool(30, 'a')],
      signals(),
      ctx,
      { pageSize: 20, servedKeys: served, prescoring },
    )

    for (const id of ids(second.page))
      expect(served.has(id)).toBe(false)
  })

  it('leaves the already-emitted prefix untouched as pages accumulate', () => {
    const feed: string[] = []
    const servedKeys = new Set<string>()
    let leftovers: PostCandidate[] = []

    for (let round = 0; round < 3; round++) {
      const { page, rest } = selectForYouPage(
        [...leftovers, ...pool(20, `round-${round}`)],
        signals(),
        ctx,
        { pageSize: 10, servedKeys, prescoring },
      )
      const prefixBefore = [...feed]

      for (const candidate of page) {
        servedKeys.add(candidate.status.id)
        feed.push(candidate.status.id)
      }
      leftovers = rest

      // Appending a page must not move anything that was already in the feed.
      expect(feed.slice(0, prefixBefore.length)).toEqual(prefixBefore)
      expect(page).toHaveLength(10)
    }

    expect(new Set(feed).size).toBe(feed.length)
  })

  it('drops posts the viewer dismissed and authors they muted for this feed', () => {
    const batch = [
      createCandidate(status('keep', { accountId: 'good' }), 'federated'),
      createCandidate(status('dismissed', { accountId: 'good' }), 'federated'),
      createCandidate(status('muted', { accountId: 'bad' }), 'federated'),
    ]

    const { page } = selectForYouPage(
      batch,
      signals({ notInterested: ['dismissed'], mutedForYou: ['bad'] }),
      ctx,
      { pageSize: 20, prescoring },
    )

    expect(ids(page)).toEqual(['keep'])
  })

  it('survives an empty candidate pool', () => {
    const { page, rest } = selectForYouPage([], signals(), ctx, { pageSize: 20, prescoring })

    expect(page).toEqual([])
    expect(rest).toEqual([])
  })
})

describe('affinityResolver', () => {
  it('carries a dismissal over to the author\'s other posts', () => {
    const dismissed = {
      ...signals(),
      dismissed: [{ statusId: 'old', authorId: 'noisy', tags: [], at: NOW }],
    }
    const { authorPenalty } = affinityResolver(dismissed, NOW)!

    // The ranker's own default only knows about the dismissed post itself; the
    // point of wiring `authorPenaltyIn` is that the *author* carries a penalty.
    expect(authorPenalty!('noisy')).toBeGreaterThan(0)
    expect(authorPenalty!('someone-else')).toBe(0)
  })

  // `authorPenalty` and `postPenalty` are deliberately split: the first floors
  // `muteAuthor`, the second floors `notInterested`, and a post-level
  // dismissal must not read back as an account-level one — that conflation is
  // exactly the bug this contract split fixed.
  it('does not let a post-level dismissal read back as an author-level one', () => {
    const { authorPenalty, postPenalty } = affinityResolver(signals({ notInterested: ['nope'] }), NOW)!

    expect(postPenalty!('nope')).toBe(1)
    expect(authorPenalty!('unknown-author')).toBe(0)
  })

  it('treats a muted author as a total penalty', () => {
    const { authorPenalty } = affinityResolver(signals({ mutedForYou: ['muted'] }), NOW)!

    expect(authorPenalty!('muted')).toBe(1)
  })
})

describe('forYouRelevanceReason', () => {
  it('prioritizes in-network, then network2hop, then trending, then tag', () => {
    const inNetworkAndTrending = createCandidate(status('a'), 'trending', true)
    expect(forYouRelevanceReason(inNetworkAndTrending)).toBe('following')

    const twoHopAndTag = { ...createCandidate(status('b'), 'tag', false), sources: new Set(['tag', 'network2hop'] as const) }
    expect(forYouRelevanceReason(twoHopAndTag)).toBe('network')

    const trendingOnly = createCandidate(status('c'), 'trending', false)
    expect(forYouRelevanceReason(trendingOnly)).toBe('trending')

    const tagOnly = createCandidate(status('d'), 'tag', false)
    expect(forYouRelevanceReason(tagOnly)).toBe('tag')
  })

  it('is undefined for plain federated/local content with no other signal', () => {
    const stranger = createCandidate(status('e'), 'federated', false)
    expect(forYouRelevanceReason(stranger)).toBeUndefined()
  })
})

describe('enforceInNetworkFloor', () => {
  it('reorders a page so out-of-network posts cannot sweep the leading window', () => {
    // The critic's reproduction: a realistic 5-post slate where 3 modest posts
    // from followed accounts sit behind 2 out-of-network posts a naive,
    // score-only ranking pass has already placed first.
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const oon2 = createCandidate(status('oon-2', { accountId: 'stranger-2' }), 'federated', false)
    const inA = createCandidate(status('in-a', { accountId: 'friend-a' }), 'home', true)
    const inB = createCandidate(status('in-b', { accountId: 'friend-b' }), 'home', true)
    const inC = createCandidate(status('in-c', { accountId: 'friend-c' }), 'home', true)

    const naivelyRanked = [oon1, oon2, inA, inB, inC]
    const { page } = enforceInNetworkFloor(naivelyRanked, [])

    const window = page.slice(0, 3)
    expect(window.filter(c => c.inNetwork).length).toBeGreaterThanOrEqual(2)
    // A reorder, not a drop: every post is still there, exactly once.
    expect(page).toHaveLength(5)
    expect(new Set(page.map(c => c.status.id)).size).toBe(5)
  })

  it('is a safety net, not a quota: leaves an already-balanced page untouched', () => {
    const inA = createCandidate(status('in-a', { accountId: 'friend-a' }), 'home', true)
    const inB = createCandidate(status('in-b', { accountId: 'friend-b' }), 'home', true)
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const page = [inA, inB, oon1]
    const rest = [createCandidate(status('in-c', { accountId: 'friend-c' }), 'home', true)]

    const result = enforceInNetworkFloor(page, rest)

    expect(result.page).toEqual(page)
    expect(result.rest).toEqual(rest)
  })

  it('lets network2hop help clear the floor, but promotes true in-network first', () => {
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const oon2 = createCandidate(status('oon-2', { accountId: 'stranger-2' }), 'federated', false)
    const twoHop = createCandidate(status('twohop-1', { accountId: 'fof-1' }), 'network2hop', false)
    const inA = createCandidate(status('in-a', { accountId: 'friend-a' }), 'home', true)

    const { page } = enforceInNetworkFloor([oon1, oon2, twoHop], [inA])

    // network2hop already counted toward the floor, so it survives; the true
    // in-network candidate from `rest` bumps one of the two strangers instead.
    const ids = page.map(c => c.status.id)
    expect(ids).toContain('twohop-1')
    expect(ids).toContain('in-a')
    expect(ids.filter(id => id.startsWith('oon-'))).toHaveLength(1)
  })

  it('degrades honestly when there is nothing left to promote', () => {
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const oon2 = createCandidate(status('oon-2', { accountId: 'stranger-2' }), 'federated', false)
    const oon3 = createCandidate(status('oon-3', { accountId: 'stranger-3' }), 'federated', false)
    const page = [oon1, oon2, oon3]

    // A viewer who follows nobody: the floor cannot manufacture what is not there.
    const result = enforceInNetworkFloor(page, [])
    expect(result.page).toEqual(page)
  })

  // `diversityRerank` already spread the page along author/content before the
  // floor ever runs. A promotion that ignores that can walk right back into
  // the same clash — this is the bug the re-review caught.
  it('does not promote a same-author echo of a post already in the window', () => {
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const oon2 = createCandidate(status('oon-2', { accountId: 'stranger-2' }), 'federated', false)
    const inA = createCandidate(status('in-a', { accountId: 'friend-a' }), 'home', true)

    // Ranked ahead of the other candidate (index 0), but by the same author as
    // `in-a`, which is already in the window.
    const sameAuthorEcho = createCandidate(status('in-a-echo', { accountId: 'friend-a' }), 'home', true)
    const distinctAuthor = createCandidate(status('in-b', { accountId: 'friend-b' }), 'home', true)

    const { page } = enforceInNetworkFloor([oon1, oon2, inA], [sameAuthorEcho, distinctAuthor])

    const ids = page.map(c => c.status.id)
    expect(ids).not.toContain('in-a-echo')
    expect(ids).toContain('in-b')
    // No two posts by the same author anywhere in the resulting page.
    const authors = page.map(c => underlyingStatus(c.status).account?.id)
    expect(new Set(authors).size).toBe(authors.length)
  })

  it('does not promote a near-duplicate of a post already in the window', () => {
    const oon1 = createCandidate(status('oon-1', { accountId: 'stranger-1' }), 'federated', false)
    const oon2 = createCandidate(status('oon-2', { accountId: 'stranger-2' }), 'federated', false)
    const inA = createCandidate(status('in-a', {
      accountId: 'friend-a',
      tags: ['birdwatching', 'photography'],
      content: '<p>Spent the morning birdwatching by the river, got some great shots</p>',
    }), 'home', true)

    // Ranked ahead of the clean candidate (index 0), different author, but
    // near-identical content to `in-a` — the case the embedding, not the
    // author check, has to catch.
    const nearDuplicate = createCandidate(status('in-dup', {
      accountId: 'friend-dup',
      tags: ['birdwatching', 'photography'],
      content: '<p>Spent the morning birdwatching by the river, got some great shots</p>',
    }), 'home', true)
    const distinctTopic = createCandidate(status('in-clean', {
      accountId: 'friend-clean',
      tags: ['baking'],
      content: '<p>First attempt at sourdough, it actually rose this time</p>',
    }), 'home', true)

    const { page } = enforceInNetworkFloor([oon1, oon2, inA], [nearDuplicate, distinctTopic])

    const ids = page.map(c => c.status.id)
    expect(ids).toContain('in-clean')
    expect(ids).not.toContain('in-dup')
  })
})

describe('useForYouFeed (orchestration)', () => {
  const orchestrationPrescoring: PreScoringContext = {
    viewerAccountId: 'viewer',
    useMastodonFilters: false,
    isSeen: () => false,
    now: NOW,
    floor: 0,
  }

  function timelineOf(statuses: mastodon.v1.Status[]) {
    return {
      list: () => ({
        async* values() {
          if (statuses.length)
            yield statuses
        },
      }),
    }
  }

  function makeClient(sources: { home?: mastodon.v1.Status[], public?: mastodon.v1.Status[] } = {}): mastodon.rest.Client {
    return {
      v1: {
        timelines: {
          home: timelineOf(sources.home ?? []),
          public: timelineOf(sources.public ?? []),
        },
      },
    } as unknown as mastodon.rest.Client
  }

  function feedOptions(client: mastodon.rest.Client) {
    return {
      client,
      now: () => NOW,
      prescoring: orchestrationPrescoring,
    }
  }

  beforeEach(() => {
    resetCandidatePool()
    resetRateLimit()
  })

  afterEach(() => {
    resetCandidatePool()
    resetRateLimit()
  })

  it('round zero: a home fill alone that fills a page never touches the fallback', async () => {
    const homeStatuses = Array.from({ length: DEFAULT_FOR_YOU_PAGE_SIZE }, (_, i) =>
      status(`fast-${i}`, { accountId: `author-fast-${i}`, minutesAgo: i + 1 }))
    const client = makeClient({ home: homeStatuses })

    const { paginator, isFallback, relevance } = useForYouFeed(feedOptions(client))
    const page1 = (await paginator.values().next()).value

    expect(page1).toHaveLength(DEFAULT_FOR_YOU_PAGE_SIZE)
    expect(isFallback.value).toBe(false)
    const providedIds = new Set(homeStatuses.map(s => s.id))
    for (const item of page1!) {
      expect(providedIds.has(item.id)).toBe(true)
      // Every emitted post is home-sourced, in-network — driven through the
      // real generator's own `emit()`, not called directly.
      expect(relevance.get(item.id)).toBe('following')
    }
  })

  it('falls back to the home timeline, then local, when the ranked pool is too thin', async () => {
    // Below MIN_VIABLE_FIRST_PAGE anywhere in the ranked pool, so round zero
    // must hand over to the chronological fallback.
    const homeStatuses = [
      status('home-1', { accountId: 'friend-1', minutesAgo: 5 }),
      status('home-2', { accountId: 'friend-2', minutesAgo: 10 }),
    ]
    expect(homeStatuses.length).toBeLessThan(MIN_VIABLE_FIRST_PAGE)
    // Old enough to fall outside even the relaxed age horizon, so these never
    // enter the *ranked* pool via the federated/local candidate sources — they
    // only appear through `fallbackPages`'s own unfiltered chronological pull.
    const localStatuses = [
      status('local-1', { accountId: 'stranger-1', minutesAgo: 60 * 24 * 30 }),
      status('local-2', { accountId: 'stranger-2', minutesAgo: 60 * 24 * 30 }),
      status('local-3', { accountId: 'stranger-3', minutesAgo: 60 * 24 * 30 }),
    ]
    const client = makeClient({ home: homeStatuses, public: localStatuses })

    const { paginator, isFallback } = useForYouFeed(feedOptions(client))
    const iterator = paginator.values()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(new Set(first.value!.map(s => s.id))).toEqual(new Set(['home-1', 'home-2']))

    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect(new Set(second.value!.map(s => s.id))).toEqual(new Set(['local-1', 'local-2', 'local-3']))

    expect(isFallback.value).toBe(true)
  })

  it('the empty/new-user path finishes the generator instead of erroring', async () => {
    const client = makeClient({ home: [], public: [] })

    const { paginator, isFallback } = useForYouFeed(feedOptions(client))
    const first = await paginator.values().next()

    expect(first.done).toBe(true)
    expect(isFallback.value).toBe(true)
  })

  it('page 2+ never re-serves what an earlier page emitted, driven through the real generator', async () => {
    const pageSize = 5
    const homeStatuses = Array.from({ length: 12 }, (_, i) =>
      status(`p-${i}`, { accountId: `author-${i}`, minutesAgo: i + 1 }))
    const client = makeClient({ home: homeStatuses })

    const { paginator } = useForYouFeed({ ...feedOptions(client), pageSize })
    const iterator = paginator.values()

    const page1 = (await iterator.next()).value!
    const page2 = (await iterator.next()).value!

    expect(page1).toHaveLength(pageSize)
    expect(page2).toHaveLength(pageSize)

    const ids1 = page1.map(s => s.id)
    const ids2 = page2.map(s => s.id)
    expect(new Set([...ids1, ...ids2]).size).toBe(pageSize * 2)
    for (const id of ids2)
      expect(ids1).not.toContain(id)
  })

  /** A `home.list()` whose response changes across calls, indexed by call count. */
  function statefulTimeline(...batches: mastodon.v1.Status[][]) {
    let calls = 0
    return {
      list: () => {
        const statuses = batches[Math.min(calls, batches.length - 1)] ?? []
        calls++
        return {
          async* values() {
            if (statuses.length)
              yield statuses
          },
        }
      },
    }
  }

  it('refresh() re-ranks fresh content and does not duplicate what was already served', async () => {
    // `candidates.ts`'s `MIN_FILL_INTERVAL_MS` throttle means round zero's own
    // second (awaited, non-`force`) fill call — moments after the first, in
    // the same synchronous burst — is a no-op that reuses the pool rather
    // than reaching the network again. So round zero makes exactly *one* real
    // `home.list()` call (the fast fill); the explicit, `force`d `refresh()`
    // below is the second.
    const firstBatch = Array.from({ length: 5 }, (_, i) =>
      status(`old-${i}`, { accountId: `author-old-${i}`, minutesAgo: i + 1 }))
    const client: mastodon.rest.Client = {
      v1: {
        timelines: {
          home: statefulTimeline(
            firstBatch, // call 0: round zero's fast fill
            // call 1+: what an explicit refresh finds — 2 posts already
            // served plus 3 genuinely new ones.
            [
              firstBatch[0]!,
              firstBatch[1]!,
              status('new-0', { accountId: 'author-new-0', minutesAgo: 1 }),
              status('new-1', { accountId: 'author-new-1', minutesAgo: 1 }),
              status('new-2', { accountId: 'author-new-2', minutesAgo: 1 }),
            ],
          ),
          public: timelineOf([]),
        },
      },
    } as unknown as mastodon.rest.Client

    const { paginator, refresh } = useForYouFeed(feedOptions(client))
    const iterator = paginator.values()

    const page1 = (await iterator.next()).value!
    expect(new Set(page1.map(s => s.id))).toEqual(new Set(firstBatch.map(s => s.id)))

    const { updated } = await refresh()
    expect(updated).toBe(true)

    const page2 = (await iterator.next()).value!
    const ids2 = page2.map(s => s.id)
    expect(new Set(ids2)).toEqual(new Set(['new-0', 'new-1', 'new-2']))
    // The two already-served ids came back in the refresh's own response but
    // must not resurface — `servedIds`/`servedKeys` catch them regardless of
    // the cursor reset.
    expect(ids2).not.toContain('old-0')
    expect(ids2).not.toContain('old-1')
  })

  it('an empty refresh reports no update rather than disturbing what has been served', async () => {
    // Every call returns the same content, so nothing is ever "new".
    const homeStatuses = Array.from({ length: 5 }, (_, i) =>
      status(`p-${i}`, { accountId: `author-${i}`, minutesAgo: i + 1 }))
    const client = makeClient({ home: homeStatuses })

    const { paginator, served, refresh } = useForYouFeed(feedOptions(client))
    await paginator.values().next()

    const servedBefore = [...served.value]
    const { updated } = await refresh()

    expect(updated).toBe(false)
    // Nothing about the session's bookkeeping moved — a refresh that finds
    // nothing new must never look like a reset.
    expect(served.value).toEqual(servedBefore)
  })

  it('honours the instance 429 backoff instead of punching through it', async () => {
    // One refresh is a full fan-out — tens of requests plus relationship
    // batches — against a 300-per-5-minute budget shared with the whole app.
    // A viewer tapping "Show new posts" while the server is already saying 429
    // must not be able to degrade their own Following tab and notifications.
    let calls = 0
    const refusing = {
      list: () => ({
        async* values() {
          calls++
          throw new Error('429 Too Many Requests')
        },
      }),
    }
    const client = {
      v1: { timelines: { home: refusing, public: refusing } },
    } as unknown as mastodon.rest.Client

    const { paginator, refresh } = useForYouFeed(feedOptions(client))
    // The first fill trips the 429 and arms the backoff.
    await paginator.values().next()
    const callsWhileArming = calls
    expect(callsWhileArming).toBeGreaterThan(0)

    const result = await refresh()

    expect(result.rateLimited).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.retryInMs).toBeGreaterThan(0)
    // The whole point: not one further request goes out while backing off.
    expect(calls).toBe(callsWhileArming)
  })

  it('flags stale only once POOL_STALE_MS has passed since the pool was last filled', async () => {
    const homeStatuses = Array.from({ length: 5 }, (_, i) =>
      status(`p-${i}`, { accountId: `author-${i}`, minutesAgo: i + 1 }))
    const client = makeClient({ home: homeStatuses })

    const { paginator, stale, checkStale } = useForYouFeed(feedOptions(client))

    // Before anything has ever loaded, there is nothing to be stale about.
    checkStale(Date.now())
    expect(stale.value).toBe(false)

    await paginator.values().next()
    const filledAt = Date.now()

    checkStale(filledAt)
    expect(stale.value).toBe(false)

    checkStale(filledAt + POOL_STALE_MS - 1)
    expect(stale.value).toBe(false)

    checkStale(filledAt + POOL_STALE_MS + 1)
    expect(stale.value).toBe(true)
  })
})

describe('shouldAutoRefreshForYou', () => {
  // The one rule that keeps a refresh from yanking content out from under a
  // scrolled-down reader: it is allowed to trigger itself only when the
  // viewer is at the very top, where there is nothing above the fold to
  // disturb. Everywhere else, only an explicit click (the "Show new posts"
  // banner in `TimelineForYou.vue`) may call it.
  it('is true only when both stale and at the top', () => {
    expect(shouldAutoRefreshForYou(true, true)).toBe(true)
    expect(shouldAutoRefreshForYou(true, false)).toBe(false)
    expect(shouldAutoRefreshForYou(false, true)).toBe(false)
    expect(shouldAutoRefreshForYou(false, false)).toBe(false)
  })
})

// The bound on the unbounded automatic fan-out: `stale` alone recurs every
// `POOL_STALE_MS` forever, so the automatic path needs its own cooldown
// (`canAutoRefreshForYou`) and backoff (`autoRefreshIntervalMs`), distinct
// from the always-responsive explicit "Show new posts" click.
describe('autoRefreshIntervalMs', () => {
  it('starts at the floor and doubles from the second consecutive empty attempt onward', () => {
    // A single empty attempt is unremarkable — it waits the same floor as a
    // fresh gate. A *run* of them is what triggers the backoff.
    expect(autoRefreshIntervalMs(0)).toBe(AUTO_REFRESH_MIN_INTERVAL_MS)
    expect(autoRefreshIntervalMs(1)).toBe(AUTO_REFRESH_MIN_INTERVAL_MS)
    expect(autoRefreshIntervalMs(2)).toBe(AUTO_REFRESH_MIN_INTERVAL_MS * 2)
    expect(autoRefreshIntervalMs(3)).toBe(AUTO_REFRESH_MIN_INTERVAL_MS * 4)
  })

  it('saturates at the ceiling instead of growing unbounded', () => {
    expect(autoRefreshIntervalMs(20)).toBe(AUTO_REFRESH_MAX_INTERVAL_MS)
    expect(autoRefreshIntervalMs(20)).toBeLessThan(AUTO_REFRESH_MIN_INTERVAL_MS * 2 ** 20)
  })
})

describe('canAutoRefreshForYou', () => {
  it('allows the very first attempt immediately', () => {
    expect(canAutoRefreshForYou(initialAutoRefreshGate(), 0)).toBe(true)
  })

  it('blocks a second attempt before the interval has elapsed', () => {
    const gate = nextAutoRefreshGate(initialAutoRefreshGate(), false, 0)
    expect(canAutoRefreshForYou(gate, AUTO_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(canAutoRefreshForYou(gate, AUTO_REFRESH_MIN_INTERVAL_MS)).toBe(true)
  })

  it('backs off further after repeated empty attempts, and resets once one finds something', () => {
    let gate = initialAutoRefreshGate()
    let now = 0

    // Three consecutive empty attempts: the required gap grows each time.
    gate = nextAutoRefreshGate(gate, false, now)
    now += AUTO_REFRESH_MIN_INTERVAL_MS
    expect(canAutoRefreshForYou(gate, now)).toBe(true)

    gate = nextAutoRefreshGate(gate, false, now)
    // The floor interval alone is no longer enough — the backoff doubled.
    expect(canAutoRefreshForYou(gate, now + AUTO_REFRESH_MIN_INTERVAL_MS)).toBe(false)
    now += AUTO_REFRESH_MIN_INTERVAL_MS * 2
    expect(canAutoRefreshForYou(gate, now)).toBe(true)

    // A successful attempt resets the backoff back to the floor.
    gate = nextAutoRefreshGate(gate, true, now)
    expect(gate.consecutiveEmpty).toBe(0)
    expect(canAutoRefreshForYou(gate, now + AUTO_REFRESH_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(canAutoRefreshForYou(gate, now + AUTO_REFRESH_MIN_INTERVAL_MS)).toBe(true)
  })
})
