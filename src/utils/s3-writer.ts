import { config } from '../config'
import type { UploadConfig } from '../config'

/**
 * Builds the public URL for a stored object. `publicUrl` wins when set
 * (CDN), otherwise falls back to `${endpoint}/${bucket}/${key}` — identical to
 * the legacy `Bun.s3` fallback in src/router/upload.ts so behavior is stable.
 */
export function buildPublicUrl(upload: UploadConfig, key: string): string {
  return upload.publicUrl
    ? `${upload.publicUrl}/${key}`
    : `${upload.endpoint}/${upload.bucket}/${key}`
}

/**
 * Creates an S3 writer bound to the `config.upload` bucket/region/endpoint.
 *
 * Credentials are read from the environment ONLY (never from config.yml):
 *   accessKeyId     = S3_ACCESS_KEY_ID     ?? AWS_ACCESS_KEY_ID
 *   secretAccessKey = S3_SECRET_ACCESS_KEY ?? AWS_SECRET_ACCESS_KEY
 *
 * If either credential is missing, returns `null` so callers keep their
 * existing fallback (local dev / tests without S3 stay unchanged).
 *
 * The returned writer writes via `Bun.S3Client` (constructed from the yml
 * bucket/region/endpoint) and returns the public URL. Construction performs no
 * network I/O.
 */
export function createS3WriterFromConfig(
  env: Record<string, string | undefined>,
  upload: UploadConfig = config.upload,
): ((key: string, body: Uint8Array) => Promise<string>) | null {
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) return null

  const client = new Bun.S3Client({
    bucket: upload.bucket,
    region: upload.region,
    endpoint: upload.endpoint || undefined,
    accessKeyId,
    secretAccessKey,
  })

  return async (key: string, body: Uint8Array): Promise<string> => {
    await client.file(key).write(body)
    return buildPublicUrl(upload, key)
  }
}
