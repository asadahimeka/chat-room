import { describe, expect, it } from 'bun:test'
import {
  formatTime,
  escapeRegex,
  buildMentionRegex,
  shouldHighlight,
  genSid,
  isBlocked,
  journeyAdReplace,
  inIframe,
  isMobile,
  parseRoomData,
} from '../src/views/room.client'

describe('formatTime', () => {
  it('formats a unix-seconds timestamp as a locale string', () => {
    const ts = 1600000000
    const out = formatTime(ts)
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })

  it('is deterministic for the same timestamp', () => {
    expect(formatTime(1600000000)).toBe(formatTime(1600000000))
  })
})

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b')
    expect(escapeRegex('(x)')).toBe('\\(x\\)')
    expect(escapeRegex('a+b')).toBe('a\\+b')
  })

  it('leaves plain alphanumerics untouched', () => {
    expect(escapeRegex('abc123')).toBe('abc123')
  })
})

describe('buildMentionRegex', () => {
  it('builds a regex matching @...(<uid>)', () => {
    const re = buildMentionRegex('u123')
    expect(re.test('hello @foo(u123)')).toBe(true)
    expect(re.test('hello @foo(u999)')).toBe(false)
  })

  it('escapes special characters in the uid', () => {
    const re = buildMentionRegex('a.b')
    expect(re.test('@x(a.b)')).toBe(true)
    expect(re.test('@x(axb)')).toBe(false)
  })
})

describe('shouldHighlight', () => {
  it('returns true when the message mentions the current uid', () => {
    expect(shouldHighlight('hi @bob(u42)', 'u42')).toBe(true)
  })

  it('returns false when the message does not mention the uid', () => {
    expect(shouldHighlight('hi @bob(u99)', 'u42')).toBe(false)
  })

  it('returns false for an empty message', () => {
    expect(shouldHighlight('', 'u42')).toBe(false)
  })
})

describe('genSid', () => {
  it('returns a non-empty string', () => {
    expect(genSid().length).toBeGreaterThan(0)
  })

  it('produces distinct values across calls', () => {
    expect(genSid()).not.toBe(genSid())
  })
})

describe('isBlocked', () => {
  it('returns true when uid is in the block list', () => {
    expect(isBlocked('u1', ['u1', 'u2'])).toBe(true)
  })

  it('returns false when uid is not in the block list', () => {
    expect(isBlocked('u3', ['u1', 'u2'])).toBe(false)
  })

  it('returns false for an empty block list', () => {
    expect(isBlocked('u1', [])).toBe(false)
  })
})

describe('journeyAdReplace', () => {
  it('replaces 变态 with 好人', () => {
    expect(journeyAdReplace('你是变态')).toBe('你是好人')
  })

  it('leaves other text unchanged', () => {
    expect(journeyAdReplace('hello world')).toBe('hello world')
  })
})

describe('inIframe', () => {
  it('returns false when window is top', () => {
    expect(inIframe()).toBe(false)
  })
})

describe('isMobile', () => {
  it('detects mobile user agents', () => {
    expect(isMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)')).toBe(true)
    expect(isMobile('Mozilla/5.0 (Linux; Android 12)')).toBe(true)
  })

  it('returns false for desktop user agents', () => {
    expect(isMobile('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })
})

describe('parseRoomData', () => {
  it('parses the room-data JSON script content', () => {
    const el = {
      textContent: JSON.stringify({ roomId: '@demo', title: 'My Room' }),
    } as unknown as HTMLElement
    expect(parseRoomData(el)).toEqual({ roomId: '@demo', title: 'My Room' })
  })

  it('returns empty defaults when the element is missing', () => {
    expect(parseRoomData(null)).toEqual({ roomId: '', title: '' })
  })
})
