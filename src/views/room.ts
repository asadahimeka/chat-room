/**
 * Room page renderer.
 *
 * Renders the full HTML document skeleton for a chat room. All client
 * interaction logic lives in the bundled module `/static/js/room.client.js`
 * (built from `src/views/room.client.ts` via `bun build`); this page only
 * provides the DOM skeleton and the initial data injection.
 *
 * ── DOM CONTRACT (the client module depends on these IDs) ─────────────
 *   #room-header   header bar
 *   #online-count  online count span (header)
 *   #user-list     sidebar user list
 *   #msg-list      message list container
 *   #name-input    nickname input
 *   #msg-input     message textarea
 *   #name-color    name color picker (inside #settings-modal)
 *   #msg-color     message color picker (inside #settings-modal)
 *   #send-btn      send button
 *   #toast         toast element
 * ──────────────────────────────────────────────────────────────────────
 *
 * Additional structural hooks (new, not part of the hard contract):
 *   #online-count-side  sidebar online count
 *
 * Contract class names (matching the CSS task): `.room-layout`, `.sidebar`,
 * `.message-list`, `.composer`, `.status`, `.toast`.
 *
 * XSS safety: user-controlled `title`/`roomId` are escaped via
 * `Bun.escapeHTML` in HTML text/attributes, and injected into the page data
 * via `JSON.stringify` (which escapes `<` as `\u003c`), so no raw user input
 * ever reaches the document unescaped.
 */

import { uploadOrigin } from '../config'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type RoomPageProps = {
  roomId: string
  title?: string
  emoji?: unknown[]
  /** Overrides the derived upload storage origin; tests inject a fixed value. */
  uploadHost?: string
  /** Vendored manifest URL (resolved from ./static at render time, not a prop). */
  emojiManifestUrl?: string
}

/**
 * Picks the newest file in `dir` whose name matches `pattern`, by mtime.
 * Returns null when the directory is missing, empty, or has no match — the
 * caller then falls back to a fixed (dev) asset name. Pure w.r.t. the rest of
 * the module so it can be unit-tested with a temp directory.
 */
export function pickLatestHashed(dir: string, pattern: RegExp): string | null {
  try {
    if (!existsSync(dir)) return null
    let latest: string | null = null
    let latestMtime = -1
    for (const name of readdirSync(dir)) {
      if (!pattern.test(name)) continue
      try {
        const mtime = statSync(join(dir, name)).mtimeMs
        if (mtime > latestMtime) {
          latestMtime = mtime
          latest = name
        }
      } catch {
        // skip entries we cannot stat
      }
    }
    return latest
  } catch {
    return null
  }
}

export function renderRoomPage({ roomId, title, emoji, uploadHost: uploadHostProp }: RoomPageProps): string {
  const pageTitle = `${roomId} - Chat Room`
  const dataObj: Record<string, unknown> = { roomId, title: title ?? '' }
  if (emoji !== undefined) dataObj.emoji = emoji
  // Origin of the upload storage host, so the client can apply a distinct
  // referrer policy to same-host images. Empty when not configured.
  const uploadHost = uploadHostProp ?? uploadOrigin()
  if (uploadHost) dataObj.uploadHost = uploadHost
  // Vendored emoji manifest (gitignored, built via `bun run vendor-emoji`).
  // Missing (fresh clone / vendor never run) → no field → client falls back
  // to fetching the remote info.json files directly. Must run BEFORE `data`
  // is serialized below.
  const emojiManifest = pickLatestHashed('./static', /^emoji-manifest-[0-9a-f]{8}\.json$/)
  if (emojiManifest) dataObj.emojiManifestUrl = `/static/${emojiManifest}`
  const data = JSON.stringify(dataObj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

  // Resolve content-hashed app-shell assets when present; fall back to the
  // fixed dev names otherwise (zero impact when no hash build has run).
  const jsHashed = pickLatestHashed('./static/js', /^room\.client-[0-9a-f]{8}\.js$/)
  const cssHashed = pickLatestHashed('./static/css', /^room-[0-9a-f]{8}\.css$/)
  const jsSrc = `/static/js/${jsHashed}`
  const cssHref = `/static/css/${cssHashed}`

  return (/** html */ `
    <!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <meta name="color-scheme" content="light dark">
        <title>${Bun.escapeHTML(pageTitle)}</title>
        <script>
          (function () {
            try {
              var t = localStorage.getItem('theme')
              if (t !== 'light' && t !== 'dark') {
                t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              }
              document.documentElement.dataset.theme = t
            } catch (e) {
              document.documentElement.dataset.theme = 'light'
            }
          })()
        </script>
        <link rel="icon" href="/favicon.ico">
        <link rel="stylesheet" href="${cssHref}">
        <link rel="stylesheet" href="/static/css/fancybox.min.css">
        <script type="application/json" id="room-data">${data}</script>
      </head>
      <body>
        <div class="room-layout">
          <header id="room-header" class="room-header">
            <h1 class="room-title">${Bun.escapeHTML(title || roomId)}</h1>
            <div class="room-meta">
              <span class="online-pill">
                <span id="online-count">0</span>
                <span class="online-label">online</span>
              </span>
              <span class="status"><span class="status-text"></span></span>
              <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle color theme">
                <svg class="icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
                <svg class="icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>
              </button>
              <button class="sidebar-toggle" type="button" aria-label="Toggle online list">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </button>
            </div>
          </header>
          <aside class="sidebar">
            <div class="sidebar-head">
              <span>Who's here</span>
              <span class="count" id="online-count-side">0</span>
            </div>
            <div id="user-list"></div>
          </aside>
          <main class="message-list">
            <div id="msg-list">
              <div id="history-tip" class="sys-msg" hidden></div>
            </div>
            <button id="scroll-bottom" class="scroll-bottom" type="button" hidden></button>
          </main>
          <footer class="composer">
            <input id="name-input" type="text" placeholder="nickname" maxlength="32">
            <div class="msg-input-wrap">
              <textarea id="msg-input" rows="1" placeholder="Say something…" maxlength="1000"></textarea>
            </div>
            <button id="emoji-btn" class="composer-btn" type="button" aria-label="Emoji"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></button>
            <button id="settings-btn" class="composer-btn" type="button" aria-label="Settings"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg></button>
            <button id="upload-btn" class="composer-btn" type="button" aria-label="Upload image"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
            <input type="file" id="upload-input" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden>
            <button id="send-btn" type="button">
              <svg class="send-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              <span class="send-label">Send</span>
            </button>
          </footer>
        </div>
        <div id="emoji-panel" class="emoji-panel" hidden></div>
        <div id="settings-modal" class="modal-backdrop" hidden>
          <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-head"><span>Settings</span><button id="settings-close" type="button" aria-label="Close">×</button></header>
            <div class="modal-body">
              <label>Name color <input type="color" id="name-color" value="#117743"></label>
              <label>Message color <input type="color" id="msg-color" value="#3d3d3d"></label>
              <label>Font <select id="set-font"><option value="default">Default</option><option value="serif">Serif</option><option value="mono">Mono</option></select></label>
              <label>Size <select id="set-size"><option value="sm">Small</option><option value="md" selected>Medium</option><option value="lg">Large</option></select></label>
              <div class="modal-row modal-style-row">
                <span class="label-text">Style</span>
                <div class="style-toggles">
                  <label><input type="checkbox" id="set-bold"> Bold</label>
                  <label><input type="checkbox" id="set-italic"> Italic</label>
                </div>
              </div>
              <label>Avatar URL <input type="url" id="set-avatar" placeholder="https://..."></label>
              <label>Bubble <select id="set-bubble"><option value="default">Default</option><option value="flat">Flat</option><option value="card">Card</option><option value="minimal">Minimal</option></select></label>
              <div class="cache-section">
                <div class="cache-header">Cache Management</div>
                <div class="cache-row">
                  <span class="cache-label">Settings &amp; blocklist</span>
                  <button class="cache-btn" id="clear-settings" type="button">Clear</button>
                </div>
                <div class="cache-row">
                  <span class="cache-label">Chat history cache</span>
                  <button class="cache-btn" id="clear-history" type="button">Clear</button>
                </div>
                <div class="cache-row">
                  <span class="cache-label">Image cache</span>
                  <button class="cache-btn" id="clear-images" type="button">Clear</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div id="toast" class="toast"></div>
        <script src="/static/js/fancybox.umd.min.js"></script>
        <script type="module" src="${jsSrc}"></script>
      </body>
    </html>
  `).trim()
}
