import { useStore } from '../store'
import { getMessages, PAGE_SIZE } from '../services/api'

/**
 * Makes a channel active and loads its latest messages. Messages that arrive
 * over the socket while the request is in flight are kept, not overwritten.
 */
export async function openChannel(channelId: string): Promise<void> {
  const { setActiveChannel, clearUnread } = useStore.getState()
  setActiveChannel(channelId)
  clearUnread(channelId)
  try {
    const page = await getMessages(channelId)
    useStore.getState().mergeLatest(channelId, page, PAGE_SIZE)
  } catch (err) {
    console.error('[chat] cannot load messages:', err)
  }
}
