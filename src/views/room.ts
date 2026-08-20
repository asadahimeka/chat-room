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
 *   #online-count  online count span
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
}

export function renderRoomPage({ roomId, title }: RoomPageProps): string {
  const pageTitle = `${roomId} - Chat Room`
  const data = JSON.stringify({ roomId, title: title ?? '' })
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
        <link rel="icon" href="/favicon.ico">
        <link rel="stylesheet" href="/static/css/room.css">
        <script type="application/json" id="room-data">${data}</script>
      </head>
      <body>
        <div class="room-layout">
          <header id="room-header" class="status">
            <span id="online-count">0</span>
          </header>
          <aside class="sidebar">
            <div id="user-list"></div>
          </aside>
          <main class="message-list">
            <div id="msg-list"></div>
          </main>
          <footer class="composer">
            <input id="name-input" type="text" placeholder="nickname" maxlength="32">
            <textarea id="msg-input" placeholder="some text..." maxlength="1000"></textarea>
            <input id="name-color" type="color" value="#117743">
            <input id="msg-color" type="color" value="#3d3d3d">
            <button id="send-btn" type="button">Send</button>
          </footer>
        </div>
        <div id="toast" class="toast"></div>
        <script type="module" src="/static/js/room.client.js"></script>
      </body>
    </html>
  `).trim()
}
