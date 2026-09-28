/**
 * Render helpers for the chat message pipeline (pure DOM, unit-testable).
 *
 * Extracted from room.client.ts so the meta-class mapping, avatar building and
 * outgoing-meta serialization can be tested without a browser. All DOM work
 * uses createElement/textContent — never innerHTML.
 */

const AVATAR_URL_RE = /^(https:\/\/|data:image\/)/

/**
 * Simple deterministic hash → two hue values (0–360) for the gradient.
 * Uses the djb2 algorithm on a UTF-8–safe string.
 */
function hashToHues(input: string): [number, number] {
  let h1 = 5381
  let h2 = 0x1337
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) >>> 0
    h2 = ((h2 << 7) ^ h2 + c) >>> 0
  }
  // Offset the second hue by 120–180° for contrast
  return [h1 % 360, (h2 % 160) + 120]
}

/**
 * Builds the gradient background for a monogram avatar.
 * The two hues come from a deterministic hash of the uid (preferred) or name.
 */
function gradientBg(id: string): string {
  const [h1, h2] = hashToHues(id)
  return `linear-gradient(135deg, hsl(${h1},55%,52%), hsl(${h2},50%,48%))`
}

/**
 * Applies validated meta fields as CSS classes on the bubble element.
 * Unknown values are ignored; null meta is a no-op.
 *
 *   font   'serif' → font-serif, 'mono' → font-mono
 *   size   'sm' → size-sm, 'lg' → size-lg ('md'/missing → no class)
 *   bold   true → msg-bold
 *   italic true → msg-italic
 *   bubble 'flat'|'card'|'minimal' → bubble--<value> ('default'/missing → none)
 */
export function applyMetaClasses(el: HTMLElement, meta: Record<string, unknown> | null): void {
  if (!meta) return
  if (meta.font === 'serif') el.classList.add('font-serif')
  else if (meta.font === 'mono') el.classList.add('font-mono')
  if (meta.size === 'sm') el.classList.add('size-sm')
  else if (meta.size === 'lg') el.classList.add('size-lg')
  if (meta.bold === true) el.classList.add('msg-bold')
  if (meta.italic === true) el.classList.add('msg-italic')
  if (meta.bubble === 'flat' || meta.bubble === 'card' || meta.bubble === 'minimal') {
    el.classList.add(`bubble--${meta.bubble}`)
  }
}

/**
 * Builds the avatar element for a message.
 *
 * When meta.avatar is a safe https/data:image URL → an `<img class="avatar-img">`
 * with lazy loading + no-referrer; on load error it falls back to the monogram
 * (built by this same function with no avatar). Otherwise → the classic
 * monogram `<span class="avatar">` with a gradient background derived from
 * the uid or name hash.
 *
 * Monogram letter rules:
 *  - empty / no name → empty string (blank avatar)
 *  - name strictly matches /^user_[a-z0-9]{5}$/ → strip prefix, uppercase first char
 *  - all other names → uppercase first char
 */
export function buildAvatarEl(
  meta: Record<string, unknown> | null,
  name: string,
  uid?: string,
): HTMLElement {
  const avatarUrl = meta && typeof meta.avatar === 'string' ? meta.avatar : ''
  if (AVATAR_URL_RE.test(avatarUrl)) {
    const img = document.createElement('img')
    img.className = 'avatar-img'
    img.src = avatarUrl
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    const monogram = buildAvatarEl(null, name, uid)
    img.onerror = () => {
      img.replaceWith(monogram)
    }
    return img
  }

  // Determine the monogram letter
  let letter = ''
  if (name) {
    if (/^user_[a-z0-9]{5}$/.test(name)) {
      // Strip "user_" prefix → take first char of the remaining 5-char slug
      letter = name.slice(5, 6).toUpperCase()
    } else {
      letter = name.charAt(0).toUpperCase()
    }
  }

  const monogram = document.createElement('span')
  monogram.className = 'avatar'
  monogram.style.background = gradientBg(uid ?? name)
  monogram.textContent = letter
  return monogram
}

/**
 * Serializes the user's outgoing message-style prefs into the meta JSON string.
 * Only non-default fields are collected; avatar is included only when it is a
 * safe https/data:image URL. Empty result → undefined (field omitted from the
 * WS payload).
 */
export function serializeOutgoingMeta(prefs: {
  avatar?: string
  font?: string
  size?: string
  bold?: boolean
  italic?: boolean
  bubble?: string
}): string | undefined {
  const out: Record<string, unknown> = {}
  if (prefs.font && prefs.font !== 'default') out.font = prefs.font
  if (prefs.size && prefs.size !== 'md') out.size = prefs.size
  if (prefs.bold === true) out.bold = true
  if (prefs.italic === true) out.italic = true
  if (prefs.bubble && prefs.bubble !== 'default') out.bubble = prefs.bubble
  if (prefs.avatar && AVATAR_URL_RE.test(prefs.avatar)) out.avatar = prefs.avatar
  const keys = Object.keys(out)
  if (keys.length === 0) return undefined
  return JSON.stringify(out)
}

/**
 * Client-side reply quote snapshot riding inside the meta JSON string.
 */
export type ReplySnapshot = { ruid: string; rname: string; rmsg: string }

/** Client pre-truncation length for the quoted snippet (server caps at 100). */
export const REPLY_SNIPPET_MAX = 80

/**
 * De-dup key with a reply dimension: a bare text and its reply variant sent in
 * the same second must NOT swallow each other. Meta missing/malformed keeps
 * the legacy `uid|ts|msg` shape.
 */
export function msgDedupKey(
  uid: string | undefined,
  ts: number | string | undefined,
  msg: string | undefined,
  meta?: string | null,
): string {
  const key = `${uid ?? ''}|${ts ?? ''}|${msg ?? ''}`
  const parsed = safeParseMeta(meta)
  const reply = parsed?.reply
  if (reply && typeof reply === 'object' && !Array.isArray(reply)
    && typeof (reply as Record<string, unknown>).ruid === 'string') {
    return `${key}|r:${(reply as Record<string, string>).ruid}`
  }
  return key
}

/** Merges a reply snapshot into the outgoing meta JSON string. */
export function mergeReplyIntoMeta(metaJson: string | undefined, reply: ReplySnapshot): string {
  const base = safeParseMeta(metaJson) ?? {}
  return JSON.stringify({ ...base, reply })
}

/**
 * Local JSON.parse for the client bundle. Deliberately NOT importing
 * parseMsgMeta from src/db — that module pulls in bun:sqlite, which would
 * break the browser bundle.
 */
export function safeParseMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}