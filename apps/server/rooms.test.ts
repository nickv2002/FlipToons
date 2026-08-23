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
  host.send({ type: 'create', name: 'Ana', season: 1, seed: opts.seed ?? 11, fameToTriggerEndgame: opts.fameToTriggerEndgame ?? 999 })
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
    host.send({ type: 'create', name: 'Ana', season: 1, seed: 1 })
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
    host.send({ type: 'create', name: 'Ana', season: 1, seed: 1 })
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

  // Nobody declares a table size any more, so "full" means MAX_SEATS: the
  // third and fourth players get in, the fifth does not.
  test('a full room is refused with its own code', async () => {
    const pair = await seatedPair()
    const extras = []
    for (const name of ['Cy', 'Di']) {
      const c = await connect()
      c.send({ type: 'join', roomCode: pair.roomCode, name })
      await c.next('seated')
      extras.push(c)
    }

    const fifth = await connect()
    fifth.send({ type: 'join', roomCode: pair.roomCode, name: 'Ed' })
    const err = await fifth.next('error')
    expect(err.code).toBe('roomFull')

    fifth.close()
    for (const c of extras) c.close()
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
    // NOT 'flip'. The Flip takes no player input, so the server runs it as
    // part of starting (rooms.ts's advanceSharedPhases) — by the time anyone
    // is dealt the match, round 1 has already been revealed and scored.
    expect(match.shared.phase).not.toBe('flip')
    pair.host.close()
    pair.guest.close()
  })

  test('a lobby of one cannot be started', async () => {
    const { getRoom } = await import('./rooms')
    const host = await connect()
    host.send({ type: 'create', name: 'Ana', season: 1, seed: 41 })
    const seated = await host.next('seated')

    host.send({ type: 'start', roomCode: seated.roomCode })
    await host.next('error')
    expect(getRoom(seated.roomCode)!.started).toBe(false)
    host.close()
  })

  // The room is built for MAX_SEATS and rebuilt at the size that turned up, so
  // this shrink is the ordinary path. It must not renumber anyone: each
  // connection's seat was pinned at join time and is never re-read from the
  // message, so a seat id that drifted here would leave every player acting as
  // somebody who no longer exists.
  test('starting with three of four seats deals three boards and leaves the seats where they were', async () => {
    const pair = await seatedPair()
    const third = await connect()
    third.send({ type: 'join', roomCode: pair.roomCode, name: 'Cy' })
    const seatedThird = await third.next('seated')

    pair.host.send({ type: 'start', roomCode: pair.roomCode })
    const state = await pair.host.next('state')
    await pair.guest.next('state')
    await third.next('state')

    expect(state.match.turnOrder).toEqual(['p0', 'p1', 'p2'])
    expect(state.match.players).toHaveLength(3)
    expect([pair.hostSeat.playerId, pair.guestSeat.playerId, seatedThird.playerId]).toEqual(['p0', 'p1', 'p2'])

    // The host's ORIGINAL socket — pinned before the rebuild — can still act.
    // advanceFlip is now the server's own call, so sending it lands out of
    // phase — which is exactly the discriminating reply: an IllegalActionError
    // means the engine accepted the seat id and rejected the timing. A seat id
    // that had drifted in the rebuild would fail earlier and harder, in
    // match.ts's playerIndex, which throws a plain Error and surfaces as
    // 'serverError'.
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const stillSeated = await pair.host.next('error')
    expect(stillSeated.code).toBe('illegalAction')

    third.close()
    pair.host.close()
    pair.guest.close()
  })
})

describe('the security boundary: the actor is the seat, not the message', () => {
  test('a player cannot act during another player\'s Market turn', async () => {
    const pair = await seatedPair()
    // Starting already runs the Flip (rooms.ts), so this lands in
    // postFameHooks or Market. Answer any mandatory Skunk dismissal.
    let match = await startGame(pair)

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
    host.send({ type: 'create', name: 'Ana', season: 1, seed: 1 })
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
    // The server-run Flip is now the first thing that writes to the log, and
    // its lines reach a client through the start broadcast's `log`.
    pair.host.send({ type: 'start', roomCode: pair.roomCode })
    const state = await pair.host.next('state')
    await pair.guest.next('state')
    expect(state.log!.length).toBeGreaterThan(0)
    for (const line of state.log!) {
      expect(line).toHaveProperty('round')
      expect(line).toHaveProperty('playerId')
      expect(typeof line.text).toBe('string')
    }
    pair.host.close()
    pair.guest.close()
  })
})

describe('room lifecycle', () => {
  test('a room nobody has touched for the whole TTL is evicted', async () => {
    const { evictStaleRooms, createRoom, getRoom, ROOM_TTL_MS } = await import('./rooms')
    const { roomCode, room } = createRoom({ name: 'Ana', season: 1, seed: 1 })
    room.seats.forEach((s) => (s.connected = false))
    room.lastActivity = Date.now() - ROOM_TTL_MS - 1000
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeUndefined()
  })

  // Idleness alone evicts. Requiring the room to also be abandoned meant one
  // tab left open kept a forgotten game resident forever.
  test('a still-connected room is evicted too once it goes untouched for the TTL', async () => {
    const { evictStaleRooms, createRoom, getRoom, ROOM_TTL_MS } = await import('./rooms')
    const { roomCode, room } = createRoom({ name: 'Ana', season: 1, seed: 1 })
    let closed = false
    const socket = { close: () => (closed = true) } as unknown as Parameters<typeof room.sockets.add>[0]
    room.sockets.add(socket)
    room.seats.forEach((s) => (s.connected = true))
    room.lastActivity = Date.now() - ROOM_TTL_MS - 1000
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeUndefined()
    // The client is told, rather than left clicking at a room that is gone.
    expect(closed).toBe(true)
  })

  test('a room touched within the TTL survives, connected or not', async () => {
    const { evictStaleRooms, createRoom, getRoom, ROOM_TTL_MS } = await import('./rooms')
    const { roomCode, room } = createRoom({ name: 'Ana', season: 1, seed: 1 })
    room.seats.forEach((s) => (s.connected = false))
    room.lastActivity = Date.now() - (ROOM_TTL_MS - 60_000)
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeDefined()
  })

  test('an active room is not evicted', async () => {
    const { evictStaleRooms, createRoom, getRoom } = await import('./rooms')
    const { roomCode } = createRoom({ name: 'Ana', season: 1, seed: 1 })
    evictStaleRooms()
    expect(getRoom(roomCode)).toBeDefined()
  })

  // Over real sockets, because the fake-socket test above only proves the
  // eviction loop calls close() — not that a genuinely seated client is hung
  // up on, nor that index.ts's close handler survives firing against a room
  // that has just been deleted out from under it.
  test("an evicted room's live connections are closed, and the server stays healthy", async () => {
    const { getRoom, ROOM_TTL_MS } = await import('./rooms')
    const pair = await seatedPair()
    await startGame(pair)

    const room = getRoom(pair.roomCode)!
    room.lastActivity = Date.now() - ROOM_TTL_MS - 1000

    const closed = new Promise<void>((resolve) => pair.host.ws.addEventListener('close', () => resolve(), { once: true }))
    // Any message sweeps — evictStaleRooms runs at the top of handleMessage.
    const bystander = await connect()
    bystander.send({ type: 'create', name: 'Cy', season: 1, seed: 3 })
    await bystander.next('seated')

    await closed
    expect(getRoom(pair.roomCode)).toBeUndefined()
    // Nothing in the close path blew up on the room that no longer exists.
    expect(pair.guest.inbox.some((m) => m.type === 'serverError')).toBe(false)
    bystander.close()
    pair.host.close()
    pair.guest.close()
  })

  test('the log is capped so a long match cannot grow without bound', async () => {
    const { createRoom, MAX_LOG_LINES, applyRoomAction, startRoom } = await import('./rooms')
    const { room } = createRoom({ name: 'Ana', season: 1, seed: 1, fameToTriggerEndgame: 999 })
    startRoom(room)
    room.log = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => ({ playerId: null, round: 1, text: `line ${i}` }))
    applyRoomAction(room, room.match.turnOrder[0], { kind: 'advanceFlip' })
    expect(room.log.length).toBeLessThanOrEqual(MAX_LOG_LINES)
  })
})

// The Pig is the one card whose effect PAUSES a turn on a cross-player
// prompt: `pendingDeckPlacement` is set on the acting seat, and
// matchActions.ts refuses to close the turn until it is answered. Nothing had
// ever put that field on the wire, and a field that fails to serialize here
// deadlocks the whole table — the acting seat can neither answer the prompt
// nor end its turn. (PLAYER_FIELDS already proved once that a per-player
// field can be silently dropped in transit.)
describe('the Pig prompt crosses the wire', () => {
  test('hiring a Pig blocks the turn until a deck is chosen, and unblocks after', async () => {
    const { getRoom } = await import('./rooms')
    const pair = await seatedPair()
    await startGame(pair)

    // Park the room in the Market phase with a Pig the host can afford, and
    // pull the real Pig out of the toon deck so there is only one copy.
    const room = getRoom(pair.roomCode)!
    const m = room.match
    const market = {
      prices: m.shared.market.prices,
      slots: m.shared.market.slots.slice(),
      insertionSeq: m.shared.market.insertionSeq.slice(),
    }
    market.slots[0] = 'pig'
    const players = m.players.slice()
    const i = m.activePlayerIndex
    players[i] = { ...players[i], fame: market.prices[0] + 5, actionsRemaining: 2 }
    room.match = {
      ...m,
      shared: { ...m.shared, phase: 'market', market, toonDeck: m.shared.toonDeck.filter((id) => id !== 'pig') },
      players,
    }
    const actingSeat = room.match.turnOrder[i]
    const acting = actingSeat === pair.hostSeat.playerId ? pair.host : pair.guest
    const other = actingSeat === pair.hostSeat.playerId ? pair.guest : pair.host

    // (a) the prompt reaches the clients
    acting.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'hire', slotIndex: 0 } })
    const afterHire = await acting.next('state')
    expect(afterHire.match.players[i].pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'hire' })
    // ...and to the other seat too, since every board is public.
    const seenByOther = await other.next('state')
    expect(seenByOther.match.players[i].pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'hire' })

    // (b) the turn cannot be ended while it is owed
    acting.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'endTurn' } })
    const refused = await acting.next('error')
    expect(refused.code).toBe('illegalAction')
    expect(getRoom(pair.roomCode)!.match.activePlayerIndex).toBe(i)

    // (c) answering it clears the prompt and frees the turn
    acting.send({
      type: 'action',
      roomCode: pair.roomCode,
      action: { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } },
    })
    const answered = await acting.next('state')
    expect(answered.match.players[i].pendingDeckPlacement).toBeNull()

    acting.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'endTurn' } })
    const ended = await acting.next('state')
    expect(ended.match.activePlayerIndex).not.toBe(i)

    pair.host.close()
    pair.guest.close()
  })
})

// The room a message claims is a client-supplied string; the room a connection
// actually sits in is not. These stay separate because seat ids are `p0..p3`
// in EVERY room and every room's creator is `p0` — so if the room were looked
// up by the message's code, a connection could create a throwaway room, become
// its p0, and then start (or act inside) anyone else's room by naming its code.
describe('cross-room isolation', () => {
  test('a connection cannot act in a room it is not seated in', async () => {
    const victim = await seatedPair({ seed: 21 })
    await startGame(victim)

    // The attacker is p0 of its OWN room — the same seat id the victim's host
    // holds, which is what used to make the check pass.
    const attacker = await connect()
    attacker.send({ type: 'create', name: 'Mallory', season: 1, seed: 22 })
    const attackerSeat = await attacker.next('seated')
    expect(attackerSeat.playerId).toBe('p0')

    // advanceFlip is deliberately not turn-gated, so it is the action with the
    // fewest preconditions standing between an outsider and the victim's game.
    attacker.send({ type: 'action', roomCode: victim.roomCode, action: { kind: 'advanceFlip' } })
    const refused = await attacker.next('error')
    expect(refused.code).toBe('noSuchRoom')

    // ...and the victim's table saw nothing at all.
    expect(victim.host.inbox.some((m) => m.type === 'state')).toBe(false)

    victim.host.close()
    victim.guest.close()
    attacker.close()
  })

  test('a connection cannot start a lobby it is not seated in', async () => {
    const { getRoom } = await import('./rooms')
    const victimHost = await connect()
    victimHost.send({ type: 'create', name: 'Ana', season: 1, seed: 23 })
    const victimSeat = await victimHost.next('seated')
    const victimGuest = await connect()
    victimGuest.send({ type: 'join', roomCode: victimSeat.roomCode, name: 'Bo' })
    await victimGuest.next('seated')

    const attacker = await connect()
    attacker.send({ type: 'create', name: 'Mallory', season: 1, seed: 24 })
    await attacker.next('seated')

    attacker.send({ type: 'start', roomCode: victimSeat.roomCode })
    const refused = await attacker.next('error')
    expect(refused.code).toBe('noSuchRoom')
    expect(getRoom(victimSeat.roomCode)!.started).toBe(false)

    victimHost.close()
    victimGuest.close()
    attacker.close()
  })
})

// Everything below the socket is typed, but nothing above it is: a message is
// whatever JSON.parse returned. These are the shapes a stale client or a
// fuzzer produces, and none of them should read as an engine bug.
describe('malformed messages', () => {
  test('an unknown action kind is a player mistake, not a server error', async () => {
    const pair = await seatedPair({ seed: 31 })
    await startGame(pair)

    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'teleport' } } as unknown as ClientMessage)
    const err = await pair.host.next('error')
    expect(err.code).toBe('illegalAction')
    expect(err.message).toMatch(/teleport/)

    // The room is untouched: a real action still reaches the engine and comes
    // back with an engine-level answer rather than an identity complaint.
    pair.host.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const after = await pair.host.next('error')
    expect(after.code).toBe('illegalAction')
    expect(after.message).toMatch(/Nothing to reveal/)

    pair.host.close()
    pair.guest.close()
  })

  test('a create with a garbage season still yields a room rather than throwing', async () => {
    const client = await connect()
    client.send({ type: 'create', name: 'Ana', season: 'winter', seed: 33 } as unknown as ClientMessage)
    const seated = await client.next('seated')
    expect(seated.roomCode).toHaveLength(5)
    // The server is still answering after it.
    const after = await connect()
    after.send({ type: 'create', name: 'Bo', season: 1, seed: 34 })
    await after.next('seated')
    client.close()
    after.close()
  })
})

// A dropped connection is often noticed late — the reconnect can land before
// the old socket's close event ever arrives. Whoever closes last must not get
// to decide whether the player is present.
describe('a seat belongs to one connection at a time', () => {
  test('a stale socket closing after a reconnect does not mark the seat away', async () => {
    const { getRoom } = await import('./rooms')
    const pair = await seatedPair({ seed: 41 })
    await startGame(pair)

    // The guest comes back on a NEW socket while the old one is still open —
    // the two-tabs case, and what a network blip looks like from here.
    const revived = await connect()
    revived.send({ type: 'join', roomCode: pair.roomCode, name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    const reseated = await revived.next('seated')
    expect(reseated.playerId).toBe(pair.guestSeat.playerId)

    // Now the original drops.
    pair.guest.close()
    await new Promise((r) => setTimeout(r, 100))

    const seat = getRoom(pair.roomCode)!.seats.find((s) => s.playerId === pair.guestSeat.playerId)!
    expect(seat.connected).toBe(true)

    // ...and the live socket can still act: the reply is an engine-level
    // complaint about timing, not "you are not seated".
    revived.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'advanceFlip' } })
    const acted = await revived.next('error')
    expect(acted.code).toBe('illegalAction')

    pair.host.close()
    revived.close()
  })

  test('the seat is still marked away when its own socket closes', async () => {
    const { getRoom } = await import('./rooms')
    const pair = await seatedPair({ seed: 42 })
    await startGame(pair)

    // The inbox already holds the lobby updates from seating, so drain it
    // first — otherwise next('lobby') returns one of those instead of the
    // disconnection we are waiting for.
    pair.host.inbox.length = 0
    pair.guest.close()
    const dropped = await pair.host.next('lobby')
    expect(dropped.lobby.seats.find((s) => s.playerId === pair.guestSeat.playerId)!.connected).toBe(false)

    const seat = getRoom(pair.roomCode)!.seats.find((s) => s.playerId === pair.guestSeat.playerId)!
    expect(seat.connected).toBe(false)

    pair.host.close()
  })
})

describe('the host role does not strand a lobby', () => {
  test('a host who drops before starting hands the role to someone still there', async () => {
    const { getRoom } = await import('./rooms')
    const pair = await seatedPair({ seed: 51 })
    expect(getRoom(pair.roomCode)!.hostPlayerId).toBe(pair.hostSeat.playerId)

    pair.guest.inbox.length = 0
    pair.host.close()
    const lobby = await pair.guest.next('lobby')
    expect(lobby.lobby.seats.find((s) => s.playerId === pair.guestSeat.playerId)!.isHost).toBe(true)

    // ...and the new host can actually start the game.
    pair.guest.send({ type: 'start', roomCode: pair.roomCode })
    const state = await pair.guest.next('state')
    expect(state.match.players).toHaveLength(2)

    pair.guest.close()
  })

  test('the role stays put once the game is underway', async () => {
    const { getRoom } = await import('./rooms')
    const pair = await seatedPair({ seed: 52 })
    await startGame(pair)

    pair.guest.inbox.length = 0
    pair.host.close()
    await pair.guest.next('lobby')
    expect(getRoom(pair.roomCode)!.hostPlayerId).toBe(pair.hostSeat.playerId)

    pair.guest.close()
  })
})

// A dropped connection used to stall everyone else until the room's idle
// TTL. These re-arm the timer with a short delay rather than waiting out
// TURN_TIMEOUT_MS — the mechanism is what's under test, not the duration.
describe('a seat nobody is holding does not stall the table', () => {
  test("the absent seat's turn is played for it, and the turn passes", async () => {
    const { getRoom, armTurnTimeout } = await import('./rooms')
    const pair = await seatedPair({ seed: 61 })

    // Starting already flipped; walk on into the Market phase, where turns
    // are strictly ordered.
    let state = { match: await startGame(pair) } as { match: Match }
    while (state.match.shared.phase !== 'market') {
      const owing = state.match.players.findIndex((p) => p.pendingPostFameChoice)
      if (owing < 0) break
      const who = owing === 0 ? pair.host : pair.guest
      const option = state.match.players[owing].pendingPostFameChoice!.options[0]
      who.send({ type: 'action', roomCode: pair.roomCode, action: { kind: 'resolvePostFameChoice', pos: option.pos, index: option.index } })
      state = await who.next('state')
    }
    expect(state.match.shared.phase).toBe('market')

    const room = getRoom(pair.roomCode)!
    const upIndex = room.match.activePlayerIndex
    const up = upIndex === 0 ? pair.host : pair.guest
    const other = upIndex === 0 ? pair.guest : pair.host

    other.inbox.length = 0
    up.close()
    await other.next('lobby')
    armTurnTimeout(room, 30)

    // The other seat is told, and the turn has moved on.
    const skipped = await other.next('state', 3000)
    expect(skipped.match.activePlayerIndex).not.toBe(upIndex)
    expect(skipped.logLines.some((l) => /skipped/.test(l.text))).toBe(true)

    other.close()
  })

  test('coming back before the clock runs out cancels it', async () => {
    const { getRoom, armTurnTimeout } = await import('./rooms')
    const pair = await seatedPair({ seed: 62 })
    await startGame(pair)

    const room = getRoom(pair.roomCode)!
    // Force a known Market-phase turn rather than depending on the shuffle.
    // The prompts have to go too: the Flip now runs as part of starting, and
    // strandingSeat answers on a pending post-fame choice BEFORE it looks at
    // whose Market turn it is.
    room.match = {
      ...room.match,
      shared: { ...room.match.shared, phase: 'market' },
      activePlayerIndex: 1,
      players: room.match.players.map((p) => ({ ...p, pendingPostFameChoice: null })),
    }

    pair.host.inbox.length = 0
    pair.guest.close()
    await pair.host.next('lobby')
    armTurnTimeout(room, 5_000)
    expect(room.turnTimer).toBeDefined()

    const revived = await connect()
    revived.send({ type: 'join', roomCode: pair.roomCode, name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    await revived.next('seated')

    // Back in their seat, back off the clock.
    expect(room.turnTimer).toBeUndefined()

    pair.host.close()
    revived.close()
  })

  test('a present player is never on a clock', async () => {
    const { getRoom, armTurnTimeout } = await import('./rooms')
    const pair = await seatedPair({ seed: 63 })
    await startGame(pair)

    const room = getRoom(pair.roomCode)!
    // Prompts cleared for the same reason as the test above: strandingSeat
    // answers on a pending post-fame choice before it looks at whose turn it
    // is, and this test is about the turn.
    room.match = {
      ...room.match,
      shared: { ...room.match.shared, phase: 'market' },
      activePlayerIndex: 0,
      players: room.match.players.map((p) => ({ ...p, pendingPostFameChoice: null })),
    }
    armTurnTimeout(room, 30)

    // Taking a long time to decide is not a disconnection.
    expect(room.turnTimer).toBeUndefined()

    pair.host.close()
    pair.guest.close()
  })
})

// The skip above only ever needed to press "end turn". These drive the three
// prompt branches, which are the ones that matter: if one of them throws, the
// skip catches it, logs, and gives up — and the table stays stranded, silently,
// which is the exact thing the timeout exists to prevent.
describe('skipping an absent seat answers whatever it owes first', () => {
  test('a pending post-Market choice is answered on their behalf', async () => {
    const { getRoom, armTurnTimeout } = await import('./rooms')
    const { emptyGrid, placeCardFaceUp } = await import('../../packages/engine/grid')
    const pair = await seatedPair({ seed: 71 })
    await startGame(pair)

    // Force the one grid that stops a turn halfway: an Alligator with two
    // eligible cards in the slot to its right.
    const room = getRoom(pair.roomCode)!
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'snail')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
    room.match = {
      ...room.match,
      shared: { ...room.match.shared, phase: 'market' },
      activePlayerIndex: 1,
      players: room.match.players.map((p, i) => (i === 1 ? { ...p, grid, actionsRemaining: 0, pendingPostFameChoice: null } : { ...p, pendingPostFameChoice: null })),
    }

    const roundBefore = room.match.shared.round
    pair.host.inbox.length = 0
    pair.guest.close()
    await pair.host.next('lobby')
    // index.ts arms this itself on the disconnection — check that before
    // re-arming with a short delay for the test's sake.
    expect(room.turnTimer).toBeDefined()
    armTurnTimeout(room, 30)

    const skipped = await pair.host.next('state', 3000)
    // The prompt was answered, not abandoned...
    expect(skipped.match.players[1].pendingPostMarketChoice).toBeNull()
    expect(skipped.match.players[1].dismissed).toHaveLength(1)
    // ...and the table is no longer waiting on that seat. Seat 1 is the LAST
    // in a two-player order, so ending its turn wraps and closes the Market
    // phase for everyone rather than moving activePlayerIndex. The ROUND is
    // what to assert on: Cleanup now rolls straight into the next round's
    // server-run Flip, so the phase lands back on 'market' within the same
    // broadcast.
    expect(skipped.match.shared.round).toBeGreaterThan(roundBefore)

    pair.host.close()
  })

  test('a pending deck placement is answered on their behalf', async () => {
    const { getRoom, armTurnTimeout } = await import('./rooms')
    const pair = await seatedPair({ seed: 72 })
    await startGame(pair)

    const room = getRoom(pair.roomCode)!
    room.match = {
      ...room.match,
      shared: { ...room.match.shared, phase: 'market' },
      activePlayerIndex: 1,
      players: room.match.players.map((p, i) =>
        i === 1
          ? { ...p, actionsRemaining: 0, pendingPostFameChoice: null, pendingDeckPlacement: { cardId: 'pig', source: 'hire' } }
          : { ...p, pendingPostFameChoice: null },
      ),
    }

    const roundBefore = room.match.shared.round
    pair.host.inbox.length = 0
    pair.guest.close()
    await pair.host.next('lobby')
    armTurnTimeout(room, 30)

    const skipped = await pair.host.next('state', 3000)
    expect(skipped.match.players[1].pendingDeckPlacement).toBeNull()
    // See the round-vs-phase note in the Alligator test above.
    expect(skipped.match.shared.round).toBeGreaterThan(roundBefore)

    pair.host.close()
  })
})

// The Flip asks nobody for anything: every seat reveals at once and the action
// was never turn- or host-gated. A button for it was therefore a shared
// control with no owner — whoever clicked first won, and everyone else got
// "Nothing to reveal right now". The server runs it instead.
describe('the flip runs itself', () => {
  test('starting a room reveals round 1 without anyone acting', async () => {
    const { createRoom, startRoom } = await import('./rooms')
    const { room } = createRoom({ name: 'Ana', season: 1, seed: 81, fameToTriggerEndgame: 999 })
    room.seats.push({ playerId: 'p1', name: 'Bo', reconnectToken: 't', connected: true })
    startRoom(room)

    expect(room.match.shared.phase).not.toBe('flip')
    // Cards are on the table, and the reveal is in the log the start
    // broadcast carries.
    expect(room.match.players.every((p) => p.grid.base.flat().some((s) => s !== null))).toBe(true)
    expect(room.log.length).toBeGreaterThan(0)
  })

  test('a round that ends rolls straight on into the next reveal', async () => {
    const { createRoom, startRoom, applyRoomAction } = await import('./rooms')
    const { room } = createRoom({ name: 'Ana', season: 1, seed: 82, fameToTriggerEndgame: 999 })
    room.seats.push({ playerId: 'p1', name: 'Bo', reconnectToken: 't', connected: true })
    startRoom(room)

    const roundBefore = room.match.shared.round
    for (let i = 0; i < 12 && room.match.shared.round === roundBefore; i++) {
      const owing = room.match.players.find((p) => p.pendingPostFameChoice)
      if (owing) {
        const o = owing.pendingPostFameChoice!.options[0]
        applyRoomAction(room, owing.playerId, { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index })
        continue
      }
      applyRoomAction(room, room.match.turnOrder[room.match.activePlayerIndex], { kind: 'endTurn' })
    }

    expect(room.match.shared.round).toBe(roundBefore + 1)
    // Never parked on the reveal, and never on Cleanup either.
    expect(['flip', 'cleanup']).not.toContain(room.match.shared.phase)
  })

  // The Final Flip is the same deal, so `phase === 'finalFlip'` now only ever
  // exists inside one server tick: the endgame arrives in the SAME broadcast
  // as the market action that triggered it.
  test('the Final Flip resolves the match without a click', async () => {
    const { createRoom, startRoom, applyRoomAction } = await import('./rooms')
    const { room } = createRoom({ name: 'Ana', season: 1, seed: 83, fameToTriggerEndgame: 1 })
    room.seats.push({ playerId: 'p1', name: 'Bo', reconnectToken: 't', connected: true })
    startRoom(room)

    for (let i = 0; i < 12 && room.match.shared.phase !== 'ended'; i++) {
      const owing = room.match.players.find((p) => p.pendingPostFameChoice)
      if (owing) {
        const o = owing.pendingPostFameChoice!.options[0]
        applyRoomAction(room, owing.playerId, { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index })
        continue
      }
      applyRoomAction(room, room.match.turnOrder[room.match.activePlayerIndex], { kind: 'endTurn' })
    }

    expect(room.match.shared.endgameTriggered).toBe(true)
    expect(room.match.shared.phase).toBe('ended')
  })
})
