/**
 * Full-stack integration smoke suite — HTTP + WebSocket end-to-end.
 *
 * DATA POLICY:
 * - ALL scenarios run against a throwaway temp DB: `process.env.DB_PATH` is
 *   set at module top, BEFORE the lazy `db` proxy is first touched, so the
 *   real msg.db is NEVER opened.
 * - Every scenario uses a unique room name (`randomRoomName`) so no scenario
 *   pollutes another (records are keyed by room).
 * - HTTP contract tests use `app.handle(new Request(...))` (no live server).
 * - WS round-trip tests use `app.listen(0)` + `app.server.port`.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { app } from '../src/index.ts'
import { db } from '../src/db/index.ts'
import type { MsgItem } from '../src/db/index.ts'
import { randomRoomName, tmpDbPath } from './setup.ts'

// Point the lazy `db` proxy at a throwaway DB BEFORE the app is imported.
// The proxy only creates the underlying Database on first access, so this
// assignment (module top-level) is guaranteed to be in effect by the time any
// route/WS handler touches the DB.
process.env.DB_PATH = tmpDbPath()

// Force the lazy `db` proxy to initialize now, against this exact path, so the
// app's writes land in the same DB we count below.
db.getRecord('__init__')

let wsBaseUrl: string

beforeAll(() => {
  app.listen(0)
  wsBaseUrl = `ws://localhost:${app.server!.port}/ws`
})

afterAll(() => {
  app.stop()
})

const sample = (overrides: Partial<MsgItem> = {}): MsgItem => ({
  name: 'alice',
  room: 'x',
  uid: '1234567',
  sid: 'abcdefg',
  ts: 1_700_000_000,
  namecolor: '#ff0000',
  msgcolor: '#00ff00',
  msg: 'hello',
  ...overrides,
})

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

describe('integration — HTTP contract (temp DB, app.handle)', () => {
  test('GET / → 302 redirect to /room/@demo', async () => {
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/room/@demo')
  })

  test('GET /heart-beat → 200 alive', async () => {
    const res = await app.handle(new Request('http://localhost/heart-beat'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('alive')
  })

  test('GET /room/@demo → 200 text/html containing room-data', async () => {
    const res = await app.handle(new Request('http://localhost/room/@demo'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('room-data')
  })

  test('GET /room/@<room>/record?limit=2&offset=0 → 200 JSON array (seeded)', async () => {
    const room = randomRoomName('rec')
    db.setRecord(sample({ room, name: 'u1', ts: 100 }))
    db.setRecord(sample({ room, name: 'u2', ts: 200 }))
    db.setRecord(sample({ room, name: 'u3', ts: 300 }))

    const res = await app.handle(
      new Request(`http://localhost/room/@${room}/record?limit=2&offset=0`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    // Ordered by time DESC → u3, u2
    expect(body.map((r: { name: string }) => r.name)).toEqual(['u3', 'u2'])
  })

  test('GET /room/@<room>/svg?limit=abc → 200 image/svg+xml starting with <?xml', async () => {
    const room = randomRoomName('svg')
    const res = await app.handle(
      new Request(`http://localhost/room/@${room}/svg?limit=abc`),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    const body = await res.text()
    expect(body.startsWith('<?xml')).toBe(true)
  })

  test('GET /filter?q=<real banned word> → body contains ***', async () => {
    // 'bitch' is a real entry in src/utils/banword.json.
    const res = await app.handle(new Request('http://localhost/filter?q=you%20bitch'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('***')
  })

  test('GET /nope → 404', async () => {
    const res = await app.handle(new Request('http://localhost/nope'))
    expect(res.status).toBe(404)
  })
})

describe('integration — WS round-trip (temp DB, live server)', () => {
  test('both clients receive init + online on connect', async () => {
    const room = randomRoomName('ws1')
    const a = await connect(`${wsBaseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${wsBaseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })

    const aInit = await a.waitFor('init')
    expect(aInit[0].data).toEqual({ uid: 'u1', name: 'Alice' })
    const aOnline = await a.waitFor('online')
    expect(aOnline[0].data).toEqual([{ uid: 'u1', name: 'Alice' }])

    const bInit = await b.waitFor('init')
    expect(bInit[0].data).toEqual({ uid: 'u2', name: 'Bob' })
    const bOnline = await b.waitFor('online')
    expect(bOnline[0].data).toEqual([
      { uid: 'u1', name: 'Alice' },
      { uid: 'u2', name: 'Bob' },
    ])

    a.ws.close()
    b.ws.close()
  })

  test('A sends message → B receives full MsgItem and DB count increments', async () => {
    const room = randomRoomName('ws2')

    const a = await connect(`${wsBaseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${wsBaseUrl}?roomId=${room}&t=s2`, {
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
          msg: 'hello integration',
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
    expect(item.msg).toBe('hello integration')

    // The message was persisted to this room (room-scoped, not a global count).
    const rows = db.getRecord(room)
    expect(rows).toHaveLength(1)
    expect(rows[0].msg).toBe('hello integration')

    a.ws.close()
    b.ws.close()
  })

  test('demo room broadcasts but does NOT persist to DB', async () => {
    const before = db.getRecord('demo').length
    const a = await connect(`${wsBaseUrl}?roomId=demo&t=s1`, {
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
    expect(db.getRecord('demo').length).toBe(before)

    a.ws.close()
  })

  test('change-name → both receive rename + online + sys', async () => {
    const room = randomRoomName('ws4')
    const a = await connect(`${wsBaseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${wsBaseUrl}?roomId=${room}&t=s2`, {
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
  })

  test('disconnect → remaining client receives leave sys + updated online', async () => {
    const room = randomRoomName('ws5')
    const a = await connect(`${wsBaseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${wsBaseUrl}?roomId=${room}&t=s2`, {
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
  })
})

describe('integration — special room journey-ad.github (temp DB, app.handle)', () => {
  test('SVG output replaces 变态 with 好人', async () => {
    const room = 'journey-ad.github'
    // Seed raw (setRecord does not filter); record2svg performs the swap.
    db.setRecord(sample({ room, name: 'alice', msg: '变态测试' }))

    const res = await app.handle(new Request(`http://localhost/room/@${room}/svg`))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('好人')
    expect(body).not.toContain('变态')
  })
})

describe('integration — data integrity (temp DB)', () => {
  test('DB count delta equals messages written during test', async () => {
    const room = randomRoomName('di')
    const before = db.getRecord(room).length

    const a = await connect(`${wsBaseUrl}?roomId=${room}&t=s1`, {
      cookie: 'name=Alice; uid=u1',
    })
    const b = await connect(`${wsBaseUrl}?roomId=${room}&t=s2`, {
      cookie: 'name=Bob; uid=u2',
    })
    await a.waitFor('online', 2)
    await b.waitFor('online')

    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: { uid: 'u1', name: 'Alice', msg: 'm1', namecolor: '#ff0000', msgcolor: '#00ff00' },
      }),
    )
    a.ws.send(
      JSON.stringify({
        type: 'message',
        data: { uid: 'u1', name: 'Alice', msg: 'm2', namecolor: '#ff0000', msgcolor: '#00ff00' },
      }),
    )

    await b.waitFor('msg', 2)

    expect(db.getRecord(room).length).toBe(before + 2)

    a.ws.close()
    b.ws.close()
  })
})