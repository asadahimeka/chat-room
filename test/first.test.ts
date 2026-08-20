import { describe, expect, it } from 'bun:test'
import { randomRoomName, tmpDbPath } from './setup.ts'

describe('test/setup.ts shared toolbox', () => {
  it('randomRoomName produces unique, prefixed names for test isolation', () => {
    const a = randomRoomName('stress')
    const b = randomRoomName('stress')
    expect(a).toMatch(/^stress-/)
    expect(a).not.toBe(b)
  })

  it('tmpDbPath returns an absolute temp-file path ending in .db', () => {
    const p = tmpDbPath()
    expect(p).toMatch(/^\/tmp\/chatroom-test-[\w]+\.db$/)
  })
})
