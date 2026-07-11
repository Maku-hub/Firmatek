import type { WSMessage, WSMessageType } from '../types'
import { getWsURL } from './api'

type Handler = (msg: WSMessage) => void

const HEARTBEAT_INTERVAL = 25_000 // send a ping this often while connected
const HEARTBEAT_TIMEOUT = 60_000  // no pong within this window => treat as dead

class WebSocketService {
  private ws: WebSocket | null = null
  private handlers = new Map<WSMessageType | '*' | 'connected' | 'disconnected', Set<Handler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private shouldConnect = false
  // Buffer of messages that could not be sent because the socket was not open.
  // Only durable messages (chat) are queued; transient signaling/typing is dropped.
  private outbox: WSMessage[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPong = 0

  connect() {
    this.shouldConnect = true
    this._connect()
  }

  private _connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return

    const url = getWsURL()
    if (!url.includes('token=') || url.endsWith('token=')) {
      console.warn('[WS] No token – delaying connection')
      this.scheduleReconnect()
      return
    }

    console.log('[WS] Connecting to', url.replace(/token=.*/, 'token=***'))
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[WS] Connected')
      this.reconnectDelay = 1000
      this.lastPong = Date.now()
      this.startHeartbeat()
      this.flushOutbox()
      this.dispatch({ type: 'connected' as WSMessageType, payload: null })
    }

    this.ws.onmessage = (event) => {
      const lines = (event.data as string).split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg: WSMessage = JSON.parse(line)
          if (msg.type === ('pong' as WSMessageType)) { this.lastPong = Date.now(); continue }
          this.dispatch(msg)
        } catch {
          console.warn('[WS] Parse error:', line.slice(0, 100))
        }
      }
    }

    this.ws.onclose = (e) => {
      console.log('[WS] Disconnected, code:', e.code)
      this.stopHeartbeat()
      this.dispatch({ type: 'disconnected' as WSMessageType, payload: null })
      this.ws = null
      if (this.shouldConnect) this.scheduleReconnect()
    }

    this.ws.onerror = (e) => {
      console.error('[WS] Connection error', e)
      this.ws?.close()
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      // If the peer has gone silent for too long the connection is half-open;
      // force a close so the reconnect logic kicks in.
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT) {
        console.warn('[WS] Heartbeat timeout – forcing reconnect')
        this.ws.close()
        return
      }
      try { this.ws.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ }
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private flushOutbox() {
    if (!this.outbox.length || this.ws?.readyState !== WebSocket.OPEN) return
    const pending = this.outbox
    this.outbox = []
    for (const msg of pending) this.ws.send(JSON.stringify(msg))
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
      this._connect()
    }, this.reconnectDelay)
  }

  disconnect() {
    this.shouldConnect = false
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopHeartbeat()
    this.outbox = []
    this.ws?.close()
    this.ws = null
  }

  send(msg: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else if (msg.type === 'chat_message') {
      // Durable message – queue it and deliver once reconnected.
      this.outbox.push(msg)
      console.warn('[WS] Not connected – message queued for delivery')
    } else {
      // Transient (typing / RTC signaling) – safe to drop.
      console.warn('[WS] Attempted to send without a connection')
    }
  }

  on(type: WSMessageType | '*' | 'connected' | 'disconnected', handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
    return () => this.handlers.get(type)?.delete(handler)
  }

  private dispatch(msg: WSMessage) {
    this.handlers.get(msg.type)?.forEach((h) => h(msg))
    this.handlers.get('*')?.forEach((h) => h(msg))
  }

  isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN }
}

export const wsService = new WebSocketService()
