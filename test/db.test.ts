import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { createDb, parseMsgMeta } from '../src/db/index.ts'
import type { MsgRowInput } from '../src/db/index.ts'
import { tmpDbPath } from './setup.ts'

const sample = (overrides: Partial<MsgRowInput> = {}): MsgRowInput => ({
  name: 'alice',
  room: 'demo',
  uid: '1234567',
  sid: 'abcdefg',
  ts: 1_700_000_000,
  namecolor: '#ff0000',
  msgcolor: '#00ff00',
  msg: 'hello',
  ...overrides,
})

describe('createDb — in-memory CRUD', () => {
  test('getRecord returns [] on an empty database', () => {
    const db = createDb(':memory:')
    expect(db.getRecord('demo')).toEqual([])
  })

  test('setRecord inserts rows with changes === 1 and sequential lastInsertRowid', () => {
    const db = createDb(':memory:')
    const first = db.setRecord(sample({ name: 'alice', msg: 'first' }))
    const second = db.setRecord(sample({ name: 'bob', msg: 'second' }))
    expect(first.changes).toBe(1)
    expect(second.changes).toBe(1)
    expect(first.lastInsertRowid).toBe(1)
    expect(second.lastInsertRowid).toBe(2)
  })

  test('getRecord returns rows ordered by time DESC', () => {
    const db = createDb(':memory:')
    db.setRecord(sample({ name: 'old', ts: 100 }))
    db.setRecord(sample({ name: 'new', ts: 300 }))
    db.setRecord(sample({ name: 'mid', ts: 200 }))
    const rows = db.getRecord('demo')
    expect(rows.map((r) => r.name)).toEqual(['new', 'mid', 'old'])
    expect(rows.map((r) => r.time)).toEqual([300, 200, 100])
  })

  test('limit/offset pagination works', () => {
    const db = createDb(':memory:')
    for (let i = 1; i <= 5; i++) {
      db.setRecord(sample({ name: `u${i}`, ts: i }))
    }
    expect(db.getRecord('demo', 2, 0).map((r) => r.name)).toEqual(['u5', 'u4'])
    expect(db.getRecord('demo', 2, 2).map((r) => r.name)).toEqual(['u3', 'u2'])
    expect(db.getRecord('demo', 2, 4).map((r) => r.name)).toEqual(['u1'])
  })

  test('rooms are isolated by the WHERE room filter', () => {
    const db = createDb(':memory:')
    db.setRecord(sample({ room: 'roomA', msg: 'a' }))
    db.setRecord(sample({ room: 'roomB', msg: 'b' }))
    expect(db.getRecord('roomA')).toHaveLength(1)
    expect(db.getRecord('roomB')).toHaveLength(1)
  })
})

describe('time column type', () => {
  test('INTEGER time is returned as a JS number (not bigint/string)', () => {
    const db = createDb(':memory:')
    const known = 1_700_123_456
    db.setRecord(sample({ ts: known }))
    const rows = db.getRecord('demo')
    expect(rows).toHaveLength(1)
    expect(typeof rows[0].time).toBe('number')
    expect(Number.isInteger(rows[0].time)).toBe(true)
    expect(rows[0].time).toBe(known)
  })
})

describe('meta column', () => {
  test('new DB schema includes meta (10th) and ip (11th) as TEXT', () => {
    // `:memory:` is per-connection and bun:sqlite has no shared-cache URI, so
    // inspect the schema of a fresh file DB through a second connection.
    const dbPath = tmpDbPath()
    createDb(dbPath)
    const raw = new Database(dbPath, { readonly: true })
    try {
      const cols = raw.query('PRAGMA table_info(tb_msg)').all() as Array<{
        name: string
        type: string
      }>
      expect(cols.map((c) => c.name)).toEqual([
        'id',
        'name',
        'room',
        'uid',
        'sid',
        'time',
        'namecolor',
        'msgcolor',
        'msg',
        'meta',
        'ip',
      ])
      expect(cols[9].type).toBe('TEXT')
      expect(cols[10].type).toBe('TEXT')
    } finally {
      raw.close()
    }
  })

  test('setRecord with meta persists it and getRecord reads it back', () => {
    const db = createDb(':memory:')
    db.setRecord(sample({ meta: '{"bold":true}' }))
    const rows = db.getRecord('demo')
    expect(rows).toHaveLength(1)
    expect(rows[0].meta).toBe('{"bold":true}')
  })

  test('setRecord without meta stores NULL', () => {
    const db = createDb(':memory:')
    db.setRecord(sample())
    const rows = db.getRecord('demo')
    expect(rows).toHaveLength(1)
    expect(rows[0].meta).toBeNull()
  })
})

describe('ip audit column', () => {
  test('setRecord with ip persists it; getRecord result omits ip', () => {
    const db = createDb(':memory:')
    db.setRecord(sample({ ip: '203.0.113.9' }))
    const rows = db.getRecord('demo')
    expect(rows).toHaveLength(1)
    // The public MsgRow shape has no `ip` field at all.
    expect((rows[0] as unknown as Record<string, unknown>).ip).toBeUndefined()
    // But the audit column IS stored — verify via raw SQL.
    const raw = new Database(':memory:')
    // Re-open the same in-memory db is not possible; instead assert through a
    // file db so we can read the ip column directly.
    const dbPath = tmpDbPath()
    const db2 = createDb(dbPath)
    db2.setRecord(sample({ ip: '203.0.113.9' }))
    const stored = new Database(dbPath, { readonly: true })
    try {
      const ip = (
        stored.query('SELECT ip FROM tb_msg WHERE room = ?').get('demo') as { ip: string | null }
      ).ip
      expect(ip).toBe('203.0.113.9')
    } finally {
      stored.close()
    }
  })

  test('setRecord without ip stores NULL in the audit column', () => {
    const dbPath = tmpDbPath()
    const db = createDb(dbPath)
    db.setRecord(sample())
    const stored = new Database(dbPath, { readonly: true })
    try {
      const ip = (
        stored.query('SELECT ip FROM tb_msg WHERE room = ?').get('demo') as { ip: string | null }
      ).ip
      expect(ip).toBeNull()
    } finally {
      stored.close()
    }
  })

  test('getRecord uses an explicit column list (no ip) even when present', () => {
    const dbPath = tmpDbPath()
    const db = createDb(dbPath)
    db.setRecord(sample({ ip: '1.2.3.4' }))
    const rows = db.getRecord('demo')
    // Every returned row must be free of the audit key.
    for (const r of rows) {
      expect(Object.keys(r as unknown as Record<string, unknown>)).not.toContain('ip')
    }
  })
})

describe('parseMsgMeta', () => {
  test('parses valid JSON objects', () => {
    expect(parseMsgMeta('{"a":1}')).toEqual({ a: 1 })
  })

  test('returns null for malformed JSON', () => {
    expect(parseMsgMeta('{bad json')).toBeNull()
  })

  test('returns null for null input', () => {
    expect(parseMsgMeta(null)).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseMsgMeta('')).toBeNull()
  })
})

describe('schema compatibility with the real msg.db', () => {
  // Read-only open of the real DB — this test must never write.
  const realDbPath = path.resolve(import.meta.dir, '../db/msg.db')

  test('PRAGMA table_info keeps column baseline ', () => {
    const db = new Database(realDbPath, { readonly: true })
    try {
      const cols = db
        .query('PRAGMA table_info(tb_msg)')
        .all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: unknown
        pk: number
      }>
      // The legacy 9 columns must be unchanged, in order.
      expect(cols.map((c) => c.name)).toEqual([
        'id',
        'name',
        'room',
        'uid',
        'sid',
        'time',
        'namecolor',
        'msgcolor',
        'msg',
        'meta',
        'ip'
      ])
      expect(cols.map((c) => c.type)).toEqual([
        'INTEGER',
        'VARCHAR (32)',
        'VARCHAR (32)',
        'VARCHAR (7)',
        'VARCHAR (7)',
        'INT (10)',
        'VARCHAR (7)',
        'VARCHAR (7)',
        'VARCHAR (1000)',
        'TEXT',
        'TEXT',
      ])
      // The sanctioned meta migration may or may not have run on this DB.
      expect(cols.length).toEqual(11)
    } finally {
      db.close()
    }
  })

  test('seed data intact — demo room keeps its 14 baseline rows', () => {
    const db = new Database(realDbPath, { readonly: true })
    try {
      // Room-scoped on purpose: total COUNT grows with legitimate chat usage,
      // but the 14 seed rows must never change (zero-migration guarantee).
      const row = db
        .query("SELECT COUNT(*) AS count FROM tb_msg WHERE room = 'demo'")
        .get() as { count: number }
      expect(row.count).toBe(14)
    } finally {
      db.close()
    }
  })
})
