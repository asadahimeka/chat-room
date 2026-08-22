/**
 * Render helpers for the chat message pipeline (pure DOM, unit-testable).
 *
 * Extracted from room.client.ts so the meta-class mapping, avatar building and
 * outgoing-meta serialization can be tested without a browser. All DOM work
 * uses createElement/textContent — never innerHTML.
 */

const AVATAR_URL_RE = /^(https:\/\/|data:image\/)/

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
 * monogram `<span class="avatar">` with the fallback background color and the
 * uppercase first character of fallbackChar.
 */
export function buildAvatarEl(
  meta: Record<string, unknown> | null,
  fallbackChar: string,
  fallbackColor: string,
): HTMLElement {
  const avatarUrl = meta && typeof meta.avatar === 'string' ? meta.avatar : ''
  if (AVATAR_URL_RE.test(avatarUrl)) {
    const img = document.createElement('img')
    img.className = 'avatar-img'
    img.src = avatarUrl
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    const monogram = buildAvatarEl(null, fallbackChar, fallbackColor)
    img.onerror = () => {
      img.replaceWith(monogram)
    }
    return img
  }
  const monogram = document.createElement('span')
  monogram.className = 'avatar'
  monogram.style.background = fallbackColor
  monogram.textContent = fallbackChar.charAt(0).toUpperCase()
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