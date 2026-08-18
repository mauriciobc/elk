<script setup lang="ts">
import type { CommonRouteTabOption } from '#shared/types'

definePageMeta({
  middleware: 'auth',
  alias: ['/signin/callback'],
})

const route = useRoute()
const router = useRouter()
if (import.meta.client && route.path === '/signin/callback')
  router.push('/home')

const { t } = useI18n()

// `/home` stays the chronological Following timeline, so every existing link,
// shortcut and redirect to it keeps meaning what it always did.
const forYouEnabled = usePreferences('enableForYouFeed')

const tabs = computed<CommonRouteTabOption[]>(() => [
  {
    name: 'for-you',
    to: '/home/for-you',
    display: t('tab.for_you'),
  },
  {
    name: 'following',
    to: '/home',
    display: t('tab.following'),
  },
])
</script>

<template>
  <MainContent>
    <template #title>
      <MainTitle as="router-link" to="/home" icon="i-ri:home-5-line">
        {{ $t('nav.home') }}
      </MainTitle>
    </template>

    <!--
      No `isHydrated` gate: `enableForYouFeed` defaults to true and is
      SSR-safe (`useUserLocalStorage` falls back to the default settings on
      the server), so rendering unconditionally on the value here — as every
      other `CommonRouteTabs` page already does — means the tab strip paints
      in the very first response for the common case instead of popping in
      after hydration and pushing the timeline down. The one edge this
      doesn't cover is a viewer who disabled the feed on this device: the
      server has no way to know that, so their tab strip is removed once
      hydration corrects it — a rare, one-time flash instead of the shift
      every viewer used to pay on every load.
    -->
    <template v-if="forYouEnabled" #header>
      <CommonRouteTabs replace command prevent-scroll-top :options="tabs" />
    </template>

    <!--
      No keepalive override here, on purpose — this <NuxtPage/> is the one
      that actually toggles between `/home` and `/home/for-you` (depth 1 in
      vue-router's matched chain; the outer <NuxtPage/> above this page, in
      the root layout, stays on the same matched component — `home.vue`
      itself — for both routes, so it never needs to cache anything for this
      transition). Its default `keepalive: true` (from `app.keepalive` in
      nuxt.config.ts) is what makes the Following/For You tab switch keep
      each tab's scroll position and `useForYouFeed()` session alive instead
      of destroying and re-fetching it — confirmed by mounting this exact
      two-level <NuxtPage/> nesting against the real Nuxt/vue-router runtime
      and driving a same-parent sibling-route switch: with keepalive left at
      its default, a leaf's component instance survives the round trip;
      with `:keepalive="false"` forced on this instance, it does not — a new
      instance is created on every switch, which is exactly the bug this
      page shipped with once before. (That reproduction does not live on as
      an automated test: it mounts Nuxt's real, globally-shared `NuxtPage`
      and router, which — independent of anything this page does — raced an
      unrelated lazy chunk load against other test files' teardown often
      enough in this suite to be worth not keeping. The verification was
      run by hand instead; see this comment for the result.)

      A previous revision set `keepalive: false` in `definePageMeta` instead,
      meaning to disable only the *outer* <NuxtPage/>'s caching (across full
      navigation away from `/home` and back). That does not work: vue-router's
      `mergeMetaFields` builds one shared `meta` object for the whole matched
      route chain, and every nested <RouterView/> — outer and inner alike —
      reads that same object, so `route.meta.keepalive` cannot target one
      level without the other. That revision silently broke the tab switch
      this comment is now protecting.

      `keepalive` as a component *prop* (rather than route meta) is read
      per-<NuxtPage/>-instance (`page.js`: `props.keepalive ?? route.meta.keepalive
      ?? defaultKeepaliveConfig`), so it *can* target one level — but the only
      instance this file can reach a prop onto is this one, and disabling it is
      exactly the change that broke the tab switch above. Silencing Nuxt's
      nested-<KeepAlive/> dev warning would require reaching the *outer*
      instance (defined outside this file, in the root layout), which this
      page does not own; forcing it off here trades a real, tested feature
      for a cosmetic dev-only warning, so it is left alone.
    -->
    <NuxtPage />
  </MainContent>
</template>
