import type { mastodon } from 'masto'
import type { ForYouEngagementKind } from '~/composables/for-you/signals'

type Action = 'reblogged' | 'favourited' | 'bookmarked' | 'pinned' | 'muted'
type CountField = 'reblogsCount' | 'favouritesCount' | 'quotesCount'

/**
 * Actions that feed the "For You" viewer model. Taking the action appends to
 * the engagement sequence, taking it back removes that entry again — the
 * sequence is the source of truth, so an undo has to be a real deletion.
 */
const FOR_YOU_ENGAGEMENTS = {
  favourited: 'favourite',
  reblogged: 'reblog',
  bookmarked: 'bookmark',
} as const satisfies Partial<Record<Action, ForYouEngagementKind>>

export interface StatusActionsProps {
  status: mastodon.v1.Status
}

export function useStatusActions(props: StatusActionsProps) {
  const status = ref<mastodon.v1.Status>({ ...props.status })
  const { client } = useMasto()

  watch(
    () => props.status,
    val => status.value = { ...val },
    { deep: true, immediate: true },
  )

  // Use different states to let the user press different actions right after the other
  const isLoading = ref({
    reblogged: false,
    favourited: false,
    bookmarked: false,
    pinned: false,
    translation: false,
    muted: false,
  })

  async function toggleStatusAction(action: Action, fetchNewStatus: () => Promise<mastodon.v1.Status>, countField?: CountField) {
    // check login
    if (!checkLogin())
      return

    const prevCount = countField ? status.value[countField] : undefined

    isLoading.value[action] = true
    const isCancel = status.value[action]
    fetchNewStatus().then((newStatus) => {
      // when the action is cancelled, the count is not updated highly likely (if they're the same)
      // issue of Mastodon API
      if (isCancel && countField && prevCount === newStatus[countField])
        newStatus[countField] -= 1

      Object.assign(status.value, newStatus)
      cacheStatus(newStatus, undefined, true)
    }).catch((error) => {
      // The request failed, so the engagement never happened: undo the optimistic
      // write into the For You viewer model, or a network blip would leave a
      // favourite in the sequence forever.
      rollbackForYouEngagement(action, isCancel)
      console.error(error)
    }).finally(() => {
      isLoading.value[action] = false
    })
    // Optimistic update
    status.value[action] = !status.value[action]
    cacheStatus(status.value, undefined, true)
    if (countField)
      status.value[countField] += status.value[action] ? 1 : -1

    applyForYouEngagement(action, isCancel)
  }

  function forYouEngagementFor(action: Action): ForYouEngagementKind | undefined {
    return FOR_YOU_ENGAGEMENTS[action as keyof typeof FOR_YOU_ENGAGEMENTS]
  }

  function applyForYouEngagement(action: Action, isCancel: boolean | null | undefined) {
    const engagement = forYouEngagementFor(action)
    if (!engagement)
      return
    if (isCancel)
      forgetEngagement(status.value, engagement)
    else
      recordEngagement(status.value, engagement)
  }

  /** Same call with the sense flipped — the action did not happen after all. */
  function rollbackForYouEngagement(action: Action, isCancel: boolean | null | undefined) {
    applyForYouEngagement(action, !isCancel)
  }

  const toggleFavourite = () => toggleStatusAction(
    'favourited',
    () => client.value.v1.statuses.$select(status.value.id)[status.value.favourited ? 'unfavourite' : 'favourite'](),
    'favouritesCount',
  )

  const canReblog = computed(() =>
    status.value.visibility !== 'direct'
    && (status.value.visibility !== 'private' || status.value.account.id === currentUser.value?.account.id),
  )

  const toggleReblog = () => toggleStatusAction(
    'reblogged',
    () => client.value.v1.statuses.$select(status.value.id)[status.value.reblogged ? 'unreblog' : 'reblog']().then((res) => {
      if (status.value.reblogged)
        // returns the original status
        return res.reblog!
      return res
    }),
    'reblogsCount',
  )

  const canQuote = computed(() => {
    if (status.value.visibility === 'private' || status.value.visibility === 'direct')
      return false

    return status.value.quoteApproval?.currentUser === 'automatic' || status.value.quoteApproval?.currentUser === 'manual'
  })

  const composeWithQuote = () => navigateTo(`/compose?quote=${status.value.id}`)

  const toggleBookmark = () => toggleStatusAction(
    'bookmarked',
    () => client.value.v1.statuses.$select(status.value.id)[status.value.bookmarked ? 'unbookmark' : 'bookmark'](),
  )

  const togglePin = async () => toggleStatusAction(
    'pinned',
    () => client.value.v1.statuses.$select(status.value.id)[status.value.pinned ? 'unpin' : 'pin'](),
  )

  const toggleMute = async () => toggleStatusAction(
    'muted',
    () => client.value.v1.statuses.$select(status.value.id)[status.value.muted ? 'unmute' : 'mute'](),
  )

  return {
    status,
    isLoading,
    canQuote,
    canReblog,
    toggleMute,
    toggleReblog,
    toggleFavourite,
    toggleBookmark,
    togglePin,
    composeWithQuote,
  }
}
