import type { mastodon } from 'masto'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import StatusAttachment from '../../app/components/status/StatusAttachment.vue'
import StatusPreviewCard from '../../app/components/status/StatusPreviewCard.vue'

/**
 * The click family's writers (`openLink`, `photoExpand`, `videoOpen`).
 *
 * These heads sat at `k = 0` for the whole life of the feature — not because
 * anything was wrong with the estimator, but because nothing called
 * `recordEngagement` for them (see `HeadClass`'s `unwired` variant in
 * `base-rates.ts`). A writer that silently does not fire puts the head right
 * back in that state while *looking* wired, so these mount the real components
 * and drive a real DOM click rather than asserting on the handler in isolation.
 *
 * That matters most for `openLink`: the handler is attached to the card
 * **variant** tags inside `StatusPreviewCard`, so it only reaches the anchor
 * through Vue's attribute fallthrough. Inspection cannot tell you whether that
 * lands; a click can.
 */

// The i18n plugin does not install itself in this mounting environment (same
// reason as `timeline-for-you-item.test.ts`); nothing here reads translated
// text.
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

const { recordEngagementMock, openMediaPreviewMock } = vi.hoisted(() => ({
  recordEngagementMock: vi.fn(),
  openMediaPreviewMock: vi.fn(),
}))
// `enableAutoplay` ships **off**, so the observer's autoplay branch would never
// run and the suppression test below would pass vacuously. Turn exactly that one
// preference on; everything else keeps its shipped default, which matters for
// `experimentalGitHubCards` — the preview-card tests need the plain variant.
mockNuxtImport('usePreferences', () => (name: string) => ref(name === 'enableAutoplay'))
mockNuxtImport('recordEngagement', () => recordEngagementMock)
mockNuxtImport('openMediaPreview', () => openMediaPreviewMock)

/**
 * Captures the callback VueUse's `useIntersectionObserver` registers, so a test
 * can drive it. `@nuxt/test-utils`' own IntersectionObserver mock never invokes
 * the callback on its own. Same shape as `timeline-for-you-item.test.ts`.
 */
class CapturingIntersectionObserver {
  static instances: CapturingIntersectionObserver[] = []
  callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    CapturingIntersectionObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  emit(entry: Partial<IntersectionObserverEntry>) {
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

vi.stubGlobal('IntersectionObserver', CapturingIntersectionObserver)

const status = { id: 's1', account: { id: 'a1' } } as unknown as mastodon.v1.Status

function card(): mastodon.v1.PreviewCard {
  return {
    url: 'https://example.com/article',
    title: 'An article',
    description: '',
    type: 'link',
    providerName: 'Example',
  } as unknown as mastodon.v1.PreviewCard
}

function attachment(type: string, url = `https://example.com/media.${type}`): mastodon.v1.MediaAttachment {
  return { id: 'm1', type, url, previewUrl: url } as unknown as mastodon.v1.MediaAttachment
}

beforeEach(() => {
  recordEngagementMock.mockClear()
  openMediaPreviewMock.mockClear()
})

describe('openLink writer', () => {
  it('records openLink when the preview card is clicked, through the variant fallthrough', async () => {
    const wrapper = await mountSuspended(StatusPreviewCard, {
      props: { card: card(), status },
    })

    await wrapper.find('a').trigger('click')

    expect(recordEngagementMock).toHaveBeenCalledWith(status, 'openLink')
  })

  it('does not throw when no status is supplied — the card renders outside a timeline too', async () => {
    const wrapper = await mountSuspended(StatusPreviewCard, { props: { card: card() } })

    await wrapper.find('a').trigger('click')

    expect(recordEngagementMock).toHaveBeenCalledWith(undefined, 'openLink')
  })
})

describe('photoExpand / videoOpen writers', () => {
  // `isPreview` forces `shouldLoadAttachment`, so the click opens the viewer
  // rather than being consumed by the data-saving reveal.
  async function mountAttachment(type: string) {
    return mountSuspended(StatusAttachment, {
      props: { attachment: attachment(type), status, isPreview: true },
    })
  }

  it('records photoExpand when an image is opened', async () => {
    const wrapper = await mountAttachment('image')
    await wrapper.find('button').trigger('click')

    expect(recordEngagementMock).toHaveBeenCalledWith(status, 'photoExpand')
    expect(openMediaPreviewMock).toHaveBeenCalled()
  })

  it('records videoOpen for a gifv, which the ranker also reads as a video', async () => {
    const wrapper = await mountAttachment('gifv')
    await wrapper.find('button').trigger('click')

    expect(recordEngagementMock).toHaveBeenCalledWith(status, 'videoOpen')
  })

  // The `video` branch counts playback, not taps. Its button also absorbs
  // pause, seek, volume and fullscreen, so a tap says nothing about whether
  // the viewer started watching — and the observer autoplays, so the raw
  // `play` event says nothing either until autoplay is excluded.
  it('records videoOpen when the viewer starts playback', async () => {
    const wrapper = await mountAttachment('video')
    await wrapper.find('video').trigger('play')

    expect(recordEngagementMock).toHaveBeenCalledWith(status, 'videoOpen')
    // A video plays inline with its own controls; there is no viewer to open.
    expect(openMediaPreviewMock).not.toHaveBeenCalled()
  })

  it('does not record a tap on the video — that is as likely to be a pause', async () => {
    const wrapper = await mountAttachment('video')
    await wrapper.find('button').trigger('click')

    expect(recordEngagementMock).not.toHaveBeenCalled()
  })

  it('does not record playback the intersection observer started', async () => {
    // The real autoplay path, driven end to end: the observer calls `play()`
    // on the element, and the browser emits `play` while that promise is still
    // pending. `HTMLMediaElement.play` does not exist in this environment, so
    // the stub below stands in for it and emits `play` at exactly that moment
    // — the window `autoplaying` has to cover.
    CapturingIntersectionObserver.instances = []
    const wrapper = await mountAttachment('video')

    const el = wrapper.find('video').element as HTMLVideoElement
    let resolvePlay: (() => void) | undefined
    let playCalls = 0
    el.play = () => {
      playCalls++
      el.dispatchEvent(new Event('play'))
      return new Promise<void>((resolve) => {
        resolvePlay = resolve
      })
    }

    const observer = CapturingIntersectionObserver.instances.at(-1)
    if (!observer)
      throw new Error('useIntersectionObserver never constructed an IntersectionObserver')
    observer.emit({ isIntersecting: true, intersectionRatio: 1 })

    // The stub must actually have run, or this test proves nothing.
    expect(playCalls).toBe(1)
    expect(recordEngagementMock).not.toHaveBeenCalled()

    // Once autoplay settles, a play the viewer causes counts again. The flag is
    // cleared in a `.finally` several microtasks down the chain, so yield a
    // full macrotask rather than guessing at a number of ticks.
    resolvePlay!()
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    await wrapper.find('video').trigger('play')
    expect(recordEngagementMock).toHaveBeenCalledWith(status, 'videoOpen')
  })

  it('records nothing for audio, which has no head', async () => {
    const wrapper = await mountAttachment('audio')
    const button = wrapper.find('button')
    if (button.exists())
      await button.trigger('click')

    expect(recordEngagementMock).not.toHaveBeenCalled()
  })

  it('records nothing without a status — the edit-history viewer passes a StatusEdit, which has no id', async () => {
    const wrapper = await mountSuspended(StatusAttachment, {
      props: { attachment: attachment('image'), isPreview: true },
    })
    await wrapper.find('button').trigger('click')

    expect(recordEngagementMock).not.toHaveBeenCalled()
    // The viewer still opens: the missing status suppresses the measurement,
    // never the behaviour.
    expect(openMediaPreviewMock).toHaveBeenCalled()
  })
})
