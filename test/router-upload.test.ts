import { describe, expect, test } from 'bun:test'
import { createUploadRouter, parseIp } from '../src/router/upload.ts'

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]

function pngFile(extra: number[] = []): File {
  return new File([new Uint8Array([...PNG_HEADER, ...extra])], 'a.png', { type: 'image/png' })
}

function uploadRequest(
  body: FormData,
  opts: { cookie?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.ip) headers['x-forwarded-for'] = opts.ip
  return new Request('http://localhost/upload', { method: 'POST', headers, body })
}

function formWithFile(file: File): FormData {
  const fd = new FormData()
  fd.append('file', file)
  return fd
}

const COOKIES = 'name=alice; avatar=https://x/a.png'

describe('parseIp', () => {
  test('single x-forwarded-for', () => {
    expect(parseIp(new Headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('1.2.3.4')
  })

  test('multi x-forwarded-for takes first entry', () => {
    expect(parseIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' }))).toBe(
      '1.2.3.4',
    )
  })

  test('absent x-forwarded-for → unknown', () => {
    expect(parseIp(new Headers())).toBe('unknown')
  })

  test('blank x-forwarded-for → unknown', () => {
    expect(parseIp(new Headers({ 'x-forwarded-for': '   ' }))).toBe('unknown')
  })
})

describe('POST /upload', () => {
  test('no cookies → 400 profile required', async () => {
    const router = createUploadRouter({ s3Writer: async () => 'https://cdn/x.png' })
    const res = await router.handle(uploadRequest(formWithFile(pngFile())))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'profile required' })
  })

  test('only name cookie → 400 profile required', async () => {
    const router = createUploadRouter({ s3Writer: async () => 'https://cdn/x.png' })
    const res = await router.handle(
      uploadRequest(formWithFile(pngFile()), { cookie: 'name=alice' }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'profile required' })
  })

  test('text disguised as png → 415 unsupported type', async () => {
    const router = createUploadRouter({ s3Writer: async () => 'https://cdn/x.png' })
    const textFile = new File([new TextEncoder().encode('this is not a png at all')], 'a.png', {
      type: 'image/png',
    })
    const res = await router.handle(uploadRequest(formWithFile(textFile), { cookie: COOKIES }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported type' })
  })

  test('oversized file → 413 file too large', async () => {
    const router = createUploadRouter({ s3Writer: async () => 'https://cdn/x.png', maxBytes: 10 })
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
    const router = createUploadRouter({
      s3Writer: async () => 'https://cdn/x.png',
      dailyQuotaPerIp: 2,
    })
    const ok1 = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok1.status).toBe(200)
    const ok2 = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok2.status).toBe(200)
    const denied = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(denied.status).toBe(429)
    expect(await denied.json()).toEqual({ error: 'quota exceeded' })
  })

  test('quota is per-IP (different IP unaffected)', async () => {
    const router = createUploadRouter({
      s3Writer: async () => 'https://cdn/x.png',
      dailyQuotaPerIp: 1,
    })
    await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    const other = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '9.9.9.9' }))
    expect(other.status).toBe(200)
  })

  test('quota resets next day (injected now)', async () => {
    let current = new Date('2026-08-22T10:00:00Z')
    const router = createUploadRouter({
      s3Writer: async () => 'https://cdn/x.png',
      dailyQuotaPerIp: 1,
      now: () => current,
    })
    const ok = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(ok.status).toBe(200)
    const denied = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(denied.status).toBe(429)
    current = new Date('2026-08-23T10:00:00Z')
    const nextDay = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(nextDay.status).toBe(200)
  })

  test('valid PNG + fake s3Writer → 200 with url', async () => {
    const fake = async (key: string, body: Uint8Array) => {
      expect(key.startsWith('uploads/')).toBe(true)
      expect(key.endsWith('.png')).toBe(true)
      expect(body.length).toBeGreaterThan(0)
      return `https://cdn.example.com/${key}`
    }
    const router = createUploadRouter({ s3Writer: fake })
    const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toMatch(/^https:\/\/cdn\.example\.com\/uploads\/[0-9a-f-]{36}\.png$/)
  })

  test('no s3Writer + no S3 env → 503 storage unavailable', async () => {
    const saved = process.env.S3_ACCESS_KEY_ID
    delete process.env.S3_ACCESS_KEY_ID
    try {
      const router = createUploadRouter()
      const res = await router.handle(uploadRequest(formWithFile(pngFile()), { cookie: COOKIES, ip: '1.2.3.4' }))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'storage unavailable' })
    } finally {
      if (saved !== undefined) process.env.S3_ACCESS_KEY_ID = saved
    }
  })
})