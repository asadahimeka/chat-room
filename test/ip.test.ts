import { describe, expect, test } from 'bun:test'
import { parseClientIp } from '../src/utils/ip'

describe('parseClientIp', () => {
  test('trustCloudflare + cf header → cf ip wins', () => {
    const h = new Headers({ 'cf-connecting-ip': '203.0.113.5' })
    expect(parseClientIp(h, { trustCloudflare: true, remoteAddress: '1.2.3.4' })).toBe(
      '203.0.113.5',
    )
  })

  test('trustCloudflare false → cf header ignored, remoteAddress used', () => {
    const h = new Headers({ 'cf-connecting-ip': '203.0.113.5' })
    expect(parseClientIp(h, { trustCloudflare: false, remoteAddress: '1.2.3.4' })).toBe('1.2.3.4')
  })

  test('no cf header → remoteAddress fallback', () => {
    const h = new Headers()
    expect(parseClientIp(h, { trustCloudflare: true, remoteAddress: '1.2.3.4' })).toBe('1.2.3.4')
  })

  test('no signal at all → unknown', () => {
    const h = new Headers()
    expect(parseClientIp(h, { trustCloudflare: false, remoteAddress: null })).toBe('unknown')
  })

  test('empty remoteAddress treated as absent → unknown', () => {
    const h = new Headers()
    expect(parseClientIp(h, { trustCloudflare: false, remoteAddress: '' })).toBe('unknown')
  })

  test('x-forwarded-for is NEVER trusted (client-forgeable)', () => {
    const h = new Headers({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })
    expect(parseClientIp(h, { trustCloudflare: false, remoteAddress: '1.2.3.4' })).toBe('1.2.3.4')
  })
})
