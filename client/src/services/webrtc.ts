import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { wsService } from './websocket'
import { getIceServers } from './api'
import type { FileSink } from '../lib/fileSink'
import type { WSMessage } from '../types'

const CHUNK_SIZE = 64 * 1024
// Keep at most this much queued in the data channel; above it we wait for
// the bufferedamountlow event instead of polling.
const MAX_BUFFERED = CHUNK_SIZE * 16
const ACCEPT_TIMEOUT = 60_000
const CONNECT_TIMEOUT = 30_000
const ICE_SERVERS_TTL = 5 * 60_000

// Used only if the server cannot be asked for fresh credentials.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type TransferStatus = 'connecting' | 'transferring' | 'done' | 'error' | 'incoming' | 'declined' | 'cancelled' | 'timeout'
type Direction = 'send' | 'receive'

export interface TransferState {
  id: string
  targetUserID: string
  filename: string
  fileSize: number
  progress: number
  status: TransferStatus
  direction: Direction
}

export interface IncomingOffer {
  fromUserID: string
  transferID: string
  filename: string
  fileSize: number
  /** Only sent by older clients; current ones send it with "eof". */
  sha256: string
}

interface Transfer {
  peer: string
  filename: string
  fileSize: number
  direction: Direction
  pc?: RTCPeerConnection
  dc?: RTCDataChannel
  timer?: ReturnType<typeof setTimeout>
  remoteSet: boolean
  pendingCandidates: RTCIceCandidateInit[]
  lastProgress: number
  finished: boolean
  sink?: FileSink
}

type ProgressCallback = (state: TransferState) => void
type OfferCallback = (offer: IncomingOffer) => void

class WebRTCService {
  private transfers = new Map<string, Transfer>()
  private pendingOffers = new Map<string, { offer: IncomingOffer; sdp: RTCSessionDescriptionInit }>()
  private earlyCandidates = new Map<string, RTCIceCandidateInit[]>()
  private iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS
  private iceServersFetchedAt = 0
  private onProgress?: ProgressCallback
  private onIncoming?: OfferCallback
  private onOfferWithdrawn?: (transferID: string) => void

  constructor() {
    wsService.on('rtc_offer', (msg) => this.handleOffer(msg))
    wsService.on('rtc_answer', (msg) => this.handleAnswer(msg))
    wsService.on('ice_candidate', (msg) => this.handleICE(msg))
    wsService.on('rtc_decline', (msg) => this.handleDecline(msg))
  }

  setProgressCallback(cb: ProgressCallback) { this.onProgress = cb }
  setIncomingCallback(cb: OfferCallback) { this.onIncoming = cb }
  /** Called when the sender cancels before the offer was answered. */
  setOfferWithdrawnCallback(cb: (transferID: string) => void) { this.onOfferWithdrawn = cb }

  async sendFile(file: File, targetUserID: string): Promise<void> {
    const transferID = crypto.randomUUID()
    const t = this.track(transferID, targetUserID, file.name, file.size, 'send')
    this.emit(transferID, 'connecting', 0)
    await this.ensureIceServers()
    if (t.finished) return

    const pc = this.createPeerConnection(transferID)
    const dc = pc.createDataChannel('file-transfer', { ordered: true })
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = MAX_BUFFERED / 2
    t.dc = dc

    dc.onopen = () => {
      this.clearTimer(t)
      this.emit(transferID, 'transferring', 0)
      this.streamFile(transferID, file).catch((err) => {
        console.error('[p2p] send failed:', err)
        this.fail(transferID, 'error')
      })
    }
    dc.onerror = () => this.fail(transferID, 'error')

    try {
      await pc.setLocalDescription(await pc.createOffer())
    } catch (err) {
      console.error('[p2p] cannot create offer:', err)
      this.fail(transferID, 'error')
      return
    }
    // The checksum is computed while streaming and sent with the final
    // "eof" message, so large files neither wait for a separate hashing pass
    // nor have to fit in memory.
    wsService.send({
      type: 'rtc_offer', target_id: targetUserID,
      payload: { sdp: pc.localDescription, transferID, filename: file.name, fileSize: file.size },
    })
    t.timer = setTimeout(() => this.fail(transferID, 'timeout'), ACCEPT_TIMEOUT)
  }

  private async streamFile(transferID: string, file: File) {
    const t = this.transfers.get(transferID)
    const dc = t?.dc
    if (!t || !dc) return

    const hash = sha256.create()
    dc.send(JSON.stringify({ filename: file.name, fileSize: file.size, transferID }))
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      if (t.finished) return
      if (dc.bufferedAmount > MAX_BUFFERED) await waitForDrain(dc)
      if (t.finished) return
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
      hash.update(new Uint8Array(chunk))
      dc.send(chunk)
      this.emit(transferID, 'transferring', percent(offset + CHUNK_SIZE, file.size))
    }
    dc.send(JSON.stringify({ type: 'eof', sha256: bytesToHex(hash.digest()) }))
    // Closing the channel right away would discard data still in its buffer.
    while (dc.bufferedAmount > 0 && dc.readyState === 'open') await waitForDrain(dc, 0)
    this.finish(transferID, 'done')
  }

  private handleOffer(msg: WSMessage) {
    const p = msg.payload as {
      sdp: RTCSessionDescriptionInit; transferID: string
      filename: string; fileSize: number; sha256: string
    }
    if (!msg.sender_id || !p?.transferID || !p.sdp) return
    const offer: IncomingOffer = {
      fromUserID: msg.sender_id,
      transferID: p.transferID,
      filename: baseName(p.filename),
      fileSize: Number(p.fileSize) || 0,
      sha256: p.sha256 ?? '',
    }
    this.pendingOffers.set(offer.transferID, { offer, sdp: p.sdp })
    this.onIncoming?.(offer)
  }

  /** Whether the offer is still waiting for an answer (not withdrawn). */
  hasPendingOffer(transferID: string): boolean {
    return this.pendingOffers.has(transferID)
  }

  /**
   * Accepts an offer and streams the file into `sink`. Resolves with the
   * sink's result (a Blob for in-memory sinks, null for files on disk) once
   * the data has been verified. On any failure the sink is aborted.
   */
  async acceptIncoming(offer: IncomingOffer, sink: FileSink): Promise<Blob | null> {
    const pending = this.pendingOffers.get(offer.transferID)
    if (!pending) {
      await sink.abort()
      throw new Error('The sender cancelled this transfer')
    }
    this.pendingOffers.delete(offer.transferID)

    const id = offer.transferID
    const t = this.track(id, offer.fromUserID, offer.filename, offer.fileSize, 'receive')
    t.sink = sink
    this.emit(id, 'connecting', 0)
    await this.ensureIceServers()

    return new Promise<Blob | null>((resolve, reject) => {
      const pc = this.createPeerConnection(id)
      const hash = sha256.create()
      // Disk writes are asynchronous; chaining them keeps chunks in order.
      let writes: Promise<void> = Promise.resolve()
      let received = 0
      let headerSeen = false
      let eofSeen = false

      const failWith = (message: string) => {
        if (this.fail(id, 'error')) reject(new Error(message))
      }

      t.timer = setTimeout(() => {
        this.fail(id, 'timeout')
        reject(new Error('Connection timed out'))
      }, CONNECT_TIMEOUT)

      pc.ondatachannel = (e) => {
        this.clearTimer(t)
        const dc = e.channel
        dc.binaryType = 'arraybuffer'
        t.dc = dc

        dc.onmessage = async (event) => {
          if (t.finished) return
          if (typeof event.data !== 'string') {
            const chunk = new Uint8Array(event.data as ArrayBuffer)
            received += chunk.byteLength
            if (received > offer.fileSize) { failWith('The sender sent more data than announced'); return }
            hash.update(chunk)
            writes = writes.then(() => sink.write(chunk))
            writes.catch((err) => {
              console.error('[p2p] cannot write file:', err)
              failWith('The file could not be written to disk')
            })
            this.emit(id, 'transferring', percent(received, offer.fileSize))
            return
          }
          if (!headerSeen) { headerSeen = true; return }
          let ctrl: { type?: string; sha256?: string }
          try { ctrl = JSON.parse(event.data) } catch { return }
          if (ctrl.type !== 'eof') return
          // The sender closes the channel right after this, possibly while
          // the last writes are still in flight; that close is expected.
          eofSeen = true

          const expected = ctrl.sha256 || offer.sha256
          if (received !== offer.fileSize || (expected && bytesToHex(hash.digest()) !== expected)) {
            failWith('The received file is incomplete or corrupted')
            return
          }
          try {
            await writes
            const result = await sink.finish()
            if (t.finished) return // cancelled while the last bytes were written
            this.finish(id, 'done')
            resolve(result)
          } catch (err) {
            console.error('[p2p] cannot finish file:', err)
            failWith('The file could not be written to disk')
          }
        }
        dc.onerror = () => failWith('Transfer failed')
        dc.onclose = () => { if (!eofSeen) failWith('Transfer interrupted') }
      }

      pc.setRemoteDescription(pending.sdp)
        .then(() => this.flushCandidates(id))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          wsService.send({
            type: 'rtc_answer', target_id: offer.fromUserID,
            payload: { sdp: pc.localDescription, transferID: id },
          })
        })
        .catch((err) => {
          this.fail(id, 'error')
          reject(err)
        })
    })
  }

  declineIncoming(offer: IncomingOffer) {
    this.pendingOffers.delete(offer.transferID)
    this.earlyCandidates.delete(offer.transferID)
    wsService.send({
      type: 'rtc_decline', target_id: offer.fromUserID,
      payload: { transferID: offer.transferID, reason: 'declined' },
    })
  }

  cancelTransfer(transferID: string) {
    const t = this.transfers.get(transferID)
    if (!t || t.finished) return
    wsService.send({
      type: 'rtc_decline', target_id: t.peer,
      payload: { transferID, reason: 'cancelled' },
    })
    this.finish(transferID, 'cancelled')
  }

  private async handleAnswer(msg: WSMessage) {
    const p = msg.payload as { sdp: RTCSessionDescriptionInit; transferID: string }
    const t = this.transfers.get(p?.transferID)
    if (!t?.pc || t.finished || t.peer !== msg.sender_id) return
    this.clearTimer(t)
    try {
      await t.pc.setRemoteDescription(p.sdp)
      await this.flushCandidates(p.transferID)
    } catch {
      this.fail(p.transferID, 'error')
    }
  }

  private async handleICE(msg: WSMessage) {
    const p = msg.payload as { candidate: RTCIceCandidateInit; transferID: string }
    if (!p?.transferID || !p.candidate) return
    const t = this.transfers.get(p.transferID)
    if (t?.pc && t.remoteSet) {
      await t.pc.addIceCandidate(p.candidate).catch(() => {})
      return
    }
    // Candidates can arrive before the remote description is set, or on the
    // receiving side before the user has accepted. Keep them until then.
    if (t) {
      t.pendingCandidates.push(p.candidate)
    } else if (this.pendingOffers.has(p.transferID)) {
      const early = this.earlyCandidates.get(p.transferID) ?? []
      early.push(p.candidate)
      this.earlyCandidates.set(p.transferID, early)
    }
  }

  private async flushCandidates(transferID: string) {
    const t = this.transfers.get(transferID)
    if (!t?.pc) return
    t.remoteSet = true
    const queued = [...(this.earlyCandidates.get(transferID) ?? []), ...t.pendingCandidates]
    this.earlyCandidates.delete(transferID)
    t.pendingCandidates = []
    for (const c of queued) await t.pc.addIceCandidate(c).catch(() => {})
  }

  private handleDecline(msg: WSMessage) {
    const p = msg.payload as { transferID: string; reason?: string }
    if (!p?.transferID) return
    if (this.pendingOffers.delete(p.transferID)) {
      this.earlyCandidates.delete(p.transferID)
      this.onOfferWithdrawn?.(p.transferID)
      return
    }
    const t = this.transfers.get(p.transferID)
    if (!t || t.peer !== msg.sender_id) return
    this.finish(p.transferID, p.reason === 'cancelled' ? 'cancelled' : 'declined')
  }

  private async ensureIceServers() {
    if (Date.now() - this.iceServersFetchedAt < ICE_SERVERS_TTL) return
    try {
      const servers = await getIceServers()
      if (servers?.length) {
        this.iceServers = servers
        this.iceServersFetchedAt = Date.now()
      }
    } catch {
      // keep the previous (or fallback) servers
    }
  }

  private track(id: string, peer: string, filename: string, fileSize: number, direction: Direction): Transfer {
    const t: Transfer = {
      peer, filename, fileSize, direction,
      remoteSet: false, pendingCandidates: [], lastProgress: -1, finished: false,
    }
    this.transfers.set(id, t)
    return t
  }

  private createPeerConnection(transferID: string): RTCPeerConnection {
    const t = this.transfers.get(transferID)!
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    t.pc = pc
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsService.send({ type: 'ice_candidate', target_id: t.peer, payload: { candidate: e.candidate.toJSON(), transferID } })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fail(transferID, 'error')
    }
    return pc
  }

  /** Reports progress, skipping updates that would not change the percentage. */
  private emit(id: string, status: TransferStatus, progress: number) {
    const t = this.transfers.get(id)
    if (!t) return
    if (status === 'transferring' && progress === t.lastProgress) return
    t.lastProgress = progress
    this.onProgress?.({
      id, targetUserID: t.peer, filename: t.filename, fileSize: t.fileSize,
      progress, status, direction: t.direction,
    })
  }

  /** Ends a transfer that is still running. Returns false if it had already ended. */
  private fail(id: string, status: TransferStatus): boolean {
    const t = this.transfers.get(id)
    if (!t || t.finished) return false
    this.finish(id, status)
    return true
  }

  private finish(id: string, status: TransferStatus) {
    const t = this.transfers.get(id)
    if (!t || t.finished) return
    t.finished = true
    this.emit(id, status, status === 'done' ? 100 : t.lastProgress < 0 ? 0 : t.lastProgress)
    this.clearTimer(t)
    try { t.dc?.close() } catch { /* already closed */ }
    try { t.pc?.close() } catch { /* already closed */ }
    // Do not leave a half-written file behind.
    if (status !== 'done') t.sink?.abort().catch(() => {})
    this.transfers.delete(id)
  }

  private clearTimer(t: Transfer) {
    if (t.timer) { clearTimeout(t.timer); t.timer = undefined }
  }
}

function waitForDrain(dc: RTCDataChannel, threshold = dc.bufferedAmountLowThreshold): Promise<void> {
  return new Promise((resolve) => {
    if (dc.bufferedAmount <= threshold || dc.readyState !== 'open') { resolve(); return }
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done)
      dc.removeEventListener('close', done)
      clearInterval(poll)
      resolve()
    }
    dc.addEventListener('bufferedamountlow', done)
    dc.addEventListener('close', done)
    // bufferedamountlow does not fire for a threshold of 0 in every engine
    const poll = setInterval(() => { if (dc.bufferedAmount <= threshold) done() }, 50)
  })
}

function percent(done: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.floor((done / total) * 100))
}

// The name comes from the other peer; never let it carry a path.
function baseName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop()?.trim()
  return base || 'file'
}

export const webrtcService = new WebRTCService()
