// Server-layer tests for the multiplayer room protocol.
//
// These run a real Bun.serve instance over real WebSockets, because the things
// most worth testing here — seat assignment, reconnect-by-token, and the "the
// actor is the connection's seat, not a field in the message" boundary — only
// exist at the socket layer. Calling rooms.ts directly would skip exactly the
// code that enforces them.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Server } from 'bun'
import { startServer } from './index'
import type { ClientMessage, LobbyState, ServerMessage } from './protocol'
import type { SocketData } from './rooms'
import type { Match } from '../../packages/engine/state'

let server: Server<SocketData>
let base: string

beforeAll(() => {
  server = startServer(0)
  base = `ws://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

// A socket that QUEUES everything it receives. The old harness attached a
// one-shot listener per await, which drops any message that arrives while
// nothing is waiting — and this protocol broadcasts presence changes to
// everyone, so unawaited messages are normal now.
type Client = {
  ws: WebSocket
  inbox: ServerMessage[]
  send: (m: ClientMessage) => void
  next: <T extends ServerMessage['type']>(type: T, timeoutMs?: number) => Promise<Extract<ServerMessage, { type: T }>>
  close: () => void
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base)
    const inbox: ServerMessage[] = []
    ws.addEventListener('message', (ev) => inbox.push(JSON.parse(ev.data as string)))
    ws.addEventListener('error', reject, { once: true })
    ws.addEventListener('open', () => {
      resolve({
        ws,
        inbox,
        send: (m) => ws.send(JSON.stringify(m)),
        next: async (type, timeoutMs = 2000) => {
          const deadline = Date.now() + timeoutMs
          for (;;) {
            const i = inbox.findIndex((m) => m.type === type)
            if (i >= 0) return inbox.splice(i, 1)[0] as never
            if (Date.now() > deadline) throw new Error(`timed out waiting for '${type}'; got ${inbox.map((m) => m.type).join(', ') || 'nothing'}`)
            await new Promise((r) => setTimeout(r, 5))
          }
        },
        close: () => ws.close(),
      })
    }, { once: true })
  })
}

// Creates a room with two seated players and starts it. `fameToTriggerEndgame`
// is set low so a test can reach a Final Flip without playing a dozen rounds.
async function seatedPair(opts: { fameToTriggerEndgame?: number; seed?: number } = {}) {
  const host = await connect()
  host.send({ type: 'create', name: 'Ana', playerCount: 2, season: 1, seed: opts.seed ?? 11, fameToTriggerEndgame: opts.fameToTriggerEndgame ?? 999 })
  const seatedHost = await host.next('seated')

  const guest = await connect()
  guest.send({ type: 'join', roomCode: seatedHost.roomCode, name: 'Bo' })
  const seatedGuest = await guest.next('seated')

  return { host, guest, roomCode: seatedHost.roomCode, hostSeat: seatedHost, guestSeat: seatedGuest }
}

async function startGame(pair: Awaited<ReturnType<typeof seatedPair>>): Promise<Match> {
  pair.host.send({ type: 'start', roomCode: pair.roomCode })
  const state = await pair.host.next('state')
  await pair.guest.next('state')
  return state.match
}

describe('lobby and seating', () => {
  test('creating a room seats the creator as host and hands them a reconnect token', async () => {
    const host = await connect()
    host.send({ type: 'create', name: 'Ana', playerCount: 2, season: 1, seed: 1 })
    const seated = await host.next('seated')

    expect(seated.roomCode).toHaveLength(5)
    expect(seated.playerId).toBe('p0')
    expect(seated.reconnectToken).toBeTruthy()
    expect(seated.lobby.seats).toHaveLength(1)
    expect(seated.lobby.seats[0]).toMatchObject({ name: 'Ana', isHost: true, connected: true })
    expect(seated.lobby.started).toBe(false)
    host.close()
  })

  test('a second player gets a DIFFERENT seat and a different token', async () => {
    const { hostSeat, guestSeat, host, guest } = await seatedPair()
    expect(guestSeat.playerId).not.toBe(hostSeat.playerId)
    expect(guestSeat.reconnectToken).not.toBe(hostSeat.reconnectToken)
    expect(guestSeat.lobby.seats).toHaveLength(2)
    host.close()
    guest.close()
  })

  test('the table is told when someone joins', async () => {
    const host = await connect()
    host.send({ type: 'create', name: 'Ana', playerCount: 2, season: 1, seed: 1 })
    const seated = await host.next('seated')
    const guest = await connect()
    guest.send({ type: 'join', roomCode: seated.roomCode, name: 'Bo' })
    const lobby = await host.next('lobby')
    expect(lobby.lobby.seats.map((s) => s.name)).toEqual(['Ana', 'Bo'])
    host.close()
    guest.close()
  })

  test('joining a nonexistent room is a distinct error from a full one', async () => {
    const c = await connect()
    c.send({ type: 'join', roomCode: 'ZZZZZ', name: 'Nobody' })
    const err = await c.next('error')
    expect(err.code).toBe('noSuchRoom')
    c.close()
  })

  test('a full room is refused with its own code', async () => {
    const pair = await seatedPair()
    const third = await connect()
    third.send({ type: 'join', roomCode: pair.roomCode, name: 'Cy' })
    const err = await third.next('error')
    expect(err.code).toBe('roomFull')
    third.close()
    pair.host.close()
    pair.guest.close()
  })

  test('joining after the game started is refused with its own code', async () => {
    const pair = await seatedPair()
    await startGame(pair)
    const late = await connect()
    late.send({ type: 'join', roomCode: pair.roomCode, name: 'Late' })
    const err = await late.next('error')
    expect(err.code).toBe('alreadyStarted')
    late.close()
    pair.host.close()
    pair.guest.close()
  })

  test('only the host can start', async () => {
    const pair = await seatedPair()
    pair.guest.send({ type: 'start', roomCode: pair.roomCode })
    const err = await pair.guest.next('error')
    expect(err.code).toBe('notHost')
    pair.host.close()
    pair.guest.close()
  })

  test('starting deals the match to everyone', async () => {
    const pair = await seatedPair()
    const match = await startGame(pair)
    expect(match.players).toHaveLength(2)
    expect(match.shared.phase).toBe('flip')
    pair.host.close()
    pair.guest.close()
  })
})

describe('the security boundary: the actor is the seat, not the message', () => {
  test('a player cannot act during another player\'s Market turn', async () => {
    const pair = await seatedPair()
    let match = await startGame(pair)

    // Advance into the Market phase, answering any mandatory Skunk dismissal.
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    match = (await pair.host.next('state')).match
    await pair.guest.next('state')

    for (const p of match.players) {
      const pending = match.players.find((x) => x.playerId === p.playerId)!.pendingPostFameChoice
      if (!pending) continue
      const client = p.playerId === pair.hostSeat.playerId ? pair.host : pair.guest
      client.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'resolvePostFameChoice', pos: pending.options[0].pos, index: pending.options[0].index } })
      match = (await client.next('state')).match
    }

    expect(match.shared.phase).toBe('market')
    const activeId = match.turnOrder[match.activePlayerIndex]
    const waiting = activeId === pair.hostSeat.playerId ? pair.guest : pair.host

    waiting.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'endTurn' } })
    const err = await waiting.next('error')
    expect(err.code).toBe('illegalAction')
    expect(err.message).toMatch(/isn't your turn/)

    pair.host.close()
    pair.guest.close()
  })

  test('an action from an unseated connection is refused', async () => {
    const pair = await seatedPair()
    await startGame(pair)
    const stranger = await connect()
    stranger.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const err = await stranger.next('error')
    expect(err.message).toMatch(/not seated/)
    stranger.close()
    pair.host.close()
    pair.guest.close()
  })

  test('actions are refused before the game starts', async () => {
    const pair = await seatedPair()
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const err = await pair.host.next('error')
    expect(err.message).toMatch(/not started/)
    pair.host.close()
    pair.guest.close()
  })
})

describe('reconnect', () => {
  test('a token reclaims the same seat mid-match, with the board and the backlog', async () => {
    const pair = await seatedPair()
    await startGame(pair)
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    await pair.host.next('state')
    await pair.guest.next('state')

    pair.guest.close()
    await new Promise((r) => setTimeout(r, 50))

    const back = await connect()
    back.send({ type: 'join', roomCode: pair.roomCode, name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    const seated = await back.next('seated')
    expect(seated.playerId).toBe(pair.guestSeat.playerId)

    // A reconnecting player needs the board, not just the lobby.
    const state = await back.next('state')
    expect(state.match.shared.phase).not.toBe('flip')
    expect(state.log!.length).toBeGreaterThan(0)

    back.close()
    pair.host.close()
  })

  test('a disconnect marks the seat away rather than freeing it', async () => {
    const pair = await seatedPair()
    pair.guest.close()
    // The host already has an earlier 'lobby' from Bo JOINING, so wait for the
    // one that actually reports the disconnect rather than the first to arrive.
    let lobby: LobbyState
    for (;;) {
      lobby = (await pair.host.next('lobby')).lobby
      if (!lobby.seats.find((s) => s.name === 'Bo')!.connected) break
    }
    expect(lobby.seats).toHaveLength(2) // the seat is still theirs, just away
    pair.host.close()
  })

  test('a bogus token falls through to taking a free seat, not an error', async () => {
    const host = await connect()
    host.send({ type: 'create', name: 'Ana', playerCount: 2, season: 1, seed: 1 })
    const seated = await host.next('seated')
    const guest = await connect()
    guest.send({ type: 'join', roomCode: seated.roomCode, name: 'Bo', reconnectToken: 'not-a-real-token' })
    const got = await guest.next('seated')
    expect(got.playerId).toBe('p1')
    host.close()
    guest.close()
  })
})

describe('log lines carry an actor', () => {
  test('the broadcast log is attributed and round-stamped', async () => {
    const pair = await seatedPair()
    await startGame(pair)
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const state = await pair.host.next('state')
    expect(state.logLines.length).toBeGreaterThan(0)
    for (const line of state.logLines) {
      expect(line).toHaveProperty('round')
      expect(line).toHaveProperty('playerId')
      expect(typeof line.text).toBe('string')
    }
    pair.host.close()
    pair.guest.close()
  })
})

describe('room lifecycle', () => {
  test('stale, abandoned rooms are evicted', async () => {
    const { evictStaleRooms, createRoom, getRoom, ROOM_TTL_MS } = await import('./rooms')
    const { roomCode, room } = createRoom({ name: 'Ana', playerCount: 2, season: 1, seed: 1 })
    room.seats.forEach((s) => (s.connected = false))
    room.lastActivity = Date.now() - ROOM_TTL_MS - 1000
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeUndefined()
  })

  test('an active room is not evicted', async () => {
    const { evictStaleRooms, createRoom, getRoom } = await import('./rooms')
    const { roomCode } = createRoom({ name: 'Ana', playerCount: 2, season: 1, seed: 1 })
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeDefined()
  })

  test('the log is capped so a long match cannot grow without bound', async () => {
    const { createRoom, MAX_LOG_LINES, applyRoomAction, startRoom } = await import('./rooms')
    const { room } = createRoom({ name: 'Ana', playerCount: 2, season: 1, seed: 1, fameToTriggerEndgame: 999 })
    startRoom(room)
    room.log = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => ({ playerId: null, round: 1, text: `line ${i}` }))
    applyRoomAction(room, room.match.turnOrder[0], { kind: 'advanceFlip' })
    expect(room.log.length).toBeLessThanOrEqual(MAX_LOG_LINES)
  })
})
