import { Elysia } from 'elysia'
import { RoomState } from './room-state'
import { db } from '../db'
import type { MsgRowInput } from '../db'
import { config } from '../config'
import { parseClientIp } from '../utils/ip'
import {
  processInput,
  getCookie,
  sanitizeColor,
  sanitizeName,
  sanitizeUid,
  genGuestName,
} from '../utils/input'
import { sanitizeClientId } from './protocol'
import type { ClientEvent, ServerEvent } from './protocol'

interface ConnData {
  roomId: string
  sid: string
  uid: string
  name: string
  /** Audit-only client IP; never sent to clients. */
  ip: string
}

interface WsLike {
  send(data: string): unknown
}

const META_KEYS = ['avatar', 'font', 'size', 'bold', 'italic', 'bubble', 'reply'] as const

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
      case 'reply': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) break
        const r = value as Record<string, unknown>
        if (typeof r.ruid !== 'string' || typeof r.rname !== 'string' || typeof r.rmsg !== 'string') break
        const ruid = r.ruid.trim().substring(0, 7)
        const rname = processInput(r.rname.trim().substring(0, 32), true)
        const rmsg = processInput(r.rmsg.trim().substring(0, 100), true)
        if (!ruid || !rname.trim() || !rmsg.trim()) break
        cleaned[key] = { ruid, rname, rmsg }
        break
      }
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

      // Audit-only IP: ws.remoteAddress is the transport peer (string); behind
      // Cloudflare it would be the edge IP, so cf-connecting-ip is consulted
      // only when explicitly trusted. Never exposed to clients.
      const headers = new Headers(data.headers as Record<string, string>)
      const ip = parseClientIp(headers, {
        trustCloudflare: config.trustCloudflare,
        remoteAddress: (ws as { remoteAddress?: string }).remoteAddress ?? null,
      })

      const name = processInput(sanitizeName(getCookie(cookieHeader, 'name')) || genGuestName())
      const uid = processInput(sanitizeUid(getCookie(cookieHeader, 'uid')) || sid)

      data.roomId = roomId
      data.sid = sid
      data.uid = uid
      data.name = name
      data.ip = ip

      const { isNew } = roomState.join(roomId, sid, uid, name)

      const conns = rooms.get(roomId) ?? new Set<WsLike>()
      conns.add(ws)
      rooms.set(roomId, conns)

      if (isNew) {
        broadcast(roomId, { type: 'sys', data: `${name}(${uid}) 加入了聊天` })
      }
      broadcast(roomId, { type: 'init', data: { uid, name } })
      broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
    },
    message(ws, message) {
      const data = ws.data as ConnData & typeof ws.data
      const { roomId, sid, uid, name, ip } = data
      const event = message as ClientEvent

      if (event.type === 'message') {
        const m = event.data
        const clientId = sanitizeClientId((m as { clientId?: unknown }).clientId)
        const msgItem: MsgRowInput = {
          ...m,
          sid,
          room: roomId,
          ts: (Date.now() / 1000) | 0,
          name: processInput(m.name, true).substring(0, 32),
          msg: processInput(m.msg, true).substring(0, 1000),
          namecolor: sanitizeColor(m.namecolor, '#117743'),
          msgcolor: sanitizeColor(m.msgcolor, '#3d3d3d'),
          meta: sanitizeMeta(m.meta),
          ip, // audit only — stripped before broadcast below
        }
        // Broadcast a copy WITHOUT the audit ip or raw clientId.
        const { ip: _auditIp, clientId: _rawCid, ...rest } = msgItem as MsgRowInput & { clientId?: string }
        const broadcastItem = clientId ? { ...rest, clientId } : rest
        broadcast(roomId, { type: 'msg', data: broadcastItem })
        // Persist WITHOUT clientId (not a DB column); ip IS kept for audit.
        const { clientId: _drop, ...record } = msgItem as MsgRowInput & { clientId?: string }
        if (roomId !== 'demo') db.setRecord(record)
      } else if (event.type === 'change-name') {
        const newName = processInput(sanitizeName(event.data))
        const oldName = name.substring(0, 32)
        if (oldName === newName) return
        roomState.rename(roomId, uid, newName)
        data.name = newName
        broadcast(roomId, { type: 'rename', data: { uid: processInput(uid), name: newName } })
        broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
        const msg = `${oldName}(${uid}) 将昵称从「${oldName}」改为「${newName}」`
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
          data: `${processInput(user.name)}(${processInput(user.uid)}) 离开了聊天`,
        })
        broadcast(roomId, { type: 'online', data: roomState.list(roomId) })
      }
      roomState.removeRoomIfEmpty(roomId)
    },
  }) as unknown as App
}
