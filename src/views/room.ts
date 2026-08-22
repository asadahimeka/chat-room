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
 *   #name-color    name color picker
 *   #msg-color     message color picker
 *   #send-btn      send button
 *   #toast         toast element
 * ──────────────────────────────────────────────────────────────────────
 *
 * Additional structural hooks (new, not part of the hard contract):
 *   #online-count-side  sidebar online count
 *   #name-swatch        name color swatch preview
 *   #msg-swatch         message color swatch preview
 *
 * Contract class names (matching the CSS task): `.room-layout`, `.sidebar`,
 * `.message-list`, `.composer`, `.status`, `.toast`.
 *
 * XSS safety: user-controlled `title`/`roomId` are escaped via
 * `Bun.escapeHTML` in HTML text/attributes, and injected into the page data
 * via `JSON.stringify` (which escapes `<` as `\u003c`), so no raw user input
 * ever reaches the document unescaped.
 */

type RoomPageProps = {
  roomId: string
  title?: string
  emoji?: unknown[]
}

export function renderRoomPage({ roomId, title, emoji }: RoomPageProps): string {
  const pageTitle = `${roomId} - Chat Room`
  const dataObj: Record<string, unknown> = { roomId, title: title ?? '' }
  if (emoji !== undefined) dataObj.emoji = emoji
  const data = JSON.stringify(dataObj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

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
        <link rel="stylesheet" href="/static/css/room.css">
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
            <div id="msg-list"></div>
          </main>
          <footer class="composer">
            <input id="name-input" type="text" placeholder="nickname" maxlength="32">
            <div class="composer-left">
              <label class="color-picker" title="Name color">
                <span class="swatch" id="name-swatch"></span>
                <input id="name-color" type="color" value="#117743">
              </label>
              <label class="color-picker" title="Message color">
                <span class="swatch" id="msg-swatch"></span>
                <input id="msg-color" type="color" value="#3d3d3d">
              </label>
            </div>
            <div class="msg-input-wrap">
              <textarea id="msg-input" rows="1" placeholder="Say something…" maxlength="1000"></textarea>
            </div>
            <button id="send-btn" type="button">
              <svg class="send-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
              <span class="send-label">Send</span>
            </button>
          </footer>
        </div>
        <div id="toast" class="toast"></div>
        <script type="module" src="/static/js/room.client.js"></script>
      </body>
    </html>
  `).trim()
}
