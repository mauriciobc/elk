import type { mastodon } from 'masto'

/**
 * Where a candidate entered the pipeline. Mirrors the candidate sources in
 * xai-org/x-algorithm (`thunder` = in-network recency, `phoenix` = embedding
 * retrieval, `simclusters` = engagement-cluster retrieval), mapped onto the
 * timelines the Mastodon API actually exposes.
 */
export type CandidateSource
  = | 'home' // in-network: accounts the viewer follows
    | 'list' // in-network: hand-curated list timelines. Highest precision we have — X has no equivalent.
    | 'federated' // out-of-network: the instance's view of the fediverse
    | 'local' // out-of-network: the viewer's own instance
    | 'tag' // out-of-network: tags the viewer follows or engages with
    | 'trending' // out-of-network: what the instance is surfacing
    /**
     * Out-of-network, but only one hop past the follow graph — the accounts the
     * viewer's follows follow. This is the `tweet_mixer` analog and the highest-
     * precision OON reach available on the fediverse, so it earns a gentler
     * out-of-network discount than `federated` or `trending`.
     */
    | 'network2hop'

/** The actions the ranker predicts a probability for, per `phoenix` ranking. */
export interface ActionProbabilities {
  favorite: number
  reply: number
  retweet: number
  quote: number
  share: number
  click: number
  openLink: number
  profileClick: number
  photoExpand: number
  videoOpen: number
  vqv: number
  dwell: number
  followAuthor: number
  /** Negative actions — these carry negative weights. */
  notInterested: number
  muteAuthor: number
  blockAuthor: number
  report: number
  notDwelled: number
}

/** A post travelling through the pipeline, accumulating scores as it goes. */
export interface PostCandidate {
  status: mastodon.v1.Status
  /** All sources that produced this candidate (a post can come from several). */
  sources: Set<CandidateSource>
  /** True when the author is followed by the viewer. */
  inNetwork: boolean
  /** Populated by the scorer. */
  probabilities?: ActionProbabilities
  /** Weighted sum of probabilities, before the post-scoring adjustments. */
  rawScore?: number
  /** Final score after diversity decay, OON discount and new-author boost. */
  score?: number
  /** Human-readable trace of how the score was reached, for the debug panel. */
  reasons?: ScoreReason[]
}

export interface ScoreReason {
  label: string
  value: number
}

/**
 * The viewer's own engagement history. This is the only personalization signal
 * Mastodon gives us — there is no global cross-user engagement graph — so the
 * ranker leans on it far harder than Phoenix leans on any single feature.
 */
export interface ForYouSignals {
  /** accountId -> affinity weight, decayed over time. */
  authorAffinity: Record<string, number>
  /** lowercased tag -> affinity weight. */
  tagAffinity: Record<string, number>
  /** language code -> affinity weight. */
  languageAffinity: Record<string, number>
  /** Post ids already shown to the viewer (PreviouslySeenPostsFilter). */
  seen: string[]
  /** Post ids the viewer explicitly dismissed. */
  notInterested: string[]
  /** accountIds the viewer explicitly dismissed. */
  mutedForYou: string[]
  /** Last time affinities were decayed, epoch ms. */
  lastDecay: number
}

export const EMPTY_SIGNALS: ForYouSignals = {
  authorAffinity: {},
  tagAffinity: {},
  languageAffinity: {},
  seen: [],
  notInterested: [],
  mutedForYou: [],
  lastDecay: 0,
}
