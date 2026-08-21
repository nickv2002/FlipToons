// Room registry: one solo GameState per room, held in memory only. This is
// NOT §6's multiplayer server (no per-player turn order, no legalActions,
// no pendingChoice) — see index.ts's header comment for the full scoping
// note. §6's own stated MVP tradeoff applies here too: no persistence, a
// process restart drops every in-progress room.
import type { ServerWebSocket } from 'bun'
import { applyAction, buildNewGameState } from '../../packages/engine/actions'
import type { Action } from '../../packages/engine/actions'
import type { GameState } from '../../packages/engine/state'
import type { SoloDifficulty } from '../../packages/engine/setup'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol'
import type { ServerMessage } from './protocol'

export type SocketData = { roomCode: string | null }

export type Room = {
  state: GameState
  log: string[]
  debugLog: string[]
  sockets: Set<ServerWebSocket<SocketData>>
}

const rooms = new Map<string, Room>()

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

export function createRoom(seed: number, difficulty: SoloDifficulty, season: 1 | 2): { roomCode: string; room: Room } {
  const roomCode = generateRoomCode()
  // Cascade the initial flip immediately (actions.ts's applyAction now
  // advances flip -> checkFame -> postFameHooks -> market on its own), so a
  // freshly created room never sits in 'flip' — the web client no longer
  // renders that phase at all.
  const { state, logLines, debugLines } = applyAction(buildNewGameState(seed, difficulty, season), { kind: 'flip' })
  const room: Room = { state, log: logLines, debugLog: debugLines, sockets: new Set() }
  rooms.set(roomCode, room)
  return { roomCode, room }
}

export function getRoom(roomCode: string): Room | undefined {
  return rooms.get(roomCode)
}

function send(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

export function broadcast(room: Room, message: ServerMessage): void {
  for (const ws of room.sockets) send(ws, message)
}

// Rejected actions (e.g. hiring with insufficient fame) come back from
// applyAction as a log line, not a throw — see actions.ts's isEngineBug
// split. A genuine phase-machine bug (calling an action in the wrong phase)
// DOES still throw here; index.ts's message handler is what turns that into
// a loud server-side log plus a client-facing error, without mutating the
// room's state.
export function applyRoomAction(room: Room, action: Action): { logLines: string[]; debugLines: string[] } {
  const { state: next, logLines, debugLines } = applyAction(room.state, action)
  room.state = next
  room.log.push(...logLines)
  room.debugLog.push(...debugLines)
  return { logLines, debugLines }
}
