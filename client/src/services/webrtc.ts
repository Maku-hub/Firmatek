import { wsService } from './websocket'
import { getIceServers } from './api'
import type { WSMessage } from '../types'

const CHUNK_SIZE = 64 * 1024
const ACCEPT_TIMEOUT = 60_000

// Fallback used only if the server can't be reached for fresh credentials.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]
const ICE_SERVERS_TTL = 5 * 60_000 // refetch credentials at most every 5 min

export type TransferStatus = 'connecting' | 'transferring' | 'done' | 'error' | 'incoming' | 'declined' | 'cancelled' | 'timeout'

export interface TransferState {
  id: string
  targetUserID: string
  filename: string
  fileSize: number
  progress: number
  status: TransferStatus
  direction: 'send' | 'receive'
}

type ProgressCallback = (state: TransferState) => void
type IncomingCallback = (offer: IncomingOffer) => void

export interface IncomingOffer {
  fromUserID: string
  fromName: string
  transferID: string
  filename: string
  fileSize: number
  sha256: string
}

interface PendingOffer {
  offer: IncomingOffer
  sdp: RTCSessionDescriptionInit
}

class WebRTCService {
  private connections = new Map<string, RTCPeerConnection>()
  private channels = new Map<string, RTCDataChannel>()
  private receiveBuffers = new Map<string, { chunks: ArrayBuffer[]; received: number; total: number }>()
  private transferTargets = new Map<string, string>()
  private transferMeta = new Map<string, { filename: string; fileSize: number }>()
  private pendingOffers = new Map<string, PendingOffer>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private completed = new Set<string>() // ignores events after done
  // ICE candidates that arrive before the remote description is set are buffered
  // here per transfer and flushed once setRemoteDescription() resolves.
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  private remoteSet = new Set<string>()
  private iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS
  private iceServersFetchedAt = 0
  private onProgress?: ProgressCallback
  private onIncoming?: IncomingCallback

  constructor() {
    wsService.on('rtc_offer', (msg) => this.handleOffer(msg))
    wsService.on('rtc_answer', (msg) => this.handleAnswer(msg))
    wsService.on('ice_candidate', (msg) => this.handleICE(msg))
    wsService.on('rtc_decline', (msg) => this.handleDecline(msg))
  }

  setProgressCallback(cb: ProgressCallback) { this.onProgress = cb }
  setIncomingCallback(cb: IncomingCallback) { this.onIncoming = cb }

  // Fetch fresh ICE/TURN servers (short-lived credentials), cached briefly.
  private async ensureIceServers(): Promise<void> {
    if (Date.now() - this.iceServersFetchedAt < ICE_SERVERS_TTL) return
    try {
      const servers = await getIceServers()
      if (servers && servers.length) {
        this.iceServers = servers
        this.iceServersFetchedAt = Date.now()
      }
    } catch {
      // Keep the previous/fallback servers on failure.
    }
  }

  // ─── Sending a file ───────────────────────────────────────────────────────

  async sendFile(file: File, targetUserID: string, sha256: string, myUserID: string): Promise<void> {
    await this.ensureIceServers()
    const transferID = `${myUserID}_${Date.now()}`
    const pc = this.createPeerConnection(transferID, targetUserID)
    this.transferMeta.set(transferID, { filename: file.name, fileSize: file.size })

    const dc = pc.createDataChannel('file-transfer', { ordered: true })
    dc.binaryType = 'arraybuffer'
    this.channels.set(transferID, dc)

    dc.onopen = () => {
      this.clearTimer(transferID)
      this.emit(transferID, targetUserID, file.name, file.size, 0, 'transferring', 'send')
      this.doStreamFile(dc, file, transferID, targetUserID)
    }

    dc.onerror = () => {
      if (!this.completed.has(transferID)) {
        this.emit(transferID, targetUserID, file.name, file.size, 0, 'error', 'send')
        this.cleanup(transferID)
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    wsService.send({
      type: 'rtc_offer', target_id: targetUserID,
      payload: { sdp: pc.localDescription, transferID, filename: file.name, fileSize: file.size, sha256 },
    })

    this.connections.set(transferID, pc)
    this.emit(transferID, targetUserID, file.name, file.size, 0, 'connecting', 'send')

    this.timers.set(transferID, setTimeout(() => {
      if (this.connections.has(transferID) && !this.completed.has(transferID)) {
        this.emit(transferID, targetUserID, file.name, file.size, 0, 'timeout', 'send')
        this.cleanup(transferID)
      }
    }, ACCEPT_TIMEOUT))
  }

  // Key detail: synchronous chunk reading with flow control
  private doStreamFile(dc: RTCDataChannel, file: File, transferID: string, targetUserID: string) {
    const { name, size } = file
    let offset = 0

    // Header
    dc.send(JSON.stringify({ filename: name, fileSize: size, transferID }))

    const MAX_BUFFER = CHUNK_SIZE * 4

    const pump = () => {
      // If the transfer was cancelled — stop
      if (!this.channels.has(transferID)) return

      // Wait until the buffer drains
      if (dc.bufferedAmount > MAX_BUFFER) {
        setTimeout(pump, 20)
        return
      }

      if (offset >= size) {
        // All chunks sent
        dc.send(JSON.stringify({ type: 'eof' }))
        this.completed.add(transferID)
        this.emit(transferID, targetUserID, name, size, 100, 'done', 'send')
        setTimeout(() => this.cleanup(transferID), 3000)
        return
      }

      const end = Math.min(offset + CHUNK_SIZE, size)
      const slice = file.slice(offset, end)
      offset = end

      slice.arrayBuffer().then((buf) => {
        if (!this.channels.has(transferID)) return
        try {
          dc.send(buf)
        } catch {
          if (!this.completed.has(transferID)) {
            this.emit(transferID, targetUserID, name, size, 0, 'error', 'send')
            this.cleanup(transferID)
          }
          return
        }
        const progress = Math.round((offset / size) * 100)
        this.emit(transferID, targetUserID, name, size, progress, 'transferring', 'send')
        // Continue immediately, or once the buffer has drained
        pump()
      })
    }

    pump()
  }

  // ─── Receiving ──────────────────────────────────────────────────────────────

  private handleOffer(msg: WSMessage) {
    const payload = msg.payload as {
      sdp: RTCSessionDescriptionInit; transferID: string
      filename: string; fileSize: number; sha256: string
    }
    const offer: IncomingOffer = {
      fromUserID: msg.sender_id!, fromName: msg.sender_id!,
      transferID: payload.transferID, filename: payload.filename,
      fileSize: payload.fileSize, sha256: payload.sha256,
    }
    this.pendingOffers.set(payload.transferID, { offer, sdp: payload.sdp })
    this.onIncoming?.(offer)
  }

  async acceptIncoming(offer: IncomingOffer): Promise<Blob> {
    const pending = this.pendingOffers.get(offer.transferID)
    if (!pending) throw new Error('No pending offer')
    const { sdp } = pending
    this.pendingOffers.delete(offer.transferID)
    await this.ensureIceServers()

    return new Promise((resolve, reject) => {
      const pc = this.createPeerConnection(offer.transferID, offer.fromUserID)

      const connTimeout = setTimeout(() => {
        if (!this.completed.has(offer.transferID)) {
          this.emit(offer.transferID, offer.fromUserID, offer.filename, offer.fileSize, 0, 'timeout', 'receive')
          this.cleanup(offer.transferID)
          reject(new Error('Timeout'))
        }
      }, 30_000)

      pc.ondatachannel = (e) => {
        clearTimeout(connTimeout)
        const dc = e.channel
        dc.binaryType = 'arraybuffer'
        this.channels.set(offer.transferID, dc)

        let headerReceived = false
        const buf = { chunks: [] as ArrayBuffer[], received: 0, total: offer.fileSize }
        this.receiveBuffers.set(offer.transferID, buf)

        dc.onmessage = (event) => {
          if (!headerReceived) { headerReceived = true; return }

          if (typeof event.data === 'string') {
            try {
              const ctrl = JSON.parse(event.data)
              if (ctrl.type === 'eof') {
                this.completed.add(offer.transferID)
                const blob = new Blob(buf.chunks)
                this.emit(offer.transferID, offer.fromUserID, offer.filename, offer.fileSize, 100, 'done', 'receive')
                this.cleanup(offer.transferID)
                resolve(blob)
              }
            } catch { /* ignore */ }
            return
          }

          buf.chunks.push(event.data as ArrayBuffer)
          buf.received += (event.data as ArrayBuffer).byteLength
          const progress = Math.round((buf.received / buf.total) * 100)
          this.emit(offer.transferID, offer.fromUserID, offer.filename, offer.fileSize, progress, 'transferring', 'receive')
        }

        dc.onerror = () => {
          if (!this.completed.has(offer.transferID)) {
            this.cleanup(offer.transferID); reject(new Error('Transfer error'))
          }
        }
        dc.onclose = () => {
          if (!this.completed.has(offer.transferID) && this.receiveBuffers.has(offer.transferID)) {
            this.cleanup(offer.transferID); reject(new Error('Interrupted'))
          }
        }
      }

      pc.setRemoteDescription(sdp)
        .then(() => { this.remoteSet.add(offer.transferID); return this.flushCandidates(offer.transferID) })
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          wsService.send({
            type: 'rtc_answer', target_id: offer.fromUserID,
            payload: { sdp: pc.localDescription, transferID: offer.transferID },
          })
        })
        .catch((err) => { clearTimeout(connTimeout); this.cleanup(offer.transferID); reject(err) })

      this.connections.set(offer.transferID, pc)
      this.emit(offer.transferID, offer.fromUserID, offer.filename, offer.fileSize, 0, 'connecting', 'receive')
    })
  }

  declineIncoming(offer: IncomingOffer) {
    this.pendingOffers.delete(offer.transferID)
    wsService.send({
      type: 'rtc_decline', target_id: offer.fromUserID,
      payload: { transferID: offer.transferID, reason: 'declined' },
    })
  }

  // ─── Cancellation ───────────────────────────────────────────────────────────

  cancelTransfer(transferID: string) {
    const target = this.transferTargets.get(transferID)
    if (target) {
      wsService.send({
        type: 'rtc_decline', target_id: target,
        payload: { transferID, reason: 'cancelled' },
      })
    }
    const meta = this.transferMeta.get(transferID)
    this.emit(transferID, target ?? '', meta?.filename ?? '', meta?.fileSize ?? 0, 0, 'cancelled', 'send')
    this.cleanup(transferID)
  }

  // ─── Signaling ──────────────────────────────────────────────────────────────

  private async handleAnswer(msg: WSMessage) {
    const payload = msg.payload as { sdp: RTCSessionDescriptionInit; transferID: string }
    const pc = this.connections.get(payload.transferID)
    if (!pc) return
    this.clearTimer(payload.transferID)
    try {
      await pc.setRemoteDescription(payload.sdp)
      this.remoteSet.add(payload.transferID)
      await this.flushCandidates(payload.transferID)
    } catch {
      if (!this.completed.has(payload.transferID)) {
        const meta = this.transferMeta.get(payload.transferID)
        const target = this.transferTargets.get(payload.transferID) ?? ''
        this.emit(payload.transferID, target, meta?.filename ?? '', meta?.fileSize ?? 0, 0, 'error', 'send')
        this.cleanup(payload.transferID)
      }
    }
  }

  private async handleICE(msg: WSMessage) {
    const payload = msg.payload as { candidate: RTCIceCandidateInit; transferID: string }
    const pc = this.connections.get(payload.transferID)
    // Buffer until the peer connection exists AND its remote description is set;
    // adding a candidate before then throws and the candidate would be lost.
    if (pc && this.remoteSet.has(payload.transferID)) {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {})
    } else {
      const arr = this.pendingCandidates.get(payload.transferID) ?? []
      arr.push(payload.candidate)
      this.pendingCandidates.set(payload.transferID, arr)
    }
  }

  private async flushCandidates(transferID: string) {
    const pc = this.connections.get(transferID)
    const arr = this.pendingCandidates.get(transferID)
    if (!pc || !arr) return
    this.pendingCandidates.delete(transferID)
    for (const c of arr) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    }
  }

  private handleDecline(msg: WSMessage) {
    const payload = msg.payload as { transferID: string; reason?: string }
    if (this.completed.has(payload.transferID)) return
    const target = this.transferTargets.get(payload.transferID)
    const meta = this.transferMeta.get(payload.transferID)
    const status: TransferStatus = payload.reason === 'cancelled' ? 'cancelled' : 'declined'
    this.emit(payload.transferID, target ?? '', meta?.filename ?? '', meta?.fileSize ?? 0, 0, status, 'send')
    this.cleanup(payload.transferID)
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private createPeerConnection(transferID: string, targetUserID: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.transferTargets.set(transferID, targetUserID)

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsService.send({ type: 'ice_candidate', target_id: targetUserID, payload: { candidate: e.candidate, transferID } })
      }
    }
    pc.onconnectionstatechange = () => {
      if (this.completed.has(transferID)) return
      if (pc.connectionState === 'failed') {
        const meta = this.transferMeta.get(transferID)
        this.emit(transferID, targetUserID, meta?.filename ?? '', meta?.fileSize ?? 0, 0, 'error', 'send')
        this.cleanup(transferID)
      }
    }
    return pc
  }

  private emit(id: string, targetUserID: string, filename: string, fileSize: number, progress: number, status: TransferStatus, direction: 'send' | 'receive') {
    this.onProgress?.({ id, targetUserID, filename, fileSize, progress, status, direction })
  }

  private clearTimer(transferID: string) {
    const t = this.timers.get(transferID)
    if (t) { clearTimeout(t); this.timers.delete(transferID) }
  }

  private cleanup(transferID: string) {
    this.clearTimer(transferID)
    try { this.channels.get(transferID)?.close() } catch { /* */ }
    this.channels.delete(transferID)
    try { this.connections.get(transferID)?.close() } catch { /* */ }
    this.connections.delete(transferID)
    this.receiveBuffers.delete(transferID)
    this.transferTargets.delete(transferID)
    this.transferMeta.delete(transferID)
    this.pendingOffers.delete(transferID)
    this.pendingCandidates.delete(transferID)
    this.remoteSet.delete(transferID)
    // `completed` is cleared after a delay (5s)
    setTimeout(() => this.completed.delete(transferID), 5000)
  }
}

export const webrtcService = new WebRTCService()
