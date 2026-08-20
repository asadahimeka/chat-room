import { Elysia } from 'elysia'
import { config } from './config'
import { miscRouter } from './router/misc'
import { roomRouter } from './router/room'
import { RoomState } from './ws/room-state'
import { registerWs } from './ws/handler'

const roomState = new RoomState()

async function resolveStatic(rel: string): Promise<Bun.BunFile | null> {
  for (const base of ['./static', './assets']) {
    const file = Bun.file(`${base}/${rel}`)
    if (await file.exists()) return file
  }
  return null
}

export const app = registerWs(new Elysia(), roomState)
  .use(miscRouter)
  .group('/room', (g) => g.use(roomRouter))
  .get('/favicon.png', async () => {
    const file = await resolveStatic('favicon.png')
    return file ? new Response(file) : new Response('Not Found', { status: 404 })
  })
  .get('/notify.mp3', async () => {
    const file = await resolveStatic('notify.mp3')
    return file ? new Response(file) : new Response('Not Found', { status: 404 })
  })
  .get('/static/*', async ({ params }) => {
    const rel = (params as { '*': string })['*']
    const file = await resolveStatic(rel)
    return file ? new Response(file) : new Response('Not Found', { status: 404 })
  })

setInterval(() => {
  console.log('room list:', JSON.stringify(roomState.listAll()))
}, 30_000)

if (import.meta.main) {
  app.listen(config.port)
  console.log(`server listening on port ${config.port}`)
}
