import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { createDb, parseMsgMeta } from '../src/db/index.ts'
import type { MsgItem } from '../src/db/index.ts'
import { tmpDbPath } from './setup.ts'

const sample = (overrides: Partial<MsgItem> = {}): MsgItem => ({
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
  test('new DB schema includes meta as the 10th column (TEXT)', () => {
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
      ])
      expect(cols[9].type).toBe('TEXT')
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

describe('legacy DB migration', () => {
  test('ALTER adds meta to a 9-column legacy DB without error', () => {
    const dbPath = tmpDbPath()
    // Recreate the original 9-column schema exactly as the legacy DDL had it.
    const legacy = new Database(dbPath)
    legacy.run(`CREATE TABLE tb_msg (
      id        INTEGER        PRIMARY KEY AUTOINCREMENT
                               NOT NULL
                               UNIQUE,
      name      VARCHAR (32)   NOT NULL,
      room      VARCHAR (32)   NOT NULL,
      uid       VARCHAR (7)    NOT NULL,
      sid       VARCHAR (7)    NOT NULL,
      time      INT (10)       NOT NULL,
      namecolor VARCHAR (7)    NOT NULL,
      msgcolor  VARCHAR (7)    NOT NULL,
      msg       VARCHAR (1000) NOT NULL
    )`)
    legacy.close()

    // createDb must not throw on the legacy schema.
    const db = createDb(dbPath)
    expect(db.getRecord('demo')).toEqual([])

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
      ])
      expect(cols[9].type).toBe('TEXT')
    } finally {
      raw.close()
    }
  })
})

describe('schema compatibility with the real msg.db', () => {
  // Read-only open of the real DB — this test must never write.
  const realDbPath = path.resolve(import.meta.dir, '../db/msg.db')

  test('PRAGMA table_info matches the legacy baseline exactly', () => {
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
      ])
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
