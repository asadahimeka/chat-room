import { Elysia } from 'elysia'
import { config } from './config'
import { miscRouter } from './router/misc'
import { roomRouter } from './router/room'
import { uploadRouter } from './router/upload'
import { RoomState } from './ws/room-state'
import { registerWs } from './ws/handler'

const roomState = new RoomState()

async function resolveStatic(rel: string): Promise<Response> {
  const file = Bun.file(`./static/${rel}`)
  if (await file.exists()) return new Response(file)
  return new Response('Not Found', { status: 404 })
}

export const app = registerWs(new Elysia(), roomState)
  .use(miscRouter)
  .use(uploadRouter)
  .group('/room', (g) => g.use(roomRouter))
  .get('/favicon.ico', async () => resolveStatic('favicon.ico'))
  .get('/notify.mp3', async () => resolveStatic('notify.mp3'))
  .get('/static/*', async ({ params }) => resolveStatic(params['*']))

setInterval(() => {
  console.log('room list:', JSON.stringify(roomState.listAll()))
}, 30_000)

if (import.meta.main) {
  app.listen(config.port)
  console.log(`server listening on port ${config.port}`)
}
