/**
 * Identity envelope — the single transport format for the client identity
 * (uid + nickname) across BOTH server channels:
 *
 *   - WebSocket handshake:  ?id=<envelope>
 *   - POST /upload:         x-chat-id: <envelope>
 *
 * Format: base64url(JSON) → e.g. {"u":"ab12cd3","n":"小明","a":true}
 *
 * Why base64url(JSON) instead of plain fields: the nickname may be any
 * Unicode text, and it must survive both a URL query value and an HTTP
 * header value. base64url is pure ASCII and header-safe, so one encoding
 * serves both channels without per-channel escaping rules.
 *
 * Security note: the envelope is CLIENT-AUTHORED, exactly like the identity
 * cookies it replaces. It carries no secret and is not an authentication
 * credential — it only lets the client keep the same nickname/uid it
 * already had the right to choose.
 */

/** Public shape of the envelope payload. */
export interface IdentityEnvelope {
  /** uid, max 7 chars */
  u?: string
  /** nickname, max 32 chars */
  n?: string
  /** whether the client has an avatar set (upload channel only) */
  a?: boolean
}

/** Hard cap on the raw envelope length; anything longer is rejected. */
const MAX_RAW_LEN = 1024

/** Hard cap on a decoded uid / nickname, applied at decode time. */
const MAX_UID_LEN = 16
const MAX_NAME_LEN = 64

/** uid charset: word characters only, so it is safe in URLs, SQL and DOM attributes. */
const UID_RE = /^[A-Za-z0-9_-]{1,7}$/

/**
 * Strips C0 control characters and DEL from a nickname (log injection /
 * header safety). Implemented by code point so no control literal ever
 * appears in this source file.
 */
function stripControlChars(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    out += ch
  }
  return out
}

/** base64url helpers that work in both Bun and the browser bundle. */

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(raw: string): Uint8Array {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Encodes an envelope into a base64url string. Returns '' when the payload
 * has no meaningful field, so callers can omit the parameter entirely.
 */
export function encodeIdentity(env: IdentityEnvelope): string {
  const payload: Record<string, unknown> = {}
  if (typeof env.u === 'string' && env.u) payload.u = env.u
  if (typeof env.n === 'string' && env.n) payload.n = env.n
  if (typeof env.a === 'boolean') payload.a = env.a
  if (Object.keys(payload).length === 0) return ''
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
}

/**
 * Decodes an envelope. Returns undefined for anything malformed — the
 * caller then falls back to the legacy cookie path. Never throws.
 */
export function decodeIdentity(raw: string | undefined | null): IdentityEnvelope | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_RAW_LEN) return undefined
  // Only base64url alphabet — rejects '!!!', padded values and junk early.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(trimmed)))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const obj = parsed as Record<string, unknown>
  const out: IdentityEnvelope = {}

  if (typeof obj.u === 'string' && obj.u.length <= MAX_UID_LEN) out.u = obj.u
  if (typeof obj.n === 'string' && obj.n.length <= MAX_NAME_LEN) out.n = obj.n
  if (typeof obj.a === 'boolean') out.a = obj.a

  if (Object.keys(out).length === 0) return undefined
  return out
}

/**
 * Validates a client-supplied uid. Returns '' when invalid so the caller
 * can fall back to the cookie/sid path. 7 chars max — matches the DB column
 * width (VARCHAR(7)) and the legacy sanitizeUid() contract.
 */
export function sanitizeEnvelopeUid(uid: string): string {
  if (typeof uid !== 'string') return ''
  return UID_RE.test(uid) ? uid : ''
}

/**
 * Sanitizes a client-supplied nickname: strips control characters, trims,
 * and caps at 32 chars (matches the legacy sanitizeName() contract).
 */
export function sanitizeEnvelopeName(name: string): string {
  if (typeof name !== 'string') return ''
  return stripControlChars(name).trim().substring(0, 32)
}
