import { useCallback, useEffect, useState } from 'react'
import { useStore } from './store'
import { wsService } from './services/websocket'
import { webrtcService } from './services/webrtc'
import { outbox } from './services/outbox'
import {
  getUsers, getChannels, getToken, logout, getAuthConfig, getMessages, getMe, refreshToken,
  ApiError, PAGE_SIZE, SESSION_EXPIRED_EVENT,
} from './services/api'
import { loadSettings, applyScale } from './components/Settings/SettingsModal'
import AuthScreen from './components/Auth/AuthScreen'
import Sidebar from './components/Layout/Sidebar'
import ChatWindow from './components/Chat/ChatWindow'
import IncomingFiles from './components/Chat/IncomingFiles'
import SettingsModal from './components/Settings/SettingsModal'
import type { WSMessage, UserStatusPayload, Message, User, Channel } from './types'
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { t } from './i18n'

const TOKEN_REFRESH_INTERVAL = 6 * 60 * 60_000
const TYPING_TIMEOUT = 4000
// Messages older than this when they arrive were queued while we were offline;
// they still count as unread but do not ring or pop up one by one.
const LIVE_MESSAGE_AGE = 2 * 60_000
const SOUND_COOLDOWN = 1500
const FINISHED_TRANSFER = ['done', 'error', 'declined', 'cancelled', 'timeout']

let audioCtx: AudioContext | null = null
let lastSound = 0
function playNotificationSound() {
  const now = Date.now()
  if (now - lastSound < SOUND_COOLDOWN) return
  lastSound = now
  try {
    audioCtx ??= new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.frequency.setValueAtTime(880, audioCtx.currentTime)
    osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.2)
  } catch { /* no audio device */ }
}

let notificationsAllowed: boolean | null = null
async function ensureNotificationPermission(): Promise<boolean> {
  if (notificationsAllowed !== null) return notificationsAllowed
  try {
    notificationsAllowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  } catch {
    notificationsAllowed = false // plugin missing, e.g. in a plain browser
  }
  return notificationsAllowed
}

async function showSystemNotification(message: Message) {
  if (!(await ensureNotificationPermission())) return
  const sender = message.sender?.display_name ?? useStore.getState().users[message.sender_id]?.display_name
  const body = message.type === 'code_snippet'
    ? t('app.codeSnippet')
    : message.content.length > 120 ? message.content.slice(0, 120) + '…' : message.content
  try {
    sendNotification({ title: sender ?? t('app.newMessage'), body })
  } catch { /* ignore */ }
}

/** Loads everything the main screen needs after signing in. */
async function loadWorkspace() {
  const [users, channels, cfg] = await Promise.all([getUsers(), getChannels(), getAuthConfig()])
  const store = useStore.getState()
  store.setUsers(users)
  store.setChannels(channels)
  return cfg.app_name
}

export default function App() {
  const currentUser = useStore((s) => s.currentUser)
  const wsConnected = useStore((s) => s.wsConnected)
  const setCurrentUser = useStore((s) => s.setCurrentUser)

  const [booting, setBooting] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [appName, setAppName] = useState('Firmatek')

  // UI scaling applies to the main window only, not the login screen.
  useEffect(() => {
    applyScale(currentUser ? loadSettings().uiScale : 100)
  }, [currentUser])

  const signOut = useCallback(() => {
    const userId = useStore.getState().currentUser?.id
    wsService.disconnect()
    outbox.stop()
    // Unsent messages must not stay on a shared computer after logout.
    if (userId) outbox.clear(userId)
    logout()
    useStore.getState().reset()
  }, [])

  const enterWorkspace = useCallback(async (user: User) => {
    setCurrentUser(user)
    try {
      setAppName(await loadWorkspace())
      ensureNotificationPermission()
      wsService.connect()
    } catch {
      signOut()
    }
  }, [setCurrentUser, signOut])

  // Resume the previous session on start-up. Refreshing the token doubles as
  // the "who am I" check and extends the session.
  useEffect(() => {
    if (!getToken()) { setBooting(false); return }
    refreshToken()
      // Servers older than the refresh endpoint answer 404; fall back to /me.
      .catch((err) => (err instanceof ApiError && err.status === 404 ? getMe() : Promise.reject(err)))
      .then(enterWorkspace)
      .catch(() => logout())
      .finally(() => setBooting(false))
  }, [enterWorkspace])

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, signOut)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, signOut)
  }, [signOut])

  useEffect(() => {
    if (!currentUser) return
    const timer = setInterval(() => {
      refreshToken().then(setCurrentUser).catch((err) => {
        if (err instanceof ApiError && err.status === 401) signOut()
      })
    }, TOKEN_REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [currentUser?.id, setCurrentUser, signOut])

  useEffect(() => {
    if (!currentUser) return
    const store = useStore.getState
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
    outbox.start(currentUser.id)

    const unsubs = [
      wsService.on('connected', async (msg) => {
        store().setWsConnected(true)
        if (!(msg.payload as { reconnect?: boolean })?.reconnect) return
        // Presence and messages may have changed while we were away.
        try {
          await loadWorkspace()
          const active = store().activeChannelId
          if (active) store().mergeLatest(active, await getMessages(active), PAGE_SIZE)
        } catch { /* next reconnect will try again */ }
      }),
      wsService.on('disconnected', () => store().setWsConnected(false)),
      wsService.on('chat_message', (msg: WSMessage) => {
        const message = msg.payload as Message
        const s = store()
        s.addMessage(message)
        if (message.sender_id === currentUser.id) return

        const inActiveChannel = message.channel_id === s.activeChannelId
        const windowFocused = document.hasFocus()
        if (!inActiveChannel) s.incrementUnread(message.channel_id)
        if (inActiveChannel && windowFocused) return
        if (Date.now() - Date.parse(message.created_at) > LIVE_MESSAGE_AGE) return

        if (loadSettings().notifSound) playNotificationSound()
        if (!windowFocused) showSystemNotification(message)
      }),
      wsService.on('user_status', (msg: WSMessage) => {
        const p = msg.payload as UserStatusPayload
        store().updateUserStatus(p.user_id, p.online, p.last_seen)
      }),
      wsService.on('typing', (msg: WSMessage) => {
        const { sender_id: userId, channel_id: channelId } = msg
        if (!userId || !channelId) return
        const typing = (msg.payload as { typing?: boolean })?.typing === true
        const key = `${channelId}:${userId}`
        clearTimeout(typingTimers.get(key))
        typingTimers.delete(key)
        store().setTyping(channelId, userId, typing)
        if (typing) {
          // Fallback in case the "stopped typing" event never arrives.
          typingTimers.set(key, setTimeout(() => {
            typingTimers.delete(key)
            store().setTyping(channelId, userId, false)
          }, TYPING_TIMEOUT))
        }
      }),
      wsService.on('user_new', (msg: WSMessage) => store().addUser(msg.payload as User)),
      wsService.on('channel_added', (msg: WSMessage) => store().addChannel(msg.payload as Channel)),
    ]

    webrtcService.setProgressCallback((state) => {
      const { setTransfer, removeTransfer } = store()
      setTransfer(state.id, {
        filename: state.filename, progress: state.progress, status: state.status, direction: state.direction,
      })
      if (FINISHED_TRANSFER.includes(state.status)) setTimeout(() => removeTransfer(state.id), 4000)
    })

    return () => {
      unsubs.forEach((u) => u())
      typingTimers.forEach((timer) => clearTimeout(timer))
      outbox.stop()
    }
  }, [currentUser?.id])

  if (booting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f0f13', color: '#888', fontSize: 16 }}>
        {t('app.loading')}
      </div>
    )
  }

  if (!currentUser) return <AuthScreen onAuth={enterWorkspace} />

  return (
    // Only #app-wrapper is scaled by the UI scale setting.
    <div id="app-wrapper" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: '#0f0f13' }}>
      {!wsConnected && (
        <div role="status" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, background: '#3f1515', color: '#ff6b6b', textAlign: 'center', padding: '6px 16px', fontSize: 13 }}>
          {t('app.noConnection')}
        </div>
      )}
      <Sidebar currentUser={currentUser} onLogout={signOut} onOpenSettings={() => setShowSettings(true)} appName={appName} />
      <ChatWindow />
      <IncomingFiles />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
