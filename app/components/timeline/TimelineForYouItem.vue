<script setup lang="ts">
import type { mastodon } from 'masto'

const { status, relevance } = defineProps<{
  status: mastodon.v1.Status
  // Passed straight through to `StatusCard` so reply threads still collapse.
  older?: mastodon.v1.Status
  newer?: mastodon.v1.Status
  /** Why this post is here — see `forYouRelevanceReason` in `feed.ts`. */
  relevance?: ForYouRelevanceReason
}>()

const emit = defineEmits<{
  /**
   * `revert` undoes both halves of the dismissal: the signal it applied
   * (`markNotInterested`/`muteAuthorForYou`) and this component's own
   * collapsed visual state. The parent owns *when* to call it (the undo
   * window) and when to give up and finalize the removal instead.
   */
  dismiss: [id: string, reason: ForYouDismissReason, revert: () => void]
}>()

const { t } = useI18n()

/**
 * Icon + label for the relevance chip. A lookup table rather than a switch:
 * every `ForYouRelevanceReason` must have an entry, so adding a category to
 * `forYouRelevanceReason` without updating this fails typecheck rather than
 * silently rendering nothing.
 */
const RELEVANCE_DISPLAY: Record<ForYouRelevanceReason, { icon: string, label: string }> = {
  following: { icon: 'i-ri:user-follow-line', label: 'for_you.reason_following' },
  network: { icon: 'i-ri:group-line', label: 'for_you.reason_network' },
  trending: { icon: 'i-ri:fire-line', label: 'for_you.reason_trending' },
  tag: { icon: 'i-ri:hashtag', label: 'for_you.reason_tag' },
}
const relevanceDisplay = computed(() => relevance ? RELEVANCE_DISPLAY[relevance] : undefined)

/** Long enough to read as motion, short enough not to make the viewer wait. */
const DISMISS_DURATION_MS = 220

const el = ref<HTMLElement>()
const dismissing = ref(false)
const reducedMotion = usePreferredReducedMotion()

/**
 * `markSeen` feeds the ranker's `PreviouslySeenPostsFilter`, so it has to record
 * what the viewer actually *saw* — not what we fetched. A post that was ranked
 * into a page but never reached the screen (the viewer switched tabs, or it sat
 * in the paginator's look-ahead buffer) must stay eligible for a later page,
 * which is why this fires on intersection rather than in the pipeline.
 *
 * The same observer also drives dwell — "shown and read" versus "shown and
 * scrolled past" — rather than running a second one: two observers per post
 * in a long feed is real scroll cost for no benefit, since both concerns are
 * the same underlying question ("is this post genuinely on screen?"), just
 * answered once (`markSeen`, latched) and continuously (`dwell`, an
 * accumulator across every in/out transition until unmount).
 *
 * Not a single `intersectionRatio` threshold: `IntersectionObserverEntry.
 * intersectionRatio` is the visible area over the *target's own* bounding
 * box, not the viewport. For a post rendered taller than the viewport, the
 * intersection can never exceed `viewportHeight / postHeight` — a post over
 * ~2.5x the viewport tall can *never* reach ratio 0.4, so a single 0.4
 * threshold silently never fires `isIntersecting` for exactly the long
 * threads, big embeds and tall media where dwell matters most. (There was
 * previously a claim here that 0.4 was "already the bar `markSeen` validated
 * for genuinely on screen" — `markSeen`'s only other call site,
 * `routes.ts`'s click-navigation handler, has no `IntersectionObserver`
 * involved at all, so there was nothing that number was actually validated
 * against.)
 *
 * {@link isMeaningfullyVisible} below fixes this with a check that does not
 * depend on the post's own height: "mostly covers itself" (ratio, the
 * original bar — fine for a normal, viewport-sized post) *or* "occupies a
 * meaningful slice of the viewport" (`intersectionRect` against `rootBounds`,
 * i.e. the *viewport's* height, not the post's — the case a huge post needs).
 * `threshold` is an array, not a single number, so the observer's callback
 * actually re-fires at several points as a tall post scrolls through,
 * instead of only at enter/exit — each firing is a fresh chance to catch the
 * moment the viewport-relative check crosses its own bar.
 */
const dwell = createDwellTracker(status)
let seenRecorded = false

/** How much of the target's own box must be visible to count on that axis alone. */
const RATIO_VISIBLE_THRESHOLD = 0.4
/** How much of the *viewport* a partially-visible tall post must fill to count. */
const VIEWPORT_VISIBLE_SHARE = 0.5

function isMeaningfullyVisible(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting)
    return false
  if (entry.intersectionRatio >= RATIO_VISIBLE_THRESHOLD)
    return true
  const viewportHeight = entry.rootBounds?.height
  if (!viewportHeight)
    return false
  return entry.intersectionRect.height / viewportHeight >= VIEWPORT_VISIBLE_SHARE
}

useIntersectionObserver(
  el,
  ([entry]) => {
    if (!entry)
      return
    if (isMeaningfullyVisible(entry)) {
      if (!seenRecorded) {
        seenRecorded = true
        markSeen([candidateKey(status)])
      }
      dwell.enter()
    }
    else {
      dwell.exit()
    }
  },
  { threshold: [0, 0.1, 0.2, RATIO_VISIBLE_THRESHOLD, 0.5, 0.75, 1] },
)

onUnmounted(dwell.flush)

interface DismissActions {
  /** Applies the ranking penalty. Runs synchronously and immediately. */
  apply: () => void
  /** Reverses it. Called only if the viewer hits Undo before the grace period ends. */
  undo: () => void
}

/**
 * Collapses the post out of the timeline and hands the parent a `revert`.
 *
 * The feedback (`markNotInterested` / `muteAuthorForYou`) is applied first and
 * synchronously: the ranker must know before the next page is scored, whatever
 * the animation or the undo window end up doing. The `dismiss` event fires
 * right away too — deliberately not delayed until the collapse animation
 * finishes.
 *
 * Why that timing matters: the click that reaches this function comes from a
 * `CommonDropdownItem` inside `StatusActionsMore`'s popper, which floating-vue
 * teleports to `document.body` — outside this article entirely, so making the
 * article `inert` below never touches it. `DropdownItem.handleClick` calls
 * floating-vue's `hide()` synchronously before emitting the click, and
 * `hide()` has no focus-return logic of its own — only `show()` ever calls
 * `.focus()` — it just schedules the popper's own DOM teardown via
 * `setTimeout(fn, 0)`, a **macrotask**. Left alone, once that macrotask fires
 * and removes the still-focused dropdown item from the document, the browser
 * drops focus to `<body>` — the "keyboard/screen-reader user loses their
 * place" failure this feature exists to prevent. The parent's
 * `nextTick(() => undoButton.value?.focus())` (see `onDismiss` in
 * `TimelineForYou.vue`) is a **microtask**, queued in the same tick this
 * function runs in, and microtasks always drain before the next macrotask —
 * so focus lands on the Undo button deterministically before `hide()`'s
 * removal could ever drop it to `<body>`. No race with `inert` is involved;
 * the dropdown's content was never inside this article to begin with.
 *
 * The animation plays out on its own; actual removal from the list happens
 * later, and only if the viewer never undoes it (see `TimelineForYou.vue`).
 */
function dismiss(reason: ForYouDismissReason, actions: DismissActions) {
  if (dismissing.value)
    return

  actions.apply()
  dismissing.value = true

  const node = el.value
  const revert = () => {
    dismissing.value = false
    if (node) {
      node.style.transition = ''
      node.style.height = ''
      node.style.opacity = ''
    }
    actions.undo()
  }

  if (node && reducedMotion.value !== 'reduce') {
    // Height has to start from a concrete value for the transition to run,
    // and the reflow in between makes the browser commit to it before it
    // changes.
    node.style.height = `${node.offsetHeight}px`
    void node.offsetHeight
    node.style.transition = `height ${DISMISS_DURATION_MS}ms ease, opacity ${DISMISS_DURATION_MS}ms ease`
    node.style.height = '0px'
    node.style.opacity = '0'
  }

  emit('dismiss', status.id, reason, revert)
}

/**
 * `StatusActionsMore` lives three components deep inside `StatusCard`, so the
 * two For You-only menu entries are handed down rather than threaded through as
 * props. Outside this feed nothing provides them and the menu is unchanged.
 */
provide(forYouItemInjectionKey, {
  notInterested: () => dismiss('not_interested', {
    apply: () => markNotInterested(status),
    undo: () => forgetNotInterested(underlyingStatus(status).id),
  }),
  showLessFromAuthor: () => dismiss('author', {
    apply: () => {
      const accountId = underlyingStatus(status).account?.id
      if (accountId)
        muteAuthorForYou(accountId)
    },
    undo: () => {
      const accountId = underlyingStatus(status).account?.id
      if (accountId)
        unmuteAuthorForYou(accountId)
    },
  }),
})
</script>

<template>
  <!--
    `inert`, not `aria-hidden`: setting `aria-hidden` on an ancestor of a
    focusable (or focused) descendant is a known accessibility anti-pattern,
    and `inert` is the property built for exactly this instead — it removes a
    subtree from both the focus order and the accessibility tree together,
    with no such caveat. (The dropdown that triggers a dismissal lives in a
    floating-vue popper teleported to `document.body`, not inside this
    article — see the JSDoc on `dismiss()` for where focus actually goes.)
  -->
  <article
    ref="el"
    :inert="dismissing || undefined"
    :class="dismissing ? 'of-hidden pointer-events-none' : ''"
  >
    <!--
      X's own "why this is in your feed" pattern — a subtle line above the
      post, not a badge inside it, so it costs nothing when there is nothing
      distinctive to say (see `forYouRelevanceReason` in `feed.ts`, which
      leaves plain federated/local content with no chip at all).
    -->
    <p
      v-if="relevanceDisplay"
      flex="~ gap-1" items-center
      ps4 pt3 text-xs text-secondary-light
    >
      <span aria-hidden="true" :class="relevanceDisplay.icon" />
      {{ t(relevanceDisplay.label) }}
    </p>
    <StatusCard :status="status" :older="older" :newer="newer" context="home" />
  </article>
</template>
