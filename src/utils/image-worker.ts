/**
 * Image compression worker (runs inside a `worker_threads` Worker).
 *
 * Receives a single image buffer + encode parameters, returns a compressed
 * Buffer. The main thread owns a single long-lived Worker (see image-compress.ts)
 * and matches requests/responses by `id`.
 *
 * Encoding rules:
 *   - EXIF orientation is honored via `.rotate()` (no args → auto from metadata).
 *   - Resized to fit inside `maxDim` on the longest edge, never enlarged.
 *   - fmt 'avif' → `.avif({ quality, effort })`; fmt 'webp' → `.webp({ quality,
 *     animated: true })` (used for GIF input to preserve animation).
 *
 * The decoded input is read with `{ animated: true }` only for webp output so
 * multi-frame GIFs survive as animated WebP.
 */

import { parentPort } from 'worker_threads'
import sharp from 'sharp'

export interface CompressRequest {
  id: number
  buf: Uint8Array
  fmt: 'avif' | 'webp'
  quality: number
  effort: number
  maxDim: number
}

export interface CompressResponse {
  id: number
  ok: boolean
  data?: Buffer
  format?: string
  pages?: number
  err?: string
}

const port = parentPort
if (!port) {
  throw new Error('image-worker must be executed inside a Worker thread')
}

port.on('message', async (msg: CompressRequest) => {
  try {
    const inputOpts = msg.fmt === 'webp' ? { animated: true } : {}
    let img = sharp(msg.buf as unknown as Buffer, inputOpts).rotate()
    img = img.resize({
      width: msg.maxDim,
      height: msg.maxDim,
      fit: 'inside',
      withoutEnlargement: true,
    })
    if (msg.fmt === 'avif') {
      img = img.avif({ quality: msg.quality, effort: msg.effort })
    } else {
      // Animation is preserved because the input was opened with { animated: true }
      // (see inputOpts above); the webp writer emits all frames automatically.
      img = img.webp({ quality: msg.quality })
    }
    const { data, info } = await img.toBuffer({ resolveWithObject: true })
    const response: CompressResponse = {
      id: msg.id,
      ok: true,
      data,
      format: msg.fmt,
      pages: info.pages ?? 1,
    }
    // Transfer the underlying ArrayBuffer to avoid a copy.
    port.postMessage(response, [data.buffer])
  } catch (err) {
    const response: CompressResponse = {
      id: msg.id,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    }
    port.postMessage(response)
  }
})
