/**
 * Single long-lived compression Worker wrapper.
 *
 * Owns one `worker_threads` Worker (src/utils/image-worker.ts) for the whole
 * server process. Requests are serialized through a queue so only one encode
 * runs at a time; each request carries its own timeout. On timeout (or worker
 * error/exit) the worker is terminated and rebuilt transparently, and the
 * in-flight request is rejected.
 *
 * The public `compressImage` is what the upload router calls. Tests inject a
 * mock via the router's `compressImage` dependency, so importing this module
 * never spawns a Worker until `compressImage` is actually invoked.
 */

import { Worker } from 'worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { CompressRequest, CompressResponse } from './image-worker'

export interface CompressOptions {
  fmt: 'avif' | 'webp'
  quality: number
  effort: number
  maxDim: number
  timeoutMs: number
}

export interface CompressResult {
  data: Buffer
  format: 'avif' | 'webp'
}

interface Pending {
  resolve: (r: CompressResult) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'image-worker.ts')

class ImageCompressor {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private queue: Array<() => void> = []
  private busy = false

  private ensureWorker(): void {
    if (this.worker) return
    const worker = new Worker(WORKER_PATH)
    worker.on('message', (msg: CompressResponse) => this.onMessage(msg))
    worker.on('error', (err: Error) => this.rebuild(err))
    worker.on('exit', (code: number) => {
      if (code !== 0) this.rebuild(new Error(`image worker exited with code ${code}`))
    })
    this.worker = worker
  }

  private onMessage(msg: CompressResponse): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok && msg.data) {
      p.resolve({ data: msg.data, format: (msg.format as 'avif' | 'webp') ?? 'avif' })
    } else {
      p.reject(new Error(msg.err || 'image compression failed'))
    }
    this.busy = false
    this.drain()
  }

  private rebuild(err: Error): void {
    // Reject everything still in flight, kill the dead worker, spawn a fresh one.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        // worker already gone
      }
      this.worker = null
    }
    this.busy = false
    this.ensureWorker()
    this.drain()
  }

  compressImage(buf: Uint8Array, opts: CompressOptions): Promise<CompressResult> {
    return new Promise<CompressResult>((resolve, reject) => {
      this.queue.push(() => {
        this.ensureWorker()
        this.busy = true
        const id = this.nextId++
        const timer = setTimeout(() => {
          this.pending.delete(id)
          // Hard timeout: the worker may be stuck encoding an expensive image.
          // Kill it and rebuild; the caller gets a clear timeout error.
          this.rebuild(new Error('image compression timed out'))
          reject(new Error('image compression timed out'))
        }, opts.timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        // Independent copy so the caller's buffer is never detached by transfer.
        const copy = new Uint8Array(buf)
        this.worker!.postMessage(
          {
            id,
            buf: copy,
            fmt: opts.fmt,
            quality: opts.quality,
            effort: opts.effort,
            maxDim: opts.maxDim,
          } satisfies CompressRequest,
          [copy.buffer],
        )
      })
      this.drain()
    })
  }

  private drain(): void {
    if (this.busy) return
    const job = this.queue.shift()
    if (!job) return
    job()
  }

  /** Tears down the worker (used by tests to let the process exit cleanly). */
  dispose(): void {
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        // ignore
      }
      this.worker = null
    }
    this.queue = []
    this.busy = false
  }
}

// One compressor (and thus one Worker) per server process.
const compressor = new ImageCompressor()

export function compressImage(buf: Uint8Array, opts: CompressOptions): Promise<CompressResult> {
  return compressor.compressImage(buf, opts)
}

export function disposeImageCompressor(): void {
  compressor.dispose()
}
