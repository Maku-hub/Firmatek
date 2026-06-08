import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../../store'
import { wsService } from '../../services/websocket'
import { webrtcService } from '../../services/webrtc'
import { loadSettings } from '../Settings/SettingsModal'
import { getMessages } from '../../services/api'
import type { Message } from '../../types'
import type { IncomingOffer } from '../../services/webrtc'
import CodeBlock from './CodeBlock'
import FileTransferBar from './FileTransferBar'
import EmojiPicker from './EmojiPicker'
import SearchPanel from './SearchPanel'
import ConfirmDialog from '../UI/ConfirmDialog'

export default function ChatWindow() {
  const { currentUser, activeChannelId, channels, messages, users, typing, transfers } = useStore()
  const setTransfer = useStore((s) => s.setTransfer)
  const removeTransfer = useStore((s) => s.removeTransfer)
  const setMessages = useStore((s) => s.setMessages)
  const setActiveChannel = useStore((s) => s.setActiveChannel)
  const clearUnread = useStore((s) => s.clearUnread)

  const [text, setText] = useState('')
  const [codeMode, setCodeMode] = useState(false)
  const [codeLang, setCodeLang] = useState('typescript')
  const [dragging, setDragging] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [scrollToMsgId, setScrollToMsgId] = useState<string | null>(null)

  const [incomingOffer, setIncomingOffer] = useState<{ offer: IncomingOffer; senderName: string } | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const channel = channels.find((c) => c.id === activeChannelId)
  const channelMessages = activeChannelId ? (messages[activeChannelId] ?? []) : []
  const isDM = channel?.is_direct ?? false
  const activeTransfers = Object.entries(transfers)

  // Nasłuchuj przychodzących plików WebRTC
  useEffect(() => {
    const handler = (e: Event) => {
      const { offer, senderName } = (e as CustomEvent).detail
      setIncomingOffer({ offer, senderName })
    }
    window.addEventListener('rtc-incoming', handler)
    return () => window.removeEventListener('rtc-incoming', handler)
  }, [])

  // Auto-scroll do dołu
  useEffect(() => {
    if (!scrollToMsgId) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [channelMessages.length, scrollToMsgId])

  // Scroll do konkretnej wiadomości z wyszukiwarki
  useEffect(() => {
    if (!scrollToMsgId) return
    let attempts = 0
    const maxAttempts = 30 // ~2 sekundy
    let rafId = 0

    const tryScroll = () => {
      const el = messagesRef.current?.querySelector(`[data-msg-id="${scrollToMsgId}"]`) as HTMLElement | null
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.outline = '2px solid #6366f1'
        el.style.outlineOffset = '4px'
        el.style.borderRadius = '12px'
        setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 2500)
        setScrollToMsgId(null)
      } else if (attempts < maxAttempts) {
        attempts++
        rafId = requestAnimationFrame(() => setTimeout(tryScroll, 60))
      } else {
        setScrollToMsgId(null) // element nie znaleziony po wielu próbach
      }
    }
    tryScroll()
    return () => cancelAnimationFrame(rafId)
  }, [scrollToMsgId, channelMessages])

  // Ctrl+F
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setShowSearch((v) => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const sendTyping = useCallback(() => {
    if (!activeChannelId) return
    wsService.send({ type: 'typing', channel_id: activeChannelId, payload: { typing: true } })
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => {
      wsService.send({ type: 'typing', channel_id: activeChannelId, payload: { typing: false } })
    }, 2000)
  }, [activeChannelId])

  const sendMessage = () => {
    if (!text.trim() || !activeChannelId) return
    wsService.send({
      type: 'chat_message', channel_id: activeChannelId,
      payload: {
        channel_id: activeChannelId, content: text,
        type: codeMode ? 'code_snippet' : 'text',
        ...(codeMode && { metadata: { language: codeLang } }),
      },
    })
    setText(''); setCodeMode(false); inputRef.current?.focus()
  }

  const settings = loadSettings()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (codeMode) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage() }
    } else {
      if (settings.sendOnEnter) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
      } else {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage() }
      }
    }
  }

  const insertEmoji = (emoji: string) => {
    setText((prev) => prev + emoji); setShowEmoji(false); inputRef.current?.focus()
  }

  // ─── Wszystkie pliki → P2P ──────────────────────────────────────────────────
  const setupProgressCallback = () => {
    webrtcService.setProgressCallback((state) => {
      setTransfer(state.id, { filename: state.filename, progress: state.progress, status: state.status, direction: state.direction })
      if (['done', 'error', 'declined', 'cancelled', 'timeout'].includes(state.status)) {
        setTimeout(() => removeTransfer(state.id), 4000)
      }
    })
  }

  const handleFile = async (file: File) => {
    if (!activeChannelId || !currentUser) return

    if (!isDM) {
      alert('Wysyłanie plików jest dostępne tylko w wiadomościach bezpośrednich (DM).')
      return
    }

    const recipientID = getDMRecipient()
    if (!recipientID) return

    const recipientOnline = useStore.getState().users[recipientID]?.online
    if (!recipientOnline) {
      wsService.send({
        type: 'chat_message', channel_id: activeChannelId,
        payload: {
          channel_id: activeChannelId,
          content: `⚠️ Nie można wysłać pliku „${file.name}" — odbiorca jest offline. Transfer P2P wymaga połączenia obu osób.`,
          type: 'text',
        },
      })
      return
    }

    setupProgressCallback()
    const sha256 = await computeSHA256(file)
    await webrtcService.sendFile(file, recipientID, sha256, currentUser.id)
  }

  const getDMRecipient = (): string | null => {
    if (!channel?.is_direct || !currentUser) return null
    const parts = channel.name.split(':')
    if (parts.length === 3) return parts[1] === currentUser.id ? parts[2] : parts[1]
    return null
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) { handleFile(file); e.preventDefault(); return }
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // Akceptowanie przychodzącego pliku WebRTC
  const handleAcceptFile = async () => {
    if (!incomingOffer) return
    const { offer } = incomingOffer
    setIncomingOffer(null)

    setupProgressCallback()

    try {
      const blob = await webrtcService.acceptIncoming(offer)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = offer.filename; a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[P2P] Błąd odbierania:', err)
    }
  }

  if (!activeChannelId || !channel) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
        <div style={{ color: '#444', fontSize: 16 }}>Wybierz kanał lub rozmowę</div>
      </div>
    )
  }

  const typingUsers = [...(typing[activeChannelId] ?? [])]
    .filter((id) => id !== currentUser?.id)
    .map((id) => users[id]?.display_name ?? 'ktoś')

  let channelTitle = channel.name
  if (channel.is_direct) {
    const parts = channel.name.split(':')
    if (parts.length === 3) {
      const otherId = parts[1] === currentUser?.id ? parts[2] : parts[1]
      channelTitle = users[otherId]?.display_name ?? 'Wiadomość bezpośrednia'
    }
  }

  const recipientOnline = isDM ? (users[getDMRecipient() ?? '']?.online ?? false) : null

  const placeholderText = codeMode
    ? 'Wklej kod… (Ctrl+Enter = wyślij)'
    : settings.sendOnEnter
      ? 'Napisz wiadomość… (Enter = wyślij, Shift+Enter = nowa linia)'
      : 'Napisz wiadomość… (Ctrl+Enter = wyślij, Enter = nowa linia)'

  return (
    <div style={{ ...s.chat, ...(dragging ? s.chatDragging : {}) }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}>

      {/* Header */}
      <div style={s.header}>
        <span style={s.channelName}>{channel.is_direct ? '👤' : '#'} {channelTitle}</span>
        {isDM && recipientOnline !== null && (
          <span style={s.statusBadge}>
            <span style={{ ...s.statusDotSmall, background: recipientOnline ? '#22c55e' : '#555' }} />
            <span style={{ color: recipientOnline ? '#22c55e' : '#666', fontSize: 12 }}>
              {recipientOnline ? 'online' : 'offline'}
            </span>
          </span>
        )}
        <button style={s.searchBtn} onClick={() => setShowSearch(!showSearch)} title="Szukaj wiadomości (Ctrl+F)">🔍</button>
      </div>

      {/* Transfer bars */}
      {activeTransfers.length > 0 && (
        <div style={{ padding: '6px 20px', background: '#13131c', borderBottom: '1px solid #1e1e2e' }}>
          {activeTransfers.map(([id, t]) => (
            <FileTransferBar key={id} transferId={id} {...t}
              onCancel={() => { webrtcService.cancelTransfer(id); removeTransfer(id) }} />
          ))}
        </div>
      )}

      {/* Messages */}
      <div ref={messagesRef} style={s.messages}>
        {channelMessages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} currentUserId={currentUser?.id ?? ''} users={users} />
        ))}
        <div ref={bottomRef} />
      </div>

      {typingUsers.length > 0 && (
        <div style={s.typingBar}>✏️ {typingUsers.join(', ')} {typingUsers.length === 1 ? 'pisze' : 'piszą'}…</div>
      )}

      {/* Input */}
      <div style={s.inputArea}>
        {codeMode && (
          <div style={s.codeModeBar}>
            <span style={{ color: '#aaa', fontSize: 12 }}>Tryb kodu – Ctrl+Enter = wyślij</span>
            <select style={s.langSelect} value={codeLang} onChange={(e) => setCodeLang(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <button style={s.closeCodeBtn} onClick={() => setCodeMode(false)}>✕</button>
          </div>
        )}
        <div style={s.inputRow}>
          {isDM && (
            <label style={s.iconBtn} title={recipientOnline ? 'Wyślij plik (P2P)' : 'Odbiorca offline – brak P2P'}>
              <span style={{ opacity: recipientOnline ? 1 : 0.4 }}>📎</span>
              <input type="file" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''
              }} />
            </label>
          )}
          <button style={{ ...s.iconBtn, ...(codeMode ? s.iconBtnActive : {}) }}
            onClick={() => setCodeMode(!codeMode)} title="Wstaw kod">{'</>'}</button>
          <div style={{ position: 'relative', flex: 1 }}>
            <textarea ref={inputRef}
              style={{ ...s.input, ...(codeMode ? s.inputCode : {}), width: '100%' }}
              value={text} onChange={(e) => { setText(e.target.value); sendTyping() }}
              onKeyDown={handleKeyDown} onPaste={handlePaste}
              placeholder={placeholderText} rows={codeMode ? 6 : 1} />
            {showEmoji && (
              <div style={s.emojiPopup}>
                <EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} />
              </div>
            )}
          </div>
          <button style={s.iconBtn} onClick={() => setShowEmoji(!showEmoji)} title="Emoji">😊</button>
          <button style={{ ...s.sendBtn, opacity: !text.trim() ? 0.4 : 1 }}
            onClick={sendMessage} disabled={!text.trim()}>➤</button>
        </div>
      </div>

      {dragging && (
        <div style={s.dropOverlay}>
          <div style={{ color: '#6366f1', fontSize: 24, fontWeight: 700 }}>⬆️ Upuść plik tutaj</div>
        </div>
      )}

      {incomingOffer && (
        <ConfirmDialog
          title="📨 Przychodzący plik"
          message={`${incomingOffer.senderName} chce wysłać:\n${incomingOffer.offer.filename} (${formatSize(incomingOffer.offer.fileSize)})\n\nCzy chcesz przyjąć?`}
          confirmLabel="Przyjmij" cancelLabel="Odrzuć"
          onConfirm={handleAcceptFile}
          onCancel={() => { webrtcService.declineIncoming(incomingOffer.offer); setIncomingOffer(null) }}
        />
      )}

      {showSearch && (
        <SearchPanel
          onClose={() => setShowSearch(false)}
          onGoToMessage={async (channelId, messageId) => {
            setActiveChannel(channelId)
            clearUnread(channelId)
            const msgs = await getMessages(channelId).catch(() => [])
            setMessages(channelId, msgs)
            setShowSearch(false)
            if (messageId) setScrollToMsgId(messageId)
          }}
        />
      )}
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, currentUserId, users }: {
  msg: Message; currentUserId: string; users: Record<string, any>
}) {
  const isMe = msg.sender_id === currentUserId
  const sender = msg.sender ?? users[msg.sender_id]

  const renderContent = () => {
    switch (msg.type) {
      case 'code_snippet':
        return <CodeBlock code={msg.content} language={msg.metadata?.language ?? 'text'} filename={msg.metadata?.filename} />
      case 'file_inline':
        return (
          <div>
            <img src={msg.content} alt={msg.metadata?.orig_name ?? 'obraz'}
              style={{ maxWidth: 400, maxHeight: 300, borderRadius: 8, display: 'block' }} />
            {msg.metadata?.orig_name && <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>{msg.metadata.orig_name}</div>}
          </div>
        )
      default:
        return (
          <span style={s.msgText}>
            {msg.content.split('\n').map((line, i, arr) => (
              <span key={i}>{line}{i < arr.length - 1 ? <br /> : null}</span>
            ))}
          </span>
        )
    }
  }

  return (
    <div data-msg-id={msg.id} style={{ ...s.message, ...(isMe ? s.messageMe : {}) }}>
      {!isMe && (
        <div style={{ width: 32, height: 32, borderRadius: '50%', background: sender?.avatar_color ?? '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
          {(sender?.display_name ?? '?')[0].toUpperCase()}
        </div>
      )}
      <div style={{ maxWidth: '70%' }}>
        {!isMe && <div style={s.senderName}>{sender?.display_name ?? 'Nieznany'}</div>}
        <div style={{ ...s.bubble, ...(isMe ? s.bubbleMe : s.bubbleThem) }}>
          {renderContent()}
        </div>
        <div style={s.timestamp}>
          {new Date(msg.created_at).toLocaleTimeString('pl', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

async function computeSHA256(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const LANGUAGES = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp', 'sql', 'bash', 'json', 'yaml', 'html', 'css', 'text']

const s: Record<string, React.CSSProperties> = {
  chat: { flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f13', position: 'relative', minWidth: 0 },
  chatDragging: { outline: '2px dashed #6366f1', outlineOffset: -2 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f0f13' },
  header: { padding: '14px 20px', borderBottom: '1px solid #1e1e2e', display: 'flex', alignItems: 'center', gap: 10 },
  channelName: { color: '#fff', fontWeight: 700, fontSize: 15, flex: 1 },
  statusBadge: { display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 12, background: '#1a1a2e' },
  statusDotSmall: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  searchBtn: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6, opacity: 0.5, flexShrink: 0 },
  messages: { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 2 },
  typingBar: { padding: '4px 20px', color: '#666', fontSize: 12, minHeight: 20 },
  inputArea: { padding: '10px 16px 14px', borderTop: '1px solid #1e1e2e' },
  codeModeBar: { display: 'flex', alignItems: 'center', gap: 8, background: '#1a1a2e', borderRadius: '8px 8px 0 0', padding: '6px 12px', borderBottom: '1px solid #333' },
  langSelect: { background: '#252535', border: '1px solid #333', borderRadius: 4, color: '#fff', fontSize: 12, padding: '2px 6px' },
  closeCodeBtn: { background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', marginLeft: 'auto' },
  inputRow: { display: 'flex', alignItems: 'flex-end', gap: 8 },
  iconBtn: { background: '#1a1a2e', border: 'none', color: '#888', cursor: 'pointer', padding: '8px 10px', borderRadius: 8, fontSize: 16, flexShrink: 0 },
  iconBtnActive: { background: '#6366f130', color: '#6366f1' },
  input: { background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: 8, padding: '10px 14px', color: '#fff', fontSize: 14, resize: 'none', outline: 'none', lineHeight: 1.5, fontFamily: 'inherit', boxSizing: 'border-box' },
  inputCode: { fontFamily: 'monospace', fontSize: 13 },
  sendBtn: { background: '#6366f1', border: 'none', color: '#fff', cursor: 'pointer', padding: '10px 14px', borderRadius: 8, fontSize: 18, flexShrink: 0 },
  emojiPopup: { position: 'absolute', bottom: '110%', right: 0, zIndex: 100 },
  message: { display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  messageMe: { flexDirection: 'row-reverse' },
  senderName: { color: '#888', fontSize: 12, marginBottom: 3, paddingLeft: 4 },
  bubble: { padding: '8px 14px', borderRadius: 12, wordBreak: 'break-word' },
  bubbleMe: { background: '#6366f1', borderTopRightRadius: 4 },
  bubbleThem: { background: '#1e1e30', borderTopLeftRadius: 4 },
  msgText: { color: '#e0e0e0', fontSize: 14, lineHeight: 1.5 },
  timestamp: { color: '#444', fontSize: 10, marginTop: 3, paddingLeft: 4 },
  dropOverlay: { position: 'absolute', inset: 0, background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
}
