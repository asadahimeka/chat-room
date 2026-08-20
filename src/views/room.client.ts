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

export function parseRoomData(el: HTMLElement | null): { roomId: string; title: string } {
  if (!el || !el.textContent) return { roomId: '', title: '' }
  try {
    const data = JSON.parse(el.textContent) as { roomId?: string; title?: string }
    return { roomId: data.roomId ?? '', title: data.title ?? '' }
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

function init(): void {
  const roomData = parseRoomData(document.getElementById('room-data'))
  const roomId = roomData.roomId
  const title = roomData.title

  const msgList = el<HTMLDivElement>('msg-list')
  const userList = el<HTMLDivElement>('user-list')
  const onlineCount = el<HTMLSpanElement>('online-count')
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

  try {
    blockList = JSON.parse(localStorage.getItem('blockList') || '[]') || []
  } catch {
    blockList = []
  }

  function setStatus(text: string, cls: string): void {
    header.textContent = ''
    const span = document.createElement('span')
    span.textContent = text
    header.appendChild(span)
    header.classList.remove('connected', 'connecting', 'disconnected')
    header.classList.add(cls)
  }

  function updateTitle(online: number): void {
    document.title = `${online}::${userInfo?.name ?? ''}::${userInfo?.uid ?? ''}::${roomId}::${title} - Chat Room`
  }

  function appendMsg(
    item: { type: 'sys' | 'msg'; msg: string; name?: string; uid?: string; time?: string; namecolor?: string; msgcolor?: string; highlight?: boolean },
    position: 'before' | 'after' = 'after',
  ): void {
    if (item.type === 'msg' && item.uid && isBlocked(item.uid, blockList)) return

    const scrollFlag =
      msgList.scrollTop + msgList.clientHeight >= msgList.scrollHeight - 2

    let node: HTMLElement

    if (item.type === 'sys') {
      node = document.createElement('div')
      node.className = 'sys-msg'
      const span = document.createElement('span')
      span.className = 'msg'
      span.textContent = item.msg
      node.appendChild(span)
    } else {
      let msg = item.msg
      if (roomId === 'journey-ad.github') msg = journeyAdReplace(msg)

      node = document.createElement('div')
      node.className = 'message' + (item.highlight ? ' highlight' : '')
      node.dataset.uid = item.uid
      if (userInfo && item.uid === userInfo.uid) node.classList.add('self')

      const nickname = document.createElement('span')
      nickname.className = 'nickname'
      nickname.dataset.uid = item.uid
      nickname.dataset.name = item.name

      const name = document.createElement('span')
      name.className = 'name'
      name.style.color = item.namecolor || '#117743'
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
      msgSpan.style.color = item.msgcolor || '#3d3d3d'
      msgSpan.textContent = msg

      node.appendChild(nickname)
      node.appendChild(msgSpan)
    }

    if (position === 'before') {
      msgList.prepend(node)
    } else {
      msgList.appendChild(node)
      if (scrollFlag) msgList.scrollTop = msgList.scrollHeight
    }

    const msgEl = node.querySelector('.msg')
    if (msgEl) linkify(msgEl as HTMLElement)
  }

  function renderOnline(users: JoinedUser[]): void {
    onlineCount.textContent = String(users.length)
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
    action.style.top = `${rect.top - 30}px`
    action.style.left = `${rect.left}px`

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
    msgInput.style.overflow = 'hidden'
    msgInput.style.height = '0px'
    let height = msgInput.scrollHeight <= 40 ? msgInput.scrollHeight - 19 : msgInput.scrollHeight
    if (height >= 120) msgInput.style.overflow = ''
    msgInput.style.height = `${height}px`
  }

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
          namecolor: nameColor.value,
          msgcolor: msgColor.value,
        },
      }),
    )
    msgInput.value = ''
    msgInput.style.height = ''
    autoGrow()
  }

  function connect(): void {
    setStatus('connecting...', 'connecting')
    const sid = genSid()
    const ws = new WebSocket(`ws://${location.host}/ws?roomId=${encodeURIComponent(roomId)}&t=${sid}`)
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
          appendMsg({
            type: 'msg',
            name: m.name,
            uid: m.uid,
            time: formatTime(m.ts),
            msg: m.msg,
            namecolor: m.namecolor,
            msgcolor: m.msgcolor,
            highlight,
          })
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
      reconnectTimer = window.setTimeout(() => {
        connect()
        fetchRecord()
      }, delay)
    }
  }

  function fetchRecord(): void {
    fetch(`/room/@${roomId}/record?limit=${limit}`)
      .then((r) => r.json())
      .then((data: MsgItem[]) => {
        setStatus('connecting...', 'connecting')
        const reversed = [...data].reverse()
        for (const m of reversed) {
          appendMsg({
            type: 'msg',
            name: m.name,
            uid: m.uid,
            time: formatTime(m.ts),
            msg: m.msg,
            namecolor: m.namecolor,
            msgcolor: m.msgcolor,
          })
        }
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
      .then((data: MsgItem[]) => {
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
              time: formatTime(m.ts),
              msg: m.msg,
              namecolor: m.namecolor,
              msgcolor: m.msgcolor,
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

  msgList.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.nickname') as HTMLElement | null
    if (!target) return
    const uid = target.dataset.uid
    const name = target.dataset.name
    if (uid && name) showActionPopover(target, name, uid)
  })

  setStatus('get record...', 'connecting')
  fetchRecord()
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
