import type { JoinedUser } from './protocol'

export interface RoomUser {
  session: string[]
  uid: string
  name: string
}

export class RoomState {
  private rooms = new Map<string, RoomUser[]>()

  join(roomId: string, session: string, uid: string, name: string): { user: RoomUser; isNew: boolean } {
    const room = this.rooms.get(roomId) ?? []
    const existing = room.find(u => u.uid === uid)
    if (existing) {
      existing.session.push(session)
      return { user: existing, isNew: false }
    }
    const user: RoomUser = { session: [session], uid, name }
    room.push(user)
    this.rooms.set(roomId, room)
    return { user, isNew: true }
  }

  leave(roomId: string, session: string, uid: string): RoomUser | null {
    const room = this.rooms.get(roomId)
    if (!room) return null
    const index = room.findIndex(u => u.uid === uid)
    if (index === -1) return null
    const user = room[index]
    const sessionIndex = user.session.indexOf(session)
    if (sessionIndex !== -1) user.session.splice(sessionIndex, 1)
    if (user.session.length === 0) {
      room.splice(index, 1)
      return user
    }
    return null
  }

  rename(roomId: string, uid: string, newName: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    const user = room.find(u => u.uid === uid)
    if (user) user.name = newName
  }

  list(roomId: string): JoinedUser[] {
    const room = this.rooms.get(roomId)
    if (!room) return []
    return room.map(u => ({ uid: u.uid, name: u.name }))
  }

  listAll(): Record<string, JoinedUser[]> {
    const out: Record<string, JoinedUser[]> = {}
    for (const [roomId, users] of this.rooms) {
      out[roomId] = users.map(u => ({ uid: u.uid, name: u.name }))
    }
    return out
  }

  removeRoomIfEmpty(roomId: string): boolean {
    const room = this.rooms.get(roomId)
    if (room && room.length === 0) {
      this.rooms.delete(roomId)
      return true
    }
    return false
  }
}
