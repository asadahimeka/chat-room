import { t } from 'elysia'

/**
 * WebSocket wire protocol contract (Bun-native rewrite, parity with legacy socket.io 2.1.1).
 *
 * Event names are preserved 1:1 from the legacy implementation — do NOT rename.
 *
 * ── SERVER → CLIENT ─────────────────────────────────────────────
 *   init     → JoinedUser            (single user, on join)
 *   online   → JoinedUser[]          (all users in the room)
 *   sys      → string                (system message text)
 *   msg      → MsgItem               (a chat message)
 *   rename   → { uid, name }         (user renamed)
 *
 * ── CLIENT → SERVER ─────────────────────────────────────────────
 *   message     → ClientMessage      (via legacy socket.send; server fills sid/room/ts)
 *   change-name → string             (new name)
 *   leave       → (no payload)       (socket disconnects)
 *
 * Channel semantics: the server broadcasts to every socket in the same roomId.
 * The internal JoinedUser bookkeeping shape is { session: [sid], uid, name };
 * the PUBLIC shape sent over the wire is { uid, name } only.
 */

export type JoinedUser = {
  uid: string
  name: string
}

export type MsgItem = {
  name: string
  room: string
  uid: string
  sid: string
  /** Unix timestamp in seconds. */
  ts: number
  namecolor: string
  msgcolor: string
  msg: string
}

export type ClientMessage = {
  uid: string
  name: string
  msg: string
  namecolor: string
  msgcolor: string
}

export type ServerEvent =
  | { type: 'init'; data: JoinedUser }
  | { type: 'online'; data: JoinedUser[] }
  | { type: 'sys'; data: string }
  | { type: 'msg'; data: MsgItem }
  | { type: 'rename'; data: { uid: string; name: string } }

export type ClientEvent =
  | { type: 'message'; data: ClientMessage }
  | { type: 'change-name'; data: string }
  | { type: 'leave' }

const JoinedUserSchema = t.Object({
  uid: t.String(),
  name: t.String(),
})

const MsgItemSchema = t.Object({
  name: t.String(),
  room: t.String(),
  uid: t.String(),
  sid: t.String(),
  ts: t.Integer(),
  namecolor: t.String(),
  msgcolor: t.String(),
  msg: t.String(),
})

const ClientMessageSchema = t.Object({
  uid: t.String(),
  name: t.String(),
  msg: t.String(),
  namecolor: t.String(),
  msgcolor: t.String(),
})

export const ServerEventSchema = t.Union([
  t.Object({ type: t.Literal('init'), data: JoinedUserSchema }),
  t.Object({ type: t.Literal('online'), data: t.Array(JoinedUserSchema) }),
  t.Object({ type: t.Literal('sys'), data: t.String() }),
  t.Object({ type: t.Literal('msg'), data: MsgItemSchema }),
  t.Object({ type: t.Literal('rename'), data: t.Object({ uid: t.String(), name: t.String() }) }),
])

export const ClientEventSchema = t.Union([
  t.Object({ type: t.Literal('message'), data: ClientMessageSchema }),
  t.Object({ type: t.Literal('change-name'), data: t.String() }),
  t.Object({ type: t.Literal('leave') }),
])