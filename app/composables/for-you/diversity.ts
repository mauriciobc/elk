import type { mastodon } from 'masto'
import type { PostCandidate } from './types'
// `content-parse` is `@unimport-disable`d, so it has to be imported explicitly.
// `htmlToText` is a pure `ultrahtml` parse + decode — no Nuxt context involved.
import { htmlToText } from '../content-parse'

/**
 * Diversity reordering — the client-side analogue of `vm-ranker` in
 * xai-org/x-algorithm, plus home-mixer's `DedupConversationFilter`.
 *
 * ## What vm-ranker actually does
 *
 * `vm-ranker/dpp.rs` runs a determinantal point process over the top
 * `max_selected_rank` (default 100) scored candidates:
 *
 * - `q_i = score_i / max_score`, then `qf_i = exp(alpha * q_i)` with
 *   `alpha = theta / (2 * (1 - theta))` (default `theta = 0.5`, so `alpha = 0.5`).
 * - The DPP kernel is `L_ij = qf_i * qf_j * cos(e_i, e_j)`, i.e. quality on the
 *   diagonal and CLIP/Phoenix embedding cosine off it.
 * - Greedy MAP selection maximises `log det(L_S)` via an incremental Cholesky,
 *   picking the item with the largest remaining conditional variance
 *   `cv_i = L_ii - sum_j f_ji^2` until `top_k` (default 50) items are picked or
 *   the volume collapses (`cv <= 1e-6`).
 * - The survivors are then re-sorted by their **original** score — so vm-ranker
 *   is a diversity *filter*, not a reorder. Everything it does not select gets
 *   score 0 in `home-mixer/scorers/vm_ranker.rs` and drops out of the timeline.
 *
 * ## What we do here, and how it differs
 *
 * We have no learned embeddings and no server to drop candidates on, so:
 *
 * - `embedCandidate` builds a *hashed bag-of-features* vector (the hashing
 *   trick, with sign hashing so inner products stay unbiased) out of the only
 *   content signals a Mastodon client has: hashtags, author, language, media
 *   kinds, outbound links, emoji and content tokens.
 * - `diversityRerank` maximises the same greedy objective as the DPP above, in
 *   its closed form under one stated approximation (see {@link diversityRerank}),
 *   which costs O(n * k) instead of the DPP's O(n * k^2) Cholesky.
 * - It *reorders* rather than truncating: nothing is thrown away, only pushed
 *   down. On a client that matters, because a discarded post is a post the user
 *   already paid to fetch.
 *
 * Everything here is a pure function. Nothing reads Nuxt state, and the vector
 * maths is reachable without any HTML via {@link embedFeatures}.
 */

/**
 * Dimensionality of the hashed feature space.
 *
 * A post carries roughly 25-60 hashed features, and sign hashing zeroes the
 * mean* of collision noise but not its variance — which a greedy argmax will
 * happily eat. At 256 dims, 52% of unrelated pairs had a nonzero cosine and the
 * p99 of pure noise (0.369) exceeded the real same-author signal (0.281). 4096
 * pushes the noise floor roughly an order of magnitude below the weakest real
 * signal; see the noise-floor test. vm-ranker uses 1024 dense f16 dims, but its
 * embeddings are learned and dense, so it does not pay for collisions the way a
 * hashed bag of features does.
 */
export const EMBEDDING_DIM = 4096

/**
 * vm-ranker's `dpp_theta`. `alpha = theta / (2 * (1 - theta))`, and the greedy
 * objective's quality coefficient is `2 * alpha = theta / (1 - theta)`, so the
 * default 0.5 means quality and diversity enter the objective at parity.
 */
export const DEFAULT_DIVERSITY_THETA = 0.5

/** vm-ranker's `dpp_top_k`: how many positions the greedy loop actually places. */
export const DEFAULT_DIVERSITY_LIMIT = 50

/**
 * vm-ranker's `dpp_max_selected_rank` is 100 against a `top_k` of 50. We keep
 * that 2:1 ratio at 200:50 — a wider pool is cheap here because the pool is
 * reordered rather than truncated, so widening it only adds candidates that
 * may* be promoted, it never drops anything.
 */
export const DEFAULT_DIVERSITY_POOL_SIZE = 200

/**
 * Penalty weight for the linear {@link DiversityPenalty} modes only. The
 * default `dpp` objective has no such knob — see {@link diversityRerank}.
 */
export const DEFAULT_DIVERSITY_LAMBDA = 0.25

const EPSILON = 1e-9
/** vm-ranker's `EPSILON`: the conditional variance at which it calls it a day. */
const MIN_RESIDUAL = 1e-6

// #region feature weights

/**
 * Relative pull of each feature family on the cosine. Each family is L2
 * normalised internally and then scaled by its weight, so a post with twenty
 * hashtags does not out-shout a post with two.
 */
const WEIGHT_AUTHOR = 0.4
const WEIGHT_TAGS = 1.2
const WEIGHT_TOKENS = 1.2
const WEIGHT_LINK = 0.8
const WEIGHT_EMOJI = 0.4
const WEIGHT_LANGUAGE = 0.35
const WEIGHT_SPOILER = 0.3
const WEIGHT_MEDIA = 0.3

/** Within the link family: which story, mostly, and which outlet, a little. */
const LINK_PATH_SHARE = 0.75
const LINK_HOST_SHARE = 0.25

// #endregion

// #region tokenizer

/**
 * Hard bound on how much text is tokenised, so a 20k-word post cannot stall a
 * feed load. Sampled head *and* tail rather than truncated, so the cap does not
 * silently turn "same post, different opening" into "different post".
 */
const MAX_TEXT_LENGTH = 4000
/** Distinct tokens retained before the per-post selection step. */
const MAX_DISTINCT_TOKENS = 512
/** Distinct tokens that actually reach the embedding. */
const MAX_TOKENS = 48

const URL_RE = /https?:\/\/\S+/g
const MENTION_RE = /@[\w.-]+(?:@[\w.-]+)?/g
const HASHTAG_RE = /#[\p{L}\p{N}\p{M}_]+/gu
const EMOJI_RE = /\p{Extended_Pictographic}/gu

/**
 * Everything that is *not* part of a word. Note `\p{M}` (combining marks) and
 * the zero-width joiners: without them Devanagari matras, Tamil vowel signs and
 * Hebrew niqqud become split points, which shreds those scripts into junk or
 * into nothing at all.
 */
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}\p{M}_\u200C\u200D]+/u

/**
 * Scripts that do not delimit words with spaces, so the split above leaves a
 * whole sentence as one token. Hangul is excluded on purpose — Korean *is*
 * space-delimited.
 */
const NEEDS_SEGMENTATION_RE
  = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u

/** A single character that is a morpheme in its own right, so length 1 is fine. */
const SINGLE_CHAR_OK_RE
  = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u

interface WordSegmenter { segment: (input: string) => Iterable<{ segment: string, isWordLike?: boolean }> }

let segmenter: WordSegmenter | null | undefined

/**
 * `Intl.Segmenter` with `granularity: 'word'` does ICU dictionary segmentation
 * for Han/Kana/Thai/Khmer/Lao/Myanmar. It ships in every browser Elk targets and
 * needs no dependency, but it is resolved lazily and falls back to character
 * bigrams so the tokenizer never depends on it being there.
 */
function getSegmenter(): WordSegmenter | null {
  if (segmenter === undefined) {
    const Ctor = (globalThis as any).Intl?.Segmenter
    try {
      segmenter = Ctor ? (new Ctor(undefined, { granularity: 'word' }) as WordSegmenter) : null
    }
    catch {
      segmenter = null
    }
  }
  return segmenter
}

/** Character bigrams — the standard CJK fallback when no segmenter is available. */
function bigrams(run: string, out: string[]): void {
  const chars = [...run]
  if (chars.length === 1) {
    out.push(chars[0])
    return
  }
  for (let i = 0; i + 1 < chars.length; i++)
    out.push(chars[i] + chars[i + 1])
}

function segmentUnspaced(run: string, out: string[]): void {
  const seg = getSegmenter()
  if (!seg) {
    bigrams(run, out)
    return
  }
  let produced = 0
  for (const piece of seg.segment(run)) {
    if (piece.isWordLike === false)
      continue
    const value = piece.segment
    if (value.length > 0) {
      out.push(value)
      produced++
    }
  }
  if (produced === 0)
    bigrams(run, out)
}

function keepToken(token: string): boolean {
  if (token.length === 0)
    return false
  if (token.length >= 2)
    return true
  return SINGLE_CHAR_OK_RE.test(token)
}

/**
 * Distinct, script-aware content tokens.
 *
 * Text is NFC-normalised first: Mastodon does not normalise Unicode, so the same
 * German or Vietnamese sentence can arrive in NFC from one server and NFD from
 * another, and without this they would not match each other.
 *
 * There is no stop-word list. A curated list is unavoidably language-specific —
 * swapping English function words for Dutch or Turkish ones moved the mean
 * unrelated-pair cosine from 0.007 to 0.152 — so ubiquitous tokens are instead
 * down-weighted by inverse document frequency over the candidate set itself
 * (see {@link embedCandidates}), which is language-neutral by construction.
 */
export function tokenizeText(text: string): string[] {
  if (!text)
    return []

  // Bound the work before doing anything quadratic-ish to it.
  let bounded = text
  if (bounded.length > MAX_TEXT_LENGTH) {
    const half = MAX_TEXT_LENGTH >> 1
    bounded = `${bounded.slice(0, half)} ${bounded.slice(-half)}`
  }

  const cleaned = bounded
    .normalize('NFC')
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(HASHTAG_RE, ' ')
    .replace(EMOJI_RE, ' ')

  const tokens = new Set<string>()
  for (const raw of cleaned.split(TOKEN_SPLIT_RE)) {
    if (raw.length === 0)
      continue

    if (NEEDS_SEGMENTATION_RE.test(raw)) {
      const pieces: string[] = []
      segmentUnspaced(raw, pieces)
      for (const piece of pieces) {
        if (keepToken(piece))
          tokens.add(piece)
      }
    }
    else if (keepToken(raw)) {
      tokens.add(raw)
    }

    if (tokens.size >= MAX_DISTINCT_TOKENS)
      break
  }

  return [...tokens]
}

// #endregion

// #region hashing

const HASH_SEED_BUCKET = 0x811C9DC5
const HASH_SEED_SIGN = 0x9E3779B1

/** FNV-1a, 32-bit. Cheap, well-spread, and dependency-free. */
function hashString(value: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// #endregion

// #region feature extraction

/** The content signals we can extract client-side. */
export interface CandidateFeatures {
  /** Distinct content tokens, already normalised and script-segmented. */
  tokens: string[]
  /** Distinct tokens of the content warning, if any. */
  spoilerTokens: string[]
  /** Lowercased hashtags, without the leading `#`. */
  hashtags: string[]
  /** Distinct emoji used in the body. */
  emoji: string[]
  /** Account id of the (original) author. */
  authorId: string
  /** BCP-47-ish language code, or `null` when the server did not detect one. */
  language: string | null
  /** Distinct media kinds present (`image`, `video`, `gifv`, ...). */
  mediaTypes: string[]
  /** `host/path` of outbound links — the story, not just the outlet. */
  linkPaths: string[]
  /** Bare hosts of those links. */
  linkHosts: string[]
  /** Stable fallback so a featureless post still gets a unit vector. */
  fallbackKey: string
}

const HREF_RE = /href="([^"]+)"/g
const TAG_PATH_RE = /\/tags?\//i
const PROFILE_PATH_RE = /\/@[^/]+\/?$/
const LINK_PARTS_RE = /^https?:\/\/([^/?#]+)([^?#]*)/i
const WWW_PREFIX_RE = /^www\./
const TRAILING_SLASH_RE = /\/+$/

function originalStatus(status: mastodon.v1.Status): mastodon.v1.Status {
  return status.reblog ?? status
}

/** `{ host, path }` for an outbound link, or `null` for in-fediverse chrome. */
function linkParts(href: string): { host: string, path: string } | null {
  // Profile and tag pages carry no topic — they are navigation, not content.
  if (TAG_PATH_RE.test(href) || PROFILE_PATH_RE.test(href))
    return null
  const match = LINK_PARTS_RE.exec(href)
  if (!match)
    return null
  const host = match[1].toLowerCase().replace(WWW_PREFIX_RE, '')
  const path = (match[2] ?? '').replace(TRAILING_SLASH_RE, '')
  return { host, path: `${host}${path}` }
}

function distinctEmoji(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(EMOJI_RE)) {
    found.add(match[0])
    if (found.size >= 16)
      break
  }
  return [...found]
}

/**
 * Pull the embeddable signals off a status. Kept separate from
 * {@link embedFeatures} so the vector maths stays testable without any HTML.
 */
export function extractCandidateFeatures(status: mastodon.v1.Status): CandidateFeatures {
  const post = originalStatus(status)
  const html = post.content ?? ''
  const body = html ? htmlToText(html) : ''
  const spoiler = post.spoilerText ?? ''

  const hashtags = new Set<string>()
  for (const tag of post.tags ?? []) {
    if (tag?.name)
      hashtags.add(tag.name.normalize('NFC').toLowerCase())
  }
  // Servers do not always populate `tags`, so fall back to what looks like a
  // hashtag in the rendered text.
  for (const raw of body.normalize('NFC').match(HASHTAG_RE) ?? [])
    hashtags.add(raw.slice(1).toLowerCase())

  const mediaTypes = new Set<string>()
  for (const media of post.mediaAttachments ?? []) {
    if (media?.type)
      mediaTypes.add(media.type)
  }

  const linkPaths = new Set<string>()
  const linkHosts = new Set<string>()
  const collectLink = (href: string) => {
    const parts = linkParts(href)
    if (!parts)
      return
    linkPaths.add(parts.path)
    linkHosts.add(parts.host)
  }
  for (const match of html.matchAll(HREF_RE))
    collectLink(match[1])
  if (post.card?.url)
    collectLink(post.card.url)

  return {
    // The content warning is part of the post's topic, so its tokens go in the
    // body bag *and* get their own small family below.
    tokens: tokenizeText(spoiler ? `${spoiler}\n${body}` : body),
    spoilerTokens: tokenizeText(spoiler),
    hashtags: [...hashtags],
    emoji: distinctEmoji(body),
    authorId: post.account?.id ?? '',
    language: post.language ?? null,
    mediaTypes: [...mediaTypes],
    linkPaths: [...linkPaths],
    linkHosts: [...linkHosts],
    fallbackKey: post.id ?? '',
  }
}

// #endregion

// #region embedding

interface SparseVector {
  indices: Int32Array
  values: Float64Array
}

/**
 * Inverse document frequency over a candidate set. `log(1 + n / (1 + df))`, so a
 * token in every post is worth a fraction of a token in one post, in whatever
 * language the feed happens to be in.
 */
export function computeTokenIdf(features: readonly CandidateFeatures[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const f of features) {
    for (const token of f.tokens)
      df.set(token, (df.get(token) ?? 0) + 1)
  }
  const n = features.length
  const idf = new Map<string, number>()
  for (const [token, count] of df)
    idf.set(token, Math.log(1 + n / (1 + count)))
  return idf
}

/**
 * Trim a post's token bag to {@link MAX_TOKENS}.
 *
 * With a corpus, keep the most distinctive tokens. Without one, sample at an
 * even stride across the whole bag — never the first N, which would make two
 * posts sharing 2900 of 2960 words look unrelated because their openings differ.
 */
function selectTokens(tokens: string[], idf?: ReadonlyMap<string, number>): string[] {
  if (tokens.length <= MAX_TOKENS)
    return tokens

  if (idf) {
    return [...tokens]
      .sort((a, b) => ((idf.get(b) ?? 0) - (idf.get(a) ?? 0)) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_TOKENS)
  }

  const stride = tokens.length / MAX_TOKENS
  const picked: string[] = []
  for (let i = 0; i < MAX_TOKENS; i++)
    picked.push(tokens[Math.floor(i * stride)])
  return picked
}

/**
 * Hash a post's features into a sparse unit vector.
 *
 * Uses the hashing trick with sign hashing (Weinberger et al.): a second,
 * independent hash decides the sign so collisions cancel in expectation instead
 * of piling up.
 */
function sparseEmbed(
  features: CandidateFeatures,
  idf?: ReadonlyMap<string, number>,
): SparseVector {
  const acc = new Map<number, number>()

  const add = (key: string, weight: number) => {
    if (weight === 0)
      return
    const bucket = hashString(key, HASH_SEED_BUCKET) % EMBEDDING_DIM
    const sign = (hashString(key, HASH_SEED_SIGN) & 1) === 0 ? 1 : -1
    acc.set(bucket, (acc.get(bucket) ?? 0) + sign * weight)
  }

  /** L2-normalise a family internally, then scale it to `familyWeight`. */
  const addFamily = (prefix: string, keys: string[], familyWeight: number, weights?: number[]) => {
    if (keys.length === 0 || familyWeight === 0)
      return
    let norm = 0
    for (let i = 0; i < keys.length; i++) {
      const w = weights ? weights[i] : 1
      norm += w * w
    }
    if (norm <= EPSILON)
      return
    const scale = familyWeight / Math.sqrt(norm)
    for (let i = 0; i < keys.length; i++)
      add(prefix + keys[i], (weights ? weights[i] : 1) * scale)
  }

  if (features.authorId)
    add(`a:${features.authorId}`, WEIGHT_AUTHOR)
  if (features.language)
    add(`l:${features.language.toLowerCase()}`, WEIGHT_LANGUAGE)

  addFamily('h:', features.hashtags, WEIGHT_TAGS)
  addFamily('m:', features.mediaTypes, WEIGHT_MEDIA)
  addFamily('e:', features.emoji, WEIGHT_EMOJI)
  addFamily('c:', selectTokens(features.spoilerTokens, idf), WEIGHT_SPOILER)
  addFamily('u:', features.linkPaths, WEIGHT_LINK * LINK_PATH_SHARE)
  addFamily('d:', features.linkHosts, WEIGHT_LINK * LINK_HOST_SHARE)

  const tokens = selectTokens(features.tokens, idf)
  addFamily('t:', tokens, WEIGHT_TOKENS, idf ? tokens.map(t => idf.get(t) ?? 1) : undefined)

  if (acc.size === 0) {
    // vm-ranker hands a *random* unit vector to candidates whose embedding is
    // missing, so they neither attract nor repel. Same idea, but seeded off the
    // post id so the feed is deterministic across loads.
    const seed = features.fallbackKey || 'empty'
    for (let i = 0; i < 4; i++)
      add(`z:${i}:${seed}`, 1)
  }

  let norm = 0
  for (const value of acc.values())
    norm += value * value
  const inv = norm > EPSILON ? 1 / Math.sqrt(norm) : 0

  const indices = new Int32Array(acc.size)
  const values = new Float64Array(acc.size)
  let cursor = 0
  for (const [bucket, value] of acc) {
    indices[cursor] = bucket
    values[cursor] = value * inv
    cursor++
  }
  return { indices, values }
}

function densify(sparse: SparseVector): Float64Array {
  const dense = new Float64Array(EMBEDDING_DIM)
  for (let i = 0; i < sparse.indices.length; i++)
    dense[sparse.indices[i]] = sparse.values[i]
  return dense
}

/**
 * Turn extracted features into a unit-norm hashed feature vector. Pure — no
 * Nuxt, no HTML, no `masto` types — so the vector maths can be tested directly.
 */
export function embedFeatures(
  features: CandidateFeatures,
  idf?: ReadonlyMap<string, number>,
): Float64Array {
  return densify(sparseEmbed(features, idf))
}

/**
 * A cheap content embedding for one candidate: hashed hashtags, tokens, links,
 * emoji, author, language and media kinds, L2-normalised.
 *
 * X uses learned CLIP/Phoenix embeddings here; this is the closest thing that
 * can be computed in the browser from what the Mastodon API already returned.
 *
 * This is the corpus-free form — every token weighs the same, because there is
 * no candidate set to measure ubiquity against. Prefer {@link embedCandidates}
 * for a feed: it down-weights tokens that appear everywhere, which is what makes
 * the similarity language-neutral.
 */
export function embedCandidate(candidate: PostCandidate): Float64Array {
  return embedFeatures(extractCandidateFeatures(candidate.status))
}

/**
 * Embed a whole candidate set, with inverse document frequency measured over
 * that set. This is what {@link diversityRerank} uses internally.
 */
export function embedCandidates(candidates: readonly PostCandidate[]): Float64Array[] {
  const features = candidates.map(c => extractCandidateFeatures(c.status))
  const idf = computeTokenIdf(features)
  return features.map(f => embedFeatures(f, idf))
}

/** Cosine similarity, in [-1, 1]. Returns 0 if either vector is degenerate. */
export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom <= EPSILON)
    return 0
  return dot / denom
}

// #endregion

// #region conversation dedup

function candidateScore(candidate: PostCandidate): number {
  return candidate.score ?? candidate.rawScore ?? 0
}

/**
 * Identity of the post itself. A reblog *is* its original, so two people
 * boosting the same post collapse to one candidate — the same thing
 * `get_original_tweet_id` does in home-mixer.
 */
function statusIdentity(status: mastodon.v1.Status): string {
  return status.reblog?.id ?? status.id
}

/**
 * Union-find over `inReplyToId`. home-mixer gets the whole ancestor chain from
 * its hydration layer and uses `min(ancestors)`; a Mastodon client only ever
 * sees the direct parent, so we stitch the branches back together transitively.
 * Two replies to the same (absent) parent still land in the same conversation,
 * which is the case the filter mostly exists for.
 */
class ConversationSets {
  private parent = new Map<string, string>()

  find(id: string): string {
    let root = id
    let next = this.parent.get(root)
    while (next !== undefined && next !== root) {
      root = next
      next = this.parent.get(root)
    }
    // Path compression.
    let cursor = id
    while (cursor !== root) {
      const up = this.parent.get(cursor) ?? root
      this.parent.set(cursor, root)
      cursor = up
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb)
      return
    // Deterministic representative, independent of insertion order.
    if (ra < rb)
      this.parent.set(rb, ra)
    else
      this.parent.set(ra, rb)
  }
}

/**
 * How many branches of one conversation may survive.
 *
 * home-mixer keeps exactly one, but on X replies are rarely For You candidates.
 * On Mastodon they are the substance: keeping one branch removed 55% of a
 * realistic 300-post feed, collapsing an eight-person conversation to a single
 * post. Three keeps the loudest branches of a thread without letting one
 * conversation own the feed.
 */
export const DEFAULT_MAX_PER_CONVERSATION = 3

export interface DedupeConversationsOptions {
  /** Branches kept per conversation. Defaults to {@link DEFAULT_MAX_PER_CONVERSATION}. */
  maxPerConversation?: number
}

/**
 * Cap how many posts from the same conversation reach the feed — home-mixer's
 * `DedupConversationFilter`, widened from "keep one" to "keep the best N".
 *
 * Runs in two stages, mirroring home-mixer having both a
 * `RetweetDeduplicationFilter` and a `DedupConversationFilter`:
 *
 * 1. **Identical posts always collapse to one.** Two people boosting the same
 *    post, or a boost sitting next to the post it boosts, are the same content
 *    twice — the cap must never let three copies of one post through.
 * 2. **Distinct posts in one conversation are capped.** Three *different*
 *    replies in a thread are three different posts, and on Mastodon that is the
 *    substance of the feed rather than noise.
 *
 * The highest-scoring branches win and ties keep the earlier input. Survivors
 * are emitted into the input positions their conversation already occupied, in
 * score order, so a score-ordered input comes back score-ordered. (For an
 * arbitrarily ordered input, positions are preserved but the global order is
 * whatever the caller supplied — this function does not sort.)
 */
export function dedupeConversations(
  candidates: PostCandidate[],
  opts: DedupeConversationsOptions = {},
): PostCandidate[] {
  const maxPerConversation = Math.max(1, opts.maxPerConversation ?? DEFAULT_MAX_PER_CONVERSATION)
  if (candidates.length < 2)
    return [...candidates]

  const sets = new ConversationSets()
  const ids: string[] = Array.from({ length: candidates.length })

  for (let i = 0; i < candidates.length; i++) {
    const status = candidates[i].status
    const id = statusIdentity(status)
    ids[i] = id
    const parentId = status.reblog?.inReplyToId ?? status.inReplyToId
    if (parentId)
      sets.union(id, parentId)
  }

  // Stage 1: collapse candidates that are the same underlying post. The winner
  // is the best-scoring one; it occupies the earliest slot that post held.
  const slotByIdentity = new Map<string, number>()
  /** Winning candidate per surviving slot. */
  const winnerBySlot = new Map<number, PostCandidate>()
  for (let i = 0; i < candidates.length; i++) {
    const slot = slotByIdentity.get(ids[i])
    if (slot === undefined) {
      slotByIdentity.set(ids[i], i)
      winnerBySlot.set(i, candidates[i])
    }
    else if (candidateScore(candidates[i]) > candidateScore(winnerBySlot.get(slot)!)) {
      winnerBySlot.set(slot, candidates[i])
    }
  }
  const unique = [...slotByIdentity.values()].sort((a, b) => a - b)

  // Stage 2: group the surviving distinct posts by conversation, in input order.
  const groups = new Map<string, number[]>()
  for (const i of unique) {
    const root = sets.find(ids[i])
    const members = groups.get(root)
    if (members)
      members.push(i)
    else
      groups.set(root, [i])
  }

  // Each conversation keeps its first `maxPerConversation` slots, filled with
  // its best branches in score order.
  const at = (slot: number) => winnerBySlot.get(slot)!
  const assigned = new Map<number, PostCandidate>()
  for (const members of groups.values()) {
    if (members.length <= maxPerConversation) {
      for (const slot of members)
        assigned.set(slot, at(slot))
      continue
    }
    const winners = [...members]
      .sort((a, b) => (candidateScore(at(b)) - candidateScore(at(a))) || (a - b))
      .slice(0, maxPerConversation)
    const slots = members.slice(0, maxPerConversation)
    for (let i = 0; i < slots.length; i++)
      assigned.set(slots[i], at(winners[i]))
  }

  const kept: PostCandidate[] = []
  for (let i = 0; i < candidates.length; i++) {
    const winner = assigned.get(i)
    if (winner)
      kept.push(winner)
  }
  return kept
}

// #endregion

// #region rerank

/**
 * How similarity to the already-placed posts enters the objective.
 *
 * - `dpp` (default) — vm-ranker's greedy DPP objective in closed form. See
 *   {@link diversityRerank} for the derivation. Has no `lambda`.
 * - `residual` — a linearised stand-in, `q_i - lambda * R_i`.
 * - `max` — the textbook MMR, `q_i - lambda * max_j cos(i, j)`.
 *
 * `max` is kept only because it is worth being able to demonstrate that it does
 * not work: it saturates. Once one post by an author is placed, every other post
 * by that author takes the *same* penalty from then on, so they re-cluster
 * immediately below it. Sweeping lambda from 0.05 to 3 on a deliberately
 * clustered feed never got same-author adjacencies in the top 20 below 10 of 19.
 * The real DPP does not have this problem because its conditional variance keeps
 * shrinking with every similar item selected.
 */
export type DiversityPenalty = 'dpp' | 'residual' | 'max'

export interface DiversityRerankOptions {
  /** Objective form. Defaults to `dpp`. */
  penalty?: DiversityPenalty
  /**
   * vm-ranker's `dpp_theta`, in [0, 1). Only used by the `dpp` objective, where
   * the quality coefficient is `theta / (1 - theta)`. Defaults to
   * {@link DEFAULT_DIVERSITY_THETA}.
   */
  theta?: number
  /**
   * Penalty weight for the `residual` and `max` objectives. Ignored by `dpp`.
   * `0` degenerates any objective to a pure score sort.
   */
  lambda?: number
  /**
   * How many positions to actively place — vm-ranker's `top_k`. The rest of the
   * pool keeps its score order. Defaults to {@link DEFAULT_DIVERSITY_LIMIT}.
   *
   * This bound is not cosmetic: the DPP penalty accumulates, so past roughly the
   * first 60 placements it dominates the quality term and the feed would be
   * ordered by "least similar to everything above it" rather than by score,
   * discarding the entire upstream ranking pipeline.
   */
  limit?: number
  /**
   * vm-ranker's `max_selected_rank`: only the top N by score are eligible to be
   * reordered. Anything below keeps its score order.
   */
  poolSize?: number
  /**
   * Precomputed embeddings, aligned index-for-index with `candidates`. Must be
   * {@link EMBEDDING_DIM} wide; anything else is ignored in favour of embedding
   * the pool here, rather than reading out of bounds.
   */
  embeddings?: ReadonlyArray<ArrayLike<number>>
  /** Override how a candidate's score is read. */
  getScore?: (candidate: PostCandidate) => number
}

/**
 * Compressed sparse rows over the pool's embeddings. A vector has tens of
 * nonzero dims out of {@link EMBEDDING_DIM}, so a scatter/gather dot product is
 * two orders of magnitude cheaper than a dense one — which is what lets the
 * dimension be large enough to keep collision noise below the real signal.
 */
interface SparseMatrix {
  offsets: Int32Array
  indices: Int32Array
  values: Float64Array
}

function toCsr(vectors: readonly SparseVector[]): SparseMatrix {
  const n = vectors.length
  const offsets = new Int32Array(n + 1)
  let nnz = 0
  for (let i = 0; i < n; i++) {
    nnz += vectors[i].indices.length
    offsets[i + 1] = nnz
  }

  const indices = new Int32Array(nnz)
  const values = new Float64Array(nnz)
  let cursor = 0
  for (const vector of vectors) {
    for (let i = 0; i < vector.indices.length; i++) {
      indices[cursor] = vector.indices[i]
      values[cursor] = vector.values[i]
      cursor++
    }
  }
  return { offsets, indices, values }
}

function sparsifyDense(dense: ArrayLike<number>): SparseVector {
  let nnz = 0
  for (let d = 0; d < dense.length; d++) {
    if (dense[d] !== 0)
      nnz++
  }
  const indices = new Int32Array(nnz)
  const values = new Float64Array(nnz)
  let cursor = 0
  for (let d = 0; d < dense.length; d++) {
    if (dense[d] !== 0) {
      indices[cursor] = d
      values[cursor] = dense[d]
      cursor++
    }
  }
  return { indices, values }
}

/**
 * Greedy DPP diversity reorder.
 *
 * ## The objective
 *
 * vm-ranker's greedy step maximises the conditional variance
 * `cv_i = L_ii - sum_{j in S} f_ji^2`. Under the approximation that the placed
 * items are mutually orthogonal, the Cholesky factors collapse to
 * `f_ji = qf_i * cos(i, j)`, so
 *
 * ```
 * cv_i = qf_i^2 - sum_j qf_i^2 cos(i, j)^2 = qf_i^2 * (1 - R_i)
 * ```
 *
 * where `R_i = sum_{j in S} cos(i, j)^2`. The relationship is *multiplicative*,
 * so taking logs — which is monotone, and therefore leaves the argmax alone —
 * gives an additive objective with no free parameter:
 *
 * ```
 * log cv_i = 2 * alpha * q_i + log(1 - R_i) = (theta / (1 - theta)) * q_i + log(1 - R_i)
 * ```
 *
 * with `q_i = score_i / max_score` exactly as vm-ranker normalises it. At the
 * default `theta = 0.5` the quality coefficient is 1. The penalty is a log, so
 * it diverges as a candidate's neighbourhood fills up rather than trading
 * linearly — and it needs no `lambda`, because the source already fixed the
 * trade-off via `theta`.
 *
 * `R` uses the raw cosine squared, so anti-correlation penalises here exactly as
 * it does in the kernel.
 *
 * ### The one place the sum has to become a product
 *
 * `1 - sum_j cos^2` goes negative as soon as two placed posts are near
 * duplicates of a candidate, and vm-ranker's answer is to stop: `cv <= EPSILON`
 * is "rank exhausted", and everything left is dropped. We cannot stop, because
 * we are ordering the whole pool rather than selecting part of it, and clamping
 * the log at a floor reproduces exactly the saturation that makes plain MMR
 * useless — every duplicate pinned at the same floor, re-clustering by score
 * underneath the first one.
 *
 * So the sum is evaluated as the product it approximates:
 *
 * ```
 * penalty_i = -sum_{j in S} log(1 - cos(i, j)^2)
 * ```
 *
 * To first order in `cos^2` this *is* `-log(1 - R_i)` — the two agree wherever
 * the orthogonality approximation is valid — but every factor lies in `(0, 1]`,
 * so the penalty grows without bound instead of hitting a floor, and the tenth
 * near-duplicate is ranked strictly below the second. Still additive, still
 * O(n * k), still parameter-free.
 *
 * ## Differences from vm-ranker
 *
 * - It reorders; vm-ranker truncates to `top_k` and drops the rest.
 * - The orthogonality approximation replaces the incremental Cholesky, which
 *   takes the loop from O(n * k^2) to O(n * k).
 * - Embeddings are hashed bags of features, not learned CLIP/Phoenix vectors.
 *
 * Scores are left untouched; the result is a permutation of the input.
 */
export function diversityRerank(
  candidates: PostCandidate[],
  opts: DiversityRerankOptions = {},
): PostCandidate[] {
  const n = candidates.length
  if (n < 2)
    return [...candidates]

  const mode = opts.penalty ?? 'dpp'
  const lambda = opts.lambda ?? DEFAULT_DIVERSITY_LAMBDA
  const theta = Math.min(Math.max(opts.theta ?? DEFAULT_DIVERSITY_THETA, 0), 1 - 1e-6)
  const qCoefficient = theta / (1 - theta)
  const getScore = opts.getScore ?? candidateScore
  const poolSize = Math.max(0, Math.min(n, opts.poolSize ?? DEFAULT_DIVERSITY_POOL_SIZE))

  const scores = new Float64Array(n)
  for (let i = 0; i < n; i++)
    scores[i] = getScore(candidates[i])

  // Stable score-descending order over the original indices.
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => (scores[b] - scores[a]) || (a - b))

  const pool = order.slice(0, poolSize)
  const overflow = order.slice(poolSize)
  const m = pool.length

  const inert = mode !== 'dpp' && lambda <= 0
  if (m < 2 || inert)
    return [...pool, ...overflow].map(i => candidates[i])

  // `q_i = score_i / max_score`, as vm-ranker normalises. If the scorer emitted
  // nothing positive, that ratio is meaningless, so fall back to min-max.
  let min = Infinity
  let max = -Infinity
  for (const i of pool) {
    const s = scores[i]
    if (s < min)
      min = s
    if (s > max)
      max = s
  }
  const q = new Float64Array(m)
  if (max > EPSILON) {
    for (let p = 0; p < m; p++)
      q[p] = scores[pool[p]] / max
  }
  else {
    const span = max - min
    for (let p = 0; p < m; p++)
      q[p] = span > EPSILON ? (scores[pool[p]] - min) / span : 0.5
  }

  // Precomputed embeddings are only usable at exactly the right width —
  // anything else would scatter out of bounds and poison every penalty.
  const provided = opts.embeddings
  const usableProvided = provided !== undefined
    && pool.every(i => provided[i]?.length === EMBEDDING_DIM)

  let vectors: SparseVector[]
  if (usableProvided) {
    vectors = pool.map(i => sparsifyDense(provided![i]))
  }
  else {
    const features = pool.map(i => extractCandidateFeatures(candidates[i].status))
    const idf = computeTokenIdf(features)
    vectors = features.map(f => sparseEmbed(f, idf))
  }
  const { offsets, indices, values } = toCsr(vectors)

  const limit = Math.max(0, Math.min(m, opts.limit ?? DEFAULT_DIVERSITY_LIMIT))
  const taken = new Uint8Array(m)
  const penalty = new Float64Array(m)
  const scratch = new Float64Array(EMBEDDING_DIM)
  const placed: number[] = []

  for (let step = 0; step < limit; step++) {
    let best = -1
    let bestValue = -Infinity
    for (let p = 0; p < m; p++) {
      if (taken[p])
        continue
      // `penalty` already holds `-sum log(1 - cos^2)` for `dpp`, and the raw
      // linear aggregate for the other two.
      const value = mode === 'dpp'
        ? qCoefficient * q[p] - penalty[p]
        : q[p] - lambda * penalty[p]
      if (value > bestValue) {
        bestValue = value
        best = p
      }
    }
    if (best < 0)
      break

    taken[best] = 1
    placed.push(pool[best])

    if (placed.length === limit)
      break

    // Scatter the freshly placed vector, then fold it into every remaining
    // candidate's running penalty. O(nnz) per candidate — and because the
    // embeddings are unit-norm, the dot product *is* the cosine.
    const bStart = offsets[best]
    const bEnd = offsets[best + 1]
    if (bEnd > bStart) {
      for (let t = bStart; t < bEnd; t++)
        scratch[indices[t]] = values[t]

      for (let p = 0; p < m; p++) {
        if (taken[p])
          continue
        let dot = 0
        const end = offsets[p + 1]
        for (let t = offsets[p]; t < end; t++)
          dot += scratch[indices[t]] * values[t]

        // Squared, so anti-correlation penalises too — as it does in `cv`.
        const squared = dot * dot
        if (mode === 'dpp')
          penalty[p] -= Math.log(Math.max(1 - squared, MIN_RESIDUAL))
        else if (mode === 'residual')
          penalty[p] += squared
        else if (dot > penalty[p])
          penalty[p] = dot
      }

      for (let t = bStart; t < bEnd; t++)
        scratch[indices[t]] = 0
    }
  }

  // Whatever the loop did not place keeps its score order.
  const rest: number[] = []
  for (let p = 0; p < m; p++) {
    if (!taken[p])
      rest.push(pool[p])
  }

  return [...placed, ...rest, ...overflow].map(i => candidates[i])
}

// #endregion
