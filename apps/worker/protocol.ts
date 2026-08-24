// Wire protocol between apps/web and apps/worker (the Cloudflare Worker +
// Durable Object multiplayer server). Imported at runtime by both sides, same
// cross-boundary pattern useGame.ts already uses for packages/engine/actions
// (vite resolves it fine, see vite.config.ts's fs.allow).
//
// A solo game is a 1-seat match through the same messages; the browser can
// also just run it locally (apps/web/src/useGame.ts) without touching this
// protocol at all.
//
// Room creation is NOT a WebSocket message here, unlike the Bun-server
// version this replaced. A Durable Object is addressed by name
// (env.ROOMS.idFromName(roomCode)) at the moment a request arrives — routing
// has to be decided before the WebSocket upgrade completes, so the room code
// has to exist before the socket opens. `join`/reconnect already know the
// code upfront (typed by the user, or stored from a previous visit); `create`
// didn't, so it's now a plain HTTP call that mints the code first.
import type { Match } from '../../packages/engine/state'
import type { LogLine, MatchAction } from '../../packages/engine/matchActions'

// §6's room-code alphabet: unambiguous characters only (no 0/O, 1/I/l).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 5

export const MAX_SEATS = 4

// What a client is told about each seat. Deliberately NOT the reconnect token
// — that is sent only to the seat it belongs to, once, on join/create.
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
  // How many seats the room can hold — always MAX_SEATS. The table size is not
  // chosen up front; it is whoever is in the lobby when the host starts. The
  // lobby renders this only so you can see there is still room.
  capacity: number
}

// POST /api/rooms — mints a room code and seeds the match. Returns what the
// creator needs to open its WebSocket and attach as the host seat.
export type CreateRoomRequest = { name: string; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }
export type CreateRoomResponse = { roomCode: string; playerId: string; reconnectToken: string; lobby: LobbyState }

// Sent as the first message over a `/ws?room=<code>` connection. There is no
// `roomCode` field on any of these any more — the query param already picked
// the Durable Object, so the message only needs to say who is attaching to
// it. `create` mints its seat over POST /api/rooms and then `join`s with the
// reconnectToken that call returned; that is exactly the same path a dropped
// connection's reconnect takes, so there is only one seat-claiming message,
// not two.
export type ClientMessage =
  | { type: 'join'; name: string; reconnectToken?: string }
  // Host-only: closes the lobby and deals the first round.
  | { type: 'start' }
  // NOTE: carries no playerId. The server derives the actor from the
  // connection's assigned seat — a client-asserted id would let anyone act as
  // anyone.
  | { type: 'action'; action: MatchAction }
  // Host-only, and only once the match has actually ended: deals a fresh
  // match to the same seats without returning to the lobby.
  | { type: 'rematch' }

export type ServerMessage =
  // Sent once to the attaching/joining connection. `reconnectToken` is
  // private to this seat; `playerId` tells the client which board is theirs.
  | { type: 'seated'; roomCode: string; playerId: string; reconnectToken: string; lobby: LobbyState }
  // Broadcast whenever the seat list changes (join, disconnect, reconnect).
  | { type: 'lobby'; lobby: LobbyState }
  // Full match state. Everything in a FlipToons game is public (§3.3a: decks,
  // grids and dismissed piles may all be examined by any player), so there is
  // no per-connection filtering to do.
  //
  // This does go slightly further than §3.3a strictly grants, and the choice
  // was made deliberately: PlayerState.rng rides along, and a deck is
  // reshuffled from that stream at every Flip. Examining a deck shows you a
  // SNAPSHOT; the rng state would let a modified client precompute every
  // future reshuffle for every seat, for the rest of the match. Considered and
  // accepted — this is a casual game among friends, and per-seat filtering
  // would buy nothing anyone here needs. Not a finding; don't re-raise it.
  | { type: 'state'; match: Match; logLines: LogLine[]; debugLines: string[]; log?: LogLine[] }
  // Something the player did wrong (acting out of turn, joining a full room).
  // Distinct from 'serverError' so the client can show one quietly and shout
  // about the other.
  | { type: 'error'; message: string; code?: 'noSuchRoom' | 'roomFull' | 'alreadyStarted' | 'notHost' | 'illegalAction' | 'notEnded' }
  | { type: 'serverError'; message: string }
