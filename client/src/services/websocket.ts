import type { WSMessage, WSMessageType } from '../types'
import { getMe, getToken, getWsURL } from './api'

type Handler = (msg: WSMessage) => void
type EventName = WSMessageType | '*' | 'connected' | 'disconnected'

const HEARTBEAT_INTERVAL = 25_000
const HEARTBEAT_TIMEOUT = 60_000 // no pong for this long => connection is dead
const MAX_RECONNECT_DELAY = 30_000

class WebSocketService {
  private ws: WebSocket | null = null
  private handlers = new Map<EventName, Set<Handler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private shouldConnect = false
  private everConnected = false
  private failedAttempts = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastPong = 0

  connect() {
    this.shouldConnect = true
    this.open()
  }

  disconnect() {
    this.shouldConnect = false
    this.everConnected = false
    this.failedAttempts = 0
    this.reconnectDelay = 1000
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  /**
   * Sends a frame if the socket is open and drops it otherwise. Chat messages
   * go through services/outbox, which resends them after reconnecting.
   */
  send(msg: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  on(type: EventName, handler: Handler): () => void {
    let set = this.handlers.get(type)
    if (!set) { set = new Set(); this.handlers.set(type, set) }
    set.add(handler)
    return () => { set!.delete(handler) }
  }

  isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  private open() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    if (!getToken()) return

    const ws = new WebSocket(getWsURL())
    this.ws = ws
    let opened = false

    ws.onopen = () => {
      opened = true
      const reconnect = this.everConnected
      this.everConnected = true
      this.failedAttempts = 0
      this.reconnectDelay = 1000
      this.lastPong = Date.now()
      this.startHeartbeat()
      this.dispatch({ type: 'connected' as WSMessageType, payload: { reconnect } })
    }

    ws.onmessage = (event) => {
      // The server may batch several JSON messages into one frame.
      for (const line of String(event.data).split('\n')) {
        if (!line) continue
        let msg: WSMessage
        try {
          msg = JSON.parse(line)
        } catch {
          console.warn('[ws] unparsable frame:', line.slice(0, 100))
          continue
        }
        if (msg.type === 'pong') { this.lastPong = Date.now(); continue }
        this.dispatch(msg)
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // replaced or closed on purpose
      this.ws = null
      this.stopHeartbeat()
      if (opened) this.dispatch({ type: 'disconnected' as WSMessageType, payload: null })
      if (!this.shouldConnect) return
      if (!opened && ++this.failedAttempts === 2) {
        // A handshake that keeps failing while the server is reachable usually
        // means the token was rejected. The REST call reports a 401 to the app,
        // which then signs out instead of retrying forever.
        getMe().catch(() => {})
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => ws.close()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    // Jitter keeps a whole office from reconnecting in lockstep after a
    // server restart.
    const delay = this.reconnectDelay * (0.75 + Math.random() * 0.5)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)
      if (this.shouldConnect) this.open()
    }, delay)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (ws?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT) {
        // Half-open connection: close it so the reconnect logic takes over.
        ws.close()
        return
      }
      ws.send(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private dispatch(msg: WSMessage) {
    this.handlers.get(msg.type)?.forEach((h) => h(msg))
    this.handlers.get('*')?.forEach((h) => h(msg))
  }
}

export const wsService = new WebSocketService()
