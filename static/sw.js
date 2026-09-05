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

const CACHE = 'emoji-img-v2'
const MAX_ENTRIES = 2000

// Vendored emoji manifest cache (same-origin JSON, built via
// `bun run vendor-emoji`). Exact-URL set, NOT prefix matching — the manifest
// is a single hashed file, so one entry is enough.
const MANIFEST_CACHE = 'emoji-manifest-v1'
let manifestUrls = new Set()

// Module-level list of emoji base URLs, populated via postMessage from the page.
let prefixes = []

// Module-level set of app-shell asset URLs (hashed JS/CSS) to also cache-first.
let appShell = new Set()

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
            names.map((n) =>
              n !== CACHE && n !== MANIFEST_CACHE ? caches.delete(n) : Promise.resolve(),
            ),
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
    } else if (data && data.type === 'emoji-manifest' && Array.isArray(data.urls)) {
      for (const u of data.urls) {
        if (typeof u === 'string') manifestUrls.add(u)
      }
    } else if (data && data.type === 'app-shell' && Array.isArray(data.urls)) {
      for (const u of data.urls) {
        if (typeof u === 'string') appShell.add(u)
      }
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
  // Cross-origin <img> requests are no-cors → opaque responses have
  // status 0 and ok === false, but they ARE cacheable. Accept both.
  if (response && (response.ok || response.type === 'opaque')) {
    try {
      await cache.put(request, response.clone())
    } catch {
      // quota / serialization failure — skip caching, still return response
    }
    await enforceLimit(cache)
  }
  return response
}

// Same-origin manifest JSON handler: cache-first under MANIFEST_CACHE.
// Unlike emoji images (opaque no-cors), the manifest is same-origin so only
// ok responses are cached; no entry-count enforcement (single file).
async function handleManifest(request) {
  const cache = await caches.open(MANIFEST_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone())
    } catch {
      // quota / serialization failure — skip caching, still return response
    }
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
    if (typeof url !== 'string') return
    // App-shell assets (hashed JS/CSS) are cache-first too — first hit warms the
    // cache via the normal network path, subsequent loads are served offline.
    if (appShell.has(url)) {
      event.respondWith(handle(req))
      return
    }
    // Vendored emoji manifest: same-origin JSON, destination '' — it never
    // reaches the image guard below, so intercept by exact URL first.
    if (manifestUrls.has(url)) {
      event.respondWith(handleManifest(req))
      return
    }
    if (!url.startsWith('https://')) return
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
