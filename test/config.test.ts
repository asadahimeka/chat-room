import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'

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
    })
  })

  test('partial upload YAML falls back per-field to defaults', () => {
    const file = writeTempYaml('upload:\n  bucket: only-bucket\n')
    const config = loadConfig({}, file)
    expect(config.upload.bucket).toBe('only-bucket')
    expect(config.upload.region).toBe('us-east-1')
    expect(config.upload.maxBytes).toBe(5242880)
  })
})