<script setup lang="ts">
import type { CommonPaginator } from '#components'
import type { ComponentExposed } from 'vue-component-type-helpers'
import type { AutoRefreshGate, ForYouDismissReason } from '~/composables/for-you/feed'

const { t } = useI18n()
const virtualScroller = usePreferences('experimentalVirtualScroller')

// Same courtesy `TimelineHome` extends to slow connections: ask for less.
const { isSupported, effectiveType } = useNetwork()
const isSlow = isSupported.value && !!effectiveType.value && ['slow-2g', '2g', '3g'].includes(effectiveType.value)

/**
 * The ranked feed, exposed as a Masto.js paginator so `CommonPaginator` drives
 * it exactly like every other timeline — infinite scroll, the end anchor, the
 * skeleton and the virtual scroller all come for free.
 */
const { paginator, isFallback, stale, checkStale, refresh, relevance, inNetwork } = useForYouFeed({
  pageSize: isSlow ? 10 : DEFAULT_FOR_YOU_PAGE_SIZE,
  sourceLimit: isSlow ? 20 : undefined,
})

type PaginatorRef = ComponentExposed<typeof CommonPaginator>
const paginatorRef = ref<PaginatorRef>()

/**
 * The stable (never `:key`-bumped) wrapper around `<CommonPaginator>` — see
 * `performRefresh`'s focus handling below for why it exists.
 */
const listRegion = ref<HTMLElement>()

/**
 * Announced to screen readers on every dismiss/undo/refresh, since each of
 * these just changes the DOM with nothing else to narrate it.
 *
 * Cleared and then set on a tick, rather than assigned directly: two
 * announcements in a row with the same text are not guaranteed to both be
 * read — most screen readers key off a text mutation, not an event. Passing
 * through an empty string in between guarantees a real mutation every time
 * without polluting what gets read aloud with a visible counter.
 */
const announcement = ref('')
function announce(message: string) {
  announcement.value = ''
  nextTick(() => {
    announcement.value = message
  })
}

/** How long "Post hidden — Undo" stays actionable before the removal finalizes. */
const UNDO_WINDOW_MS = 6000

interface PendingDismissal {
  id: string
  revert: () => void
  commit: () => void
}

/** At most one undo window open at a time — see `onDismiss`. */
const pending = ref<PendingDismissal>()
const undoButton = ref<HTMLElement>()
const graceTimer = useTimeoutFn(() => finalizePending(), UNDO_WINDOW_MS, { immediate: false })

/** Finalizes whatever is pending: drops it from the paginator for good. */
function finalizePending() {
  if (!pending.value)
    return
  graceTimer.stop()
  pending.value.commit()
  pending.value = undefined
}

function onDismiss(id: string, reason: ForYouDismissReason, revert: () => void) {
  // A second dismissal while one is still undoable finalizes the first rather
  // than stacking silent removals or losing track of either one.
  finalizePending()

  pending.value = {
    id,
    revert,
    commit: () => paginatorRef.value?.removeEntry(id),
  }
  graceTimer.start()

  announce(reason === 'author'
    ? t('for_you.dismissed_author')
    : t('for_you.dismissed_post'))

  // Without this, focus would fall back to <body> once floating-vue's
  // hide() removes the (still-focused) dropdown item from the DOM — this
  // nextTick is a microtask that always wins that race against hide()'s
  // macrotask-scheduled teardown. Full mechanism in the JSDoc on
  // TimelineForYouItem.vue's dismiss(). Landing spot: a stable,
  // always-present, genuinely actionable control, not <body>.
  nextTick(() => undoButton.value?.focus())
}

function undoDismiss() {
  if (!pending.value)
    return
  graceTimer.stop()
  pending.value.revert()
  pending.value = undefined
  announce(t('for_you.dismiss_undone'))
}

/**
 * Refresh-on-demand, not a live stream.
 *
 * `TimelinePaginator` (the Following tab) passes `CommonPaginator` a `stream`
 * and lets it splice live posts into `prevItems`/`#updater`. That is wrong
 * here on two counts: it would insert unranked content above a ranked feed,
 * and stream-sourced items never pass through `feed.ts`'s `emit()`, so they
 * would dodge the `servedKeys` bookkeeping that makes "already-served posts
 * never move" true — the exact invariant the dismiss/undo work above depends
 * on. X does not live-insert into For You either.
 *
 * So this is refresh-on-demand instead: force a fresh top-of-timeline fetch
 * (`refresh()`, see `feed.ts`), and if it found anything new, throw the
 * `CommonPaginator` away and mount a new one. `useForYouFeed()` itself is not
 * re-called, so the session (`servedKeys`, `round`, `isFallback`) survives the
 * remount untouched — only the *rendered* list and its own internal
 * `usePaginator` state (`items`, `nextItems`, scroll-triggered loading) start
 * over, by calling `paginator.values()` again from a component that has never
 * seen a page yet.
 */
const paginatorGeneration = ref(0)
const refreshing = ref(false)
const nuxtApp = useNuxtApp()

/**
 * Near enough to the top that replacing what is on screen cannot yank content
 * out from under someone mid-read.
 */
const NEAR_TOP_PX = 64
const { y: scrollY } = useWindowScroll({ behavior: 'instant' })
const isNearTop = computed(() => scrollY.value <= NEAR_TOP_PX)

/**
 * The automatic path's own cooldown/backoff state — see `canAutoRefreshForYou`
 * / `autoRefreshIntervalMs` in `feed.ts`. Deliberately a local `ref`, not part
 * of `useForYouFeed()`'s session: it is UI timing, not feed data, so it is
 * fine for it to reset on remount (unlike `servedKeys`).
 */
const autoRefreshGate = ref<AutoRefreshGate>(initialAutoRefreshGate())

/**
 * Is the viewer actually looking at this tab right now?
 *
 * Mirrors `signals.ts`'s own `isDocumentVisible` (same undefined-safe
 * fallback for SSR/a DOM-less test), plus `document.hasFocus()` where it
 * exists: `visibilityState` alone still reports "visible" for a background
 * *window* that is merely not the foreground one (e.g. two browser windows
 * side by side), and the automatic path firing a ~40-request fan-out for a
 * tab the viewer isn't even looking at is exactly what it must not do.
 */
function isViewerActive(): boolean {
  if (typeof document === 'undefined')
    return true
  if (document.visibilityState === 'hidden')
    return false
  return typeof document.hasFocus !== 'function' || document.hasFocus()
}

/**
 * `auto: true` is the staleness watcher below; `auto: false` (the default) is
 * the explicit "Show new posts" click. Only the automatic path is gated —
 * visibility/focus, and the cooldown/backoff in `feed.ts` — so a viewer who
 * deliberately taps the button always gets an immediate attempt, exactly as
 * before.
 */
async function performRefresh(auto = false): Promise<void> {
  if (refreshing.value)
    return
  if (auto) {
    if (!isViewerActive() || !canAutoRefreshForYou(autoRefreshGate.value))
      return
  }
  // A pending "Post hidden — Undo" toast refers to an item in the
  // about-to-be-destroyed paginator; finalize it rather than leave it
  // dangling (its penalty is already applied regardless — see `onDismiss`).
  finalizePending()

  refreshing.value = true
  try {
    const { updated, rateLimited, retryInMs } = await refresh()
    if (auto) {
      // A rate-limited attempt counts as "found nothing" for backoff
      // purposes too — the instance just told us to slow down, which is
      // exactly what growing the cooldown does.
      autoRefreshGate.value = nextAutoRefreshGate(autoRefreshGate.value, updated)
    }
    if (updated) {
      // The dismiss path (`onDismiss` above) is careful about focus: it never
      // lets the removed dropdown item's teardown drop focus to `<body>`. A
      // refresh bumping `:key` on `<CommonPaginator>` below is the same class
      // of problem at a larger scale — it destroys *every* DOM node the list
      // currently holds, including whichever one has focus, if any — but
      // previously had none of that care. Unlike the dismiss path, there is
      // no third party whose async teardown we are racing: the `:key` bump
      // and the DOM patch it causes are both fully synchronous with this
      // function, so plain `nextTick()` (which resolves once that patch has
      // flushed) is enough, with no microtask/macrotask ordering to worry
      // about.
      const hadFocusInList = !!listRegion.value?.contains(document.activeElement)
      paginatorGeneration.value++
      await nextTick()
      nuxtApp.$scrollToTop()
      // `listRegion` itself is not `:key`-bumped, so it survived the patch
      // above untouched — land focus there, rather than let it fall to
      // `<body>`, whenever the viewer's focus was somewhere inside the list
      // that patch just destroyed.
      if (hadFocusInList)
        listRegion.value?.focus()
      // Said either way: a refresh silently swapping the whole list out from
      // under a screen-reader user is worth announcing regardless of exactly
      // where their focus was.
      announce(t('for_you.refreshed'))
    }
    else if (rateLimited) {
      // The instance asked us to back off. Say so, and say for how long —
      // silently doing nothing reads as a broken button and invites the
      // viewer to keep tapping, which is what the backoff exists to prevent.
      announce(t('for_you.refresh_rate_limited', { seconds: Math.ceil((retryInMs ?? 0) / 1000) }))
    }
    else {
      // Never blank the feed over an empty refresh: nothing here touches
      // `paginatorGeneration`, so the currently-rendered list is untouched —
      // only the prompt/next poll needs to know there was nothing new.
      announce(t('for_you.refresh_empty'))
    }
  }
  finally {
    // Whether or not anything new came back, the pool was just re-filled, so
    // the staleness verdict needs recomputing — otherwise a quiet instance
    // with nothing new would keep re-triggering this every poll.
    checkStale()
    refreshing.value = false
  }
}

// While at the top, a refresh cannot disturb anything the viewer is reading —
// there is nothing above the fold to disturb — so a stale pool refreshes
// itself there. Anywhere else, only the visible "Show new posts" prompt
// (below) can trigger it; auto-replacing content under a scrolled-down reader
// is worse than showing them slightly stale posts.
//
// `shouldAutoRefreshForYou` is the fold-safety rule alone (stale + at the
// top); `performRefresh(true)` layers the visibility/focus check and the
// cooldown/backoff on top, so a viewer idling at the top of a background tab,
// or one whose instance just went quiet, does not fan out every poll forever.
watch([stale, isNearTop], ([isStale, atTop]) => {
  if (shouldAutoRefreshForYou(isStale, atTop))
    void performRefresh(true)
})

const STALE_POLL_MS = 30_000
useIntervalFn(() => checkStale(), STALE_POLL_MS)

onActivated(() => {
  // Nuxt's `app.keepalive` keeps this component alive while the viewer is on
  // another tab; returning after a long absence should not silently serve an
  // hour-old feed. `checkStale` re-reads the pool's real fill time, so this
  // is correct regardless of how long the component was deactivated for. If
  // it comes back stale *and* the viewer left scrolled at the top, the
  // `watch` above fires the same as it would from the periodic poll.
  checkStale()
})

// Matches how the sidebar builds its Explore link, so the empty state's call to
// action lands on the same page the nav would.
const exploreLink = computed(() => {
  if (!isHydrated.value)
    return '/explore'
  const server = currentServer.value
  return server ? `/${server}/explore` : '/explore'
})
</script>

<template>
  <div>
    <PublishWidgetList draft-key="home" />
    <div h="1px" w-auto bg-border mb-3 />

    <div
      v-if="isFallback"
      flex="~ gap-2" items-start
      px5 py3 text-sm text-secondary border="b base"
    >
      <div aria-hidden="true" i-ri:information-line shrink-0 mt-2px />
      <p>{{ t('for_you.fallback_notice') }}</p>
    </div>

    <div
      v-if="pending"
      flex="~ gap-3" items-center justify-between
      px5 py3 text-sm border="b base"
    >
      <span>{{ t('for_you.dismissed_post_toast') }}</span>
      <button
        ref="undoButton"
        type="button"
        btn-text shrink-0 font-medium text-primary
        @click="undoDismiss"
      >
        {{ t('for_you.undo') }}
      </button>
    </div>

    <p sr-only role="status" aria-live="polite">
      {{ announcement }}
    </p>

    <!--
      Only rendered scrolled away from the top: at the top, the `watch` in the
      script refreshes silently instead (nothing above the fold to disturb),
      so this button existing at all already means "don't touch what's on
      screen without asking." Same id as every other timeline's "show new
      items" button so the "." keyboard shortcut (`magic-keys.client.ts`)
      works here too.
    -->
    <button
      v-if="stale && !isNearTop"
      id="elk_show_new_items"
      type="button"
      py-4 border="b base" flex="~ col" p-3 w-full text-primary font-bold
      :disabled="refreshing"
      :class="refreshing ? 'op50' : ''"
      @click="performRefresh()"
    >
      {{ t('for_you.show_new_posts') }}
    </button>

    <!--
      `tabindex="-1"`: not in the tab order (nothing here is meant to be
      reached by Tab), but a valid `.focus()` target — the landing spot
      `performRefresh` moves focus to when the viewer had focus somewhere
      inside the list right before a `:key` bump below tears that whole
      subtree down. This wrapper is *not* keyed, so it — and the DOM node
      focus lands on — survives the remount the paginator itself does not.
    -->
    <div ref="listRegion" tabindex="-1" focus:outline-none focus-visible:ring="2 primary">
      <CommonPaginator
        :key="paginatorGeneration"
        ref="paginatorRef"
        :paginator="paginator"
        :virtual-scroller="virtualScroller"
      >
        <template #default="{ item, older, newer }">
          <TimelineForYouItem
            :key="item.id"
            :status="item"
            :older="older"
            :newer="newer"
            :relevance="relevance.get(item.id)"
            :in-network="inNetwork.get(item.id)"
            @dismiss="onDismiss"
          />
        </template>

        <!--
          A viewer who follows nobody on a quiet instance can genuinely reach
          the end with nothing ranked. Send them somewhere instead of leaving
          them on a line of italic text.
        -->
        <template #done="{ items }">
          <div v-if="items.length === 0" flex="~ col center gap-3" px6 py10 text-center>
            <div aria-hidden="true" i-ri:sparkling-2-line text-4xl text-secondary-light />
            <h2 text-lg font-bold>
              {{ t('for_you.empty_title') }}
            </h2>
            <p text-secondary max-w-80>
              {{ t('for_you.empty_description') }}
            </p>
            <NuxtLink
              :to="exploreLink"
              btn-solid mt-1 flex="~ gap-2 center"
            >
              <span aria-hidden="true" i-ri:compass-3-line />
              {{ t('for_you.empty_action') }}
            </NuxtLink>
          </div>
          <div v-else p5 text-secondary italic text-center>
            {{ t('common.end_of_list') }}
          </div>
        </template>
      </CommonPaginator>
    </div>
  </div>
</template>
