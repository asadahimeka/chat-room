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
import type { JoinedUser, MsgItem } from '../ws/protocol'
import { renderMarkdown } from '../utils/markdown'
import { resolveEmojiConfig, buildEmojiMap, BUILTIN_EMOJI_ENTRIES, isEmojiOnlyMessage, type EmojiPack } from '../utils/emoji'
import { readableColor } from '../utils/color'
import { loadHistoryCache, saveHistoryCache, clearHistoryCache, type CachedMsg } from '../utils/history-cache'
import { applyMetaClasses, buildAvatarEl, serializeOutgoingMeta, safeParseMeta } from '../utils/render'

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
  } catch {
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
} {
  if (!el || !el.textContent) return { roomId: '', title: '' }
  try {
    const data = JSON.parse(el.textContent) as {
      roomId?: string
      title?: string
      emoji?: unknown
      uploadHost?: string
    }
    return {
      roomId: data.roomId ?? '',
      title: data.title ?? '',
      emoji: Array.isArray(data.emoji) ? data.emoji : undefined,
      uploadHost: typeof data.uploadHost === 'string' ? data.uploadHost : undefined,
    }
  } catch {
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

  // Reads the active theme's --bg custom property (the surface chat messages
  // sit on) so per-message colors can be made readable against it.
  function currentThemeBg(): string {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      if (v) return v
    } catch {
      // getComputedStyle unavailable — fall back to the light default
    }
    return '#f6f2fa'
  }

  // De-duplication guard for rendered chat messages. A reconnect re-fetches the
  // record and re-receives WS echoes, which would otherwise double-render the
  // same message. Capped at 500 entries with FIFO eviction to avoid leaks.
  const renderedMsgKeys = new Set<string>()
  const MAX_RENDERED_KEYS = 500

  const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement | null
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      try {
        localStorage.setItem('theme', next)
      } catch {
        // storage unavailable (private mode etc.) — theme still switches for this page
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
  } catch {
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
  } catch {
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
            const jsUrl = document
              .querySelector('script[type="module"][src*="room.client-"]')
              ?.getAttribute('src')
            const cssUrl = document
              .querySelector('link[rel="stylesheet"][href*="room-"]')
              ?.getAttribute('href')
            const shellUrls = [jsUrl, cssUrl]
              .filter((u): u is string => !!u)
              .map((u) => new URL(u, location.origin).href)
            if (shellUrls.length > 0) {
              target?.postMessage({ type: 'app-shell', urls: shellUrls })
            }
          } catch {
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
      .catch(() => {
        // SW registration is best-effort
      })
  }

  try {
    emojiPacks = await resolveEmojiConfig(emojiEntries)
    emojiMap = buildEmojiMap(emojiPacks)
    // Pre-warm the first pack's icon + first-screen images (silent on failure).
    // prewarmEmoji(emojiPacks)
  } catch {
    // Emoji loading is best-effort; plain text rendering still works.
  }

  // Restore a cached history snapshot (stale-while-revalidate): paint it
  // instantly, then fetchRecord() refreshes from the server. The existing
  // de-dup guard ensures any overlap is not rendered twice.
  try {
    const cached = await loadHistoryCache(roomId)
    if (cached.length > 0) {
      for (const m of cached) {
        appendMsg({ ...m, type: 'msg' }, 'after')
      }
      msgList.scrollTop = msgList.scrollHeight
    }
  } catch {
    // Cache restore is best-effort.
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
      const key = `${item.uid ?? ''}|${item.rawTs ?? ''}|${item.msg ?? ''}`
      if (renderedMsgKeys.has(key)) return
      renderedMsgKeys.add(key)
      if (renderedMsgKeys.size > MAX_RENDERED_KEYS) {
        const oldest = renderedMsgKeys.values().next().value
        if (oldest !== undefined) renderedMsgKeys.delete(oldest)
      }
    }

    const scrollFlag =
      msgList.scrollTop + msgList.clientHeight >= msgList.scrollHeight - 2

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

      const avatar = buildAvatarEl(safeParseMeta(item.meta), item.name ?? '?', item.namecolor || '#117743')

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
      containsLink = renderMarkdown(msgSpan, msg, emojiMap, uploadHost).containsLink

      if (isEmojiOnlyMessage(msg, emojiMap)) bubble.classList.add('emoji-only')

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
      // Own messages always land at the bottom; otherwise only scroll when the
      // reader was already pinned there (so reading history isn't yanked down).
      if (scrollFlag || forceScroll) msgList.scrollTop = msgList.scrollHeight
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

  function showActionPopover(anchor: HTMLElement, name: string, uid: string): void {
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

  function send(): void {
    const name = nameInput.value
    const msg = msgInput.value.trim()
    if (!name || !msg || !userInfo || !socket || socket.readyState !== WebSocket.OPEN) return

    socket.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: userInfo.uid,
          name,
          msg,
          namecolor: userPrefs.namecolor,
          msgcolor: userPrefs.msgcolor,
          meta: serializeOutgoingMeta(userPrefs),
        },
      }),
    )
    msgInput.value = ''
    msgInput.style.height = ''
    autoGrow()
    // Fallback: make sure the composer's own send lands the view at the bottom
    // even before the WS echo round-trips back (the echo also force-scrolls).
    msgList.scrollTop = msgList.scrollHeight
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
      } catch {
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
        requestAnimationFrame(() => {
          msgList.scrollTop = msgList.scrollHeight
        })
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
      .catch(() => {
        connect()
      })
  }

  function getRecord(): void {
    if (loading || finished) return
    loading = true
    const scrollHeight = msgList.scrollHeight
    fetch(`/room/@${roomId}/record?offset=${offset}&limit=${limit}`)
      .then((r) => r.json())
      .then((data: RecordRow[]) => {
        if (data.length === 0) {
          finished = true
          appendMsg({ type: 'sys', msg: 'No more record.' }, 'before')
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
        msgList.scrollTop = msgList.scrollHeight - scrollHeight
        offset += limit
      })
      .finally(() => {
        loading = false
      })
  }

  msgList.addEventListener('scroll', () => {
    if (msgList.scrollTop < 300) getRecord()
  })

  sendBtn.addEventListener('click', send)

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
    if (uid && name) showActionPopover(target, name, uid)
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
    } catch {
      // storage unavailable — prefs still apply for this page
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
        } catch {
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
    } catch {
      // storage unavailable
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
    } catch {
      // cookies unavailable
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
  const emojiPanel = el<HTMLDivElement>('emoji-panel')
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
        img.title = kw
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
      .catch(() => {
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
}

/**
 * Pre-warms the first emoji pack's icon and first-screen images by assigning
 * their URLs to `new Image()` (browser only). Failures are silent — this is a
 * pure latency optimization and never affects rendering.
 */
function prewarmEmoji(packs: EmojiPack[]): void {
  if (typeof Image === 'undefined') return
  const pack = packs[0]
  if (!pack) return
  const urls = new Set<string>()
  if (pack.icon) {
    const u = pack.urlOf(pack.icon)
    if (u.startsWith('https://')) urls.add(u)
  }
  // First ~30 keywords cover the panel's first screen without over-fetching.
  for (const kw of pack.keywords.slice(0, 30)) {
    const u = pack.urlOf(kw)
    if (u.startsWith('https://')) urls.add(u)
  }
  for (const u of urls) {
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    img.src = u
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
