import { afterAll, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { compressImage, disposeImageCompressor } from '../src/utils/image-compress'

/**
 * Hand-crafted minimal animated GIF89a (2 frames, 1×1, NETSCAPE loop ext).
 * No ffmpeg/imagemagick on the box, so we build the bytes directly. Used to
 * assert the gif → animated webp path yields pages >= 2.
 */
function makeAnimatedGif(): Uint8Array {
  const out: number[] = []
  const u16 = (n: number) => {
    out.push(n & 0xff, (n >> 8) & 0xff)
  }
  const bytes = (...b: number[]) => out.push(...b)
  const str = (s: string) => {
    for (const c of s) out.push(c.charCodeAt(0))
  }

  // Header
  str('GIF89a')
  // Logical Screen Descriptor: 1×1, GCT flag, 2 colors
  u16(1)
  u16(1)
  bytes(0xf0, 0x00, 0x00)
  // Global Color Table: black, red
  bytes(0x00, 0x00, 0x00, 0xff, 0x00, 0x00)
  // NETSCAPE2.0 looping extension (infinite)
  bytes(0x21, 0xff, 0x0b)
  str('NETSCAPE2.0')
  bytes(0x03, 0x01, 0x00, 0x00, 0x00)

  const frame = (pixel: number, lzw: number[]) => {
    // Graphic Control Extension
    bytes(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00)
    // Image Descriptor
    bytes(0x2c)
    u16(0) // left
    u16(0) // top
    u16(1) // width
    u16(1) // height
    bytes(0x00)
    // Image Data: LZW min code size, then sub-block(s), terminator
    bytes(0x02, lzw.length & 0xff, ...lzw, 0x00)
    void pixel
  }

  // Frame 1: pixel 0 (black). LZW: clear(4), index 0, EOI(5) packed at codeSize 3.
  frame(0, [0x44, 0x01])
  // Frame 2: pixel 1 (red). LZW: clear(4), index 1, EOI(5).
  frame(1, [0x4c, 0x01])

  // Trailer
  bytes(0x3b)
  return new Uint8Array(out)
}

/** Generates a real raster image of the given format via sharp. */
async function genImage(fmt: 'jpeg' | 'png' | 'webp' | 'avif', w: number, h: number): Promise<Uint8Array> {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 160, b: 200 } } })
  if (fmt === 'jpeg') p = p.jpeg()
  else if (fmt === 'png') p = p.png()
  else if (fmt === 'webp') p = p.webp()
  else p = p.avif()
  return new Uint8Array(await p.toBuffer())
}

const BASE_OPTS = { quality: 50, effort: 4, maxDim: 2048, timeoutMs: 30000 }

afterAll(() => {
  disposeImageCompressor()
})

describe('image-compress (real Worker + sharp)', () => {
  test('jpg → avif with dimensions clamped to maxDim', async () => {
    const buf = await genImage('jpeg', 4000, 3000)
    const res = await compressImage(buf, { ...BASE_OPTS, fmt: 'avif' })
    expect(res.format).toBe('avif')
    const meta = await sharp(res.data).metadata()
    expect(meta.width ?? 0).toBeLessThanOrEqual(2048)
    expect(meta.height ?? 0).toBeLessThanOrEqual(2048)
    // 4000×3000 fit-inside 2048 → 2048×1536
    expect(meta.width).toBe(2048)
  })

  test('png → avif', async () => {
    const buf = await genImage('png', 800, 600)
    const res = await compressImage(buf, { ...BASE_OPTS, fmt: 'avif' })
    expect(res.format).toBe('avif')
    // Decoding the artifact must succeed (valid AVIF).
    const meta = await sharp(res.data).metadata()
    expect(meta.width).toBe(800)
  })

  test('webp (static) → avif', async () => {
    const buf = await genImage('webp', 800, 600)
    const res = await compressImage(buf, { ...BASE_OPTS, fmt: 'avif' })
    expect(res.format).toBe('avif')
  })

  test('avif → avif (re-encode)', async () => {
    const buf = await genImage('avif', 800, 600)
    const res = await compressImage(buf, { ...BASE_OPTS, fmt: 'avif' })
    expect(res.format).toBe('avif')
  })

  test('gif → animated webp with pages >= 2', async () => {
    const buf = makeAnimatedGif()
    const res = await compressImage(buf, { ...BASE_OPTS, fmt: 'webp' })
    expect(res.format).toBe('webp')
    const meta = await sharp(res.data).metadata()
    expect(meta.pages ?? 1).toBeGreaterThanOrEqual(2)
  })

  test('hard timeout rejects and the worker is rebuilt for later requests', async () => {
    const big = await genImage('jpeg', 4000, 3000)
    // gaussian noise makes AVIF encoding extremely slow; a 100ms budget forces timeout.
    const noisy = await sharp({
      create: {
        width: 4000,
        height: 3000,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .jpeg()
      .toBuffer()
    await expect(compressImage(new Uint8Array(noisy), { ...BASE_OPTS, fmt: 'avif', timeoutMs: 100 })).rejects.toThrow(
      'image compression timed out',
    )
    // The compressor must still work after the worker was terminated + rebuilt.
    const res = await compressImage(new Uint8Array(big), { ...BASE_OPTS, fmt: 'avif' })
    expect(res.format).toBe('avif')
  }, 15000)
})
