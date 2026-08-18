import type { CommonRouteTabOption } from '../../shared/types'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import CommonRouteTabs from '../../app/components/common/CommonRouteTabs.vue'

// The Nuxt i18n module's plugin does not install itself in this mounting
// environment, so the real `useI18n()` (from `~/utils/i18n.ts`, per the
// project-wide auto-import override) throws. Nothing under test here reads
// translated text — the assertions are all about ARIA/DOM structure — so a
// pass-through stub is enough.
mockNuxtImport('useI18n', () => () => ({ t: (key: string) => key }))

/**
 * `CommonRouteTabs` is shared by five pages (`home`, `explore`, `notifications`,
 * `AccountTabs`, the list page), so the ARIA-tab rewrite that added
 * `role="tablist"`/`"tab"`, `aria-selected` and roving tabindex is the
 * highest-blast-radius change in the For You feature. These tests exercise it
 * directly rather than relying on "the suite still passes" — none of the
 * existing pages assert on tab semantics at all.
 *
 * `match: true` is used instead of a real route so "which tab is active" is
 * asserted independently of router state — `CommonRouteTabs` honours an
 * explicit `match` before falling back to resolving `to` against the current
 * route, and that fallback path already has its own reasoning documented in
 * the component itself.
 */
function options(overrides: Partial<CommonRouteTabOption>[] = []): CommonRouteTabOption[] {
  const base: CommonRouteTabOption[] = [
    { name: 'a', to: '/tab-a', display: 'Tab A', match: true },
    { name: 'b', to: '/tab-b', display: 'Tab B', match: false },
    { name: 'c', to: '/tab-c', display: 'Tab C', match: false, disabled: true },
  ]
  return base.map((tab, i) => ({ ...tab, ...overrides[i] }))
}

describe('commonRouteTabs', () => {
  // The keyboard-nav tests mount with `attachTo: document.body` (jsdom only
  // updates `document.activeElement` for connected nodes); clean that up so
  // no test leaks DOM into a document other test files in this run may share.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a tablist of tabs, with the active one selected and the rest not', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, { props: { options: options() } })

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(3)

    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    expect(tabs[1]!.attributes('aria-selected')).toBe('false')
    expect(tabs[2]!.attributes('aria-selected')).toBe('false')
  })

  it('gives only the active tab a roving tabindex of 0, everything else -1', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, { props: { options: options() } })
    const tabs = wrapper.findAll('[role="tab"]')

    expect(tabs[0]!.attributes('tabindex')).toBe('0')
    expect(tabs[1]!.attributes('tabindex')).toBe('-1')
    expect(tabs[2]!.attributes('tabindex')).toBe('-1')
  })

  it('excludes a disabled tab from the tab order and marks it aria-disabled', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, { props: { options: options() } })
    const tabs = wrapper.findAll('[role="tab"]')

    // The disabled option renders as a non-interactive div, not a NuxtLink —
    // explore.vue relies on exactly this to keep a pre-login tab inert.
    expect(tabs[2]!.element.tagName).toBe('DIV')
    expect(tabs[2]!.attributes('aria-disabled')).toBe('true')
    expect(tabs[2]!.attributes('tabindex')).toBe('-1')
  })

  it('moves focus between tabs with ArrowRight/ArrowLeft, skipping the disabled one', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, {
      props: { options: options() },
      attachTo: document.body,
    })
    const tabs = wrapper.findAll('[role="tab"]')

    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[1]!.element)

    // From the last *focusable* tab (B — C is disabled and excluded), ArrowRight
    // wraps back to the first rather than trying to land on the disabled one.
    await tabs[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[0]!.element)

    await tabs[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tabs[1]!.element)
  })

  it('moves focus to the first/last focusable tab with Home/End', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, {
      props: { options: options() },
      attachTo: document.body,
    })
    const tabs = wrapper.findAll('[role="tab"]')

    await tabs[0]!.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(tabs[1]!.element)

    await tabs[1]!.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0]!.element)
  })

  it('hides a tab flagged `hide` entirely, out of both the tablist and the tab order', async () => {
    const wrapper = await mountSuspended(CommonRouteTabs, {
      props: { options: options([{}, { hide: true }, {}]) },
    })

    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs.map(t => t.text())).toEqual(['Tab A', 'Tab C'])
  })
})
