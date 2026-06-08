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

// Krótki dźwięk powiadomienia (Web Audio API – nie wymaga plików)
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
  } catch { /* brak audio – ignoruj */ }
}

// Powiadomienie systemowe OS (Tauri plugin-notification)
async function showSystemNotification(message: Message) {
  try {
    let ok = await isPermissionGranted()
    if (!ok) {
      const perm = await requestPermission()
      ok = perm === 'granted'
    }
    if (!ok) return
    const sender = useStore.getState().users[message.sender_id]
    const title = sender?.display_name ?? 'Nowa wiadomość'
    const body = message.type === 'code_snippet'
      ? '📋 Fragment kodu'
      : message.content.length > 120
        ? message.content.slice(0, 120) + '…'
        : message.content
    sendNotification({ title, body })
  } catch { /* plugin niedostępny w dev – ignoruj */ }
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
    setTyping, activeChannelId, incrementUnread,
  } = useStore()

  const [booting, setBooting] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [appName, setAppName] = useState('Firmatek')

  // Zastosuj skalę przy starcie – TYLKO gdy zalogowany
  useEffect(() => {
    if (currentUser) applyScale(loadSettings().uiScale)
    else applyScale(100) // reset przy wylogowaniu
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
    const [users, channels, cfg] = await Promise.all([getUsers(), getChannels(), getAuthConfig()])
    setUsers(users)
    setChannels(channels)
    setAppName(cfg.app_name)
    requestNotifPermission()
    setTimeout(() => wsService.connect(), 100)
  }

  const handleLogout = () => {
    wsService.disconnect()
    logout()
    setCurrentUser(null)
  }

  useEffect(() => {
    if (!currentUser) return
    const unsubs = [
      wsService.on('connected', () => setWsConnected(true)),
      wsService.on('disconnected', () => setWsConnected(false)),
      wsService.on('chat_message', (msg: WSMessage) => {
        const message = msg.payload as Message
        addMessage(message)
        if (message.channel_id !== activeChannelId && message.sender_id !== currentUser?.id) {
          incrementUnread(message.channel_id)
          // Dźwięk powiadomienia
          if (loadSettings().notifSound) {
            playNotifSound()
          }
          // Powiadomienie systemowe OS
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
          setTimeout(() => setTyping(msg.channel_id!, msg.sender_id!, false), 3000)
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

    return () => unsubs.forEach((u) => u())
  }, [currentUser, activeChannelId])

  if (booting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f0f13', color: '#888', fontSize: 16 }}>
        💬 Ładowanie…
      </div>
    )
  }

  if (!currentUser) return <AuthScreen onAuth={(u) => handleAuth(u)} />

  return (
    // id="app-wrapper" – tylko ten element jest skalowany przez ustawienia
    <div id="app-wrapper" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: '#0f0f13' }}>
      {!wsConnected && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, background: '#3f1515', color: '#ff6b6b', textAlign: 'center', padding: '6px 16px', fontSize: 13 }}>
          🔴 Brak połączenia z serwerem – próba ponownego połączenia…
        </div>
      )}
      <Sidebar currentUser={currentUser} onLogout={handleLogout} onOpenSettings={() => setShowSettings(true)} appName={appName} />
      <ChatWindow />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
