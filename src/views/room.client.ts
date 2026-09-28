/**
 * Client-side chat module (Bun-native port of views/room.ejs).
 *
 * Vanilla TypeScript + native DOM + WebSocket. No jQuery, no framework.
 * Bundled to a browser ES module via `bun build`.
 *
 * Pure helpers are exported for unit testing; the DOM/WS wiring runs on
 * DOMContentLoaded.
 */

import { Notify } from './notify'
import { linkify } from './linkify'
import type { ClientEvent, ClientMessage, JoinedUser, MsgItem } from '../ws/protocol'
export { sanitizeClientId } from '../ws/protocol'
import { renderMarkdown } from '../utils/markdown'
import { resolveEmojiConfig, buildEmojiMap, packsFromManifest, BUILTIN_EMOJI_ENTRIES, isEmojiOnlyMessage, type EmojiPack } from '../utils/emoji'
import { readableColor } from '../utils/color'
import { loadHistoryCache, saveHistoryCache, clearHistoryCache, type CachedMsg } from '../utils/history-cache'
import { applyMetaClasses, buildAvatarEl, serializeOutgoingMeta, safeParseMeta, msgDedupKey, parseReplyFromMeta, buildReplyQuoteEl, isReplyToMe, mergeReplyIntoMeta, REPLY_SNIPPET_MAX, type ReplySnapshot } from '../utils/render'

export const PENDING_TIMEOUT_MS = 8000
export const PIN_TOLERANCE_PX = 32

// ── Task 4: History loading tri-state tip ─────────────────────────────
export type HistoryTipState = 'hidden' | 'loading' | 'error' | 'end'

/** Returns the user-facing text for a given history tip state. */
export function historyTipText(state: HistoryTipState): string {
  switch (state) {
    case 'loading':
      return '加载历史中…'
    case 'error':
      return '加载失败，点击重试'
    case 'end':
      return '没有更多历史了'
    case 'hidden':
      return ''
  }
}

export function isPinned(scrollTop: number, clientHeight: number, scrollHeight: number, tolerance = PIN_TOLERANCE_PX): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance
}

export function formatUnreadLabel(n: number): string {
  if (n <= 0) return ''
  return n > 99 ? '↓ 99+ 条新消息' : `↓ ${n} 条新消息`
}

export function shouldCountAsUnread(kind: 'sys' | 'msg', isSelf: boolean): boolean {
  return kind === 'sys' ? true : !isSelf
}

/**
 * Unread gate: only LIVE arrivals while scrolled up count. Bulk history
 * load (cache restore / fetchRecord, ~100 appends while scrollTop sits at 0)
 * must never drive the pill — otherwise it visibly counts up on every init
 * and flashes away on the landing scroll.
 */
export function shouldAccumulateUnread(live: boolean, pinned: boolean): boolean {
  return live && !pinned
}

/**
 * Pill visibility: show ONLY when the reader is scrolled up AND there are
 * unreads. The previous `pinned && unread === 0` (&&) showed an empty pill
 * whenever unpinned, and flashed it during initial history load.
 */
export function shouldHidePill(pinned: boolean, unreadCount: number): boolean {
  return pinned || unreadCount <= 0
}

/**
 * Builds the wire payload for an outgoing chat message. clientId MUST live
 * inside `data` — the server reads `event.data.clientId` (see
 * src/ws/handler.ts); a top-level clientId is silently ignored, which broke
 * echo matching and duplicated own messages.
 */
export function buildMessagePayload(fields: ClientMessage, clientId: string): ClientEvent {
  return { type: 'message', data: { ...fields, clientId } }
}

export function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

export function escapeRegex(str: string): string {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
}

export function buildMentionRegex(uid: string): RegExp {
  return new RegExp('@.*\\((' + escapeRegex(uid) + ')\\)')
}

export function shouldHighlight(msg: string, uid: string): boolean {
  if (!msg) return false
  return buildMentionRegex(uid).test(msg)
}

export function genSid(): string {
  return Math.random().toString(36).substr(2, 7)
}

export function isBlocked(uid: string, blockList: string[]): boolean {
  return blockList.indexOf(uid) !== -1
}

export function journeyAdReplace(msg: string): string {
  return msg.replace(/\u53d8\u6001/g, '\u597d\u4eba')
}

/**
 * Reverses the server-side xss() entity escaping so markdown line-start
 * syntax (`> quote`) matches again. Rendering stays createElement/textContent,
 * which re-escapes everything safely — this cannot introduce HTML injection.
 */
export function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Maps a POST /upload HTTP status to a user-facing toast message.
 * Mirrors the error contract in src/router/upload.ts (400/413/415/429/503).
 */
export function uploadErrorMsg(code: number): string {
  switch (code) {
    case 400:
      return 'Profile required'
    case 413:
      return 'Image exceeds the size limit'
    case 415:
      return 'Unsupported image type'
    case 429:
      return 'Daily upload quota exceeded'
    case 503:
      return 'Storage unavailable'
    default:
      return 'Upload failed'
  }
}

export function inIframe(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch (e) {
    console.log(e)
    return true
  }
}

export function isMobile(ua: string): boolean {
  return /(iPad)|(iPhone)|(iPod)|(android)|(webOS)/i.test(ua)
}

export function parseRoomData(el: HTMLElement | null): {
  roomId: string
  title: string
  emoji?: unknown[]
  uploadHost?: string
  emojiManifestUrl?: string
} {
  if (!el || !el.textContent) return { roomId: '', title: '' }
  try {
    const data = JSON.parse(el.textContent) as {
      roomId?: string
      title?: string
      emoji?: unknown
      uploadHost?: string
      emojiManifestUrl?: unknown
    }
    return {
      roomId: data.roomId ?? '',
      title: data.title ?? '',
      emoji: Array.isArray(data.emoji) ? data.emoji : undefined,
      uploadHost: typeof data.uploadHost === 'string' ? data.uploadHost : undefined,
      // Only same-origin vendored manifests are trusted (built via
      // `bun run vendor-emoji`); anything else falls back to direct fetch.
      emojiManifestUrl:
        typeof data.emojiManifestUrl === 'string' &&
        data.emojiManifestUrl.startsWith('/static/emoji-manifest-')
          ? data.emojiManifestUrl
          : undefined,
    }
  } catch (e) {
    console.log(e)
    return { roomId: '', title: '' }
  }
}

function getCookie(name: string): string {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : ''
}

function setCookie(name: string, value: string): void {
  const date = new Date()
  date.setTime(date.getTime() + 7 * 24 * 60 * 60 * 1000)
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${date.toUTCString()}`
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

async function init(): Promise<void> {
  const roomData = parseRoomData(document.getElementById('room-data'))
  const roomId = roomData.roomId
  const title = roomData.title
  // Origin of the site's upload storage host; used to pick the image referrer
  // policy (strict-origin-when-cross-origin for same-host images, else no-referrer).
  const uploadHost = roomData.uploadHost

  const msgList = el<HTMLDivElement>('msg-list')
  const userList = el<HTMLDivElement>('user-list')
  const onlineCount = el<HTMLSpanElement>('online-count')
  const onlineCountSide = el<HTMLSpanElement>('online-count-side')
  const nameInput = el<HTMLInputElement>('name-input')
  const msgInput = el<HTMLTextAreaElement>('msg-input')
  const nameColor = el<HTMLInputElement>('name-color')
  const msgColor = el<HTMLInputElement>('msg-color')
  const sendBtn = el<HTMLButtonElement>('send-btn')
  const header = el<HTMLElement>('room-header')

  const notify = new Notify()
  let userInfo: JoinedUser | null = null
  let blockList: string[] = []
  let socket: WebSocket | null = null
  let reconnectAttempts = 0
  let reconnectTimer: number | null = null
  let offset = 100
  const limit = 100
  let loading = false
  let finished = false
  let unread = 0
  // Becomes true once the initial history bulk-load has landed at the
  // bottom. Gates unread accumulation (see shouldAccumulateUnread).
  let liveMode = false
  // Stick-to-bottom: the persistent intent to stay pinned. Set on every
  // user scroll (true only when actually pinned), engaged by landings /
  // own sends / pill clicks. Unlike an instantaneous pinned-check, the
  // stick survives sequential layout growth (many images loading one by
  // one), where each grower's own gap would otherwise defeat every re-pin.
  let stickToBottom = true
  // Reply target riding the composer: the quoted message snapshot shown in
  // the #reply-bar preview and merged into outgoing meta on send.
  let replyTarget: ReplySnapshot | null = null
  const pill = el<HTMLButtonElement>('scroll-bottom')
  const historyTip = el<HTMLElement>('history-tip')

  // ── Task 4: history loading tri-state ───────────────────────────────
  let historyTipState: HistoryTipState = 'hidden'
  function setTip(state: HistoryTipState): void {
    historyTipState = state
    historyTip.textContent = historyTipText(state)
    historyTip.hidden = state === 'hidden'
  }

  function renderPill(): void {
    pill.textContent = formatUnreadLabel(unread)
    pill.hidden = shouldHidePill(
      isPinned(msgList.scrollTop, msgList.clientHeight, msgList.scrollHeight),
      unread,
    )
  }

  // Reads the active theme's --bg custom property (the surface chat messages
  // sit on) so per-message colors can be made readable against it.
  function currentThemeBg(): string {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      if (v) return v
    } catch (e) {
      // getComputedStyle unavailable — fall back to the light default
      console.log(e)
    }
    return '#f6f2fa'
  }

  // De-duplication guard for rendered chat messages. A reconnect re-fetches the
  // record and re-receives WS echoes, which would otherwise double-render the
  // same message. Capped at 500 entries with FIFO eviction to avoid leaks.
  const renderedMsgKeys = new Set<string>()
  const MAX_RENDERED_KEYS = 500

  // Optimistic send: track pending messages by clientId so echoes can
  // transition them from .pending → confirmed, and failed sends can be
  // retried via the .failed click handler.
  const pendingMap = new Map<string, { node: HTMLElement; timer: ReturnType<typeof setTimeout> }>()
  // Seen clientIds that have already been confirmed or timed out. A late echo
  // (after timeout) for a known clientId is silently dropped — the .failed node
  // already shows the content and the user clicks to resend as a new message.
  // Capped at 500 with FIFO eviction to prevent leaks.
  const seenClientIds = new Set<string>()
  const MAX_SEEN_CLIENT_IDS = 500

  const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement | null
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      try {
        localStorage.setItem('theme', next)
      } catch (e) {
        // storage unavailable (private mode etc.) — theme still switches for this page
        console.log(e)
      }
      // Recompute every per-message color against the new theme background so
      // user-chosen nickname / message colors stay readable after a switch.
      const bg = currentThemeBg()
      msgList.querySelectorAll<HTMLElement>('[data-original-color]').forEach((el) => {
        const orig = el.dataset.originalColor
        if (!orig) return
        el.style.color = readableColor(orig, bg, orig)
      })
    })
  }

  try {
    blockList = JSON.parse(localStorage.getItem('blockList') || '[]') || []
  } catch (e) {
    console.log(e)
    blockList = []
  }

  // Outgoing message-style prefs (reader only — the settings modal writer
  // arrives in T7). Missing fields serialize as defaults.
  let userPrefs: {
    avatar?: string
    font?: string
    size?: string
    bold?: boolean
    italic?: boolean
    bubble?: string
    namecolor?: string
    msgcolor?: string
  } = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('settings') || '{}')
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      userPrefs = stored as typeof userPrefs
    }
  } catch (e) {
    console.log(e)
    userPrefs = {}
  }

  // Client-side hex color validation (mirrors server REGEX_HEX_COLOR intent).
  // Invalid or missing values fall back to the design defaults.
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
  const DEFAULT_NAME_COLOR = '#117743'
  const DEFAULT_MSG_COLOR = '#3d3d3d'
  function sanitizeColor(v: unknown, fallback: string): string {
    return typeof v === 'string' && HEX_COLOR.test(v) ? v : fallback
  }
  userPrefs.namecolor = sanitizeColor(userPrefs.namecolor, DEFAULT_NAME_COLOR)
  userPrefs.msgcolor = sanitizeColor(userPrefs.msgcolor, DEFAULT_MSG_COLOR)

  // Emoji packs are resolved before the first record fetch (Fix 4a) so the
  // history renders with emoji already mapped. The map starts empty and is
  // filled synchronously once the await below resolves.
  let emojiMap = new Map<string, string>()
  let emojiPacks: EmojiPack[] = []
  const emojiEntries = roomData.emoji && roomData.emoji.length ? roomData.emoji : BUILTIN_EMOJI_ENTRIES

  // Register the Service Worker that cache-first serves emoji images. This is a
  // pure optimization: any registration / messaging failure is silently ignored
  // and emoji still load over the network.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const prefixes = emojiEntries.filter(
          (e): e is string => typeof e === 'string' && e.startsWith('https://'),
        )
        // Also cache-first serve uploaded images from the room's upload host.
        if (typeof uploadHost === 'string' && uploadHost.startsWith('https://')) {
          prefixes.push(uploadHost.endsWith('/') ? uploadHost : uploadHost + '/')
        }
        const send = (target: ServiceWorker | null): void => {
          try {
            target?.postMessage({ type: 'emoji-prefixes', prefixes })
            // Also let the SW cache-first serve the hashed app-shell assets.
            const jsUrl = [...document.querySelectorAll('script[src]')]
              .filter(Boolean)
              .map(e => e.getAttribute('src'))
            const cssUrl = [...document.querySelectorAll('link[rel="stylesheet"]')]
              .filter(Boolean)
              .map(e => e.getAttribute('href'))
            const shellUrls = [...jsUrl, ...cssUrl]
              .filter((u): u is string => Boolean(u))
              .map((u) => new URL(u, location.origin).href)
            if (shellUrls.length > 0) {
              target?.postMessage({ type: 'app-shell', urls: shellUrls })
            }
          } catch (e) {
            console.log(e)
            // messaging is best-effort
          }
        }
        const active = reg.active ?? navigator.serviceWorker.controller
        if (active) {
          send(active)
        } else {
          // No active controller yet (first install) — send once it takes over.
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => send(navigator.serviceWorker.controller),
            { once: true },
          )
        }
      })
      .catch((e) => {
        // SW registration is best-effort
        console.log(e)
      })
  }

  const emojiPanel = el<HTMLDivElement>('emoji-panel')
  // Non-blocking emoji config: prefer the single same-origin vendored
  // manifest (1 request, built via `bun run vendor-emoji`), then re-render all
  // messages with emoji mapping. Messages render as plain text until either
  // path resolves. No lazy loading: the full pack list is mapped at once.
  async function loadEmoji(): Promise<void> {
    const manifestUrl = roomData.emojiManifestUrl
    if (manifestUrl) {
      try {
        const res = await fetch(manifestUrl, { credentials: 'same-origin' })
        if (res.ok) {
          const packs = packsFromManifest(await res.json())
          if (packs.length > 0) {
            emojiPacks = packs
            emojiMap = buildEmojiMap(packs)
            rerenderEmojis()
            // Refresh the emoji panel if it's currently visible
            !emojiPanel.hidden && renderEmojiPanel()
            // Let the SW cache-first serve the manifest next time (best-effort).
            try {
              navigator.serviceWorker?.controller?.postMessage({
                type: 'emoji-manifest',
                urls: [new URL(manifestUrl, location.origin).href],
              })
            } catch (e) {
              // messaging is best-effort
              console.log(e)
            }
            return
          }
        }
      } catch (e) {
        // fall through to direct fetch
        console.log(e)
      }
    }
    // Fallback: manifest missing/corrupt (fresh clone, vendor never run) —
    // fetch the remote info.json files directly as before.
    try {
      const packs = await resolveEmojiConfig(emojiEntries)
      emojiPacks = packs
      emojiMap = buildEmojiMap(packs)
      rerenderEmojis()
      // Refresh the emoji panel if it's currently visible
      if (!emojiPanel.hidden) renderEmojiPanel()
    } catch(e) {
      // Emoji loading is best-effort; plain text rendering still works.
      console.log(e)
    }
  }
  loadEmoji()

  // Restore a cached history snapshot (stale-while-revalidate): paint it
  // instantly, then fetchRecord() refreshes from the server. The existing
  // de-dup guard ensures any overlap is not rendered twice.
  try {
    const cached = await loadHistoryCache(roomId)
    if (cached.length > 0) {
      for (const m of cached) {
        appendMsg({ ...m, type: 'msg' }, 'after')
      }
      setTimeout(() => {
        msgList.scrollTop = msgList.scrollHeight
        // Cache bulk-load has landed — further arrivals are live.
        liveMode = true
        stickToBottom = true
        renderPill()
      }, 100)
    }
  } catch (e) {
    // Cache restore is best-effort.
    console.log(e)
  }

  function setStatus(text: string, cls: string): void {
    const statusEl = header.querySelector('.status') as HTMLElement | null
    if (!statusEl) return
    let textEl = statusEl.querySelector('.status-text') as HTMLElement | null
    if (!textEl) {
      textEl = document.createElement('span')
      textEl.className = 'status-text'
      statusEl.appendChild(textEl)
    }
    textEl.textContent = text
    statusEl.classList.remove('connected', 'connecting', 'disconnected')
    statusEl.classList.add(cls)
  }

  function updateTitle(online: number): void {
    document.title = `${online}::${userInfo?.name ?? ''}::${userInfo?.uid ?? ''}::${roomId}::${title} - Chat Room`
  }

  function appendMsg(
    item: {
      type: 'sys' | 'msg'
      msg: string
      name?: string
      uid?: string
      time?: string
      /** Raw second-level timestamp used for de-duplication (more precise than
       *  the minute-grained `time` display string). */
      rawTs?: number
      namecolor?: string
      msgcolor?: string
      highlight?: boolean
      meta?: string
    },
    position: 'before' | 'after' = 'after',
    forceScroll = false,
  ): void {
    if (item.type === 'msg' && item.uid && isBlocked(item.uid, blockList)) return

    // De-duplicate chat messages. Reconnects re-fetch the record and re-receive
    // WS echoes, which would otherwise render the same message twice. System
    // messages (sys/init/online) are intentionally NOT de-duplicated. The key
    // uses the raw second-level `rawTs` (not the minute-grained `time` string)
    // so two identical messages sent in the same minute are NOT swallowed.
    if (item.type === 'msg') {
      const key = msgDedupKey(item.uid, item.rawTs, item.msg, item.meta)
      if (renderedMsgKeys.has(key)) return
      renderedMsgKeys.add(key)
      if (renderedMsgKeys.size > MAX_RENDERED_KEYS) {
        const oldest = renderedMsgKeys.values().next().value
        if (oldest !== undefined) renderedMsgKeys.delete(oldest)
      }
    }

    // Active theme background, used to keep per-message colors readable.
    const themeBg = currentThemeBg()

    let node: HTMLElement
    let containsLink = false

    if (item.type === 'sys') {
      node = document.createElement('div')
      node.className = 'sys-msg'
      const span = document.createElement('span')
      span.className = 'msg'
      span.textContent = item.msg
      node.appendChild(span)
    } else {
      let msg = unescapeEntities(item.msg)
      if (roomId === 'journey-ad.github') msg = journeyAdReplace(msg)

      node = document.createElement('div')
      node.className = 'message' + (item.highlight ? ' highlight' : '')
      node.dataset.uid = item.uid
      if (userInfo && item.uid === userInfo.uid) node.classList.add('self')

      const avatar = buildAvatarEl(safeParseMeta(item.meta), item.name ?? '?', item.uid)

      const bubble = document.createElement('div')
      bubble.className = 'bubble'

      const nickname = document.createElement('span')
      nickname.className = 'nickname'
      nickname.dataset.uid = item.uid
      nickname.dataset.name = item.name

      const name = document.createElement('span')
      name.className = 'name'
      // Keep the user's chosen color readable against the active theme bg;
      // stash the original so a theme switch can recompute it.
      const nameColorVal = item.namecolor || DEFAULT_NAME_COLOR
      name.dataset.originalColor = nameColorVal
      name.style.color = readableColor(nameColorVal, themeBg, DEFAULT_NAME_COLOR)
      name.textContent = item.name ?? ''
      nickname.appendChild(name)

      const meta = document.createElement('span')
      meta.className = 'meta'
      const uidSpan = document.createElement('span')
      uidSpan.className = 'uid'
      uidSpan.textContent = item.uid ?? ''
      const timeSpan = document.createElement('span')
      timeSpan.className = 'time'
      timeSpan.textContent = item.time ?? ''
      meta.appendChild(uidSpan)
      meta.appendChild(timeSpan)
      nickname.appendChild(meta)

      const msgSpan = document.createElement('span')
      msgSpan.className = 'msg'
      const msgColorVal = item.msgcolor || DEFAULT_MSG_COLOR
      msgSpan.dataset.originalColor = msgColorVal
      msgSpan.style.color = readableColor(msgColorVal, themeBg, DEFAULT_MSG_COLOR)
      // Store raw text for non-blocking emoji rerender
      msgSpan.dataset.raw = msg
      containsLink = renderMarkdown(msgSpan, msg, emojiMap, uploadHost).containsLink
      msgSpan.dataset.hasLink = String(containsLink)

      if (isEmojiOnlyMessage(msg, emojiMap)) bubble.classList.add('emoji-only')

      const replySnap = parseReplyFromMeta(item.meta)
      if (replySnap) {
        bubble.appendChild(
          buildReplyQuoteEl(
            {
              ruid: replySnap.ruid,
              rname: unescapeEntities(replySnap.rname),
              rmsg: unescapeEntities(replySnap.rmsg),
            },
            userInfo?.uid,
            isBlocked(replySnap.ruid, blockList),
          ),
        )
        node.dataset.replyUid = replySnap.ruid
        if (isReplyToMe(replySnap, userInfo?.uid)) node.classList.add('reply-to-me')
      }

      bubble.appendChild(nickname)
      bubble.appendChild(msgSpan)
      applyMetaClasses(bubble, safeParseMeta(item.meta))
      node.appendChild(avatar)
      node.appendChild(bubble)
    }

    if (position === 'before') {
      msgList.prepend(node)
    } else {
      msgList.appendChild(node)
      // Stick-to-bottom: own messages engage the stick and always land at
      // the bottom; otherwise scroll only while the stick is engaged (the
      // reader is pinned — reading history is never yanked down).
      if (forceScroll) stickToBottom = true
      if (stickToBottom) {
        setTimeout(() => {
          msgList.scrollTop = msgList.scrollHeight
        }, 100)
      }
      // Track unread count for the scroll-to-bottom pill (live arrivals only;
      // bulk history load is gated by liveMode — see shouldAccumulateUnread).
      if (shouldAccumulateUnread(liveMode, isPinned(msgList.scrollTop, msgList.clientHeight, msgList.scrollHeight))) {
        if (shouldCountAsUnread(item.type, item.type === 'msg' && item.uid === userInfo?.uid)) {
          unread++
          renderPill()
        }
      }
    }

    // Group consecutive messages from the same user (avatar/meta hidden via .threaded)
    if (node.classList.contains('message')) {
      const sibling = (
        position === 'before' ? node.nextElementSibling : node.previousElementSibling
      ) as HTMLElement | null
      if (sibling && sibling.classList.contains('message') && sibling.dataset.uid === node.dataset.uid) {
        node.classList.add('threaded')
      }
    }

    // linkify runs for sys messages as before; for chat messages only when
    // renderMarkdown produced no link (avoids double-wrapping).
    if (item.type === 'sys' || !containsLink) {
      const msgEl = node.querySelector('.msg')
      if (msgEl) linkify(msgEl as HTMLElement)
    }
  }

  /**
   * Re-renders all chat messages with the newly loaded emoji mapping.
   * Called once the non-blocking emoji config resolves. Only touches
   * .msg spans inside .message nodes; system messages are left as-is.
   */
  function rerenderEmojis(): void {
    for (const msgEl of msgList.querySelectorAll<HTMLElement>('.message .msg')) {
      const raw = msgEl.dataset.raw
      if (raw === undefined) continue // sys messages or stale DOM — skip

      // Clear existing content (safe: textContent = '' removes children)
      msgEl.textContent = ''

      // Re-render markdown with the loaded emoji map
      const { containsLink } = renderMarkdown(msgEl, raw, emojiMap, uploadHost)

      // Update dataset.hasLink for subsequent linkify decisions
      msgEl.dataset.hasLink = String(containsLink)

      // Re-run linkify if the message had no markdown links
      if (!containsLink) {
        linkify(msgEl)
      }

      // Update bubble emoji-only class
      const bubble = msgEl.closest('.bubble') as HTMLElement | null
      if (bubble) {
        bubble.classList.toggle('emoji-only', isEmojiOnlyMessage(raw, emojiMap))
      }
    }
  }

  function renderOnline(users: JoinedUser[]): void {
    onlineCount.textContent = String(users.length)
    if (onlineCountSide) onlineCountSide.textContent = String(users.length)
    updateTitle(users.length)
    userList.textContent = ''
    for (const u of users) {
      const item = document.createElement('div')
      item.className = 'user-item' + (userInfo && u.uid === userInfo.uid ? ' cur' : '')
      item.dataset.uid = u.uid
      item.dataset.name = u.name

      const dot = document.createElement('span')
      dot.className = 'dot'
      const uname = document.createElement('span')
      uname.className = 'uname'
      uname.textContent = `${u.name}(${u.uid})`

      item.appendChild(dot)
      item.appendChild(uname)
      userList.appendChild(item)
    }
  }

  function fillMention(name: string, uid: string): void {
    msgInput.value += `@${name}(${uid}) `
    msgInput.focus()
    autoGrow()
  }

  function showActionPopover(anchor: HTMLElement, name: string, uid: string, rawMsg = ''): void {
    const existing = document.querySelector('.action')
    if (existing) existing.remove()

    const rect = anchor.getBoundingClientRect()
    const action = document.createElement('div')
    action.className = 'action'
    action.style.position = 'fixed'
    action.style.top = `${Math.max(8, rect.top - 48)}px`
    action.style.left = `${rect.left}px`
    action.style.setProperty('--transform-origin', 'top left')

    const atLink = document.createElement('a')
    atLink.href = 'javascript:;'
    atLink.textContent = `@${name}`
    atLink.addEventListener('click', (e) => {
      e.preventDefault()
      fillMention(name, uid)
      action.remove()
    })

    const replyLink = document.createElement('a')
    replyLink.href = 'javascript:;'
    replyLink.textContent = `回复 ${name}`
    replyLink.addEventListener('click', (e) => {
      e.preventDefault()
      setReplyTarget({ ruid: uid, rname: name, rmsg: rawMsg.substring(0, REPLY_SNIPPET_MAX) })
      msgInput.focus()
      action.remove()
    })

    const blockLink = document.createElement('a')
    blockLink.href = 'javascript:;'
    blockLink.textContent = `Block ${name}`
    blockLink.addEventListener('click', (e) => {
      e.preventDefault()
      if (confirm(`Are you sure to block ${name}?`)) {
        blockList.push(uid)
        localStorage.setItem('blockList', JSON.stringify(blockList))
        msgList.querySelectorAll(`.message[data-uid="${uid}"]`).forEach((n) => n.remove())
      }
      action.remove()
    })

    action.appendChild(atLink)
    action.appendChild(replyLink)
    action.appendChild(blockLink)
    document.body.appendChild(action)

    const dismiss = () => action.remove()
    document.addEventListener('click', dismiss, { once: true })
    action.addEventListener('click', (e) => e.stopPropagation())
  }

  function autoGrow(): void {
    msgInput.style.height = 'auto'
    const max = parseInt(getComputedStyle(msgInput).maxHeight, 10) || 220
    msgInput.style.height = `${Math.min(msgInput.scrollHeight, max)}px`
    msgInput.style.overflowY = msgInput.scrollHeight > max ? 'auto' : 'hidden'
  }
  autoGrow()

  function markFailed(clientId: string): void {
    const entry = pendingMap.get(clientId)
    if (!entry) return
    pendingMap.delete(clientId)
    clearTimeout(entry.timer)
    entry.node.classList.remove('pending')
    entry.node.classList.add('failed')
    // Track clientId so a late echo (after timeout) is dropped.
    if (seenClientIds.size >= MAX_SEEN_CLIENT_IDS) {
      const oldestCid = seenClientIds.values().next().value
      if (oldestCid !== undefined) seenClientIds.delete(oldestCid)
    }
    seenClientIds.add(clientId)
    // Attach click-to-resend: removes old node and runs full send() with new clientId.
    entry.node.addEventListener('click', () => {
      entry.node.remove()
      // Restore the raw message text (preserves markdown syntax) into the
      // input so the user can edit before resend.
      const rawMsg = (entry.node.querySelector('.msg') as HTMLElement | null)?.dataset?.raw
        ?? entry.node.querySelector('.msg')?.textContent
        ?? ''
      // If the input is empty, fill it with the failed message; otherwise
      // send whatever the user has typed (send() reads msgInput directly).
      if (!msgInput.value.trim()) {
        msgInput.value = rawMsg
      }
      send()
    }, { once: true })
    showToast('发送失败，点击消息可重试')
  }

  function send(): void {
    const name = nameInput.value
    const msg = msgInput.value.trim()
    if (!name || !msg || !userInfo) return
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast('还没连上，稍后重试')
      return
    }

    const clientId = genSid()
    const outgoingMeta = replyTarget
      ? mergeReplyIntoMeta(serializeOutgoingMeta(userPrefs), replyTarget)
      : serializeOutgoingMeta(userPrefs)
    const payload = buildMessagePayload(
      {
        uid: userInfo.uid,
        name,
        msg,
        namecolor: userPrefs.namecolor ?? DEFAULT_NAME_COLOR,
        msgcolor: userPrefs.msgcolor ?? DEFAULT_MSG_COLOR,
        meta: outgoingMeta,
      },
      clientId,
    )

    // Optimistic append: render a .pending placeholder immediately.
    appendMsg({
      type: 'msg',
      name,
      uid: userInfo.uid,
      time: formatTime(Date.now() / 1000),
      rawTs: Date.now() / 1000,
      msg,
      namecolor: userPrefs.namecolor,
      msgcolor: userPrefs.msgcolor,
      highlight: false,
      meta: outgoingMeta,
    }, 'after', true)

    // Grab the just-appended node (last child of msgList).
    const pendingNode = msgList.lastElementChild as HTMLElement | null
    if (pendingNode) {
      pendingNode.classList.add('pending')
      pendingNode.dataset.clientId = clientId
    }

    // Start timeout timer — if no echo within 8s, mark as failed.
    const timer = setTimeout(() => markFailed(clientId), PENDING_TIMEOUT_MS)
    if (pendingNode) {
      pendingMap.set(clientId, { node: pendingNode, timer })
    }

    try {
      socket.send(JSON.stringify(payload))
    } catch (e) {
      console.log(e)
      markFailed(clientId)
      showToast('发送出错，请重试')
      return
    }

    msgInput.value = ''
    setReplyTarget(null)
    msgInput.style.height = ''
    autoGrow()
    // Fallback: make sure the composer's own send lands the view at the bottom
    // even before the WS echo round-trips back (the echo also force-scrolls).
    stickToBottom = true
    setTimeout(() => {
      msgList.scrollTop = msgList.scrollHeight
    }, 100)
  }

  function connect(): void {
    setStatus('connecting...', 'connecting')
    const sid = genSid()
    const ws = new WebSocket(`${location.protocol == 'https:' ? 'wss' : 'ws'}://${location.host}/ws?roomId=${encodeURIComponent(roomId)}&t=${sid}`)
    socket = ws

    ws.onopen = () => {
      reconnectAttempts = 0
      setStatus('connected.', 'connected')
      notify.init()
      appendMsg({ type: 'sys', msg: `Welcome to ${title ? `${title} #${roomId}#` : roomId}!` })
    }

    ws.onmessage = (event) => {
      let payload: { type: string; data: unknown }
      try {
        payload = JSON.parse(event.data)
      } catch (e) {
        console.log(e)
        return
      }

      switch (payload.type) {
        case 'init': {
          const user = payload.data as JoinedUser
          if (userInfo) return
          userInfo = user
          if (!getCookie('uid')) setCookie('uid', user.uid)
          nameInput.value = user.name || user.uid
          // History rendered before init had no identity — tag own bubbles now.
          msgList.querySelectorAll<HTMLElement>('.message[data-uid]').forEach((n) => {
            n.classList.toggle('self', n.dataset.uid === user.uid)
            if (n.dataset.replyUid === user.uid) n.classList.add('reply-to-me')
          })
          break
        }
        case 'online': {
          renderOnline(payload.data as JoinedUser[])
          break
        }
        case 'sys': {
          appendMsg({ type: 'sys', msg: payload.data as string })
          break
        }
        case 'msg': {
          const m = payload.data as MsgItem
          let highlight = false
          if (userInfo && m.uid !== userInfo.uid && shouldHighlight(m.msg, userInfo.uid)) {
            highlight = true
            notify.push({
              roomId,
              from: m.name,
              to: userInfo.name,
              msg: m.msg,
            })
          }
          // Optimistic echo match: if the incoming message carries a clientId
          // that's in our pendingMap, transition the placeholder to confirmed.
          // Register the server-side dedup key (K2) so reconnect fetchRecord
          // doesn't re-render this message.
          if (m.clientId && pendingMap.has(m.clientId)) {
            const entry = pendingMap.get(m.clientId)!
            pendingMap.delete(m.clientId)
            clearTimeout(entry.timer)
            entry.node.classList.remove('pending')
            // Register server-side dedup key (uid|ts|msg) with integer ts,
            // matching the key format used by appendMsg.
            const serverKey = msgDedupKey(m.uid, m.ts, m.msg, m.meta)
            renderedMsgKeys.add(serverKey)
            if (renderedMsgKeys.size > MAX_RENDERED_KEYS) {
              const oldest = renderedMsgKeys.values().next().value
              if (oldest !== undefined) renderedMsgKeys.delete(oldest)
            }
            // Track clientId so a late echo (after timeout) is also dropped.
            if (seenClientIds.size >= MAX_SEEN_CLIENT_IDS) {
              const oldestCid = seenClientIds.values().next().value
              if (oldestCid !== undefined) seenClientIds.delete(oldestCid)
            }
            seenClientIds.add(m.clientId)
            break
          }
          // Late echo: clientId was already seen (confirmed or timed out).
          // Drop silently — .failed node already shows content; user clicks
          // to resend as a new message.
          if (m.clientId && seenClientIds.has(m.clientId)) {
            break
          }
          // Own echoed message forces the view to the bottom; others only
          // scroll if the reader was already pinned there.
          const isSelf = userInfo != null && m.uid === userInfo.uid
          appendMsg({
            type: 'msg',
            name: m.name,
            uid: m.uid,
            time: formatTime(m.ts),
            rawTs: m.ts,
            msg: m.msg,
            namecolor: m.namecolor,
            msgcolor: m.msgcolor,
            highlight,
            meta: m.meta ?? undefined,
          }, 'after', isSelf)
          break
        }
        case 'rename': {
          const info = payload.data as { uid: string; name: string }
          if (userInfo && userInfo.uid === info.uid) {
            userInfo.name = info.name
            nameInput.value = info.name
          }
          break
        }
      }
    }

    ws.onclose = () => {
      setStatus('disconnected.', 'disconnected')
      socket = null
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectAttempts++
      // Single reconnect path: fetchRecord() already opens the WebSocket in
      // both its success and failure branches, so calling connect() here too
      // would create a second socket. One timer → one fetchRecord → one socket.
      reconnectTimer = window.setTimeout(() => {
        fetchRecord()
      }, delay)
    }
  }

  // /record returns DB rows with column name `time`; WS MsgItem carries `ts`.
  // Reading .ts here silently yields undefined → "Invalid Date" on all history.
  interface RecordRow {
    name: string
    uid: string
    time: number
    msg: string
    namecolor?: string
    msgcolor?: string
    meta?: string | null
  }

  function fetchRecord(): void {
    fetch(`/room/@${roomId}/record?limit=${limit}`)
      .then((r) => r.json())
      .then((data: RecordRow[]) => {
        setStatus('connecting...', 'connecting')
        const reversed = [...data].reverse()
        for (const m of reversed) {
          appendMsg({
            type: 'msg',
            name: m.name,
            uid: m.uid,
            time: formatTime(m.time),
            rawTs: m.time,
            msg: m.msg,
            namecolor: m.namecolor,
            msgcolor: m.msgcolor,
            meta: m.meta ?? undefined,
          })
        }
        // Initial load lands the reader on the newest message.
        setTimeout(() => {
          msgList.scrollTop = msgList.scrollHeight
          // History bulk-load has landed — further arrivals are live.
          liveMode = true
          stickToBottom = true
          renderPill()
        }, 100)
        // Persist a snapshot for instant restore on the next visit
        // (stale-while-revalidate). Fire-and-forget; failures are silent.
        const snapshot: CachedMsg[] = data.map((m) => ({
          type: 'msg',
          name: m.name,
          uid: m.uid,
          time: formatTime(m.time),
          rawTs: m.time,
          msg: m.msg,
          namecolor: m.namecolor,
          msgcolor: m.msgcolor,
          meta: m.meta ?? undefined,
        }))
        saveHistoryCache(roomId, snapshot).catch(() => {})
        connect()
      })
      .catch((e) => {
        console.log(e)
        // No bulk load happened — go live immediately so later arrivals
        // still drive the pill.
        liveMode = true
        renderPill()
        connect()
      })
  }

  function getRecord(): void {
    if (loading || finished) return
    loading = true
    setTip('loading')
    const scrollHeight = msgList.scrollHeight
    fetch(`/room/@${roomId}/record?offset=${offset}&limit=${limit}`)
      .then((r) => r.json())
      .then((data: RecordRow[]) => {
        if (data.length === 0) {
          finished = true
          setTip('end')
          return
        }
        for (const m of data) {
          appendMsg(
            {
              type: 'msg',
              name: m.name,
              uid: m.uid,
              time: formatTime(m.time),
              rawTs: m.time,
              msg: m.msg,
              namecolor: m.namecolor,
              msgcolor: m.msgcolor,
              meta: m.meta ?? undefined,
            },
            'before',
          )
        }
        setTimeout(() => {
          msgList.scrollTop = msgList.scrollHeight - scrollHeight
        }, 100)
        offset += limit
        setTip('hidden')
      })
      .catch((e) => {
        console.log(e)
        setTip('error')
        showToast('历史加载失败')
      })
      .finally(() => {
        loading = false
      })
  }

  // ── Task 4: 200ms debounce for scroll-triggered history load ─────────
  let tipTimer: ReturnType<typeof setTimeout> | null = null
  msgList.addEventListener('scroll', () => {
    if (msgList.scrollTop < 300) {
      if (tipTimer === null) {
        tipTimer = setTimeout(() => {
          tipTimer = null
          getRecord()
        }, 200)
      }
    }
    // The stick follows the reader: any scroll away from the bottom
    // disengages it (later image loads won't yank); scrolling back to the
    // bottom re-engages it. Programmatic pins flow through here as well.
    stickToBottom = isPinned(msgList.scrollTop, msgList.clientHeight, msgList.scrollHeight)
    if (stickToBottom) {
      unread = 0
    }
    renderPill()
  })

  pill.addEventListener('click', () => {
    stickToBottom = true
    msgList.scrollTop = msgList.scrollHeight
    unread = 0
    renderPill()
  })

  // ── Task 4: history tip click → retry on error ─────────────────────
  historyTip.addEventListener('click', () => {
    if (historyTipState === 'error') getRecord()
  })

  // Pin images that load while the stick is engaged. The pin is deferred
  // to the next animation frame: at `load` time layout hasn't applied the
  // new image size yet (scrollHeight is stale), so pinning synchronously
  // lands short and leaves a gap. The stick (not an instantaneous
  // pinned-check) is re-read inside rAF: sequential image growth unpins
  // momentarily by construction, and only a real user scroll-up disengages.
  msgList.addEventListener('load', (e) => {
    const target = e.target as HTMLElement
    if (target.tagName !== 'IMG') return
    requestAnimationFrame(() => {
      if (stickToBottom) {
        msgList.scrollTop = msgList.scrollHeight
      }
    })
  }, true)

  // ── Reply menu entries: desktop right-click + touch long-press ─────────
  let lastLongPressAt = 0
  let suppressNextClick = false

  function openMenuForMessage(msgNode: HTMLElement): void {
    const uid = msgNode.dataset.uid
    const nicknameEl = msgNode.querySelector('.nickname') as HTMLElement | null
    const name = nicknameEl?.dataset.name
    if (!uid || !nicknameEl || !name) return
    const raw = (msgNode.querySelector('.msg') as HTMLElement | null)?.dataset.raw ?? ''
    showActionPopover(nicknameEl, name, uid, raw)
  }

  msgList.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('.md-img') || target.closest('a')) return // keep native menu on images/links
    const msgNode = target.closest('.message') as HTMLElement | null
    if (!msgNode || !msgNode.dataset.uid) return // sys messages are not replyable
    e.preventDefault()
    if (Date.now() - lastLongPressAt < 600) return // long-press timer already opened it
    openMenuForMessage(msgNode)
  })

  // iOS Safari fires no contextmenu on long-press — timer covers it.
  let lpTimer: number | null = null
  let lpStartX = 0
  let lpStartY = 0
  msgList.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    const touch = e.touches[0]
    const target = touch.target as HTMLElement
    if (target.closest('.md-img') || target.closest('a')) return
    const msgNode = target.closest('.message') as HTMLElement | null
    if (!msgNode || !msgNode.dataset.uid) return
    lpStartX = touch.clientX
    lpStartY = touch.clientY
    lpTimer = window.setTimeout(() => {
      lpTimer = null
      lastLongPressAt = Date.now()
      suppressNextClick = true // synthesized click after touchend must not dismiss/reopen
      openMenuForMessage(msgNode)
    }, 500)
  }, { passive: true })

  const cancelLongPress = (e: TouchEvent) => {
    if (lpTimer === null) return
    if (e.type === 'touchmove' && e.touches[0]) {
      const dx = e.touches[0].clientX - lpStartX
      const dy = e.touches[0].clientY - lpStartY
      if (dx * dx + dy * dy < 100) return // <10px drift still counts as a press
    }
    window.clearTimeout(lpTimer)
    lpTimer = null
  }
  msgList.addEventListener('touchmove', cancelLongPress, { passive: true })
  msgList.addEventListener('touchend', cancelLongPress, { passive: true })
  msgList.addEventListener('touchcancel', cancelLongPress, { passive: true })

  document.addEventListener('click', (e) => {
    if (!suppressNextClick) return
    suppressNextClick = false
    e.preventDefault()
    e.stopPropagation()
  }, true)

  sendBtn.addEventListener('click', send)

  // ── Reply composer preview bar (#reply-bar) ──────────────────────────
  const replyBar = document.createElement('div')
  replyBar.id = 'reply-bar'
  replyBar.className = 'reply-bar'
  replyBar.hidden = true
  const replyBarText = document.createElement('span')
  replyBarText.className = 'reply-bar-text'
  const replyBarCancel = document.createElement('a')
  replyBarCancel.href = 'javascript:;'
  replyBarCancel.className = 'reply-bar-cancel'
  replyBarCancel.textContent = '取消'
  replyBar.appendChild(replyBarText)
  replyBar.appendChild(replyBarCancel)
  const composer = document.querySelector('.composer')
  const msgInputWrap = document.querySelector('.msg-input-wrap')
  if (composer && msgInputWrap) composer.insertBefore(replyBar, msgInputWrap)

  function renderReplyBar(): void {
    if (!replyTarget) {
      replyBar.hidden = true
      replyBarText.textContent = ''
      return
    }
    replyBarText.textContent = `回复 ${replyTarget.rname}：${replyTarget.rmsg}`
    replyBar.hidden = false
  }

  function setReplyTarget(reply: ReplySnapshot | null): void {
    replyTarget = reply
    renderReplyBar()
  }

  replyBarCancel.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    setReplyTarget(null)
  })

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && replyTarget) setReplyTarget(null)
  })

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  msgInput.addEventListener('input', autoGrow)

  nameInput.addEventListener('blur', () => {
    const name = nameInput.value.trim()
    if (!name || !userInfo || name === userInfo.name) return
    setCookie('name', name)
    userInfo.name = name
    refreshUploadVisibility()
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'change-name', data: name }))
    }
  })

  userList.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.user-item') as HTMLElement | null
    if (!target) return
    const uid = target.dataset.uid
    const name = target.dataset.name
    if (uid && name) fillMention(name, uid)
  })

  const sidebar = document.querySelector('.sidebar') as HTMLElement | null
  const sidebarToggle = document.querySelector('.sidebar-toggle') as HTMLElement | null
  if (sidebar && sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open')
    })
  }

  // Delegated at document level (not #msg-list): the dismiss-once listener is
  // also on document, and a listener added at a node the opening click has not
  // reached yet would fire for that same click — instantly closing the popover.
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.nickname') as HTMLElement | null
    if (!target) return
    const uid = target.dataset.uid
    const name = target.dataset.name
    if (!uid || !name) return
    const raw = (target.closest('.message')?.querySelector('.msg') as HTMLElement | null)?.dataset.raw ?? ''
    showActionPopover(target, name, uid, raw)
  })

  // ── Settings modal (gear → modal) ──────────────────────────────────────
  const settingsBtn = el<HTMLButtonElement>('settings-btn')
  const settingsModal = el<HTMLDivElement>('settings-modal')
  const settingsClose = el<HTMLButtonElement>('settings-close')
  const setFont = el<HTMLSelectElement>('set-font')
  const setSize = el<HTMLSelectElement>('set-size')
  const setBold = el<HTMLInputElement>('set-bold')
  const setItalic = el<HTMLInputElement>('set-italic')
  const setAvatar = el<HTMLInputElement>('set-avatar')
  const setBubble = el<HTMLSelectElement>('set-bubble')

  const FONT_VALUES = ['default', 'serif', 'mono'] as const
  const SIZE_VALUES = ['sm', 'md', 'lg'] as const
  const BUBBLE_VALUES = ['default', 'flat', 'card', 'minimal'] as const
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

  setFont.value = pick(userPrefs.font, FONT_VALUES, 'default')
  setSize.value = pick(userPrefs.size, SIZE_VALUES, 'md')
  setBold.checked = userPrefs.bold === true
  setItalic.checked = userPrefs.italic === true
  setAvatar.value = typeof userPrefs.avatar === 'string' ? userPrefs.avatar : ''
  setBubble.value = pick(userPrefs.bubble, BUBBLE_VALUES, 'default')
  nameColor.value = userPrefs.namecolor
  msgColor.value = userPrefs.msgcolor

  function persistPrefs(): void {
    try {
      localStorage.setItem('settings', JSON.stringify(userPrefs))
    } catch (e) {
      // storage unavailable — prefs still apply for this page
      console.log(e)
    }
  }

  setFont.addEventListener('change', () => {
    userPrefs.font = setFont.value
    persistPrefs()
  })
  setSize.addEventListener('change', () => {
    userPrefs.size = setSize.value
    persistPrefs()
  })
  setBold.addEventListener('change', () => {
    userPrefs.bold = setBold.checked
    persistPrefs()
  })
  setItalic.addEventListener('change', () => {
    userPrefs.italic = setItalic.checked
    persistPrefs()
  })
  setBubble.addEventListener('change', () => {
    userPrefs.bubble = setBubble.value
    persistPrefs()
  })
  setAvatar.addEventListener('input', () => {
    userPrefs.avatar = setAvatar.value.trim()
    persistPrefs()
    // A valid avatar URL also sets the profile cookie (T8 upload gate).
    if (/^(https:\/\/|data:image\/)/.test(userPrefs.avatar)) {
      setCookie('avatar', userPrefs.avatar)
      refreshUploadVisibility()
    }
  })
  nameColor.addEventListener('input', () => {
    userPrefs.namecolor = sanitizeColor(nameColor.value, DEFAULT_NAME_COLOR)
    persistPrefs()
  })
  msgColor.addEventListener('input', () => {
    userPrefs.msgcolor = sanitizeColor(msgColor.value, DEFAULT_MSG_COLOR)
    persistPrefs()
  })

  function openSettings(): void {
    settingsModal.hidden = false
  }
  function closeSettings(): void {
    settingsModal.hidden = true
  }
  settingsBtn.addEventListener('click', openSettings)
  settingsClose.addEventListener('click', closeSettings)
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.hidden) closeSettings()
  })

  // ── Cache management buttons ─────────────────────────────────────────
  const CONFIRM_RESET_MS = 4000

  function setupCacheButton(
    btn: HTMLButtonElement,
    label: string,
    action: () => Promise<void>,
  ): void {
    let timer: number | null = null
    const reset = () => {
      btn.classList.remove('confirm')
      btn.textContent = 'Clear'
      btn.disabled = false
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('confirm')) {
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        btn.disabled = true
        btn.textContent = 'Clearing…'
        try {
          await action()
          showToast(`${label} cleared`)
        } catch (e) {
          console.log(e)
          showToast(`Failed to clear ${label.toLowerCase()}`)
        }
        reset()
      } else {
        btn.classList.add('confirm')
        btn.textContent = 'Confirm?'
        timer = window.setTimeout(reset, CONFIRM_RESET_MS)
      }
    })
  }

  const clearSettingsBtn = el<HTMLButtonElement>('clear-settings')
  const clearHistoryBtn = el<HTMLButtonElement>('clear-history')
  const clearImagesBtn = el<HTMLButtonElement>('clear-images')

  setupCacheButton(clearSettingsBtn, 'Settings', async () => {
    try {
      localStorage.clear()
    } catch (e) {
      // storage unavailable
      console.log(e)
    }
    // Expire every cookie except the identity pair (name + uid).
    // Cookies were all set with path=/, so expiring with path=/ matches.
    try {
      const keep = new Set(['name', 'uid'])
      for (const entry of document.cookie.split(';')) {
        const key = entry.split('=')[0]?.trim()
        if (!key || keep.has(key)) continue
        document.cookie = `${key}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
      }
    } catch (e) {
      // cookies unavailable
      console.log(e)
    }
  })

  setupCacheButton(clearHistoryBtn, 'History', async () => {
    await clearHistoryCache()
  })

  setupCacheButton(clearImagesBtn, 'Images', async () => {
    if (!('caches' in window)) return
    const keys = await caches.keys()
    for (const key of keys) {
      if (key.startsWith('emoji-img-')) {
        await caches.delete(key)
      }
    }
  })

  // ── Emoji picker panel ─────────────────────────────────────────────────
  const emojiBtn = el<HTMLButtonElement>('emoji-btn')
  // Index of the currently displayed pack; defaults to the first available.
  let emojiPackIndex = 0

  // Panel-level guard: any click inside the panel (tabs, grid images, future
  // content) must never reach the document-level outside-click dismiss below.
  emojiPanel.addEventListener('click', (e) => e.stopPropagation())

  function renderEmojiGrid(): HTMLElement {
    const grid = document.createElement('div')
    grid.className = 'emoji-grid'
    const pack = emojiPacks[emojiPackIndex]
    if (pack) {
      // Prefixed packs insert a qualified token (:prefixkw:) so same-named
      // emojis across packs stay distinct; unprefixed packs keep the bare :kw:.
      const tokenPrefix = typeof pack.prefix === 'string' ? pack.prefix : ''
      for (const kw of pack.keywords) {
        const url = pack.urlOf(kw)
        if (!url.startsWith('https://')) continue
        const img = document.createElement('img')
        img.src = url
        img.alt = `:${tokenPrefix}${kw}:`
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('click', () => insertEmojiToken(tokenPrefix + kw))
        grid.appendChild(img)
      }
    }
    return grid
  }

  function renderEmojiTabs(): HTMLElement {
    const tabs = document.createElement('div')
    tabs.className = 'emoji-tabs'
    emojiPacks.forEach((pack, i) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'emoji-tab' + (i === emojiPackIndex ? ' active' : '')
      tab.title = pack.name
      const iconUrl = pack.icon ? pack.urlOf(pack.icon) : ''
      if (iconUrl.startsWith('https://')) {
        const icon = document.createElement('img')
        icon.className = 'emoji-tab-icon'
        icon.src = iconUrl
        icon.alt = pack.name
        icon.loading = 'lazy'
        icon.referrerPolicy = 'no-referrer'
        tab.appendChild(icon)
      } else {
        const ph = document.createElement('span')
        ph.className = 'emoji-tab-ph'
        ph.textContent = pack.name.charAt(0).toUpperCase()
        tab.appendChild(ph)
      }
      tab.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (emojiPackIndex === i) return
        // Remember the tab rail's horizontal scroll so switching packs doesn't
        // snap it back to the left (renderEmojiPanel rebuilds the DOM).
        const prevTabs = emojiPanel.querySelector('.emoji-tabs') as HTMLElement | null
        const savedScroll = prevTabs ? prevTabs.scrollLeft : 0
        emojiPackIndex = i
        renderEmojiPanel()
        const newTabs = emojiPanel.querySelector('.emoji-tabs') as HTMLElement | null
        if (newTabs) newTabs.scrollLeft = savedScroll
      })
      tabs.appendChild(tab)
    })
    return tabs
  }

  function renderEmojiPanel(): void {
    hideEmojiPreview()
    emojiPanel.textContent = ''
    if (emojiPacks.length === 0) {
      const hint = document.createElement('span')
      hint.className = 'emoji-hint'
      hint.textContent = 'loading…'
      emojiPanel.appendChild(hint)
      return
    }
    emojiPanel.appendChild(renderEmojiGrid())
    emojiPanel.appendChild(renderEmojiTabs())
  }

  function insertEmojiToken(kw: string): void {
    const token = `:${kw}:`
    const start = msgInput.selectionStart ?? msgInput.value.length
    const end = msgInput.selectionEnd ?? start
    msgInput.setRangeText(token, start, end, 'end')
    msgInput.focus()
    autoGrow()
  }

  function positionEmojiPanel(): void {
    const rect = emojiBtn.getBoundingClientRect()
    const panelHeight = emojiPanel.offsetHeight || 240
    const panelWidth = emojiPanel.offsetWidth || 320
    emojiPanel.style.top = `${Math.max(8, rect.top - panelHeight - 8)}px`
    emojiPanel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8))}px`
    emojiPanel.style.setProperty('--transform-origin', 'bottom left')
  }

  emojiBtn.addEventListener('click', () => {
    if (emojiPanel.hidden) {
      renderEmojiPanel()
      emojiPanel.hidden = false
      positionEmojiPanel()
    } else {
      emojiPanel.hidden = true
    }
  })

  // ── Emoji hover preview (singleton floating div, fine-pointer only) ─────
  const emojiPreview = document.createElement('div')
  emojiPreview.style.cssText =
    'position:fixed;z-index:100;pointer-events:none;max-width:120px;max-height:120px;object-fit:contain;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:0;transition:opacity 120ms ease;display:none;'
  document.body.appendChild(emojiPreview)

  let emojiPreviewVisible = false
  let emojiPreviewSrc = ''

  function positionEmojiPreview(e: MouseEvent): void {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pw = 120
    const ph = 120
    let x = e.clientX + 16
    let y = e.clientY + 16
    if (x + pw > vw) x = e.clientX - pw - 8
    if (y + ph > vh) y = e.clientY - ph - 8
    emojiPreview.style.left = `${Math.max(0, x)}px`
    emojiPreview.style.top = `${Math.max(0, y)}px`
  }

  function hideEmojiPreview(): void {
    if (!emojiPreviewVisible) return
    emojiPreviewVisible = false
    emojiPreviewSrc = ''
    emojiPreview.style.opacity = '0'
    setTimeout(() => { emojiPreview.style.display = 'none' }, 130)
  }

  // Event delegation on the emoji panel. Only active for fine pointers.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    function showEmojiPreview(img: HTMLImageElement, e: MouseEvent): void {
      if (emojiPreviewVisible) {
        // Same image — just reposition
        if (emojiPreviewSrc === img.src) {
          positionEmojiPreview(e)
          return
        }
        // Different image — swap src/alt on the existing clone
        const existing = emojiPreview.querySelector('img')
        if (existing) {
          existing.src = img.src
          existing.alt = img.alt
        }
        emojiPreviewSrc = img.src
        positionEmojiPreview(e)
        return
      }
      // First show
      emojiPreviewVisible = true
      emojiPreviewSrc = img.src
      emojiPreview.textContent = ''
      const clone = document.createElement('img')
      clone.src = img.src
      clone.alt = img.alt
      clone.referrerPolicy = 'no-referrer'
      clone.style.cssText = 'display:block;width:100%;height:auto;pointer-events:none;'
      emojiPreview.appendChild(clone)
      emojiPreview.style.display = 'block'
      requestAnimationFrame(() => { emojiPreview.style.opacity = '1' })
      positionEmojiPreview(e)
    }

    emojiPanel.addEventListener('mouseenter', (e) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'IMG' && t.closest('.emoji-grid')) {
        showEmojiPreview(t as HTMLImageElement, e as MouseEvent)
      }
    }, true)

    emojiPanel.addEventListener('mousemove', (e) => {
      if (emojiPreviewVisible) positionEmojiPreview(e)
    }, true)

    emojiPanel.addEventListener('mouseleave', (e) => {
      const t = e.target as HTMLElement
      if (t === emojiPanel || t.classList.contains('emoji-grid') || t.classList.contains('emoji-tabs')) {
        hideEmojiPreview()
      }
    }, true)

    // Also hide on grid scroll
    emojiPanel.addEventListener('scroll', () => {
      hideEmojiPreview()
    }, true)
  }

  // ── Wheel on .emoji-tabs switches pack (event delegation on #emoji-panel) ──
  emojiPanel.addEventListener('wheel', (e) => {
    // Only react when the pointer is over the tab rail
    const tabs = (e.target as HTMLElement).closest('.emoji-tabs')
    if (!tabs) return
    // Shift+wheel (horizontal gesture) → let it scroll the tab rail
    if (e.shiftKey) return
    const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0
    if (dir === 0) return
    const next = emojiPackIndex + dir
    if (next < 0 || next >= emojiPacks.length) return
    e.preventDefault()
    emojiPackIndex = next
    renderEmojiPanel()
    // Scroll the active tab into view using bounding rect delta
    const newTabs = emojiPanel.querySelector('.emoji-tabs') as HTMLElement | null
    if (newTabs) {
      const activeTab = newTabs.children[next] as HTMLElement | undefined
      if (activeTab) {
        const railRect = newTabs.getBoundingClientRect()
        const tabRect = activeTab.getBoundingClientRect()
        if (tabRect.left < railRect.left) {
          newTabs.scrollLeft -= railRect.left - tabRect.left
        } else if (tabRect.right > railRect.right) {
          newTabs.scrollLeft += tabRect.right - railRect.right
        }
      }
    }
  }, { passive: false })

  // Clicking outside the panel (or the button) dismisses it.
  document.addEventListener('click', (e) => {
    if (emojiPanel.hidden) return
    const target = e.target as Node
    if (emojiPanel.contains(target) || emojiBtn.contains(target)) return
    emojiPanel.hidden = true
  })

  // ── Image upload (📷 → POST /upload → insert ![img](url)) ──────────────
  let toastTimer: number | null = null
  function showToast(text: string): void {
    const toast = document.getElementById('toast')
    if (!toast) return
    toast.textContent = text
    toast.classList.add('show')
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('show')
      toastTimer = null
    }, 3000)
  }

  const uploadBtn = el<HTMLButtonElement>('upload-btn')
  const uploadInput = el<HTMLInputElement>('upload-input')

  // Hide the upload entry until the profile gate (name + avatar cookies) is
  // satisfied — POST /upload returns 400 otherwise (see src/router/upload.ts).
  function refreshUploadVisibility(): void {
    const name = getCookie('name').trim()
    const avatar = getCookie('avatar').trim()
    const ok = name !== '' && !name.startsWith('user_') && avatar !== ''
    uploadBtn.hidden = !ok
  }

  uploadBtn.addEventListener('click', () => {
    uploadInput.click()
  })

  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0]
    uploadInput.value = ''
    if (!file) return

    const fd = new FormData()
    fd.append('file', file)

    uploadBtn.disabled = true
    uploadBtn.classList.add('uploading')
    fetch('/upload', { method: 'POST', body: fd })
      .then(async (res) => {
        if (res.status === 200) {
          const data = (await res.json()) as { url?: unknown }
          if (typeof data.url === 'string' && data.url.startsWith('https://')) {
            const token = `![img](${data.url})`
            const start = msgInput.selectionStart ?? msgInput.value.length
            const end = msgInput.selectionEnd ?? start
            msgInput.setRangeText(token, start, end, 'end')
            msgInput.focus()
            autoGrow()
          } else {
            showToast(uploadErrorMsg(0))
          }
        } else {
          showToast(uploadErrorMsg(res.status))
        }
      })
      .catch((e) => {
        console.log(e)
        showToast(uploadErrorMsg(0))
      })
      .finally(() => {
        uploadBtn.disabled = false
        uploadBtn.classList.remove('uploading')
      })
  })

  setStatus('get record...', 'connecting')
  fetchRecord()
  refreshUploadVisibility()

  const Fancybox = (window as any).Fancybox
  if (Fancybox) {
    Fancybox.bind('.message .msg .md-img')
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
}

if (typeof document !== 'undefined' && !isMobile(navigator.userAgent) && !inIframe()) {
  document.body.classList.add('self')
}
