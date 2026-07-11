import { useEffect, useState } from 'react'
import { useStore } from './store'
import { wsService } from './services/websocket'
import { webrtcService } from './services/webrtc'
import { getMe, getUsers, getChannels, getToken, logout, getAuthConfig } from './services/api'
import { loadSettings, applyScale } from './components/Settings/SettingsModal'
import AuthScreen from './components/Auth/AuthScreen'
import Sidebar from './components/Layout/Sidebar'
import ChatWindow from './components/Chat/ChatWindow'
import SettingsModal from './components/Settings/SettingsModal'
import type { WSMessage, UserStatusPayload, Message, User, Channel } from './types'
import type { IncomingOffer } from './services/webrtc'
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { t } from './i18n'

// Short notification sound (Web Audio API – no files required)
let audioCtx: AudioContext | null = null
function playNotifSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext()
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
  } catch { /* no audio – ignore */ }
}

// OS system notification (Tauri plugin-notification)
async function showSystemNotification(message: Message) {
  try {
    let ok = await isPermissionGranted()
    if (!ok) {
      const perm = await requestPermission()
      ok = perm === 'granted'
    }
    if (!ok) return
    const sender = useStore.getState().users[message.sender_id]
    const title = sender?.display_name ?? t('app.newMessage')
    const body = message.type === 'code_snippet'
      ? t('app.codeSnippet')
      : message.content.length > 120
        ? message.content.slice(0, 120) + '…'
        : message.content
    sendNotification({ title, body })
  } catch { /* plugin unavailable in dev – ignore */ }
}

async function requestNotifPermission() {
  try {
    const ok = await isPermissionGranted()
    if (!ok) await requestPermission()
  } catch { /* ignore */ }
}

export default function App() {
  const {
    currentUser, setCurrentUser, wsConnected, setWsConnected,
    setUsers, addUser, setChannels, addChannel, addMessage, updateUserStatus,
    setTyping, incrementUnread,
  } = useStore()

  const [booting, setBooting] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [appName, setAppName] = useState('Firmatek')

  // Apply the scale on startup – ONLY when logged in
  useEffect(() => {
    if (currentUser) applyScale(loadSettings().uiScale)
    else applyScale(100) // reset on logout
  }, [currentUser])

  useEffect(() => {
    const token = getToken()
    if (!token) { setBooting(false); return }
    getMe()
      .then((user) => {
        setCurrentUser(user)
        return Promise.all([getUsers(), getChannels(), getAuthConfig()])
      })
      .then(([users, channels, cfg]) => {
        setUsers(users)
        setChannels(channels)
        setAppName(cfg.app_name)
        requestNotifPermission()
        setTimeout(() => wsService.connect(), 100)
      })
      .catch(() => logout())
      .finally(() => setBooting(false))
  }, [])

  const handleAuth = async (user: typeof currentUser) => {
    setCurrentUser(user)
    try {
      const [users, channels, cfg] = await Promise.all([getUsers(), getChannels(), getAuthConfig()])
      setUsers(users)
      setChannels(channels)
      setAppName(cfg.app_name)
      requestNotifPermission()
      setTimeout(() => wsService.connect(), 100)
    } catch {
      // Failed to initialize after auth – drop back to the login screen.
      logout()
      setCurrentUser(null)
    }
  }

  const handleLogout = () => {
    wsService.disconnect()
    logout()
    setCurrentUser(null)
  }

  useEffect(() => {
    if (!currentUser) return
    // Track auto-clear timers for typing indicators so they don't leak or fire
    // after the effect is torn down.
    const typingTimers = new Set<ReturnType<typeof setTimeout>>()
    const unsubs = [
      wsService.on('connected', () => setWsConnected(true)),
      wsService.on('disconnected', () => setWsConnected(false)),
      wsService.on('chat_message', (msg: WSMessage) => {
        const message = msg.payload as Message
        addMessage(message)
        // Read the active channel live (via getState) so this subscription does
        // not need to be torn down and recreated on every channel switch.
        const active = useStore.getState().activeChannelId
        if (message.channel_id !== active && message.sender_id !== currentUser?.id) {
          incrementUnread(message.channel_id)
          if (loadSettings().notifSound) {
            playNotifSound()
          }
          showSystemNotification(message)
        }
      }),
      wsService.on('user_status', (msg: WSMessage) => {
        const p = msg.payload as UserStatusPayload
        updateUserStatus(p.user_id, p.online, p.last_seen)
      }),
      wsService.on('typing', (msg: WSMessage) => {
        const p = msg.payload as { typing: boolean }
        if (msg.sender_id && msg.channel_id) {
          setTyping(msg.channel_id, msg.sender_id, p.typing)
          const t = setTimeout(() => {
            setTyping(msg.channel_id!, msg.sender_id!, false)
            typingTimers.delete(t)
          }, 3000)
          typingTimers.add(t)
        }
      }),
      wsService.on('user_new', (msg: WSMessage) => {
        const user = msg.payload as User
        addUser(user)
      }),
      wsService.on('channel_added', (msg: WSMessage) => {
        const channel = msg.payload as Channel
        addChannel(channel)
      }),
    ]

    webrtcService.setIncomingCallback((offer: IncomingOffer) => {
      const senderName = useStore.getState().users[offer.fromUserID]?.display_name ?? offer.fromUserID
      window.dispatchEvent(new CustomEvent('rtc-incoming', { detail: { offer, senderName } }))
    })

    return () => {
      unsubs.forEach((u) => u())
      typingTimers.forEach((t) => clearTimeout(t))
    }
  }, [currentUser])

  if (booting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f0f13', color: '#888', fontSize: 16 }}>
        {t('app.loading')}
      </div>
    )
  }

  if (!currentUser) return <AuthScreen onAuth={(u) => handleAuth(u)} />

  return (
    // id="app-wrapper" – only this element is scaled by the settings
    <div id="app-wrapper" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: '#0f0f13' }}>
      {!wsConnected && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, background: '#3f1515', color: '#ff6b6b', textAlign: 'center', padding: '6px 16px', fontSize: 13 }}>
          {t('app.noConnection')}
        </div>
      )}
      <Sidebar currentUser={currentUser} onLogout={handleLogout} onOpenSettings={() => setShowSettings(true)} appName={appName} />
      <ChatWindow />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
