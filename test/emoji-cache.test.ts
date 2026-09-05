import { describe, expect, test } from 'bun:test'
import {
  CACHE_MAX,
  CACHE_PREFIX,
  CACHE_TTL,
  loadRemoteManifest,
  type ManifestCacheStore,
} from '../src/utils/emoji'

/** In-memory ManifestCacheStore for deterministic, DOM-free tests. */
function memStore(): ManifestCacheStore & { _map: Map<string, string> } {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
    _map: m,
  }
}

function makeFetch(handler: (url: string) => Response): typeof fetch {
  const fn = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return handler(url)
  }) as typeof fetch
  return fn
}

const VALID_MANIFEST = {
  name: 'GBC',
  type: 'png',
  icon: 'GBC_01',
  items: ['GBC_01', 'GBC_02'],
}

function cacheValue(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    name: 'GBC',
    icon: 'GBC_01',
    prefix: '',
    type: 'png',
    keywords: ['GBC_01', 'GBC_02'],
    ts: Date.now(),
    ...overrides,
  })
}

describe('loadRemoteManifest — cache read', () => {
  test('fresh cache hit skips the network and rebuilds the pack', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    store.setItem(CACHE_PREFIX + base, cacheValue())
    const fetchImpl = makeFetch(() => {
      throw new Error('network should not be used on a cache hit')
    })
    const pack = await loadRemoteManifest(base, fetchImpl, store)
    expect(pack).not.toBeNull()
    expect(pack!.name).toBe('GBC')
    expect(pack!.urlOf('GBC_02')).toBe('https://x.com/stamp/GBC/GBC_02.png')
  })

  test('expired cache falls through to the network', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    store.setItem(CACHE_PREFIX + base, cacheValue({ ts: Date.now() - CACHE_TTL - 1000 }))
    let called = false
    const fetchImpl = makeFetch(() => {
      called = true
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 })
    })
    const pack = await loadRemoteManifest(base, fetchImpl, store)
    expect(called).toBe(true)
    expect(pack).not.toBeNull()
  })
})

describe('loadRemoteManifest — cache write', () => {
  test('successful fetch writes the manifest to the cache', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    const fetchImpl = makeFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }))
    await loadRemoteManifest(base, fetchImpl, store)
    const raw = store.getItem(CACHE_PREFIX + base)
    expect(raw).not.toBeNull()
    const cached = JSON.parse(raw!)
    expect(cached.name).toBe('GBC')
    expect(cached.type).toBe('png')
    expect(cached.keywords).toEqual(['GBC_01', 'GBC_02'])
    expect(typeof cached.ts).toBe('number')
  })

  test('non-https URL is rejected without touching the store', async () => {
    const store = memStore()
    const fetchImpl = makeFetch(() => new Response('', { status: 200 }))
    const pack = await loadRemoteManifest('http://x.com/stamp/GBC/', fetchImpl, store)
    expect(pack).toBeNull()
    expect(store.keys!()).toHaveLength(0)
  })
})

describe('loadRemoteManifest — failure fallback', () => {
  test('fetch failure with an expired cache still returns the cached pack', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    store.setItem(CACHE_PREFIX + base, cacheValue({ ts: Date.now() - CACHE_TTL - 1000 }))
    const fetchImpl = makeFetch(() => {
      throw new Error('network down')
    })
    const pack = await loadRemoteManifest(base, fetchImpl, store)
    expect(pack).not.toBeNull()
    expect(pack!.name).toBe('GBC')
  })

  test('fetch failure with no cache returns null', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    const fetchImpl = makeFetch(() => {
      throw new Error('network down')
    })
    const pack = await loadRemoteManifest(base, fetchImpl, store)
    expect(pack).toBeNull()
  })

  test('corrupt cached JSON is treated as a miss and refetched', async () => {
    const store = memStore()
    const base = 'https://x.com/stamp/GBC/'
    store.setItem(CACHE_PREFIX + base, 'this is not json')
    let called = false
    const fetchImpl = makeFetch(() => {
      called = true
      return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 })
    })
    const pack = await loadRemoteManifest(base, fetchImpl, store)
    expect(called).toBe(true)
    expect(pack).not.toBeNull()
  })
})

describe('loadRemoteManifest — cache write cap (~120 keys)', () => {
  test('writing more than CACHE_MAX distinct packs evicts the oldest', async () => {
    const store = memStore()
    const fetchImpl = makeFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }))
    // CACHE_MAX+1 distinct remote packs → one eviction.
    for (let i = 0; i < CACHE_MAX + 1; i++) {
      await loadRemoteManifest(`https://cdn.example.com/p${i}/`, fetchImpl, store)
    }
    const keys = store.keys!().filter((k) => k.startsWith(CACHE_PREFIX))
    expect(keys.length).toBe(CACHE_MAX)
  })
})
