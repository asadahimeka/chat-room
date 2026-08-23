import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_EMOJI_ENTRIES,
  buildEmojiMap,
  isEmojiOnlyMessage,
  loadRemoteManifest,
  parseInlineEmojiConfig,
  replaceEmojiTokens,
  resolveEmojiConfig,
} from '../src/utils/emoji.ts'
import type { EmojiPack } from '../src/utils/emoji.ts'

function makeFetch(
  handler: (url: string) => Response,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const VALID_MANIFEST = {
  name: 'GBC',
  type: 'png',
  icon: 'GBC_01',
  items: ['GBC_01', 'GBC_02'],
}

// Waline-shaped manifest: items and `icon` are stored WITHOUT the prefix; the
// real image URL is base + prefix + item + '.' + type.
const PREFIXED_MANIFEST = {
  name: 'Weibo',
  prefix: 'weibo_',
  type: 'png',
  icon: 'doge',
  items: ['smile', 'lovely'],
}

// Valine-shaped manifest: NO type, NO prefix; items carry the full filename
// (incl. extension). The real image URL is base + item (no extension appended).
const VALINE_MANIFEST = {
  name: 'Menhera-chan',
  icon: '1.jpg',
  items: ['1.jpg', '10.jpg', '100.jpg'],
}

describe('parseInlineEmojiConfig', () => {
  test('string entry → remoteUrls', () => {
    const { packs, remoteUrls } = parseInlineEmojiConfig(['https://x.com/stamp/GBC/'])
    expect(packs).toEqual([])
    expect(remoteUrls).toEqual(['https://x.com/stamp/GBC/'])
  })

  test('inline object → pack with Waline urlOf rule', () => {
    const { packs, remoteUrls } = parseInlineEmojiConfig([
      {
        name: 'test',
        icon: 'a',
        folder: 'https://x.com/stamp/',
        prefix: 'p_',
        type: 'png',
        items: ['a', 'b'],
      },
    ])
    expect(remoteUrls).toEqual([])
    expect(packs).toHaveLength(1)
    const pack = packs[0]
    expect(pack.name).toBe('test')
    expect(pack.icon).toBe('a')
    expect(pack.keywords).toEqual(['a', 'b'])
    expect(pack.urlOf('a')).toBe('https://x.com/stamp/p_a.png')
    expect(pack.urlOf('b')).toBe('https://x.com/stamp/p_b.png')
  })

  test('inline object without folder → urlOf returns empty string', () => {
    const { packs } = parseInlineEmojiConfig([{ name: 'x', type: 'png', items: ['a'] }])
    expect(packs[0].urlOf('a')).toBe('')
  })

  test('malformed inline objects are skipped silently', () => {
    const { packs, remoteUrls } = parseInlineEmojiConfig([
      { name: 'no-type', items: ['a'] },
      { type: 'png', items: ['a'] },
      { name: 'no-items', type: 'png' },
      { name: 'bad-items', type: 'png', items: 'nope' },
      null,
      42,
      { name: 'ok', type: 'png', items: ['a'] },
    ])
    expect(packs).toHaveLength(1)
    expect(packs[0].name).toBe('ok')
    expect(remoteUrls).toEqual([])
  })

  test('mixed input: strings → remoteUrls, objects → packs', () => {
    const { packs, remoteUrls } = parseInlineEmojiConfig([
      'https://x.com/a/',
      { name: 'inline', type: 'gif', items: ['x'] },
      'https://y.com/b/',
    ])
    expect(remoteUrls).toEqual(['https://x.com/a/', 'https://y.com/b/'])
    expect(packs).toHaveLength(1)
    expect(packs[0].name).toBe('inline')
  })
})

describe('replaceEmojiTokens', () => {
  const map = new Map([['hi', 'https://x/hi.png']])

  test('hit splits into img part', () => {
    expect(replaceEmojiTokens('a :hi: b', map)).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'img', url: 'https://x/hi.png' },
      { type: 'text', text: ' b' },
    ])
  })

  test('miss keeps original text including colons', () => {
    expect(replaceEmojiTokens('a :nope: b', map)).toEqual([
      { type: 'text', text: 'a :nope: b' },
    ])
  })

  test('mixed multiple hits with misses in between', () => {
    const m = new Map([
      ['a', 'https://x/a.png'],
      ['b', 'https://x/b.png'],
    ])
    expect(replaceEmojiTokens('x :a: y :nope: z :b: w', m)).toEqual([
      { type: 'text', text: 'x ' },
      { type: 'img', url: 'https://x/a.png' },
      { type: 'text', text: ' y :nope: z ' },
      { type: 'img', url: 'https://x/b.png' },
      { type: 'text', text: ' w' },
    ])
  })

  test('empty map → single text part', () => {
    expect(replaceEmojiTokens('a :hi: b', new Map())).toEqual([
      { type: 'text', text: 'a :hi: b' },
    ])
  })
})

describe('loadRemoteManifest', () => {
  test('valid info.json → pack built', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
    )
    const pack = await loadRemoteManifest('https://x.com/stamp/GBC/', fetchImpl)
    expect(pack).not.toBeNull()
    expect(pack!.name).toBe('GBC')
    expect(pack!.icon).toBe('GBC_01')
    expect(pack!.keywords).toEqual(['GBC_01', 'GBC_02'])
    expect(pack!.urlOf('GBC_02')).toBe('https://x.com/stamp/GBC/GBC_02.png')
    expect(calls).toEqual(['https://x.com/stamp/GBC/info.json'])
  })

  test('trailing slash auto-added', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
    )
    await loadRemoteManifest('https://x.com/stamp/GBC', fetchImpl)
    expect(calls[0]).toBe('https://x.com/stamp/GBC/info.json')
  })

  test('404 → null', async () => {
    const { fetchImpl } = makeFetch(() => new Response('not found', { status: 404 }))
    expect(await loadRemoteManifest('https://x.com/stamp/GBC/', fetchImpl)).toBeNull()
  })

  test('non-JSON body → null', async () => {
    const { fetchImpl } = makeFetch(() => new Response('<html>oops</html>', { status: 200 }))
    expect(await loadRemoteManifest('https://x.com/stamp/GBC/', fetchImpl)).toBeNull()
  })

  test('bad shape → null', async () => {
    const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ foo: 1 }), { status: 200 }))
    expect(await loadRemoteManifest('https://x.com/stamp/GBC/', fetchImpl)).toBeNull()
  })

  test('non-https URL → null without calling fetch', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
    )
    expect(await loadRemoteManifest('http://x.com/stamp/GBC/', fetchImpl)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('manifest with prefix → urlOf joins base+prefix+kw (Waline shape)', async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response(JSON.stringify(PREFIXED_MANIFEST), { status: 200 }),
    )
    const pack = await loadRemoteManifest(
      'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/',
      fetchImpl,
    )
    expect(pack).not.toBeNull()
    expect(pack!.name).toBe('Weibo')
    expect(pack!.icon).toBe('doge')
    // icon also flows through urlOf → prefix applied
    expect(pack!.urlOf(pack!.icon)).toBe(
      'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/weibo_doge.png',
    )
    expect(pack!.urlOf('smile')).toBe(
      'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/weibo_smile.png',
    )
    expect(pack!.urlOf('lovely')).toBe(
      'https://npm.elemecdn.com/@waline/emojis@1.2.0/weibo/weibo_lovely.png',
    )
  })

  test('manifest without prefix → urlOf unchanged (back-compat)', async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
    )
    const pack = await loadRemoteManifest('https://x.com/stamp/GBC/', fetchImpl)
    expect(pack!.urlOf('GBC_02')).toBe('https://x.com/stamp/GBC/GBC_02.png')
    expect(pack!.urlOf(pack!.icon)).toBe('https://x.com/stamp/GBC/GBC_01.png')
  })

  test('valine-shaped manifest (no type/prefix) → urlOf uses item as filename', async () => {
    const { fetchImpl } = makeFetch(() =>
      new Response(JSON.stringify(VALINE_MANIFEST), { status: 200 }),
    )
    const pack = await loadRemoteManifest('https://cdn.example.com/menhera/', fetchImpl)
    expect(pack).not.toBeNull()
    expect(pack!.name).toBe('Menhera-chan')
    expect(pack!.icon).toBe('1.jpg')
    // items already include the extension → no extension appended
    expect(pack!.urlOf('1.jpg')).toBe('https://cdn.example.com/menhera/1.jpg')
    expect(pack!.urlOf(pack!.icon)).toBe('https://cdn.example.com/menhera/1.jpg')
    expect(pack!.urlOf('10.jpg')).toBe('https://cdn.example.com/menhera/10.jpg')
  })
})

describe('resolveEmojiConfig', () => {
  test('inline packs first, then remote packs; nulls dropped', async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('bad')) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 })
    })
    const packs = await resolveEmojiConfig(
      [
        { name: 'inline', type: 'png', items: ['x'] },
        'https://x.com/stamp/GBC/',
        'https://x.com/stamp/bad/',
      ],
      fetchImpl,
    )
    expect(packs.map((p) => p.name)).toEqual(['inline', 'GBC'])
  })
})

describe('buildEmojiMap', () => {
  test('keyword → URL mapping', () => {
    const pack: EmojiPack = {
      name: 't',
      icon: 'a',
      keywords: ['a', 'b'],
      urlOf: (kw) => `https://x/${kw}.png`,
    }
    const map = buildEmojiMap([pack])
    expect(map.get('a')).toBe('https://x/a.png')
    expect(map.get('b')).toBe('https://x/b.png')
    expect(map.size).toBe(2)
  })

  test('non-https and empty URLs filtered out', () => {
    const good: EmojiPack = {
      name: 'good',
      icon: 'a',
      keywords: ['a'],
      urlOf: () => 'https://x/a.png',
    }
    const insecure: EmojiPack = {
      name: 'insecure',
      icon: '',
      keywords: ['b'],
      urlOf: () => 'http://x/b.png',
    }
    const noFolder: EmojiPack = {
      name: 'nofolder',
      icon: '',
      keywords: ['c'],
      urlOf: () => '',
    }
    const map = buildEmojiMap([good, insecure, noFolder])
    expect(map.get('a')).toBe('https://x/a.png')
    expect(map.has('b')).toBe(false)
    expect(map.has('c')).toBe(false)
    expect(map.size).toBe(1)
  })

  test('first pack wins on keyword collision; later pack skipped', () => {
    const weibo: EmojiPack = {
      name: 'weibo',
      icon: 'doge',
      keywords: ['smile', 'joy', 'weibo_only'],
      urlOf: (kw) => `https://weibo/${kw}.png`,
    }
    const qq: EmojiPack = {
      name: 'qq',
      icon: 'q',
      keywords: ['smile', 'joy', 'qq_only'],
      urlOf: (kw) => `https://qq/${kw}.png`,
    }
    const map = buildEmojiMap([weibo, qq])
    // Shared keywords resolve to the first (weibo) pack's URL.
    expect(map.get('smile')).toBe('https://weibo/smile.png')
    expect(map.get('joy')).toBe('https://weibo/joy.png')
    // Each pack's unique keyword is still collected.
    expect(map.get('weibo_only')).toBe('https://weibo/weibo_only.png')
    expect(map.get('qq_only')).toBe('https://qq/qq_only.png')
    expect(map.size).toBe(4)
  })

  test('prefixed packs register qualified key + bare alias; no cross-pack overwrite', () => {
    const weibo: EmojiPack = {
      name: 'weibo',
      icon: 'doge',
      prefix: 'weibo_',
      keywords: ['smile', 'joy', 'weibo_only'],
      urlOf: (kw) => `https://weibo/${kw}.png`,
    }
    const qq: EmojiPack = {
      name: 'qq',
      icon: 'q',
      prefix: 'qq_',
      keywords: ['smile', 'joy', 'qq_only'],
      urlOf: (kw) => `https://qq/${kw}.png`,
    }
    const map = buildEmojiMap([weibo, qq])
    // Qualified keys make every emoji addressable and never collide.
    expect(map.get('weibo_smile')).toBe('https://weibo/smile.png')
    expect(map.get('qq_smile')).toBe('https://qq/smile.png')
    expect(map.get('weibo_joy')).toBe('https://weibo/joy.png')
    expect(map.get('qq_joy')).toBe('https://qq/joy.png')
    // Bare alias still first-wins → weibo owns :smile: / :joy:.
    expect(map.get('smile')).toBe('https://weibo/smile.png')
    expect(map.get('joy')).toBe('https://weibo/joy.png')
    // qq's qualified key did NOT overwrite weibo's qualified key.
    expect(map.get('weibo_smile')).toBe('https://weibo/smile.png')
    // Unique keywords collected under both bare and qualified forms.
    expect(map.get('weibo_only')).toBe('https://weibo/weibo_only.png')
    expect(map.get('qq_only')).toBe('https://qq/qq_only.png')
    expect(map.size).toBe(10)
  })

  test('unprefixed pack behaves as before (GBC regression)', () => {
    const gbc: EmojiPack = {
      name: 'GBC',
      icon: 'GBC_01',
      keywords: ['GBC_01', 'GBC_02'],
      urlOf: (kw) => `https://x/${kw}.png`,
    }
    const map = buildEmojiMap([gbc])
    expect(map.get('GBC_01')).toBe('https://x/GBC_01.png')
    expect(map.get('GBC_02')).toBe('https://x/GBC_02.png')
    expect(map.size).toBe(2)
  })
})

describe('BUILTIN_EMOJI_ENTRIES', () => {
  test('fallback remote pack URL', () => {
    expect(BUILTIN_EMOJI_ENTRIES).toEqual(['https://www.nanoka.top/images/stamp/GBC/'])
  })
})

describe('isEmojiOnlyMessage', () => {
  const map = new Map([
    ['hi', 'https://x/hi.png'],
    ['bye', 'https://x/bye.png'],
  ])

  test('true for a single emoji token', () => {
    expect(isEmojiOnlyMessage(':hi:', map)).toBe(true)
  })

  test('true for multiple emoji tokens with surrounding whitespace', () => {
    expect(isEmojiOnlyMessage('  :hi:  :bye:  ', map)).toBe(true)
  })

  test('false when mixed with words', () => {
    expect(isEmojiOnlyMessage(':hi: hello', map)).toBe(false)
    expect(isEmojiOnlyMessage('hi :bye:', map)).toBe(false)
  })

  test('false when an unmatched :token: is present (counts as text)', () => {
    expect(isEmojiOnlyMessage(':hi: :nope:', map)).toBe(false)
  })

  test('false when there are no resolved emoji at all', () => {
    expect(isEmojiOnlyMessage('just words', map)).toBe(false)
    expect(isEmojiOnlyMessage(':nope:', map)).toBe(false)
  })

  test('false for an empty map', () => {
    expect(isEmojiOnlyMessage(':hi:', new Map())).toBe(false)
  })

  test('false for markdown-wrapped emoji (non-emoji chars remain)', () => {
    expect(isEmojiOnlyMessage('**:hi:**', map)).toBe(false)
  })
})