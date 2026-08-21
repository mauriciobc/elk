<script setup lang="ts">
import type { HomeTab } from '~/composables/settings'

const { t } = useI18n()

useHydratedHead({
  title: () => `${t('settings.preferences.label')} | ${t('nav.settings')}`,
})

const userSettings = useUserSettings()

const forYouEnabled = usePreferences('enableForYouFeed')
const defaultHomeTab = computed<HomeTab>(() => userSettings.value.defaultHomeTab ?? 'following')

const homeTabs = [
  { value: 'for-you', label: 'tab.for_you', icon: 'i-ri:sparkling-line' },
  { value: 'following', label: 'tab.following', icon: 'i-ri:user-follow-line' },
] as const

function setDefaultHomeTab(tab: HomeTab) {
  userSettings.value.defaultHomeTab = tab
}
</script>

<template>
  <MainContent back="small-only">
    <template #title>
      <MainTitle as="h1" secondary>
        {{ $t('settings.preferences.label') }}
      </MainTitle>
    </template>
    <section>
      <h2 px6 py4 mt2 font-bold text-xl flex="~ gap-1" items-center sr-only>
        <span aria-hidden="true" block i-ri-equalizer-line />
        {{ $t('settings.preferences.label') }}
      </h2>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideAltIndicatorOnPosts')"
        @click="togglePreferences('hideAltIndicatorOnPosts')"
      >
        {{ $t('settings.preferences.hide_alt_indi_on_posts') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideGifIndicatorOnPosts')"
        @click="togglePreferences('hideGifIndicatorOnPosts')"
      >
        {{ $t('settings.preferences.hide_gif_indi_on_posts') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideAccountHoverCard')"
        @click="togglePreferences('hideAccountHoverCard')"
      >
        {{ $t('settings.preferences.hide_account_hover_card') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideTagHoverCard')"
        @click="togglePreferences('hideTagHoverCard')"
      >
        {{ $t('settings.preferences.hide_tag_hover_card') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'enableAutoplay')"
        :disabled="getPreferences(userSettings, 'enableDataSaving')"
        @click="togglePreferences('enableAutoplay')"
      >
        {{ $t('settings.preferences.enable_autoplay') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'unmuteVideos')"
        @click="togglePreferences('unmuteVideos')"
      >
        {{ $t('settings.preferences.unmute_videos') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'optimizeForLowPerformanceDevice')"
        @click="togglePreferences('optimizeForLowPerformanceDevice')"
      >
        {{ $t('settings.preferences.optimize_for_low_performance_device') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'enableDataSaving')"
        @click="togglePreferences('enableDataSaving')"
      >
        {{ $t("settings.preferences.enable_data_saving") }}
        <template #description>
          {{ $t("settings.preferences.enable_data_saving_description") }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'enablePinchToZoom')"
        @click="togglePreferences('enablePinchToZoom')"
      >
        {{ $t('settings.preferences.enable_pinch_to_zoom') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'useStarFavoriteIcon')"
        @click="togglePreferences('useStarFavoriteIcon')"
      >
        {{ $t('settings.preferences.use_star_favorite_icon') }}
      </SettingsToggleItem>
    </section>
    <section>
      <h2 px6 py4 mt2 font-bold text-xl flex="~ gap-1" items-center>
        <span aria-hidden="true" block i-ri-home-5-line />
        {{ $t('settings.preferences.home_feed') }}
      </h2>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'enableForYouFeed')"
        @click="togglePreferences('enableForYouFeed')"
      >
        {{ $t('settings.preferences.enable_for_you') }}
        <template #description>
          {{ $t('settings.preferences.enable_for_you_description') }}
        </template>
      </SettingsToggleItem>
      <div px5 py3 space-y-2 :class="forYouEnabled ? '' : 'op50'">
        <h3 id="settings-default-home-tab" font-medium>
          {{ $t('settings.preferences.default_home_tab') }}
        </h3>
        <div flex="~ gap4 wrap" w-full role="group" aria-labelledby="settings-default-home-tab">
          <button
            v-for="tab in homeTabs"
            :key="tab.value"
            type="button"
            btn-text flex-1 flex="~ gap-1 center" p4 border="~ base rounded" bg-base ws-nowrap
            :disabled="!forYouEnabled"
            :aria-pressed="defaultHomeTab === tab.value ? 'true' : 'false'"
            :class="defaultHomeTab === tab.value ? 'pointer-events-none' : 'filter-saturate-0'"
            @click="setDefaultHomeTab(tab.value)"
          >
            <span aria-hidden="true" :class="tab.icon" />
            {{ $t(tab.label) }}
          </button>
        </div>
      </div>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'personalizeForYouRanking')"
        :disabled="!forYouEnabled"
        @click="togglePreferences('personalizeForYouRanking')"
      >
        {{ $t('settings.preferences.personalize_for_you') }}
        <template #description>
          {{ $t('settings.preferences.personalize_for_you_description') }}
        </template>
      </SettingsToggleItem>
    </section>
    <section>
      <h2 px6 py4 mt2 font-bold text-xl flex="~ gap-1" items-center>
        <span aria-hidden="true" block i-ri-hearts-line />
        {{ $t('settings.preferences.wellbeing') }}
      </h2>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'grayscaleMode')"
        @click="togglePreferences('grayscaleMode')"
      >
        {{ $t('settings.preferences.grayscale_mode') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideBoostCount')"
        @click="togglePreferences('hideBoostCount')"
      >
        {{ $t('settings.preferences.hide_boost_count') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideQuoteCount')"
        @click="togglePreferences('hideQuoteCount')"
      >
        {{ $t('settings.preferences.hide_quote_count') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideFavoriteCount')"
        @click="togglePreferences('hideFavoriteCount')"
      >
        {{ $t('settings.preferences.hide_favorite_count') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideReplyCount')"
        @click="togglePreferences('hideReplyCount')"
      >
        {{ $t('settings.preferences.hide_reply_count') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideFollowerCount')"
        @click="togglePreferences('hideFollowerCount')"
      >
        {{ $t('settings.preferences.hide_follower_count') }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideUsernameEmojis')"
        @click="togglePreferences('hideUsernameEmojis')"
      >
        {{ $t("settings.preferences.hide_username_emojis") }}
        <template #description>
          {{ $t('settings.preferences.hide_username_emojis_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideNews')"
        @click="togglePreferences('hideNews')"
      >
        {{ $t("settings.preferences.hide_news") }}
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideRepliesInTimeline')"
        @click="togglePreferences('hideRepliesInTimeline')"
      >
        {{ $t('settings.preferences.hide_replies_in_timeline') }}
        <template #description>
          {{ $t('settings.preferences.hide_replies_in_timeline_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'hideBoostsInTimeline')"
        @click="togglePreferences('hideBoostsInTimeline')"
      >
        {{ $t('settings.preferences.hide_boosts_in_timeline') }}
        <template #description>
          {{ $t('settings.preferences.hide_boosts_in_timeline_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'disableTimelineAutoloading')"
        @click="togglePreferences('disableTimelineAutoloading')"
      >
        {{ $t('settings.preferences.disable_timeline_autoloading') }}
        <template #description>
          {{ $t('settings.preferences.disable_timeline_autoloading_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'zenMode')"
        @click="togglePreferences('zenMode')"
      >
        {{ $t("settings.preferences.zen_mode") }}
        <template #description>
          {{ $t('settings.preferences.zen_mode_description') }}
        </template>
      </SettingsToggleItem>
    </section>
    <section>
      <h2 px6 py4 mt2 font-bold text-xl flex="~ gap-1" items-center>
        <span aria-hidden="true" block i-ri-flask-line />
        {{ $t('settings.preferences.title') }}
      </h2>
      <!-- Embedded Media -->
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'experimentalEmbeddedMedia')"
        @click="togglePreferences('experimentalEmbeddedMedia')"
      >
        {{ $t('settings.preferences.embedded_media') }}
        <template #description>
          {{ $t('settings.preferences.embedded_media_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'experimentalVirtualScroller')"
        @click="togglePreferences('experimentalVirtualScroller')"
      >
        {{ $t('settings.preferences.virtual_scroll') }}
        <template #description>
          {{ $t('settings.preferences.virtual_scroll_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'experimentalGitHubCards')"
        @click="togglePreferences('experimentalGitHubCards')"
      >
        {{ $t('settings.preferences.github_cards') }}
        <template #description>
          {{ $t('settings.preferences.github_cards_description') }}
        </template>
      </SettingsToggleItem>
      <SettingsToggleItem
        :checked="getPreferences(userSettings, 'experimentalUserPicker')"
        @click="togglePreferences('experimentalUserPicker')"
      >
        {{ $t('settings.preferences.user_picker') }}
        <template #description>
          {{ $t('settings.preferences.user_picker_description') }}
        </template>
      </SettingsToggleItem>
    </section>
  </MainContent>
</template>
