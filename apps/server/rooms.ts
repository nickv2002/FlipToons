// Room registry: one Match per room, held in memory only. §6's own stated MVP
// tradeoff applies — no persistence, a process restart drops every in-progress
// room.
//
// This replaces the previous "hosted solo" registry, which held a single
// shared GameState that any number of connections jointly drove. That had no
// concept of who was acting, so two browsers in one room shared one grid and
// one fame pool. Rooms now have SEATS, and every action is attributed to the
// seat its connection holds.
import type { ServerWebSocket } from 'bun'
import { buildNewMatch } from '../../packages/engine/match'
import { IllegalActionError, applyMatchAction } from '../../packages/engine/matchActions'
import type { LogLine, MatchAction } from '../../packages/engine/matchActions'
import type { Match } from '../../packages/engine/state'
import { MAX_SEATS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol'
import type { LobbyState, SeatInfo, ServerMessage } from './protocol'

// The connection's identity. `seat` is assigned by the server on join and is
// the ONLY thing an action is attributed to — see applyRoomAction.
export type SocketData = { roomCode: string | null; seat: string | null }

export type Seat = {
  playerId: string
  name: string
  // Opaque bearer token the client persists. Presenting it on a later join
  // reclaims this seat, which is what makes a reload or a dropped connection
  // survivable.
  reconnectToken: string
  connected: boolean
}

export type Room = {
  match: Match
  seats: Seat[]
  hostPlayerId: string
  started: boolean
  playerCount: number
  season: 1 | 2
  seed: number
  fameToTriggerEndgame: number
  log: LogLine[]
  debugLog: string[]
  sockets: Set<ServerWebSocket<SocketData>>
  lastActivity: number
}

const rooms = new Map<string, Room>()

// Rooms are evicted once they have been idle this long. The old registry never
// called rooms.delete and never truncated its logs, so a long-lived server
// grew without bound.
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
// Logs are capped too: a long match generates a lot of lines, and a client
// only ever renders the recent tail.
export const MAX_LOG_LINES = 2000

function generateRoomCode(): string {
  let code: string
  do {
    code = ''
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
  } while (rooms.has(code))
  return code
}

function generateToken(): string {
  return crypto.randomUUID()
}

export function createRoom(params: {
  name: string
  playerCount: number
  season: 1 | 2
  seed?: number
  fameToTriggerEndgame?: number
}): { roomCode: string; room: Room; seat: Seat } {
  // Rooms are 2-4 seats. A solo game does not go through a room at all — the
  // browser runs it locally (apps/web/src/useGame.ts), which is what "hosted
  // solo" was really doing before, only with the extra failure modes of a
  // network in the middle.
  // Math.floor of a non-number is NaN, and both Math.max and Math.min pass NaN
  // straight through — so clamping alone turned a malformed playerCount into a
  // NaN that buildMultiplayerSetup rejected by throwing. Anything that isn't a
  // usable number falls back to the smallest legal table instead.
  const requested = Number(params.playerCount)
  const playerCount = Number.isFinite(requested) ? Math.max(2, Math.min(MAX_SEATS, Math.floor(requested))) : 2
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31)
  const roomCode = generateRoomCode()

  // The match is built up front so the lobby already knows the table size and
  // the seat ids; it simply isn't dealt until `start`.
  const match = buildNewMatch(seed, playerCount, params.season, {
    fameToTriggerEndgame: params.fameToTriggerEndgame,
  })

  const seat: Seat = { playerId: match.turnOrder[0], name: params.name, reconnectToken: generateToken(), connected: true }
  const room: Room = {
    match,
    seats: [seat],
    hostPlayerId: seat.playerId,
    started: false,
    playerCount,
    season: params.season,
    seed,
    fameToTriggerEndgame: match.shared.fameToTriggerEndgame,
    log: [],
    debugLog: [],
    sockets: new Set(),
    lastActivity: Date.now(),
  }
  rooms.set(roomCode, room)
  return { roomCode, room, seat }
}

export function getRoom(roomCode: string): Room | undefined {
  return rooms.get(roomCode)
}

export function deleteRoom(roomCode: string): void {
  rooms.delete(roomCode)
}

export function roomCount(): number {
  return rooms.size
}

// Drops rooms nobody has touched in ROOM_TTL_MS. Called opportunistically on
// every message rather than from a timer, so a quiet server does no work.
export function evictStaleRooms(now: number = Date.now()): number {
  let evicted = 0
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity > ROOM_TTL_MS
    const abandoned = room.sockets.size === 0 && room.seats.every((s) => !s.connected)
    if (idle && abandoned) {
      rooms.delete(code)
      evicted++
    }
  }
  return evicted
}

export type JoinOutcome =
  | { ok: true; seat: Seat; reclaimed: boolean }
  | { ok: false; code: 'roomFull' | 'alreadyStarted'; message: string }

// Seats a connection. A valid reconnect token always wins — it reclaims that
// exact seat, which is what lets a player rejoin a match already in progress.
export function joinRoom(room: Room, name: string, reconnectToken?: string): JoinOutcome {
  if (reconnectToken) {
    const existing = room.seats.find((s) => s.reconnectToken === reconnectToken)
    if (existing) {
      existing.connected = true
      if (name) existing.name = name
      return { ok: true, seat: existing, reclaimed: true }
    }
  }

  // A new player can only take a free seat in a lobby that hasn't started.
  // Rejected with a DISTINCT code from "no such room" so the UI can say what
  // actually went wrong.
  if (room.started) {
    return { ok: false, code: 'alreadyStarted', message: 'That game has already started.' }
  }
  if (room.seats.length >= room.playerCount) {
    return { ok: false, code: 'roomFull', message: 'That room is full.' }
  }

  const seat: Seat = {
    playerId: room.match.turnOrder[room.seats.length],
    name,
    reconnectToken: generateToken(),
    connected: true,
  }
  room.seats.push(seat)
  return { ok: true, seat, reclaimed: false }
}

export function lobbyOf(room: Room, roomCode: string): LobbyState {
  const seats: SeatInfo[] = room.seats.map((s) => ({
    playerId: s.playerId,
    name: s.name,
    connected: s.connected,
    isHost: s.playerId === room.hostPlayerId,
  }))
  return { roomCode, seats, started: room.started, season: room.season, fameToTriggerEndgame: room.fameToTriggerEndgame }
}

// Closes the lobby. The match was built for `playerCount` seats; if fewer
// people actually turned up, it is rebuilt at the size that did — otherwise
// the empty seats would sit there holding boards nobody plays.
export function startRoom(room: Room): void {
  if (room.started) return
  if (room.seats.length < 2) return // nothing to start; the lobby waits
  if (room.seats.length !== room.playerCount) {
    room.playerCount = room.seats.length
    room.match = buildNewMatch(room.seed, room.seats.length, room.season, {
      fameToTriggerEndgame: room.fameToTriggerEndgame,
    })
    room.seats.forEach((s, i) => {
      s.playerId = room.match.turnOrder[i]
    })
    room.hostPlayerId = room.seats[0].playerId
  }
  room.started = true
  room.lastActivity = Date.now()
}

function send(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

export function broadcast(room: Room, message: ServerMessage): void {
  for (const ws of room.sockets) send(ws, message)
}

// Applies one action on behalf of the seat the CONNECTION holds. `playerId`
// comes from SocketData.seat at the call site in index.ts, never from the
// message body.
//
// IllegalActionError is a player mistake (acting out of turn, not enough
// fame) and is returned, not thrown. Anything else is a genuine engine bug and
// propagates so index.ts can log it loudly and leave the room untouched.
export function applyRoomAction(
  room: Room,
  playerId: string,
  action: MatchAction,
): { ok: true; logLines: LogLine[]; debugLines: string[] } | { ok: false; message: string } {
  try {
    const { match, logLines, debugLines } = applyMatchAction(room.match, playerId, action)
    room.match = match
    room.log.push(...logLines)
    room.debugLog.push(...debugLines)
    if (room.log.length > MAX_LOG_LINES) room.log.splice(0, room.log.length - MAX_LOG_LINES)
    if (room.debugLog.length > MAX_LOG_LINES) room.debugLog.splice(0, room.debugLog.length - MAX_LOG_LINES)
    room.lastActivity = Date.now()
    return { ok: true, logLines, debugLines }
  } catch (err) {
    if (err instanceof IllegalActionError) return { ok: false, message: err.message }
    throw err
  }
}
