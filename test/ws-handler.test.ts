import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { Database } from 'bun:sqlite'
import { RoomState } from '../src/ws/room-state'
import { registerWs, sanitizeMeta } from '../src/ws/handler'
import { db, _testDefaultDbPath } from '../src/db'
import { randomRoomName, tmpDbPath } from './setup'

// Point the lazy `db` proxy at a throwaway DB BEFORE any message triggers
// setRecord. The proxy only creates the underlying Database on first access,
// so this assignment (module top-level) is guaranteed to be in effect by the
// time a test sends a chat message. We also force-lock the proxy here (like
// integration.test.ts does) so writes land in THIS file's DB, which we reopen
// below to assert the audit ip was persisted.
const WS_DB_PATH = tmpDbPath()
process.env.DB_PATH = WS_DB_PATH
db.getRecord('__init__')

interface Collected {
  type: string
  data: unknown
}

/** Wraps a client WebSocket and buffers every parsed message it receives. */
function connect(url: string, headers: Record<string, string>): Promise<{
  ws: WebSocket
  messages: Collected[]
  waitFor: (type: string, count?: number) => Promise<Collected[]>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as any)
    const messages: Collected[] = []
    const waiters: Array<{ type: string; count: number; resolve: (m: Collected[]) => void }> = []

    ws.onmessage = (ev) => {
      const parsed = JSON.parse(String(ev.data)) as Collected
      messages.push(parsed)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]
        if (parsed.type === w.type && messages.filter((m) => m.type === w.type).length >= w.count) {
          waiters.splice(i, 1)
          w.resolve(messages.filter((m) => m.type === w.type))
        }
      }
    }
    ws.onerror = (ev) => reject(new Error(`ws error: ${String(ev)}`))
    ws.onopen = () =>
      resolve({
        ws,
        messages,
        waitFor: (type, count = 1) =>
          new Promise((res) => {
            const existing = messages.filter((m) => m.type === type)
            if (existing.length >= count) return res(existing)
            waiters.push({ type, count, resolve: res })
          }),
      })
  })
}

describe('sanitizeMeta', () => {
  test('valid meta passes through cleaned', () => {
    const raw = '{"bold":true,"font":"serif","size":"lg","bubble":"card","italic":false,"avatar":"https://example.com/a.png"}'
    expect(sanitizeMeta(raw)).toBe(
      '{"avatar":"https://example.com/a.png","font":"serif","size":"lg","bold":true,"italic":false,"bubble":"card"}',
    )
  })

  test('rejects meta longer than 2048 chars', () => {
    expect(sanitizeMeta(`{"msg":"${'a'.repeat(2100)}"}`)).toBeUndefined()
  })

  test('rejects bad JSON', () => {
    expect(sanitizeMeta('{not json')).toBeUndefined()
  })

  test('rejects array and primitive values', () => {
    expect(sanitizeMeta('[1,2,3]')).toBeUndefined()
    expect(sanitizeMeta('"hello"')).toBeUndefined()
    expect(sanitizeMeta('42')).toBeUndefined()
    expect(sanitizeMeta('null')).toBeUndefined()
  })

  test('strips unknown fields', () => {
    expect(sanitizeMeta('{"bold":true,"xss":"a"}')).toBe('{"bold":true}')
  })

  test('drops only the invalid field, keeps valid siblings', () => {
    expect(sanitizeMeta('{"font":"Comic Sans","bold":true}')).toBe('{"bold":true}')
  })

  test('rejects javascript: avatar', () => {
    expect(sanitizeMeta('{"avatar":"javascript:alert(1)"}')).toBeUndefined()
  })

  test('returns undefined when nothing survives or input is falsy', () => {
    expect(sanitizeMeta('{"xss":"a"}')).toBeUndefined()
    expect(sanitizeMeta(undefined)).toBeUndefined()
    expect(sanitizeMeta('')).toBeUndefined()
  })

  test('valid reply passes through sanitized', () => {
    const raw = '{"bold":true,"reply":{"ruid":"abc1234","rname":"Alice","rmsg":"hi there"}}'
    expect(sanitizeMeta(raw)).toBe('{"bold":true,"reply":{"ruid":"abc1234","rname":"Alice","rmsg":"hi there"}}')
  })

  test('reply fields are truncated to 7/32/100 chars', () => {
    const raw = JSON.stringify({
      reply: { ruid: '1234567890', rname: 'N'.repeat(40), rmsg: 'M'.repeat(150) },
    })
    const out = sanitizeMeta(raw)
    expect(out).toBeDefined()
    const parsed = JSON.parse(out!) as { reply: { ruid: string; rname: string; rmsg: string } }
    expect(parsed.reply.ruid).toBe('1234567')
    expect(parsed.reply.rname).toBe('N'.repeat(32))
    expect(parsed.reply.rmsg).toBe('M'.repeat(100))
  })

  test('reply with script payload never survives as raw markup', () => {
    const raw = JSON.stringify({ reply: { ruid: 'u1', rname: 'A', rmsg: '<script>alert(1)</script>' } })
    const out = sanitizeMeta(raw)
    expect(out).toBeDefined()
    expect(out!.includes('<script')).toBe(false)
  })

  test('reply dropped entirely when any field is missing or wrong type', () => {
    expect(sanitizeMeta('{"bold":true,"reply":{"ruid":"u1","rname":"A"}}')).toBe('{"bold":true}')
    expect(sanitizeMeta('{"bold":true,"reply":{"ruid":"u1","rname":"A","rmsg":42}}')).toBe('{"bold":true}')
    expect(sanitizeMeta('{"bold":true,"reply":"nope"}')).toBe('{"bold":true}')
    expect(sanitizeMeta('{"bold":true,"reply":{"ruid":"   ","rname":"A","rmsg":"q"}}')).toBe('{"bold":true}')
  })
})

describe('ws handler — connection lifecycle + broadcast pipeline', () => {
  test('both clients receive init + online on connect', async () => {
    const room = randomRoomName('t1')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })

    const aInit = await a.waitFor('init')
    expect(aInit[0].data).toEqual({ uid: 'u1', name: 'Alice' })
    const aOnline = await a.waitFor('online')
    expect(aOnline[0].data).toEqual([{ uid: 'u1', name: 'Alice' }])
    const aSys = await a.waitFor('sys')
    expect(aSys[0].data).toBe('Alice(u1) join the chat.')

    const bInit = await b.waitFor('init')
    expect(bInit[0].data).toEqual({ uid: 'u2', name: 'Bob' })
    const bOnline = await b.waitFor('online')
    expect(bOnline[0].data).toEqual([
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
    ])
    const bSys = await b.waitFor('sys')
    expect(bSys[0].data).toBe('Bob(u2) join the chat.')

    const aOnline2 = await a.waitFor('online', 2)
    expect(aOnline2[1].data).toEqual([
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
    ])

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('message is broadcast with full MsgItem and persisted to DB', async () => {
    const room = randomRoomName('t2')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'hello world',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
        },
      }),
    )

    const msg = await b.waitFor('msg')
    const item = msg[0].data as Record<string, unknown>
    expect(item.name).toBe('Alice')
    expect(item.room).toBe(room)
    expect(item.uid).toBe('u1')
    expect(item.sid).toBe('s1')
    expect(typeof item.ts).toBe('number')
    expect(Number.isInteger(item.ts)).toBe(true)
    expect(item.namecolor).toBe('#ff0000')
    expect(item.msgcolor).toBe('#00ff00')
    expect(item.msg).toBe('hello world')
    // Hard privacy boundary: the audit ip must never reach clients.
    expect(item).not.toHaveProperty('ip')

    const rows = db.getRecord(room)
    expect(rows).toHaveLength(1)
    expect(rows[0].msg).toBe('hello world')

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('broadcast payload excludes ip; DB row stores server-resolved audit ip', async () => {
    const room = randomRoomName('tip')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    // Client tries to smuggle its own `ip` field — must be ignored.
    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'audit me',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
          ip: 'EVIL-CLIENT-IP',
        },
      }),
    )

    const msg = await b.waitFor('msg')
    const item = msg[0].data as Record<string, unknown>
    expect(item).not.toHaveProperty('ip')
    expect(item.msg).toBe('audit me')

    // The persisted audit ip is the server-resolved peer, never the client value.
    // Reopen the exact file the app's `db` proxy wrote to (path may differ from
    // process.env.DB_PATH due to cross-file proxy lock order).
    const dbPath = _testDefaultDbPath()
    expect(dbPath).not.toBeNull()
    const stored = new Database(dbPath!, { readonly: true })
    try {
      const ip = (
        stored.query('SELECT ip FROM tb_msg WHERE room = ?').get(room) as { ip: string | null }
      ).ip
      expect(ip).not.toBe('EVIL-CLIENT-IP')
      expect(typeof ip).toBe('string')
      expect((ip as string).length).toBeGreaterThan(0)
    } finally {
      stored.close()
    }

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('message meta is sanitized before broadcast and persisted to DB', async () => {
    const room = randomRoomName('t6')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'styled',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
          meta: '{"bold":true,"evil":"x"}',
        },
      }),
    )

    const msg = await b.waitFor('msg')
    const item = msg[0].data as Record<string, unknown>
    expect(item.meta).toBe('{"bold":true}')

    const rows = db.getRecord(room)
    expect(rows).toHaveLength(1)
    expect(rows[0].meta).toBe('{"bold":true}')

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('demo room broadcasts but does NOT persist to DB', async () => {
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=demo&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    await a.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'demo msg',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
        },
      }),
    )

    await a.waitFor('msg')
    expect(db.getRecord('demo')).toHaveLength(0)

    a.ws.close()
    app.stop()
  })

  test('change-name broadcasts rename + online + sys to both clients', async () => {
    const room = randomRoomName('t4')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(JSON.stringify({ type: 'change-name', data: 'Alice2' }))

    const rename = await b.waitFor('rename')
    expect(rename[0].data).toEqual({ uid: 'u1', name: 'Alice2' })

    const online = await b.waitFor('online', 2)
    expect(online[1].data).toEqual([
      { uid: 'u1', name: 'Alice2' },
      { uid: 'u2', name: 'Bob' },
    ])

    const sys = await b.waitFor('sys', 2)
    expect(sys[1].data).toBe('Alice(u1) changed the name from Alice to Alice2.')

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('disconnect broadcasts leave sys + updated online to remaining client', async () => {
    const room = randomRoomName('t5')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.close()

    const sys = await b.waitFor('sys', 2)
    expect(sys[1].data).toBe('Alice(u1) leave the chat.')

    const online = await b.waitFor('online', 2)
    expect(online[1].data).toEqual([{ uid: 'u2', name: 'Bob' }])

    b.ws.close()
    app.stop()
  })

  test('clientId is broadcast to all clients but NOT persisted to DB', async () => {
    const room = randomRoomName('tcid')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'with id',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
          clientId: 'c1',
        },
      }),
    )

    // Both clients should receive the message with clientId
    const msgA = await a.waitFor('msg')
    expect((msgA[0].data as Record<string, unknown>).clientId).toBe('c1')
    const msgB = await b.waitFor('msg')
    expect((msgB[0].data as Record<string, unknown>).clientId).toBe('c1')

    // DB row must NOT contain clientId
    const rows = db.getRecord(room)
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('clientId')

    a.ws.close()
    b.ws.close()
    app.stop()
  })

  test('invalid clientId is NOT broadcast to clients', async () => {
    const room = randomRoomName('tcid-bad')
    const app = registerWs(new Elysia(), new RoomState()).listen(0)
    const baseUrl = `ws://localhost:${app.server!.port}/ws`

    const a = await connect(`${baseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${baseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: {
          uid: 'u1',
          name: 'Alice',
          msg: 'bad id',
          namecolor: '#ff0000',
          msgcolor: '#00ff00',
          clientId: '<script>alert(1)</script>',
        },
      }),
    )

    const msgB = await b.waitFor('msg')
    const item = msgB[0].data as Record<string, unknown>
    expect(item).not.toHaveProperty('clientId')
    expect(item.msg).toBe('bad id')

    a.ws.close()
    b.ws.close()
    app.stop()
  })
})
