import { isTauri } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { open, remove, type FileHandle } from '@tauri-apps/plugin-fs'

/** Destination for the bytes of an incoming file. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>
  /** Flushes and closes. Returns the data when it was kept in memory. */
  finish(): Promise<Blob | null>
  /** Discards everything written so far. Safe to call more than once. */
  abort(): Promise<void>
}

// Each write is an IPC round trip, so small network chunks are batched.
const FLUSH_BYTES = 1024 * 1024

class DiskSink implements FileSink {
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private closed = false

  constructor(private file: FileHandle, private path: string) {}

  async write(chunk: Uint8Array) {
    this.pending.push(chunk)
    this.pendingBytes += chunk.byteLength
    if (this.pendingBytes >= FLUSH_BYTES) await this.flush()
  }

  async finish() {
    await this.flush()
    await this.close()
    return null
  }

  async abort() {
    this.pending = []
    this.pendingBytes = 0
    await this.close()
    await remove(this.path).catch(() => {})
  }

  private async flush() {
    if (!this.pendingBytes) return
    const data = new Uint8Array(this.pendingBytes)
    let offset = 0
    for (const part of this.pending) {
      data.set(part, offset)
      offset += part.byteLength
    }
    this.pending = []
    this.pendingBytes = 0
    for (let done = 0; done < data.byteLength;) {
      done += await this.file.write(data.subarray(done))
    }
  }

  private async close() {
    if (this.closed) return
    this.closed = true
    await this.file.close().catch(() => {})
  }
}

class MemorySink implements FileSink {
  private parts: Uint8Array[] = []

  async write(chunk: Uint8Array) { this.parts.push(chunk) }

  async finish() {
    const blob = new Blob(this.parts as BlobPart[])
    this.parts = []
    return blob
  }

  async abort() { this.parts = [] }
}

/**
 * Asks where to save an incoming file and opens it for writing. Returns null
 * if the user closed the dialog. Outside the desktop app (plain browser
 * during development) the file is collected in memory and downloaded at the
 * end instead.
 */
export async function createFileSink(suggestedName: string): Promise<FileSink | null> {
  if (!isTauri()) return new MemorySink()
  const path = await save({ defaultPath: suggestedName })
  if (!path) return null
  const file = await open(path, { write: true, create: true, truncate: true })
  return new DiskSink(file, path)
}
