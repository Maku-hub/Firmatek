import type { WSMessage, WSMessageType } from '../types'
import { getWsURL } from './api'

type Handler = (msg: WSMessage) => void

class WebSocketService {
  private ws: WebSocket | null = null
  private handlers = new Map<WSMessageType | '*' | 'connected' | 'disconnected', Set<Handler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private shouldConnect = false

  connect() {
    this.shouldConnect = true
    this._connect()
  }

  private _connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return

    const url = getWsURL()
    if (!url.includes('token=') || url.endsWith('token=')) {
      console.warn('[WS] Brak tokenu – opóźnienie połączenia')
      this.scheduleReconnect()
      return
    }

    console.log('[WS] Łączenie z', url.replace(/token=.*/, 'token=***'))
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      console.log('[WS] Połączono')
      this.reconnectDelay = 1000
      this.dispatch({ type: 'connected' as WSMessageType, payload: null })
    }

    this.ws.onmessage = (event) => {
      const lines = (event.data as string).split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg: WSMessage = JSON.parse(line)
          this.dispatch(msg)
        } catch {
          console.warn('[WS] Błąd parsowania:', line.slice(0, 100))
        }
      }
    }

    this.ws.onclose = (e) => {
      console.log('[WS] Rozłączono, kod:', e.code)
      this.dispatch({ type: 'disconnected' as WSMessageType, payload: null })
      this.ws = null
      if (this.shouldConnect) this.scheduleReconnect()
    }

    this.ws.onerror = (e) => {
      console.error('[WS] Błąd połączenia', e)
      this.ws?.close()
    }
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
    this.ws?.close()
    this.ws = null
  }

  send(msg: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      console.warn('[WS] Próba wysłania bez połączenia')
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
