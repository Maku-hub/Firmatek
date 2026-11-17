import { useStore } from '../store'
import { wsService } from './websocket'
import type { Message, MessageMeta, MessageType, PendingMessage, WSMessage } from '../types'

// How long to wait for the server's acknowledgement on an open connection
// before showing the message as not delivered.
const ACK_TIMEOUT = 10_000
const STORAGE_PREFIX = 'firmatek_outbox_'

/**
 * Keeps every outgoing chat message until the server confirms it was stored.
 * Unconfirmed messages are resent after a reconnect and survive an app
 * restart. Each message carries a client_id, so a resend after a lost
 * acknowledgement never creates a duplicate.
 */
class Outbox {
  private userId: string | null = null
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private unsubs: (() => void)[] = []

  start(userId: string) {
    this.stop()
    this.userId = userId
    useStore.getState().setPending(this.load())
    this.unsubs = [
      wsService.on('connected', () => this.resendAll()),
      wsService.on('message_ack', (msg) => this.onStored(msg.payload as Message)),
      // Our own message coming back also proves it was stored, e.g. when the
      // acknowledgement was lost or another of our devices sent it.
      wsService.on('chat_message', (msg) => {
        const m = msg.payload as Message
        if (m.client_id && m.sender_id === this.userId) this.onStored(m)
      }),
      wsService.on('error', (msg) => this.onRejected(msg)),
    ]
  }

  stop() {
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
    this.userId = null
  }

  /** Forgets the queue of the signed-out user, including the saved copy. */
  clear(userId: string) {
    try { localStorage.removeItem(STORAGE_PREFIX + userId) } catch { /* ignore */ }
  }

  send(channelId: string, content: string, type: MessageType, metadata?: MessageMeta) {
    const pending: PendingMessage = {
      client_id: crypto.randomUUID(),
      channel_id: channelId,
      content,
      type,
      metadata,
      created_at: new Date().toISOString(),
      status: 'sending',
    }
    this.update((list) => [...list, pending])
    this.transmit(pending)
  }

  retry(clientId: string) {
    const pending = this.find(clientId)
    if (!pending) return
    const next = { ...pending, status: 'sending' as const, error: undefined, rejected: false }
    this.update((list) => list.map((p) => (p.client_id === clientId ? next : p)))
    this.transmit(next)
  }

  discard(clientId: string) {
    this.clearTimer(clientId)
    this.update((list) => list.filter((p) => p.client_id !== clientId))
  }

  private transmit(p: PendingMessage) {
    if (!wsService.isConnected()) return // resent on reconnect
    wsService.send({
      type: 'chat_message', channel_id: p.channel_id,
      payload: { channel_id: p.channel_id, client_id: p.client_id, content: p.content, type: p.type, metadata: p.metadata },
    })
    this.clearTimer(p.client_id)
    this.timers.set(p.client_id, setTimeout(() => {
      this.timers.delete(p.client_id)
      this.mark(p.client_id, { status: 'failed' })
    }, ACK_TIMEOUT))
  }

  private resendAll() {
    // Messages the server refused (too long, no access...) stay failed until
    // the user retries them; everything else goes out again.
    for (const p of useStore.getState().pending) {
      if (!p.rejected) {
        if (p.status === 'failed') this.mark(p.client_id, { status: 'sending' })
        this.transmit(p)
      }
    }
  }

  private onStored(m: Message) {
    if (!m?.client_id || !this.find(m.client_id)) return
    useStore.getState().addMessage(m)
    this.discard(m.client_id)
  }

  private onRejected(msg: WSMessage) {
    const p = msg.payload as { message?: string; client_id?: string }
    if (!p?.client_id) return
    this.clearTimer(p.client_id)
    this.mark(p.client_id, { status: 'failed', rejected: true, error: p.message })
  }

  private find(clientId: string) {
    return useStore.getState().pending.find((p) => p.client_id === clientId)
  }

  private mark(clientId: string, patch: Partial<PendingMessage>) {
    this.update((list) => list.map((p) => (p.client_id === clientId ? { ...p, ...patch } : p)))
  }

  private update(fn: (list: PendingMessage[]) => PendingMessage[]) {
    const store = useStore.getState()
    const next = fn(store.pending)
    store.setPending(next)
    this.save(next)
  }

  private clearTimer(clientId: string) {
    const t = this.timers.get(clientId)
    if (t) { clearTimeout(t); this.timers.delete(clientId) }
  }

  private load(): PendingMessage[] {
    if (!this.userId) return []
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + this.userId)
      const list = raw ? (JSON.parse(raw) as PendingMessage[]) : []
      return Array.isArray(list) ? list.map((p) => (p.rejected ? p : { ...p, status: 'sending' })) : []
    } catch {
      return []
    }
  }

  private save(list: PendingMessage[]) {
    if (!this.userId) return
    try {
      if (list.length) localStorage.setItem(STORAGE_PREFIX + this.userId, JSON.stringify(list))
      else localStorage.removeItem(STORAGE_PREFIX + this.userId)
    } catch { /* storage full or disabled; the queue still works in memory */ }
  }
}

export const outbox = new Outbox()
