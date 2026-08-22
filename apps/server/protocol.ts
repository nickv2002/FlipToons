// Wire protocol between apps/web (remote mode) and apps/server. Imported at
// runtime by both sides — same cross-boundary pattern useGame.ts already
// uses for packages/engine/actions (vite resolves it fine, see
// vite.config.ts's fs.allow). Must stay free of any Bun-only types
// (ServerWebSocket, Bun.*): apps/web/tsconfig.json has no "bun-types", so a
// Bun reference here would fail `cd apps/web && bunx tsc --noEmit`.
//
// This is now a MULTIPLAYER protocol. The previous version hosted a single
// shared solo GameState that any number of browsers jointly drove — no
// identity, no seats, so the server could not tell who sent an action. A solo
// game is now simply a 1-seat match through the same messages.
import type { Match } from '../../packages/engine/state'
import type { LogLine, MatchAction } from '../../packages/engine/matchActions'

export const DEFAULT_PORT = 8787

// §6's room-code alphabet: unambiguous characters only (no 0/O, 1/I/l).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 5

export const MAX_SEATS = 4

// What a client is told about each seat. Deliberately NOT the reconnect token
// — that is sent only to the seat it belongs to, once, on join.
export type SeatInfo = {
  playerId: string
  name: string
  connected: boolean
  isHost: boolean
}

export type LobbyState = {
  roomCode: string
  seats: SeatInfo[]
  started: boolean
  season: 1 | 2
  fameToTriggerEndgame: number
}

export type ClientMessage =
  // Creates a room and takes the first seat. `playerCount` is the table size
  // the room will accept; a 1-player room is a solo game.
  //
  // `fameToTriggerEndgame` is optional and exists because 30 fame is many
  // rounds of play: the browser end-to-end test sets it low to reach a Final
  // Flip quickly, and it doubles as the most useful playtesting knob.
  | { type: 'create'; name: string; playerCount: number; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }
  // `reconnectToken` reclaims a seat after a reload or a dropped connection.
  // Without one, this is a new player taking a free seat.
  | { type: 'join'; roomCode: string; name: string; reconnectToken?: string }
  // Host-only: closes the lobby and deals the first round.
  | { type: 'start'; roomCode: string }
  // NOTE: carries no playerId. The server derives the actor from the
  // connection's assigned seat — a client-asserted id would let anyone act as
  // anyone.
  | { type: 'action'; roomCode: string; action: MatchAction }

export type ServerMessage =
  // Sent once to the joining connection. `reconnectToken` is private to this
  // seat; `playerId` tells the client which board is theirs.
  | { type: 'seated'; roomCode: string; playerId: string; reconnectToken: string; lobby: LobbyState }
  // Broadcast whenever the seat list changes (join, disconnect, reconnect).
  | { type: 'lobby'; lobby: LobbyState }
  // Full match state. Everything in a FlipToons game is public (§3.3a: decks,
  // grids and dismissed piles may all be examined by any player), so there is
  // no per-connection filtering to do.
  | { type: 'state'; match: Match; logLines: LogLine[]; debugLines: string[]; log?: LogLine[] }
  // Something the player did wrong (acting out of turn, joining a full room).
  // Distinct from 'serverError' so the client can show one quietly and shout
  // about the other.
  | { type: 'error'; message: string; code?: 'noSuchRoom' | 'roomFull' | 'alreadyStarted' | 'notHost' | 'illegalAction' }
  | { type: 'serverError'; message: string }
