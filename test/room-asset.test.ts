import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickLatestHashed } from '../src/views/room'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'room-asset-'))
}

describe('pickLatestHashed', () => {
  test('returns the file with the newest mtime', () => {
    const dir = tmpDir()
    try {
      const older = join(dir, 'room.client-aaaa1111.js')
      const newer = join(dir, 'room.client-bbbb2222.js')
      writeFileSync(older, 'old')
      writeFileSync(newer, 'new')
      const tOld = new Date(Date.now() - 30_000)
      const tNew = new Date(Date.now())
      utimesSync(older, tOld, tOld)
      utimesSync(newer, tNew, tNew)
      const got = pickLatestHashed(dir, /^room\.client-[0-9a-f]{8}\.js$/)
      expect(got).toBe('room.client-bbbb2222.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when no file matches the pattern', () => {
    const dir = tmpDir()
    try {
      writeFileSync(join(dir, 'unrelated.txt'), 'x')
      expect(pickLatestHashed(dir, /^room\.client-[0-9a-f]{8}\.js$/)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a truly empty directory', () => {
    const dir = tmpDir()
    try {
      expect(pickLatestHashed(dir, /^room\.client-[0-9a-f]{8}\.js$/)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a non-existent directory', () => {
    expect(
      pickLatestHashed(join(tmpdir(), 'room-asset-does-not-exist-xyz'), /^room\.client-[0-9a-f]{8}\.js$/),
    ).toBeNull()
  })

  test('matches the CSS hash naming pattern', () => {
    const dir = tmpDir()
    try {
      const older = join(dir, 'room-1111aaaa.css')
      const newer = join(dir, 'room-2222bbbb.css')
      writeFileSync(older, 'old')
      writeFileSync(newer, 'new')
      const tOld = new Date(Date.now() - 30_000)
      const tNew = new Date(Date.now())
      utimesSync(older, tOld, tOld)
      utimesSync(newer, tNew, tNew)
      const got = pickLatestHashed(dir, /^room-[0-9a-f]{8}\.css$/)
      expect(got).toBe('room-2222bbbb.css')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
