import { useCallback, useEffect, useRef, useState } from 'react'
import type { Match } from '../../../packages/engine/state'
import type { LogLine, MatchAction } from '../../../packages/engine/matchActions'
import type { ClientMessage, CreateRoomRequest, CreateRoomResponse, LobbyState, ServerMessage } from '../../worker/protocol'

// In production the Worker serves apps/web's build itself, so the page and
// the API/WS are same-origin. In local dev, apps/web runs on Vite's own dev
// server (port 5173) while apps/worker runs separately under `wrangler dev`
// (port 8787, wrangler's default — see scripts/play.sh) — so dev needs an
// explicit origin instead of `window.location.origin`.
const WORKER_ORIGIN = import.meta.env.DEV ? `http://${window.location.hostname}:8787` : window.location.origin
const WS_ORIGIN = WORKER_ORIGIN.replace(/^http/, 'ws')

// Where a seat is remembered across reloads. Losing this means losing the
// ability to get back into a live game: the old remote hook persisted nothing,
// so a refresh dropped the room code with no way back in — while the LOCAL
// solo hook has had save/resume all along.
const STORAGE_KEY = 'fliptoons.match.seat'

type StoredSeat = { roomCode: string; reconnectToken: string; name: string }

function loadSeat(): StoredSeat | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSeat) : null
  } catch {
    return null
  }
}

function saveSeat(seat: StoredSeat | null): void {
  try {
    if (seat) localStorage.setItem(STORAGE_KEY, JSON.stringify(seat))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private browsing, or storage disabled. Not being able to auto-rejoin is
    // a degraded experience, not a broken one.
  }
}

// Is there a seat remembered from a previous visit? App uses this to decide
// which mode to open in — without it, a reload after joining a room lands you
// back on the SOLO screen with a live game still running behind it.
export function hasStoredSeat(): boolean {
  return loadSeat() !== null
}

// The room code can also arrive in the URL (?room=ABCDE), which is what makes
// a room shareable — you send someone a link rather than dictating five
// characters.
export function roomCodeFromUrl(): string | null {
  try {
    const code = new URLSearchParams(window.location.search).get('room')
    return code ? code.toUpperCase() : null
  } catch {
    return null
  }
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed'

// How long a socket may sit in CONNECTING before we call it failed. Without
// this an unreachable server leaves the UI on "Connecting…" forever, which was
// the single worst gap in the old remote hook.
const CONNECT_TIMEOUT_MS = 8000
const RECONNECT_DELAY_MS = 1500

export type MatchClient = ReturnType<typeof useMatch>

export function useMatch() {
  const [match, setMatch] = useState<Match | null>(null)
  const [lobby, setLobby] = useState<LobbyState | null>(null)
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [debugLog, setDebugLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('idle')

  const wsRef = useRef<WebSocket | null>(null)
  const seatRef = useRef<StoredSeat | null>(loadSeat())
  // The message to send as soon as the socket opens. Held in a ref so the
  // auto-reconnect below can replay it without re-deriving intent.
  const openMessageRef = useRef<ClientMessage | null>(null)
  const wantConnectedRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback((roomCode: string, first: ClientMessage, reconnecting = false) => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    wsRef.current?.close()
    openMessageRef.current = first
    wantConnectedRef.current = true
    setConnection(reconnecting ? 'reconnecting' : 'connecting')
    if (!reconnecting) setError(null)

    const ws = new WebSocket(`${WS_ORIGIN}/ws?room=${roomCode}`)
    wsRef.current = ws

    const timeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close()
        setConnection('failed')
        setError('Could not reach the game server.')
      }
    }, CONNECT_TIMEOUT_MS)

    ws.addEventListener('open', () => {
      clearTimeout(timeout)
      setConnection('open')
      ws.send(JSON.stringify(first))
    })

    // The old hook had no 'error' listener at all, so a refused connection was
    // silent.
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      if (ws.readyState !== WebSocket.OPEN) setConnection('failed')
    })

    ws.addEventListener('message', (ev) => {
      // A frame that isn't JSON would otherwise throw straight out of the
      // listener, where nothing catches it. The server guards its own parse
      // the same way (apps/worker/room.ts's webSocketMessage).
      let message: ServerMessage
      try {
        message = JSON.parse(ev.data as string)
      } catch {
        setError('Received a malformed message from the server.')
        return
      }
      switch (message.type) {
        case 'seated': {
          setMyPlayerId(message.playerId)
          setLobby(message.lobby)
          setError(null)
          seatRef.current = { roomCode: message.roomCode, reconnectToken: message.reconnectToken, name: message.lobby.seats.find((s) => s.playerId === message.playerId)?.name ?? '' }
          saveSeat(seatRef.current)
          break
        }
        case 'lobby':
          setLobby(message.lobby)
          break
        case 'state':
          setMatch(message.match)
          // A full backlog (`log`) arrives on join/start and REPLACES what we
          // have; incremental lines append. Each line already carries the
          // round it happened in, so history no longer collapses into the
          // current round the way it did before.
          if (message.log) setLog(message.log)
          if (message.logLines.length > 0) setLog((prev) => [...prev, ...message.logLines])
          if (message.debugLines.length > 0) setDebugLog((prev) => [...prev, ...message.debugLines])
          break
        case 'error':
          setError(message.message)
          // A seat we can't get back into shouldn't keep being retried on
          // every reload.
          if (message.code === 'noSuchRoom') {
            seatRef.current = null
            saveSeat(null)
            // ...and the screen has to let go of it too. Clearing only the
            // stored seat left a lobby rendering its old seat list, waiting on
            // a host, in a room that no longer exists — no error, no
            // connection banner (the socket opened fine), and no way back to
            // the start screen short of a reload.
            wantConnectedRef.current = false
            setLobby(null)
            setMatch(null)
            setMyPlayerId(null)
          }
          break
        case 'serverError':
          setError(message.message)
          break
      }
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (!wantConnectedRef.current) {
        setConnection('closed')
        return
      }
      const seat = seatRef.current
      // Only a SEATED connection can come back: reconnecting means rejoining a
      // room with a token, and a create that never reached the server has
      // neither. Claiming 'reconnecting' anyway was a dead end with no way out
      // — the retry below was a no-op without a seat, so hosting against an
      // unreachable server sat on "Reconnecting…" forever, and because
      // MultiplayerStart derives `busy` from this state, the Host button that
      // would let you try again was disabled the whole time. A page reload was
      // the only escape.
      if (!seat) {
        setConnection('failed')
        // The connect timeout may already have set a more specific message.
        setError((prev) => prev ?? 'Could not reach the game server.')
        return
      }
      // Dropped while we still wanted to be in a game — come back on our own
      // rather than leaving every click a silent no-op.
      setConnection('reconnecting')
      retryTimerRef.current = setTimeout(() => {
        if (!wantConnectedRef.current) return
        connect(seat.roomCode, { type: 'join', name: seat.name, reconnectToken: seat.reconnectToken }, true)
      }, RECONNECT_DELAY_MS)
    })
  }, [])

  // Room creation is HTTP, not a WebSocket message: the Worker has to know
  // the room code to route to the right Durable Object BEFORE the socket
  // upgrades, and there is no code yet until this call mints one (see
  // apps/worker/protocol.ts).
  const createRoom = useCallback(
    async (opts: CreateRoomRequest) => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      wsRef.current?.close()
      wantConnectedRef.current = true
      setConnection('connecting')
      setError(null)
      let created: CreateRoomResponse
      try {
        const res = await fetch(`${WORKER_ORIGIN}/api/rooms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(opts),
        })
        if (!res.ok) throw new Error(`status ${res.status}`)
        created = await res.json()
      } catch {
        setConnection('failed')
        setError('Could not reach the game server.')
        return
      }
      connect(created.roomCode, { type: 'join', name: opts.name, reconnectToken: created.reconnectToken })
    },
    [connect],
  )

  const joinRoom = useCallback(
    (roomCode: string, name: string) => {
      const code = roomCode.trim().toUpperCase()
      const stored = seatRef.current
      // Reuse a stored token for THIS room, so a reload rejoins the seat you
      // already had instead of consuming a second one.
      const token = stored && stored.roomCode === code ? stored.reconnectToken : undefined
      connect(code, { type: 'join', name, reconnectToken: token })
    },
    [connect],
  )

  const startGame = useCallback(() => {
    if (!wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'start' } satisfies ClientMessage))
  }, [])

  const act = useCallback((action: MatchAction) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // The old dispatch returned silently here, which turned every click
      // into a permanent no-op with zero feedback.
      setError('Not connected — trying to reconnect.')
      return
    }
    wsRef.current.send(JSON.stringify({ type: 'action', action } satisfies ClientMessage))
  }, [])

  const leave = useCallback(() => {
    wantConnectedRef.current = false
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    wsRef.current?.close()
    wsRef.current = null
    seatRef.current = null
    saveSeat(null)
    setMatch(null)
    setLobby(null)
    setMyPlayerId(null)
    setLog([])
    setDebugLog([])
    setError(null)
    setConnection('idle')
  }, [])

  useEffect(() => {
    return () => {
      wantConnectedRef.current = false
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [])

  // Stable identity: an inline arrow here is a new function every render,
  // which defeats memoization in anything that takes it as a prop.
  const clearError = useCallback(() => setError(null), [])

  const storedSeat = seatRef.current
  return { match, lobby, myPlayerId, log, debugLog, error, connection, createRoom, joinRoom, startGame, act, leave, storedSeat, clearError }
}
