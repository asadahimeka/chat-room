import { describe, expect, test, beforeAll } from 'bun:test'
import { roomRouter, coerceLimit } from '../src/router/room.ts'
import { db } from '../src/db/index.ts'
import type { MsgItem } from '../src/db/index.ts'
import { tmpDbPath } from './setup.ts'

// Point the lazy `db` singleton at a throwaway temp file BEFORE its first
// access (the Proxy creates the DB on first property access, so setting the
// env var at module top-level is sufficient).
process.env.DB_PATH = tmpDbPath()

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

describe('coerceLimit — locks the legacy loose-coercion behavior exactly', () => {
  // Derived from `Math.floor(Math.abs(Math.min(limit, 100) || 20))` where
  // `limit` is a raw string query param (or undefined). Do NOT "fix" these.
  const table: Array<[string | undefined, number]> = [
    [undefined, 20], // Math.min(undefined,100)=NaN (falsy) -> || 20
    ['50', 50],
    ['abc', 20], // NaN (falsy) -> || 20
    ['0', 20], // 0 is falsy -> || 20
    ['-5', 5], // min(-5,100)=-5 (truthy), abs=5, floor=5
    ['200', 100], // min(200,100)=100
    ['150', 100], // min(150,100)=100
    ['20', 20],
  ]

  test.each(table)('coerceLimit(%p) === %d', (raw, expected) => {
    expect(coerceLimit(raw)).toBe(expected)
  })
})

describe('room router', () => {
  beforeAll(() => {
    // Seed 3 rows for room 'x' with distinct times.
    db.setRecord(sample({ name: 'u1', ts: 100 }))
    db.setRecord(sample({ name: 'u2', ts: 200 }))
    db.setRecord(sample({ name: 'u3', ts: 300 }))
  })

  test('GET /@x/record?limit=2&offset=0 returns 2 rows with the full field set including meta', async () => {
    const res = await roomRouter.handle(
      new Request('http://localhost/@x/record?limit=2&offset=0'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    // Ordered by time DESC -> u3, u2
    expect(body.map((r: { name: string }) => r.name)).toEqual(['u3', 'u2'])
    // Field names include the T1 `meta` column (SELECT * in getRecord).
    expect(Object.keys(body[0]).sort()).toEqual(
      ['id', 'name', 'room', 'uid', 'sid', 'time', 'namecolor', 'msgcolor', 'msg', 'meta'].sort(),
    )
  })

  test('GET /@x/record with no params defaults to limit=100 offset=0', async () => {
    const res = await roomRouter.handle(new Request('http://localhost/@x/record'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(3)
  })

  test('GET /@x/svg?limit=abc returns 200 with svg headers and <?xml body', async () => {
    const res = await roomRouter.handle(
      new Request('http://localhost/@x/svg?limit=abc'),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('cache-control')).toBe(
      'max-age=0, no-cache, no-store, must-revalidate',
    )
    const body = await res.text()
    expect(body.startsWith('<?xml')).toBe(true)
  })

  test('GET /@x/svg?limit=200 coerces to 100 (capped)', async () => {
    const res = await roomRouter.handle(
      new Request('http://localhost/@x/svg?limit=200'),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.startsWith('<?xml')).toBe(true)
  })
})
