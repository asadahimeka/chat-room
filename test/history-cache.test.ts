import { describe, expect, test } from 'bun:test'
import {
  loadHistoryCache,
  saveHistoryCache,
  clearHistoryCache,
  type CachedMsg,
} from '../src/utils/history-cache'

/**
 * Minimal in-memory IndexedDB stub (~50 lines) supporting only what
 * history-cache.ts uses: open (with onupgradeneeded), a keyPath objectStore
 * with get/put/getAll/delete, and transaction oncomplete. Request callbacks
 * fire on microtasks; the transaction tracks pending requests so oncomplete
 * fires only after all of them settle — mirroring real IDB semantics closely
 * enough to exercise the cache logic deterministically.
 */
function makeIdbStub() {
  const stores = new Map<string, Map<string, unknown>>()

  function makeStore(m: Map<string, unknown>, tx: { _dec(): void; _inc(): void }) {
    const wrap = (fn: () => unknown) => {
      tx._inc()
      const req: any = { result: undefined, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        try {
          req.result = fn()
        } catch (e) {
          req.error = e
          if (req.onerror) req.onerror()
        }
        if (req.onsuccess) req.onsuccess()
        tx._dec()
      })
      return req
    }
    return {
      get: (key: string) => wrap(() => m.get(key)),
      put: (value: any) => wrap(() => void m.set(value.roomId, value)),
      getAll: () => wrap(() => [...m.values()]),
      delete: (key: string) => wrap(() => void m.delete(key)),
      clear: () => wrap(() => void m.clear()),
    }
  }

  function makeTx(m: Map<string, unknown>) {
    let pending = 0
    let completed = false
    const tx: any = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => makeStore(m, tx),
    }
    tx._inc = () => {
      pending++
    }
    tx._dec = () => {
      pending--
      if (pending === 0 && !completed) {
        completed = true
        queueMicrotask(() => {
          if (tx.oncomplete) tx.oncomplete()
        })
      }
    }
    return tx
  }

  const factory: any = {
    open: (_name: string, _version: number) => {
      const req: any = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null }
      queueMicrotask(() => {
        const db: any = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore: (s: string) => {
            const m = new Map<string, unknown>()
            stores.set(s, m)
            return makeStore(m, makeTx(m))
          },
          transaction: (s: string) => makeTx(stores.get(s)!),
          close: () => {},
        }
        req.result = db
        if (!stores.has('rooms') && req.onupgradeneeded) req.onupgradeneeded()
        if (req.onsuccess) req.onsuccess()
      })
      return req
    },
  }
  return factory as unknown as IDBFactory
}

function sample(over: Partial<CachedMsg> = {}): CachedMsg {
  return { type: 'msg', name: 'bob', uid: 'u1', time: 't', rawTs: 1, msg: 'hi', ...over }
}

describe('history-cache — save/load round-trip', () => {
  test('saved messages can be read back identically', async () => {
    const idb = makeIdbStub()
    const msgs = [sample({ rawTs: 1, msg: 'a' }), sample({ rawTs: 2, msg: 'b' })]
    await saveHistoryCache('roomA', msgs, idb)
    const out = await loadHistoryCache('roomA', idb)
    expect(out).toHaveLength(2)
    expect(out[0].msg).toBe('a')
    expect(out[1].msg).toBe('b')
  })

  test('empty cache returns []', async () => {
    const idb = makeIdbStub()
    expect(await loadHistoryCache('nope', idb)).toEqual([])
  })
})

describe('history-cache — per-room 200 cap', () => {
  test('over 200 messages are truncated, keeping the newest', async () => {
    const idb = makeIdbStub()
    const msgs: CachedMsg[] = []
    for (let i = 1; i <= 250; i++) msgs.push(sample({ rawTs: i, msg: `m${i}` }))
    await saveHistoryCache('roomBig', msgs, idb)
    const out = await loadHistoryCache('roomBig', idb)
    expect(out).toHaveLength(200)
    // Newest 200 kept: rawTs 51..250
    expect(out[0].rawTs).toBe(51)
    expect(out[out.length - 1].rawTs).toBe(250)
  })
})

describe('history-cache — 10-room LRU cap', () => {
  test('the oldest room (by ts) is evicted past 10 rooms', async () => {
    const idb = makeIdbStub()
    // Deterministic timestamps so LRU ordering is predictable.
    const realNow = Date.now
    let now = 1000
    Date.now = () => (now += 1)
    try {
      for (let i = 0; i < 11; i++) {
        await saveHistoryCache(`room${i}`, [sample({ rawTs: i + 1 })], idb)
      }
    } finally {
      Date.now = realNow
    }
    // room0 (oldest ts) should have been evicted; room10 (newest) survives.
    expect(await loadHistoryCache('room0', idb)).toEqual([])
    expect((await loadHistoryCache('room10', idb)).length).toBe(1)
    // Exactly 10 rooms remain.
    let total = 0
    for (let i = 0; i < 11; i++) {
      if ((await loadHistoryCache(`room${i}`, idb)).length > 0) total++
    }
    expect(total).toBe(10)
  })
})

describe('history-cache — resilience', () => {
  test('factory.open throwing → load returns [] and save is silent', async () => {
    const broken = {
      open: () => {
        throw new Error('no idb')
      },
    } as unknown as IDBFactory
    expect(await loadHistoryCache('x', broken)).toEqual([])
    // save must not throw
    await expect(saveHistoryCache('x', [sample()], broken)).resolves.toBeUndefined()
  })

  test('factory missing open → load returns []', async () => {
    const missing = {} as unknown as IDBFactory
    expect(await loadHistoryCache('x', missing)).toEqual([])
  })

  test('save with a put that throws is silent (no rejection)', async () => {
    // A factory whose transaction store.put throws synchronously.
    const throwingFactory: any = {
      open: (_n: string, _v: number) => {
        const req: any = { result: null, onsuccess: null, onupgradeneeded: null }
        queueMicrotask(() => {
          const db: any = {
            objectStoreNames: { contains: () => false },
            createObjectStore: () => ({}),
            transaction: () => {
              const tx: any = { oncomplete: null, objectStore: () => ({
                get: () => ({ result: undefined, onsuccess: null }),
                getAll: () => ({ result: [], onsuccess: null }),
                put: () => { throw new Error('put fails') },
                delete: () => ({}),
              }) }
              queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete() })
              return tx
            },
            close: () => {},
          }
          req.result = db
          if (req.onupgradeneeded) req.onupgradeneeded()
          if (req.onsuccess) req.onsuccess()
        })
        return req
      },
    }
    await expect(
      saveHistoryCache('x', [sample()], throwingFactory as unknown as IDBFactory),
    ).resolves.toBeUndefined()
  })
})

describe('history-cache — clearHistoryCache', () => {
  test('clears all rooms from the store', async () => {
    const idb = makeIdbStub()
    await saveHistoryCache('room1', [sample({ rawTs: 1 })], idb)
    await saveHistoryCache('room2', [sample({ rawTs: 2 })], idb)
    expect((await loadHistoryCache('room1', idb)).length).toBe(1)
    expect((await loadHistoryCache('room2', idb)).length).toBe(1)

    await clearHistoryCache(idb)

    expect(await loadHistoryCache('room1', idb)).toEqual([])
    expect(await loadHistoryCache('room2', idb)).toEqual([])
  })

  test('does not throw when the database does not exist', async () => {
    const fresh = makeIdbStub()
    await expect(clearHistoryCache(fresh)).resolves.toBeUndefined()
  })

  test('does not throw when factory is broken', async () => {
    const broken = {
      open: () => {
        throw new Error('no idb')
      },
    } as unknown as IDBFactory
    await expect(clearHistoryCache(broken)).resolves.toBeUndefined()
  })
})
