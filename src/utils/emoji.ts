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
  urlOf(kw: string): string
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
): Promise<EmojiPack | null> {
  if (!url.startsWith('https://')) {
    console.warn(`[emoji] skip non-https remote pack: ${url}`)
    return null
  }
  const base = url.endsWith('/') ? url : url + '/'
  try {
    const res = await fetchImpl(base + 'info.json')
    if (!res.ok) {
      console.warn(`[emoji] manifest fetch failed (${res.status}): ${base}info.json`)
      return null
    }
    const data: unknown = await res.json()
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      console.warn(`[emoji] invalid manifest shape: ${base}info.json`)
      return null
    }
    const obj = data as Record<string, unknown>
    const { name, type, icon, items } = obj
    if (
      typeof name !== 'string' ||
      typeof type !== 'string' ||
      typeof icon !== 'string' ||
      !Array.isArray(items)
    ) {
      console.warn(`[emoji] invalid manifest shape: ${base}info.json`)
      return null
    }
    const keywords = items.filter((it): it is string => typeof it === 'string')
    return {
      name,
      icon,
      keywords,
      urlOf: (kw: string) => base + kw + '.' + type,
    }
  } catch (err) {
    console.warn(`[emoji] manifest load failed: ${base}info.json — ${(err as Error).message ?? err}`)
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
): Promise<EmojiPack[]> {
  const { packs, remoteUrls } = parseInlineEmojiConfig(entries)
  const remotePacks = await Promise.all(
    remoteUrls.map((url) => loadRemoteManifest(url, fetchImpl)),
  )
  return [...packs, ...remotePacks.filter((p): p is EmojiPack => p !== null)]
}

/**
 * Flattens every pack keyword → its image URL. Any URL that does not start
 * with `https://` is skipped (defense in depth).
 */
export function buildEmojiMap(packs: EmojiPack[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const pack of packs) {
    for (const kw of pack.keywords) {
      const url = pack.urlOf(kw)
      if (url.startsWith('https://')) {
        map.set(kw, url)
      }
    }
  }
  return map
}

export type EmojiTokenPart = { type: 'text'; text: string } | { type: 'img'; url: string }

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

/** Fallback when config `emoji[]` is empty (client wiring happens in T6/T7). */
export const BUILTIN_EMOJI_ENTRIES: unknown[] = ['https://www.nanoka.top/images/stamp/GBC/']