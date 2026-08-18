import type { mastodon } from 'masto'
import type { CandidateSource, ForYouSignals, PostCandidate } from '../../app/composables/for-you/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPreScoringFilters,
  candidateKey,
  consumeCandidates,
  createCandidate,
  dedupeCandidates,
  deriveFollowedAccountIds,
  ensureCandidatePool,
  fetchCandidates,
  fetchCandidatesDetailed,
  fillCandidatePool,
  filterBlockedAuthors,
  filterByAge,
  filterIneligibleVisibility,
  filterNotInterested,
  filterOonRetweetsAndReplies,
  filterOonSensitive,
  filterSeen,
  filterSelfPosts,
  filterUnhydrated,
  hydrateInNetwork,
  isRateLimited,
  isRateLimitError,
  isReplyContextAvailable,
  MAX_CANDIDATE_AGE_MS,
  maxAgeForCandidate,
  poolNeedsRefill,
  protectedSeenCount,
  rateLimitRetryIn,
  refillCandidatePool,
  resetCandidatePool,
  resetFollowCache,
  resetRateLimit,
  resolveFollowedAccountIds,
  retryAfterMs,
  TRENDING_MAX_AGE_MS,
  useForYouCandidatePool,
} from '../../app/composables/for-you/candidates'
import { EMPTY_SIGNALS } from '../../app/composables/for-you/types'

const NOW = Date.parse('2026-08-16T12:00:00.000Z')

function minutesAgo(minutes: number) {
  return new Date(NOW - minutes * 60_000).toISOString()
}

interface StatusOptions {
  accountId?: string
  createdAt?: string
  inReplyToId?: string
  inReplyToAccountId?: string
  reblog?: mastodon.v1.Status
  sensitive?: boolean
  visibility?: mastodon.v1.StatusVisibility
}

function status(id: string, options: StatusOptions = {}): mastodon.v1.Status {
  return {
    id,
    createdAt: options.createdAt ?? minutesAgo(10),
    account: { id: options.accountId ?? `author-${id}` } as mastodon.v1.Account,
    visibility: options.visibility ?? 'public',
    sensitive: options.sensitive ?? false,
    inReplyToId: options.inReplyToId ?? null,
    inReplyToAccountId: options.inReplyToAccountId ?? null,
    reblog: options.reblog ?? null,
    tags: [],
  } as unknown as mastodon.v1.Status
}

function reblogOf(id: string, original: mastodon.v1.Status, accountId = `booster-${id}`): mastodon.v1.Status {
  return status(id, { accountId, reblog: original })
}

function candidate(
  s: mastodon.v1.Status,
  source: CandidateSource = 'federated',
  inNetwork = false,
): PostCandidate {
  return createCandidate(s, source, inNetwork)
}

function signals(overrides: Partial<ForYouSignals> = {}): ForYouSignals {
  return { ...EMPTY_SIGNALS, seen: [], notInterested: [], mutedForYou: [], ...overrides }
}

function ids(candidates: PostCandidate[]) {
  return candidates.map(c => c.status.id)
}

/** Every ordering of `items`, for pinning order-independent behaviour. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1)
    return [items]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]))
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('candidateKey', () => {
  it('identifies a boost by the post it wraps', () => {
    const original = status('a')
    expect(candidateKey(original)).toBe('a')
    expect(candidateKey(reblogOf('rb', original))).toBe('a')
  })
})

describe('dedupeCandidates', () => {
  it('merges the same post from several sources into one candidate', () => {
    const post = status('a')
    const merged = dedupeCandidates([
      candidate(post, 'home', true),
      candidate(post, 'trending'),
      candidate(post, 'tag'),
    ])

    expect(merged).toHaveLength(1)
    expect([...merged[0]!.sources].sort()).toEqual(['home', 'tag', 'trending'])
  })

  it('keeps in-network once any source proved it', () => {
    const post = status('a')
    const merged = dedupeCandidates([
      candidate(post, 'federated', false),
      candidate(post, 'home', true),
    ])

    expect(merged[0]!.inNetwork).toBe(true)
  })

  it('does not mutate the input candidates', () => {
    const post = status('a')
    const first = candidate(post, 'home', true)
    const second = candidate(post, 'trending')
    dedupeCandidates([first, second])

    expect([...first.sources]).toEqual(['home'])
    expect([...second.sources]).toEqual(['trending'])
  })

  it('collapses several boosts of the same post (RetweetDeduplicationFilter)', () => {
    const original = status('a')
    const merged = dedupeCandidates([
      candidate(reblogOf('rb1', original), 'home', true),
      candidate(reblogOf('rb2', original), 'federated'),
      candidate(reblogOf('rb3', original), 'local'),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.status.id).toBe('rb1')
    expect([...merged[0]!.sources].sort()).toEqual(['federated', 'home', 'local'])
  })

  it('prefers an in-network boost over a bare original', () => {
    const original = status('a')

    for (const order of [
      [candidate(original, 'federated'), candidate(reblogOf('rb', original), 'home', true)],
      [candidate(reblogOf('rb', original), 'home', true), candidate(original, 'federated')],
    ]) {
      const merged = dedupeCandidates(order)
      expect(merged).toHaveLength(1)
      // Someone the viewer follows vouched for it — that is what Elk renders.
      expect(merged[0]!.status.id).toBe('rb')
      expect(merged[0]!.inNetwork).toBe(true)
    }
  })

  it('prefers a bare original over an out-of-network boost, whatever the order', () => {
    // The reason this matters: X runs RetweetDeduplication *after*
    // OONRetweetReplyFilter, so an OON boost is already gone by dedup time.
    // We dedup first, so letting the boost represent the group would let the
    // OON filter delete the original along with it.
    const original = status('a')
    const merged = dedupeCandidates([
      candidate(reblogOf('oon-rb', original), 'federated', false),
      candidate(original, 'local', false),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.status.id).toBe('a')

    const kept = filterOonRetweetsAndReplies(merged, { followedAccountIds: new Set() })
    expect(ids(kept)).toEqual(['a'])
  })

  it('picks the same representative under every source-resolution order', () => {
    // The fan-out is `Promise.allSettled` over branches that finish whenever the
    // network says so. Nothing guarantees home lands first, so the representative
    // rule must not depend on arrival order at all. Brute-force every permutation.
    const original = status('a')
    const copies = [
      candidate(original, 'local', false),
      candidate(reblogOf('oon-rb', original), 'federated', false),
      candidate(reblogOf('in-rb', original, 'followed'), 'home', true),
      candidate(original, 'trending', false),
    ]

    for (const order of permutations(copies)) {
      const merged = dedupeCandidates(order)
      expect(merged).toHaveLength(1)
      // The in-network boost always wins, whenever it happened to arrive.
      expect(merged[0]!.status.id).toBe('in-rb')
      expect(merged[0]!.inNetwork).toBe(true)
      expect([...merged[0]!.sources].sort()).toEqual(['federated', 'home', 'local', 'trending'])
    }
  })

  it('never loses the in-network flag, whichever copy carries it', () => {
    // A refill merges candidates built against an older follow set, so the same
    // post can arrive both as out-of-network and as in-network.
    const original = status('a')
    const copies = [
      candidate(reblogOf('rb', original), 'federated', false),
      candidate(reblogOf('rb', original), 'local', true),
      candidate(original, 'trending', false),
    ]

    for (const order of permutations(copies)) {
      const merged = dedupeCandidates(order)
      expect(merged[0]!.inNetwork).toBe(true)
    }
  })

  it('never lets an out-of-network boost drag the original out of the feed', () => {
    // The regression this rule exists for: X drops OON retweets *before*
    // deduplicating, so the original survives on its own. We dedup first, so if
    // an OON boost were allowed to represent the group the OON filter would
    // delete the original with it — in any arrival order.
    const original = status('a')
    const copies = [
      candidate(reblogOf('oon-rb', original), 'federated', false),
      candidate(original, 'local', false),
    ]

    for (const order of permutations(copies)) {
      const kept = filterOonRetweetsAndReplies(dedupeCandidates(order), { followedAccountIds: new Set() })
      expect(ids(kept)).toEqual(['a'])
    }
  })

  it('leaves distinct posts alone and preserves order', () => {
    const merged = dedupeCandidates([
      candidate(status('a'), 'home', true),
      candidate(status('b'), 'federated'),
      candidate(status('c'), 'trending'),
    ])

    expect(ids(merged)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Individual filters
// ---------------------------------------------------------------------------

describe('filterUnhydrated (CoreDataHydrationFilter)', () => {
  it('drops candidates missing an author or a timestamp', () => {
    const broken = { ...status('b'), account: undefined } as unknown as mastodon.v1.Status
    const undated = { ...status('c'), createdAt: '' } as unknown as mastodon.v1.Status

    const kept = filterUnhydrated([
      candidate(status('a')),
      candidate(broken),
      candidate(undated),
    ])

    expect(ids(kept)).toEqual(['a'])
  })
})

describe('filterByAge (AgeFilter)', () => {
  it('drops posts older than 48 hours', () => {
    const kept = filterByAge([
      candidate(status('fresh', { createdAt: minutesAgo(5) })),
      candidate(status('edge', { createdAt: new Date(NOW - MAX_CANDIDATE_AGE_MS).toISOString() })),
      candidate(status('stale', { createdAt: minutesAgo(60 * 49) })),
    ], NOW)

    expect(ids(kept)).toEqual(['fresh', 'edge'])
  })

  it('gives trending candidates a week, since that is how trends accumulate', () => {
    const threeDaysOld = minutesAgo(60 * 24 * 3)

    expect(ids(filterByAge([candidate(status('t', { createdAt: threeDaysOld }), 'trending')], NOW)))
      .toEqual(['t'])
    expect(ids(filterByAge([candidate(status('f', { createdAt: threeDaysOld }), 'federated')], NOW)))
      .toEqual([])
  })

  it('takes the most permissive horizon across a merged candidate sources', () => {
    const merged = dedupeCandidates([
      candidate(status('a'), 'federated'),
      candidate(status('a'), 'trending'),
    ])

    expect(maxAgeForCandidate(merged[0]!)).toBe(TRENDING_MAX_AGE_MS)
  })

  it('honours an explicit override', () => {
    const kept = filterByAge([candidate(status('t', { createdAt: minutesAgo(60 * 24 * 3) }), 'trending')], NOW, MAX_CANDIDATE_AGE_MS)
    expect(kept).toEqual([])
  })

  it('measures the boost, not the post it wraps', () => {
    const old = status('a', { createdAt: minutesAgo(60 * 24 * 30) })
    const kept = filterByAge([candidate(reblogOf('rb', old))], NOW)

    expect(ids(kept)).toEqual(['rb'])
  })

  it('drops candidates with an unparseable timestamp', () => {
    const kept = filterByAge([candidate(status('a', { createdAt: 'not a date' }))], NOW)
    expect(kept).toEqual([])
  })
})

describe('filterSelfPosts (SelfTweetFilter)', () => {
  it('drops the viewer own posts and boosts, but not boosts of them', () => {
    const mine = status('mine', { accountId: 'me' })
    const theirs = status('theirs', { accountId: 'them' })

    const kept = filterSelfPosts([
      candidate(mine),
      candidate(reblogOf('my-boost', theirs, 'me')),
      candidate(reblogOf('their-boost', mine, 'them')),
      candidate(theirs),
    ], 'me')

    expect(ids(kept)).toEqual(['their-boost', 'theirs'])
  })

  it('is a no-op for a logged-out viewer', () => {
    const kept = filterSelfPosts([candidate(status('a'))], undefined)
    expect(ids(kept)).toEqual(['a'])
  })
})

describe('filterOonRetweetsAndReplies (OONRetweetReplyFilter)', () => {
  const followedAccountIds = new Set(['followed'])

  it('drops out-of-network boosts and replies', () => {
    const kept = filterOonRetweetsAndReplies([
      candidate(reblogOf('oon-boost', status('x')), 'federated', false),
      candidate(status('oon-reply', { inReplyToId: 'x', inReplyToAccountId: 'stranger' }), 'federated', false),
      candidate(status('oon-post'), 'federated', false),
    ], { followedAccountIds })

    expect(ids(kept)).toEqual(['oon-post'])
  })

  it('keeps in-network boosts', () => {
    const kept = filterOonRetweetsAndReplies([
      candidate(reblogOf('boost', status('x'), 'followed'), 'home', true),
    ], { followedAccountIds })

    expect(ids(kept)).toEqual(['boost'])
  })

  it('keeps out-of-network boosts once relaxed', () => {
    const kept = filterOonRetweetsAndReplies([
      candidate(reblogOf('oon-boost', status('x')), 'federated', false),
    ], { followedAccountIds, keepOonReblogs: true })

    expect(ids(kept)).toEqual(['oon-boost'])
  })

  it('drops replies whose parent we cannot place, even in-network', () => {
    const kept = filterOonRetweetsAndReplies([
      candidate(status('orphan', { accountId: 'followed', inReplyToId: 'gone', inReplyToAccountId: 'stranger' }), 'home', true),
    ], { followedAccountIds })

    expect(kept).toEqual([])
  })

  it('keeps a reply whose parent is in the same batch', () => {
    const parent = status('parent', { accountId: 'stranger' })
    const kept = filterOonRetweetsAndReplies([
      candidate(parent, 'home', true),
      candidate(status('child', { accountId: 'followed', inReplyToId: 'parent', inReplyToAccountId: 'stranger' }), 'home', true),
    ], { followedAccountIds })

    expect(ids(kept)).toEqual(['parent', 'child'])
  })

  it('keeps self-replies and replies to the viewer or to a followed account', () => {
    const kept = filterOonRetweetsAndReplies([
      candidate(status('self', { accountId: 'followed', inReplyToId: 'x', inReplyToAccountId: 'followed' }), 'home', true),
      candidate(status('to-me', { accountId: 'followed', inReplyToId: 'y', inReplyToAccountId: 'me' }), 'home', true),
      candidate(status('to-followed', { accountId: 'followed', inReplyToId: 'z', inReplyToAccountId: 'followed' }), 'home', true),
    ], { followedAccountIds, viewerAccountId: 'me' })

    expect(ids(kept)).toEqual(['self', 'to-me', 'to-followed'])
  })

  it('treats a boost of a reply as a boost, not as a reply', () => {
    const reply = status('reply', { inReplyToId: 'gone', inReplyToAccountId: 'stranger' })
    const kept = filterOonRetweetsAndReplies([
      candidate(reblogOf('boost', reply, 'followed'), 'home', true),
    ], { followedAccountIds })

    expect(ids(kept)).toEqual(['boost'])
  })

  it('still drops out-of-network replies when relaxOonReplyContext is off (the default)', () => {
    const parent = status('parent', { accountId: 'stranger' })
    const kept = filterOonRetweetsAndReplies([
      candidate(parent, 'federated', false),
      candidate(status('child', { accountId: 'other-stranger', inReplyToId: 'parent', inReplyToAccountId: 'stranger' }), 'federated', false),
    ], { followedAccountIds })

    expect(ids(kept)).toEqual(['parent'])
  })

  it('keeps an out-of-network reply once relaxed, when its parent is reachable', () => {
    const parent = status('parent', { accountId: 'stranger' })
    const kept = filterOonRetweetsAndReplies([
      candidate(parent, 'federated', false),
      // Reply-between-strangers: neither the author nor the parent's author
      // is followed. Its parent is right there in the same batch though —
      // exactly the "replies between strangers" case a federated/local/tag
      // fan-out is mostly made of.
      candidate(status('child', { accountId: 'other-stranger', inReplyToId: 'parent', inReplyToAccountId: 'stranger' }), 'federated', false),
    ], { followedAccountIds, relaxOonReplyContext: true })

    expect(ids(kept)).toEqual(['parent', 'child'])
  })

  it('still drops an out-of-network reply once relaxed if its parent is genuinely unreachable', () => {
    // Relaxing who gets judged by isReplyContextAvailable must not relax the
    // verdict itself: an orphaned reply is unreadable at every level.
    const kept = filterOonRetweetsAndReplies([
      candidate(status('orphan', { accountId: 'stranger', inReplyToId: 'gone', inReplyToAccountId: 'another-stranger' }), 'federated', false),
    ], { followedAccountIds, relaxOonReplyContext: true })

    expect(kept).toEqual([])
  })
})

describe('isReplyContextAvailable', () => {
  it('always accepts a non-reply', () => {
    expect(isReplyContextAvailable(status('a'), new Set())).toBe(true)
  })

  it('rejects a reply with no known parent author', () => {
    const orphan = status('a', { inReplyToId: 'gone' })
    expect(isReplyContextAvailable(orphan, new Set())).toBe(false)
  })
})

describe('filterOonSensitive (OONNsfwSimclustersFilter)', () => {
  it('only touches the simclusters analog, never the general firehoses', () => {
    const kept = filterOonSensitive([
      candidate(status('trending-nsfw', { sensitive: true }), 'trending', false),
      candidate(status('federated-cw', { sensitive: true }), 'federated', false),
      candidate(status('local-cw', { sensitive: true }), 'local', false),
      candidate(status('tag-cw', { sensitive: true }), 'tag', false),
      candidate(status('in-network-cw', { sensitive: true }), 'home', true),
    ])

    // `sensitive` on Mastodon is a content warning, not an adult-content label.
    expect(ids(kept)).toEqual(['federated-cw', 'local-cw', 'tag-cw', 'in-network-cw'])
  })

  it('spares a trending post that another source also produced', () => {
    const post = status('a', { sensitive: true })
    const merged = dedupeCandidates([
      candidate(post, 'trending'),
      candidate(post, 'tag'),
    ])

    expect(ids(filterOonSensitive(merged))).toEqual(['a'])
  })

  it('looks through a boost at the post it wraps', () => {
    const kept = filterOonSensitive([
      candidate(reblogOf('rb', status('a', { sensitive: true })), 'trending', false),
    ])

    expect(kept).toEqual([])
  })
})

describe('filterIneligibleVisibility (IneligibleSubscriptionFilter)', () => {
  it('keeps public and unlisted, drops direct, and allows followers-only in network', () => {
    const kept = filterIneligibleVisibility([
      candidate(status('pub', { visibility: 'public' })),
      candidate(status('unl', { visibility: 'unlisted' })),
      candidate(status('dm', { visibility: 'direct' })),
      candidate(status('oon-priv', { visibility: 'private' }), 'federated', false),
      candidate(status('in-priv', { visibility: 'private' }), 'home', true),
    ])

    expect(ids(kept)).toEqual(['pub', 'unl', 'in-priv'])
  })
})

describe('filterSeen (PreviouslySeenPostsFilter)', () => {
  it('drops posts already shown, matching on the boost or on the post it wraps', () => {
    const seen = new Set(['a', 'rb-seen'])
    const kept = filterSeen([
      candidate(status('a')),
      candidate(status('b')),
      candidate(reblogOf('rb-seen', status('c'))),
      candidate(reblogOf('rb-fresh', status('a'))),
    ], id => seen.has(id))

    expect(ids(kept)).toEqual(['b'])
  })
})

describe('filterBlockedAuthors (AuthorSocialgraphFilter)', () => {
  it('drops posts by, and boosts of, a blocked or muted account', () => {
    const kept = filterBlockedAuthors([
      candidate(status('a', { accountId: 'bad' })),
      candidate(status('b', { accountId: 'good' })),
      candidate(reblogOf('rb', status('c', { accountId: 'bad' }), 'good')),
      candidate(reblogOf('rb2', status('d', { accountId: 'good' }), 'bad')),
    ], ['bad'])

    expect(ids(kept)).toEqual(['b'])
  })

  it('is a no-op with an empty list', () => {
    const input = [candidate(status('a'))]
    expect(filterBlockedAuthors(input, [])).toBe(input)
  })
})

describe('filterNotInterested', () => {
  it('drops dismissed posts, by boost id or by underlying id', () => {
    const kept = filterNotInterested([
      candidate(status('a')),
      candidate(status('b')),
      candidate(reblogOf('rb', status('a'))),
    ], ['a'])

    expect(ids(kept)).toEqual(['b'])
  })
})

describe('hydrateInNetwork / deriveFollowedAccountIds', () => {
  it('marks candidates authored by a followed account without mutating them', () => {
    const input = [
      candidate(status('a', { accountId: 'followed' }), 'federated', false),
      candidate(status('b', { accountId: 'stranger' }), 'federated', false),
    ]
    const hydrated = hydrateInNetwork(input, new Set(['followed']))

    expect(hydrated.map(c => c.inNetwork)).toEqual([true, false])
    expect(input.map(c => c.inNetwork)).toEqual([false, false])
    // Unchanged candidates are passed through by reference.
    expect(hydrated[1]).toBe(input[1])
  })

  it('infers the follow set from the in-network candidates', () => {
    const followed = deriveFollowedAccountIds([
      candidate(status('a', { accountId: 'followed' }), 'home', true),
      candidate(reblogOf('rb', status('x'), 'booster'), 'home', true),
      candidate(status('b', { accountId: 'stranger' }), 'federated', false),
    ])

    expect([...followed].sort()).toEqual(['booster', 'followed'])
  })
})

// ---------------------------------------------------------------------------
// The real follow set
// ---------------------------------------------------------------------------

describe('resolveFollowedAccountIds', () => {
  beforeEach(() => resetFollowCache())

  function relationshipClient(following: Record<string, boolean>, batches: string[][] = []) {
    return {
      v1: {
        accounts: {
          relationships: {
            fetch: async ({ id }: { id: string[] }) => {
              batches.push(id)
              return id.map(accountId => ({ id: accountId, following: !!following[accountId] }))
            },
          },
        },
      },
    } as unknown as mastodon.rest.Client
  }

  it('resolves exact follow state from the batch endpoint', async () => {
    const client = relationshipClient({ a: true, b: false, c: true })
    const followed = await resolveFollowedAccountIds(client, ['a', 'b', 'c'], { now: NOW })

    expect([...followed].sort()).toEqual(['a', 'c'])
  })

  it('batches the lookups rather than asking one account at a time', async () => {
    const batches: string[][] = []
    const many = Array.from({ length: 95 }, (_, i) => `a${i}`)
    const client = relationshipClient({}, batches)
    await resolveFollowedAccountIds(client, many, { now: NOW })

    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(40)
    expect(batches[2]).toHaveLength(15)
  })

  it('memoizes, so a refill does not re-ask for the same accounts', async () => {
    const batches: string[][] = []
    const client = relationshipClient({ a: true }, batches)

    await resolveFollowedAccountIds(client, ['a', 'b'], { now: NOW })
    const second = await resolveFollowedAccountIds(client, ['a', 'b'], { now: NOW + 1000 })

    expect(batches).toHaveLength(1)
    expect([...second]).toEqual(['a'])
  })

  it('degrades to an empty set when the endpoint is missing', async () => {
    const client = { v1: {} } as unknown as mastodon.rest.Client
    await expect(resolveFollowedAccountIds(client, ['a'], { now: NOW })).resolves.toEqual(new Set())
  })

  it('reports errors without rejecting', async () => {
    const errors: unknown[] = []
    const client = {
      v1: { accounts: { relationships: { fetch: async () => { throw new Error('boom') } } } },
    } as unknown as mastodon.rest.Client

    await resolveFollowedAccountIds(client, ['a'], { now: NOW, onError: e => errors.push(e) })
    expect(errors).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe('applyPreScoringFilters', () => {
  // Every test in this block asserts the behaviour of the STRICT chain. If a
  // change ever pushed these batches under the floor, the chain would quietly
  // escalate to a relaxed pass and these assertions would start describing a
  // different code path — an escalation masking a filter regression. `floor: 0`
  // pins level 0, and `onRelax` throwing makes that pin impossible to lose
  // silently: relaxation here is a test failure, not a shrug.
  const context = {
    now: NOW,
    viewerAccountId: 'me',
    followedAccountIds: new Set(['followed']),
    useMastodonFilters: false,
    floor: 0,
    onRelax: (level: number) => {
      throw new Error(`strict-chain test unexpectedly relaxed to level ${level}`)
    },
  }

  it('exercises the strict chain, never a relaxed one', () => {
    // Guard on the guard: prove the throwing onRelax actually fires when the
    // chain does relax, so the other tests in this block mean what they say.
    expect(() => applyPreScoringFilters(
      [candidate(status('seen-post'), 'local')],
      signals({ seen: ['seen-post'] }),
      { ...context, floor: 1 },
    )).toThrow(/unexpectedly relaxed to level 1/)
  })

  it('runs the whole chain', () => {
    const original = status('shared', { accountId: 'stranger' })

    const kept = applyPreScoringFilters([
      // Survives, and keeps every source that produced it.
      candidate(original, 'trending'),
      candidate(original, 'tag'),
      // The viewer's own post.
      candidate(status('mine', { accountId: 'me' }), 'home', true),
      // Too old.
      candidate(status('stale', { createdAt: minutesAgo(60 * 72) }), 'federated'),
      // Out-of-network boost.
      candidate(reblogOf('oon-rb', status('x'), 'stranger'), 'federated'),
      // Out-of-network reply.
      candidate(status('oon-reply', { inReplyToId: 'q', inReplyToAccountId: 'stranger' }), 'local'),
      // Already seen.
      candidate(status('seen-post'), 'federated'),
      // Feed-muted author.
      candidate(status('muted', { accountId: 'noisy' }), 'local'),
      // Explicitly dismissed.
      candidate(status('dismissed'), 'trending'),
      // Direct message that somehow made it into a timeline.
      candidate(status('dm', { visibility: 'direct' }), 'home', true),
      // In-network post: survives.
      candidate(status('friend', { accountId: 'followed' }), 'home', true),
    ], signals({
      seen: ['seen-post'],
      notInterested: ['dismissed'],
      mutedForYou: ['noisy'],
    }), context)

    expect(ids(kept)).toEqual(['shared', 'friend'])
    expect([...kept[0]!.sources].sort()).toEqual(['tag', 'trending'])
  })

  it('uses the exact follow set it is given rather than guessing from the batch', () => {
    const kept = applyPreScoringFilters([
      // An account the viewer follows, surfaced by the federated firehose. A
      // sampled follow set would never have caught this and would have dropped
      // the boost and the followers-only post below.
      candidate(reblogOf('rb', status('x'), 'followed'), 'federated', false),
      candidate(status('priv', { accountId: 'followed', visibility: 'private' }), 'federated', false),
    ], signals(), context)

    expect(ids(kept)).toEqual(['rb', 'priv'])
    expect(kept.every(c => c.inNetwork)).toBe(true)
  })

  it('falls back to the home sample when no follow set is available', () => {
    const kept = applyPreScoringFilters([
      candidate(status('home-post', { accountId: 'followed' }), 'home', true),
      candidate(reblogOf('rb', status('x'), 'followed'), 'federated', false),
    ], signals(), { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 })

    expect(ids(kept)).toEqual(['home-post', 'rb'])
  })

  it('keeps out-of-network sensitive posts by default', () => {
    const kept = applyPreScoringFilters([
      candidate(status('cw', { sensitive: true }), 'trending'),
    ], signals(), context)

    expect(ids(kept)).toEqual(['cw'])
  })

  it('can be told to apply the simclusters adult-content filter', () => {
    const kept = applyPreScoringFilters([
      candidate(status('cw', { sensitive: true }), 'trending'),
    ], signals(), { ...context, dropOonSensitive: true })

    expect(kept).toEqual([])
  })

  it('survives an empty batch and empty signals', () => {
    expect(applyPreScoringFilters([], signals(), context)).toEqual([])
  })

  it('honours an explicit blocked list on top of the feed-local mutes', () => {
    const kept = applyPreScoringFilters([
      candidate(status('a', { accountId: 'blocked' }), 'federated'),
      candidate(status('b', { accountId: 'ok' }), 'federated'),
    ], signals(), { ...context, blockedAccountIds: ['blocked'] })

    expect(ids(kept)).toEqual(['b'])
  })

  it('drops posts Mastodon flagged for the viewer keyword filters (MutedKeywordFilter)', () => {
    const hidden = status('hidden')
    hidden.filtered = [{
      filter: { filterAction: 'hide', context: ['home'] },
    } as mastodon.v1.FilterResult]

    const kept = applyPreScoringFilters([
      candidate(hidden, 'federated'),
      candidate(status('visible'), 'federated'),
    ], signals(), { ...context, useMastodonFilters: true })

    expect(ids(kept)).toEqual(['visible'])
  })
})

describe('applyPreScoringFilters result-size floor (ResultSizeFilter)', () => {
  const base = {
    now: NOW,
    viewerAccountId: 'me',
    followedAccountIds: new Set(['followed']),
    useMastodonFilters: false,
  }

  it('replays only enough seen posts to reach the floor, oldest impression first', () => {
    // `seen` is a 3000-entry FIFO with no TTL; on a small instance it eventually
    // swallows the entire reachable 48h pool. Relaxing must not mean replaying
    // the viewer's whole history.
    const posts = Array.from({ length: 8 }, (_, i) => status(`p${i}`))
    const relaxed: number[] = []

    const kept = applyPreScoringFilters(
      posts.map(post => candidate(post, 'local')),
      // Impression log is oldest-first, so p7 is what they just scrolled past.
      signals({ seen: posts.map(p => p.id) }),
      { ...base, floor: 3, onRelax: level => relaxed.push(level) },
    )

    expect(ids(kept)).toEqual(['p0', 'p1', 'p2'])
    expect(relaxed).toEqual([1])
  })

  it('never replays the impressions the viewer just scrolled past', () => {
    const posts = Array.from({ length: 8 }, (_, i) => status(`p${i}`))

    const kept = applyPreScoringFilters(
      posts.map(post => candidate(post, 'local')),
      signals({ seen: posts.map(p => p.id) }),
      // A floor big enough to want every last one of them.
      { ...base, floor: 100 },
    )

    // 25% of an 8-entry log is protected: p6 and p7 can never come back.
    expect(ids(kept)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('protects a share of the log, so a short history cannot starve the feed', () => {
    expect(protectedSeenCount(8)).toBe(2)
    expect(protectedSeenCount(5)).toBe(1)
    // A brand-new viewer has nothing to protect and nothing to loop.
    expect(protectedSeenCount(1)).toBe(0)
    // A flat 100 would have swallowed every one of these logs whole.
    expect(protectedSeenCount(3000)).toBe(100)
  })

  it('opens the age horizon when the seen relaxation is not enough', () => {
    const relaxed: number[] = []
    const kept = applyPreScoringFilters([
      candidate(status('old', { createdAt: minutesAgo(60 * 24 * 4) }), 'local'),
    ], signals(), { ...base, floor: 1, onRelax: level => relaxed.push(level) })

    expect(ids(kept)).toEqual(['old'])
    expect(relaxed).toEqual([2])
  })

  it('keeps out-of-network boosts as the last resort', () => {
    const relaxed: number[] = []
    const kept = applyPreScoringFilters([
      candidate(reblogOf('oon-rb', status('x')), 'federated'),
    ], signals(), { ...base, floor: 1, onRelax: level => relaxed.push(level) })

    expect(ids(kept)).toEqual(['oon-rb'])
    expect(relaxed).toEqual([3])
  })

  it('keeps out-of-network replies with a reachable parent at level 4, once level 3 is not enough', () => {
    const relaxed: number[] = []
    const parent = status('parent', { accountId: 'stranger' })
    const kept = applyPreScoringFilters([
      candidate(parent, 'federated'),
      // Neither author is followed, and there is no boost here for level 3 to
      // rescue — only level 4's relaxed reply-context check can reach these.
      candidate(status('child', { accountId: 'other-stranger', inReplyToId: 'parent', inReplyToAccountId: 'stranger' }), 'federated'),
    ], signals(), { ...base, floor: 2, onRelax: level => relaxed.push(level) })

    expect(ids(kept)).toEqual(['parent', 'child'])
    expect(relaxed).toEqual([4])
  })

  it('never resurrects a reply whose parent is genuinely unreachable, even at level 4', () => {
    const kept = applyPreScoringFilters([
      candidate(status('orphan', { accountId: 'stranger', inReplyToId: 'gone', inReplyToAccountId: 'another-stranger' }), 'federated'),
    ], signals(), { ...base, floor: 50 })

    expect(kept).toEqual([])
  })

  it('never relaxes blocks, dismissals or the viewer own posts', () => {
    const kept = applyPreScoringFilters([
      candidate(status('mine', { accountId: 'me' }), 'home', true),
      candidate(status('blocked', { accountId: 'noisy' }), 'local'),
      candidate(status('dismissed'), 'local'),
      candidate(status('dm', { visibility: 'direct' }), 'local'),
    ], signals({ notInterested: ['dismissed'], mutedForYou: ['noisy'] }), { ...base, floor: 50 })

    expect(kept).toEqual([])
  })

  it('does not relax when the floor is already met', () => {
    const relaxed: number[] = []
    applyPreScoringFilters(
      [candidate(status('a'), 'local'), candidate(status('b'), 'local')],
      signals(),
      { ...base, floor: 2, onRelax: level => relaxed.push(level) },
    )

    expect(relaxed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

function pagesOf(pages: (mastodon.v1.Status[] | Error)[]) {
  return {
    values: () => {
      let index = 0
      return {
        next: async () => {
          if (index >= pages.length)
            return { value: undefined, done: true }
          const page = pages[index++]
          if (page instanceof Error)
            throw page
          return { value: page, done: false }
        },
      }
    },
  }
}

function paginatorOf(statuses: mastodon.v1.Status[] | Error) {
  return pagesOf([statuses])
}

const hangingPaginator = {
  values: () => ({ next: () => new Promise<never>(() => {}) }),
}

interface FakeClientPages {
  home?: mastodon.v1.Status[] | Error | ReturnType<typeof pagesOf>
  federated?: mastodon.v1.Status[] | Error
  local?: mastodon.v1.Status[] | Error
  trending?: mastodon.v1.Status[] | Error
  tags?: Record<string, mastodon.v1.Status[] | Error>
  followedTags?: { name: string }[] | Error | 'hang'
  trendTags?: { name: string }[] | Error
  lists?: { id: string, title: string }[] | Error
  listTimelines?: Record<string, mastodon.v1.Status[]>
  suggestions?: { account: { id: string }, sources: string[] }[] | Error
  accountStatuses?: Record<string, mastodon.v1.Status[]>
  relationships?: Record<string, boolean>
  onCall?: (name: string) => void
}

function asPaginator(value: mastodon.v1.Status[] | Error | ReturnType<typeof pagesOf> | undefined) {
  if (value && !Array.isArray(value) && !(value instanceof Error))
    return value
  return paginatorOf((value as mastodon.v1.Status[] | Error) ?? [])
}

function fakeClient(pages: FakeClientPages) {
  const call = (name: string) => pages.onCall?.(name)
  return {
    v1: {
      timelines: {
        home: {
          list: () => {
            call('home')
            return asPaginator(pages.home)
          },
        },
        public: {
          list: (params?: { local?: boolean }) => {
            call(params?.local ? 'local' : 'federated')
            return paginatorOf((params?.local ? pages.local : pages.federated) ?? [])
          },
        },
        tag: {
          $select: (tag: string) => ({
            list: () => {
              call(`tag:${tag}`)
              return paginatorOf(pages.tags?.[tag] ?? [])
            },
          }),
        },
        list: {
          $select: (id: string) => ({ list: () => paginatorOf(pages.listTimelines?.[id] ?? []) }),
        },
      },
      trends: {
        statuses: {
          list: () => {
            call('trending')
            return paginatorOf(pages.trending ?? [])
          },
        },
        tags: { list: () => paginatorOf((pages.trendTags ?? []) as never) },
      },
      followedTags: {
        list: () => {
          call('followedTags')
          if (pages.followedTags === 'hang')
            return hangingPaginator
          return paginatorOf((pages.followedTags ?? []) as never)
        },
      },
      lists: { list: () => paginatorOf((pages.lists ?? []) as never) },
      accounts: {
        $select: (id: string) => ({
          statuses: { list: () => paginatorOf(pages.accountStatuses?.[id] ?? []) },
          following: { list: () => paginatorOf([] as never) },
        }),
        relationships: {
          fetch: async ({ id }: { id: string[] }) =>
            id.map(accountId => ({ id: accountId, following: !!pages.relationships?.[accountId] })),
        },
      },
    },
    v2: {
      suggestions: { list: () => paginatorOf((pages.suggestions ?? []) as never) },
    },
  } as unknown as mastodon.rest.Client
}

describe('fetchCandidates', () => {
  beforeEach(() => {
    resetFollowCache()
    resetCandidatePool()
    resetRateLimit()
  })

  it('fans out to every timeline and labels each candidate with its source', async () => {
    const client = fakeClient({
      home: [status('h', { accountId: 'followed' })],
      federated: [status('f')],
      local: [status('l')],
      trending: [status('t')],
      followedTags: [{ name: 'vue' }],
      tags: { vue: [status('tag-post')] },
      lists: [{ id: '7', title: 'friends' }],
      listTimelines: { 7: [status('list-post')] },
      suggestions: [{ account: { id: 'sug' }, sources: ['friends_of_friends'] }],
      accountStatuses: { sug: [status('two-hop')] },
    })

    const candidates = await fetchCandidates({ client, now: NOW })
    const bySource = Object.fromEntries(candidates.map(c => [c.status.id, [...c.sources]]))

    expect(bySource).toEqual({
      'h': ['home'],
      'f': ['federated'],
      'l': ['local'],
      't': ['trending'],
      'tag-post': ['tag'],
      'list-post': ['list'],
      'two-hop': ['network2hop'],
    })
  })

  it('treats list timelines as in-network and 2-hop as out-of-network', async () => {
    const client = fakeClient({
      lists: [{ id: '7', title: 'friends' }],
      // A Mastodon list can only contain accounts the viewer already follows.
      listTimelines: { 7: [reblogOf('list-boost', status('x'), 'friend')] },
      suggestions: [{ account: { id: 'sug' }, sources: ['friends_of_friends'] }],
      accountStatuses: { sug: [status('two-hop')] },
    })

    const candidates = await fetchCandidates({
      client,
      now: NOW,
      sources: ['list', 'network2hop'],
      resolveFollowSet: false,
    })

    const byId = Object.fromEntries(candidates.map(c => [c.status.id, c.inNetwork]))
    expect(byId).toEqual({ 'list-boost': true, 'two-hop': false })
  })

  it('seeds tags from followed, engaged and *trending* tags', async () => {
    const asked: string[] = []
    const client = fakeClient({
      followedTags: [{ name: 'vue' }],
      trendTags: [{ name: 'photography' }],
      onCall: (name) => {
        if (name.startsWith('tag:'))
          asked.push(name.slice(4))
      },
    })

    await fetchCandidates({ client, now: NOW, sources: ['tag'], maxTags: 4 })

    // Without the trending seed the feed can only ever return the viewer's
    // existing interests to them.
    expect(asked).toContain('vue')
    expect(asked).toContain('photography')
  })

  it('walks each source several pages deep and returns a resume cursor', async () => {
    const client = fakeClient({
      home: pagesOf([
        [status('h1'), status('h2')],
        [status('h3'), status('h4')],
        [status('h5')],
      ]),
    })

    const result = await fetchCandidatesDetailed({ client, now: NOW, sources: ['home'], disable: ['list'] })

    expect(ids(result.candidates)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(result.counts.home).toBe(5)
    expect(result.cursors.home).toBe('h5')
  })

  it('stops paginating as soon as a page crosses the age horizon', async () => {
    const client = fakeClient({
      home: pagesOf([
        [status('fresh')],
        [status('stale', { createdAt: minutesAgo(60 * 60) })],
        [status('never-read')],
      ]),
    })

    const result = await fetchCandidatesDetailed({ client, now: NOW, sources: ['home'], disable: ['list'] })

    expect(ids(result.candidates)).toEqual(['fresh'])
  })

  it('resumes from the cursors it is handed', async () => {
    let seenMaxId: string | undefined
    const client = {
      v1: {
        timelines: {
          home: {
            list: (params: { maxId?: string }) => {
              seenMaxId = params.maxId
              return paginatorOf([status('older')])
            },
          },
        },
      },
    } as unknown as mastodon.rest.Client

    await fetchCandidates({ client, now: NOW, sources: ['home'], disable: ['list'], cursors: { home: 'h5' } })
    expect(seenMaxId).toBe('h5')
  })

  it('resolves in-network exactly, via the relationships batch endpoint', async () => {
    const client = fakeClient({
      federated: [status('f', { accountId: 'followed' }), status('g', { accountId: 'stranger' })],
      relationships: { followed: true },
    })

    const result = await fetchCandidatesDetailed({ client, now: NOW, sources: ['federated'] })

    expect(result.candidates.find(c => c.status.id === 'f')!.inNetwork).toBe(true)
    expect(result.candidates.find(c => c.status.id === 'g')!.inNetwork).toBe(false)
    expect([...result.followedAccountIds]).toEqual(['followed'])
  })

  it('marks home candidates in-network without asking anyone', async () => {
    const client = fakeClient({ home: [status('h')], federated: [status('f')] })
    const candidates = await fetchCandidates({ client, now: NOW, resolveFollowSet: false })

    expect(candidates.find(c => c.status.id === 'h')!.inNetwork).toBe(true)
    expect(candidates.find(c => c.status.id === 'f')!.inNetwork).toBe(false)
  })

  it('does not let seed-tag resolution gate the other sources', async () => {
    const client = fakeClient({
      home: [status('h')],
      federated: [status('f')],
      // A followed-tags call that never returns must not hang the feed.
      followedTags: 'hang',
    })

    const started = Date.now()
    const candidates = await fetchCandidates({
      client,
      now: NOW,
      timeoutMs: 30,
      sources: ['home', 'federated', 'tag'],
      disable: ['list', 'twohop'],
    })

    expect(ids(candidates).sort()).toEqual(['f', 'h'])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('time-boxes a hanging source and keeps the rest', async () => {
    const errors: string[] = []
    const client = fakeClient({ federated: [status('f')] })
    const spied = {
      ...client,
      v1: {
        ...client.v1,
        timelines: { ...client.v1.timelines, home: { list: () => hangingPaginator } },
      },
    } as unknown as mastodon.rest.Client

    const candidates = await fetchCandidates({
      client: spied,
      now: NOW,
      timeoutMs: 30,
      sources: ['home', 'federated'],
      disable: ['list'],
      onSourceError: key => errors.push(key),
    })

    expect(ids(candidates)).toEqual(['f'])
    expect(errors).toEqual(['home'])
  })

  it('keeps every other source when one is dead', async () => {
    const errors: string[] = []
    const client = fakeClient({
      home: [status('h')],
      federated: new Error('404 disabled'),
      local: [status('l')],
      trending: new Error('trends are off'),
      followedTags: new Error('unsupported'),
    })

    const candidates = await fetchCandidates({
      client,
      now: NOW,
      disable: ['list', 'twohop'],
      onSourceError: key => errors.push(key),
    })

    expect(ids(candidates).sort()).toEqual(['h', 'l'])
    expect(errors.sort()).toEqual(['federated', 'trending'])
  })

  it('returns an empty batch, not a rejection, when everything fails', async () => {
    const client = fakeClient({
      home: new Error('boom'),
      federated: new Error('boom'),
      local: new Error('boom'),
      trending: new Error('boom'),
      followedTags: new Error('boom'),
    })

    await expect(fetchCandidates({ client, now: NOW, onSourceError: () => {} })).resolves.toEqual([])
  })

  it('honours an explicit source restriction and explicit tags', async () => {
    const client = fakeClient({
      home: [status('h')],
      tags: { rust: [status('r')] },
    })

    const candidates = await fetchCandidates({ client, now: NOW, sources: ['tag'], tags: ['#rust'] })

    expect(ids(candidates)).toEqual(['r'])
  })

  it('caps the tag fan-out', async () => {
    const asked: string[] = []
    const client = fakeClient({
      onCall: (name) => {
        if (name.startsWith('tag:'))
          asked.push(name.slice(4))
      },
    })

    await fetchCandidates({ client, now: NOW, sources: ['tag'], tags: ['a', 'b', 'c', 'd'], maxTags: 2 })

    expect(asked).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

describe('candidate pool', () => {
  beforeEach(() => {
    resetCandidatePool()
    resetFollowCache()
    resetRateLimit()
  })

  const poolOptions = {
    now: NOW,
    signals: signals(),
    resolveFollowSet: false as const,
    // These tests fill several times in the same millisecond; the request-budget
    // throttle is exercised on its own, below.
    minFillIntervalMs: 0,
    filters: { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 },
  }

  function poolClient(homePages: mastodon.v1.Status[][]) {
    return fakeClient({ home: pagesOf(homePages) })
  }

  it('fills, filters and exposes the pool', async () => {
    const client = poolClient([[status('a'), status('b')]])
    const candidates = await fillCandidatePool({ ...poolOptions, client, sources: ['home'], disable: ['list'] })

    expect(ids(candidates)).toEqual(['a', 'b'])

    const state = useForYouCandidatePool().value
    expect(state.status).toBe('ready')
    expect(state.candidates).toHaveLength(2)
    expect(state.cursors.home).toBe('b')
    expect(state.stats.fetched).toBe(2)
    expect(state.stats.filtered).toBe(2)
  })

  it('accumulates across refills, merging sources and resuming cursors', async () => {
    const shared = status('shared')
    await fillCandidatePool({
      ...poolOptions,
      client: fakeClient({ home: paginatorOf([shared]) }),
      sources: ['home'],
      disable: ['list'],
    })
    await refillCandidatePool({
      ...poolOptions,
      client: fakeClient({ local: [shared, status('newer')] }),
      sources: ['local'],
      disable: ['list'],
    })

    const state = useForYouCandidatePool().value
    expect(ids(state.candidates).sort()).toEqual(['newer', 'shared'])
    expect([...state.candidates.find(c => c.status.id === 'shared')!.sources].sort())
      .toEqual(['home', 'local'])
  })

  it('never resurrects a candidate once it has been served', async () => {
    const client = poolClient([[status('a'), status('b')]])
    await fillCandidatePool({ ...poolOptions, client, sources: ['home'], disable: ['list'] })

    consumeCandidates(['a'])
    expect(ids(useForYouCandidatePool().value.candidates)).toEqual(['b'])

    await fillCandidatePool({ ...poolOptions, client: poolClient([[status('a'), status('b')]]), sources: ['home'], disable: ['list'] })
    expect(ids(useForYouCandidatePool().value.candidates)).toEqual(['b'])
  })

  it('reports when it is running low', async () => {
    await fillCandidatePool({ ...poolOptions, client: poolClient([[status('a')]]), sources: ['home'], disable: ['list'] })

    expect(poolNeedsRefill(5)).toBe(true)
    expect(poolNeedsRefill(1)).toBe(false)
  })

  it('ensureCandidatePool awaits a fill only when the pool cannot serve', async () => {
    const client = poolClient([[status('a'), status('b')]])
    const first = await ensureCandidatePool({ ...poolOptions, client, sources: ['home'], disable: ['list'] })
    expect(ids(first)).toEqual(['a', 'b'])

    // Healthy pool: returns synchronously from cache, no second fetch.
    const spy = vi.fn()
    const second = await ensureCandidatePool({
      ...poolOptions,
      client: fakeClient({ home: [status('c')], onCall: spy }),
      sources: ['home'],
      disable: ['list'],
      floor: 1,
    })
    expect(ids(second)).toEqual(['a', 'b'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('resets cleanly', async () => {
    await fillCandidatePool({ ...poolOptions, client: poolClient([[status('a')]]), sources: ['home'], disable: ['list'] })
    resetCandidatePool()

    const state = useForYouCandidatePool().value
    expect(state.candidates).toEqual([])
    expect(state.cursors).toEqual({})
    expect(state.status).toBe('empty')
  })

  it('survives a total fetch failure without losing what it had', async () => {
    await fillCandidatePool({ ...poolOptions, client: poolClient([[status('a')]]), sources: ['home'], disable: ['list'] })

    const broken = { v1: null } as unknown as mastodon.rest.Client
    const candidates = await fillCandidatePool({ ...poolOptions, client: broken, sources: ['home'], disable: ['list'] })

    expect(Array.isArray(candidates)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The shared request budget
// ---------------------------------------------------------------------------

function httpError(statusCode: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, headers })
}

describe('rate limiting', () => {
  beforeEach(() => {
    resetCandidatePool()
    resetRateLimit()
    resetFollowCache()
  })

  it('recognises a 429 however the error is shaped', () => {
    expect(isRateLimitError(httpError(429))).toBe(true)
    expect(isRateLimitError({ status: 429 })).toBe(true)
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true)
    expect(isRateLimitError(httpError(404))).toBe(false)
    expect(isRateLimitError(new Error('nope'))).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
  })

  it('honours Retry-After in seconds, as an HTTP date, and X-RateLimit-Reset', () => {
    expect(retryAfterMs(httpError(429, { 'retry-after': '30' }), NOW)).toBe(30_000)
    expect(retryAfterMs(
      httpError(429, { 'retry-after': new Date(NOW + 45_000).toUTCString() }),
      NOW,
    )).toBeGreaterThanOrEqual(44_000)
    expect(retryAfterMs(
      httpError(429, { 'x-ratelimit-reset': new Date(NOW + 120_000).toISOString() }),
      NOW,
    )).toBe(120_000)
    // No hint at all: caller falls back to the flat backoff.
    expect(retryAfterMs(httpError(429), NOW)).toBeUndefined()
    // A server claiming a week still gets retried within the hour.
    expect(retryAfterMs(httpError(429, { 'retry-after': '604800' }), NOW)).toBe(60 * 60_000)
  })

  it('stops the fan-out dead on the first 429 instead of spending the rest', async () => {
    const called: string[] = []
    const client = fakeClient({
      home: httpError(429, { 'retry-after': '30' }),
      federated: [status('f')],
      local: [status('l')],
      trending: [status('t')],
      onCall: name => called.push(name),
    })

    const result = await fetchCandidatesDetailed({
      client,
      now: NOW,
      concurrency: 1,
      disable: ['list', 'twohop', 'tag'],
      onSourceError: () => {},
    })

    expect(result.rateLimited).toBe(true)
    // Home ran and was refused; the queued sources were abandoned unissued.
    expect(called).toEqual(['home'])
    // The backoff deadline is wall-clock, not the pinned content `now`.
    expect(isRateLimited()).toBe(true)
    expect(rateLimitRetryIn()).toBeGreaterThan(0)
    expect(rateLimitRetryIn()).toBeLessThanOrEqual(30_000)
  })

  it('spends nothing at all while backing off', async () => {
    const called: string[] = []
    const client = fakeClient({ home: [status('h')], onCall: name => called.push(name) })

    await fetchCandidatesDetailed({
      client: fakeClient({ home: httpError(429) }),
      now: NOW,
      disable: ['list', 'twohop', 'tag'],
      onSourceError: () => {},
    })
    called.length = 0

    const result = await fetchCandidatesDetailed({ client, disable: ['list', 'twohop', 'tag'] })

    expect(called).toEqual([])
    expect(result.rateLimited).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('lets an explicit retry through the backoff', async () => {
    await fetchCandidatesDetailed({
      client: fakeClient({ home: httpError(429) }),
      now: NOW,
      disable: ['list', 'twohop', 'tag'],
      onSourceError: () => {},
    })

    const candidates = await fetchCandidates({
      client: fakeClient({ home: [status('h')] }),
      ignoreRateLimit: true,
      disable: ['list', 'twohop', 'tag'],
      sources: ['home'],
      resolveFollowSet: false,
    })

    expect(ids(candidates)).toEqual(['h'])
  })

  it('degrades to the pooled candidates rather than emptying the feed', async () => {
    const poolOptions = {
      signals: signals(),
      resolveFollowSet: false as const,
      minFillIntervalMs: 0,
      filters: { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 },
    }

    await fillCandidatePool({
      ...poolOptions,
      now: NOW,
      client: fakeClient({ home: [status('a'), status('b')] }),
      sources: ['home'],
      disable: ['list'],
    })
    expect(useForYouCandidatePool().value.candidates).toHaveLength(2)

    // The instance now refuses everything.
    const after = await refillCandidatePool({
      ...poolOptions,
      now: NOW,
      client: fakeClient({ home: httpError(429) }),
      sources: ['home'],
      disable: ['list'],
      onSourceError: () => {},
    })

    expect(ids(after)).toEqual(['a', 'b'])
    const state = useForYouCandidatePool().value
    expect(ids(state.candidates)).toEqual(['a', 'b'])
    expect(state.status).toBe('error')
    expect(state.stats.errors.length).toBeGreaterThan(0)
  })

  it('does not let reloads or tab toggles burn the request budget', async () => {
    const called: string[] = []
    const make = () => fakeClient({ home: [status('a')], onCall: name => called.push(name) })
    const options = {
      signals: signals(),
      resolveFollowSet: false as const,
      sources: ['home'] as CandidateSource[],
      disable: ['list'],
      filters: { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 },
    }

    await fillCandidatePool({ ...options, now: NOW, client: make() })
    expect(called).toHaveLength(1)

    // Five more mounts in the same second must cost nothing.
    for (let i = 0; i < 5; i++)
      await fillCandidatePool({ ...options, now: NOW, client: make() })

    expect(called).toHaveLength(1)
    expect(useForYouCandidatePool().value.candidates).toHaveLength(1)
  })

  it('cannot be bypassed by switching accounts in a loop', async () => {
    const called: string[] = []
    const make = () => fakeClient({ home: [status('a')], onCall: name => called.push(name) })
    const options = {
      signals: signals(),
      resolveFollowSet: false as const,
      sources: ['home'] as CandidateSource[],
      disable: ['list'],
      filters: { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 },
    }

    await fillCandidatePool({ ...options, now: NOW, client: make() })
    expect(called).toHaveLength(1)

    for (let i = 0; i < 5; i++) {
      // An account switch drops the pool, but must not reset the throttle —
      // otherwise the switch itself becomes the bypass.
      resetCandidatePool()
      await fillCandidatePool({ ...options, now: NOW, client: make() })
    }

    expect(called).toHaveLength(1)
  })

  it('still fetches for a genuinely empty pool, and for an explicit refresh', async () => {
    const called: string[] = []
    const make = () => fakeClient({ home: [status('a')], onCall: name => called.push(name) })
    const options = {
      signals: signals(),
      resolveFollowSet: false as const,
      sources: ['home'] as CandidateSource[],
      disable: ['list'],
      filters: { now: NOW, viewerAccountId: 'me', useMastodonFilters: false, floor: 0 },
    }

    // Empty pool: the user has nothing, so the request is the whole point.
    await fillCandidatePool({ ...options, now: NOW, client: make() })
    expect(called).toHaveLength(1)

    // Pull-to-refresh opts out of the throttle deliberately.
    await fillCandidatePool({ ...options, now: NOW, client: make(), force: true })
    expect(called).toHaveLength(2)
  })
})
