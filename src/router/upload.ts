import { Elysia } from 'elysia'
import { config } from '../config'
import { getCookie } from '../utils/input'
import { parseClientIp } from '../utils/ip'

export interface UploadDeps {
  /** Injected S3 writer; returns the public URL. Prod uses Bun.s3. */
  s3Writer?: (key: string, body: Uint8Array) => Promise<string>
  /** Injectable clock for quota date rollover tests. */
  now?: () => Date
  /** Test override; prod reads config.upload.dailyQuotaPerIp. */
  dailyQuotaPerIp?: number
  /** Test override; prod reads config.upload.maxBytes. */
  maxBytes?: number
  /** When true, `cf-connecting-ip` is trusted as the client IP. */
  trustCloudflare?: boolean
  /** Resolves the transport peer IP in production (verified: server.requestIP). */
  getRemoteAddress?: (request: Request) => string | null
  /** Override for the quota-map capacity cap (default 5000); used by tests. */
  quotaCapacity?: number
}

/** Hard cap on quota-map entries to bound memory under IP-spoofing pressure. */
const QUOTA_CAPACITY = 5000

interface QuotaEntry {
  date: string
  count: number
}

const MAGIC_TYPES: Array<{ ext: string; test: (b: Uint8Array) => boolean }> = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: '.png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: '.gif',
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  { ext: '.bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  {
    ext: '.webp',
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
]

function detectExt(bytes: Uint8Array): string | null {
  for (const { ext, test } of MAGIC_TYPES) {
    if (test(bytes)) return ext
  }
  return null
}

function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Resolves the client IP for quota keying. Delegates to the shared
 * `parseClientIp` so the trust rules (Cloudflare opt-in, XFF never trusted)
 * stay identical across WS and upload paths.
 */
export function parseIp(
  headers: Headers,
  opts: { trustCloudflare: boolean; remoteAddress?: string | null },
): string {
  return parseClientIp(headers, opts)
}

/**
 * POST /upload — profile gate → daily IP quota → file parse → size → magic
 * bytes → storage availability → S3 write. All state (quota map) lives inside
 * the factory closure so each call gets fresh state (test isolation).
 */
export function createUploadRouter(deps: UploadDeps = {}): Elysia<any, any, any, any, any, any, any> {
  const quota = new Map<string, QuotaEntry>()
  const quotaPerIp = deps.dailyQuotaPerIp ?? config.upload.dailyQuotaPerIp
  const maxBytes = deps.maxBytes ?? config.upload.maxBytes
  const capacity = deps.quotaCapacity ?? QUOTA_CAPACITY

  // Bounds the quota map so a flood of distinct spoofed IPs cannot grow it
  // unbounded. Map iteration order is insertion order, so the first key is the
  // oldest. On overflow we first drop cross-day (stale) entries; if still full
  // we evict the oldest insertion-order entries until under capacity.
  function evictIfNeeded(): void {
    if (quota.size < capacity) return
    const today = dateKey(deps.now?.() ?? new Date())
    for (const [k, v] of quota) {
      if (v.date !== today) quota.delete(k)
    }
    let oldest = quota.keys().next()
    while (oldest.done !== true && quota.size >= capacity) {
      quota.delete(oldest.value)
      oldest = quota.keys().next()
    }
  }

  return new Elysia().post('/upload', async ({ request }) => {
    const headers = new Headers(request.headers)
    const cookieHeader = headers.get('cookie') ?? undefined

    // a. Profile gate: both name AND avatar cookies must be present.
    const name = getCookie(cookieHeader, 'name')
    const avatar = getCookie(cookieHeader, 'avatar')
    if (!name || !avatar) {
      return Response.json({ error: 'profile required' }, { status: 400 })
    }

    // b. Daily per-IP quota (increments on acceptance only).
    const ip = parseIp(headers, {
      trustCloudflare: deps.trustCloudflare ?? false,
      remoteAddress: deps.getRemoteAddress ? deps.getRemoteAddress(request) : null,
    })
    evictIfNeeded()
    const today = dateKey(deps.now?.() ?? new Date())
    const entry = quota.get(ip)
    if (!entry || entry.date !== today) {
      quota.set(ip, { date: today, count: 0 })
    }
    const current = quota.get(ip)!
    if (current.count >= quotaPerIp) {
      return Response.json({ error: 'quota exceeded' }, { status: 429 })
    }
    current.count += 1

    // c. File parse.
    const data = await request.formData()
    const file = data.get('file')
    if (!(file instanceof File)) {
      return Response.json({ error: 'file required' }, { status: 400 })
    }

    // d. Size.
    if (file.size > maxBytes) {
      return Response.json({ error: 'file too large' }, { status: 413 })
    }

    // e. Magic bytes (first 12 bytes).
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    const ext = detectExt(head)
    if (!ext) {
      return Response.json({ error: 'unsupported type' }, { status: 415 })
    }

    // f. Storage availability (startup must never crash without S3 config).
    if (!deps.s3Writer && !process.env.S3_ACCESS_KEY_ID) {
      return Response.json({ error: 'storage unavailable' }, { status: 503 })
    }

    // g. Write.
    const key = `uploads/${crypto.randomUUID()}${ext}`
    const body = new Uint8Array(await file.arrayBuffer())
    let url: string
    if (deps.s3Writer) {
      url = await deps.s3Writer(key, body)
    } else {
      await Bun.s3.file(key).write(body)
      url = config.upload.publicUrl
        ? `${config.upload.publicUrl}/${key}`
        : `${config.upload.endpoint}/${config.upload.bucket}/${key}`
    }
    return Response.json({ url })
  })
}

export const uploadRouter: Elysia<any, any, any, any, any, any, any> = createUploadRouter()