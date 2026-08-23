import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createUploadRouter, parseIp } from '../src/router/upload.ts'
import type { UploadDeps } from '../src/router/upload.ts'

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]
// GIF89a magic (first 4 bytes); rest is irrelevant for magic detection.
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
// ISO-BMFF: 4-byte size, 'ftyp', brand 'avif'.
const AVIF_HEADER = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]
// 'ftyp' present but an unknown brand → must be rejected as unsupported.
const FAKE_FTYP_HEADER = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x78, 0x78, 0x78, 0x78]

function pngFile(extra: number[] = []): File {
  return new File([new Uint8Array([...PNG_HEADER, ...extra])], 'a.png', { type: 'image/png' })
}

function gifFile(extra: number[] = []): File {
  return new File([new Uint8Array([...GIF_HEADER, ...extra])], 'a.gif', { type: 'image/gif' })
}

function avifFile(extra: number[] = []): File {
  return new File([new Uint8Array([...AVIF_HEADER, ...extra])], 'a.avif', { type: 'image/avif' })
}

function fakeFtypFile(): File {
  return new File([new Uint8Array([...FAKE_FTYP_HEADER])], 'a.bin', { type: 'application/octet-stream' })
}

/** Mock compressor that returns a fixed artifact of the given format/size. */
function mockCompress(format: 'avif' | 'webp', byteLength = 100): UploadDeps['compressImage'] {
  return async () => ({ data: new Uint8Array(byteLength), format })
}

function uploadRequest(
  body: FormData,
  opts: { cookie?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = opts.cookie
  // The injected getRemoteAddress reads this header to simulate the real peer IP.
  if (opts.ip) headers['x-client-ip'] = opts.ip
  return new Request('http://localhost/upload', { method: 'POST', headers, body })
}

function formWithFile(file: File): FormData {
  const fd = new FormData()
  fd.append('file', file)
  return fd
}

const COOKIES = 'name=alice; avatar=https://x/a.png'

/** Builds a router whose quota IP comes from the x-client-ip header. */
function makeRouter(extra: Partial<UploadDeps> = {}): Elysia<any, any, any, any, any, any, any> {
  return createUploadRouter({
    s3Writer: async () => 'https://cdn/x.png',
    getRemoteAddress: (req) => req.headers.get('x-client-ip'),
    // Default to a mock compressor so quota/size/magic tests stay fast and don't
    // depend on a valid raster fixture. Compression-specific tests override this.
    compressImage: mockCompress('avif'),
    ...extra,
  })
}

describe('parseIp (delegates to parseClientIp)', () => {
  test('trustCloudflare false → remoteAddress wins, cf ignored', () => {
    const h = new Headers({ 'cf-connecting-ip': '2.2.2.2' })
    expect(parseIp(h, { trustCloudflare: false, remoteAddress: '1.1.1.1' })).toBe('1.1.1.1')
  })

  test('trustCloudflare true → cf-connecting-ip wins', () => {
    const h = new Headers({ 'cf-connecting-ip': '2.2.2.2' })
    expect(parseIp(h, { trustCloudflare: true, remoteAddress: '1.1.1.1' })).toBe('2.2.2.2')
  })

  test('no signal → unknown', () => {
    expect(parseIp(new Headers(), { trustCloudflare: false, remoteAddress: null })).toBe('unknown')
  })
})

describe('POST /upload', () => {
  test('no cookies → 400 profile required', async () => {
    const router = makeRouter()
    const res = await router.handle(uploadRequest(formWithFile(pngFile())))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'profile required' })
  })

  test('only name cookie → 400 profile required', async () => {
    const router = makeRouter()
    const res = await router.handle(
      uploadRequest(formWithFile(pngFile()), { cookie: 'name=alice' }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'profile required' })
  })

  test('text disguised as png → 415 unsupported type', async () => {
    const router = makeRouter()
    const textFile = new File([new TextEncoder().encode('this is not a png at all')], 'a.png', {
      type: 'image/png',
    })
    const res = await router.handle(uploadRequest(formWithFile(textFile), { cookie: COOKIES }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported type' })
  })

  test('oversized file → 413 file too large', async () => {
    const router = makeRouter({ inputMaxBytes: 10 })
    const big = new Uint8Array([...PNG_HEADER, ...new Array(100).fill(0)])
    const res = await router.handle(
      uploadRequest(formWithFile(new File([big], 'a.png', { type: 'image/png' })), {
        cookie: COOKIES,
      }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'file too large' })
  })

  test('quota exceeded after N requests → 429', async () => {
    const router = makeRouter({ dailyQuotaPerIp: 2 })
    const ok1 = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok1.status).toBe(200)
    const ok2 = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok2.status).toBe(200)
    const denied = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(denied.status).toBe(429)
    expect(await denied.json()).toEqual({ error: 'quota exceeded' })
  })

  test('quota is per-IP (different IP unaffected)', async () => {
    const router = makeRouter({ dailyQuotaPerIp: 1 })
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    const other = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '9.9.9.9' }))
    expect(other.status).toBe(200)
  })

  test('quota resets next day (injected now)', async () => {
    let current = new Date('2026-08-22T10:00:00Z')
    const router = makeRouter({ dailyQuotaPerIp: 1, now: () => current })
    const ok = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok.status).toBe(200)
    const denied = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(denied.status).toBe(429)
    current = new Date('2026-08-23T10:00:00Z')
    const nextDay = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(nextDay.status).toBe(200)
  })

  test('valid PNG + fake s3Writer → 200 with .avif url (compressed)', async () => {
    const fake = async (key: string, body: Uint8Array) => {
      expect(key.startsWith('uploads/')).toBe(true)
      expect(key.endsWith('.avif')).toBe(true)
      expect(body.length).toBeGreaterThan(0)
      return `https://cdn.example.com/${key}`
    }
    const router = makeRouter({ s3Writer: fake, compressImage: mockCompress('avif') })
    const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toMatch(/^https:\/\/cdn\.example\.com\/uploads\/[0-9a-f-]{36}\.avif$/)
  })

  test('no s3Writer + no S3 env → 503 storage unavailable', async () => {
    const saved = process.env.S3_ACCESS_KEY_ID
    delete process.env.S3_ACCESS_KEY_ID
    try {
      const router = makeRouter({ s3Writer: undefined, compressImage: mockCompress('avif') })
      const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'storage unavailable' })
    } finally {
      if (saved !== undefined) process.env.S3_ACCESS_KEY_ID = saved
    }
  })

  test('AVIF magic accepted → 200 with .avif url', async () => {
    const router = makeRouter({ s3Writer: async () => 'https://cdn/x.avif', compressImage: mockCompress('avif') })
    const res = await router.handle(uploadRequest(formWithFile(avifFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toMatch(/\.avif$/)
  })

  test('ftyp with unknown brand → 415 unsupported type', async () => {
    const router = makeRouter({ compressImage: mockCompress('avif') })
    const res = await router.handle(uploadRequest(formWithFile(fakeFtypFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported type' })
  })

  test('input exceeds inputMaxBytes → 413 file too large', async () => {
    const router = makeRouter({ inputMaxBytes: 10, compressImage: mockCompress('avif') })
    const big = new Uint8Array([...PNG_HEADER, ...new Array(100).fill(0)])
    const res = await router.handle(
      uploadRequest(formWithFile(new File([big], 'a.png', { type: 'image/png' })), { cookie: COOKIES, ip: '1.2.3.4' }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'file too large' })
  })

  test('compressed artifact exceeds maxBytes → 413 compressed image too large', async () => {
    const router = makeRouter({ maxBytes: 5, compressImage: mockCompress('avif', 100) })
    const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'compressed image too large' })
  })

  test('compression failure → 500 with semantic message', async () => {
    const router = makeRouter({
      compressImage: async () => {
        throw new Error('image compression failed')
      },
    })
    const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'image compression failed' })
  })

  test('compression timeout → 500 with timeout message', async () => {
    const router = makeRouter({
      compressImage: async () => {
        throw new Error('image compression timed out')
      },
    })
    const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'image compression timed out' })
  })

  test('GIF input → 200 with .webp url (animated webp)', async () => {
    const router = makeRouter({ s3Writer: async () => 'https://cdn/x.webp', compressImage: mockCompress('webp') })
    const res = await router.handle(uploadRequest(formWithFile(gifFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toMatch(/\.webp$/)
  })

  test('compression is invoked with gif→webp and png→avif formats', async () => {
    const seen: string[] = []
    const router = makeRouter({
      compressImage: async (_buf, opts) => {
        seen.push(opts.fmt)
        return { data: new Uint8Array(10), format: opts.fmt }
      },
    })
    await router.handle(uploadRequest(formWithFile(gifFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(seen).toEqual(['webp', 'avif'])
  })
})

describe('quota map bounding', () => {
  test('evicts oldest entry when capacity is exceeded', async () => {
    const router = makeRouter({ quotaCapacity: 2, dailyQuotaPerIp: 100 })
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.1.1.1' }))
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '2.2.2.2' }))
    // 3rd distinct IP overflows capacity → oldest (1.1.1.1) evicted.
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '3.3.3.3' }))
    // 1.1.1.1 was evicted, so its quota reset and it can upload again.
    const again = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.1.1.1' }))
    expect(again.status).toBe(200)
  })

  test('drops cross-day entries on overflow before evicting', async () => {
    let current = new Date('2026-08-22T10:00:00Z')
    const router = makeRouter({ quotaCapacity: 1, dailyQuotaPerIp: 100, now: () => current })
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.1.1.1' }))
    // Next day: a new IP overflows capacity=1; the stale (prior-day) entry is
    // dropped first, so the new IP is accepted without evicting by age.
    current = new Date('2026-08-23T10:00:00Z')
    const r = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '2.2.2.2' }))
    expect(r.status).toBe(200)
    // And the stale IP now has a fresh (empty) quota again.
    const again = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.1.1.1' }))
    expect(again.status).toBe(200)
  })
})
