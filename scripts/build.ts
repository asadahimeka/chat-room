/**
 * Production build: emits content-hashed app-shell assets.
 *
 * - JS: Bun.build bundles src/views/room.client.ts → static/js/room.client-<hash>.js
 * - CSS: src/style/room.css → static/css/room-<sha256:8>.css
 * - Old hashed artifacts in both dirs are pruned (except the fresh ones) so
 *   re-running never accumulates stale files.
 *
 * The final two filenames are printed (one per line) for easy inspection.
 */

import { readFile, readdir, rm, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const JS_DIR = './static/js'
const JS_SRC = './src/views/room.client.ts'
const CSS_DIR = './static/css'
const CSS_SRC = './src/style/room.css'

async function main(): Promise<void> {
  // 1) Bundle the client module with a content hash in the filename.
  const result = await Bun.build({
    entrypoints: [JS_SRC],
    outdir: JS_DIR,
    naming: '[name]-[hash].[ext]',
    format: 'esm',
    target: 'browser',
    minify: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Bun.build failed')
  }
  const jsArtifact =
    result.outputs.find((o) => o.kind === 'entry-point') ?? result.outputs[0]
  // Bun's [hash] is base36, but the page resolver expects an 8-hex name, so we
  // re-hash the emitted bundle with sha256 and rename it to room.client-<hex>.js.
  const builtPath = jsArtifact.path
  const jsBuf = await readFile(builtPath)
  const jsHash = createHash('sha256').update(jsBuf).digest('hex').slice(0, 8)
  const jsName = `room.client-${jsHash}.js`
  await rename(builtPath, join(JS_DIR, jsName))

  // 2) Bundle the CSS through Bun.build (handles @import, minify, nesting
  //    lowering) and re-hash it to an 8-hex name like the JS branch.
  const cssResult = await Bun.build({
    entrypoints: [CSS_SRC],
    outdir: CSS_DIR,
    naming: '[name]-[hash].[ext]',
    minify: true,
    target: 'browser',
  })
  if (!cssResult.success) {
    for (const log of cssResult.logs) console.error(log)
    throw new Error('Bun.build (css) failed')
  }
  const cssArtifact =
    cssResult.outputs.find((o) => o.path.endsWith('.css')) ?? cssResult.outputs[0]
  const cssBuiltPath = cssArtifact.path
  const cssBuf = await readFile(cssBuiltPath)
  const cssHash = createHash('sha256').update(cssBuf).digest('hex').slice(0, 8)
  const cssName = `room-${cssHash}.css`
  await rename(cssBuiltPath, join(CSS_DIR, cssName))

  // 3) Prune stale hashed artifacts (keep only this run's outputs).
  if (existsSync(JS_DIR)) {
    const jsFiles = await readdir(JS_DIR)
    for (const f of jsFiles) {
      if (/^room\.client.*\.js$/.test(f) && f !== jsName) {
        await rm(join(JS_DIR, f), { force: true })
      }
    }
  }
  if (existsSync(CSS_DIR)) {
    const cssFiles = await readdir(CSS_DIR)
    for (const f of cssFiles) {
      if (/^room-.*\.css$/.test(f) && f !== cssName) {
        await rm(join(CSS_DIR, f), { force: true })
      }
    }
  }

  console.log(jsName)
  console.log(cssName)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
