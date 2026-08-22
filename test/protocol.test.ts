import { describe, expect, test } from 'bun:test'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import {
  ClientEventSchema,
  ServerEventSchema,
  type ClientEvent,
  type ClientMessage,
  type JoinedUser,
  type MsgItem,
  type ServerEvent,
} from '../src/ws/protocol.ts'

const SERVER_EVENT_NAMES = ['init', 'online', 'sys', 'msg', 'rename'] as const
const CLIENT_EVENT_NAMES = ['message', 'change-name', 'leave'] as const

describe('protocol types', () => {
  test('JoinedUser has exactly uid and name', () => {
    const user: JoinedUser = { uid: 'u1', name: 'alice' }
    expect(user.uid).toBe('u1')
    expect(user.name).toBe('alice')
  })

  test('MsgItem carries all documented fields', () => {
    const item: MsgItem = {
      name: 'alice',
      room: 'demo',
      uid: 'u1',
      sid: 's1',
      ts: 1700000000,
      namecolor: '#fff',
      msgcolor: '#000',
      msg: 'hello',
    }
    expect(item.ts).toBe(1700000000)
    expect(item.msg).toBe('hello')
  })

  test('MsgItem carries optional meta', () => {
    const item: MsgItem = {
      name: 'alice',
      room: 'demo',
      uid: 'u1',
      sid: 's1',
      ts: 1700000000,
      namecolor: '#fff',
      msgcolor: '#000',
      msg: 'hello',
      meta: '{"bold":true}',
    }
    expect(item.meta).toBe('{"bold":true}')
  })

  test('ClientMessage has no sid/room/ts (server completes them)', () => {
    const payload: ClientMessage = {
      uid: 'u1',
      name: 'alice',
      msg: 'hello',
      namecolor: '#fff',
      msgcolor: '#000',
    }
    expect(payload).not.toHaveProperty('sid')
    expect(payload).not.toHaveProperty('room')
    expect(payload).not.toHaveProperty('ts')
  })

  test('ServerEvent is a discriminated union with exactly the documented event names', () => {
    const events: ServerEvent[] = [
      { type: 'init', data: { uid: 'u1', name: 'alice' } },
      { type: 'online', data: [{ uid: 'u1', name: 'alice' }] },
      { type: 'sys', data: 'welcome' },
      {
        type: 'msg',
        data: {
          name: 'alice',
          room: 'demo',
          uid: 'u1',
          sid: 's1',
          ts: 1700000000,
          namecolor: '#fff',
          msgcolor: '#000',
          msg: 'hello',
        },
      },
      { type: 'rename', data: { uid: 'u1', name: 'bob' } },
    ]
    expect(events.map((e) => e.type)).toEqual([...SERVER_EVENT_NAMES])
  })

  test('ClientEvent is a discriminated union with exactly the documented event names', () => {
    const events: ClientEvent[] = [
      { type: 'message', data: { uid: 'u1', name: 'alice', msg: 'hi', namecolor: '#fff', msgcolor: '#000' } },
      { type: 'change-name', data: 'bob' },
      { type: 'leave' },
    ]
    expect(events.map((e) => e.type)).toEqual([...CLIENT_EVENT_NAMES])
  })
})

describe('protocol schemas', () => {
  const serverCheck = TypeCompiler.Compile(ServerEventSchema)
  const clientCheck = TypeCompiler.Compile(ClientEventSchema)

  test('ServerEventSchema validates every server event variant', () => {
    const valid: unknown[] = [
      { type: 'init', data: { uid: 'u1', name: 'alice' } },
      { type: 'online', data: [{ uid: 'u1', name: 'alice' }] },
      { type: 'sys', data: 'welcome' },
      {
        type: 'msg',
        data: {
          name: 'alice',
          room: 'demo',
          uid: 'u1',
          sid: 's1',
          ts: 1700000000,
          namecolor: '#fff',
          msgcolor: '#000',
          msg: 'hello',
        },
      },
      { type: 'rename', data: { uid: 'u1', name: 'bob' } },
    ]
    for (const payload of valid) {
      expect(serverCheck.Check(payload)).toBe(true)
    }
  })

  test('ServerEventSchema rejects an unknown event type', () => {
    expect(serverCheck.Check({ type: 'nope', data: {} })).toBe(false)
  })

  test('ClientEventSchema validates a well-formed message payload', () => {
    const payload = {
      type: 'message',
      data: { uid: 'u1', name: 'alice', msg: 'hello', namecolor: '#fff', msgcolor: '#000' },
    }
    expect(clientCheck.Check(payload)).toBe(true)
  })

  test('ClientEventSchema accepts a message payload with valid meta', () => {
    const payload = {
      type: 'message',
      data: {
        uid: 'u1',
        name: 'alice',
        msg: 'hello',
        namecolor: '#fff',
        msgcolor: '#000',
        meta: '{"bold":true,"font":"serif"}',
      },
    }
    expect(clientCheck.Check(payload)).toBe(true)
  })

  test('ClientEventSchema accepts a message payload without meta (backward compat)', () => {
    const payload = {
      type: 'message',
      data: { uid: 'u1', name: 'alice', msg: 'hello', namecolor: '#fff', msgcolor: '#000' },
    }
    expect(clientCheck.Check(payload)).toBe(true)
  })

  test('ClientEventSchema validates change-name and leave', () => {
    expect(clientCheck.Check({ type: 'change-name', data: 'bob' })).toBe(true)
    expect(clientCheck.Check({ type: 'leave' })).toBe(true)
  })

  test('ClientEventSchema rejects a message missing required fields', () => {
    expect(clientCheck.Check({ type: 'message', data: { uid: 'u1' } })).toBe(false)
  })
})