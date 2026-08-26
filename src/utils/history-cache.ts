/**
 * Chat-history snapshot cache backed by IndexedDB (stale-while-revalidate).
 *
 * Pure logic + a thin IndexedDB wrapper. Every operation is wrapped so that a
 * missing/unavailable IndexedDB, an open failure, or a read/write error degrades
 * gracefully: `loadHistoryCache` returns `[]`, `saveHistoryCache` silently
 * no-ops. The `idbFactory` parameter defaults to the browser `indexedDB` but is
 * injectable so tests can supply an in-memory stub (no real IndexedDB in Bun).
 */

export interface CachedMsg {
  type: 'msg'
  name?: string
  uid?: string
  time?: string
  rawTs?: number
  msg: string
  namecolor?: string
  msgcolor?: string
  meta?: string
}

const DB_NAME = 'chatroom-history'
const DB_VERSION = 1
const STORE = 'rooms'
const MAX_MSGS_PER_ROOM = 200
const MAX_ROOMS = 10

interface HistoryRecord {
  roomId: string
  ts: number
  msgs: CachedMsg[]
}

/** Wraps an IDBRequest in a promise. */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Wraps a transaction's completion in a promise. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDB(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'roomId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Keeps at most MAX_MSGS_PER_ROOM of the newest messages (by rawTs, else order). */
function capMsgs(msgs: CachedMsg[]): CachedMsg[] {
  const valid = (msgs || []).filter((m) => m && m.type === 'msg')
  const sorted = [...valid].sort((a, b) => (a.rawTs ?? 0) - (b.rawTs ?? 0))
  return sorted.slice(-MAX_MSGS_PER_ROOM)
}

export async function loadHistoryCache(
  roomId: string,
  idbFactory: IDBFactory = indexedDB,
): Promise<CachedMsg[]> {
  try {
    if (!roomId || !idbFactory || typeof idbFactory.open !== 'function') return []
    const db = await openDB(idbFactory)
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const rec = await reqToPromise<HistoryRecord | undefined>(store.get(roomId))
    db.close()
    if (!rec || !Array.isArray(rec.msgs)) return []
    return rec.msgs.filter((m) => m && m.type === 'msg')
  } catch {
    return []
  }
}

export async function clearHistoryCache(
  idbFactory: IDBFactory = indexedDB,
): Promise<void> {
  try {
    if (!idbFactory || typeof idbFactory.open !== 'function') return
    const db = await openDB(idbFactory)
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.clear()
    await txDone(tx)
    db.close()
  } catch {
    // Best-effort: if the DB doesn't exist or clear fails, silently ignore.
  }
}

export async function saveHistoryCache(
  roomId: string,
  msgs: CachedMsg[],
  idbFactory: IDBFactory = indexedDB,
): Promise<void> {
  try {
    if (!roomId || !idbFactory || typeof idbFactory.open !== 'function') return
    const capped = capMsgs(msgs)
    if (capped.length === 0) return

    const db = await openDB(idbFactory)
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const record: HistoryRecord = { roomId, ts: Date.now(), msgs: capped }
    store.put(record)

    // Enforce the per-room cap is already applied; now enforce the room-count cap
    // (LRU by record ts) so we never grow unbounded across rooms.
    const all = await reqToPromise<HistoryRecord[]>(store.getAll())
    if (Array.isArray(all) && all.length > MAX_ROOMS) {
      const sorted = [...all].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
      const excess = sorted.length - MAX_ROOMS
      for (let i = 0; i < excess; i++) {
        store.delete(sorted[i].roomId)
      }
    }

    await txDone(tx)
    db.close()
  } catch {
    // Persistence is best-effort; never break the caller.
  }
}
