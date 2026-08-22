import { describe, expect, it } from 'bun:test'
import { renderRoomPage } from '../src/views/room'

const CONTRACT_IDS = [
  'room-header',
  'online-count',
  'user-list',
  'msg-list',
  'name-input',
  'msg-input',
  'name-color',
  'msg-color',
  'send-btn',
  'toast',
] as const

describe('renderRoomPage room page', () => {
  it('returns a full HTML document string', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(typeof html).toBe('string')
    expect(html).toMatch(/^<!DOCTYPE html>/i)
    expect(html).toMatch(/<html lang="zh-CN">/)
  })

  it('injects roomId into the room-data JSON script', () => {
    const html = renderRoomPage({ roomId: '@demo', title: 'My Room' })
    expect(html).toContain('id="room-data"')
    expect(html).toContain('"roomId":"@demo"')
    expect(html).toContain('"title":"My Room"')
  })

  it('includes emoji in room-data when provided', () => {
    const html = renderRoomPage({ roomId: '@demo', emoji: ['https://x/a/'] })
    expect(html).toContain('"emoji":["https://x/a/"]')
  })

  it('escapes a malicious title inside room-data (no raw <script>)', () => {
    const html = renderRoomPage({ roomId: '@demo', title: '<script>alert(1)</script>' })
    // The JSON.stringify output must escape the angle brackets so no raw <script> survives.
    expect(html).not.toContain('<script>alert(1)</script>')
    // The escaped form (JSON.stringify produces \u003cscript\u003e) must be present.
    expect(html).toContain('\\u003cscript\\u003e')
  })

  it('escapes roomId in the <title> element', () => {
    const html = renderRoomPage({ roomId: '<b>x</b>' })
    expect(html).not.toContain('<title><b>x</b> - Chat Room</title>')
    expect(html).toMatch(/<title>[^<]*&lt;b&gt;[^<]* - Chat Room<\/title>/)
  })

  it('references the local CSS and bundled client JS', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).toContain('/static/css/room.css')
    expect(html).toContain('/static/js/room.client.js')
  })

  it('contains no CDN or external script references', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).not.toContain('cdn.jsdelivr')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('http://')
  })

  it('contains no inline <script> blocks except the theme bootstrap', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    // Allowed inline scripts: the JSON data injection and the theme bootstrap
    // (must run before paint to avoid a theme flash). Everything else must be
    // an external module reference.
    const stripped = html.replace(
      /<script>[\s\S]*?localStorage\.getItem\('theme'[\s\S]*?<\/script>/,
      '',
    )
    expect(stripped).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/)
  })

  it('contains all 10 contract element IDs', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    for (const id of CONTRACT_IDS) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('contains the color-scheme meta for native light/dark', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
  })

  it('contains the favicon link', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).toContain('href="/favicon.ico"')
  })

  it('uses the contract class names', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    for (const cls of ['room-layout', 'sidebar', 'message-list', 'composer', 'status', 'toast']) {
      expect(html).toContain(cls)
    }
  })
})
