import { useCallback, useEffect, useRef, useState } from 'react'
import type { Match } from '../../../packages/engine/state'
import type { LogLine, MatchAction } from '../../../packages/engine/matchActions'
import { DEFAULT_PORT } from '../../server/protocol'
import type { ClientMessage, LobbyState, ServerMessage } from '../../server/protocol'

const SERVER_URL = `ws://${window.location.hostname}:${DEFAULT_PORT}`

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

  const connect = useCallback((first: ClientMessage, reconnecting = false) => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    wsRef.current?.close()
    openMessageRef.current = first
    wantConnectedRef.current = true
    setConnection(reconnecting ? 'reconnecting' : 'connecting')
    if (!reconnecting) setError(null)

    const ws = new WebSocket(SERVER_URL)
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
      const message: ServerMessage = JSON.parse(ev.data as string)
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
      // Dropped while we still wanted to be in a game — come back on our own
      // rather than leaving every click a silent no-op.
      setConnection('reconnecting')
      const seat = seatRef.current
      retryTimerRef.current = setTimeout(() => {
        if (!wantConnectedRef.current) return
        if (seat) connect({ type: 'join', roomCode: seat.roomCode, name: seat.name, reconnectToken: seat.reconnectToken }, true)
      }, RECONNECT_DELAY_MS)
    })
  }, [])

  const createRoom = useCallback(
    (opts: { name: string; playerCount: number; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }) => {
      connect({ type: 'create', ...opts })
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
      connect({ type: 'join', roomCode: code, name, reconnectToken: token })
    },
    [connect],
  )

  const startGame = useCallback(() => {
    const code = lobby?.roomCode ?? seatRef.current?.roomCode
    if (!code || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'start', roomCode: code } satisfies ClientMessage))
  }, [lobby])

  const act = useCallback(
    (action: MatchAction) => {
      const code = lobby?.roomCode ?? seatRef.current?.roomCode
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !code) {
        // The old dispatch returned silently here, which turned every click
        // into a permanent no-op with zero feedback.
        setError('Not connected — trying to reconnect.')
        return
      }
      wsRef.current.send(JSON.stringify({ type: 'action', roomCode: code, action } satisfies ClientMessage))
    },
    [lobby],
  )

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

  const storedSeat = seatRef.current
  return { match, lobby, myPlayerId, log, debugLog, error, connection, createRoom, joinRoom, startGame, act, leave, storedSeat, clearError: () => setError(null) }
}
