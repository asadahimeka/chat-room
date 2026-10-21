import { describe, expect, test } from 'bun:test'
import {
  encodeIdentity,
  decodeIdentity,
  sanitizeEnvelopeUid,
  sanitizeEnvelopeName,
} from '../src/utils/identity'

describe('encodeIdentity / decodeIdentity', () => {
  test('round-trips a unicode nickname', () => {
    const raw = encodeIdentity({ u: 'ab12cd3', n: '小明' })
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeIdentity(raw)).toEqual({ u: 'ab12cd3', n: '小明' })
  })

  test('round-trips the avatar flag', () => {
    const raw = encodeIdentity({ n: 'Alice', a: true })
    expect(decodeIdentity(raw)).toEqual({ n: 'Alice', a: true })
  })

  test('omits absent fields instead of emitting undefined', () => {
    const decoded = decodeIdentity(encodeIdentity({ u: 'u1' }))
    expect(decoded).toEqual({ u: 'u1' })
    expect('n' in (decoded as object)).toBe(false)
    expect('a' in (decoded as object)).toBe(false)
  })

  test('rejects malformed input without throwing', () => {
    expect(decodeIdentity(undefined)).toBeUndefined()
    expect(decodeIdentity(null)).toBeUndefined()
    expect(decodeIdentity('')).toBeUndefined()
    expect(decodeIdentity('!!!')).toBeUndefined()
    expect(decodeIdentity('bm90IGpzb24')).toBeUndefined() // base64url of "not json"
    expect(decodeIdentity('W10=')).toBeUndefined() // base64 of "[]"
    expect(decodeIdentity('bnVsbA')).toBeUndefined() // base64 of "null"
  })

  test('rejects non-object payloads and wrong field types', () => {
    expect(decodeIdentity(b64url('"str"'))).toBeUndefined()
    expect(decodeIdentity(b64url('42'))).toBeUndefined()
    expect(decodeIdentity(b64url('{"u":123}'))).toBeUndefined()
    expect(decodeIdentity(b64url('{"a":"yes"}'))).toBeUndefined()
  })

  test('drops over-long field values instead of passing them through', () => {
    const decoded = decodeIdentity(b64url(JSON.stringify({ u: 'x'.repeat(64), n: 'y'.repeat(200) })))
    expect(decoded).toBeUndefined()
  })

  test('rejects absurdly long raw input', () => {
    expect(decodeIdentity('A'.repeat(2048))).toBeUndefined()
  })
})

describe('sanitizeEnvelopeUid', () => {
  test('accepts 1-7 word chars', () => {
    expect(sanitizeEnvelopeUid('ab12cd3')).toBe('ab12cd3')
    expect(sanitizeEnvelopeUid('a')).toBe('a')
    expect(sanitizeEnvelopeUid('a-b_C')).toBe('a-b_C')
  })

  test('rejects anything else', () => {
    expect(sanitizeEnvelopeUid('toolonguid')).toBe('')
    expect(sanitizeEnvelopeUid('a b')).toBe('')
    expect(sanitizeEnvelopeUid('a'.repeat(8))).toBe('')
    expect(sanitizeEnvelopeUid('中文')).toBe('')
    expect(sanitizeEnvelopeUid('')).toBe('')
  })
})

describe('sanitizeEnvelopeName', () => {
  test('trims and keeps unicode', () => {
    expect(sanitizeEnvelopeName('  小明  ')).toBe('小明')
  })

  test('caps at 32 chars', () => {
    expect(sanitizeEnvelopeName('x'.repeat(40))).toBe('x'.repeat(32))
  })

  test('strips control characters', () => {
    expect(sanitizeEnvelopeName('a\nb')).toBe('ab')
    expect(sanitizeEnvelopeName('a\tb')).toBe('ab')
    expect(sanitizeEnvelopeName('a\u0000b')).toBe('ab')
  })

  test('empty stays empty', () => {
    expect(sanitizeEnvelopeName('   ')).toBe('')
  })
})

/** base64url of an ASCII/UTF-8 string (test helper, no padding). */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}
