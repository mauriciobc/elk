import type { mastodon } from 'masto'
import type { PostCandidate } from '../../app/composables/for-you/types'
import { describe, expect, it, vi } from 'vitest'
import {
  computeTokenIdf,
  cosineSimilarity,
  dedupeConversations,
  DEFAULT_DIVERSITY_LIMIT,
  diversityRerank,
  embedCandidate,
  embedCandidates,
  EMBEDDING_DIM,
  extractCandidateFeatures,
  tokenizeText,
} from '../../app/composables/for-you/diversity'

interface StatusSpec {
  id: string
  authorId?: string
  text?: string
  tags?: string[]
  language?: string | null
  media?: string[]
  links?: string[]
  spoiler?: string
  inReplyToId?: string
  reblogOf?: StatusSpec
}

function makeStatus(spec: StatusSpec): mastodon.v1.Status {
  const links = (spec.links ?? [])
    .map(href => `<a href="${href}">${href}</a>`)
    .join(' ')
  const tagLinks = (spec.tags ?? [])
    .map(tag => `<a href="https://example.social/tags/${tag}" class="hashtag">#${tag}</a>`)
    .join(' ')

  return {
    id: spec.id,
    createdAt: '2024-01-01T00:00:00.000Z',
    content: `<p>${spec.text ?? ''} ${tagLinks} ${links}</p>`,
    spoilerText: spec.spoiler ?? '',
    language: spec.language === undefined ? 'en' : spec.language,
    inReplyToId: spec.inReplyToId ?? null,
    inReplyToAccountId: null,
    account: { id: spec.authorId ?? 'author-1', acct: `user${spec.authorId ?? '1'}` },
    tags: (spec.tags ?? []).map(name => ({ name, url: `https://example.social/tags/${name}` })),
    mediaAttachments: (spec.media ?? []).map((type, i) => ({ id: `${spec.id}-m${i}`, type })),
    reblog: spec.reblogOf ? makeStatus(spec.reblogOf) : null,
  } as unknown as mastodon.v1.Status
}

function makeCandidate(spec: StatusSpec, score = 1): PostCandidate {
  return {
    status: makeStatus(spec),
    sources: new Set(['home']),
    inNetwork: true,
    score,
  }
}

/**
 * Filler posts so inverse document frequency has a corpus to measure against.
 * `embedCandidates` is the shipping path — `embedCandidate` is its corpus-free
 * degenerate case, in which every token, including function words, weighs the
 * same.
 */
function filler(count: number): PostCandidate[] {
  const subjects = ['harbour', 'lantern', 'quarry', 'meadow', 'compass', 'thimble', 'lattice', 'burrow']
  return Array.from({ length: count }, (_, i) => makeCandidate({
    id: `filler-${i}`,
    authorId: `filler-author-${i}`,
    tags: [`filler-tag-${i}`],
    text: `The ${subjects[i % subjects.length]} and the ${subjects[(i + 3) % subjects.length]} `
      + `are here with a few more words so that the common function words appear `
      + `in every single post of this corpus, sample ${i}.`,
  }))
}

/** Similarity between the probes, measured with IDF fitted on probes + filler. */
function similarityInCorpus(probes: PostCandidate[], fillerCount = 40): number[][] {
  const all = [...probes, ...filler(fillerCount)]
  const vectors = embedCandidates(all)
  return probes.map((_, i) => probes.map((__, j) => cosineSimilarity(vectors[i], vectors[j])))
}

function authorOf(candidate: PostCandidate): string {
  const status = candidate.status.reblog ?? candidate.status
  return status.account.id
}

function topicOf(candidate: PostCandidate): string {
  const status = candidate.status.reblog ?? candidate.status
  return status.tags[0]?.name ?? ''
}

/** Number of neighbouring pairs in `list[0..n)` that share a key. */
function adjacentRuns(list: PostCandidate[], key: (c: PostCandidate) => string, n: number): number {
  let count = 0
  const window = list.slice(0, n)
  for (let i = 1; i < window.length; i++) {
    if (key(window[i]) === key(window[i - 1]))
      count++
  }
  return count
}

function meanScore(list: PostCandidate[], n: number): number {
  const window = list.slice(0, n)
  return window.reduce((acc, c) => acc + (c.score ?? 0), 0) / window.length
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/**
 * Spearman rank correlation between output position and score rank, over the
 * output slice `[start, end)`. 1.0 means the slice is in exact score order.
 */
function tailRho(reranked: PostCandidate[], byScore: PostCandidate[], start: number, end: number): number {
  const scoreRank = new Map(byScore.map((c, i) => [c.status.id, i]))
  const observed = reranked.slice(start, end).map(c => scoreRank.get(c.status.id)!)
  // Rank the observed score-ranks among themselves, so the comparison is
  // "is this slice internally ordered", not "is it in absolute position".
  const order = [...observed].sort((a, b) => a - b)
  const n = observed.length
  let sumSquaredDiff = 0
  for (let i = 0; i < n; i++) {
    const d = i - order.indexOf(observed[i])
    sumSquaredDiff += d * d
  }
  return 1 - (6 * sumSquaredDiff) / (n * (n * n - 1))
}

describe('for-you diversity: embedding + similarity', () => {
  it('produces unit-norm vectors of the declared dimension', () => {
    const vector = embedCandidate(makeCandidate({
      id: '1',
      text: 'Reverse engineering the home timeline ranker',
      tags: ['algorithms'],
    }))

    expect(vector.length).toBe(EMBEDDING_DIM)
    expect(EMBEDDING_DIM).toBeGreaterThanOrEqual(4096)
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 10)

    let norm = 0
    for (const x of vector)
      norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 10)
  })

  it('scores identical posts at ~1 and unrelated posts at ~0', () => {
    const base: StatusSpec = {
      id: 'a',
      authorId: 'alice',
      text: 'A long walk through the mountains, photographing alpine flowers at dawn',
      tags: ['hiking', 'photography'],
      media: ['image'],
      links: ['https://alpinejournal.example/flowers'],
    }
    const probes = [
      makeCandidate(base),
      makeCandidate({ ...base, id: 'b' }),
      makeCandidate({
        id: 'c',
        authorId: 'bob',
        text: 'Rust borrow checker finally clicked while writing a lock-free queue',
        tags: ['rustlang', 'concurrency'],
        language: 'de',
        links: ['https://crates.example/queue'],
      }),
    ]

    const sim = similarityInCorpus(probes)
    expect(sim[0][1]).toBeGreaterThan(0.999)
    expect(Math.abs(sim[0][2])).toBeLessThan(0.05)
  })

  it('ranks same-topic well above unrelated, and same-author only just above', () => {
    const probes = [
      makeCandidate({ id: 'a', authorId: 'alice', tags: ['backend'], text: 'Shipping the new caching layer today, latency down by half' }),
      makeCandidate({ id: 'b', authorId: 'alice', tags: ['baking'], text: 'Made sourdough focaccia with rosemary and olives' }),
      makeCandidate({ id: 'c', authorId: 'carol', tags: ['backend'], text: 'Shipping the new caching layer today, latency down by half' }),
      makeCandidate({ id: 'd', authorId: 'dave', tags: ['birds'], text: 'Watched a heron fish the canal for twenty minutes' }),
    ]
    const sim = similarityInCorpus(probes)
    const [, sameAuthor, sameTopic, unrelated] = sim[0]

    expect(sameTopic).toBeGreaterThan(0.8)
    expect(unrelated).toBeLessThan(0.05)
    // Author is deliberately a *weak* residual signal: `ranking.ts` already
    // applies its own author-diversity decay in `applyAdjustments`, so a heavy
    // author weight here would penalise the same author twice.
    expect(sameAuthor).toBeGreaterThan(unrelated)
    expect(sameAuthor).toBeLessThan(sameTopic / 3)
  })

  it('keeps hash-collision noise well below the weakest real signal', () => {
    // 120 posts sharing no author, tag, language or token: every nonzero cosine
    // between them is pure hashing-trick collision noise.
    const posts = Array.from({ length: 120 }, (_, i) => makeCandidate({
      id: `n${i}`,
      authorId: `au${i}`,
      tags: [`tg${i}`],
      language: null,
      text: `zzq${i}alpha zzq${i}beta zzq${i}gamma zzq${i}delta zzq${i}epsilon zzq${i}zeta`,
    }))
    const vectors = embedCandidates(posts)

    const noise: number[] = []
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++)
        noise.push(Math.abs(cosineSimilarity(vectors[i], vectors[j])))
    }
    noise.sort((a, b) => a - b)

    // The weakest signal we actually rely on: two posts sharing only a hashtag.
    const shared = similarityInCorpus([
      makeCandidate({ id: 's1', authorId: 'x', tags: ['climate'], language: null, text: 'aaa bbb ccc' }),
      makeCandidate({ id: 's2', authorId: 'y', tags: ['climate'], language: null, text: 'ddd eee fff' }),
    ])[0][1]

    // At 256 dims the p99 of pure noise (0.369) exceeded the real same-author
    // signal (0.281). Here p99 is ~0.08 against a 0.47 signal.
    expect(quantile(noise, 0.99)).toBeLessThan(shared / 4)
    // A hashed embedding always has a collision tail — two posts whose *tags*
    // land in the same bucket are indistinguishable from two posts that share a
    // tag, at any dimension. What matters is how rare that is. Measured at
    // EMBEDDING_DIM 4096: 3 confusable pairs out of 2380, i.e. 0.13%. The bound
    // is the measured rate with headroom, not an aspiration — tightening it
    // requires more dimensions, not a smaller number here.
    const confusable = noise.filter(x => x > shared / 2).length
    expect(confusable / noise.length).toBeLessThan(0.005)
  })

  it('keys links on the story, not just the outlet', () => {
    const story = 'https://news.example/2026/03/election-results-explained'
    const other = 'https://news.example/2026/03/badger-census-published'
    const mirror = 'https://otherpaper.example/2026/03/election-results-explained'

    const probes = [
      makeCandidate({ id: 'a', authorId: 'bot1', text: 'headline', links: [story] }),
      makeCandidate({ id: 'b', authorId: 'bot1', text: 'headline', links: [other] }),
      makeCandidate({ id: 'c', authorId: 'bot2', text: 'headline', links: [mirror] }),
    ]
    const sim = similarityInCorpus(probes)

    // Same outlet, different story must not read as a duplicate...
    expect(sim[0][1]).toBeLessThan(0.95)
    // ...and the same path on two outlets must still share the link signal.
    expect(sim[0][2]).toBeGreaterThan(0)
  })

  it('samples tokens across the post, not just its opening', () => {
    const shared = Array.from({ length: 400 }, (_, i) => `sharedword${i}`).join(' ')
    const probes = [
      makeCandidate({ id: 'a', authorId: 'x', text: `alpha beta gamma delta ${shared}` }),
      makeCandidate({ id: 'b', authorId: 'x', text: `epsilon zeta eta theta ${shared}` }),
    ]
    // The two differ only in their first four words out of 404.
    expect(similarityInCorpus(probes)[0][1]).toBeGreaterThan(0.85)
  })

  it('handles degenerate vectors and empty posts', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10)

    // No text, no tags, no author: still a usable unit vector, and deterministic.
    const empty = makeCandidate({ id: 'empty', authorId: '', text: '', language: null })
    const v1 = embedCandidate(empty)
    const v2 = embedCandidate(empty)
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1, 10)

    const otherEmpty = embedCandidate(makeCandidate({ id: 'other', authorId: '', text: '', language: null }))
    expect(Math.abs(cosineSimilarity(v1, otherEmpty))).toBeLessThan(0.99)
  })
})

describe('for-you diversity: tokenizer', () => {
  it('strips markup, urls, mentions and hashtags', () => {
    const tokens = tokenizeText('The quick brown fox https://x.example/a @alice@fed.example #tagged jumped')
    expect(tokens).toContain('quick')
    expect(tokens).toContain('brown')
    expect(tokens).toContain('jumped')
    expect(tokens).not.toContain('https')
    expect(tokens).not.toContain('alice')
    expect(tokens).not.toContain('tagged')
  })

  it('keeps function words rather than using a stop-word list', () => {
    // A curated stop-word list only works for the languages it covers, and Elk
    // ships ~40 locales. Function words are kept and down-weighted by IDF.
    expect(tokenizeText('the and for with')).toContain('the')
    // ...which also means "New York" survives, where an English list would have
    // eaten `new`.
    expect(tokenizeText('Visiting New York in the new year')).toContain('new')
  })

  it('down-weights ubiquitous tokens in whatever language the feed is in', () => {
    // Dutch/Turkish function words — nothing an English list would contain.
    const corpus = Array.from({ length: 30 }, (_, i) => makeCandidate({
      id: `d${i}`,
      authorId: `a${i}`,
      text: `het is een van de bir ve bu için onderwerp${i} kavram${i}`,
    }))
    const idf = computeTokenIdf(corpus.map(c => extractCandidateFeatures(c.status)))

    const ubiquitous = idf.get('het')!
    const distinctive = idf.get('onderwerp0')!
    expect(ubiquitous).toBeGreaterThan(0)
    expect(distinctive).toBeGreaterThan(ubiquitous * 3)
  })

  it('bounds work by input length', () => {
    const huge = `${'lorem ipsum dolor sit amet consectetur '.repeat(20000)}`
    const start = performance.now()
    for (let i = 0; i < 50; i++)
      tokenizeText(huge)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('for-you diversity: multilingual', () => {
  it('segments Japanese into words rather than one token', () => {
    const tokens = tokenizeText('今日の選挙結果について議論しています')
    expect(tokens.length).toBeGreaterThan(3)

    const probes = [
      makeCandidate({ id: 'ja1', authorId: 'a', language: 'ja', text: '今日の選挙結果について議論しています' }),
      makeCandidate({ id: 'ja2', authorId: 'b', language: 'ja', text: '選挙結果が発表されました' }),
      makeCandidate({ id: 'ja3', authorId: 'c', language: 'ja', text: '今日は寿司を食べに行きました' }),
    ]
    const sim = similarityInCorpus(probes)
    expect(sim[0][1]).toBeGreaterThan(sim[0][2] + 0.05)
  })

  it('segments Chinese into words rather than one token', () => {
    const tokens = tokenizeText('今天的选举结果引发了广泛讨论')
    expect(tokens.length).toBeGreaterThan(3)

    const probes = [
      makeCandidate({ id: 'zh1', authorId: 'a', language: 'zh', text: '今天的选举结果引发了广泛讨论' }),
      makeCandidate({ id: 'zh2', authorId: 'b', language: 'zh', text: '选举结果已经公布了' }),
      makeCandidate({ id: 'zh3', authorId: 'c', language: 'zh', text: '我今天去公园散步看花' }),
    ]
    const sim = similarityInCorpus(probes)
    expect(sim[0][1]).toBeGreaterThan(sim[0][2] + 0.05)
  })

  it('keeps combining marks attached: Hindi, Tamil, Hebrew with niqqud', () => {
    // Without `\p{M}` in the token class these produce junk or nothing at all.
    const hindi = tokenizeText('नमस्ते दुनिया आप कैसे हैं')
    expect(hindi.length).toBeGreaterThan(2)
    expect(hindi).toContain('नमस्ते')

    const tamil = tokenizeText('தமிழ் மொழி மிகவும் அழகானது')
    expect(tamil.length).toBeGreaterThan(2)
    expect(tamil).toContain('தமிழ்')

    const hebrew = tokenizeText('שָׁלוֹם עוֹלָם יָפֶה')
    expect(hebrew.length).toBeGreaterThan(2)
  })

  it('treats NFC and NFD as the same text', () => {
    for (const text of ['Grüße aus München', 'Tiếng Việt rất đẹp', 'čaj s příchutí']) {
      const nfc = text.normalize('NFC')
      const nfd = text.normalize('NFD')
      expect(nfd).not.toBe(nfc)
      expect(tokenizeText(nfd)).toEqual(tokenizeText(nfc))
    }

    const probes = [
      makeCandidate({ id: 'nfc', authorId: 'a', language: 'de', text: 'Grüße aus München im Frühling'.normalize('NFC') }),
      makeCandidate({ id: 'nfd', authorId: 'a', language: 'de', text: 'Grüße aus München im Frühling'.normalize('NFD') }),
    ]
    expect(similarityInCorpus(probes)[0][1]).toBeGreaterThan(0.999)
  })

  it('falls back to character bigrams when Intl.Segmenter is missing', async () => {
    vi.resetModules()
    const intl = globalThis.Intl as any
    const original = intl.Segmenter
    intl.Segmenter = undefined
    try {
      const mod = await import('../../app/composables/for-you/diversity')
      const tokens = mod.tokenizeText('選挙結果')
      expect(tokens).toContain('選挙')
      expect(tokens).toContain('結果')
      expect(tokens.length).toBeGreaterThan(1)
    }
    finally {
      intl.Segmenter = original
      vi.resetModules()
    }
  })
})

describe('for-you diversity: conversation dedup', () => {
  /** `maxPerConversation: 1` is the faithful port of home-mixer's filter. */
  const one = { maxPerConversation: 1 }

  it('keeps the highest-scoring branch of a conversation', () => {
    const kept = dedupeConversations([
      makeCandidate({ id: '10', inReplyToId: '1' }, 0.5),
      makeCandidate({ id: '11', inReplyToId: '10' }, 0.9),
      makeCandidate({ id: '12', inReplyToId: '1' }, 0.7),
      makeCandidate({ id: '20', inReplyToId: '2' }, 0.3),
    ], one)

    expect(kept).toHaveLength(2)
    expect(kept.map(c => c.status.id).sort()).toEqual(['11', '20'])
    expect(kept[0].status.id).toBe('11')
  })

  it('links sibling replies to an absent parent', () => {
    const kept = dedupeConversations([
      makeCandidate({ id: 'r1', inReplyToId: 'root' }, 0.2),
      makeCandidate({ id: 'r2', inReplyToId: 'root' }, 0.8),
      makeCandidate({ id: 'r3', inReplyToId: 'root' }, 0.4),
    ], one)

    expect(kept).toHaveLength(1)
    expect(kept[0].status.id).toBe('r2')
  })

  it('keeps the first occurrence when scores tie', () => {
    const kept = dedupeConversations([
      makeCandidate({ id: '1', inReplyToId: '42' }, 1),
      makeCandidate({ id: '2', inReplyToId: '42' }, 1),
    ], one)

    expect(kept).toHaveLength(1)
    expect(kept[0].status.id).toBe('1')
  })

  it('does not dedup standalone posts', () => {
    const kept = dedupeConversations([
      makeCandidate({ id: '1' }, 1),
      makeCandidate({ id: '2' }, 2),
      makeCandidate({ id: '3' }, 3),
    ])
    expect(kept).toHaveLength(3)
  })

  it('collapses reblogs onto the post they boost', () => {
    const original: StatusSpec = { id: '500', authorId: 'alice', text: 'original post' }
    const kept = dedupeConversations([
      makeCandidate({ id: '900', authorId: 'bob', reblogOf: original }, 0.4),
      makeCandidate({ id: '901', authorId: 'carol', reblogOf: original }, 0.8),
      makeCandidate({ id: '600', authorId: 'dave', text: 'unrelated' }, 0.1),
    ], one)

    expect(kept).toHaveLength(2)
    expect(kept[0].status.id).toBe('901')
    expect(kept[1].status.id).toBe('600')
  })

  it('collapses a reply onto the conversation of the post it boosts', () => {
    const original: StatusSpec = { id: '500', authorId: 'alice', text: 'original post' }
    const kept = dedupeConversations([
      makeCandidate({ id: '900', authorId: 'bob', reblogOf: original }, 0.5),
      makeCandidate({ id: '11', authorId: 'carol', inReplyToId: '500' }, 0.9),
    ], one)

    expect(kept).toHaveLength(1)
    expect(kept[0].status.id).toBe('11')
  })

  it('preserves score ordering of the survivors', () => {
    const kept = dedupeConversations([
      makeCandidate({ id: 'a' }, 3),
      makeCandidate({ id: 'b', inReplyToId: 'a' }, 2),
      makeCandidate({ id: 'c' }, 1),
    ], one)
    expect(kept.map(c => c.status.id)).toEqual(['a', 'c'])
  })

  it('caps rather than collapses: keeps the best N branches', () => {
    // On Mastodon, replies are the substance of the feed — collapsing an
    // 8-person conversation to one post throws away most of a thread.
    const thread = Array.from({ length: 8 }, (_, i) =>
      makeCandidate({ id: `t${i}`, authorId: `a${i}`, inReplyToId: 'root' }, 1 - i * 0.1))

    const capped = dedupeConversations(thread)
    expect(capped).toHaveLength(3)
    // The three highest-scoring branches, in score order.
    expect(capped.map(c => c.status.id)).toEqual(['t0', 't1', 't2'])

    const wider = dedupeConversations(thread, { maxPerConversation: 5 })
    expect(wider.map(c => c.status.id)).toEqual(['t0', 't1', 't2', 't3', 't4'])

    // A cap below 1 is meaningless and is clamped, never zero-length.
    expect(dedupeConversations(thread, { maxPerConversation: 0 })).toHaveLength(1)
  })

  it('always collapses identical posts, even under a cap', () => {
    // Three people boosting one post is the same content three times, and the
    // cap must not let it through — that is a separate filter in home-mixer
    // (`RetweetDeduplicationFilter`) and a separate stage here.
    const original: StatusSpec = { id: '500', authorId: 'alice', text: 'original' }
    const kept = dedupeConversations([
      makeCandidate({ id: '900', authorId: 'bob', reblogOf: original }, 0.4),
      makeCandidate({ id: '901', authorId: 'carol', reblogOf: original }, 0.9),
      makeCandidate({ id: '902', authorId: 'dave', reblogOf: original }, 0.6),
    ])

    expect(kept).toHaveLength(1)
    expect(kept[0].status.id).toBe('901')
  })

  it('does not gut a realistic reply-heavy feed', () => {
    // 300 posts: 25% replies across 12 conversations, 35% boosts concentrated on
    // 25 popular originals, the rest standalone.
    const feed: PostCandidate[] = []
    for (let i = 0; i < 300; i++) {
      const score = 1 - i / 300
      if (i % 4 === 0) {
        feed.push(makeCandidate({
          id: `p${i}`,
          authorId: `author-${i % 60}`,
          inReplyToId: `conversation-${Math.floor(i / 4) % 12}`,
        }, score))
      }
      else if (i % 3 === 0) {
        feed.push(makeCandidate({
          id: `p${i}`,
          authorId: `booster-${i}`,
          reblogOf: { id: `popular-${i % 25}`, authorId: `star-${i % 25}` },
        }, score))
      }
      else {
        feed.push(makeCandidate({ id: `p${i}`, authorId: `author-${i % 60}` }, score))
      }
    }

    const collapsed = dedupeConversations(feed, one)
    const capped = dedupeConversations(feed)

    // Keeping exactly one branch throws away a large slice of the feed: on this
    // fixture 187 of 300 survive, so 38% is discarded outright. That is the
    // behaviour the cap exists to avoid; the two assertions below are the ones
    // that carry the meaning.
    expect(collapsed.length / feed.length).toBeLessThan(0.65)
    // Capping keeps substantially more of it. With DEFAULT_MAX_PER_CONVERSATION
    // at 3 this fixture retains 211 of 300 against 187 collapsed: the 12 reply
    // threads contribute 36 posts instead of 12, while boosts of one original
    // stay capped at 1 because they are the same post, not distinct branches.
    // 211 is therefore the arithmetic ceiling here, not a tuning target.
    expect(capped.length).toBeGreaterThan(collapsed.length)
    expect(capped.length / feed.length).toBeGreaterThan(0.7)
    // ...without ever duplicating a boosted post.
    const identities = capped.map(c => c.status.reblog?.id ?? c.status.id)
    expect(new Set(identities).size).toBe(identities.length)
  })

  it('is a no-op on 0 or 1 candidates', () => {
    expect(dedupeConversations([])).toEqual([])
    expect(dedupeConversations([makeCandidate({ id: '1' })])).toHaveLength(1)
  })
})

describe('for-you diversity: rerank', () => {
  /**
   * Five authors, five topics. Scores are laid out so a plain score sort puts
   * all eight of alice's posts first, then all eight of bob's, and so on — the
   * exact clustering vm-ranker's DPP exists to break up.
   */
  function clusteredFeed(): PostCandidate[] {
    const authors = ['alice', 'bob', 'carol', 'dave', 'erin']
    const topics = ['rustlang', 'baking', 'birdwatching', 'typography', 'trains']
    const bodies = [
      'borrow checker lifetimes async runtime executor scheduling',
      'sourdough starter hydration crumb oven spring rye levain',
      'heron kingfisher canal reeds binoculars migration ringing',
      'kerning ligature grotesque serif metrics hinting variable font',
      'catenary bogie signalling timetable gauge sleeper depot',
    ]

    const candidates: PostCandidate[] = []
    for (let a = 0; a < authors.length; a++) {
      for (let i = 0; i < 8; i++) {
        candidates.push(makeCandidate({
          id: `${a}-${i}`,
          authorId: authors[a],
          tags: [topics[a]],
          text: `${bodies[a]} note ${i}`,
        }, 1 - (a * 8 + i) * 0.01))
      }
    }
    return candidates
  }

  it('breaks up same-author and same-topic runs a score sort would cluster', () => {
    const feed = clusteredFeed()
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const reranked = diversityRerank(feed)

    expect(reranked).toHaveLength(feed.length)
    expect(new Set(reranked.map(c => c.status.id)).size).toBe(feed.length)

    expect(adjacentRuns(byScore, authorOf, 20)).toBeGreaterThanOrEqual(15)
    expect(adjacentRuns(reranked, authorOf, 20)).toBe(0)
    expect(adjacentRuns(byScore, topicOf, 20)).toBeGreaterThanOrEqual(15)
    expect(adjacentRuns(reranked, topicOf, 20)).toBe(0)

    // A score sort needs 33 slots before it shows a fifth author; the rerank
    // covers all five inside the first screenful.
    expect(new Set(byScore.slice(0, 12).map(authorOf)).size).toBe(2)
    expect(new Set(reranked.slice(0, 12).map(authorOf)).size).toBe(5)
  })

  it('the textbook max-MMR penalty cannot do this at any lambda', () => {
    // Documents why the DPP objective is the default: `max` saturates, so runs
    // re-form immediately below the first similar post that is placed.
    const feed = clusteredFeed()
    const best = [0.05, 0.1, 0.2, 0.35, 0.5, 0.8, 1.5, 3]
      .map(lambda => adjacentRuns(diversityRerank(feed, { lambda, penalty: 'max' }), authorOf, 20))
      .reduce((a, b) => Math.min(a, b))

    expect(best).toBeGreaterThan(5)
  })

  it('gives up only a little score to buy that diversity', () => {
    const feed = clusteredFeed()
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const reranked = diversityRerank(feed)

    const before = meanScore(byScore, 20)
    const after = meanScore(reranked, 20)
    const range = (byScore[0].score ?? 0) - (byScore.at(-1).score ?? 0)

    expect(after).toBeLessThanOrEqual(before)
    // ~21% of the pool's whole score range surrendered, on a feed engineered to
    // be maximally hostile: every author is eight near-duplicates, so there is
    // no cheap way to interleave. On a normal feed the cost is ~0.1% — see
    // "barely perturbs a feed that is already diverse".
    expect((before - after) / range).toBeLessThan(0.25)
    // The single best post is never displaced: nothing is penalised yet on the
    // first pick, exactly like the DPP's first greedy step.
    expect(reranked[0].status.id).toBe(byScore[0].status.id)
  })

  /** 200 posts, 40 authors, 25 topics, distinct vocabulary, heavy-tailed scores. */
  function variedFeed(): PostCandidate[] {
    const nouns = ['harbour', 'lantern', 'quarry', 'meadow', 'compass', 'thimble', 'lattice', 'burrow', 'cinder', 'marsh', 'anvil', 'orchard', 'ferry', 'kettle', 'pylon', 'satchel', 'willow', 'grotto', 'beacon', 'trellis']
    const verbs = ['collapsed', 'flourished', 'drifted', 'echoed', 'hardened', 'scattered', 'gleamed', 'settled', 'vanished', 'unfolded']
    return Array.from({ length: 200 }, (_, i) => makeCandidate({
      id: `v${i}`,
      authorId: `author-${i % 40}`,
      tags: [`topic-${i % 25}`],
      text: `${nouns[i % 20]} ${verbs[i % 10]} ${nouns[(i * 7) % 20]} ${nouns[(i * 13) % 20]} `
        + `${verbs[(i * 3) % 10]} beside the ${nouns[(i * 11) % 20]}`,
    }, 1 / (1 + i * 0.05)))
  }

  it('barely perturbs a feed that is already diverse', () => {
    const feed = variedFeed()
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const reranked = diversityRerank(feed)

    const originalTop20 = new Set(byScore.slice(0, 20).map(c => c.status.id))
    const overlap = reranked.slice(0, 20).filter(c => originalTop20.has(c.status.id)).length
    expect(overlap).toBeGreaterThanOrEqual(18)

    const loss = (meanScore(byScore, 20) - meanScore(reranked, 20)) / meanScore(byScore, 20)
    expect(loss).toBeLessThan(0.02)
  })

  it('does restructure a feed whose posts really do share their vocabulary', () => {
    // Every post here is 9/11 the same tokens as every other, so their pairwise
    // cosine sits around 0.52. Heavy reordering is the *correct* response, and
    // it is worth pinning down that this is deliberate rather than a regression.
    const feed = Array.from({ length: 200 }, (_, i) => makeCandidate({
      id: `p${i}`,
      authorId: `author-${i % 40}`,
      tags: [`topic-${i % 25}`],
      text: `Post number ${i} about widget ${i % 25} and gadget ${i % 11} with filler prose ${i}`,
    }, 1 / (1 + i * 0.05)))

    const vectors = embedCandidates(feed)
    expect(cosineSimilarity(vectors[0], vectors[1])).toBeGreaterThan(0.4)

    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const top20 = new Set(byScore.slice(0, 20).map(c => c.status.id))
    const overlap = diversityRerank(feed).slice(0, 20).filter(c => top20.has(c.status.id)).length
    expect(overlap).toBeLessThan(10)
  })

  it('breaks up the pattern that actually hurts: one story, many authors', () => {
    // 18 different accounts all posting the same news story, all scoring high —
    // the case a score sort turns into a wall of duplicates.
    const feed: PostCandidate[] = []
    for (let i = 0; i < 18; i++) {
      feed.push(makeCandidate({
        id: `story-${i}`,
        authorId: `reporter-${i}`,
        tags: ['breakingnews'],
        text: 'The council voted last night to approve the harbour redevelopment plan',
        links: ['https://news.example/harbour-redevelopment-approved'],
      }, 1 - i * 0.001))
    }
    for (let i = 0; i < 40; i++) {
      feed.push(makeCandidate({
        id: `other-${i}`,
        authorId: `person-${i}`,
        tags: [`hobby-${i}`],
        text: `An entirely separate thought about subject${i} and matter${i} today`,
      }, 0.9 - i * 0.005))
    }

    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const isStory = (c: PostCandidate) => c.status.id.startsWith('story-')

    expect(byScore.slice(0, 10).filter(isStory)).toHaveLength(10)
    expect(diversityRerank(feed).slice(0, 10).filter(isStory).length).toBeLessThanOrEqual(3)
  })

  it('leaves the tail in score order instead of ordering it by novelty', () => {
    // The penalty accumulates, so without a `limit` it eventually dominates the
    // quality term and the feed stops reflecting the ranking pipeline at all.
    const feed: PostCandidate[] = []
    for (let i = 0; i < 300; i++) {
      feed.push(makeCandidate({
        id: `p${i}`,
        authorId: `author-${i % 30}`,
        tags: [`topic-${i % 15}`],
        text: `Filler post ${i} discussing subject ${i % 15} and object ${i % 9}`,
      }, 1 / (1 + i * 0.02)))
    }
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    expect(DEFAULT_DIVERSITY_LIMIT).toBeLessThanOrEqual(50)

    const reranked = diversityRerank(feed)
    expect(tailRho(reranked, byScore, 100, 200)).toBeCloseTo(1, 6)
    expect(tailRho(reranked, byScore, 200, 300)).toBeCloseTo(1, 6)

    // Placing the whole pool is what the limit exists to prevent: past roughly
    // slot 100 the accumulated penalty dominates the quality term and the order
    // stops reflecting the upstream ranking pipeline at all.
    const unbounded = diversityRerank(feed, { limit: 300, poolSize: 300 })
    expect(tailRho(unbounded, byScore, 150, 300)).toBeLessThan(0.6)
    expect(tailRho(unbounded, byScore, 150, 300))
      .toBeLessThan(tailRho(reranked, byScore, 150, 300) - 0.3)
  })

  it('needs no lambda: the DPP objective is parameter-free', () => {
    const feed = clusteredFeed()
    // `lambda` is inert for the default objective — the trade-off comes from
    // `theta`, exactly as it does in vm-ranker.
    const a = diversityRerank(feed, { lambda: 0 })
    const b = diversityRerank(feed, { lambda: 99 })
    expect(a.map(c => c.status.id)).toEqual(b.map(c => c.status.id))

    // theta -> 1 sends the quality coefficient to infinity: a pure score sort.
    const byScore = [...feed].sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
    const scoreOrdered = diversityRerank(feed, { theta: 1 - 1e-9 })
    expect(scoreOrdered.map(c => c.status.id)).toEqual(byScore.map(c => c.status.id))

    // theta = 0 drops the quality term entirely and orders purely by novelty.
    // The first pick is still the top scorer — nothing is penalised yet, so the
    // tie is broken by score — but everything after it ignores score.
    const novelty = diversityRerank(feed, { theta: 0 })
    expect(novelty[0].status.id).toBe(byScore[0].status.id)
    expect(novelty.map(c => c.status.id)).not.toEqual(byScore.map(c => c.status.id))
    expect(meanScore(novelty, 20)).toBeLessThan(meanScore(byScore, 20))
  })

  it('lambda = 0 degenerates the linear objectives to a pure score sort', () => {
    const feed = clusteredFeed()
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    for (const penalty of ['residual', 'max'] as const) {
      expect(diversityRerank(feed, { penalty, lambda: 0 }).map(c => c.status.id))
        .toEqual(byScore.map(c => c.status.id))
    }
  })

  it('a larger lambda trades more score for more diversity', () => {
    const feed = clusteredFeed()
    const gentle = diversityRerank(feed, { penalty: 'residual', lambda: 0.05, limit: 40 })
    const aggressive = diversityRerank(feed, { penalty: 'residual', lambda: 1.5, limit: 40 })

    expect(adjacentRuns(gentle, authorOf, 20))
      .toBeGreaterThan(adjacentRuns(aggressive, authorOf, 20))
    expect(meanScore(aggressive, 20)).toBeLessThan(meanScore(gentle, 20))
  })

  it('is deterministic and a strict permutation of its input', () => {
    const feed = clusteredFeed()
    const a = diversityRerank(feed)
    const b = diversityRerank(feed)
    expect(a.map(c => c.status.id)).toEqual(b.map(c => c.status.id))
    expect(feed.every(c => a.includes(c))).toBe(true)
    expect(a).toHaveLength(feed.length)
  })

  it('honours limit and poolSize the way max_selected_rank does', () => {
    const feed = clusteredFeed()
    const byScore = [...feed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    // Only the top 10 by score may be reordered; the tail stays put.
    const pooled = diversityRerank(feed, { poolSize: 10 })
    expect(pooled.slice(10).map(c => c.status.id)).toEqual(byScore.slice(10).map(c => c.status.id))
    expect(new Set(pooled.slice(0, 10).map(c => c.status.id)))
      .toEqual(new Set(byScore.slice(0, 10).map(c => c.status.id)))

    // Only the first 5 slots are actively placed; the rest fall back to score order.
    const limited = diversityRerank(feed, { limit: 5 })
    const placed = new Set(limited.slice(0, 5).map(c => c.status.id))
    const tail = limited.slice(5).map(c => c.status.id)
    expect(tail).toEqual(byScore.map(c => c.status.id).filter(id => !placed.has(id)))
  })

  it('ignores precomputed embeddings of the wrong width', () => {
    const feed = clusteredFeed()
    const good = embedCandidates(feed)
    expect(diversityRerank(feed, { embeddings: good }).map(c => c.status.id))
      .toEqual(diversityRerank(feed).map(c => c.status.id))

    // Too narrow would scatter out of bounds and poison every penalty; the
    // rerank must fall back to embedding the pool itself, not produce NaNs.
    const narrow = feed.map(() => new Float64Array(256))
    const result = diversityRerank(feed, { embeddings: narrow })
    expect(result.map(c => c.status.id)).toEqual(diversityRerank(feed).map(c => c.status.id))
  })

  it('handles trivial inputs', () => {
    expect(diversityRerank([])).toEqual([])
    expect(diversityRerank([makeCandidate({ id: '1' })])).toHaveLength(1)
    // All-equal scores must not divide by zero.
    const flat = [
      makeCandidate({ id: '1', authorId: 'a' }, 0),
      makeCandidate({ id: '2', authorId: 'a' }, 0),
      makeCandidate({ id: '3', authorId: 'b' }, 0),
    ]
    expect(diversityRerank(flat)).toHaveLength(3)
    // Negative scores fall back to min-max rather than dividing by a bad max.
    const negative = [
      makeCandidate({ id: '1', authorId: 'a' }, -3),
      makeCandidate({ id: '2', authorId: 'b' }, -1),
      makeCandidate({ id: '3', authorId: 'c' }, -2),
    ]
    expect(diversityRerank(negative)[0].status.id).toBe('2')
  })
})

describe('for-you diversity: performance', () => {
  function bigFeed(n: number): PostCandidate[] {
    const candidates: PostCandidate[] = []
    for (let i = 0; i < n; i++) {
      candidates.push(makeCandidate({
        id: `p${i}`,
        authorId: `author-${i % 40}`,
        tags: [`topic-${i % 25}`, `sub-${i % 7}`],
        text: `Post number ${i} about widget ${i % 25} and gadget ${i % 11}, `
          + `with some filler prose so the token bag has a realistic length `
          + `and the parser has real markup to chew through, sample ${i}.`,
        media: i % 3 === 0 ? ['image'] : [],
        links: i % 5 === 0 ? [`https://news-${i % 13}.example/story/${i}`] : [],
        language: i % 9 === 0 ? 'pt' : 'en',
        inReplyToId: i % 6 === 0 ? `thread-${i % 8}` : undefined,
      }, 1 - i / n))
    }
    return candidates
  }

  it('runs the whole pipeline on 400 candidates well inside a feed load', () => {
    const feed = bigFeed(400)

    // Warm up JIT and the lazily-resolved segmenter so we time steady state.
    diversityRerank(dedupeConversations(bigFeed(50)))

    const start = performance.now()
    const deduped = dedupeConversations(feed)
    const reranked = diversityRerank(deduped)
    const elapsed = performance.now() - start

    expect(reranked.length).toBe(deduped.length)
    // 67 replies across 8 conversations, capped at 3 each.
    expect(deduped.length).toBeLessThan(feed.length)
    // Includes HTML parsing and embedding the whole pool. The bound leaves an
    // order of magnitude of headroom for slow CI.
    expect(elapsed).toBeLessThan(150)
  })

  it('scales linearly in k, not cubically', () => {
    const feed = bigFeed(300)
    const embeddings = embedCandidates(feed)

    const time = (limit: number) => {
      const start = performance.now()
      diversityRerank(feed, { embeddings, limit, poolSize: 300 })
      return performance.now() - start
    }

    time(10) // warm up
    const small = Math.max(time(30), 0.05)
    const large = time(300)

    // O(n*k) means 10x the picks costs ~10x; O(n^3)-ish would blow past 40x.
    expect(large / small).toBeLessThan(40)
    expect(large).toBeLessThan(200)
  })
})
