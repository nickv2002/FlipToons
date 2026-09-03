// The Worker entry point: serves the built apps/web static assets, mints
// rooms over POST /api/rooms, and routes /ws upgrades to the room's Durable
// Object by name. See room.ts for why room creation is HTTP rather than a
// WebSocket message, and CLAUDE.md's Cloudflare Workers section for the rest
// of the migration's reasoning.
import { MAX_SEATS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, sanitizePlayerName } from './protocol'
import type { CreateRoomRequest, CreateRoomResponse } from './protocol'
import { log } from './log'
import type { Env } from './room'
import type { SoloDifficulty } from '../../packages/engine/setup'

function validBots(raw: unknown): SoloDifficulty[] | undefined {
  if (!Array.isArray(raw)) return undefined
  // Reject rather than clamp: a client sending too many bots or a bogus
  // difficulty string is either a bug or an attempt to bypass the picker's
  // own MAX_SEATS - 1 cap, and silently truncating would seat a different
  // table than what was asked for.
  if (raw.length > MAX_SEATS - 1) return undefined
  if (!raw.every((d) => d === 'easy' || d === 'normal' || d === 'hard')) return undefined
  return raw as SoloDifficulty[]
}

export { RoomDurableObject } from './room'

// ROOM_CODE_ALPHABET (32 chars) ^ ROOM_CODE_LENGTH (5) ≈ 33M codes. A Worker
// has no cross-room registry to check a fresh code against the way the old
// single-process Map did — at this project's scale, minting one and going is
// the right tradeoff over a collision-check round trip to the DO.
function mintRoomCode(): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

// Same-origin in production (the Worker serves apps/web's own build), so
// these headers are inert there. In local dev, apps/web runs on Vite's own
// port (5173) while apps/worker runs separately under `wrangler dev` (8787)
// — a genuine cross-origin POST, which a WebSocket handshake never was
// subject to but `fetch()` is. Permissive rather than allowlisted: there's
// no session cookie or credential this endpoint could leak, only the ability
// to mint a room, which is the same thing a public "Host a table" button
// already does for anyone.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  let body: CreateRoomRequest
  try {
    body = await request.json()
  } catch {
    return Response.json({ message: 'Malformed request body.' }, { status: 400, headers: CORS_HEADERS })
  }
  if (body.season !== 1 && body.season !== 2 && body.season !== 'both') {
    return Response.json({ message: 'season must be 1, 2, or "both".' }, { status: 400, headers: CORS_HEADERS })
  }

  const roomCode = mintRoomCode()
  const stub = env.ROOMS.getByName(roomCode)
  const result: CreateRoomResponse = await stub.createRoom(roomCode, {
    name: sanitizePlayerName(body.name ?? '').trim() || 'Player 1',
    season: body.season,
    seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined,
    fameToTriggerEndgame: Number.isFinite(Number(body.fameToTriggerEndgame)) ? Number(body.fameToTriggerEndgame) : undefined,
    // Validated rather than passed through: this reaches setup.ts and decides
    // the toon deck's composition, so an arbitrary string arriving from a
    // client must land as "not in play", not as a truthy unknown effect.
    bigButton: body.bigButton === 'market' || body.bigButton === 'grid' ? body.bigButton : undefined,
    bots: validBots(body.bots),
  })
  return Response.json(result, { headers: CORS_HEADERS })
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const roomCode = (url.searchParams.get('room') ?? '').toUpperCase()
  if (!roomCode) {
    return new Response('Missing ?room=.', { status: 400 })
  }
  const stub = env.ROOMS.getByName(roomCode)
  return stub.fetch(request)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.hostname === 'www.fliptoons.win') {
      url.hostname = 'fliptoons.win'
      return Response.redirect(url.toString(), 301)
    }

    if (url.pathname === '/api/rooms' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      try {
        return await handleCreateRoom(request, env)
      } catch (err) {
        log('error', null, 'could not create a room', err)
        return Response.json({ message: 'Could not create that room.' }, { status: 500, headers: CORS_HEADERS })
      }
    }

    if (url.pathname === '/ws') {
      return handleWebSocket(request, env)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
