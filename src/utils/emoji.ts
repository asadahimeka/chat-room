/**
 * Emoji pack loading + `:keyword:` token parsing.
 *
 * NOTE (deviation from plan T4): the plan's sync-only signature cannot fetch
 * remote manifests, so responsibilities are split:
 *   - `parseInlineEmojiConfig` handles the sync half (inline packs + collecting
 *     remote base URLs) and returns `{ packs, remoteUrls }`.
 *   - `loadRemoteManifest` handles the async half with an injectable `fetch`
 *     (defaults to global fetch) so tests never touch the network.
 *   - `resolveEmojiConfig` orchestrates both.
 * All remote data is treated as DATA ONLY — only URLs are extracted, never
 * rendered as HTML.
 */

export interface EmojiPack {
  name: string
  icon: string
  keywords: string[]
  /** Optional pack prefix. When set, the panel inserts qualified tokens
   *  (`:prefixkw:`) so same-named emojis across packs stay addressable. */
  prefix?: string
  urlOf(kw: string): string
}

/**
 * Pluggable key/value store for the manifest cache. Defaults to a
 * try/catch-wrapped `localStorage` (private-mode safe); tests inject an
 * in-memory implementation. `keys()` is optional and only used for the
 * write-cap eviction.
 */
export interface ManifestCacheStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys?(): string[]
}

/** localStorage key prefix for cached manifests. */
export const CACHE_PREFIX = 'emoji-manifest:'
/** Cache TTL: 24 hours. */
export const CACHE_TTL = 24 * 60 * 60 * 1000
/** Max number of cached manifest keys before the oldest is evicted. */
export const CACHE_MAX = 120

interface CachedManifest {
  name: string
  icon: string
  prefix: string
  type: string
  keywords: string[]
  ts: number
}

/**
 * Returns a cache store. Uses `globalThis.localStorage` when present
 * (every access wrapped in try/catch for private-mode throws); otherwise
 * falls back to a throwaway in-memory Map so the function still works in
 * Node/test environments.
 */
export function defaultStore(): ManifestCacheStore {
  const ls = (globalThis as { localStorage?: Storage }).localStorage
  if (!ls) {
    const mem = new Map<string, string>()
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
      keys: () => [...mem.keys()],
    }
  }
  return {
    getItem: (k) => {
      try {
        return ls.getItem(k)
      } catch {
        return null
      }
    },
    setItem: (k, v) => {
      try {
        ls.setItem(k, v)
      } catch {
        // quota exceeded / private mode — drop silently
      }
    },
    removeItem: (k) => {
      try {
        ls.removeItem(k)
      } catch {
        // ignore
      }
    },
    keys: () => {
      try {
        const out: string[] = []
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i)
          if (k) out.push(k)
        }
        return out
      } catch {
        return []
      }
    },
  }
}

/** Reads + validates a cached manifest; returns null on miss / corruption. */
function readCache(store: ManifestCacheStore, key: string): CachedManifest | null {
  let raw: string | null = null
  try {
    raw = store.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<CachedManifest>
    if (typeof obj.name !== 'string' || !Array.isArray(obj.keywords)) return null
    return {
      name: obj.name,
      icon: typeof obj.icon === 'string' ? obj.icon : '',
      prefix: typeof obj.prefix === 'string' ? obj.prefix : '',
      type: typeof obj.type === 'string' ? obj.type : '',
      keywords: obj.keywords.filter((k): k is string => typeof k === 'string'),
      ts: typeof obj.ts === 'number' ? obj.ts : 0,
    }
  } catch {
    return null
  }
}

/**
 * Writes a manifest to the cache, evicting the oldest entry first when the
 * `emoji-manifest:` key count has reached CACHE_MAX. All access is guarded.
 */
function writeCache(store: ManifestCacheStore, key: string, value: CachedManifest): void {
  if (typeof store.keys === 'function') {
    try {
      const mine = store.keys().filter((k) => k.startsWith(CACHE_PREFIX))
      if (mine.length >= CACHE_MAX) {
        let oldestKey: string | null = null
        let oldestTs = Infinity
        for (const k of mine) {
          const raw = store.getItem(k)
          if (!raw) continue
          try {
            const o = JSON.parse(raw) as { ts?: number }
            if (typeof o.ts === 'number' && o.ts < oldestTs) {
              oldestTs = o.ts
              oldestKey = k
            }
          } catch {
            // unparseable → treat as oldest so it gets evicted
            oldestKey = k
            oldestTs = -Infinity
          }
        }
        if (oldestKey) store.removeItem(oldestKey)
      }
    } catch {
      // eviction is best-effort
    }
  }
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    // ignore write failures
  }
}

/**
 * Rebuilds an EmojiPack from cached fields. The urlOf join rule mirrors the
 * live fetch path: Waline shape (type present) appends `.{type}`; Valine shape
 * (no type) uses the keyword as the full filename.
 */
function packFromCache(c: CachedManifest, base: string): EmojiPack {
  const type = c.type
  const prefix = c.prefix
  return {
    name: c.name,
    icon: c.icon,
    keywords: c.keywords,
    prefix,
    urlOf: (kw: string) => (type ? base + prefix + kw + '.' + type : base + prefix + kw),
  }
}

export interface ParsedEmojiConfig {
  packs: EmojiPack[]
  remoteUrls: string[]
}

/**
 * Parses the raw `emoji[]` config entries. Each entry is either:
 *   - a `string` → remote pack base URL, collected into `remoteUrls`
 *   - an inline object `{ name, icon?, folder?, prefix?, type, items }` → sync EmojiPack
 * Malformed inline objects (missing name/type/items-array) are skipped silently.
 */
export function parseInlineEmojiConfig(entries: unknown[]): ParsedEmojiConfig {
  const packs: EmojiPack[] = []
  const remoteUrls: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      remoteUrls.push(entry)
      continue
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const obj = entry as Record<string, unknown>
    const { name, type, items } = obj
    if (typeof name !== 'string' || typeof type !== 'string' || !Array.isArray(items)) continue
    const folder = typeof obj.folder === 'string' ? obj.folder : ''
    const prefix = typeof obj.prefix === 'string' ? obj.prefix : ''
    const icon = typeof obj.icon === 'string' ? obj.icon : ''
    const keywords = items.filter((it): it is string => typeof it === 'string')
    packs.push({
      name,
      icon,
      keywords,
      prefix,
      // Waline join rule: folder + (prefix ?? '') + kw + '.' + type.
      // Without a folder there is no base URL → urlOf returns '' and the
      // pack is filtered out later by buildEmojiMap.
      urlOf: (kw: string) => (folder ? folder + prefix + kw + '.' + type : ''),
    })
  }
  return { packs, remoteUrls }
}

/**
 * Fetches a remote pack manifest at `url + 'info.json'` (trailing slash
 * auto-added). Never throws: any failure → null + console.warn. Non-https
 * URLs are rejected immediately without calling fetch.
 */
export async function loadRemoteManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
  store: ManifestCacheStore = defaultStore(),
): Promise<EmojiPack | null> {
  if (!url.startsWith('https://')) {
    console.warn(`[emoji] skip non-https remote pack: ${url}`)
    return null
  }
  const base = url.endsWith('/') ? url : url + '/'
  const cacheKey = CACHE_PREFIX + base

  // 1) Cache lookup. A fresh (unexpired) entry short-circuits the network.
  const cached = readCache(store, cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return packFromCache(cached, base)
  }

  // 2) Network fetch (cache miss or expired).
  try {
    const res = await fetchImpl(base + 'info.json')
    if (!res.ok) {
      console.warn(`[emoji] manifest fetch failed (${res.status}): ${base}info.json`)
      // Fall back to an (even expired) cached copy rather than dropping the pack.
      if (cached) return packFromCache(cached, base)
      return null
    }
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      console.warn(`[emoji] invalid manifest shape: ${base}info.json`)
      if (cached) return packFromCache(cached, base)
      return null
    }
    const obj = data as Record<string, unknown>
    const { name, items } = obj
    // Required shape: name (string) + items (string[]). `icon`, `prefix`, and
    // `type` are all OPTIONAL — Valine-style manifests carry none of them and
    // store full filenames (incl. extension) directly in `items`.
    if (typeof name !== 'string' || !Array.isArray(items)) {
      console.warn(`[emoji] invalid manifest shape: ${base}info.json`)
      if (cached) return packFromCache(cached, base)
      return null
    }
    // `type` optional: missing or non-string → '' (Valine shape, no extension).
    const type = typeof obj.type === 'string' ? obj.type : ''
    // `prefix` optional: missing or non-string → '' (GBC/AM packs have none).
    const prefix = typeof obj.prefix === 'string' ? obj.prefix : ''
    // `icon` optional: missing or non-string → '' (falls back to placeholder).
    const icon = typeof obj.icon === 'string' ? obj.icon : ''
    const keywords = items.filter((it): it is string => typeof it === 'string')
    const pack: EmojiPack = {
      name,
      icon,
      keywords,
      prefix,
      // Waline-style (type present): base + prefix + kw + '.' + type.
      // Valine-style (no type): items already carry the full filename, so the
      // join is base + prefix + kw (no extension appended).
      urlOf: (kw: string) => (type ? base + prefix + kw + '.' + type : base + prefix + kw),
    }
    writeCache(store, cacheKey, { name, icon, prefix, type, keywords, ts: Date.now() })
    return pack
  } catch (err) {
    console.warn(`[emoji] manifest load failed: ${base}info.json — ${(err as Error).message ?? err}`)
    // Network/parse failure: serve the stale cache if we have one.
    if (cached) return packFromCache(cached, base)
    return null
  }
}

/**
 * Orchestrator: inline packs first, then all remote manifests resolved in
 * parallel; failed manifests (null) are dropped.
 */
export async function resolveEmojiConfig(
  entries: unknown[],
  fetchImpl?: typeof fetch,
  store?: ManifestCacheStore,
): Promise<EmojiPack[]> {
  const { packs, remoteUrls } = parseInlineEmojiConfig(entries)
  const remotePacks = await Promise.all(
    remoteUrls.map((url) => loadRemoteManifest(url, fetchImpl, store)),
  )
  return [...packs, ...remotePacks.filter((p): p is EmojiPack => p !== null)]
}

/**
 * Flattens every pack keyword → its image URL. Any URL that does not start
 * with `https://` is skipped (defense in depth).
 *
 * Dual-layer registration per pack:
 *   - **Qualified key** `prefix + kw` (only when the pack has a `prefix`): the
 *     underlying files are uniquely named by prefix, so this key never collides
 *     across packs and makes EVERY emoji addressable (`:weibo_smile:` vs
 *     `:qq_smile:`). Clicking a prefixed pack's emoji inserts this qualified token.
 *   - **Bare alias** `kw` (first pack wins): keeps historical plain `:kw:`
 *     messages rendering. A later pack cannot rewrite an already-claimed bare
 *     alias, so `:smile:` stays bound to whichever pack claimed it first.
 */
export function buildEmojiMap(packs: EmojiPack[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const pack of packs) {
    const prefix = typeof pack.prefix === 'string' ? pack.prefix : ''
    for (const kw of pack.keywords) {
      const url = pack.urlOf(kw)
      if (!url.startsWith('https://')) continue
      // Prefixed packs register their canonical qualified key — the underlying
      // files are uniquely named by prefix, so this key never collides across
      // packs and makes EVERY emoji addressable (:weibo_smile: vs :qq_smile:).
      if (prefix && !map.has(prefix + kw)) map.set(prefix + kw, url)
      // Bare alias (first pack wins) keeps historical plain :kw: messages rendering.
      if (!map.has(kw)) map.set(kw, url)
    }
  }
  return map
}

export type EmojiTokenPart = { type: 'text'; text: string } | { type: 'img'; url: string }

/**
 * True when `src` is an "emoji-only" message: every `:keyword:` token resolves
 * to an emoji image in `emojiMap` and all remaining text is whitespace. This is
 * the decision used to enlarge standalone emoji. It mirrors the DOM result of
 * `renderTextWithEmoji` (which uses the same `:([^:\s]+):` token regex):
 *   - an unmatched `:x:` token counts as literal text → not emoji-only
 *   - any non-whitespace remainder → not emoji-only
 *   - zero resolved emoji → not emoji-only
 * `emojiMap` must be non-empty or the result is always false (no emoji render).
 */
export function isEmojiOnlyMessage(src: string, emojiMap: Map<string, string>): boolean {
  if (!emojiMap || emojiMap.size === 0) return false
  const re = /:([^:\s]+):/g
  let lastIndex = 0
  let matched = false
  let remainder = ''
  let match: RegExpExecArray | null
  while ((match = re.exec(src)) !== null) {
    if (emojiMap.get(match[1])) {
      matched = true
      remainder += src.slice(lastIndex, match.index)
      lastIndex = match.index + match[0].length
    }
  }
  remainder += src.slice(lastIndex)
  if (!matched) return false
  return remainder.trim() === ''
}

/**
 * Splits `text` on `:keyword:` tokens that hit `map`. Hits become img parts;
 * misses stay literal text including the colons (no fallback rewriting).
 */
export function replaceEmojiTokens(
  text: string,
  map: Map<string, string>,
): EmojiTokenPart[] {
  const parts: EmojiTokenPart[] = []
  const re = /:([^:\s]+):/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const url = map.get(match[1])
    if (url) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
      }
      parts.push({ type: 'img', url })
      lastIndex = match.index + match[0].length
    }
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) })
  }
  return parts
}

/**
 * Pure predicate: is `url` an emoji image that the Service Worker should cache?
 * True only when `url` is an https string starting with one of `prefixes`.
 * Mirrors the matching rule implemented independently in static/sw.js (which
 * cannot import this TS module).
 */
export function isEmojiImageUrl(prefixes: string[], url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false
  return prefixes.some((p) => typeof p === 'string' && url.startsWith(p))
}

/** Fallback when config `emoji[]` is empty (client wiring happens in T6/T7). */
export const BUILTIN_EMOJI_ENTRIES: unknown[] = ['https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/']

export interface ManifestPackEntry {
  name: string
  base: string
  icon: string
  prefix: string
  type: string
  keywords: string[]
}

export interface EmojiManifest {
  v: 1
  ts: number
  packs: ManifestPackEntry[]
}

/**
 * Rebuilds EmojiPacks from a vendored manifest JSON (see
 * scripts/vendor-emoji.ts). DATA ONLY: entries failing the shape check are
 * skipped silently; non-https bases are dropped. The urlOf join rule mirrors
 * loadRemoteManifest so vendored and live packs render identically.
 */
export function packsFromManifest(m: unknown): EmojiPack[] {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return []
  const packs = (m as { packs?: unknown }).packs
  if (!Array.isArray(packs)) return []
  const out: EmojiPack[] = []
  for (const p of packs) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) continue
    const o = p as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.base !== 'string' || !Array.isArray(o.keywords)) {
      continue
    }
    if (!o.base.startsWith('https://')) continue
    const base = o.base.endsWith('/') ? o.base : o.base + '/'
    const type = typeof o.type === 'string' ? o.type : ''
    const prefix = typeof o.prefix === 'string' ? o.prefix : ''
    const icon = typeof o.icon === 'string' ? o.icon : ''
    const keywords = (o.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
    out.push({
      name: o.name,
      icon,
      keywords,
      prefix,
      urlOf: (kw: string) => (type ? base + prefix + kw + '.' + type : base + prefix + kw),
    })
  }
  return out
}
