<script setup lang="ts">
import type { mastodon } from 'masto'

const { card, status } = defineProps<{
  card: mastodon.v1.PreviewCard
  /** For the preview image, only the small image mode is displayed */
  smallPictureOnly?: boolean
  /** When it is root card in the list, not appear as a child card */
  root?: boolean
  /**
   * The post this card belongs to, when the caller has it. Only used to record
   * the `openLink` engagement — the card renders identically without it.
   */
  status?: mastodon.v1.Status
}>()

const providerName = card.providerName

const gitHubCards = usePreferences('experimentalGitHubCards')

/**
 * `openLink` — the click family's link head (`ForYouEngagementKind`).
 *
 * Recorded here rather than in each of the three card variants so every one of
 * them is covered by construction: the handler goes on the variant *tags*
 * below, one level of attribute fallthrough onto whichever root each renders.
 *
 * Fires app-wide, like every other `recordEngagement` call — `signals.ts`'s
 * population gate is what restricts the *counter* to posts For You actually put
 * on screen. See `base-rates.ts` for why that gate is the whole measurement.
 */
function recordLinkOpen() {
  recordEngagement(status, 'openLink')
}
</script>

<template>
  <LazyStatusPreviewGitHub v-if="gitHubCards && providerName === 'GitHub'" :card="card" @click="recordLinkOpen" />
  <LazyStatusPreviewStackBlitz v-else-if="gitHubCards && providerName === 'StackBlitz'" :card="card" :small-picture-only="smallPictureOnly" :root="root" @click="recordLinkOpen" />
  <StatusPreviewCardNormal v-else :card="card" :small-picture-only="smallPictureOnly" :root="root" @click="recordLinkOpen" />
</template>
