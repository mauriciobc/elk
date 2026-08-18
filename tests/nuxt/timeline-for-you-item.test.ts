import type { mastodon } from 'masto'
import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import TimelineForYouItem from '../../app/components/timeline/TimelineForYouItem.vue'

// The Nuxt i18n module's plugin does not install itself in this mounting
// environment (same reason as `common-route-tabs.test.ts`); nothing under
// test here reads translated text.
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

// `mockComponent` (like `mockNuxtImport`, a compile-time macro) replaces
// `StatusCard`'s registration before `TimelineForYouItem.vue`'s own module
// graph ever loads, rather than swapping it out at mount/render time the way
// a VTU `stubs` option would — nothing under test here needs a real status
// card (the observer wiring on the `<article>` around it is what is under
// test), and a VTU-level stub still leaves the real `StatusCard` chain (its
// own real child components — `StatusReplyingTo`, `AccountInlineInfo`, and
// everything *they* import) as a static import of this file, which pulled in
// enough of the app's real, heavy component tree during development of this
// test to intermittently race a background chunk load against this test
// file's own teardown. Mocking here avoids ever loading that chain at all.
mockComponent('StatusCard', { template: '<div />' })

// `mockNuxtImport`'s factory is hoisted above this file's own top-level
// declarations (same rule as `vi.mock`), so the mocks it returns have to be
// created through `vi.hoisted` rather than closed-over `const`s.
const { markSeenMock, dwellEnter, dwellExit, dwellFlush } = vi.hoisted(() => ({
  markSeenMock: vi.fn(),
  dwellEnter: vi.fn(),
  dwellExit: vi.fn(),
  dwellFlush: vi.fn(),
}))
mockNuxtImport('markSeen', () => markSeenMock)
mockNuxtImport('createDwellTracker', () => () => ({
  enter: dwellEnter,
  exit: dwellExit,
  flush: dwellFlush,
  get visibleMs() {
    return 0
  },
}))

/**
 * Captures whatever callback/options `useIntersectionObserver` (VueUse)
 * registers on the real `IntersectionObserver` constructor, so the test can
 * drive it with synthetic entries — `@nuxt/test-utils`' own IntersectionObserver
 * mock (`vitest.config.ts`'s `intersectionObserver: true`) is a total no-op
 * that never invokes the callback on its own.
 */
class CapturingIntersectionObserver {
  static instances: CapturingIntersectionObserver[] = []
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  observed: Element[] = []
  disconnected = false

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    CapturingIntersectionObserver.instances.push(this)
  }

  observe(el: Element) {
    this.observed.push(el)
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true
  }

  /** Fires the registered callback with one synthetic entry. */
  emit(entry: Partial<IntersectionObserverEntry>) {
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

function status(id = 'post-1'): mastodon.v1.Status {
  return {
    id,
    uri: `https://example.com/${id}`,
    url: `https://example.com/${id}`,
    content: `<p>post ${id}</p>`,
    createdAt: new Date().toISOString(),
    account: { id: 'author-1', acct: 'author-1' },
    reblog: null,
  } as unknown as mastodon.v1.Status
}

/** A short, viewport-sized entry: mostly covers its own box. */
function shortVisibleEntry(): Partial<IntersectionObserverEntry> {
  return {
    isIntersecting: true,
    intersectionRatio: 0.9,
    intersectionRect: { height: 400 } as DOMRectReadOnly,
    rootBounds: { height: 800 } as DOMRectReadOnly,
  }
}

/**
 * A post rendered taller than the viewport (the Blocker 3 reproduction): its
 * own `intersectionRatio` can never clear the old single 0.4 threshold — here
 * it is pinned at 0.2, well under it — but it fills the whole viewport, which
 * `isMeaningfullyVisible`'s viewport-relative branch has to catch instead.
 */
function tallPostFillingViewportEntry(): Partial<IntersectionObserverEntry> {
  return {
    isIntersecting: true,
    intersectionRatio: 0.2,
    intersectionRect: { height: 800 } as DOMRectReadOnly,
    rootBounds: { height: 800 } as DOMRectReadOnly,
  }
}

function notIntersectingEntry(): Partial<IntersectionObserverEntry> {
  return {
    isIntersecting: false,
    intersectionRatio: 0,
    intersectionRect: { height: 0 } as DOMRectReadOnly,
    rootBounds: { height: 800 } as DOMRectReadOnly,
  }
}

describe('timelineForYouItem', () => {
  let originalIO: typeof IntersectionObserver

  beforeEach(() => {
    originalIO = window.IntersectionObserver
    CapturingIntersectionObserver.instances = []
    // @ts-expect-error test double, not a full IntersectionObserver
    window.IntersectionObserver = CapturingIntersectionObserver
    // @ts-expect-error same reason — `useIntersectionObserver`'s `defaultWindow`
    // may bind to either global depending on how happy-dom wires them up.
    globalThis.IntersectionObserver = CapturingIntersectionObserver
  })

  afterEach(() => {
    window.IntersectionObserver = originalIO
    globalThis.IntersectionObserver = originalIO
    markSeenMock.mockClear()
    dwellEnter.mockClear()
    dwellExit.mockClear()
    dwellFlush.mockClear()
  })

  async function mountItem() {
    const wrapper = await mountSuspended(TimelineForYouItem, {
      props: { status: status() },
    })
    await nextTick()
    await nextTick()
    const observer = CapturingIntersectionObserver.instances.at(-1)
    if (!observer)
      throw new Error('useIntersectionObserver never constructed an IntersectionObserver')
    return { wrapper, observer }
  }

  it('wires a single IntersectionObserver with a multi-value threshold, not one fixed ratio', async () => {
    const { observer } = await mountItem()

    expect(CapturingIntersectionObserver.instances).toHaveLength(1)
    expect(Array.isArray(observer.options?.threshold)).toBe(true)
    expect((observer.options!.threshold as number[]).length).toBeGreaterThan(1)
  })

  it('marks seen and starts dwell once, latched, for a normal short post', async () => {
    const { observer } = await mountItem()

    observer.emit(shortVisibleEntry())
    expect(markSeenMock).toHaveBeenCalledTimes(1)
    expect(dwellEnter).toHaveBeenCalledTimes(1)

    // Rapid scroll: several more "still visible" firings must not re-record
    // seen a second time — it is a one-shot latch, not a counter.
    observer.emit(shortVisibleEntry())
    observer.emit(shortVisibleEntry())
    expect(markSeenMock).toHaveBeenCalledTimes(1)
    // Dwell, unlike the seen latch, does accrue every entry.
    expect(dwellEnter).toHaveBeenCalledTimes(3)
  })

  it('exits dwell (without re-marking seen) once the post scrolls away', async () => {
    const { observer } = await mountItem()

    observer.emit(shortVisibleEntry())
    observer.emit(notIntersectingEntry())

    expect(markSeenMock).toHaveBeenCalledTimes(1)
    expect(dwellExit).toHaveBeenCalledTimes(1)
  })

  it('a post taller than the viewport, which never reaches its own 0.4 ratio, still records seen and dwell', async () => {
    const { observer } = await mountItem()

    const entry = tallPostFillingViewportEntry()
    // The reproduction: ratio is well under the old single threshold, yet
    // the post is genuinely filling the screen.
    expect(entry.intersectionRatio).toBeLessThan(0.4)

    observer.emit(entry)

    expect(markSeenMock).toHaveBeenCalledTimes(1)
    expect(dwellEnter).toHaveBeenCalledTimes(1)
  })

  it('a sliver of a tall post peeking into view (low ratio, small viewport share) does not count as seen', async () => {
    const { observer } = await mountItem()

    observer.emit({
      isIntersecting: true,
      intersectionRatio: 0.05,
      intersectionRect: { height: 40 } as DOMRectReadOnly,
      rootBounds: { height: 800 } as DOMRectReadOnly,
    })

    expect(markSeenMock).not.toHaveBeenCalled()
    expect(dwellEnter).not.toHaveBeenCalled()
    expect(dwellExit).toHaveBeenCalledTimes(1)
  })

  it('flushes dwell on unmount', async () => {
    const { wrapper, observer } = await mountItem()

    observer.emit(shortVisibleEntry())
    expect(dwellFlush).not.toHaveBeenCalled()

    wrapper.unmount()
    expect(dwellFlush).toHaveBeenCalledTimes(1)
  })
})
