import { describe, expect, it } from 'bun:test'
import { RoomState } from '../src/ws/room-state'

describe('RoomState in-memory room/user registry', () => {
  it('join new user → isNew true, list length 1', () => {
    const rs = new RoomState()
    const { user, isNew } = rs.join('r1', 's1', 'u1', 'Alice')
    expect(isNew).toBe(true)
    expect(user).toMatchObject({ uid: 'u1', name: 'Alice', session: ['s1'] })
    expect(rs.list('r1')).toHaveLength(1)
  })

  it('join same uid second session → isNew false, list length STILL 1 (multi-session)', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    const { user, isNew } = rs.join('r1', 's2', 'u1', 'Alice')
    expect(isNew).toBe(false)
    expect(user.session).toEqual(['s1', 's2'])
    expect(rs.list('r1')).toHaveLength(1)
  })

  it('leave one of two sessions → user still in list (length 1)', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    rs.join('r1', 's2', 'u1', 'Alice')
    const removed = rs.leave('r1', 's1', 'u1')
    expect(removed).toBeNull()
    expect(rs.list('r1')).toHaveLength(1)
    expect(rs.list('r1')[0]).toEqual({ uid: 'u1', name: 'Alice' })
  })

  it('leave last session → user removed (list length 0), returns the removed user', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    const removed = rs.leave('r1', 's1', 'u1')
    expect(removed).toMatchObject({ uid: 'u1', name: 'Alice', session: [] })
    expect(rs.list('r1')).toHaveLength(0)
  })

  it('rename updates name in list', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    rs.rename('r1', 'u1', 'Bob')
    expect(rs.list('r1')[0]).toEqual({ uid: 'u1', name: 'Bob' })
  })

  it('removeRoomIfEmpty removes empty room from map', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    rs.leave('r1', 's1', 'u1')
    expect(rs.removeRoomIfEmpty('r1')).toBe(true)
    expect(rs.list('r1')).toHaveLength(0)
    // non-empty room is not removed
    rs.join('r2', 's1', 'u1', 'Alice')
    expect(rs.removeRoomIfEmpty('r2')).toBe(false)
  })

  it('two different rooms are isolated', () => {
    const rs = new RoomState()
    rs.join('r1', 's1', 'u1', 'Alice')
    rs.join('r2', 's2', 'u2', 'Bob')
    expect(rs.list('r1')).toHaveLength(1)
    expect(rs.list('r2')).toHaveLength(1)
    expect(rs.list('r1')[0]).toEqual({ uid: 'u1', name: 'Alice' })
    expect(rs.list('r2')[0]).toEqual({ uid: 'u2', name: 'Bob' })
    // leaving r1 does not affect r2
    rs.leave('r1', 's1', 'u1')
    expect(rs.list('r2')).toHaveLength(1)
  })
})
