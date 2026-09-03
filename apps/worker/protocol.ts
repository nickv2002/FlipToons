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
import type { Season } from '../../packages/engine/cards/types'
import type { SoloDifficulty } from '../../packages/engine/setup'

// §6's room-code alphabet: unambiguous characters only (no 0/O, 1/I/l).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 5

export const PLAYER_NAME_MAX_LENGTH = 10

// The one place player names get cleaned up, used by both the client (as you
// type) and the worker (join/create never pass through the same HTTP
// validation, so the Durable Object has to enforce this itself too). Strips
// control characters and line/paragraph separators (\p{Cc}, \p{Zl}, \p{Zp} —
// covers \n, \r, and friends) so a name can't forge a fake line in
// apps/worker/log.ts's single-line, unescaped log format. Deliberately does
// NOT strip \p{Cf} (format characters): that category is where the
// zero-width joiner lives, and a multi-person emoji (👨‍👩‍👧‍👦) is four base
// emoji stitched together BY zero-width joiners — stripping them breaks the
// emoji apart into separate glyphs instead of leaving it intact.
// Caps at PLAYER_NAME_MAX_LENGTH grapheme clusters (not UTF-16 code units)
// via Intl.Segmenter — a naive .slice() would miscount or mid-truncate
// multi-codepoint emoji (ZWJ sequences, skin-tone modifiers) into broken
// glyphs. Deliberately does NOT trim: this runs on every keystroke in the
// name input, and trimming there would eat a trailing space the moment it's
// typed, making a two-word name impossible to enter. Callers trim once, at
// submit/storage time, same as before this function existed.
export function sanitizePlayerName(raw: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
  const graphemes = Array.from(new Intl.Segmenter().segment(cleaned), (s) => s.segment)
  return graphemes.slice(0, PLAYER_NAME_MAX_LENGTH).join('')
}

export const MAX_SEATS = 4

// What a client is told about each seat. Deliberately NOT the reconnect token
// — that is sent only to the seat it belongs to, once, on join/create.
export type SeatInfo = {
  playerId: string
  name: string
  connected: boolean
  isHost: boolean
  isBot: boolean
  // Present only when isBot. Public (not just remembered by whichever
  // browser hosted) because any connected human's browser may end up
  // computing this seat's moves, and a joiner needs to see it before they
  // ever touch the board — see CreateRoomRequest.bots below.
  botDifficulty?: SoloDifficulty
}

export type LobbyState = {
  roomCode: string
  seats: SeatInfo[]
  started: boolean
  season: Season
  fameToTriggerEndgame: number
  // Which Big Button reset effect card is on the table, or null for "the
  // mini-expansion is not in play" (the default). Fixed at room creation —
  // see CreateRoomRequest.
  bigButton: 'market' | 'grid' | null
  // How many seats the room can hold — always MAX_SEATS. The table size is not
  // chosen up front; it is whoever is in the lobby when the host starts. The
  // lobby renders this only so you can see there is still room.
  capacity: number
}

// POST /api/rooms — mints a room code and seeds the match. Returns what the
// creator needs to open its WebSocket and attach as the host seat.
// `bigButton` names which Big Button reset effect card is on the table, or is
// omitted for "the mini-expansion is not in play" — the default. It is fixed
// at room creation because it changes the toon deck's composition (the
// season's Big Button card is only dealt when a reset effect is chosen), which
// setup.ts decides before the first Flip.
// `bots` seats one permanent bot per entry, starting at seat 2, at creation
// (see room.ts) — 0 to MAX_SEATS - 1 of them, each entry naming that seat's
// difficulty (packages/engine/setup.ts's SoloDifficulty, the same knob solo
// play already uses). A bot's moves are computed in ANY connected human's
// browser and relayed as ordinary `action` messages tagged with `asSeat`
// below, never computed on this server.
export type CreateRoomRequest = {
  name: string
  season: Season
  seed?: number
  fameToTriggerEndgame?: number
  bigButton?: 'market' | 'grid'
  bots?: SoloDifficulty[]
}
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
  // anyone. `asSeat`, if present, is honored ONLY when it names a bot seat in
  // this room (see room.ts's handleAction) — this is a low-stakes hobby app,
  // so there is deliberately no check on WHICH socket sends a bot's move, only
  // on WHOSE seat it is allowed to move.
  | { type: 'action'; action: MatchAction; asSeat?: string }
  // Host-only, and only once the match has actually ended: deals a fresh
  // match to the same seats without returning to the lobby.
  | { type: 'rematch' }
  // Host-only, pre-start only: seats one more bot at the next open turnOrder
  // slot. Lets the host size the table to who actually showed up rather than
  // guessing bot count before anyone has joined.
  | { type: 'addBot'; difficulty: SoloDifficulty }
  // Host-only, pre-start only: vacates a bot seat so a human (or a
  // differently-difficultied bot) can take it.
  | { type: 'removeBot'; playerId: string }

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
