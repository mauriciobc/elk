<script setup lang="ts">
const { t } = useI18n()

useHydratedHead({
  title: () => `${t('tab.for_you')} | ${t('nav.home')}`,
})

const router = useRouter()
const forYouEnabled = usePreferences('enableForYouFeed')

// A bookmarked link to a tab the viewer has since switched off must not strand
// them on a feed with no way back to it.
onHydrated(() => {
  if (!forYouEnabled.value)
    router.replace('/home')
})
</script>

<template>
  <TimelineForYou v-if="isHydrated" />
</template>
