import { memo, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../store'
import { wsService } from '../../services/websocket'
import { webrtcService } from '../../services/webrtc'
import { outbox } from '../../services/outbox'
import { loadSettings } from '../Settings/SettingsModal'
import { getMessages, PAGE_SIZE } from '../../services/api'
import type { Message, PendingMessage, User } from '../../types'
import { dmPartnerId } from '../../lib/dm'
import { openChannel } from '../../lib/channels'
import { formatMessageTime } from '../../lib/format'
import { t } from '../../i18n'
import CodeBlock from './CodeBlock'
import FileTransferBar from './FileTransferBar'
import EmojiPicker from './EmojiPicker'
import SearchPanel from './SearchPanel'

const EMPTY: Message[] = []
const EMPTY_IDS: string[] = []
// Send "typing" at most this often while the user keeps typing, and "stopped"
// after this much silence.
const TYPING_THROTTLE = 2500
const TYPING_IDLE = 2000

export default function ChatWindow() {
  const { currentUser, activeChannelId, channel, channelMessages, hasMore, users, typingIds, transfers, allPending } = useStore(
    useShallow((s) => ({
      currentUser: s.currentUser,
      activeChannelId: s.activeChannelId,
      channel: s.channels.find((c) => c.id === s.activeChannelId),
      channelMessages: (s.activeChannelId && s.messages[s.activeChannelId]) || EMPTY,
      hasMore: s.activeChannelId ? s.hasMore[s.activeChannelId] ?? false : false,
      users: s.users,
      typingIds: (s.activeChannelId && s.typing[s.activeChannelId]) || EMPTY_IDS,
      transfers: s.transfers,
      allPending: s.pending,
    })),
  )
  const pending = allPending.filter((p) => p.channel_id === activeChannelId)
  const removeTransfer = useStore((s) => s.removeTransfer)
  const prependMessages = useStore((s) => s.prependMessages)

  const [text, setText] = useState('')
  const [codeMode, setCodeMode] = useState(false)
  const [codeLang, setCodeLang] = useState('typescript')
  const [dragging, setDragging] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [scrollToMsgId, setScrollToMsgId] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [notice, setNotice] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const typingSentAt = useRef(0)
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isDM = channel?.is_direct ?? false
  const recipientId = isDM && channel && currentUser ? dmPartnerId(channel.name, currentUser.id) : null
  const recipientOnline = recipientId ? users[recipientId]?.online ?? false : false
  const settings = loadSettings()

  // Stick to the bottom when a new message arrives or the channel changes, but
  // not when older history is prepended (that changes the first id, not the last).
  const lastMsgId = pending.length
    ? pending[pending.length - 1].client_id
    : channelMessages[channelMessages.length - 1]?.id
  useEffect(() => {
    if (!scrollToMsgId) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastMsgId, activeChannelId, scrollToMsgId])

  // Leaving a channel (or the window) must clear our typing indicator there.
  useEffect(() => () => stopTyping(activeChannelId), [activeChannelId])

  useEffect(() => { setNotice('') }, [activeChannelId])

  // Jump to a message picked in the search panel once it has rendered.
  useEffect(() => {
    if (!scrollToMsgId) return
    const el = messagesRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(scrollToMsgId)}"]`)
    if (!el) {
      // Older than the loaded history; give up rather than block auto-scroll.
      setScrollToMsgId(null)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.style.outline = '2px solid #6366f1'
    el.style.outlineOffset = '4px'
    const timer = setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 2500)
    setScrollToMsgId(null)
    return () => clearTimeout(timer)
  }, [scrollToMsgId, channelMessages])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setShowSearch((v) => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const loadOlder = async () => {
    if (!activeChannelId || loadingOlder || !channelMessages.length) return
    const channelId = activeChannelId
    setLoadingOlder(true)
    try {
      const older = await getMessages(channelId, channelMessages[0], PAGE_SIZE)
      const el = messagesRef.current
      const prevHeight = el?.scrollHeight ?? 0
      prependMessages(channelId, older, PAGE_SIZE)
      // Keep the viewport where it was instead of jumping to the new top.
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevHeight })
    } catch (err) {
      console.error('[chat] cannot load older messages:', err)
    } finally {
      setLoadingOlder(false)
    }
  }

  const onTextChange = (value: string) => {
    setText(value)
    if (!activeChannelId) return
    const now = Date.now()
    if (now - typingSentAt.current > TYPING_THROTTLE) {
      typingSentAt.current = now
      wsService.send({ type: 'typing', channel_id: activeChannelId, payload: { typing: true } })
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current)
    const channelId = activeChannelId
    typingIdleTimer.current = setTimeout(() => stopTyping(channelId), TYPING_IDLE)
  }

  function stopTyping(channelId: string | null) {
    if (typingIdleTimer.current) { clearTimeout(typingIdleTimer.current); typingIdleTimer.current = null }
    if (!channelId || !typingSentAt.current) return
    typingSentAt.current = 0
    wsService.send({ type: 'typing', channel_id: channelId, payload: { typing: false } })
  }

  const sendMessage = () => {
    if (!text.trim() || !activeChannelId) return
    stopTyping(activeChannelId)
    outbox.send(activeChannelId, text, codeMode ? 'code_snippet' : 'text', codeMode ? { language: codeLang } : undefined)
    setText(''); setCodeMode(false); inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const sendOnPlainEnter = settings.sendOnEnter && !codeMode
    if (sendOnPlainEnter ? !e.shiftKey : e.ctrlKey || e.metaKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    setShowEmoji(false)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + emoji.length, start + emoji.length)
    })
  }

  // Files always go peer-to-peer and never through the server.
  const handleFile = (file: File) => {
    if (!activeChannelId || !currentUser) return
    if (!isDM || !recipientId) { setNotice(t('chat.filesOnlyDM')); return }
    if (!recipientOnline) { setNotice(t('chat.cannotSendOffline', { name: file.name })); return }
    setNotice('')
    webrtcService.sendFile(file, recipientId)
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) { e.preventDefault(); handleFile(file); return }
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  if (!activeChannelId || !channel) {
    return (
      <div style={s.empty}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
        <div style={{ color: '#444', fontSize: 16 }}>{t('chat.selectChannel')}</div>
      </div>
    )
  }

  const typingUsers = typingIds
    .filter((id) => id !== currentUser?.id)
    .map((id) => users[id]?.display_name ?? t('chat.someone'))

  const channelTitle = channel.is_direct
    ? (recipientId && users[recipientId]?.display_name) || t('chat.directMessage')
    : channel.name

  const placeholderText = codeMode
    ? t('chat.placeholderCode')
    : settings.sendOnEnter ? t('chat.placeholderEnter') : t('chat.placeholderCtrlEnter')

  const activeTransfers = Object.entries(transfers)

  return (
    <div style={{ ...s.chat, ...(dragging ? s.chatDragging : {}) }}
      onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={handleDrop}>

      <div style={s.header}>
        <span style={s.channelName}>{channel.is_direct ? '👤' : '#'} {channelTitle}</span>
        {isDM && (
          <span style={s.statusBadge}>
            <span style={{ ...s.statusDotSmall, background: recipientOnline ? '#22c55e' : '#555' }} />
            <span style={{ color: recipientOnline ? '#22c55e' : '#666', fontSize: 12 }}>
              {recipientOnline ? t('chat.online') : t('chat.offline')}
            </span>
          </span>
        )}
        <button style={s.searchBtn} onClick={() => setShowSearch(!showSearch)} title={t('chat.searchTitle')} aria-label={t('chat.searchTitle')}>🔍</button>
      </div>

      {activeTransfers.length > 0 && (
        <div style={s.transfers}>
          {activeTransfers.map(([id, tr]) => (
            <FileTransferBar key={id} transferId={id} {...tr}
              onCancel={() => { webrtcService.cancelTransfer(id); removeTransfer(id) }} />
          ))}
        </div>
      )}

      <div ref={messagesRef} style={s.messages} role="log" aria-live="polite">
        {hasMore && channelMessages.length > 0 && (
          <button style={s.loadOlderBtn} onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? t('chat.loadingOlder') : t('chat.loadEarlier')}
          </button>
        )}
        {channelMessages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} isMe={msg.sender_id === currentUser?.id} fallbackSender={users[msg.sender_id]} />
        ))}
        {pending.map((p) => <PendingBubble key={p.client_id} pending={p} />)}
        <div ref={bottomRef} />
      </div>

      <div style={s.typingBar}>
        {typingUsers.length > 0 &&
          `✏️ ${typingUsers.join(', ')} ${typingUsers.length === 1 ? t('chat.isTyping') : t('chat.areTyping')}…`}
      </div>

      {notice && <div role="alert" style={s.notice} onClick={() => setNotice('')}>{notice}</div>}

      <div style={s.inputArea}>
        {codeMode && (
          <div style={s.codeModeBar}>
            <span style={{ color: '#aaa', fontSize: 12 }}>{t('chat.codeMode')}</span>
            <select style={s.langSelect} value={codeLang} onChange={(e) => setCodeLang(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <button style={s.closeCodeBtn} onClick={() => setCodeMode(false)} aria-label={t('confirm.cancel')}>✕</button>
          </div>
        )}
        <div style={s.inputRow}>
          {isDM && (
            <label style={s.iconBtn} title={recipientOnline ? t('chat.sendFileP2P') : t('chat.recipientOfflineNoP2P')}>
              <span style={{ opacity: recipientOnline ? 1 : 0.4 }}>📎</span>
              <input type="file" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''
              }} />
            </label>
          )}
          <button style={{ ...s.iconBtn, ...(codeMode ? s.iconBtnActive : {}) }}
            onClick={() => setCodeMode(!codeMode)} title={t('chat.insertCode')} aria-pressed={codeMode}>{'</>'}</button>
          <div style={{ position: 'relative', flex: 1 }}>
            <textarea ref={inputRef}
              style={{ ...s.input, ...(codeMode ? s.inputCode : {}), width: '100%' }}
              value={text} onChange={(e) => onTextChange(e.target.value)}
              onKeyDown={handleKeyDown} onPaste={handlePaste}
              placeholder={placeholderText} rows={codeMode ? 6 : 1} />
            {showEmoji && (
              <div style={s.emojiPopup}>
                <EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} />
              </div>
            )}
          </div>
          <button style={s.iconBtn} onClick={() => setShowEmoji(!showEmoji)} title={t('chat.emoji')} aria-label={t('chat.emoji')}>😊</button>
          <button style={{ ...s.sendBtn, opacity: !text.trim() ? 0.4 : 1 }}
            onClick={sendMessage} disabled={!text.trim()} aria-label={t('chat.send')}>➤</button>
        </div>
      </div>

      {dragging && (
        <div style={s.dropOverlay}>
          <div style={{ color: '#6366f1', fontSize: 24, fontWeight: 700 }}>{t('chat.dropFile')}</div>
        </div>
      )}

      {showSearch && (
        <SearchPanel
          onClose={() => setShowSearch(false)}
          onGoToMessage={async (channelId, messageId) => {
            setShowSearch(false)
            await openChannel(channelId)
            if (messageId) setScrollToMsgId(messageId)
          }}
        />
      )}
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({ msg, isMe, fallbackSender }: {
  msg: Message; isMe: boolean; fallbackSender?: User
}) {
  const name = msg.sender?.display_name || fallbackSender?.display_name
  const color = msg.sender?.avatar_color || fallbackSender?.avatar_color || '#6366f1'

  let content: React.ReactNode
  switch (msg.type) {
    case 'code_snippet':
      content = <CodeBlock code={msg.content} language={msg.metadata?.language ?? 'text'} filename={msg.metadata?.filename} />
      break
    case 'file_inline':
      // Older servers accepted inline images from clients; only render data
      // URLs so a message cannot load a remote (tracking) image.
      content = msg.content.startsWith('data:image/')
        ? <img src={msg.content} alt={msg.metadata?.orig_name ?? t('chat.image')} style={{ maxWidth: 400, maxHeight: 300, borderRadius: 8, display: 'block' }} />
        : <span style={s.msgText}>{msg.metadata?.orig_name ?? t('chat.image')}</span>
      break
    default:
      content = <span style={s.msgText}>{msg.content}</span>
  }

  return (
    <div data-msg-id={msg.id} style={{ ...s.message, ...(isMe ? s.messageMe : {}) }}>
      {!isMe && (
        <div style={{ ...s.avatar, background: color }} aria-hidden="true">
          {(name?.[0] ?? '?').toUpperCase()}
        </div>
      )}
      <div style={{ maxWidth: '70%', minWidth: 0 }}>
        {!isMe && <div style={s.senderName}>{name ?? t('chat.unknown')}</div>}
        <div style={{ ...s.bubble, ...(isMe ? s.bubbleMe : s.bubbleThem) }}>{content}</div>
        <div style={{ ...s.timestamp, ...(isMe ? { textAlign: 'right' as const } : {}) }}>
          <time dateTime={msg.created_at}>{formatMessageTime(msg.created_at)}</time>
        </div>
      </div>
    </div>
  )
})

function PendingBubble({ pending }: { pending: PendingMessage }) {
  const failed = pending.status === 'failed'
  return (
    <div style={{ ...s.message, ...s.messageMe }}>
      <div style={{ maxWidth: '70%', minWidth: 0 }}>
        <div style={{ ...s.bubble, ...s.bubbleMe, opacity: failed ? 1 : 0.6, ...(failed ? s.bubbleFailed : {}) }}>
          {pending.type === 'code_snippet'
            ? <CodeBlock code={pending.content} language={pending.metadata?.language ?? 'text'} />
            : <span style={s.msgText}>{pending.content}</span>}
        </div>
        <div style={{ ...s.timestamp, textAlign: 'right' }}>
          {failed ? (
            <span style={{ color: '#ef4444' }} role="alert">
              {pending.error ?? t('chat.notDelivered')}{' · '}
              <button style={s.linkBtn} onClick={() => outbox.retry(pending.client_id)}>{t('chat.retry')}</button>
              {' · '}
              <button style={s.linkBtn} onClick={() => outbox.discard(pending.client_id)}>{t('chat.discard')}</button>
            </span>
          ) : t('chat.sending')}
        </div>
      </div>
    </div>
  )
}

const LANGUAGES = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp', 'sql', 'bash', 'json', 'yaml', 'html', 'css', 'text']

const s: Record<string, React.CSSProperties> = {
  chat: { flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f13', position: 'relative', minWidth: 0 },
  chatDragging: { outline: '2px dashed #6366f1', outlineOffset: -2 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f0f13' },
  header: { padding: '14px 20px', borderBottom: '1px solid #1e1e2e', display: 'flex', alignItems: 'center', gap: 10 },
  channelName: { color: '#fff', fontWeight: 700, fontSize: 15, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusBadge: { display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 12, background: '#1a1a2e' },
  statusDotSmall: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  searchBtn: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6, opacity: 0.5, flexShrink: 0 },
  transfers: { padding: '6px 20px', background: '#13131c', borderBottom: '1px solid #1e1e2e' },
  messages: { flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 2 },
  loadOlderBtn: { alignSelf: 'center', margin: '4px 0 10px', background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#888', cursor: 'pointer', borderRadius: 8, padding: '5px 14px', fontSize: 12 },
  typingBar: { padding: '4px 20px', color: '#666', fontSize: 12, minHeight: 20 },
  notice: { margin: '0 16px 6px', padding: '6px 10px', borderRadius: 6, background: '#3f2a15', color: '#f5b971', fontSize: 12, cursor: 'pointer' },
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
  avatar: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0 },
  senderName: { color: '#888', fontSize: 12, marginBottom: 3, paddingLeft: 4 },
  bubble: { padding: '8px 14px', borderRadius: 12, wordBreak: 'break-word', overflowWrap: 'anywhere' },
  bubbleMe: { background: '#6366f1', borderTopRightRadius: 4 },
  bubbleThem: { background: '#1e1e30', borderTopLeftRadius: 4 },
  bubbleFailed: { background: '#3f1515', border: '1px solid #7f1d1d' },
  linkBtn: { background: 'none', border: 'none', padding: 0, color: '#a5b4fc', cursor: 'pointer', fontSize: 10, textDecoration: 'underline' },
  msgText: { color: '#e0e0e0', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' },
  timestamp: { color: '#444', fontSize: 10, marginTop: 3, paddingLeft: 4, paddingRight: 4 },
  dropOverlay: { position: 'absolute', inset: 0, background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
}
