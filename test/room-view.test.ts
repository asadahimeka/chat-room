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

  it('injects the upload storage origin into room-data', () => {
    // Explicit injection keeps this test hermetic (independent of local config.yml).
    const html = renderRoomPage({ roomId: '@demo', uploadHost: 'https://cdn.example.com' })
    expect(html).toContain('"uploadHost":"https://cdn.example.com"')
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
    // Accepts either the fixed dev name or a content-hashed build output.
    expect(html).toMatch(/\/static\/css\/room[^\"]*\.css/)
    expect(html).toMatch(/\/static\/js\/room\.client[^\"]*\.js/)
  })

  it('contains no CDN or external script references', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).not.toContain('cdn.jsdelivr')
    // External references only via src/href attributes; the avatar input's
    // `placeholder="https://..."` is inert text, not a resource reference.
    expect(html).not.toContain('src="https://')
    expect(html).not.toContain('href="https://')
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

  it('contains the settings modal and emoji panel controls', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    for (const id of [
      'emoji-btn',
      'settings-btn',
      'emoji-panel',
      'settings-modal',
      'settings-close',
      'set-font',
      'set-size',
      'set-bold',
      'set-italic',
      'set-avatar',
      'set-bubble',
    ]) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('places the color pickers inside the settings modal, not the composer', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    // Contract IDs #name-color / #msg-color must still exist (frozen contract).
    expect(html).toContain('id="name-color"')
    expect(html).toContain('id="msg-color"')
    // They live inside the settings modal block.
    const modal = html.slice(html.indexOf('id="settings-modal"'), html.indexOf('id="toast"'))
    expect(modal).toContain('id="name-color"')
    expect(modal).toContain('id="msg-color"')
    // The composer must no longer carry the composer-left color block.
    const composer = html.slice(html.indexOf('class="composer"'), html.indexOf('id="emoji-panel"'))
    expect(composer).not.toContain('composer-left')
    expect(composer).not.toContain('class="color-picker"')
  })

  it('contains the image upload button and hidden file input', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).toContain('id="upload-btn"')
    expect(html).toContain('id="upload-input"')
    expect(html).toContain('accept="image/png,image/jpeg,image/gif,image/webp,image/avif"')
    expect(html).toContain('<input type="file" id="upload-input" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden>')
  })

  it('renders three composer icon buttons', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html.match(/class="composer-btn"/g)?.length).toBe(3)
  })

  it('marks the settings modal as a dialog', () => {
    const html = renderRoomPage({ roomId: '@demo' })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })
})
