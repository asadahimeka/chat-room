import { readFileSync } from 'node:fs'

export interface UploadConfig {
  region: string
  bucket: string
  endpoint: string
  publicUrl: string
  dailyQuotaPerIp: number
  maxBytes: number
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
      }
    | undefined
  const upload: UploadConfig = {
    region: typeof yamlUpload?.region === 'string' ? yamlUpload.region : DEFAULT_UPLOAD.region,
    bucket: typeof yamlUpload?.bucket === 'string' ? yamlUpload.bucket : DEFAULT_UPLOAD.bucket,
    endpoint: typeof yamlUpload?.endpoint === 'string' ? yamlUpload.endpoint : DEFAULT_UPLOAD.endpoint,
    publicUrl: typeof yamlUpload?.publicUrl === 'string' ? yamlUpload.publicUrl : DEFAULT_UPLOAD.publicUrl,
    dailyQuotaPerIp:
      typeof yamlUpload?.dailyQuotaPerIp === 'number'
        ? yamlUpload.dailyQuotaPerIp
        : DEFAULT_UPLOAD.dailyQuotaPerIp,
    maxBytes: typeof yamlUpload?.maxBytes === 'number' ? yamlUpload.maxBytes : DEFAULT_UPLOAD.maxBytes,
  }

  const emoji = Array.isArray(yaml?.emoji) ? yaml.emoji : []

  const trustCloudflare =
    parseBool(env.TRUST_CLOUDFLARE) ?? parseBool(yaml?.trustCloudflare) ?? false

  return { port, dbPath, emoji, upload, trustCloudflare }
}

export const config: Config = loadConfig(process.env)