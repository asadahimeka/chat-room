/**
 * Service Worker — emoji image cache (cache-first).
 *
 * Hand-written native JS served from the site root so it can control /room/*
 * pages (the static dir is only mounted under /static/*). It intercepts only
 * emoji image requests (GET + https + destination 'image' + URL starts with one
 * of the registered emoji base prefixes) and serves them cache-first, falling
 * back to the network. Every path is wrapped so a failure never breaks a normal
 * request.
 *
 * The prefix-matching semantics mirror src/utils/emoji.ts `isEmojiImageUrl`
 * (https check + startsWith any prefix). This file cannot import TS, so the
 * logic is repeated here on purpose.
 */

const CACHE = 'emoji-img-v1'
const MAX_ENTRIES = 2000

// Module-level list of emoji base URLs, populated via postMessage from the page.
let prefixes = []

self.addEventListener('install', (event) => {
  try {
    event.waitUntil(self.skipWaiting())
  } catch {
    // ignore
  }
})

self.addEventListener('activate', (event) => {
  try {
    event.waitUntil(
      (async () => {
        try {
          const names = await caches.keys()
          await Promise.all(
            names.map((n) => (n !== CACHE ? caches.delete(n) : Promise.resolve())),
          )
        } catch {
          // best-effort cleanup
        }
        await self.clients.claim()
      })(),
    )
  } catch {
    // ignore
  }
})

self.addEventListener('message', (event) => {
  try {
    const data = event.data
    if (data && data.type === 'emoji-prefixes' && Array.isArray(data.prefixes)) {
      prefixes = data.prefixes.filter((p) => typeof p === 'string')
    }
  } catch {
    // ignore malformed messages
  }
})

// Evict the oldest entries (Cache API keys are insertion-ordered) when over cap.
async function enforceLimit(cache) {
  try {
    const keys = await cache.keys()
    if (keys.length > MAX_ENTRIES) {
      const excess = keys.length - MAX_ENTRIES
      for (let i = 0; i < excess; i++) {
        try {
          await cache.delete(keys[i])
        } catch {
          // ignore individual delete failures
        }
      }
    }
  } catch {
    // ignore
  }
}

async function handle(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone())
    } catch {
      // quota / serialization failure — skip caching, still return response
    }
    await enforceLimit(cache)
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  // Synchronous guard: only intercept emoji image requests. Anything else is
  // left to the browser untouched (we must not call respondWith for it).
  try {
    if (req.method !== 'GET') return
    const url = req.url
    if (typeof url !== 'string' || !url.startsWith('https://')) return
    if (req.destination !== 'image') return
    if (!Array.isArray(prefixes) || prefixes.length === 0) return
    if (!prefixes.some((p) => typeof p === 'string' && url.startsWith(p))) return
  } catch {
    return
  }
  try {
    event.respondWith(handle(req))
  } catch {
    // if respondWith throws, leave the request alone
  }
})
