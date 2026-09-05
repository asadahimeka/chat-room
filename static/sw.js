/**
 * Service Worker — two-namespace cache-first.
 *
 *  - `emoji-img-v2`: cross-origin emoji images ONLY (opaque no-cors, 2000-entry
 *    cap with oldest-first eviction). Emoji churn can never evict site assets.
 *  - `static-v1`: same-origin immutable assets ONLY — the hashed app-shell
 *    JS/CSS plus the vendored emoji manifest JSON. Exact-URL sets, no eviction
 *    (a handful of entries, all content-hashed).
 *
 * Hand-written native JS served from the site root so it can control /room/*
 * pages (the static dir is only mounted under /static/*). Every path is
 * wrapped so a failure never breaks a normal request.
 *
 * The prefix-matching semantics mirror src/utils/emoji.ts `isEmojiImageUrl`
 * (https check + startsWith any prefix). This file cannot import TS, so the
 * logic is repeated here on purpose.
 */

const CACHE = 'emoji-img-v2'
const MAX_ENTRIES = 2000

// Same-origin static namespace (hashed app-shell JS/CSS + vendored emoji
// manifest JSON, built via `bun run vendor-emoji`). Exact-URL sets, NOT prefix
// matching — a handful of content-hashed files, so no eviction is needed.
const STATIC_CACHE = 'static-v1'
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
              n !== CACHE && n !== STATIC_CACHE ? caches.delete(n) : Promise.resolve(),
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

// Same-origin static handler: cache-first under STATIC_CACHE.
// Unlike emoji images (opaque no-cors), same-origin assets always have
// ok responses, so only those are cached; no entry-count enforcement
// (a handful of content-hashed files).
async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE)
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
    // Same-origin static assets (hashed app-shell JS/CSS + vendored emoji
    // manifest JSON): exact-URL match into the STATIC_CACHE namespace.
    // The manifest is destination '' so it never reaches the image guard
    // below — intercept both here, before the emoji-image branch.
    if (appShell.has(url) || manifestUrls.has(url)) {
      event.respondWith(handleStatic(req))
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
