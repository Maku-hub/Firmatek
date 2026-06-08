import { create } from 'zustand'
import type { User, Channel, Message } from '../types'

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
  addMessage: (msg: Message) => void
  setMessages: (channelId: string, msgs: Message[]) => void
  typing: Record<string, Set<string>>
  setTyping: (channelId: string, userId: string, isTyping: boolean) => void
  transfers: Record<string, { filename: string; progress: number; status: string; direction: string }>
  setTransfer: (id: string, data: { filename: string; progress: number; status: string; direction: string }) => void
  removeTransfer: (id: string) => void
  unread: Record<string, number>
  incrementUnread: (channelId: string) => void
  clearUnread: (channelId: string) => void
}

export const useStore = create<AppState>((set) => ({
  currentUser: null,
  setCurrentUser: (user) => set({ currentUser: user }),
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
  users: {},
  setUsers: (users) => {
    const map: Record<string, User> = {}
    for (const u of users) map[u.id] = u
    set({ users: map })
  },
  addUser: (user) =>
    set((state) => ({ users: { ...state.users, [user.id]: user } })),
  updateUserStatus: (userId, online, lastSeen) =>
    set((state) => {
      if (!state.users[userId]) return {}
      const updated = { ...state.users[userId], online }
      if (lastSeen) updated.last_seen = lastSeen
      else if (!online) updated.last_seen = new Date().toISOString()
      return { users: { ...state.users, [userId]: updated } }
    }),
  channels: [],
  activeChannelId: null,
  setChannels: (channels) => set({ channels }),
  addChannel: (channel) =>
    set((state) => ({
      channels: state.channels.find((c) => c.id === channel.id) ? state.channels : [...state.channels, channel],
    })),
  removeChannel: (channelId) =>
    set((state) => ({ channels: state.channels.filter((c) => c.id !== channelId) })),
  setActiveChannel: (id) => set({ activeChannelId: id }),
  messages: {},
  addMessage: (msg) =>
    set((state) => {
      const existing = state.messages[msg.channel_id] ?? []
      if (existing.some((m) => m.id === msg.id)) return {}
      return { messages: { ...state.messages, [msg.channel_id]: [...existing, msg] } }
    }),
  setMessages: (channelId, msgs) =>
    set((state) => ({ messages: { ...state.messages, [channelId]: msgs } })),
  typing: {},
  setTyping: (channelId, userId, isTyping) =>
    set((state) => {
      const current = new Set(state.typing[channelId] ?? [])
      isTyping ? current.add(userId) : current.delete(userId)
      return { typing: { ...state.typing, [channelId]: current } }
    }),
  transfers: {},
  setTransfer: (id, data) => set((state) => ({ transfers: { ...state.transfers, [id]: data } })),
  removeTransfer: (id) =>
    set((state) => { const t = { ...state.transfers }; delete t[id]; return { transfers: t } }),
  unread: {},
  incrementUnread: (channelId) =>
    set((state) => ({ unread: { ...state.unread, [channelId]: (state.unread[channelId] ?? 0) + 1 } })),
  clearUnread: (channelId) =>
    set((state) => ({ unread: { ...state.unread, [channelId]: 0 } })),
}))
