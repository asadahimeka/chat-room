import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_EMOJI_ENTRIES,
  buildEmojiMap,
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
})

describe('BUILTIN_EMOJI_ENTRIES', () => {
  test('fallback remote pack URL', () => {
    expect(BUILTIN_EMOJI_ENTRIES).toEqual(['https://www.nanoka.top/images/stamp/GBC/'])
  })
})