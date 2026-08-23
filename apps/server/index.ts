// The multiplayer game server (§6). Rooms of 2-4 seats, room-code joins,
// reconnect-by-token, and turn enforcement.
//
// What this replaced: a "hosted solo" server that ran one shared GameState
// which any number of connections jointly drove. It had no notion of identity
// — SocketData carried only a room code — so it could not tell who sent an
// action, and two people in one room shared a single grid and fame pool.
//
// §8's literal text says "Node + ws," but this project has used bun as its
// sole runtime/toolchain throughout (flip-toonz-phase0-plan.md's stated
// reasoning) — Bun.serve's built-in websocket handler gives the same result
// with zero new dependencies, so that's what's used here instead.
import {
  applyRoomAction,
  armTurnTimeout,
  broadcast,
  createRoom,
  evictStaleRooms,
  getRoom,
  joinRoom,
  lobbyOf,
  startRoom,
} from './rooms'
import type { Room, SocketData } from './rooms'
import { DEFAULT_PORT } from './protocol'
import type { ClientMessage, ServerMessage } from './protocol'

function send(ws: Bun.ServerWebSocket<SocketData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message))
}

function attach(ws: Bun.ServerWebSocket<SocketData>, room: Room, roomCode: string, playerId: string): void {
  room.sockets.add(ws)
  ws.data.roomCode = roomCode
  // THE SECURITY BOUNDARY. Every action this connection sends is attributed to
  // this seat and nothing else. The 'action' message deliberately carries no
  // playerId field — if it did, any client could act as any player.
  ws.data.seat = playerId
  // A seat has exactly one live connection. Reclaiming it hands the seat to
  // this socket; the previous one is dropped now rather than left to report a
  // disconnection later, on behalf of a player who has already come back.
  const seat = room.seats.find((s) => s.playerId === playerId)
  if (seat) {
    const previous = seat.socket
    seat.socket = ws
    if (previous && previous !== ws) {
      room.sockets.delete(previous)
      previous.close()
    }
  }
  room.lastActivity = Date.now()
}

// The OTHER half of the security boundary. `attach` pins WHO a connection is;
// this pins WHICH TABLE it may touch. Post-join messages carry a roomCode, but
// it is a client-supplied string and must never be what we look the room up
// by: seat ids are `p0..p3` in EVERY room (match.ts's turn order) and the
// creator of any room is always `p0`, so a lookup by message code let a
// connection seated as p0 of its own throwaway room start, and act inside,
// anyone else's room. The connection's own roomCode is the only trustworthy
// one; the message's is accepted only when it agrees with it.
function roomForConnection(
  ws: Bun.ServerWebSocket<SocketData>,
  claimedRoomCode: string | undefined,
): { ok: true; room: Room; roomCode: string } | { ok: false; reply: ServerMessage } {
  const roomCode = ws.data.roomCode
  // Never joined anything — say so plainly; there is no room to be secretive
  // about.
  if (!roomCode) return { ok: false, reply: { type: 'error', message: 'You are not seated in this room.' } }
  // Seated elsewhere, or naming a room that has since been evicted. Both
  // answer the same way: from this connection's point of view that room does
  // not exist, and saying more would confirm it does.
  const room = (claimedRoomCode ?? '').toUpperCase() === roomCode ? getRoom(roomCode) : undefined
  if (!room) return { ok: false, reply: { type: 'error', code: 'noSuchRoom', message: `No room with code "${claimedRoomCode}".` } }
  return { ok: true, room, roomCode }
}

// Pushes the whole match plus the full backlog to one connection — what a
// joiner or reconnecting player needs to render the game from scratch.
function sendFullState(ws: Bun.ServerWebSocket<SocketData>, room: Room): void {
  send(ws, { type: 'state', match: room.match, logLines: [], debugLines: [], log: room.log })
}

function handleMessage(ws: Bun.ServerWebSocket<SocketData>, raw: string): void {
  let message: ClientMessage
  try {
    message = JSON.parse(raw)
  } catch {
    send(ws, { type: 'error', message: 'Malformed message.' })
    return
  }

  evictStaleRooms()

  if (message.type === 'create') {
    // The 'action' path already treats engine throws as containable; create
    // and start used to not, so a malformed message threw straight out of the
    // socket callback. Same shape here.
    try {
      const { roomCode, room, seat } = createRoom({
        name: message.name || 'Player 1',
        playerCount: message.playerCount,
        // Anything that isn't literally season 2 is season 1 — the union is a
        // claim about well-behaved clients, not a runtime guarantee.
        season: Number(message.season) === 2 ? 2 : 1,
        seed: Number.isFinite(Number(message.seed)) ? Number(message.seed) : undefined,
        fameToTriggerEndgame: Number.isFinite(Number(message.fameToTriggerEndgame)) ? Number(message.fameToTriggerEndgame) : undefined,
      })
      attach(ws, room, roomCode, seat.playerId)
      send(ws, { type: 'seated', roomCode, playerId: seat.playerId, reconnectToken: seat.reconnectToken, lobby: lobbyOf(room, roomCode) })
    } catch (err) {
      console.error('apps/server: could not create a room', err)
      send(ws, { type: 'error', message: 'Could not create that room.' })
    }
    return
  }

  if (message.type === 'join') {
    const roomCode = (message.roomCode ?? '').toUpperCase()
    const room = getRoom(roomCode)
    if (!room) {
      send(ws, { type: 'error', code: 'noSuchRoom', message: `No room with code "${roomCode}".` })
      return
    }
    const outcome = joinRoom(room, message.name || 'Player', message.reconnectToken)
    if (!outcome.ok) {
      send(ws, { type: 'error', code: outcome.code, message: outcome.message })
      return
    }
    attach(ws, room, roomCode, outcome.seat.playerId)
    send(ws, {
      type: 'seated',
      roomCode,
      playerId: outcome.seat.playerId,
      reconnectToken: outcome.seat.reconnectToken,
      lobby: lobbyOf(room, roomCode),
    })
    // A player rejoining a match in progress needs the board, not just the
    // lobby.
    if (room.started) sendFullState(ws, room)
    // Everyone else sees the seat list change — that's how a table notices
    // someone dropped or came back.
    broadcast(room, { type: 'lobby', lobby: lobbyOf(room, roomCode) })
    // They may be the seat everyone was waiting on; if so, stand the clock
    // down.
    armTurnTimeout(room)
    return
  }

  if (message.type === 'start') {
    const found = roomForConnection(ws, message.roomCode)
    if (!found.ok) {
      send(ws, found.reply)
      return
    }
    const { room, roomCode } = found
    if (ws.data.seat !== room.hostPlayerId) {
      send(ws, { type: 'error', code: 'notHost', message: 'Only the host can start the game.' })
      return
    }
    if (room.seats.length < 2) {
      send(ws, { type: 'error', message: 'Need at least 2 players to start.' })
      return
    }
    try {
      startRoom(room)
    } catch (err) {
      console.error('apps/server: could not start the game', err)
      send(ws, { type: 'serverError', message: 'Server error starting the game.' })
      return
    }
    broadcast(room, { type: 'lobby', lobby: lobbyOf(room, roomCode) })
    broadcast(room, { type: 'state', match: room.match, logLines: [], debugLines: [], log: room.log })
    armTurnTimeout(room)
    return
  }

  if (message.type === 'action') {
    const found = roomForConnection(ws, message.roomCode)
    if (!found.ok) {
      send(ws, found.reply)
      return
    }
    const { room } = found
    if (!room.started) {
      send(ws, { type: 'error', message: 'The game has not started yet.' })
      return
    }
    // The actor is the connection's seat. Never message.playerId — there
    // isn't one, on purpose.
    const seat = ws.data.seat
    if (!seat) {
      send(ws, { type: 'error', message: 'You are not seated in this room.' })
      return
    }
    try {
      const result = applyRoomAction(room, seat, message.action)
      if (!result.ok) {
        // A player mistake (out of turn, not enough fame). Told to them only,
        // and the room is untouched.
        send(ws, { type: 'error', code: 'illegalAction', message: result.message })
        return
      }
      broadcast(room, { type: 'state', match: room.match, logLines: result.logLines, debugLines: result.debugLines })
      // The turn may have just passed to a seat nobody is holding.
      armTurnTimeout(room)
    } catch (err) {
      // A genuine phase-machine bug — loud server-side, room state untouched.
      console.error('apps/server: engine bug applying action', message.action, err)
      send(ws, { type: 'serverError', message: 'Server error applying that action.' })
    }
    return
  }

  send(ws, { type: 'error', message: `Unknown message type.` })
}

export function startServer(port: number = DEFAULT_PORT) {
  return Bun.serve<SocketData>({
    port,
    fetch(req, server) {
      if (server.upgrade(req, { data: { roomCode: null, seat: null } })) return
      return new Response('FlipToons server: WebSocket endpoint only.', { status: 400 })
    },
    websocket: {
      open() {},
      message(ws, raw) {
        handleMessage(ws, typeof raw === 'string' ? raw : raw.toString())
      },
      close(ws) {
        const room = ws.data.roomCode ? getRoom(ws.data.roomCode) : undefined
        if (!room) return
        room.sockets.delete(ws)
        // Mark the seat away rather than freeing it — the player holds a
        // reconnect token and can come back to it. Presence is broadcast so
        // the rest of the table can see who dropped.
        //
        // Only the seat's CURRENT socket may report this. A socket that has
        // already been superseded is closing after the fact, and the player it
        // belonged to is by now connected on another one.
        const seat = room.seats.find((s) => s.playerId === ws.data.seat)
        if (!seat || seat.socket !== ws) return
        seat.socket = undefined
        seat.connected = false
        // Only the host can start a game, and nothing used to reassign that.
        // A host who dropped before starting and could not get their token
        // back left everyone else sitting in a lobby no one was allowed to
        // start. It stays put once the game is underway — the role does
        // nothing then, and moving it would only confuse the seat list.
        if (!room.started && room.hostPlayerId === seat.playerId) {
          const heir = room.seats.find((s) => s.connected)
          if (heir) room.hostPlayerId = heir.playerId
        }
        broadcast(room, { type: 'lobby', lobby: lobbyOf(room, ws.data.roomCode!) })
        // If they were the seat the table was waiting on, start the clock.
        armTurnTimeout(room)
      },
    },
  })
}

if (import.meta.main) {
  const server = startServer()
  console.log(`FlipToons server listening on ws://localhost:${server.port}`)
}
