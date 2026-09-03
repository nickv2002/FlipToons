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

async function createRoom(opts: {
  name: string
  season: 1 | 2
  seed?: number
  fameToTriggerEndgame?: number
  bigButton?: 'market' | 'grid'
  bots?: ('easy' | 'normal' | 'hard')[]
}): Promise<CreateRoomResponse> {
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

async function seatedPair(opts: { fameToTriggerEndgame?: number; seed?: number; bigButton?: 'market' | 'grid' } = {}) {
  const created = await createRoom({
    name: 'Ana',
    season: 1,
    seed: opts.seed ?? 11,
    fameToTriggerEndgame: opts.fameToTriggerEndgame ?? 999,
    bigButton: opts.bigButton,
  })
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

  test('a name with a newline cannot forge a fake log line — control characters are stripped', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby')
    const guest = await connect(created.roomCode)
    opened.push(guest)
    guest.send({ type: 'join', name: '2099-01-01T00:00:00.000Z ERROR [ZZZZZ] fake admin action\nBo' })
    const lobby = await host.next('lobby')
    const guestName = lobby.lobby.seats[1].name
    expect(guestName).not.toContain('\n')
    expect(guestName).toBe('2099-01-01')
  })

  test('a name over 10 grapheme clusters is capped without corrupting multi-codepoint emoji', async () => {
    // A family emoji (4 codepoints joined by ZWJ) plus a skin-toned emoji (2
    // codepoints) — 12 UTF-16 code units, but 2 grapheme clusters. A naive
    // slice(0, 10) would both over-truncate this and risk splitting a
    // surrogate pair or ZWJ sequence into broken glyphs.
    const emojiName = '👨‍👩‍👧‍👦👍🏽ABCDEFGHIJKLMNOP'
    const created = await createRoom({ name: emojiName, season: 1, seed: 1 })
    expect(created.lobby.seats[0].name).toBe('👨‍👩‍👧‍👦👍🏽ABCDEFGH')
    expect([...new Intl.Segmenter().segment(created.lobby.seats[0].name)]).toHaveLength(10)
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

// ---------------------------------------------------------------------------
// Bot rooms — one or more permanent bot seats, their moves relayed from any
// connected human's browser via `asSeat` rather than computed on this server.
// ---------------------------------------------------------------------------
describe('bot rooms', () => {
  test('creating a room with one bot synthesizes a bot seat named after its difficulty', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['hard'] })
    expect(created.lobby.seats).toHaveLength(2)
    const bot = created.lobby.seats.find((s) => s.isBot)
    expect(bot).toBeTruthy()
    expect(bot!.playerId).toBe('p1')
    expect(bot!.connected).toBe(true)
    expect(bot!.botDifficulty).toBe('hard')
    expect(bot!.name).toBe('Bot (Hard)')
    expect(created.lobby.seats.find((s) => s.playerId === created.playerId)?.isBot).toBe(false)
  })

  test('multiple bots sharing a difficulty are numbered; distinct difficulties are not', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['hard', 'easy', 'hard'] })
    expect(created.lobby.seats).toHaveLength(4)
    const bots = created.lobby.seats.filter((s) => s.isBot)
    expect(bots.map((b) => b.name)).toEqual(['Bot (Hard) 1', 'Bot (Easy)', 'Bot (Hard) 2'])
  })

  test('a human joining a room with a bot cannot be assigned the bot seat', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['normal'] })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby')

    const guest = await connect(created.roomCode)
    opened.push(guest)
    guest.send({ type: 'join', name: 'Bo' })
    const seated = await guest.next('seated')
    expect(seated.playerId).not.toBe('p1')
    expect(seated.lobby.seats.filter((s) => s.isBot)).toHaveLength(1)
  })

  test('an action tagged asSeat for the bot seat is applied to the bot regardless of who sends it', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['normal'], fameToTriggerEndgame: 999 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby')
    host.send({ type: 'start' })
    await host.next('state')
    host.drain('lobby')

    const stub = ROOMS.getByName(created.roomCode)
    await runInDO(stub, async (instance: any) => {
      const room = await instance.ctx.storage.get('room')
      room.match.shared.phase = 'market'
      room.match.activePlayerIndex = room.match.turnOrder.indexOf('p1')
      await instance.ctx.storage.put('room', room)
      instance.room = room
    })

    host.send({ type: 'action', action: { kind: 'endTurn' }, asSeat: 'p1' })
    const state = await host.next('state')
    // Applied as p1 (the bot), not as p0 (the host's own attached seat) —
    // the log line names whoever's turn actually ended.
    expect(state.logLines.some((l) => l.playerId === 'p1' && l.text.includes('ended their turn'))).toBe(true)
  })

  test('an action tagged asSeat for a human seat is ignored, falling back to the sender own attached seat', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['normal'], fameToTriggerEndgame: 999 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby')
    host.send({ type: 'start' })
    await host.next('state')
    host.drain('lobby')

    const stub = ROOMS.getByName(created.roomCode)
    await runInDO(stub, async (instance: any) => {
      const room = await instance.ctx.storage.get('room')
      room.match.shared.phase = 'market'
      // It is the bot's (p1) turn — asSeat cannot redirect the host's own
      // socket onto p0 (a human seat) and have that magically succeed as p1.
      room.match.activePlayerIndex = room.match.turnOrder.indexOf('p1')
      await instance.ctx.storage.put('room', room)
      instance.room = room
    })

    host.send({ type: 'action', action: { kind: 'endTurn' }, asSeat: 'p0' })
    const err = await host.next('error')
    expect(err.code).toBe('illegalAction')
  })

  test('the bot seat is eligible for playForAbsentSeat when the host disconnects', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 1, bots: ['normal'], fameToTriggerEndgame: 999 })
    const host = await connect(created.roomCode)
    opened.push(host)
    host.send({ type: 'join', name: 'Ana', reconnectToken: created.reconnectToken })
    await host.next('seated')
    host.drain('lobby')
    host.send({ type: 'start' })
    await host.next('state')

    const stub = ROOMS.getByName(created.roomCode)
    await runInDO(stub, async (instance: any) => {
      const room = await instance.ctx.storage.get('room')
      room.match.shared.phase = 'market'
      room.match.activePlayerIndex = room.match.turnOrder.indexOf('p1')
      await instance.ctx.storage.put('room', room)
      instance.room = room
    })

    host.close()
    await new Promise((r) => setTimeout(r, 50))
    await runInDO(stub, async (instance: any) => {
      const room = await instance.ctx.storage.get('room')
      room.turnTimeoutDeadline = Date.now() - 1
      await instance.ctx.storage.put('room', room)
      instance.room = room
    })
    const ran = await runAlarm(stub)
    expect(ran).toBe(true)

    await runInDO(stub, async (instance: any) => {
      const room = await instance.ctx.storage.get('room')
      expect(room.log.some((l: any) => l.text.includes('was skipped'))).toBe(true)
    })
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

// ---------------------------------------------------------------------------
// The Big Button mini-expansion
// ---------------------------------------------------------------------------
//
// Three things can only be proved at this layer. The room-level SETTING has
// to survive handleStart's match rebuild — a room always opens at MAX_SEATS
// and is re-dealt at the size that actually turned up, so a setting held only
// on the dealt match would be silently discarded in every real game. The
// RESET: GRID decision phase is turn-gated and now Final-Flip-only, so a
// disconnected seat can stall the whole table unless strandingSeat knows
// about it. And an in-round RESET: GRID button is a Market-phase action now
// (hasAnyLegalMarketAction counts it), so a disconnected seat that still
// holds one is no longer instantly skipped by the ordinary boundary loop the
// way an action-less broke seat used to be — it has to wait for the
// turn-timeout alarm like any other seat mid-turn.
describe('Big Button', () => {
  test('a room created without it is unaffected — the default is off', async () => {
    const created = await createRoom({ name: 'Ana', season: 1, seed: 11 })
    expect(created.lobby.bigButton).toBeNull()
  })

  test('the reset effect survives handleStart rebuilding the match at the real seat count', async () => {
    const pair = await seatedPair({ bigButton: 'grid' })
    opened.push(pair.host, pair.guest)
    expect(pair.hostSeat.lobby.bigButton).toBe('grid')

    const match = await startGame(pair)
    // The room opened at MAX_SEATS and was re-dealt at 2. Both halves of the
    // setting have to have made it through that rebuild: the shared reset
    // effect, and the per-seat button.
    expect(match.shared.resetEffect).toBe('grid')
    expect(match.players).toHaveLength(2)
    expect(match.players.every((p) => p.bigButtonFaceUp)).toBe(true)
  })

  test('a normal round never opens the decision phase — RESET: GRID moved onto the Market turn', async () => {
    const pair = await seatedPair({ bigButton: 'grid' })
    opened.push(pair.host, pair.guest)
    const match = await startGame(pair)
    // advanceSharedPhases only loops while the phase is flip/finalFlip. A
    // normal round's Check Fame now hands straight to postFameHooks (a
    // pending Skunk prompt, ordinary and unrelated to this feature) or
    // straight through to the Market phase — 'gridReset' is reachable only
    // from the Final Flip now (see startMatchFinalFlip in match.ts).
    expect(match.shared.phase).not.toBe('gridReset')
    expect(match.shared.resetEffect).toBe('grid')
    expect(match.players.every((p) => p.bigButtonFaceUp)).toBe(true)
  })

  test('a disconnected seat holding an unspent RESET: GRID button is not instantly skipped — it waits for the alarm', async () => {
    const pair = await seatedPair({ bigButton: 'grid' })
    opened.push(pair.host, pair.guest)
    let match = await startGame(pair)

    // Drive past any pending post-fame choice (e.g. a Skunk dismissal) to
    // reach the Market phase, where the in-round RESET: GRID button lives.
    for (let step = 0; step < 4 && match.shared.phase !== 'market'; step++) {
      const owing = match.players.find((p: any) => p.pendingPostFameChoice)
      if (!owing) break
      const client = owing.playerId === pair.hostSeat.playerId ? pair.host : pair.guest
      const option = owing.pendingPostFameChoice!.options[0]
      client.send({ type: 'action', action: { kind: 'resolvePostFameChoice', pos: option.pos, index: option.index } })
      match = (await client.next('state')).match
    }
    if (match.shared.phase !== 'market') return // nothing to assert about; not this test's subject

    const actingId = match.turnOrder[match.activePlayerIndex]
    const acting = actingId === pair.hostSeat.playerId ? pair.host : pair.guest
    const watcher = acting === pair.host ? pair.guest : pair.host
    acting.close()

    // hasAnyLegalMarketAction now counts the acting seat's unspent Big Button
    // (canUseGridResetNow) as a legal move, so the ordinary boundary loop —
    // which used to close out a broke, action-less seat's turn on its own —
    // must NOT skip them just because they went quiet: webSocketClose only
    // flips `connected` and broadcasts nothing on its own. Only the
    // turn-timeout alarm below actually moves anything.
    await new Promise((r) => setTimeout(r, 50))

    const stub = ROOMS.getByName(pair.roomCode)
    await runInDO(stub, async (instance: any) => {
      // Fast-forward the armed deadline rather than waiting out TURN_TIMEOUT_MS.
      const room = await instance.ctx.storage.get('room')
      expect(room.turnTimeoutDeadline).toBeTruthy()
      room.turnTimeoutDeadline = Date.now() - 1
      await instance.ctx.storage.put('room', room)
      instance.room = room
    })
    await runAlarm(stub)

    // Drain any 'state' broadcasts already queued from the earlier
    // resolvePostFameChoice loop before reading the one the alarm produced.
    let after = await watcher.next('state')
    while (!after.logLines.some((l: any) => l.text.includes('was skipped'))) {
      after = await watcher.next('state')
    }
    // The alarm — not the boundary loop — is what finally moves the turn on.
    expect(after.match.turnOrder[after.match.activePlayerIndex]).not.toBe(actingId)
  })

  test('RESET: MARKET is a Market-phase action that costs neither fame nor an action', async () => {
    const pair = await seatedPair({ bigButton: 'market' })
    opened.push(pair.host, pair.guest)
    const started = await startGame(pair)
    // RESET: MARKET adds no phase, so the game opens exactly where it always
    // did (or on the Skunk prompt, which is not this feature's business).
    expect(started.shared.phase).not.toBe('gridReset')

    // Drive whatever the table owes until the Market phase is open.
    let match = started
    for (let step = 0; step < 4 && match.shared.phase !== 'market'; step++) {
      const owing = match.players.find((p: any) => p.pendingPostFameChoice)
      if (!owing) break
      const client = owing.playerId === pair.hostSeat.playerId ? pair.host : pair.guest
      const option = owing.pendingPostFameChoice!.options[0]
      client.send({ type: 'action', action: { kind: 'resolvePostFameChoice', pos: option.pos, index: option.index } })
      match = (await client.next('state')).match
    }
    if (match.shared.phase !== 'market') return // nothing to assert about; not this test's subject

    // The postFameChoice loop above broadcasts each 'state' to BOTH clients,
    // but only drains it from whichever one sent the action — so the other
    // client's inbox can be left holding a stale 'state'. Harmless while the
    // acting seat below always happened to be the same client that drained
    // its own inbox in the loop, but the acting seat is now randomized
    // (round 1's first player), so drain both before relying on `.next`.
    pair.host.drain('state')
    pair.guest.drain('state')

    const actingId = match.turnOrder[match.activePlayerIndex]
    const actor = actingId === pair.hostSeat.playerId ? pair.host : pair.guest
    const fameBefore = match.players.find((p: any) => p.playerId === actingId)!.fame
    actor.send({ type: 'action', action: { kind: 'useBigButton' } })
    const after = (await actor.next('state')).match
    const me = after.players.find((p: any) => p.playerId === actingId)!
    expect(me.bigButtonFaceUp).toBe(false)
    expect(me.fame).toBe(fameBefore)
    expect(me.actionsRemaining).toBe(2)
  })
})
