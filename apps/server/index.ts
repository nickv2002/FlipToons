// Solo-game hosting server — NOT §6's full multiplayer server (no turn
// order, no legalActions, no pendingChoice; multiplayer GameState doesn't
// exist, see flip-toonz-structure-plan.md §12). What this actually is: the
// exact same solo packages/engine/actions.ts reducer the browser already
// runs locally (apps/web/src/useGame.ts), now run authoritatively on a
// server instead of only in one browser's memory/localStorage — so a solo
// game's state lives in the room and survives a reload, and in principle
// can be resumed from another device with the room code.
//
// §8's literal text says "Node + ws," but this project has used bun as its
// sole runtime/toolchain throughout (flip-toonz-phase0-plan.md's stated
// reasoning) — Bun.serve's built-in websocket handler gives the same result
// with zero new dependencies, so that's what's used here instead.
import { createRoom, getRoom, broadcast, applyRoomAction } from './rooms'
import type { SocketData } from './rooms'
import { DEFAULT_PORT } from './protocol'
import type { ClientMessage, ServerMessage } from './protocol'

function send(ws: Bun.ServerWebSocket<SocketData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

function handleMessage(ws: Bun.ServerWebSocket<SocketData>, raw: string): void {
  let message: ClientMessage
  try {
    message = JSON.parse(raw)
  } catch {
    send(ws, { type: 'error', message: 'Malformed message.' })
    return
  }

  if (message.type === 'create') {
    const { roomCode, room } = createRoom(message.seed, message.difficulty, message.season)
    room.sockets.add(ws)
    ws.data.roomCode = roomCode
    send(ws, { type: 'joined', roomCode, state: room.state, log: room.log })
    return
  }

  if (message.type === 'join') {
    const room = getRoom(message.roomCode)
    if (!room) {
      send(ws, { type: 'error', message: `No room with code "${message.roomCode}".` })
      return
    }
    room.sockets.add(ws)
    ws.data.roomCode = message.roomCode
    send(ws, { type: 'joined', roomCode: message.roomCode, state: room.state, log: room.log })
    return
  }

  if (message.type === 'action') {
    const room = getRoom(message.roomCode)
    if (!room) {
      send(ws, { type: 'error', message: `No room with code "${message.roomCode}".` })
      return
    }
    try {
      const { logLines } = applyRoomAction(room, message.action)
      broadcast(room, { type: 'state', state: room.state, logLines })
    } catch (err) {
      // A genuine phase-machine bug (actions.ts's isEngineBug case) —
      // visible/logged loudly server-side, room state left untouched.
      console.error('apps/server: engine bug applying action', message.action, err)
      send(ws, { type: 'error', message: 'Server error applying that action.' })
    }
    return
  }

  send(ws, { type: 'error', message: `Unknown message type.` })
}

export function startServer(port: number = DEFAULT_PORT) {
  return Bun.serve<SocketData>({
    port,
    fetch(req, server) {
      if (server.upgrade(req, { data: { roomCode: null } })) return
      return new Response('FlipToons server: WebSocket endpoint only.', { status: 400 })
    },
    websocket: {
      open() {},
      message(ws, raw) {
        handleMessage(ws, typeof raw === 'string' ? raw : raw.toString())
      },
      close(ws) {
        const room = ws.data.roomCode ? getRoom(ws.data.roomCode) : undefined
        room?.sockets.delete(ws)
      },
    },
  })
}

if (import.meta.main) {
  const server = startServer()
  console.log(`FlipToons server listening on ws://localhost:${server.port}`)
}
