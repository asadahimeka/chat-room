import { readFileSync } from 'node:fs'

export interface UploadConfig {
  region: string
  bucket: string
  endpoint: string
  publicUrl: string
  dailyQuotaPerIp: number
  maxBytes: number
  /** Raw input byte ceiling before compression (default 25MB). */
  inputMaxBytes: number
  /** AVIF/WebP encode quality (0-100). */
  compressQuality: number
  /** AVIF encode effort (higher = slower). */
  compressEffort: number
  /** Longest edge (px) the image is resized to fit inside before encoding. */
  maxDimension: number
  /** Per-request hard timeout (ms) for the compression worker. */
  compressTimeoutMs: number
}

export interface Config {
  port: number
  dbPath: string
  emoji: unknown[]
  upload: UploadConfig
  /** Trust `cf-connecting-ip` as the real client IP. Default false (untrusted). */
  trustCloudflare: boolean
}

const DEFAULT_PORT = 3000
const DEFAULT_DB_PATH = './db/msg.db'
const DEFAULT_UPLOAD: UploadConfig = {
  region: 'us-east-1',
  bucket: 'chat-room',
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  publicUrl: '',
  dailyQuotaPerIp: 50,
  maxBytes: 5242880,
  inputMaxBytes: 26214400,
  compressQuality: 50,
  compressEffort: 4,
  maxDimension: 2048,
  compressTimeoutMs: 30000,
}

// Only a positive integer is a valid port; everything else → undefined.
// Env values arrive as strings (regex-checked); YAML values arrive as numbers.
const PORT_RE = /^[1-9]\d*$/

// Accepts boolean or the string forms 'true'/'1' (true) and 'false'/'0' (false).
// Anything else (including undefined) → undefined so the next source down wins.
function parseBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return undefined
  const t = raw.trim().toLowerCase()
  if (t === 'true' || t === '1') return true
  if (t === 'false' || t === '0') return false
  return undefined
}

function parsePort(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : undefined
  }
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!PORT_RE.test(trimmed)) return undefined
  return Number(trimmed)
}

// Accepts a number or a numeric string (Bun.YAML.parse may return either for
// the same field). Anything non-finite → undefined so the next source down wins.
function parseNum(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

// Sync on purpose: loadConfig is called from a lazy Proxy getter in
// src/db/index.ts and at module top level in src/index.ts. Making it async
// would force call-site changes; node:fs readFileSync keeps it sync with
// zero call-site churn. Bun.YAML.parse does the actual YAML parsing.
function readYaml(yamlPath: string): Record<string, unknown> | null {
  try {
    const parsed = Bun.YAML.parse(readFileSync(yamlPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[config] ${yamlPath}: not a YAML mapping, using defaults`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    console.warn(`[config] failed to read ${yamlPath}: ${(err as Error).message ?? err}`)
    return null
  }
}

export function loadConfig(
  env: Record<string, string | undefined>,
  yamlPath = './config.yml',
): Config {
  const yaml = readYaml(yamlPath)

  // Priority env > YAML > default; port validity is checked on whichever
  // source wins, invalid → next source down.
  const port = parsePort(env.PORT) ?? parsePort(yaml?.port) ?? DEFAULT_PORT

  const yamlDbPath = yaml?.dbPath
  const dbPath =
    env.DB_PATH ??
    (typeof yamlDbPath === 'string' ? yamlDbPath : undefined) ??
    DEFAULT_DB_PATH

  const yamlUpload = yaml?.upload as
    | {
        region?: unknown
        bucket?: unknown
        endpoint?: unknown
        publicUrl?: unknown
        dailyQuotaPerIp?: unknown
        maxBytes?: unknown
        inputMaxBytes?: unknown
        compressQuality?: unknown
        compressEffort?: unknown
        maxDimension?: unknown
        compressTimeoutMs?: unknown
      }
    | undefined
  const upload: UploadConfig = {
    region: typeof yamlUpload?.region === 'string' ? yamlUpload.region : DEFAULT_UPLOAD.region,
    bucket: typeof yamlUpload?.bucket === 'string' ? yamlUpload.bucket : DEFAULT_UPLOAD.bucket,
    endpoint: typeof yamlUpload?.endpoint === 'string' ? yamlUpload.endpoint : DEFAULT_UPLOAD.endpoint,
    publicUrl: typeof yamlUpload?.publicUrl === 'string' ? yamlUpload.publicUrl : DEFAULT_UPLOAD.publicUrl,
    dailyQuotaPerIp:
      parseNum(yamlUpload?.dailyQuotaPerIp) ?? DEFAULT_UPLOAD.dailyQuotaPerIp,
    maxBytes: parseNum(yamlUpload?.maxBytes) ?? DEFAULT_UPLOAD.maxBytes,
    inputMaxBytes: parseNum(yamlUpload?.inputMaxBytes) ?? DEFAULT_UPLOAD.inputMaxBytes,
    compressQuality: parseNum(yamlUpload?.compressQuality) ?? DEFAULT_UPLOAD.compressQuality,
    compressEffort: parseNum(yamlUpload?.compressEffort) ?? DEFAULT_UPLOAD.compressEffort,
    maxDimension: parseNum(yamlUpload?.maxDimension) ?? DEFAULT_UPLOAD.maxDimension,
    compressTimeoutMs: parseNum(yamlUpload?.compressTimeoutMs) ?? DEFAULT_UPLOAD.compressTimeoutMs,
  }

  const emoji = Array.isArray(yaml?.emoji) ? yaml.emoji : []

  const trustCloudflare =
    parseBool(env.TRUST_CLOUDFLARE) ?? parseBool(yaml?.trustCloudflare) ?? false

  return { port, dbPath, emoji, upload, trustCloudflare }
}

export const config: Config = loadConfig(process.env)

/**
 * Origin (scheme://host[:port]) of the upload storage host, used by the client
 * to decide the image `referrerPolicy`. Derived from `publicUrl` when set,
 * otherwise the S3 `endpoint`. Returns '' when neither is a parseable URL.
 */
export function uploadOrigin(upload: UploadConfig = config.upload): string {
  const raw = upload.publicUrl || upload.endpoint
  if (!raw) return ''
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}