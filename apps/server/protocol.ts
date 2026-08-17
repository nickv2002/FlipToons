// Wire protocol between apps/web (remote mode) and apps/server. Imported at
// runtime by both sides — same cross-boundary pattern useGame.ts already
// uses for packages/engine/actions (vite resolves it fine, see
// vite.config.ts's fs.allow). Must stay free of any Bun-only types
// (ServerWebSocket, Bun.*): apps/web/tsconfig.json has no "bun-types", so a
// Bun reference here would fail `cd apps/web && bunx tsc --noEmit`.
import type { GameState } from '../../packages/engine/state'
import type { SoloDifficulty } from '../../packages/engine/setup'
import type { Action } from '../../packages/engine/actions'

export const DEFAULT_PORT = 8787

// §6's room-code alphabet: unambiguous characters only (no 0/O, 1/I/l).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 5

export type ClientMessage =
  | { type: 'create'; seed: number; difficulty: SoloDifficulty; season: 1 | 2 }
  | { type: 'join'; roomCode: string }
  | { type: 'action'; roomCode: string; action: Action }

export type ServerMessage =
  | { type: 'joined'; roomCode: string; state: GameState; log: string[] }
  | { type: 'state'; state: GameState; logLines: string[] }
  | { type: 'error'; message: string }
