import { Database } from 'bun:sqlite'
import { loadConfig } from '../config'

export interface MsgRow {
  id: number
  name: string
  room: string
  uid: string
  sid: string
  time: number
  namecolor: string
  msgcolor: string
  msg: string
}

export interface MsgItem {
  name: string
  room: string
  uid: string
  sid: string
  ts: number
  namecolor: string
  msgcolor: string
  msg: string
}

export interface Db {
  getRecord(roomId: string, limit?: number, offset?: number): MsgRow[]
  setRecord(msgItem: MsgItem): { lastInsertRowid: number; changes: number }
}

// Character-identical to the legacy db/sqlite.js DDL — zero migration.
const DDL = `CREATE TABLE IF NOT EXISTS tb_msg (
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
);`

export function createDb(dbPath: string): Db {
  const db = new Database(dbPath, { readwrite: true, create: true })

  // WAL is a performance optimization only; it never changes the schema.
  // On ':memory:' databases SQLite reports journal mode 'memory' and WAL is a
  // no-op — it must not throw, so guard it.
  try {
    db.run('PRAGMA journal_mode = WAL')
  } catch {
    // ':memory:' (and readonly) databases cannot switch to WAL; ignore.
  }

  db.run(DDL)

  // Positional `?` params are equivalent to the legacy named `$name` params:
  // SQLite binds them in declaration order, so the two styles are
  // interchangeable for the same column list.
  const getRecordStmt = db.query(
    'SELECT * FROM tb_msg WHERE `room` = ? ORDER BY `time` DESC LIMIT ? OFFSET ?',
  )
  const setRecordStmt = db.query(
    'INSERT INTO tb_msg(name, room, uid, sid, time, namecolor, msgcolor, msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )

  return {
    getRecord(roomId, limit = 100, offset = 0) {
      return getRecordStmt.all(roomId, limit, offset) as MsgRow[]
    },
    setRecord(msgItem) {
      const { name, room, uid, sid, ts: time, namecolor, msgcolor, msg } = msgItem
      const result = setRecordStmt.run(name, room, uid, sid, time, namecolor, msgcolor, msg)
      // safeIntegers defaults to false, so these are always JS numbers.
      return {
        lastInsertRowid: result.lastInsertRowid as number,
        changes: result.changes as number,
      }
    },
  }
}

// Default instance for the app. Created lazily on first access: an eager
// `createDb(loadConfig(process.env).dbPath)` at module top level would run
// `PRAGMA journal_mode = WAL` against the real msg.db the moment a test
// imports this module for `createDb`, altering the file's bytes and breaking
// the byte-for-byte preservation requirement.
let defaultDb: Db | null = null
export const db: Db = new Proxy({} as Db, {
  get(_target, prop: string | symbol) {
    if (!defaultDb) defaultDb = createDb(loadConfig(process.env).dbPath)
    if (prop === 'getRecord' || prop === 'setRecord') return defaultDb[prop]
    return undefined
  },
  has(_target, prop: string | symbol) {
    return prop === 'getRecord' || prop === 'setRecord'
  },
  ownKeys() {
    return ['getRecord', 'setRecord']
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true }
  },
})
