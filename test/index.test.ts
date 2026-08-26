import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { app } from '../src/index.ts'
import { tmpDbPath } from './setup.ts'

// Point the lazy `db` proxy at a throwaway DB BEFORE the app is imported.
// The proxy only creates the underlying Database on first access, so this
// assignment (module top-level) is guaranteed to be in effect by the time any
// route touches the DB.
process.env.DB_PATH = tmpDbPath()

let baseUrl: string

beforeAll(() => {
  app.listen(0)
  baseUrl = `http://localhost:${app.server!.port}`
})

afterAll(() => {
  app.stop()
})

describe('app entry — routes + static + ws', () => {
  test('GET / redirects to /room/@demo with 302', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/room/@demo')
  })

  test('GET /heart-beat returns alive', async () => {
    const res = await fetch(`${baseUrl}/heart-beat`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('alive')
  })

  test('GET /favicon.ico returns 200 image/x-icon', async () => {
    const res = await fetch(`${baseUrl}/favicon.ico`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/x-icon')
  })

  test('GET /notify.mp3 returns 200 audio/mpeg', async () => {
    const res = await fetch(`${baseUrl}/notify.mp3`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
  })

  test('GET /static/css/room-*.css (or hashed build) returns 200 text/css', async () => {
    // The page references either the fixed dev name or a content-hashed build
    // output; resolve it from the rendered HTML so the test works in both modes.
    const page = await fetch(`${baseUrl}/room/@demo`)
    const html = await page.text()
    const m = html.match(/<link[^>]+href="(\/static\/css\/room[^"]*)"[^>]*>/)
    const cssUrl = m ? m[1] : '/static/css/room.css'
    const res = await fetch(`${baseUrl}${cssUrl}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  test('GET /static/js/room.client.js (or hashed build) returns 200 text/javascript', async () => {
    // The page references either the fixed dev name or a content-hashed build
    // output; resolve it from the rendered HTML so the test works in both modes.
    const page = await fetch(`${baseUrl}/room/@demo`)
    const html = await page.text()
    const m = html.match(
      /<script type="module" src="(\/static\/js\/room\.client[^"]*)"><\/script>/,
    )
    const jsUrl = m ? m[1] : '/static/js/room.client.js'
    const res = await fetch(`${baseUrl}${jsUrl}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
  })

  test('GET /nope returns 404', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  test('GET /room/@demo returns 200 text/html containing room-data', async () => {
    const res = await fetch(`${baseUrl}/room/@demo`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('room-data')
  })

  test('GET /room/@demo/record returns 200 JSON', async () => {
    const res = await fetch(`${baseUrl}/room/@demo/record`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  test('GET /room/@demo/svg returns 200 image/svg+xml', async () => {
    const res = await fetch(`${baseUrl}/room/@demo/svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })

  test('WS upgrade to /ws?roomId=test receives init event', async () => {
    const wsUrl = `ws://localhost:${app.server!.port}/ws?roomId=test&t=s1`
    const ws = new WebSocket(wsUrl, { headers: { cookie: 'name=Alice; uid=u1' } } as any)

    const init = await new Promise<{ type: string; data: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for init')), 5000)
      ws.onmessage = (ev) => {
        const parsed = JSON.parse(String(ev.data))
        if (parsed.type === 'init') {
          clearTimeout(timer)
          resolve(parsed)
        }
      }
      ws.onerror = (ev) => {
        clearTimeout(timer)
        reject(new Error(`ws error: ${String(ev)}`))
      }
    })

    expect(init.type).toBe('init')
    expect(init.data).toEqual({ uid: 'u1', name: 'Alice' })
    ws.close()
  })
})
