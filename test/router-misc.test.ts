import { describe, expect, test } from 'bun:test'
import { miscRouter } from '../src/router/misc.ts'

describe('misc router', () => {
  test('GET / redirects to /room/@demo with 302', async () => {
    const res = await miscRouter.handle(new Request('http://localhost/'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/room/@demo')
  })

  test('GET /heart-beat returns alive with no-cache headers', async () => {
    const res = await miscRouter.handle(new Request('http://localhost/heart-beat'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('alive')
    expect(res.headers.get('cache-control')).toBe(
      'max-age=0, no-cache, no-store, must-revalidate',
    )
  })

  test('GET /filter?q=<banned word> replaces with ***', async () => {
    const res = await miscRouter.handle(new Request('http://localhost/filter?q=you%20bitch'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('you ***')
  })

  test('GET /filter with no q returns empty body', async () => {
    const res = await miscRouter.handle(new Request('http://localhost/filter'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  test('GET /filter?q=hello passes unfiltered word through', async () => {
    const res = await miscRouter.handle(new Request('http://localhost/filter?q=hello'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
  })
})
