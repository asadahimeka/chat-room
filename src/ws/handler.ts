import { Elysia } from 'elysia'
import { RoomState } from './room-state'
import { db } from '../db'
import {
  processInput,
  getCookie,
  sanitizeColor,
  sanitizeName,
  sanitizeUid,
  genGuestName,
} from '../utils/input'
import type { ClientEvent, ServerEvent } from './protocol'

interface ConnData {
  roomId: string
  sid: string
  uid: string
  name: string
}

interface WsLike {
  send(data: string): unknown
}

const META_KEYS = ['avatar', 'font', 'size', 'bold', 'italic', 'bubble'] as const

/**
 * Whitelist-sanitizes a client-supplied meta JSON string. Returns undefined
 * (silently dropped) on any violation; invalid field values are dropped
 * individually while valid siblings survive.
 */
export function sanitizeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  if (typeof raw !== 'string' || raw.length > 2048) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const obj = parsed as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const key of META_KEYS) {
    const value = obj[key]
    if (value === undefined) continue
    switch (key) {
      case 'font':
        if (value === 'default' || value === 'serif' || value === 'mono') cleaned[key] = value
        break
      case 'size':
        if (value === 'sm' || value === 'md' || value === 'lg') cleaned[key] = value
        break
      case 'bold':
      case 'italic':
        if (typeof value === 'boolean') cleaned[key] = value
        break
      case 'bubble':
        if (value === 'default' || value === 'flat' || value === 'card' || value === 'minimal') cleaned[key] = value
        break
      case 'avatar':
        if (typeof value === 'string' && (value.startsWith('https://') || value.startsWith('data:image'))) {
          cleaned[key] = value
        }
        break
    }
  }
  if (Object.keys(cleaned).length === 0) return undefined
  return JSON.stringify(cleaned)
}

export function registerWs<App extends Elysia>(app: App, roomState: RoomState): App {
  const rooms = new Map<string, Set<WsLike>>()

  const broadcast = (roomId: string, event: ServerEvent) => {
    const conns = rooms.get(roomId)
    if (!conns) return
    const payload = JSON.stringify(event)
    for (const ws of conns) ws.send(payload)
  }

  return app.ws('/ws', {
    open(ws) {
      const data = ws.data as ConnData & typeof ws.data
      const roomId = data.query.roomId ?? 'default'
      const sid = data.query.t ?? ''
      const cookieHeader = data.headers.cookie

      const name = processInput(sanitizeName(getCookie(cookieHeader, 'name')) || genGuestName())
      const uid = processInput(sanitizeUid(getCookie(cookieHeader, 'uid')) || sid)

      data.roomId = roomId
      data.sid = sid
      data.uid = uid
      data.name = name

      const { isNew } = roomState.join(roomId, sid, uid, name)

      const conns = rooms.get(roomId) ?? new Set<WsLike>()
      conns.add(ws)
      rooms.set(roomId, conns)

      if (isNew) {
        broadcast(roomId, { type: 'sys', data: `${name}(${uid}) join the chat.` })
      }
      broadcast(roomId, { type: 'init', data: { uid, name } })
      broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
    },
    message(ws, message) {
      const data = ws.data as ConnData & typeof ws.data
      const { roomId, sid, uid, name } = data
      const event = message as ClientEvent

      if (event.type === 'message') {
        const m = event.data
        const msgItem = {
          ...m,
          sid,
          room: roomId,
          ts: (Date.now() / 1000) | 0,
          name: processInput(m.name, true).substring(0, 32),
          msg: processInput(m.msg, true).substring(0, 1000),
          namecolor: sanitizeColor(m.namecolor, '#117743'),
          msgcolor: sanitizeColor(m.msgcolor, '#3d3d3d'),
          meta: sanitizeMeta(m.meta),
        }
        broadcast(roomId, { type: 'msg', data: msgItem })
        if (roomId !== 'demo') db.setRecord(msgItem)
      } else if (event.type === 'change-name') {
        const newName = processInput(sanitizeName(event.data))
        const oldName = name.substring(0, 32)
        if (oldName === newName) return
        roomState.rename(roomId, uid, newName)
        data.name = newName
        broadcast(roomId, { type: 'rename', data: { uid: processInput(uid), name: newName } })
        broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
        const msg = `${oldName}(${uid}) changed the name from ${oldName} to ${newName}.`
        broadcast(roomId, { type: 'sys', data: processInput(msg) })
      } else if (event.type === 'leave') {
        ws.close()
      }
    },
    close(ws) {
      const data = ws.data as ConnData & typeof ws.data
      const { roomId, sid, uid, name } = data

      const conns = rooms.get(roomId)
      if (conns) {
        conns.delete(ws)
        if (conns.size === 0) rooms.delete(roomId)
      }

      const user = roomState.leave(roomId, sid, uid)
      if (user) {
        broadcast(roomId, {
          type: 'sys',
          data: `${processInput(user.name)}(${processInput(user.uid)}) leave the chat.`,
        })
        broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
      }
      roomState.removeRoomIfEmpty(roomId)
    },
  }) as unknown as App
}
