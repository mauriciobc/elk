<script setup lang="ts">
const { t } = useI18n()

useHydratedHead({
  title: () => `${t('tab.following')} | ${t('nav.home')}`,
})

const router = useRouter()
const userSettings = useUserSettings()
const forYouEnabled = usePreferences('enableForYouFeed')

// The default-tab preference lives in per-account local storage, so it can only
// be read once we are on the client. `/home` therefore stays the canonical
// Following route and the preference is honoured as a post-hydration replace,
// which keeps the URL linkable and the server render deterministic.
onHydrated(() => {
  if (forYouEnabled.value && userSettings.value.defaultHomeTab === 'for-you')
    router.replace('/home/for-you')
})
</script>

<template>
  <TimelineHome v-if="isHydrated" />
</template>
