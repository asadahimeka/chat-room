import { describe, expect, it } from 'bun:test'
// Registers the global DOM stub BEFORE importing room.client (its module-level
// code runs when `document` exists; readyState 'loading' defers init()).
import './dom-stub'
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
import {
  applyMetaClasses,
  buildAvatarEl,
  serializeOutgoingMeta,
  safeParseMeta,
} from '../src/utils/render'

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

  it('parses an optional emoji array from room-data', () => {
    const el = {
      textContent: JSON.stringify({ roomId: '@demo', title: 'My Room', emoji: ['https://x/a/'] }),
    } as unknown as HTMLElement
    expect(parseRoomData(el)).toEqual({ roomId: '@demo', title: 'My Room', emoji: ['https://x/a/'] })
  })
})

describe('applyMetaClasses', () => {
  it('maps each validated meta field to its class', () => {
    const el = document.createElement('div')
    applyMetaClasses(el, { font: 'serif', size: 'lg', bold: true, italic: true, bubble: 'card' })
    expect(el.classList.contains('font-serif')).toBe(true)
    expect(el.classList.contains('size-lg')).toBe(true)
    expect(el.classList.contains('msg-bold')).toBe(true)
    expect(el.classList.contains('msg-italic')).toBe(true)
    expect(el.classList.contains('bubble--card')).toBe(true)
  })

  it('maps mono font, sm size and flat/minimal bubbles', () => {
    const el = document.createElement('div')
    applyMetaClasses(el, { font: 'mono', size: 'sm', bubble: 'flat' })
    expect(el.classList.contains('font-mono')).toBe(true)
    expect(el.classList.contains('size-sm')).toBe(true)
    expect(el.classList.contains('bubble--flat')).toBe(true)
    const el2 = document.createElement('div')
    applyMetaClasses(el2, { bubble: 'minimal' })
    expect(el2.classList.contains('bubble--minimal')).toBe(true)
  })

  it('adds no class for md size or default bubble', () => {
    const el = document.createElement('div')
    applyMetaClasses(el, { size: 'md', bubble: 'default' })
    expect(el.classList.contains('size-sm')).toBe(false)
    expect(el.classList.contains('size-lg')).toBe(false)
    expect(el.classList.contains('bubble--flat')).toBe(false)
    expect(el.classList.contains('bubble--card')).toBe(false)
    expect(el.classList.contains('bubble--minimal')).toBe(false)
  })

  it('ignores unknown values', () => {
    const el = document.createElement('div')
    applyMetaClasses(el, { font: 'comic', size: 'xl', bold: 'yes', bubble: 'weird' })
    expect(el.classList.contains('font-serif')).toBe(false)
    expect(el.classList.contains('font-mono')).toBe(false)
    expect(el.classList.contains('size-sm')).toBe(false)
    expect(el.classList.contains('size-lg')).toBe(false)
    expect(el.classList.contains('msg-bold')).toBe(false)
    expect(el.classList.contains('msg-italic')).toBe(false)
  })

  it('is a no-op for null meta', () => {
    const el = document.createElement('div')
    applyMetaClasses(el, null)
    expect(el.classList.contains('font-serif')).toBe(false)
    expect(el.classList.contains('size-lg')).toBe(false)
    expect(el.classList.contains('msg-bold')).toBe(false)
  })
})

describe('serializeOutgoingMeta', () => {
  it('returns undefined when all prefs are defaults', () => {
    expect(serializeOutgoingMeta({})).toBeUndefined()
    expect(
      serializeOutgoingMeta({ font: 'default', size: 'md', bold: false, italic: false, bubble: 'default' }),
    ).toBeUndefined()
  })

  it('serializes only non-default fields', () => {
    expect(serializeOutgoingMeta({ font: 'serif', size: 'lg', bold: true })).toBe(
      '{"font":"serif","size":"lg","bold":true}',
    )
  })

  it('drops a javascript: avatar', () => {
    expect(serializeOutgoingMeta({ avatar: 'javascript:alert(1)' })).toBeUndefined()
  })

  it('keeps a valid https avatar', () => {
    expect(serializeOutgoingMeta({ avatar: 'https://x/a.png' })).toBe('{"avatar":"https://x/a.png"}')
  })

  it('keeps a data:image avatar', () => {
    expect(serializeOutgoingMeta({ avatar: 'data:image/png;base64,xxx' })).toBe(
      '{"avatar":"data:image/png;base64,xxx"}',
    )
  })
})

describe('buildAvatarEl', () => {
  it('builds an img for a safe https avatar URL', () => {
    const el = buildAvatarEl({ avatar: 'https://x/a.png' }, 'A', '#c00') as HTMLImageElement
    expect(el.tagName).toBe('IMG')
    expect(el.className).toBe('avatar-img')
    expect(el.src).toBe('https://x/a.png')
    expect(el.alt).toBe('')
    expect(el.loading).toBe('lazy')
    expect(el.referrerPolicy).toBe('no-referrer')
  })

  it('builds an img for a data:image avatar URL', () => {
    const el = buildAvatarEl({ avatar: 'data:image/png;base64,xxx' }, 'A', '#c00') as HTMLImageElement
    expect(el.tagName).toBe('IMG')
    expect(el.src).toBe('data:image/png;base64,xxx')
  })

  it('falls back to a monogram span for a javascript: avatar', () => {
    const el = buildAvatarEl({ avatar: 'javascript:alert(1)' }, 'A', '#c00')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toBe('avatar')
    expect(el.style.background).toBe('#c00')
    expect(el.textContent).toBe('A')
  })

  it('builds a monogram span for null meta', () => {
    const el = buildAvatarEl(null, 'bob', '#117743')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toBe('avatar')
    expect(el.style.background).toBe('#117743')
    expect(el.textContent).toBe('B')
  })
})

describe('safeParseMeta', () => {
  it('parses valid JSON objects', () => {
    expect(safeParseMeta('{"bold":true}')).toEqual({ bold: true })
  })

  it('returns null for invalid JSON', () => {
    expect(safeParseMeta('{bad')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(safeParseMeta('"str"')).toBeNull()
    expect(safeParseMeta('[1,2]')).toBeNull()
  })

  it('returns null for null/undefined/empty input', () => {
    expect(safeParseMeta(null)).toBeNull()
    expect(safeParseMeta(undefined)).toBeNull()
    expect(safeParseMeta('')).toBeNull()
  })
})
