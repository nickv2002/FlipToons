// One Durable Object instance per room. Replaces apps/server/rooms.ts's
// module-level `Map<string, Room>` (one process, every room) and the
// socket-handling half of apps/server/index.ts.
//
// What changed and why:
//  - Persistence. The old registry was explicitly in-memory only ("a process
//    restart drops every in-progress room") because that was true of a single
//    long-lived Bun process. It is NOT true of a Durable Object: the
//    Hibernation API evicts the DO's JS heap between messages while its
//    WebSockets stay open, so anything not in `ctx.storage` is gone the next
//    time a message wakes this instance up. Room state is persisted after
//    every mutation and reloaded in the constructor. This buys crash/restart
//    resilience the Bun server never had, as a side effect of the platform's
//    own execution model — not a scope addition.
//  - Timers. `setTimeout` doesn't survive hibernation either. A DO gets ONE
//    alarm slot, so the turn-timeout and the room's own staleness eviction —
//    previously a per-room `setTimeout` plus a separate cross-room sweep in
//    `evictStaleRooms` — are merged into one scheduled deadline: whichever of
//    "the stranded seat's clock runs out" or "the room goes idle past its
//    TTL" comes first.
//  - Sockets. `ctx.getWebSockets()` replaces the `Set<ServerWebSocket>` —
//    it's hibernation-aware, so it returns sockets that aren't necessarily
//    resident on this exact tick.
//  - Identity. `ws.serializeAttachment`/`deserializeAttachment` replaces
//    `SocketData` (a plain JS field on the socket) for the same reason: it
//    has to survive hibernation.
import { DurableObject } from 'cloudflare:workers'
import { buildNewMatch } from '../../packages/engine/match'
import { IllegalActionError, applyMatchAction } from '../../packages/engine/matchActions'
import type { LogLine, MatchAction } from '../../packages/engine/matchActions'
import type { Match } from '../../packages/engine/state'
import { log } from './log'
import { MAX_SEATS, sanitizePlayerName } from './protocol'
import type { ClientMessage, CreateRoomRequest, CreateRoomResponse, LobbyState, SeatInfo, ServerMessage } from './protocol'
import type { Season } from '../../packages/engine/cards/types'
import type { MatchDifficulty } from '../../packages/engine/ai'
import { formatNewGameLogLine } from '../../packages/engine/setup'

export type Seat = {
  playerId: string
  name: string
  // Opaque bearer token the client persists. Presenting it on a later `join`
  // reclaims this seat — what makes a reload or a dropped connection
  // survivable. Also what a `create`d connection presents to attach to the
  // seat its own POST /api/rooms call just reserved (see protocol.ts).
  reconnectToken: string
  connected: boolean
  // True only for a bot seat synthesized at creation (see createRoom) —
  // never assigned via handleJoin. Its playerId is whatever buildNewMatch's
  // turnOrder gives its index — the engine has no separate id scheme for
  // bots, so it has to be a real seat id.
  isBot: boolean
  botDifficulty?: MatchDifficulty
}

// Everything about one room, as it's persisted to `ctx.storage`. No sockets
// and no timer handle here — both live outside this shape (getWebSockets(),
// the single alarm) precisely because neither survives hibernation.
export type Room = {
  code: string
  match: Match
  seats: Seat[]
  hostPlayerId: string
  started: boolean
  season: Season
  // Big Button reset effect, or null for "not in play". Stored on the Room —
  // NOT only on the dealt match — because handleStart REBUILDS the match at
  // the size that actually turned up (see the table-size note in CLAUDE.md),
  // and handleRematch builds another one again. All three buildNewMatch call
  // sites have to pass it or the expansion silently switches itself off.
  bigButton: 'market' | 'grid' | null
  // Mirrors the bigButton pattern above: fixed at creation, stored on the
  // Room (not only the dealt match) so all three buildNewMatch call sites —
  // start, rebuild-at-real-seat-count, rematch — agree on it. The engine
  // itself has no concept of a bot seat; this is Room/protocol-level
  // bookkeeping only. One entry per bot seat, in seating order; empty is the
  // default "no bots" no-op.
  bots: MatchDifficulty[]
  seed: number
  fameToTriggerEndgame: number
  log: LogLine[]
  debugLog: string[]
  lastActivity: number
  // Set only while the table is waiting on a seat nobody is sitting in — see
  // armTurnTimeout. Persisted (unlike the old `setTimeout` handle) so the
  // alarm survives this DO being evicted and re-woken before it fires.
  turnTimeoutDeadline?: number
}

// Rooms are evicted once they have been idle this long. "Idle" means nothing
// has TOUCHED the room — creating it, seating a connection, starting it, or
// applying an action all bump `lastActivity`. A client that keeps rejoining
// without ever playing does hold a room open; what the window really bounds
// is abandonment, and a rejoin is not that.
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
// Logs are capped too: a long match generates a lot of lines, and a client
// only ever renders the recent tail.
export const MAX_LOG_LINES = 2000
// How long the table waits on a seat whose player has dropped before playing
// that seat's turn for them.
export const TURN_TIMEOUT_MS = 60 * 1000

const STORAGE_KEY = 'room'

// Per-connection identity, persisted via serializeAttachment so it survives
// hibernation. `seat` is assigned on `join` and is the ONLY thing an action is
// ever attributed to — the 'action' message deliberately carries no playerId,
// or a client could act as any player.
type SocketAttachment = { seat: string }

function generateToken(): string {
  return crypto.randomUUID()
}

// "Medium" is the UI-facing label for MatchDifficulty's 'normal' everywhere a
// bot's difficulty is shown — the engine's own value stays 'normal' to avoid
// an engine-wide rename.
const DIFFICULTY_LABEL: Record<MatchDifficulty, string> = { easy: 'Easy', normal: 'Medium', hard: 'Hard', extreme: 'Extreme' }

// One name per bot, in seating order. Carries the difficulty in parentheses
// — even a lone bot — so a player can tell what it was set to. Used ONLY
// from here on (handleStart) — while still in the lobby the difficulty is
// already visible on each seat's own selector, so re-printing it in the name
// too was redundant, and the label wouldn't have tracked a later change in
// the pill row without yet another rename call on every retarget. Bots
// sharing a difficulty are numbered in the order they were added.
function difficultyTaggedBotSeatNames(difficulties: MatchDifficulty[]): string[] {
  const seenSoFar: Partial<Record<MatchDifficulty, number>> = {}
  const totalOf: Partial<Record<MatchDifficulty, number>> = {}
  for (const d of difficulties) totalOf[d] = (totalOf[d] ?? 0) + 1
  return difficulties.map((d) => {
    const label = `Bot (${DIFFICULTY_LABEL[d]})`
    if ((totalOf[d] ?? 0) <= 1) return label
    const n = (seenSoFar[d] ?? 0) + 1
    seenSoFar[d] = n
    return `${label} ${n}`
  })
}

// Lobby-facing bot names, before any difficulty has been locked in by
// Start — just "Bot", numbered only if there's more than one, since the
// per-seat difficulty selector sitting right next to the name already shows
// the difficulty; naming and numbering it too was the redundant/overflowing
// part of the seat row.
function plainBotSeatNames(count: number): string[] {
  return count <= 1 ? ['Bot'] : Array.from({ length: count }, (_, i) => `Bot ${i + 1}`)
}

function lobbyOf(room: Room): LobbyState {
  const seats: SeatInfo[] = room.seats.map((s) => ({
    playerId: s.playerId,
    name: s.name,
    connected: s.connected,
    isHost: s.playerId === room.hostPlayerId,
    isBot: s.isBot,
    botDifficulty: s.botDifficulty,
  }))
  return {
    roomCode: room.code,
    seats,
    started: room.started,
    season: room.season,
    fameToTriggerEndgame: room.fameToTriggerEndgame,
    bigButton: room.bigButton,
    capacity: MAX_SEATS,
  }
}

// The Flip is not a decision: nobody chooses anything, every seat reveals at
// once, and the action was never turn- or host-gated — so it runs here,
// server-side, the instant the phase is reached, rather than racing N clients
// for a button with no owner.
//
// Consequence worth knowing: `phase === 'finalFlip'` only ever exists inside
// one call to this function, so the endgame arrives in the SAME broadcast as
// the market action that triggered it.
function advanceSharedPhases(match: Match, logLines: LogLine[], debugLines: string[]): Match {
  let next = match
  for (let i = 0; i < 4; i++) {
    const phase = next.shared.phase
    if (phase !== 'flip' && phase !== 'finalFlip') return next
    const result = applyMatchAction(next, next.turnOrder[0], { kind: 'advanceFlip' })
    next = result.match
    logLines.push(...result.logLines)
    debugLines.push(...result.debugLines)
  }
  return next
}

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>
  ASSETS: Fetcher
}

export class RoomDurableObject extends DurableObject<Env> {
  private room: Room | null = null
  private loaded: Promise<void>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<Room>(STORAGE_KEY)) ?? null
    })
  }

  private async persist(): Promise<void> {
    if (!this.room) return
    await this.ctx.storage.put(STORAGE_KEY, this.room)
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.room) return
    const staleAt = this.room.lastActivity + ROOM_TTL_MS
    const next = this.room.turnTimeoutDeadline ? Math.min(this.room.turnTimeoutDeadline, staleAt) : staleAt
    await this.ctx.storage.setAlarm(next)
  }

  private touch(): void {
    if (!this.room) return
    this.room.lastActivity = Date.now()
  }

  // ---------------------------------------------------------------------
  // RPC surface — called by the Worker's fetch handler, not over the wire.
  // ---------------------------------------------------------------------

  // Mints the room and seats its creator as host. The Worker calls this from
  // POST /api/rooms, after it has already picked which DO instance owns this
  // room code — createRoom does not generate the code itself.
  async createRoom(roomCode: string, params: CreateRoomRequest): Promise<CreateRoomResponse> {
    await this.loaded
    const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31)
    // Built at full capacity so joiners have seat ids to take; it isn't
    // dealt until `start`, which rebuilds it at the size that showed up. A
    // solo game never goes through a room at all — the browser runs it
    // locally (apps/web/src/useGame.ts).
    const bigButton = params.bigButton ?? null
    const bots = params.bots ?? []
    const match = buildNewMatch(seed, MAX_SEATS, params.season, { fameToTriggerEndgame: params.fameToTriggerEndgame, bigButton })
    const seat: Seat = { playerId: match.turnOrder[0], name: params.name, reconnectToken: generateToken(), connected: false, isBot: false }
    const seats: Seat[] = [seat]
    // Synthesized, not joined: a bot never has a socket of its own, so it is
    // "connected" from the moment the room exists — see strandingSeat for
    // what actually happens when every human who could compute its moves
    // disappears.
    const names = plainBotSeatNames(bots.length)
    bots.forEach((difficulty, i) => {
      seats.push({ playerId: match.turnOrder[i + 1], name: names[i]!, reconnectToken: generateToken(), connected: true, isBot: true, botDifficulty: difficulty })
    })
    const room: Room = {
      code: roomCode,
      match,
      seats,
      hostPlayerId: seat.playerId,
      started: false,
      season: params.season,
      bigButton,
      bots,
      seed,
      fameToTriggerEndgame: match.shared.fameToTriggerEndgame,
      log: [],
      debugLog: [],
      lastActivity: Date.now(),
    }
    this.room = room
    await this.persist()
    await this.scheduleAlarm()
    log(
      'info',
      roomCode,
      `created by "${params.name}" — season ${params.season}, seed ${seed}, threshold ${room.fameToTriggerEndgame}${bots.length > 0 ? `, bots: ${names.join(', ')}` : ''}`,
    )
    return { roomCode, playerId: seat.playerId, reconnectToken: seat.reconnectToken, lobby: lobbyOf(room) }
  }

  // Called by the Worker for a `/ws?room=...` upgrade request. The room code
  // in the URL only ever picked the DO instance; nothing else about it
  // matters once we're here.
  async fetch(request: Request): Promise<Response> {
    await this.loaded
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 400 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    // A room that doesn't exist (bad code, or evicted by the alarm) still
    // accepts the upgrade — refusing it outright surfaces to a browser
    // WebSocket as an opaque "connection failed", with no message the client
    // can read. Accepting, then sending a real `error` frame before closing,
    // matches what a client already knows how to render.
    if (!this.room) {
      // This DO instance has no state of its own to name the room by — the
      // Worker's `?room=` query param, still on the forwarded request, is the
      // only place the code the client actually typed survives to here.
      const roomCode = new URL(request.url).searchParams.get('room') ?? ''
      this.send(server, { type: 'error', code: 'noSuchRoom', message: `No room with code "${roomCode}".` })
      server.close(1000, 'No such room.')
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  // ---------------------------------------------------------------------
  // Hibernatable WebSocket lifecycle
  // ---------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.loaded
    const room = this.room
    if (!room) {
      this.send(ws, { type: 'error', code: 'noSuchRoom', message: 'No such room.' })
      return
    }

    let message: ClientMessage
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      this.send(ws, { type: 'error', message: 'Malformed message.' })
      return
    }

    if (message.type === 'join') {
      await this.handleJoin(ws, room, sanitizePlayerName(message.name ?? '').trim() || 'Player', message.reconnectToken)
      return
    }

    // Every other message requires an attached seat already.
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (!attachment) {
      this.send(ws, { type: 'error', message: 'You are not seated in this room.' })
      return
    }

    if (message.type === 'start') {
      await this.handleStart(ws, room, attachment.seat)
      return
    }

    if (message.type === 'action') {
      // asSeat is honored only when it names a bot seat in this room —
      // otherwise the sender acts as their own attached seat, same as
      // always. No check on which socket sent it: this is a low-stakes
      // hobby app, and the only invariant that matters is that asSeat can
      // never move a human seat's pieces.
      const botSeat = message.asSeat ? room.seats.find((s) => s.playerId === message.asSeat && s.isBot) : undefined
      await this.handleAction(ws, room, botSeat ? botSeat.playerId : attachment.seat, message.action)
      return
    }

    if (message.type === 'rematch') {
      await this.handleRematch(ws, room, attachment.seat)
      return
    }

    if (message.type === 'addBot') {
      await this.handleAddBot(ws, room, attachment.seat, message.difficulty)
      return
    }

    if (message.type === 'removeBot') {
      await this.handleRemoveBot(ws, room, attachment.seat, message.playerId)
      return
    }

    if (message.type === 'setBotDifficulty') {
      await this.handleSetBotDifficulty(ws, room, attachment.seat, message.playerId, message.difficulty)
      return
    }

    this.send(ws, { type: 'error', message: 'Unknown message type.' })
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.loaded
    const room = this.room
    if (!room) return
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (!attachment) return
    // A seat has exactly one live connection (see handleJoin). If a newer
    // socket has already reclaimed this seat, this close is the stale
    // connection catching up — the player it belonged to is already back.
    const stillCurrent = this.ctx.getWebSockets().some((other) => {
      if (other === ws) return false
      const otherAttachment = other.deserializeAttachment() as SocketAttachment | null
      return otherAttachment?.seat === attachment.seat
    })
    if (stillCurrent) return

    const seat = room.seats.find((s) => s.playerId === attachment.seat)
    if (!seat) return
    seat.connected = false
    // Only the host can start a game, and nothing used to reassign that. A
    // host who dropped before starting and could not get their token back
    // left everyone else sitting in a lobby no one was allowed to start.
    // The role used to stay put once the game was underway, on the theory
    // that it did nothing there — that stopped being true once bot moves
    // were gated to the host's browser (apps/web/src/App.tsx's isHost gate
    // on useBotSeats): a host who drops mid-match with an unfinished bot
    // seat would otherwise freeze that seat forever. So reassignment now
    // also runs mid-match, to whichever seat is still connected.
    if (room.hostPlayerId === seat.playerId) {
      // A bot seat's `connected` is always true (it has no socket) and it
      // can never actually act as host — excluded here so a table with one
      // human and one bot doesn't hand the role to something that can never
      // use it, stranding the table exactly like having no heir at all.
      const heir = room.seats.find((s) => !s.isBot && s.connected)
      if (heir) room.hostPlayerId = heir.playerId
    }
    this.touch()
    await this.persist()
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
    await this.armTurnTimeout(room)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log('warn', this.room?.code ?? null, 'websocket error', error)
  }

  async alarm(): Promise<void> {
    await this.loaded
    const room = this.room
    if (!room) return
    const now = Date.now()

    if (now - room.lastActivity >= ROOM_TTL_MS) {
      log('info', room.code, `evicted — idle for ${Math.round((now - room.lastActivity) / 60000)} minute(s)`)
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, 'Room evicted.')
        } catch {
          // Already closed.
        }
      }
      await this.ctx.storage.deleteAll()
      this.room = null
      return
    }

    if (room.turnTimeoutDeadline && now >= room.turnTimeoutDeadline) {
      room.turnTimeoutDeadline = undefined
      await this.playForAbsentSeat(room, TURN_TIMEOUT_MS)
      return
    }

    // Not actually due — a stale alarm firing early for some reason.
    await this.scheduleAlarm()
  }

  // ---------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------

  private async handleJoin(ws: WebSocket, room: Room, name: string, reconnectToken?: string): Promise<void> {
    let seat: Seat | undefined
    let reclaimed = false

    if (reconnectToken) {
      seat = room.seats.find((s) => s.reconnectToken === reconnectToken)
      if (seat) {
        reclaimed = true
        if (name) seat.name = name
      }
    }

    if (!seat) {
      if (room.started) {
        this.send(ws, { type: 'error', code: 'alreadyStarted', message: 'That game has already started.' })
        return
      }
      if (room.seats.length >= MAX_SEATS) {
        this.send(ws, { type: 'error', code: 'roomFull', message: 'That room is full.' })
        return
      }
      // The bot seat, if any, already occupies a turnOrder slot — a joining
      // human must not be handed it, so the next open index skips past it.
      let nextIndex = 0
      while (room.seats.some((s) => s.playerId === room.match.turnOrder[nextIndex])) nextIndex++
      seat = { playerId: room.match.turnOrder[nextIndex], name, reconnectToken: generateToken(), connected: true, isBot: false }
      room.seats.push(seat)
      log('info', room.code, `${seat.playerId} ("${name}") joined — ${room.seats.length}/${MAX_SEATS} seated`)
    } else {
      seat.connected = true
      log('info', room.code, `${seat.playerId} ("${seat.name}") ${reclaimed ? 'reclaimed their seat' : 'joined'}`)
    }

    // A seat has exactly one live connection. Reclaiming it hands the seat to
    // this socket; any previous one is dropped now rather than left to report
    // a disconnection later on behalf of a player who has already come back.
    const attachment: SocketAttachment = { seat: seat.playerId }
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue
      const otherAttachment = other.deserializeAttachment() as SocketAttachment | null
      if (otherAttachment?.seat === seat.playerId) other.close(1000, 'Seat reclaimed by another connection.')
    }
    ws.serializeAttachment(attachment)

    this.touch()
    await this.persist()

    this.send(ws, { type: 'seated', roomCode: room.code, playerId: seat.playerId, reconnectToken: seat.reconnectToken, lobby: lobbyOf(room) })
    // A player rejoining a match in progress needs the board, not just the
    // lobby.
    if (room.started) this.send(ws, { type: 'state', match: room.match, logLines: [], debugLines: [], log: room.log })
    // Everyone else sees the seat list change — that's how a table notices
    // someone dropped or came back.
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
    // They may be the seat everyone was waiting on; if so, stand the clock
    // down.
    await this.armTurnTimeout(room)
  }

  private async handleStart(ws: WebSocket, room: Room, seatId: string): Promise<void> {
    if (seatId !== room.hostPlayerId) {
      this.send(ws, { type: 'error', code: 'notHost', message: 'Only the host can start the game.' })
      return
    }
    if (room.seats.length < 2) {
      this.send(ws, { type: 'error', message: 'Need at least 2 players to start.' })
      return
    }
    if (room.started) return

    // Lock each bot's difficulty into its name now — the per-seat selector
    // that showed it live is about to disappear along with the lobby.
    this.tagBotSeatsWithDifficulty(room)

    let dealt: Match
    try {
      dealt =
        room.seats.length !== room.match.turnOrder.length
          ? buildNewMatch(room.seed, room.seats.length, room.season, { fameToTriggerEndgame: room.fameToTriggerEndgame, bigButton: room.bigButton })
          : room.match
      // The very first log line the table ever sees. firstPlayerIndex was
      // randomized in buildMultiplayerSetup (setup.ts); turnOrder itself is
      // always seat/join order, so rotate it to the actual play order —
      // same rotation apps/web/src/App.tsx already does for the live fame
      // summary.
      const order = [...dealt.turnOrder.slice(dealt.firstPlayerIndex), ...dealt.turnOrder.slice(0, dealt.firstPlayerIndex)]
      const orderNames = order.map((pid) => room.seats.find((s) => s.playerId === pid)?.name ?? pid)
      room.log.push({ playerId: null, round: dealt.shared.round, text: formatNewGameLogLine(room.seed, room.season, room.bigButton) })
      room.log.push({ playerId: null, round: dealt.shared.round, text: `Randomized starting player — turn order: ${orderNames.join(', then ')}.` })
      // Nothing is committed to `room` until the advance has finished — same
      // discipline as handleAction — so an engine bug thrown mid-cascade
      // leaves memory and storage agreeing the room never started, rather
      // than memory saying started while storage (and a re-woken instance)
      // still says not.
      dealt = advanceSharedPhases(dealt, room.log, room.debugLog)
    } catch (err) {
      log('error', room.code, 'could not start the game', err)
      this.send(ws, { type: 'serverError', message: 'Server error starting the game.' })
      return
    }
    room.match = dealt
    room.started = true
    this.touch()
    log('info', room.code, `started with ${room.seats.length} seat(s): ${room.seats.map((s) => `${s.playerId}="${s.name}"`).join(', ')}`)

    await this.persist()
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
    this.broadcast(room, { type: 'state', match: room.match, logLines: [], debugLines: [], log: room.log })
    await this.armTurnTimeout(room)
  }

  // "Play with group again": deals a fresh match to the same seats without
  // dropping back to the lobby — no re-joining, no re-sharing the room code.
  // Host-only for the same reason `start` is, and gated on the match actually
  // having ended so a stray rematch mid-game can't blow away a live board.
  private async handleRematch(ws: WebSocket, room: Room, seatId: string): Promise<void> {
    if (seatId !== room.hostPlayerId) {
      this.send(ws, { type: 'error', code: 'notHost', message: 'Only the host can start a rematch.' })
      return
    }
    if (!room.started || room.match.shared.phase !== 'ended') {
      this.send(ws, { type: 'error', code: 'notEnded', message: 'The game has not ended yet.' })
      return
    }

    let dealt: Match
    const seed = Math.floor(Math.random() * 2 ** 31)
    const freshLog: LogLine[] = [{ playerId: null, round: 1, text: formatNewGameLogLine(seed, room.season, room.bigButton) }]
    const freshDebugLog: string[] = []
    try {
      dealt = advanceSharedPhases(
        buildNewMatch(seed, room.seats.length, room.season, { fameToTriggerEndgame: room.fameToTriggerEndgame, bigButton: room.bigButton }),
        freshLog,
        freshDebugLog,
      )
    } catch (err) {
      log('error', room.code, 'could not start the rematch', err)
      this.send(ws, { type: 'serverError', message: 'Server error starting the rematch.' })
      return
    }
    room.seed = seed
    room.match = dealt
    room.log = freshLog
    room.debugLog = freshDebugLog
    this.touch()
    log('info', room.code, `rematch dealt with ${room.seats.length} seat(s), new seed ${seed}`)

    await this.persist()
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
    this.broadcast(room, { type: 'state', match: room.match, logLines: [], debugLines: [], log: room.log })
    await this.armTurnTimeout(room)
  }

  // Keeps lobby bot names in plain "Bot"/"Bot N" form, renumbered after an
  // add or remove — plainBotSeatNames has to see the whole current list, not
  // just the one seat that changed. Called on every pre-start bot mutation;
  // NOT on a difficulty retarget, since the difficulty no longer lives in
  // the name until Start.
  private renameBotSeats(room: Room): void {
    const botSeats = room.seats.filter((s) => s.isBot)
    const names = plainBotSeatNames(botSeats.length)
    botSeats.forEach((s, i) => {
      s.name = names[i]!
    })
  }

  // Locks each bot seat's difficulty into its name — "Bot (Hard)" and so on
  // — once Start closes the lobby and the per-seat selector disappears.
  private tagBotSeatsWithDifficulty(room: Room): void {
    const botSeats = room.seats.filter((s) => s.isBot)
    const names = difficultyTaggedBotSeatNames(botSeats.map((s) => s.botDifficulty!))
    botSeats.forEach((s, i) => {
      s.name = names[i]!
    })
  }

  private async handleAddBot(ws: WebSocket, room: Room, seatId: string, difficulty: MatchDifficulty): Promise<void> {
    if (seatId !== room.hostPlayerId) {
      this.send(ws, { type: 'error', code: 'notHost', message: 'Only the host can add bots.' })
      return
    }
    if (room.started) {
      this.send(ws, { type: 'error', code: 'alreadyStarted', message: 'That game has already started.' })
      return
    }
    if (room.seats.length >= MAX_SEATS) {
      this.send(ws, { type: 'error', code: 'roomFull', message: 'That room is full.' })
      return
    }
    // Same slot-picking rule handleJoin uses: skip whichever turnOrder ids
    // are already seated (human or bot).
    let nextIndex = 0
    while (room.seats.some((s) => s.playerId === room.match.turnOrder[nextIndex])) nextIndex++
    const playerId = room.match.turnOrder[nextIndex]
    room.seats.push({ playerId, name: '', reconnectToken: generateToken(), connected: true, isBot: true, botDifficulty: difficulty })
    this.renameBotSeats(room)
    this.touch()
    await this.persist()
    log('info', room.code, `bot added (${difficulty}) — ${room.seats.length}/${MAX_SEATS} seated`)
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
  }

  private async handleRemoveBot(ws: WebSocket, room: Room, seatId: string, playerId: string): Promise<void> {
    if (seatId !== room.hostPlayerId) {
      this.send(ws, { type: 'error', code: 'notHost', message: 'Only the host can remove bots.' })
      return
    }
    if (room.started) {
      this.send(ws, { type: 'error', code: 'alreadyStarted', message: 'That game has already started.' })
      return
    }
    const index = room.seats.findIndex((s) => s.playerId === playerId && s.isBot)
    if (index === -1) return
    room.seats.splice(index, 1)
    this.renameBotSeats(room)
    this.touch()
    await this.persist()
    log('info', room.code, `bot removed — ${room.seats.length}/${MAX_SEATS} seated`)
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
  }

  // Host-only, pre-start only (same as addBot/removeBot): retargets an
  // existing bot seat's difficulty in place, so its name/position stay
  // stable rather than requiring a remove+re-add.
  private async handleSetBotDifficulty(ws: WebSocket, room: Room, seatId: string, playerId: string, difficulty: MatchDifficulty): Promise<void> {
    if (seatId !== room.hostPlayerId) {
      this.send(ws, { type: 'error', code: 'notHost', message: "Only the host can change a bot's difficulty." })
      return
    }
    if (room.started) {
      this.send(ws, { type: 'error', code: 'alreadyStarted', message: 'That game has already started.' })
      return
    }
    const seat = room.seats.find((s) => s.playerId === playerId && s.isBot)
    if (!seat) return
    seat.botDifficulty = difficulty
    // No renameBotSeats call — the name stays plain in the lobby regardless
    // of difficulty; see plainBotSeatNames.
    this.touch()
    await this.persist()
    log('info', room.code, `bot ${playerId} difficulty set to ${difficulty}`)
    this.broadcast(room, { type: 'lobby', lobby: lobbyOf(room) })
  }

  private async handleAction(ws: WebSocket, room: Room, seatId: string, action: MatchAction): Promise<void> {
    if (!room.started) {
      this.send(ws, { type: 'error', message: 'The game has not started yet.' })
      return
    }
    try {
      const { match, logLines, debugLines } = applyMatchAction(room.match, seatId, action)
      const advanced = advanceSharedPhases(match, logLines, debugLines)
      room.match = advanced
      room.log.push(...logLines)
      room.debugLog.push(...debugLines)
      if (room.log.length > MAX_LOG_LINES) room.log.splice(0, room.log.length - MAX_LOG_LINES)
      if (room.debugLog.length > MAX_LOG_LINES) room.debugLog.splice(0, room.debugLog.length - MAX_LOG_LINES)
      this.touch()
      await this.persist()
      this.broadcast(room, { type: 'state', match: room.match, logLines, debugLines })
      await this.armTurnTimeout(room)
    } catch (err) {
      if (err instanceof IllegalActionError) {
        this.send(ws, { type: 'error', code: 'illegalAction', message: err.message })
        return
      }
      log('error', room.code, `engine bug applying action ${action.kind} from ${seatId}`, err)
      this.send(ws, { type: 'serverError', message: 'Server error applying that action.' })
    }
  }

  // ---------------------------------------------------------------------
  // Waiting on someone who isn't there
  // ---------------------------------------------------------------------

  // A bot seat's own `connected` is always true (it has no socket) — but its
  // moves are computed ONLY in the HOST's browser (apps/web/src/App.tsx gates
  // useBotSeats on isHost), so if the host isn't connected to compute and
  // relay them, the bot has no compute source and would stall the game
  // forever without this. `!s.connected` alone would never catch that.
  // webSocketClose reassigns hostPlayerId to a connected heir immediately on
  // drop (mid-match too, as of the host-only compute change), so this check
  // and that reassignment are what keep a bot seat from freezing for good —
  // this alarm covers the gap until a heir exists at all (every seat gone).
  private seatIsStranded(room: Room, seat: Seat): boolean {
    if (!seat.connected) return true
    if (seat.isBot) return !room.seats.some((s) => s.playerId === room.hostPlayerId && s.connected)
    return false
  }

  private strandingSeat(room: Room): Seat | undefined {
    if (!room.started) return undefined

    // A post-fame choice (a mandatory Skunk dismissal, say) blocks the Market
    // phase from opening for anyone until EVERY seat that owes one has
    // answered, so the question is "is any owing seat empty", not "who is
    // the one owing seat".
    const owing = room.match.players.filter((p) => p.pendingPostFameChoice)
    if (owing.length > 0) {
      for (const p of owing) {
        const seat = room.seats.find((s) => s.playerId === p.playerId)
        if (seat && this.seatIsStranded(room, seat)) return seat
      }
      return undefined
    }

    // The Big Button's RESET: GRID decision phase only exists at the Final
    // Flip now — an in-round reset rides on the Market phase's own turn
    // instead — but that walk is still turn-based like the Market phase: the
    // table cannot advance past a seat that never answers. Without this
    // branch the whole table stalls with NO alarm armed, because the check
    // below returns undefined for every non-'market' phase.
    if (room.match.shared.phase === 'gridReset') {
      const decider = room.seats.find((s) => s.playerId === room.match.turnOrder[room.match.activePlayerIndex])
      return decider && this.seatIsStranded(room, decider) ? decider : undefined
    }

    if (room.match.shared.phase !== 'market') return undefined
    const seat = room.seats.find((s) => s.playerId === room.match.turnOrder[room.match.activePlayerIndex])
    return seat && this.seatIsStranded(room, seat) ? seat : undefined
  }

  // Re-evaluates whether the table is stranded and (re)schedules the alarm
  // accordingly. Cheap and idempotent — call after anything that might have
  // changed the answer: an action, a disconnection, a reconnection.
  //
  // The gate is DISCONNECTION, never idleness — a player who is present and
  // thinking is not on a clock.
  private async armTurnTimeout(room: Room, timeoutMs: number = TURN_TIMEOUT_MS): Promise<void> {
    const seat = this.strandingSeat(room)
    room.turnTimeoutDeadline = seat ? Date.now() + timeoutMs : undefined
    await this.persist()
    await this.scheduleAlarm()
  }

  // Plays the least the rules allow on behalf of a seat nobody is holding:
  // answer whatever it owes with the first legal option, then end its turn.
  // Buying nothing is always legal, so this can only cost that player the
  // chance to spend — never a rule.
  private async playForAbsentSeat(room: Room, timeoutMs: number): Promise<void> {
    const seat = this.strandingSeat(room)
    if (!seat) {
      await this.scheduleAlarm()
      return
    }

    const logLines: LogLine[] = []
    const debugLines: string[] = []
    let stalled = false
    for (let step = 0; step < 8; step++) {
      const player = room.match.players.find((p) => p.playerId === seat.playerId)
      if (!player) break

      let action: MatchAction
      if (player.pendingPostFameChoice) {
        const option = player.pendingPostFameChoice.options[0]
        action = { kind: 'resolvePostFameChoice', pos: option.pos, index: option.index }
      } else if (player.pendingDeckPlacement) {
        action = { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } }
      } else if (player.pendingPostMarketChoice) {
        const option = player.pendingPostMarketChoice.options[0]
        action = { kind: 'resolvePostMarketChoice', pos: option.pos, index: option.index }
      } else if (room.match.shared.phase === 'gridReset' && room.match.turnOrder[room.match.activePlayerIndex] === seat.playerId) {
        // This is the Final Flip's decision only — the in-round RESET: GRID
        // press lives on the Market phase's own turn and needs no fallback
        // here. Declining is the "least the rules allow" answer: it keeps the
        // button for whenever they reconnect, whereas spending it on their
        // behalf would burn a once-per-game resource on a guess.
        action = { kind: 'bigButtonDecision', use: false }
      } else if (room.match.shared.phase === 'market' && room.match.turnOrder[room.match.activePlayerIndex] === seat.playerId) {
        action = { kind: 'endTurn' }
      } else {
        break // no longer stranded on this seat
      }

      try {
        const { match, logLines: applied, debugLines: appliedDebug } = applyMatchAction(room.match, seat.playerId, action)
        const advanced = advanceSharedPhases(match, applied, appliedDebug)
        room.match = advanced
        room.log.push(...applied)
        room.debugLog.push(...appliedDebug)
        logLines.push(...applied)
        debugLines.push(...appliedDebug)
      } catch (err) {
        if (err instanceof IllegalActionError) {
          log('warn', room.code, `could not skip ${seat.playerId}'s turn — ${err.message}`)
        } else {
          log('error', room.code, `engine bug skipping absent seat ${seat.playerId} (${action.kind})`, err)
        }
        stalled = true
        break
      }
    }

    if (room.log.length > MAX_LOG_LINES) room.log.splice(0, room.log.length - MAX_LOG_LINES)
    if (room.debugLog.length > MAX_LOG_LINES) room.debugLog.splice(0, room.debugLog.length - MAX_LOG_LINES)

    if (logLines.length > 0 || debugLines.length > 0) {
      const notice: LogLine = { playerId: seat.playerId, round: room.match.shared.round, text: 'was skipped — no one is connected to that seat.' }
      room.log.push(notice)
      log('info', room.code, `played ${seat.playerId}'s turn — seat empty for ${Math.round(timeoutMs / 1000)}s`)
      this.touch()
      await this.persist()
      this.broadcast(room, { type: 'state', match: room.match, logLines: [notice, ...logLines], debugLines })
    } else {
      await this.persist()
    }

    // A skip that could not move anything must NOT re-arm on this deadline:
    // nothing changed, so the next firing would find the same state and fail
    // the same way, once a minute, forever. The room stays stranded either
    // way — but stranded and quiet, with one line in the log saying why,
    // beats a spin. The clock starts again on its own the next time anything
    // happens in the room.
    if (stalled) {
      await this.scheduleAlarm()
      return
    }

    // The seat this passed to may be empty too.
    await this.armTurnTimeout(room, timeoutMs)
  }

  // ---------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message))
  }

  private broadcast(room: Room, message: ServerMessage): void {
    const json = JSON.stringify(message)
    // One socket mid-close (a departing or just-reclaimed connection) must
    // not stop the rest of the table from hearing about it — `send` throwing
    // used to abort the whole `for` loop, silently dropping the broadcast for
    // every socket that iterated after the dead one.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json)
      } catch {
        // Already closed; webSocketClose will clean up its seat.
      }
    }
  }
}
