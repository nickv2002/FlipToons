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
  // The connection currently holding this seat, so a LATER close event from an
  // EARLIER socket can be recognised and ignored. Without it, a stale socket
  // closing after the player had already reconnected marked a seat that was
  // sitting right there as away — and, once turns can be skipped on
  // disconnection, would have skipped a present player's turn.
  socket?: ServerWebSocket<SocketData>
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
  // Set only while the table is waiting on a seat nobody is sitting in. See
  // armTurnTimeout.
  turnTimer?: ReturnType<typeof setTimeout>
}

const rooms = new Map<string, Room>()

// Rooms are evicted once they have been idle this long. The old registry never
// called rooms.delete and never truncated its logs, so a long-lived server
// grew without bound.
//
// "Idle" means nothing has TOUCHED the room — creating it, seating a
// connection, starting it, or applying an action all bump `lastActivity`. So a
// client that keeps rejoining without ever playing does hold a room open; what
// the window is really bounding is abandonment, and a rejoin is not that.
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
// Logs are capped too: a long match generates a lot of lines, and a client
// only ever renders the recent tail.
export const MAX_LOG_LINES = 2000
// How long the table waits on a seat whose player has dropped before playing
// that seat's turn for them. Nothing used to skip such a turn, so one dropped
// connection stalled everyone else for the full ROOM_TTL_MS.
export const TURN_TIMEOUT_MS = 60 * 1000

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
  const room = rooms.get(roomCode)
  if (room) clearTurnTimeout(room)
  rooms.delete(roomCode)
}

export function roomCount(): number {
  return rooms.size
}

// Drops rooms nobody has touched in ROOM_TTL_MS. Called opportunistically on
// every message rather than from a timer, so a quiet server does no work.
//
// Idleness alone is the test. Eviction used to additionally require that the
// room be abandoned — no sockets, no seat marked connected — which meant a
// single browser tab left open overnight pinned a finished or forgotten game
// in memory forever, however long the TTL was. A day without anyone touching
// the room is the answer regardless of who still has a socket pointed at it.
export function evictStaleRooms(now: number = Date.now()): number {
  let evicted = 0
  for (const [code, room] of rooms) {
    if (now - room.lastActivity <= ROOM_TTL_MS) continue
    // A pending timer would otherwise outlive the room it was waiting on.
    clearTurnTimeout(room)
    // Delete before closing, so index.ts's close handler — which looks the
    // room up by code — finds nothing and bails, rather than broadcasting to
    // and re-arming a turn timer on the room being evicted (a timer armed
    // after clearTurnTimeout, on an object nothing will ever clear again).
    // Close events are delivered asynchronously, so in practice it would find
    // the room gone either way; this makes that independent of timing.
    rooms.delete(code)
    evicted++
    // Any connection still pointed at this room is now talking to nothing.
    // Closing it puts the client on its normal reconnect path, where the
    // rejoin answers `noSuchRoom` and the UI lets go of the seat — far better
    // than leaving a live-looking board whose every click is a no-op.
    for (const ws of room.sockets) ws.close()
    room.sockets.clear()
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

// ---------------------------------------------------------------------------
// Waiting on someone who isn't there
// ---------------------------------------------------------------------------
//
// A dropped connection used to mark its seat away and change nothing else. If
// that seat was the one holding everyone up, the table sat there until the
// room hit its idle TTL — and until the client's own fix, the other
// players could not even leave.
//
// The Flip is safe: any seat may press it. Only two things wait on ONE named
// seat, and both are covered here.

function seatOf(room: Room, playerId: string): Seat | undefined {
  return room.seats.find((s) => s.playerId === playerId)
}

// The seat, if any, whose absence is currently stopping the game.
function strandingSeat(room: Room): Seat | undefined {
  if (!room.started) return undefined

  // A post-fame choice (a mandatory Skunk dismissal, say) blocks the Market
  // phase from opening for anyone, and is owed by one particular player.
  const owing = room.match.players.find((p) => p.pendingPostFameChoice)
  if (owing) {
    const seat = seatOf(room, owing.playerId)
    return seat && !seat.connected ? seat : undefined
  }

  // Otherwise only the Market phase is strictly turn-based.
  if (room.match.shared.phase !== 'market') return undefined
  const seat = seatOf(room, room.match.turnOrder[room.match.activePlayerIndex])
  return seat && !seat.connected ? seat : undefined
}

export function clearTurnTimeout(room: Room): void {
  if (!room.turnTimer) return
  clearTimeout(room.turnTimer)
  room.turnTimer = undefined
}

// Re-evaluates whether the table is stranded, and arms or disarms accordingly.
// Cheap and idempotent, so it can be called after anything that might have
// changed the answer: an action, a disconnection, a reconnection.
//
// The gate is DISCONNECTION, never idleness — a player who is present and
// thinking is not on a clock.
export function armTurnTimeout(room: Room, timeoutMs: number = TURN_TIMEOUT_MS): void {
  clearTurnTimeout(room)
  const seat = strandingSeat(room)
  if (!seat) return
  const timer = setTimeout(() => {
    room.turnTimer = undefined
    playForAbsentSeat(room, timeoutMs)
  }, timeoutMs)
  // Otherwise an armed timer holds the event loop open and `bun test` never
  // exits.
  timer.unref?.()
  room.turnTimer = timer
}

// Plays the least the rules allow on behalf of a seat nobody is holding:
// answer whatever it owes with the first legal option, then end its turn.
// Buying nothing is always legal, so this can only cost that player the
// chance to spend — never a rule.
function playForAbsentSeat(room: Room, timeoutMs: number): void {
  const seat = strandingSeat(room)
  if (!seat) return

  const logLines: LogLine[] = []
  const debugLines: string[] = []
  let stalled = false
  // Each action is applied through the normal surface, so the engine's own
  // legality checks still hold. The bound is a safety net: nothing here should
  // need more than a couple of steps, and a loop that isn't converging must
  // not spin.
  for (let step = 0; step < 8; step++) {
    const player = room.match.players.find((p) => p.playerId === seat.playerId)
    if (!player) break

    let action: MatchAction
    if (player.pendingPostFameChoice) {
      const option = player.pendingPostFameChoice.options[0]
      action = { kind: 'resolvePostFameChoice', pos: option.pos, index: option.index }
    } else if (player.pendingDeckPlacement) {
      action = { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } }
    } else if (player.pendingPostMarketChoice) {
      const option = player.pendingPostMarketChoice.options[0]
      action = { kind: 'resolvePostMarketChoice', pos: option.pos, index: option.index }
    } else if (room.match.shared.phase === 'market' && room.match.turnOrder[room.match.activePlayerIndex] === seat.playerId) {
      action = { kind: 'endTurn' }
    } else {
      break // no longer stranded on this seat
    }

    let result: ReturnType<typeof applyRoomAction>
    try {
      result = applyRoomAction(room, seat.playerId, action)
    } catch (err) {
      // Same split as the action handler: a genuine engine fault is loud here
      // and leaves the room untouched, rather than taking the process down
      // from inside a timer.
      console.error('apps/server: engine bug skipping an absent seat', action, err)
      stalled = true
      break
    }
    if (!result.ok) {
      console.error(`apps/server: could not skip ${seat.playerId}'s turn — ${result.message}`)
      stalled = true
      break
    }
    logLines.push(...result.logLines)
    debugLines.push(...result.debugLines)
  }

  if (logLines.length > 0 || debugLines.length > 0) {
    const notice: LogLine = {
      playerId: seat.playerId,
      round: room.match.shared.round,
      text: `was skipped — no one is connected to that seat.`,
    }
    room.log.push(notice)
    broadcast(room, { type: 'state', match: room.match, logLines: [notice, ...logLines], debugLines })
  }

  // A skip that could not move anything must NOT re-arm: nothing changed, so
  // the next firing would find the same state and fail the same way, once a
  // minute, forever. The room stays stranded either way — but stranded and
  // quiet, with one line in the log saying why, beats a spin. The clock starts
  // again on its own the next time anything happens in the room.
  if (stalled) return

  // The seat this passed to may be empty too.
  armTurnTimeout(room, timeoutMs)
}
