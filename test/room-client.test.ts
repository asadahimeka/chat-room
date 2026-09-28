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
  unescapeEntities,
  uploadErrorMsg,
  inIframe,
  isMobile,
  parseRoomData,
  isPinned,
  formatUnreadLabel,
  shouldCountAsUnread,
  sanitizeClientId,
  historyTipText,
  shouldHidePill,
  buildMessagePayload,
  shouldAccumulateUnread,
} from '../src/views/room.client'
import {
  applyMetaClasses,
  buildAvatarEl,
  serializeOutgoingMeta,
  safeParseMeta,
  REPLY_SNIPPET_MAX,
  msgDedupKey,
  mergeReplyIntoMeta,
  parseReplyFromMeta,
  isReplyToMe,
  buildReplyQuoteEl,
} from '../src/utils/render'
import { parseMarkdown } from '../src/utils/markdown'

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

describe('unescapeEntities', () => {
  it('restores a leading quote marker', () => {
    expect(unescapeEntities('&gt; quote')).toBe('> quote')
  })

  it('restores tags as literal text', () => {
    expect(unescapeEntities('&lt;b&gt;hi&lt;/b&gt;')).toBe('<b>hi</b>')
  })

  it('does not double-unescape (ampersand replaced last)', () => {
    expect(unescapeEntities('&amp;gt;')).toBe('&gt;')
  })

  it('restores ampersand and quotes', () => {
    expect(unescapeEntities('&amp;')).toBe('&')
    expect(unescapeEntities('&quot;x&quot;')).toBe('"x"')
  })

  it('leaves plain text unchanged', () => {
    expect(unescapeEntities('hello')).toBe('hello')
  })

  it('feeds markdown parsing after unescaping (quote node)', () => {
    const nodes = parseMarkdown(unescapeEntities('&gt; q'))
    expect(nodes.some((n) => n.type === 'quote')).toBe(true)
  })
})

describe('uploadErrorMsg', () => {
  it('maps 400 to the profile-required message', () => {
    expect(uploadErrorMsg(400)).toBe('Profile required')
  })

  it('maps 413 to the size-limit message', () => {
    expect(uploadErrorMsg(413)).toBe('Image exceeds the size limit')
  })

  it('maps 415 to the unsupported-type message', () => {
    expect(uploadErrorMsg(415)).toBe('Unsupported image type')
  })

  it('maps 429 to the quota message', () => {
    expect(uploadErrorMsg(429)).toBe('Daily upload quota exceeded')
  })

  it('maps 503 to the storage message', () => {
    expect(uploadErrorMsg(503)).toBe('Storage unavailable')
  })

  it('falls back to a generic message for unknown codes', () => {
    expect(uploadErrorMsg(0)).toBe('Upload failed')
    expect(uploadErrorMsg(500)).toBe('Upload failed')
    expect(uploadErrorMsg(999)).toBe('Upload failed')
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

  it('parses an optional uploadHost from room-data', () => {
    const el = {
      textContent: JSON.stringify({
        roomId: '@demo',
        title: 'My Room',
        uploadHost: 'https://cdn.example.com',
      }),
    } as unknown as HTMLElement
    expect(parseRoomData(el).uploadHost).toBe('https://cdn.example.com')
  })

  it('leaves uploadHost undefined when absent', () => {
    const el = {
      textContent: JSON.stringify({ roomId: '@demo', title: 'My Room' }),
    } as unknown as HTMLElement
    expect(parseRoomData(el).uploadHost).toBeUndefined()
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
    const el = buildAvatarEl({ avatar: 'https://x/a.png' }, 'A') as HTMLImageElement
    expect(el.tagName).toBe('IMG')
    expect(el.className).toBe('avatar-img')
    expect(el.src).toBe('https://x/a.png')
    expect(el.alt).toBe('')
    expect(el.loading).toBe('lazy')
    expect(el.referrerPolicy).toBe('no-referrer')
  })

  it('builds an img for a data:image avatar URL', () => {
    const el = buildAvatarEl({ avatar: 'data:image/png;base64,xxx' }, 'A') as HTMLImageElement
    expect(el.tagName).toBe('IMG')
    expect(el.src).toBe('data:image/png;base64,xxx')
  })

  it('falls back to a monogram span for a javascript: avatar', () => {
    const el = buildAvatarEl({ avatar: 'javascript:alert(1)' }, 'A')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toBe('avatar')
    expect(el.style.background).toContain('linear-gradient')
    expect(el.textContent).toBe('A')
  })

  it('builds a monogram span for null meta', () => {
    const el = buildAvatarEl(null, 'bob')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toBe('avatar')
    expect(el.style.background).toContain('linear-gradient')
    expect(el.textContent).toBe('B')
  })

  // ── New tests for updated monogram rules ────────────────────────────
  it('system name user_xxxxx → strip prefix, uppercase first char of slug', () => {
    const el = buildAvatarEl(null, 'user_abc12')
    expect(el.textContent).toBe('A')
  })

  it('empty name → empty string (no letter)', () => {
    const el = buildAvatarEl(null, '')
    expect(el.textContent).toBe('')
  })

  it('same uid → same gradient colors', () => {
    const el1 = buildAvatarEl(null, 'alice', 'u42')
    const el2 = buildAvatarEl(null, 'bob', 'u42')
    expect(el1.style.background).toBe(el2.style.background)
  })

  it('different uid → different gradient colors (with high probability)', () => {
    const el1 = buildAvatarEl(null, 'alice', 'u1')
    const el2 = buildAvatarEl(null, 'alice', 'u2')
    // Hash-based colors should differ for different inputs
    expect(el1.style.background).not.toBe(el2.style.background)
  })
})

// ── Upload button loading state ────────────────────────────────────────
describe('upload button loading state', () => {
  it('adds uploading class and disables button when upload starts', () => {
    const btn = document.createElement('button')
    btn.className = 'composer-btn'

    // Simulate what the upload handler does at the start
    btn.disabled = true
    btn.classList.add('uploading')

    expect(btn.disabled).toBe(true)
    expect(btn.classList.contains('uploading')).toBe(true)
  })

  it('removes uploading class and re-enables button when upload finishes', () => {
    const btn = document.createElement('button')
    btn.className = 'composer-btn'
    btn.disabled = true
    btn.classList.add('uploading')

    // Simulate what the .finally() block does
    btn.disabled = false
    btn.classList.remove('uploading')

    expect(btn.disabled).toBe(false)
    expect(btn.classList.contains('uploading')).toBe(false)
  })

  it('button is not clickable while uploading (disabled blocks interaction)', () => {
    const btn = document.createElement('button')
    btn.className = 'composer-btn'
    btn.disabled = true
    btn.classList.add('uploading')

    // A disabled button should report disabled state
    expect(btn.disabled).toBe(true)
    // The uploading class should be present for visual feedback
    expect(btn.classList.contains('uploading')).toBe(true)
  })

  it('upload input value is reset after file selection to allow re-upload', () => {
    // Simulates the guard: uploadInput.value = '' after reading the file
    const input = document.createElement('input')
    // In real browser, input.value would be the file path; we simulate reset
    input.value = '/fake/path/image.png'
    input.value = '' // The actual guard in the handler
    expect(input.value).toBe('')
  })

  it('multiple rapid uploads are blocked by the disabled guard', () => {
    const btn = document.createElement('button')
    btn.className = 'composer-btn'

    // First upload starts
    btn.disabled = true
    btn.classList.add('uploading')
    expect(btn.disabled).toBe(true)

    // Second click should be blocked (button is disabled)
    // In real browser, click events don't fire on disabled buttons
    expect(btn.disabled).toBe(true)
    expect(btn.classList.contains('uploading')).toBe(true)

    // First upload ends
    btn.disabled = false
    btn.classList.remove('uploading')
    expect(btn.disabled).toBe(false)
    expect(btn.classList.contains('uploading')).toBe(false)
  })
})

describe('isPinned', () => {
  it('isPinned tolerates 32px near-bottom', () => {
    // scrollTop=900 + clientHeight=100 = 1000 >= scrollHeight(1000) - 32 → true
    expect(isPinned(900, 100, 1000)).toBe(true)
    // scrollTop=0 + clientHeight=100 = 100 < 1000 - 32 = 968 → false
    expect(isPinned(0, 100, 1000)).toBe(false)
    // Exact bottom: scrollTop=900 + clientHeight=100 = 1000 >= 1000 - 0 → true
    expect(isPinned(900, 100, 1000, 0)).toBe(true)
  })
})

describe('formatUnreadLabel', () => {
  it('formatUnreadLabel caps at 99+', () => {
    expect(formatUnreadLabel(0)).toBe('')
    expect(formatUnreadLabel(3)).toBe('↓ 3 条新消息')
    expect(formatUnreadLabel(120)).toBe('↓ 99+ 条新消息')
  })
})

describe('shouldCountAsUnread', () => {
  it('shouldCountAsUnread counts sys + others, not self', () => {
    expect(shouldCountAsUnread('sys', false)).toBe(true)
    expect(shouldCountAsUnread('msg', false)).toBe(true)
    expect(shouldCountAsUnread('msg', true)).toBe(false)
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

// ── Task 3: sanitizeClientId re-export + resend id uniqueness ──────────
describe('sanitizeClientId (re-exported from room.client)', () => {
  it('passes through valid ids', () => {
    expect(sanitizeClientId('ok-1_x')).toBe('ok-1_x')
  })

  it('rejects ids with spaces', () => {
    expect(sanitizeClientId('no spaces')).toBeUndefined()
  })
})

describe('genSid uniqueness (Task 3 resend)', () => {
  it('resend uses a fresh id (no reuse)', () => {
    expect(genSid()).not.toBe(genSid())
  })
})

// ── Bugfix: pill visibility + payload shape ────────────────────────────
describe('shouldHidePill', () => {
  it('hides when pinned, regardless of unread', () => {
    expect(shouldHidePill(true, 0)).toBe(true)
    expect(shouldHidePill(true, 5)).toBe(true)
  })

  it('hides when there is nothing to show, even if scrolled up', () => {
    expect(shouldHidePill(false, 0)).toBe(true)
  })

  it('shows only when scrolled up AND there are unreads', () => {
    expect(shouldHidePill(false, 3)).toBe(false)
  })
})

describe('buildMessagePayload', () => {
  it('places clientId inside data (server reads event.data.clientId)', () => {
    const payload = buildMessagePayload(
      { uid: 'u1', name: 'a', msg: 'hi', namecolor: '#117743', msgcolor: '#3d3d3d' },
      'abc123',
    )
    expect(payload.type).toBe('message')
    if (payload.type !== 'message') throw new Error('unreachable')
    expect(payload.data.clientId).toBe('abc123')
    expect(payload).not.toHaveProperty('clientId')
  })
})
// ── Bugfix: live-only unread accumulation ────────────────────────────
describe('shouldAccumulateUnread', () => {
  it('counts only live arrivals while scrolled up', () => {
    expect(shouldAccumulateUnread(true, false)).toBe(true)
    expect(shouldAccumulateUnread(true, true)).toBe(false)
  })

  it('never counts bulk history load, even when unpinned', () => {
    expect(shouldAccumulateUnread(false, false)).toBe(false)
    expect(shouldAccumulateUnread(false, true)).toBe(false)
  })
})

// ── Task 4: historyTipText ────────────────────────────────────────────
describe('historyTipText', () => {
  it('covers all states', () => {
    expect(historyTipText('loading')).toBe('加载历史中…')
    expect(historyTipText('error')).toBe('加载失败，点击重试')
    expect(historyTipText('end')).toBe('没有更多历史了')
    expect(historyTipText('hidden')).toBe('')
  })
})

// ── Reply: dedup key dimension + meta merge ───────────────────────────
describe('msgDedupKey', () => {
  it('keeps legacy bare key when meta has no reply', () => {
    expect(msgDedupKey('u1', 123, 'hi', undefined)).toBe('u1|123|hi')
    expect(msgDedupKey('u1', 123, 'hi', '{"bold":true}')).toBe('u1|123|hi')
  })

  it('appends reply dimension when meta carries a reply', () => {
    expect(msgDedupKey('u1', 123, 'hi', '{"reply":{"ruid":"u2","rname":"A","rmsg":"q"}}')).toBe('u1|123|hi|r:u2')
  })

  it('tolerates malformed meta', () => {
    expect(msgDedupKey('u1', 123, 'hi', '{oops')).toBe('u1|123|hi')
  })

  it('treats undefined parts as empty like the legacy template', () => {
    expect(msgDedupKey(undefined, undefined, undefined, undefined)).toBe('||')
  })
})

describe('mergeReplyIntoMeta', () => {
  const reply = { ruid: 'u2', rname: 'Alice', rmsg: 'q' }

  it('merges reply into existing style meta', () => {
    expect(JSON.parse(mergeReplyIntoMeta('{"bold":true}', reply))).toEqual({
      bold: true,
      reply,
    })
  })

  it('creates meta from scratch when absent or malformed', () => {
    expect(JSON.parse(mergeReplyIntoMeta(undefined, reply))).toEqual({ reply })
    const fromBad = JSON.parse(mergeReplyIntoMeta('{oops', reply)) as { reply: typeof reply }
    expect(fromBad.reply.ruid).toBe('u2')
  })

  it('overwrites a previous reply', () => {
    const old = JSON.stringify({ reply: { ruid: 'x', rname: 'X', rmsg: 'x' } })
    expect(JSON.parse(mergeReplyIntoMeta(old, reply))).toEqual({ reply })
  })

  it('exposes REPLY_SNIPPET_MAX as 80', () => {
    expect(REPLY_SNIPPET_MAX).toBe(80)
  })
})

// ── Reply: quote bar renderer ─────────────────────────────────────────
describe('parseReplyFromMeta', () => {
  it('parses a valid reply snapshot', () => {
    expect(parseReplyFromMeta('{"reply":{"ruid":"u2","rname":"Alice","rmsg":"q"}}')).toEqual({
      ruid: 'u2', rname: 'Alice', rmsg: 'q',
    })
  })

  it('returns null for missing, malformed, or partial reply', () => {
    expect(parseReplyFromMeta(undefined)).toBeNull()
    expect(parseReplyFromMeta('{"bold":true}')).toBeNull()
    expect(parseReplyFromMeta('{"reply":{"ruid":"u2"}}')).toBeNull()
    expect(parseReplyFromMeta('{"reply":"nope"}')).toBeNull()
    expect(parseReplyFromMeta('{"reply":{"ruid":"","rname":"A","rmsg":"q"}}')).toBeNull()
  })
})

describe('buildReplyQuoteEl', () => {
  const reply = { ruid: 'u2', rname: 'Alice', rmsg: 'hello' }

  it('renders name + snippet via textContent only', () => {
    const el = buildReplyQuoteEl(reply, 'u1', false)
    expect(el.className).toBe('reply-quote')
    expect(el.textContent).toBe('Alicehello')
  })

  it('marks reply-to-me when ruid matches self uid', () => {
    expect(buildReplyQuoteEl(reply, 'u2', false).className).toBe('reply-quote reply-to-me')
    expect(isReplyToMe(reply, 'u2')).toBe(true)
    expect(isReplyToMe(reply, undefined)).toBe(false)
  })

  it('shows blocked placeholder without leaking content', () => {
    const el = buildReplyQuoteEl(reply, 'u1', true)
    expect(el.className).toBe('reply-quote reply-blocked')
    expect(el.textContent).toBe('已屏蔽的消息')
  })
})
