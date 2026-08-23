import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, uploadOrigin } from '../src/config.ts'

const tempDirs: string[] = []

function writeTempYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-room-config-'))
  tempDirs.push(dir)
  const file = join(dir, 'config.yml')
  writeFileSync(file, content, 'utf8')
  return file
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const MISSING = './nonexistent-test.yml'

describe('loadConfig', () => {
  test('uses defaults when no env AND missing YAML file', () => {
    const config = loadConfig({}, MISSING)
    expect(config.port).toBe(3000)
    expect(config.dbPath).toBe('./db/msg.db')
    expect(config.emoji).toEqual([])
    expect(config.upload).toEqual({
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
    })
  })

  test('YAML values win over defaults', () => {
    const file = writeTempYaml('port: 4000\ndbPath: ./data/msg.db\n')
    const config = loadConfig({}, file)
    expect(config.port).toBe(4000)
    expect(config.dbPath).toBe('./data/msg.db')
  })

  test('env beats YAML', () => {
    const file = writeTempYaml('port: 3000\ndbPath: ./db/msg.db\n')
    const config = loadConfig({ PORT: '8080', DB_PATH: ':memory:' }, file)
    expect(config.port).toBe(8080)
    expect(config.dbPath).toBe(':memory:')
  })

  test('invalid PORT falls back correctly', () => {
    const file = writeTempYaml('port: 3000\n')
    for (const bad of ['abc', '0', '-1', '']) {
      expect(loadConfig({ PORT: bad }, file).port).toBe(3000)
    }
  })

  test('invalid env PORT falls back to YAML port', () => {
    const file = writeTempYaml('port: 4000\n')
    expect(loadConfig({ PORT: 'abc' }, file).port).toBe(4000)
  })

  test('falls back to 3000 when PORT is a non-integer', () => {
    expect(loadConfig({ PORT: '3000.5' }, MISSING).port).toBe(3000)
  })

  test('emoji array passthrough (strings and inline objects)', () => {
    const file = writeTempYaml(
      [
        'emoji:',
        '  - https://www.nanoka.top/images/stamp/GBC/',
        '  - name: GBC',
        '    icon: GBC_01',
        '    prefix: ""',
        '    type: png',
        '    items:',
        '      - hi',
        '      - bye',
      ].join('\n'),
    )
    const config = loadConfig({}, file)
    expect(config.emoji).toHaveLength(2)
    expect(config.emoji[0]).toBe('https://www.nanoka.top/images/stamp/GBC/')
    expect(config.emoji[1]).toEqual({
      name: 'GBC',
      icon: 'GBC_01',
      prefix: '',
      type: 'png',
      items: ['hi', 'bye'],
    })
  })

  test('upload fields parsed from YAML', () => {
    const file = writeTempYaml(
      [
        'upload:',
        '  region: ap-northeast-1',
        '  bucket: my-bucket',
        '  endpoint: https://s3.ap-northeast-1.amazonaws.com',
        '  publicUrl: https://cdn.example.com',
        '  dailyQuotaPerIp: 10',
        '  maxBytes: 1048576',
        '  inputMaxBytes: 12345678',
        '  compressQuality: 42',
        '  compressEffort: 6',
        '  maxDimension: 1024',
        '  compressTimeoutMs: 15000',
      ].join('\n'),
    )
    const config = loadConfig({}, file)
    expect(config.upload).toEqual({
      region: 'ap-northeast-1',
      bucket: 'my-bucket',
      endpoint: 'https://s3.ap-northeast-1.amazonaws.com',
      publicUrl: 'https://cdn.example.com',
      dailyQuotaPerIp: 10,
      maxBytes: 1048576,
      inputMaxBytes: 12345678,
      compressQuality: 42,
      compressEffort: 6,
      maxDimension: 1024,
      compressTimeoutMs: 15000,
    })
  })

  test('upload numeric fields accept string form (Bun.YAML.parse dual type)', () => {
    const file = writeTempYaml(
      [
        'upload:',
        '  maxBytes: "1048576"',
        '  inputMaxBytes: "12345678"',
        '  compressQuality: "42"',
        '  compressEffort: "6"',
        '  maxDimension: "1024"',
        '  compressTimeoutMs: "15000"',
      ].join('\n'),
    )
    const config = loadConfig({}, file)
    expect(config.upload.maxBytes).toBe(1048576)
    expect(config.upload.inputMaxBytes).toBe(12345678)
    expect(config.upload.compressQuality).toBe(42)
    expect(config.upload.compressEffort).toBe(6)
    expect(config.upload.maxDimension).toBe(1024)
    expect(config.upload.compressTimeoutMs).toBe(15000)
  })

  test('partial upload YAML falls back per-field to defaults', () => {
    const file = writeTempYaml('upload:\n  bucket: only-bucket\n')
    const config = loadConfig({}, file)
    expect(config.upload.bucket).toBe('only-bucket')
    expect(config.upload.region).toBe('us-east-1')
    expect(config.upload.maxBytes).toBe(5242880)
  })
})

describe('uploadOrigin', () => {
  test('derives origin from publicUrl when set', () => {
    expect(
      uploadOrigin({
        region: '',
        bucket: '',
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        publicUrl: 'https://cdn.example.com/images',
        dailyQuotaPerIp: 0,
        maxBytes: 0,
        inputMaxBytes: 0,
        compressQuality: 0,
        compressEffort: 0,
        maxDimension: 0,
        compressTimeoutMs: 0,
      }),
    ).toBe('https://cdn.example.com')
  })

  test('falls back to endpoint origin when publicUrl is empty', () => {
    expect(
      uploadOrigin({
        region: '',
        bucket: '',
        endpoint: 'https://s3.ap-northeast-1.amazonaws.com',
        publicUrl: '',
        dailyQuotaPerIp: 0,
        maxBytes: 0,
        inputMaxBytes: 0,
        compressQuality: 0,
        compressEffort: 0,
        maxDimension: 0,
        compressTimeoutMs: 0,
      }),
    ).toBe('https://s3.ap-northeast-1.amazonaws.com')
  })

  test('returns empty string when neither is a parseable URL', () => {
    expect(
      uploadOrigin({
        region: '',
        bucket: '',
        endpoint: '',
        publicUrl: '',
        dailyQuotaPerIp: 0,
        maxBytes: 0,
        inputMaxBytes: 0,
        compressQuality: 0,
        compressEffort: 0,
        maxDimension: 0,
        compressTimeoutMs: 0,
      }),
    ).toBe('')
  })
})