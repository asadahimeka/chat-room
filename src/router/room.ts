import { Elysia } from 'elysia'
import { db } from '../db'
import record2svg from '../utils/record2svg'
import { renderRoomPage } from '../views/room'
import { config } from '../config'

type RoomParams = { roomId: string }
type RoomQuery = {
  title?: string
  limit?: string
  offset?: string
  width?: string
  height?: string
  theme?: string
  fontSize?: string
}

export function coerceLimit(raw: string | undefined): number {
  return Math.floor(Math.abs(Math.min(raw as unknown as number, 100) || 20))
}

export const roomRouter = new Elysia()
  .get('/@:roomId', ({ params, query }) => {
    const p = params as unknown as RoomParams
    const q = query as RoomQuery
    return new Response(renderRoomPage({ roomId: p.roomId, title: q.title, emoji: config.emoji }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  })
  .get('/@:roomId/record', ({ params, query }) => {
    const p = params as unknown as RoomParams
    const q = query as RoomQuery
    return Response.json(
      db.getRecord(p.roomId, Number(q.limit ?? 100), Number(q.offset ?? 0)),
    )
  })
  .get('/@:roomId/svg', ({ params, query }) => {
    const p = params as unknown as RoomParams
    const q = query as RoomQuery
    const limit = coerceLimit(q.limit)
    const record = db.getRecord(p.roomId, limit)
    const svg = record2svg({
      roomId: p.roomId,
      record,
      width: Math.abs(Number(q.width ?? 500)),
      height: Math.abs(Number(q.height ?? 300)),
      limit,
      theme: q.theme ?? '',
      title: q.title ?? `${p.roomId}\n  @chat.getloli.com: ~`,
      fontSize: Math.abs(Number(q.fontSize ?? 12)),
    })
    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml',
        'cache-control': 'max-age=0, no-cache, no-store, must-revalidate',
      },
    })
  })
