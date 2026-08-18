<script setup lang="ts">
import type { CommonRouteTabMoreOption, CommonRouteTabOption } from '#shared/types'

const { options, command, preventScrollTop = false } = defineProps<{
  options: CommonRouteTabOption[]
  moreOptions?: CommonRouteTabMoreOption
  command?: boolean
  replace?: boolean
  preventScrollTop?: boolean
}>()

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

useCommands(() => command
  ? options.map(tab => ({
      scope: 'Tabs',
      name: tab.display,
      icon: tab.icon ?? 'i-ri:file-list-2-line',
      onActivate: () => router.replace(tab.to),
    }))
  : [])

/**
 * A screen reader announces this row as a set of unrelated links, not a tab
 * strip, because it never carried tab semantics — no `role="tablist"`/`tab`,
 * no `aria-selected`, no roving tabindex. Fixed centrally rather than per
 * page: every caller (`home`, `explore`, `notifications`, `AccountTabs`, the
 * list page) renders the same structure, so five copies of the same ARIA
 * wiring would be five chances for it to drift out of sync. Visual styling
 * (the active tab's underline) still comes entirely from `exact-active-class`
 * and is untouched; this only adds the semantics layered on top of it.
 */
const visibleOptions = computed(() => options.filter(item => !item.hide))
const focusableOptions = computed(() => visibleOptions.value.filter(item => !item.disabled))

/**
 * `option.match` (used today for the "more" overflow entry) is honoured when
 * a caller sets it explicitly; otherwise the active tab is whichever option's
 * route resolves to the current path — an approximation of `exact-active`
 * good enough for `aria-selected`, which never needs to be pixel-perfect.
 */
function isTabActive(option: CommonRouteTabOption): boolean {
  if (option.match !== undefined)
    return option.match
  try {
    return router.resolve(option.to).path === route.path
  }
  catch {
    return false
  }
}

const activeFocusableIndex = computed(() => {
  const index = focusableOptions.value.findIndex(isTabActive)
  return index === -1 ? 0 : index
})

const tabRefs = ref<HTMLElement[]>([])
function setTabRef(el: unknown, index: number) {
  const node = (el as { $el?: HTMLElement })?.$el ?? (el as HTMLElement | null)
  if (node instanceof HTMLElement)
    tabRefs.value[index] = node
  else
    delete tabRefs.value[index]
}

/** Roving tabindex + arrow-key movement, per the WAI-ARIA tabs pattern. */
function onTabKeydown(event: KeyboardEvent, index: number) {
  const total = focusableOptions.value.length
  if (!total)
    return

  let next: number | undefined
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % total
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + total) % total
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = total - 1
      break
    default:
      return
  }

  event.preventDefault()
  tabRefs.value[next]?.focus()
}
</script>

<template>
  <div flex w-full items-center lg:text-lg of-x-auto scrollbar-hide border="b base" role="tablist">
    <template
      v-for="(option, index) in visibleOptions"
      :key="option?.name || index"
    >
      <NuxtLink
        v-if="!option.disabled"
        :ref="(el: unknown) => setTabRef(el, focusableOptions.indexOf(option))"
        :to="option.to"
        :replace="replace"
        relative flex flex-auto cursor-pointer sm:px6 px2 rounded transition-all
        role="tab"
        :aria-selected="isTabActive(option) ? 'true' : 'false'"
        :tabindex="focusableOptions.indexOf(option) === activeFocusableIndex ? 0 : -1"
        hover:bg-active transition-100
        exact-active-class="children:(text-secondary !border-primary !op100 !text-base)"
        @click="!preventScrollTop && $scrollToTop()"
        @keydown="onTabKeydown($event, focusableOptions.indexOf(option))"
      >
        <span ws-nowrap mxa sm:px2 sm:py3 xl:pb4 xl:pt5 py2 text-center border-b-3 text-secondary-light hover:text-secondary border-transparent>{{ option.display || '&nbsp;' }}</span>
      </NuxtLink>
      <div v-else flex flex-auto sm:px6 px2 xl:pb4 xl:pt5 role="tab" aria-disabled="true" aria-selected="false" tabindex="-1">
        <span ws-nowrap mxa sm:px2 sm:py3 py2 text-center text-secondary-light op50>{{ option.display }}</span>
      </div>
    </template>
    <template v-if="isHydrated && moreOptions?.options?.length">
      <CommonDropdown placement="bottom" flex cursor-pointer mx-1.25rem>
        <CommonTooltip placement="top" :content="moreOptions.tooltip || t('action.more')">
          <button
            cursor-pointer
            flex
            gap-1
            w-12
            rounded
            hover:bg-active
            btn-action-icon
            op75
            px4
            group
            :aria-label="t('action.more')"
            :class="moreOptions.match ? 'text-primary' : 'text-secondary'"
          >
            <span v-if="moreOptions.icon" :class="moreOptions.icon" text-sm me--1 block />
            <span i-ri:arrow-down-s-line text-sm me--1 block />
          </button>
        </CommonTooltip>
        <template #popper>
          <NuxtLink
            v-for="(option, index) in moreOptions.options.filter(item => !item.hide)"
            :key="option?.name || index"
            :to="option.to"
          >
            <CommonDropdownItem>
              <span flex="~ row" gap-x-4 items-center :class="option.match ? 'text-primary' : ''">
                <span v-if="option.icon" :class="[option.icon, option.match ? 'text-primary' : 'text.secondary']" text-md me--1 block />
                <span v-else block>&#160;</span>
                <span>{{ option.display }}</span>
              </span>
            </CommonDropdownItem>
          </NuxtLink>
        </template>
      </commondropdown>
    </template>
  </div>
</template>
