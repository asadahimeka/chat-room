import { describe, expect, test } from 'bun:test'
import {
  REGEX_HEX_COLOR,
  genGuestName,
  getCookie,
  processInput,
  sanitizeColor,
  sanitizeMsg,
  sanitizeName,
  sanitizeUid,
} from '../src/utils/input.ts'

describe('processInput', () => {
  test('runs xss sanitization BEFORE the banword filter when flag is true', () => {
    const out = processInput('<script>alert(1)</script>', true)
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;script')
  })

  test('skips xss entirely when flag is undefined — banword only', () => {
    // Locks the legacy XSS asymmetry: undefined flag must NOT strip tags
    expect(processInput('<img src=x>')).toBe('<img src=x>')
  })

  test('skips xss when flag is false — banword only', () => {
    expect(processInput('<img src=x>', false)).toBe('<img src=x>')
  })

  test('replaces a banned word with ***', () => {
    expect(processInput('you bitch')).toBe('you ***')
  })

  test('replaces a banned word with *** even when flag is true', () => {
    expect(processInput('you bitch', true)).toBe('you ***')
  })
})

describe('sanitizeColor', () => {
  test('keeps a valid 3-digit hex color', () => {
    expect(sanitizeColor('#abc', '#3d3d3d')).toBe('#abc')
  })

  test('keeps a valid 6-digit hex color', () => {
    expect(sanitizeColor('#117743', '#3d3d3d')).toBe('#117743')
  })

  test('falls back for non-hex color names', () => {
    expect(sanitizeColor('red', '#117743')).toBe('#117743')
  })

  test('falls back for undefined value', () => {
    expect(sanitizeColor(undefined, '#3d3d3d')).toBe('#3d3d3d')
  })

  test('REGEX_HEX_COLOR rejects invalid hex values', () => {
    expect(REGEX_HEX_COLOR.test('red')).toBe(false)
    expect(REGEX_HEX_COLOR.test('#ggg')).toBe(false)
    expect(REGEX_HEX_COLOR.test('#abcde')).toBe(false)
    expect(REGEX_HEX_COLOR.test('#12345')).toBe(false)
    expect(REGEX_HEX_COLOR.test('#123456789')).toBe(false)
  })
})

describe('sanitizeName', () => {
  test('trims surrounding whitespace', () => {
    expect(sanitizeName('  alice  ')).toBe('alice')
  })

  test('truncates to 32 characters', () => {
    const long = 'a'.repeat(40)
    expect(sanitizeName(long)).toBe('a'.repeat(32))
    expect(sanitizeName(long).length).toBe(32)
  })
})

describe('sanitizeMsg', () => {
  test('trims surrounding whitespace', () => {
    expect(sanitizeMsg('  hello  ')).toBe('hello')
  })

  test('truncates to 1000 characters', () => {
    const long = 'm'.repeat(1200)
    expect(sanitizeMsg(long).length).toBe(1000)
    expect(sanitizeMsg(long)).toBe('m'.repeat(1000))
  })
})

describe('sanitizeUid', () => {
  test('trims surrounding whitespace', () => {
    expect(sanitizeUid('  abc123  ')).toBe('abc123')
  })

  test('truncates to 7 characters', () => {
    const long = 'x'.repeat(20)
    expect(sanitizeUid(long)).toBe('x'.repeat(7))
    expect(sanitizeUid(long).length).toBe(7)
  })
})

describe('getCookie', () => {
  test('extracts a cookie by name', () => {
    expect(getCookie('name=alice; uid=abc1234', 'name')).toBe('alice')
  })

  test('extracts a cookie value when it is the first token', () => {
    expect(getCookie('uid=xyz; name=bob', 'name')).toBe('bob')
  })

  test('returns empty string when the cookie name is missing', () => {
    expect(getCookie('foo=bar; baz=qux', 'name')).toBe('')
  })

  test('returns empty string when the header is undefined', () => {
    expect(getCookie(undefined, 'name')).toBe('')
  })

  test('returns empty string for a partial name match', () => {
    expect(getCookie('username=alice', 'name')).toBe('')
  })

  test('returns wrong_name on malformed percent-encoding', () => {
    expect(getCookie('name=%zz', 'name')).toBe('wrong_name')
  })
})

describe('genGuestName', () => {
  test('generates a guest name matching the legacy pattern', () => {
    for (let i = 0; i < 50; i++) {
      expect(genGuestName()).toMatch(/^user_[a-z0-9]{5}$/)
    }
  })
})
