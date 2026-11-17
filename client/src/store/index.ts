import { create } from 'zustand'
import type { User, Channel, Message, PendingMessage } from '../types'

export interface Transfer {
  filename: string
  progress: number
  status: string
  direction: string
}

interface AppState {
  currentUser: User | null
  setCurrentUser: (user: User | null) => void
  wsConnected: boolean
  setWsConnected: (v: boolean) => void
  users: Record<string, User>
  setUsers: (users: User[]) => void
  addUser: (user: User) => void
  updateUserStatus: (userId: string, online: boolean, lastSeen?: string) => void
  channels: Channel[]
  activeChannelId: string | null
  setChannels: (channels: Channel[]) => void
  addChannel: (channel: Channel) => void
  removeChannel: (channelId: string) => void
  setActiveChannel: (id: string | null) => void
  messages: Record<string, Message[]>
  /** Whether older history may still exist on the server, per channel. */
  hasMore: Record<string, boolean>
  addMessage: (msg: Message) => void
  /** Merges the newest page of a channel into what is already loaded. */
  mergeLatest: (channelId: string, page: Message[], pageSize: number) => void
  prependMessages: (channelId: string, older: Message[], pageSize: number) => void
  /** Outgoing messages not yet confirmed by the server (see services/outbox). */
  pending: PendingMessage[]
  setPending: (pending: PendingMessage[]) => void
  typing: Record<string, string[]>
  setTyping: (channelId: string, userId: string, isTyping: boolean) => void
  transfers: Record<string, Transfer>
  setTransfer: (id: string, data: Transfer) => void
  removeTransfer: (id: string) => void
  unread: Record<string, number>
  incrementUnread: (channelId: string) => void
  clearUnread: (channelId: string) => void
  reset: () => void
}

const byTime = (a: Message, b: Message) =>
  a.created_at === b.created_at ? a.id.localeCompare(b.id) : Date.parse(a.created_at) - Date.parse(b.created_at)

function merge(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing
  const ids = new Set(existing.map((m) => m.id))
  const fresh = incoming.filter((m) => !ids.has(m.id))
  if (fresh.length === 0) return existing
  return [...existing, ...fresh].sort(byTime)
}

const initialData = {
  currentUser: null,
  wsConnected: false,
  users: {},
  channels: [],
  activeChannelId: null,
  messages: {},
  hasMore: {},
  pending: [],
  typing: {},
  transfers: {},
  unread: {},
}

export const useStore = create<AppState>((set) => ({
  ...initialData,
  setCurrentUser: (user) => set({ currentUser: user }),
  setWsConnected: (v) => set({ wsConnected: v }),
  setUsers: (users) => set({ users: Object.fromEntries(users.map((u) => [u.id, u])) }),
  addUser: (user) => set((state) => ({ users: { ...state.users, [user.id]: user } })),
  updateUserStatus: (userId, online, lastSeen) =>
    set((state) => {
      const user = state.users[userId]
      if (!user) return {}
      const last_seen = lastSeen ?? (online ? user.last_seen : new Date().toISOString())
      return { users: { ...state.users, [userId]: { ...user, online, last_seen } } }
    }),
  setChannels: (channels) => set({ channels }),
  addChannel: (channel) =>
    set((state) => (state.channels.some((c) => c.id === channel.id) ? {} : { channels: [...state.channels, channel] })),
  removeChannel: (channelId) =>
    set((state) => ({ channels: state.channels.filter((c) => c.id !== channelId) })),
  setActiveChannel: (id) => set({ activeChannelId: id }),
  addMessage: (msg) =>
    set((state) => {
      const existing = state.messages[msg.channel_id] ?? []
      const next = merge(existing, [msg])
      return next === existing ? {} : { messages: { ...state.messages, [msg.channel_id]: next } }
    }),
  mergeLatest: (channelId, page, pageSize) =>
    set((state) => {
      const existing = state.messages[channelId]
      const next = merge(existing ?? [], page)
      // Only the first load decides whether there is more history; later
      // refreshes must not hide the "load earlier" button.
      const hasMore = existing === undefined ? page.length >= pageSize : (state.hasMore[channelId] ?? false)
      return {
        messages: { ...state.messages, [channelId]: next },
        hasMore: { ...state.hasMore, [channelId]: hasMore },
      }
    }),
  prependMessages: (channelId, older, pageSize) =>
    set((state) => ({
      messages: { ...state.messages, [channelId]: merge(state.messages[channelId] ?? [], older) },
      hasMore: { ...state.hasMore, [channelId]: older.length >= pageSize },
    })),
  setPending: (pending) => set({ pending }),
  setTyping: (channelId, userId, isTyping) =>
    set((state) => {
      const current = state.typing[channelId] ?? []
      const has = current.includes(userId)
      if (has === isTyping) return {}
      const next = isTyping ? [...current, userId] : current.filter((id) => id !== userId)
      return { typing: { ...state.typing, [channelId]: next } }
    }),
  setTransfer: (id, data) => set((state) => ({ transfers: { ...state.transfers, [id]: data } })),
  removeTransfer: (id) =>
    set((state) => {
      if (!(id in state.transfers)) return {}
      const { [id]: _, ...rest } = state.transfers
      return { transfers: rest }
    }),
  incrementUnread: (channelId) =>
    set((state) => ({ unread: { ...state.unread, [channelId]: (state.unread[channelId] ?? 0) + 1 } })),
  clearUnread: (channelId) =>
    set((state) => (state.unread[channelId] ? { unread: { ...state.unread, [channelId]: 0 } } : {})),
  // Clears everything that belongs to the signed-in user (on logout), so the
  // next account does not see the previous one's messages.
  reset: () => set(initialData),
}))
