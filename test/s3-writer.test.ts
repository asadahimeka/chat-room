import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { createS3WriterFromConfig, buildPublicUrl } from '../src/utils/s3-writer.ts'
import type { UploadConfig } from '../src/config.ts'

const TEST_UPLOAD: UploadConfig = {
  region: 'eu-west-1',
  bucket: 'my-bucket',
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  publicUrl: '',
  dailyQuotaPerIp: 50,
  maxBytes: 5242880,
  inputMaxBytes: 26214400,
  compressQuality: 50,
  compressEffort: 4,
  maxDimension: 2048,
  compressTimeoutMs: 30000,
}

// --- Mock Bun.S3Client so the writer's write path needs no network. ---
interface MockCall {
  opts: Record<string, unknown>
  key: string
  body: Uint8Array
}
let calls: MockCall[] = []
let savedS3Client: unknown

class MockS3Client {
  opts: Record<string, unknown>
  constructor(opts: Record<string, unknown>) {
    this.opts = opts
  }
  file(key: string) {
    return {
      write: async (body: Uint8Array) => {
        calls.push({ opts: this.opts, key, body })
      },
    }
  }
}

beforeEach(() => {
  calls = []
  savedS3Client = (Bun as unknown as { S3Client: unknown }).S3Client
  ;(Bun as unknown as { S3Client: unknown }).S3Client = MockS3Client
})

afterEach(() => {
  ;(Bun as unknown as { S3Client: unknown }).S3Client = savedS3Client
})

describe('buildPublicUrl', () => {
  test('publicUrl wins when set', () => {
    const upload = { ...TEST_UPLOAD, publicUrl: 'https://cdn.example.com' }
    expect(buildPublicUrl(upload, 'uploads/x.avif')).toBe(
      'https://cdn.example.com/uploads/x.avif',
    )
  })

  test('falls back to endpoint/bucket when no publicUrl', () => {
    expect(buildPublicUrl(TEST_UPLOAD, 'uploads/x.avif')).toBe(
      'https://s3.eu-west-1.amazonaws.com/my-bucket/uploads/x.avif',
    )
  })
})

describe('createS3WriterFromConfig — credential gating', () => {
  test('no credentials → null', () => {
    expect(createS3WriterFromConfig({}, TEST_UPLOAD)).toBeNull()
  })

  test('only access key → null (secret required)', () => {
    expect(
      createS3WriterFromConfig({ S3_ACCESS_KEY_ID: 'a' }, TEST_UPLOAD),
    ).toBeNull()
  })

  test('S3_* credentials → non-null writer', () => {
    const w = createS3WriterFromConfig(
      { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' },
      TEST_UPLOAD,
    )
    expect(w).not.toBeNull()
    expect(typeof w).toBe('function')
  })

  test('AWS_* fallback credentials → non-null writer', () => {
    const w = createS3WriterFromConfig(
      { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' },
      TEST_UPLOAD,
    )
    expect(w).not.toBeNull()
  })

  test('empty-string credentials treated as missing → null', () => {
    expect(
      createS3WriterFromConfig(
        { S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' },
        TEST_UPLOAD,
      ),
    ).toBeNull()
  })
})

describe('createS3WriterFromConfig — writer behavior', () => {
  test('constructs client with config bucket/region/endpoint and returns publicUrl URL', async () => {
    const upload = { ...TEST_UPLOAD, publicUrl: 'https://cdn.example.com' }
    const writer = createS3WriterFromConfig(
      { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' },
      upload,
    )!
    const url = await writer('uploads/abc.avif', new Uint8Array([1, 2, 3]))
    expect(url).toBe('https://cdn.example.com/uploads/abc.avif')
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.bucket).toBe('my-bucket')
    expect(calls[0].opts.region).toBe('eu-west-1')
    expect(calls[0].opts.endpoint).toBe('https://s3.eu-west-1.amazonaws.com')
    expect(calls[0].key).toBe('uploads/abc.avif')
    expect(calls[0].body).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('no publicUrl → endpoint/bucket URL', async () => {
    const writer = createS3WriterFromConfig(
      { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' },
      TEST_UPLOAD,
    )!
    const url = await writer('uploads/abc.avif', new Uint8Array([9]))
    expect(url).toBe(
      'https://s3.eu-west-1.amazonaws.com/my-bucket/uploads/abc.avif',
    )
  })

  test('empty endpoint passed as undefined to client', async () => {
    const upload = { ...TEST_UPLOAD, endpoint: '', publicUrl: 'https://cdn.example.com' }
    const writer = createS3WriterFromConfig(
      { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' },
      upload,
    )!
    await writer('uploads/x.avif', new Uint8Array([1]))
    expect(calls[0].opts.endpoint).toBeUndefined()
  })
})
