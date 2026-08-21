<script setup lang="ts">
import type { mastodon } from 'masto'
import { clamp } from '@vueuse/core'
import { decode } from 'blurhash'

const {
  attachment,
  attachments,
  fullSize = false,
  isPreview = false,
  status,
} = defineProps<{
  attachment: mastodon.v1.MediaAttachment
  attachments?: mastodon.v1.MediaAttachment[]
  fullSize?: boolean
  isPreview?: boolean
  /**
   * The post this attachment belongs to, when the caller has it. Only used to
   * record `photoExpand`/`videoOpen`; the attachment renders identically
   * without it. Typed as widely as `StatusMedia`'s own prop, which also serves
   * the edit-history viewer — a `StatusEdit` has no `id`, so it cannot be the
   * subject of an engagement and is filtered out below.
   */
  status?: mastodon.v1.Status | mastodon.v1.StatusEdit
}>()

const src = computed(() => attachment.previewUrl || attachment.url || attachment.remoteUrl!)
const srcset = computed(() => [
  [attachment.url, attachment.meta?.original?.width],
  [attachment.remoteUrl, attachment.meta?.original?.width],
  [attachment.previewUrl, attachment.meta?.small?.width],
].filter(([url]) => url).map(([url, size]) => `${url} ${size}w`).join(', '))

const rawAspectRatio = computed(() => {
  if (attachment.meta?.original?.aspect)
    return attachment.meta.original.aspect
  if (attachment.meta?.small?.aspect)
    return attachment.meta.small.aspect
  return undefined
})

const aspectRatio = computed(() => {
  if (fullSize)
    return rawAspectRatio.value
  if (rawAspectRatio.value)
    return clamp(rawAspectRatio.value, 0.8, 6)
  return undefined
})

const objectPosition = computed(() => {
  const focusX = attachment.meta?.focus?.x || 0
  const focusY = attachment.meta?.focus?.y || 0
  const x = ((focusX / 2) + 0.5) * 100
  const y = ((focusY / -2) + 0.5) * 100

  return `${x}% ${y}%`
})

const typeExtsMap = {
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'svg', 'webp', 'bmp'],
  gifv: ['gifv', 'gif'],
}

const type = computed(() => {
  if (attachment.type && attachment.type !== 'unknown')
    return attachment.type
  // some server returns unknown type, we need to guess it based on file extension
  for (const [type, exts] of Object.entries(typeExtsMap)) {
    if (exts.some(ext => src.value?.toLowerCase().endsWith(`.${ext}`)))
      return type
  }
  return 'unknown'
})

const video = ref<HTMLVideoElement | undefined>()
const prefersReducedMotion = usePreferredReducedMotion()
const isAudio = computed(() => attachment.type === 'audio')
const isVideo = computed(() => attachment.type === 'video')
const isGif = computed(() => attachment.type === 'gifv')

const enableAutoplay = usePreferences('enableAutoplay')
const unmuteVideos = usePreferences('unmuteVideos')

/**
 * True while the observer below is starting playback the viewer did not ask
 * for. Read by {@link onVideoPlay}, which must count a *chosen* play and not
 * an autoplayed one — see its docblock. Set before `play()` and cleared once
 * the promise settles; the element's `play` event fires when playback begins,
 * which is inside that window, so an autoplay is always covered.
 */
let autoplaying = false

useIntersectionObserver(video, (entries) => {
  const ready = video.value?.dataset.ready === 'true'
  if (prefersReducedMotion.value === 'reduce' || !enableAutoplay.value) {
    if (ready && !video.value?.paused)
      video.value?.pause()

    return
  }

  entries.forEach((entry) => {
    if (entry.intersectionRatio <= 0.75) {
      if (ready && !video.value?.paused)
        video.value?.pause()
    }
    else {
      autoplaying = true
      video.value?.play().then(() => {
        video.value!.dataset.ready = 'true'
      }).catch(noop).finally(() => {
        autoplaying = false
      })
    }
  })
}, { threshold: 0.75 })

const userSettings = useUserSettings()

const shouldLoadAttachment = ref(isPreview || !getPreferences(userSettings.value, 'enableDataSaving'))

function loadAttachment() {
  shouldLoadAttachment.value = true
}

/**
 * `photoExpand`/`videoOpen` — the click family's media heads
 * (`ForYouEngagementKind`).
 *
 * Keyed on the rendered {@link type}, not `attachment.type`, so a server that
 * reports `unknown` and gets classified by file extension is counted as
 * whatever the viewer actually saw. `gifv` counts as a video, matching how
 * `ranking.ts` reads the same attachment (`hasVideo`/`videoDurationMs` both
 * treat `gifv` as one) — the numerator has to classify media the same way the
 * features do. `audio` and a genuinely unresolvable `unknown` have no head and
 * are deliberately silent rather than folded into either.
 *
 * Fires app-wide, like every other `recordEngagement` call — `signals.ts`'s
 * population gate is what restricts the *counter* to posts For You actually
 * put on screen.
 */
function recordMediaOpen() {
  if (!status || !('id' in status))
    return
  if (type.value === 'image')
    recordEngagement(status, 'photoExpand')
  else if (type.value === 'video' || type.value === 'gifv')
    recordEngagement(status, 'videoOpen')
}

/**
 * What a tap on the attachment does: reveal it if data saving is holding it
 * back, otherwise open the viewer. Both call sites in the template used to
 * carry this as the same inline ternary; it is a named function now because
 * the "otherwise" branch also has to record the engagement.
 */
function openOrLoad() {
  if (!shouldLoadAttachment.value) {
    loadAttachment()
    return
  }
  recordMediaOpen()
  openMediaPreview(attachments ?? [attachment], attachments?.indexOf(attachment) || 0)
}

/**
 * The `video` branch never opens the media viewer — a video plays inline with
 * its own controls — so its `videoOpen` cannot ride on {@link openOrLoad}, and
 * a tap is the wrong event to hang it on either: the same button absorbs
 * pause, seek, volume and fullscreen, so counting taps counts four things that
 * are not "the viewer started a video".
 *
 * Playback beginning is the event that actually means the head. The reason not
 * to use it used to be autoplay — the observer above starts videos the viewer
 * never asked for, and counting those is exactly the correlated bias
 * `INTERCEPT.md` §3 is about — so {@link autoplaying} suppresses precisely
 * that case and nothing else. A viewer who pauses an autoplayed video and then
 * resumes it *has* chosen to watch, and that resume counts.
 */
function onVideoPlay() {
  if (!autoplaying)
    recordMediaOpen()
}

/** The data-saving reveal, for the `video` branch. Playback is counted by {@link onVideoPlay}. */
function tapVideo() {
  if (!shouldLoadAttachment.value)
    loadAttachment()
}

const blurHashSrc = computed(() => {
  if (!attachment.blurhash)
    return ''
  const pixels = decode(attachment.blurhash, 32, 32)
  return getDataUrlFromArr(pixels, 32, 32)
})

const videoThumbnail = ref(shouldLoadAttachment.value
  ? attachment.previewUrl
  : blurHashSrc.value)

watch(shouldLoadAttachment, () => {
  videoThumbnail.value = shouldLoadAttachment.value
    ? attachment.previewUrl
    : blurHashSrc.value
})
</script>

<template>
  <div relative ma flex :gap="isAudio ? '2' : ''">
    <template v-if="type === 'video'">
      <button
        type="button"
        relative
        @click="tapVideo"
      >
        <video
          ref="video"
          preload="none"
          :poster="videoThumbnail"
          :muted="!unmuteVideos"
          loop
          playsinline
          :controls="shouldLoadAttachment"
          rounded-lg
          object-cover
          fullscreen:object-contain
          :width="attachment.meta?.original?.width"
          :height="attachment.meta?.original?.height"
          :style="{
            aspectRatio,
            objectPosition,
          }"
          :class="!shouldLoadAttachment ? 'brightness-60 hover:brightness-70 transition-filter' : ''"
          @play="onVideoPlay"
        >
          <source :src="attachment.url || attachment.previewUrl" type="video/mp4">
        </video>
        <span
          v-if="!shouldLoadAttachment"
          class="status-attachment-load"
          absolute
          text-sm
          text-white
          flex flex-col justify-center items-center
          gap-3 w-6 h-6
          pointer-events-none
          i-ri:video-download-line
        />
      </button>
    </template>
    <template v-else-if="type === 'gifv'">
      <button
        type="button"
        relative
        @click="openOrLoad"
      >
        <video
          ref="video"
          preload="none"
          :poster="videoThumbnail"
          :muted="!unmuteVideos"
          loop
          playsinline
          rounded-lg
          object-cover
          :width="attachment.meta?.original?.width"
          :height="attachment.meta?.original?.height"
          :style="{
            aspectRatio,
            objectPosition,
          }"
        >
          <source :src="attachment.url || attachment.previewUrl" type="video/mp4">
        </video>
        <span
          v-if="!shouldLoadAttachment"
          class="status-attachment-load"
          absolute
          text-sm
          text-white
          flex flex-col justify-center items-center
          gap-3 w-6 h-6
          pointer-events-none
          i-ri:video-download-line
        />
      </button>
    </template>
    <template v-else-if="type === 'audio'">
      <audio controls h-15>
        <source :src="attachment.url || attachment.previewUrl" type="audio/mp3">
      </audio>
    </template>
    <template v-else>
      <button
        type="button"
        focus:outline-none
        focus:ring="2 primary inset"
        rounded-lg
        h-full
        w-full
        :aria-label="$t('action.open_image_preview_dialog')"
        relative
        @click="openOrLoad"
      >
        <CommonBlurhash
          :blurhash="attachment.blurhash || ''"
          class="status-attachment-image"
          :src="src"
          :srcset="srcset"
          :width="attachment.meta?.original?.width"
          :height="attachment.meta?.original?.height"
          :alt="attachment.description ?? 'Image'"
          :style="{
            aspectRatio,
            objectPosition,
          }"
          :should-load-image="shouldLoadAttachment"
          rounded-lg
          h-full
          w-full
          object-cover
          :draggable="shouldLoadAttachment"
          :class="!shouldLoadAttachment ? 'brightness-60 hover:brightness-70 transition-filter' : ''"
        />
        <span
          v-if="!shouldLoadAttachment"
          class="status-attachment-load"
          absolute
          text-sm
          text-white
          flex flex-col justify-center items-center
          gap-3 w-6 h-6
          pointer-events-none
          i-ri:file-download-line
        />
      </button>
    </template>
    <div
      :class="isAudio ? [] : [
        'absolute left-2',
        isVideo ? 'top-2' : 'bottom-2',
      ]"
      flex gap-col-2
    >
      <VDropdown v-if="attachment.description && !getPreferences(userSettings, 'hideAltIndicatorOnPosts')" :distance="6" placement="bottom-start">
        <button
          font-bold text-sm
          :class="isAudio
            ? 'rounded-full h-15 w-15 btn-outline border-base text-secondary hover:bg-active hover:text-active'
            : 'rounded-1 bg-black/65 text-white hover:bg-black px1.2 py0.2'"
        >
          <div hidden>
            {{ $t('status.img_alt.read', [attachment.type]) }}
          </div>
          {{ $t('status.img_alt.ALT') }}
        </button>
        <template #popper>
          <div p4 flex flex-col gap-2 max-w-130>
            <div flex justify-between>
              <h2 font-bold text-xl text-secondary>
                {{ $t('status.img_alt.desc') }}
              </h2>
              <button v-close-popper text-sm btn-outline py0 px2 text-secondary border-base>
                {{ $t('status.img_alt.dismiss') }}
              </button>
            </div>
            <p whitespace-pre-wrap>
              {{ attachment.description }}
            </p>
          </div>
        </template>
      </VDropdown>
      <div v-if="isGif && !getPreferences(userSettings, 'hideGifIndicatorOnPosts')">
        <button
          aria-hidden font-bold text-sm
          rounded-1 bg-black:65 text-white px1.2 py0.2 pointer-events-none
        >
          {{ $t('status.gif') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="postcss">
.status-attachment-load {
  left: 50%;
  top: 50%;
  translate: -50% -50%;
}
</style>
