import { Elysia } from 'elysia'
import { config } from './config'
import { miscRouter } from './router/misc'
import { roomRouter } from './router/room'
import { createUploadRouter } from './router/upload'
import { createS3WriterFromConfig } from './utils/s3-writer'
import { RoomState } from './ws/room-state'
import { registerWs } from './ws/handler'

const roomState = new RoomState()

// Production upload router: trust flag from config; real peer IP resolved via
// the verified Bun server.requestIP (returns {address,...}). The closure reads
// app.server lazily so it is populated by the time a request arrives.
// S3 writer is built from config.yml's upload bucket/region/endpoint (creds
// from env only); when creds are absent it stays null and upload.ts keeps its
// legacy Bun.s3 fallback.
const s3Writer = createS3WriterFromConfig(process.env)
const uploadRouter = createUploadRouter({
  trustCloudflare: config.trustCloudflare,
  getRemoteAddress: (request) => app.server?.requestIP(request)?.address ?? null,
  ...(s3Writer ? { s3Writer } : {}),
})

async function resolveStatic(rel: string): Promise<Response> {
  const file = Bun.file(`./static/${rel}`)
  if (await file.exists()) {
    // Content-hashed assets (e.g. room.client-<hash>.js / room-<hash>.css) are
    // immutable: cache them for a year so repeat visits never revalidate.
    const headers: Record<string, string> = {}
    if (/-[0-9a-f]{8}\.(js|css)$/.test(rel)) {
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    }
    return new Response(file, { headers })
  }
  return new Response('Not Found', { status: 404 })
}

export const app = registerWs(new Elysia(), roomState)
  .use(miscRouter)
  .use(uploadRouter)
  .group('/room', (g) => g.use(roomRouter))
  .get('/favicon.ico', async () => resolveStatic('favicon.ico'))
  .get('/notify.mp3', async () => resolveStatic('notify.mp3'))
  .get('/sw.js', async () => {
    const file = Bun.file('./static/sw.js')
    return new Response(file, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'service-worker-allowed': '/',
        'cache-control': 'no-cache',
      },
    })
  })
  .get('/static/*', async ({ params }) => resolveStatic(params['*']))

setInterval(() => {
  const list = roomState.listAll()
  if (Object.keys(list).length === 0) return
  console.log(`[${new Date().toLocaleString('zh')}] room list: ${JSON.stringify(list)}`)
}, 30_000)

if (import.meta.main) {
  app.listen(config.port)
  console.log(`server listening on port ${config.port}`)
}
