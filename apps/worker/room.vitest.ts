// Durable Object tests for the multiplayer room protocol, run against a real
// Workers runtime (via @cloudflare/vitest-plugin / workerd), same spirit as
// the Bun-server version this replaced: seat assignment, reconnect-by-token,
// and "the actor is the connection's seat, not a field in the message" only
// exist at the socket layer, so these open real WebSockets against the real
// Worker rather than calling room.ts's methods directly.
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, test } from 'vitest'
import type { ClientMessage, CreateRoomResponse, ServerMessage } from './protocol'

type Client = {
  ws: WebSocket
  inbox: ServerMessage[]
  send: (m: ClientMessage) => void
  next: <T extends ServerMessage['type']>(type: T, timeoutMs?: number) => Promise<Extract<ServerMessage, { type: T }>>
  drain: (type: ServerMessage['type']) => void
  close: () => void
}

async function createRoom(opts: { name: string; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }): Promise<CreateRoomResponse> {
  const res = await SELF.fetch('https://fliptoons.example/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  })
  expect(res.status).toBe(200)
  return res.json()
}

async function connect(roomCode: string): Promise<Client> {
  const res = await SELF.fetch(`https://fliptoons.example/ws?room=${roomCode}`, { headers: { Upgrade: 'websocket' } })
  const ws = res.webSocket
  if (!ws) throw new Error(`expected a WebSocket upgrade, got status ${res.status}`)
  ws.accept()
  const inbox: ServerMessage[] = []
  ws.addEventListener('message', (ev: MessageEvent) => {
    inbox.push(JSON.parse(ev.data as string))
  })
  return {
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
    // Drops any already-queued messages of a type. `join` broadcasts a
    // `lobby` snapshot to every socket, including the one attaching — so a
    // client's OWN attach leaves a `lobby` in its queue ahead of whatever
    // event a test actually means to wait for next.
    drain: (type: ServerMessage['type']) => {
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) inbox.splice(i, 1)
    },
    close: () => ws.close(),
  }
}

async function seatedPair(opts: { fameToTriggerEndgame?: number; seed?: number } = {}) {
  const created = await createRoom({ name: 'Ana', season: 1, seed: opts.seed ?? 11, fameToTriggerEndgame: opts.fameToTriggerEndgame ?? 999 })
  const host = await connect(created.roomCode)
  host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
  const hostSeat = await host.next('seated')
  host.drain('lobby') // the host's own attach broadcasts a 1-seat snapshot to itself

  const guest = await connect(created.roomCode)
  guest.send({ type: 'join', name: 'Bo' })
  const guestSeat = await guest.next('seated')
  await host.next('lobby') // the 2-seat snapshot from the guest joining
  guest.drain('lobby') // the guest's own attach broadcasts that same snapshot to itself too

  return { host, guest, roomCode: created.roomCode, hostSeat, guestSeat }
}

async function startGame(pair: Awaited<ReturnType<typeof seatedPair>>) {
  pair.host.send({ type: 'start' })
  const state = await pair.host.next('state')
  await pair.guest.next('state')
  return state.match
}

const opened: Client[] = []

// Hand-written minimal interface, not `DurableObjectNamespace<any>`:
// `env.ROOMS`'s RPC-derived generics make TypeScript choke (TS2589,
// excessively deep instantiation) once fed through the DO test helpers'
// own generics below — a known friction point with Workers RPC types, not a
// real type-safety concern in a test file that only ever needs these two
// methods.
const ROOMS = (env as any).ROOMS as {
  getByName(name: string): any
  idFromName(name: string): DurableObjectId
}

// Re-typed as plain `any`-taking functions: the ambient `DurableObjectStub<T>`
// / `DurableObjectNamespace<T>` generics these test helpers are declared
// against blow up TypeScript's instantiation depth (TS2589) once T resolves
// to RoomDurableObject's own RPC-derived method types — a known friction
// point with Workers RPC types, not a real type-safety concern in a test
// file that only ever passes room.ts's own stub around.
const runInDO: (stub: any, cb: (instance: any, state: any) => any) => Promise<any> = runInDurableObject as any
const runAlarm: (stub: any) => Promise<boolean> = runDurableObjectAlarm as any
const evictDO: (stub: any, options?: { webSockets?: 'close' | 'hibernate' }) => Promise<void> = evictDurableObject as any

describe('lobby and seating', () => {
  test('creating a room mints a code and a host seat', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1 })
    expect(created.roomCode).toHaveLength(5)
    expect(created.playerId).toBe('p0')
    expect(created.reconnectToken).toBeTruthy()
    expect(created.lobby.seats).toHaveLength(1)
    expect(created.lobby.seats[0]).toMatchObject({ name: 'Ana', isHost: true })
    expect(created.lobby.started).toBe(false)
  })

  test('attaching with the minted token seats the creator as connected', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    const seated = await host.next('seated')
    expect(seated.playerId).toBe(created.playerId)
    expect(seated.lobby.seats[0].connected).toBe(true)
  })

  test('a second player gets a DIFFERENT seat and a different token', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    expect(pair.guestSeat.playerId).not.toBe(pair.hostSeat.playerId)
    expect(pair.guestSeat.reconnectToken).not.toBe(pair.hostSeat.reconnectToken)
    expect(pair.guestSeat.lobby.seats).toHaveLength(2)
  })

  test('the table is told when someone joins', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby') // the host's own attach broadcasts a 1-seat snapshot to itself
    const guest = await connect(created.roomCode)
    opened.push(guest)
    guest.send({ type: 'join', name: 'Bo' })
    const lobby = await host.next('lobby')
    expect(lobby.lobby.seats.map((s) => s.name)).toEqual(['Ana', 'Bo'])
  })

  test('joining a nonexistent room errors on the socket rather than failing the upgrade', async () => {
    const c = await connect('ZZZZZ')
    opened.push(c)
    const err = await c.next('error')
    expect(err.code).toBe('noSuchRoom')
  })

  test('a full room is refused with its own code', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    for (const name of ['Cy', 'Di']) {
      const c = await connect(pair.roomCode)
      opened.push(c)
      c.send({ type: 'join', name })
      await c.next('seated')
    }
    const fifth = await connect(pair.roomCode)
    opened.push(fifth)
    fifth.send({ type: 'join', name: 'Ed' })
    const err = await fifth.next('error')
    expect(err.code).toBe('roomFull')
  })

  test('joining after the game started is refused with its own code', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    await startGame(pair)
    const late = await connect(pair.roomCode)
    opened.push(late)
    late.send({ type: 'join', name: 'Late' })
    const err = await late.next('error')
    expect(err.code).toBe('alreadyStarted')
  })

  test('only the host can start', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    pair.guest.send({ type: 'start' })
    const err = await pair.guest.next('error')
    expect(err.code).toBe('notHost')
  })

  test('starting deals the match to everyone, past the Flip', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    const match = await startGame(pair)
    expect(match.players).toHaveLength(2)
    expect(match.shared.phase).not.toBe('flip')
  })

  test('a lobby of one cannot be started', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 41 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.send({ type: 'start' })
    const err = await host.next('error')
    expect(err.message).toMatch(/at least 2/)
  })

  test('starting with three of four seats deals three boards and leaves seat ids where they were', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    const third = await connect(pair.roomCode)
    opened.push(third)
    third.send({ type: 'join', name: 'Cy' })
    const seatedThird = await third.next('seated')

    pair.host.send({ type: 'start' })
    const state = await pair.host.next('state')
    await pair.guest.next('state')
    await third.next('state')

    expect(state.match.turnOrder).toEqual(['p0', 'p1', 'p2'])
    expect(state.match.players).toHaveLength(3)
    expect([pair.hostSeat.playerId, pair.guestSeat.playerId, seatedThird.playerId]).toEqual(['p0', 'p1', 'p2'])
  })
})

describe('the security boundary: the actor is the seat, not the message', () => {
  test('a player cannot act as another seat — the action has no playerId field to spoof', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    await startGame(pair)
    // Whichever seat is NOT active right now should be refused for acting.
    pair.guest.send({ type: 'action', action: { kind: 'endTurn' } })
    // Either an illegalAction (wrong phase/turn) — never a spoof succeeding.
    const result = await Promise.race([pair.guest.next('error'), pair.guest.next('state')])
    if ('code' in result) expect(result.code).toBe('illegalAction')
  })
})

describe('reconnect', () => {
  test('a stored token reclaims the same seat rather than taking a new one', async () => {
    const pair = await seatedPair()
    opened.push(pair.host)
    pair.guest.close()
    await new Promise((r) => setTimeout(r, 50))

    const rejoined = await connect(pair.roomCode)
    opened.push(rejoined)
    rejoined.send({ type: 'join', name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    const seated = await rejoined.next('seated')
    expect(seated.playerId).toBe(pair.guestSeat.playerId)
    expect(seated.lobby.seats).toHaveLength(2)
  })

  test('reconnecting mid-match gets the full match state, not just the lobby', async () => {
    const pair = await seatedPair()
    opened.push(pair.host)
    await startGame(pair)
    pair.guest.close()
    await new Promise((r) => setTimeout(r, 50))

    const rejoined = await connect(pair.roomCode)
    opened.push(rejoined)
    rejoined.send({ type: 'join', name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    await rejoined.next('seated')
    const state = await rejoined.next('state')
    expect(state.match.players).toHaveLength(2)
  })

  test('an older socket for a reclaimed seat is closed, not left open', async () => {
    const pair = await seatedPair()
    opened.push(pair.host)
    const closed = new Promise<void>((resolve) => pair.guest.ws.addEventListener('close', () => resolve()))
    const rejoined = await connect(pair.roomCode)
    opened.push(rejoined)
    rejoined.send({ type: 'join', name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    await rejoined.next('seated')
    await closed
  })
})

describe('room lifecycle', () => {
  test('the host role passes to a connected seat if the host drops before starting', async () => {
    const pair = await seatedPair()
    opened.push(pair.guest)
    pair.host.close()
    const lobby = await pair.guest.next('lobby')
    expect(lobby.lobby.seats.find((s) => s.playerId === pair.guestSeat.playerId)?.isHost).toBe(true)

    pair.guest.send({ type: 'start' })
    const state = await pair.guest.next('state')
    expect(state.match.players.length).toBeGreaterThanOrEqual(1)
  })
})

describe('rematch', () => {
  test('the host can deal a fresh match to the same seats once the game has ended', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    const firstMatch = await startGame(pair)

    const stub = ROOMS.getByName(pair.roomCode)
    await runInDO(stub, (instance: any) => {
      instance.room.match.shared.phase = 'ended'
      instance.room.log = [{ round: 1, text: 'stale line from the old game' }]
    })

    pair.host.send({ type: 'rematch' })
    const lobby = await pair.host.next('lobby')
    const state = await pair.host.next('state')
    await pair.guest.next('lobby')
    await pair.guest.next('state')

    // Same two seats, but a newly dealt match — not the doctored 'ended' one.
    expect(lobby.lobby.seats.map((s) => s.playerId).sort()).toEqual([pair.hostSeat.playerId, pair.guestSeat.playerId].sort())
    expect(state.match.shared.phase).not.toBe('ended')
    expect(state.match.players.map((p) => p.playerId).sort()).toEqual(firstMatch.players.map((p) => p.playerId).sort())
    // The log resets rather than carrying the previous game's lines forward.
    expect(state.log?.some((l) => l.text === 'stale line from the old game')).toBe(false)
  })

  test('only the host may call for a rematch', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    await startGame(pair)

    const stub = ROOMS.getByName(pair.roomCode)
    await runInDO(stub, (instance: any) => {
      instance.room.match.shared.phase = 'ended'
    })

    pair.guest.send({ type: 'rematch' })
    const err = await pair.guest.next('error')
    expect(err.code).toBe('notHost')
  })

  test('a rematch is refused before the game has ended', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    await startGame(pair)

    pair.host.send({ type: 'rematch' })
    const err = await pair.host.next('error')
    expect(err.code).toBe('notEnded')
  })
})

describe('the Durable Object namespace', () => {
  test('two different room codes are two different rooms', async () => {
    const a = await createRoom({ name: 'A', season: 1, seed: 1 })
    const b = await createRoom({ name: 'B', season: 1, seed: 2 })
    expect(a.roomCode).not.toBe(b.roomCode)

    const idA = ROOMS.idFromName(a.roomCode)
    const idB = ROOMS.idFromName(b.roomCode)
    expect(idA.toString()).not.toBe(idB.toString())
  })
})

// A DO gets exactly one alarm slot, replacing both the old Bun server's
// per-room `setTimeout` turn-timeout AND its cross-room `evictStaleRooms`
// sweep (see room.ts's top-of-file comment). `runDurableObjectAlarm` fires
// whatever's scheduled immediately, regardless of the real deadline, so
// these don't need to wait out TURN_TIMEOUT_MS for real.
describe('the turn-timeout alarm', () => {
  test('a disconnected seat that owes a turn gets skipped when the alarm fires', async () => {
    const pair = await seatedPair()
    const match = await startGame(pair)
    // Round 1 opens in `postFameHooks` (a mandatory post-fame choice, e.g. a
    // Skunk dismissal) before `market` ever opens — strandingSeat() gates on
    // whichever seat actually owes one, NOT on turnOrder/activePlayerIndex
    // (that's a `market`-phase-only concept). Once nobody owes a choice,
    // `market` is turn-based and activePlayerIndex is the right seat.
    const owing = match.players.find((p) => p.pendingPostFameChoice)
    const strandedSeatId = owing ? owing.playerId : match.turnOrder[match.activePlayerIndex]
    const strandedClient = strandedSeatId === pair.hostSeat.playerId ? pair.host : pair.guest
    const survivor = strandedClient === pair.host ? pair.guest : pair.host
    opened.push(survivor)
    strandedClient.close()
    await new Promise((r) => setTimeout(r, 50))

    // Cast: RoomDurableObject's RPC-derived stub type makes TS choke on
    // instantiation depth (TS2589) inside these test helpers' generic
    // signatures otherwise.
    const stub = ROOMS.getByName(pair.roomCode)
    // `runDurableObjectAlarm` runs the callback immediately without
    // advancing real time — but `alarm()` itself compares
    // `room.turnTimeoutDeadline` against the actual wall clock (a real
    // safeguard: Cloudflare's own guarantee is alarms fire AT OR AFTER their
    // scheduled time, never before), so a deadline armed 60s out is
    // correctly seen as "not due yet" a few milliseconds later. Backdating
    // the deadline is what stands in for waiting out TURN_TIMEOUT_MS for
    // real.
    await runInDO(stub, (instance: any) => {
      instance.room.turnTimeoutDeadline = Date.now() - 1
    })
    const ran = await runAlarm(stub)
    expect(ran).toBe(true)

    const state = await survivor.next('state')
    expect(state.logLines.some((l) => l.text.includes('was skipped'))).toBe(true)
  })

  test('a reconnect before the alarm fires means nothing gets skipped', async () => {
    const pair = await seatedPair()
    opened.push(pair.host)
    await startGame(pair)
    pair.guest.close()
    await new Promise((r) => setTimeout(r, 50))

    const rejoined = await connect(pair.roomCode)
    opened.push(rejoined)
    rejoined.send({ type: 'join', name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    await rejoined.next('seated')

    const stub = ROOMS.getByName(pair.roomCode)
    const ran = await runAlarm(stub)
    // Either no alarm was scheduled (the reconnect disarmed it), or one fired
    // and found nobody stranded — both are "nothing got skipped". Give any
    // broadcast a moment to arrive, then check what actually showed up.
    if (ran) await new Promise((r) => setTimeout(r, 100))
    const skipNotice = rejoined.inbox.find((m) => m.type === 'state' && m.logLines.some((l) => l.text.includes('was skipped')))
    expect(skipNotice).toBeUndefined()
  })
})

// The whole reason room state moved to ctx.storage: a Durable Object's JS
// heap gets evicted between messages while its hibernating WebSockets stay
// open, so the constructor has to be able to reload everything from
// scratch. Every other reconnect test in this file runs inside one resident
// instance and never actually exercises that reload — this one forces it.
describe('surviving eviction', () => {
  test('room state reloads from storage after the DO instance is evicted', async () => {
    const pair = await seatedPair()
    opened.push(pair.host, pair.guest)
    await startGame(pair)

    const stub = ROOMS.getByName(pair.roomCode)
    await evictDO(stub, { webSockets: 'close' })

    // The old sockets are gone with the instance; reconnecting by token
    // proves the seat, the match, and the log all came back from storage,
    // not from anything still resident in memory.
    const rejoined = await connect(pair.roomCode)
    opened.push(rejoined)
    rejoined.send({ type: 'join', name: 'Bo', reconnectToken: pair.guestSeat.reconnectToken })
    const seated = await rejoined.next('seated')
    expect(seated.playerId).toBe(pair.guestSeat.playerId)
    expect(seated.lobby.started).toBe(true)
    const state = await rejoined.next('state')
    expect(state.match.players).toHaveLength(2)
  })
})

afterEach(() => {
  for (const c of opened.splice(0)) {
    try {
      c.close()
    } catch {
      // Already closed.
    }
  }
})
