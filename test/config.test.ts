import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  test('uses default port 3000 and dbPath ./msg.db when env is empty', () => {
    const config = loadConfig({})
    expect(config.port).toBe(3000)
    expect(config.dbPath).toBe('./db/msg.db')
  })

  test('overrides port and dbPath from env', () => {
    const config = loadConfig({ PORT: '8080', DB_PATH: ':memory:' })
    expect(config.port).toBe(8080)
    expect(config.dbPath).toBe(':memory:')
  })

  test('falls back to 3000 when PORT is undefined', () => {
    expect(loadConfig({ DB_PATH: ':memory:' }).port).toBe(3000)
  })

  test('falls back to 3000 when PORT is an empty string', () => {
    expect(loadConfig({ PORT: '' }).port).toBe(3000)
  })

  test('falls back to 3000 when PORT is non-numeric', () => {
    expect(loadConfig({ PORT: 'abc' }).port).toBe(3000)
  })

  test('falls back to 3000 when PORT is zero', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(3000)
  })

  test('falls back to 3000 when PORT is negative', () => {
    expect(loadConfig({ PORT: '-1' }).port).toBe(3000)
  })

  test('falls back to 3000 when PORT is a non-integer', () => {
    expect(loadConfig({ PORT: '3000.5' }).port).toBe(3000)
  })
})
