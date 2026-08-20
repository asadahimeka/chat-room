import { Elysia } from 'elysia'
import { processInput } from '../utils/input'

export const miscRouter = new Elysia()
  .get('/', () =>
    new Response(null, { status: 302, headers: { Location: '/room/@demo' } }),
  )
  .get('/filter', ({ query }) =>
    new Response(processInput(query.q ?? ''), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  )
  .get('/heart-beat', () =>
    new Response('alive', {
      headers: { 'cache-control': 'max-age=0, no-cache, no-store, must-revalidate' },
    }),
  )
