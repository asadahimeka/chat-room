/**
 * Vendor script: aggregates every `emoji[]` URL in config.yml into a single
 * hashed static manifest (`static/emoji-manifest-<sha256:8>.json`).
 *
 * Decoupled from `scripts/build.ts` — run manually, NOT part of the build:
 *
 *   bun run vendor-emoji          # or: bun run scripts/vendor-emoji.ts
 *
 * Run it once after editing `config.yml`'s emoji list, and once on a fresh
 * deploy (the output is gitignored, see .gitignore). Without an output file
 * the client falls back to fetching the 72 remote info.json files directly.
 *
 * Failure semantics: any failure before a successful write leaves the previous
 * manifest untouched. An empty result (all remotes failed) aborts without
 * writing or pruning so the old file keeps serving.
 */

import { readFileSync } from 'node:fs'
import { writeFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const OUT_RE = /^emoji-manifest-[0-9a-f]{8}\.json$/

export async function vendorEmojiManifest(
  yamlPath = './config.yml',
  outDir = './static',
): Promise<string> {
  const yaml = Bun.YAML.parse(readFileSync(yamlPath, 'utf8')) as { emoji?: unknown[] }
  const urls = Array.isArray(yaml.emoji)
    ? yaml.emoji.filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    : []
  const settled = await Promise.all(
    urls.map(async (base0) => {
      const base = base0.endsWith('/') ? base0 : base0 + '/'
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 8000)
        const res = await fetch(base + 'info.json', { signal: ctrl.signal })
        clearTimeout(t)
        if (!res.ok) {
          console.warn(`[vendor-emoji] skip ${base}info.json status=${res.status}`)
          return null
        }
        const data = (await res.json()) as Record<string, unknown>
        if (typeof data.name !== 'string' || !Array.isArray(data.items)) {
          console.warn(`[vendor-emoji] invalid shape ${base}`)
          return null
        }
        return {
          name: data.name,
          base,
          icon: typeof data.icon === 'string' ? data.icon : '',
          prefix: typeof data.prefix === 'string' ? data.prefix : '',
          type: typeof data.type === 'string' ? data.type : '',
          keywords: (data.items as unknown[]).filter((k): k is string => typeof k === 'string'),
        }
      } catch (e) {
        console.warn(`[vendor-emoji] fail ${base}: ${(e as Error).message}`)
        return null
      }
    }),
  )
  const packs = settled.filter((p): p is NonNullable<typeof p> => p !== null)
  // Failure keeps the old file: empty result aborts without writing or pruning.
  if (packs.length === 0) {
    throw new Error('[vendor-emoji] no packs fetched, keeping previous manifest')
  }
  const manifest = { v: 1, ts: Date.now(), packs }
  const body = JSON.stringify(manifest)
  // Hash only the packs array (stable content) so the filename stays the same
  // across runs as long as pack data hasn't changed — preventing 404 storms
  // when old filenames get pruned.
  const hash = createHash('sha256').update(JSON.stringify(packs)).digest('hex').slice(0, 8)
  const name = `emoji-manifest-${hash}.json`
  await writeFile(`${outDir}/${name}`, body)
  // Prune only after the new file landed successfully.
  for (const f of await readdir(outDir)) {
    if (OUT_RE.test(f) && f !== name) await rm(`${outDir}/${f}`, { force: true })
  }
  console.log(`[vendor-emoji] ${packs.length}/${urls.length} packs -> ${name}`)
  return name
}

if (import.meta.main) {
  await vendorEmojiManifest()
}
