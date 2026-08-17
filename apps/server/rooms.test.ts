import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Server } from 'bun'
import { startServer } from './index'
import { applyAction, buildNewGameState } from '../../packages/engine/actions'
import type { Action } from '../../packages/engine/actions'
import type { GameState } from '../../packages/engine/state'
import { ROOM_CODE_ALPHABET } from './protocol'
import type { ClientMessage, ServerMessage } from './protocol'
import type { SocketData } from './rooms'

let server: Server<SocketData>
let base: string

beforeAll(() => {
  server = startServer(0)
  base = `ws://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      'message',
      (ev) => {
        resolve(JSON.parse(ev.data as string))
      },
      { once: true },
    )
    ws.addEventListener('error', reject, { once: true })
  })
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
}

function sendMsg(ws: WebSocket, message: ClientMessage): void {
  ws.send(JSON.stringify(message))
}

// Sends each action in order over `ws`, awaiting the resulting 'state'
// broadcast before sending the next, and threads the same actions through
// applyAction directly from `initial` — so the caller can assert the
// server's accumulated state/log match a purely-local run, not just a
// single-action snapshot.
async function runSequence(
  ws: WebSocket,
  roomCode: string,
  initial: GameState,
  actions: Action[],
): Promise<{ serverState: GameState; serverLogLines: string[]; localState: GameState }> {
  let localState = initial
  const serverLogLines: string[] = []
  let serverState = initial
  for (const action of actions) {
    const waiter = nextMessage(ws)
    sendMsg(ws, { type: 'action', roomCode, action })
    const reply = (await waiter) as Extract<ServerMessage, { type: 'state' }>
    expect(reply.type).toBe('state')
    serverState = reply.state
    serverLogLines.push(...reply.logLines)
    localState = applyAction(localState, action).state
  }
  return { serverState, serverLogLines, localState }
}

describe('apps/server room protocol', () => {
  test('create → joined with initial state matching buildNewGameState', async () => {
    const ws = await openSocket()
    const waiter = nextMessage(ws)
    sendMsg(ws, { type: 'create', seed: 42, difficulty: 'normal', season: 1 })
    const reply = await waiter
    expect(reply.type).toBe('joined')
    if (reply.type !== 'joined') throw new Error('unreachable')
    expect(reply.roomCode).toHaveLength(5)
    for (const char of reply.roomCode) expect(ROOM_CODE_ALPHABET).toContain(char)
    expect(reply.log).toEqual([])
    const expected = buildNewGameState(42, 'normal', 1)
    expect(reply.state).toEqual(expected)
    ws.close()
  })

  test('a sequence of actions (flip, hire, etc.) matches applyAction threaded locally', async () => {
    const ws = await openSocket()
    const waiter1 = nextMessage(ws)
    sendMsg(ws, { type: 'create', seed: 7, difficulty: 'normal', season: 1 })
    const createdReply = (await waiter1) as Extract<ServerMessage, { type: 'joined' }>
    expect(createdReply.type).toBe('joined')

    const actions: Action[] = [{ kind: 'flip' }, { kind: 'checkFame' }, { kind: 'continueToMarket' }, { kind: 'hire', slotIndex: 0 }]
    const { serverState, localState } = await runSequence(ws, createdReply.roomCode, createdReply.state, actions)
    expect(serverState).toEqual(localState)
    ws.close()
  })

  test('join an existing room from a second socket gets current state and full accumulated log', async () => {
    const ws1 = await openSocket()
    const waiter1 = nextMessage(ws1)
    sendMsg(ws1, { type: 'create', seed: 99, difficulty: 'easy', season: 1 })
    const joined1 = (await waiter1) as Extract<ServerMessage, { type: 'joined' }>

    const actions: Action[] = [{ kind: 'flip' }, { kind: 'checkFame' }]
    const { serverState, serverLogLines } = await runSequence(ws1, joined1.roomCode, joined1.state, actions)

    const ws2 = await openSocket()
    const waiter2 = nextMessage(ws2)
    sendMsg(ws2, { type: 'join', roomCode: joined1.roomCode })
    const joined2 = (await waiter2) as Extract<ServerMessage, { type: 'joined' }>

    expect(joined2.type).toBe('joined')
    expect(joined2.state).toEqual(serverState)
    expect(joined2.log).toEqual(serverLogLines)

    ws1.close()
    ws2.close()
  })

  test('join a nonexistent room returns an error', async () => {
    const ws = await openSocket()
    const waiter = nextMessage(ws)
    sendMsg(ws, { type: 'join', roomCode: 'ZZZZZ' })
    const reply = await waiter
    expect(reply.type).toBe('error')
    ws.close()
  })

  test('two sockets in the same room both receive a broadcast after an action', async () => {
    const ws1 = await openSocket()
    const waiter1 = nextMessage(ws1)
    sendMsg(ws1, { type: 'create', seed: 123, difficulty: 'normal', season: 1 })
    const joined1 = (await waiter1) as Extract<ServerMessage, { type: 'joined' }>

    const ws2 = await openSocket()
    const joinWaiter = nextMessage(ws2)
    sendMsg(ws2, { type: 'join', roomCode: joined1.roomCode })
    await joinWaiter

    const bothWaiters = Promise.all([nextMessage(ws1), nextMessage(ws2)])
    sendMsg(ws1, { type: 'action', roomCode: joined1.roomCode, action: { kind: 'flip' } })
    const [reply1, reply2] = await bothWaiters
    expect(reply1.type).toBe('state')
    expect(reply2.type).toBe('state')
    expect(reply1).toEqual(reply2)

    ws1.close()
    ws2.close()
  })

  test('a rejected-but-legal action (hire out of range) logs a rejection and keeps the connection open', async () => {
    const ws = await openSocket()
    const waiter1 = nextMessage(ws)
    sendMsg(ws, { type: 'create', seed: 55, difficulty: 'normal', season: 1 })
    const created = (await waiter1) as Extract<ServerMessage, { type: 'joined' }>

    await runSequence(ws, created.roomCode, created.state, [{ kind: 'flip' }, { kind: 'checkFame' }, { kind: 'continueToMarket' }])

    const waiter2 = nextMessage(ws)
    sendMsg(ws, { type: 'action', roomCode: created.roomCode, action: { kind: 'hire', slotIndex: 99 } })
    const reply = (await waiter2) as Extract<ServerMessage, { type: 'state' }>
    expect(reply.type).toBe('state')
    expect(reply.logLines.some((line) => line.startsWith("Can't do that"))).toBe(true)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // connection still usable afterward
    const waiter3 = nextMessage(ws)
    sendMsg(ws, { type: 'action', roomCode: created.roomCode, action: { kind: 'endMarket' } })
    const followUp = (await waiter3) as Extract<ServerMessage, { type: 'state' }>
    expect(followUp.type).toBe('state')

    ws.close()
  })

  test('a genuine engine bug (action in the wrong phase) errors without mutating room state', async () => {
    const ws = await openSocket()
    const waiter1 = nextMessage(ws)
    sendMsg(ws, { type: 'create', seed: 3, difficulty: 'normal', season: 1 })
    const created = (await waiter1) as Extract<ServerMessage, { type: 'joined' }>
    expect(created.state.phase).toBe('flip')

    const waiter2 = nextMessage(ws)
    sendMsg(ws, { type: 'action', roomCode: created.roomCode, action: { kind: 'hire', slotIndex: 0 } })
    const reply = await waiter2
    expect(reply.type).toBe('error')

    const waiter3 = nextMessage(ws)
    sendMsg(ws, { type: 'join', roomCode: created.roomCode })
    const rejoined = (await waiter3) as Extract<ServerMessage, { type: 'joined' }>
    expect(rejoined.state).toEqual(created.state)
    expect(rejoined.log).toEqual([])

    ws.close()
  })
})
