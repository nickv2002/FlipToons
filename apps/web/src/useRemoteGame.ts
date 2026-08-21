import { useCallback, useRef, useState } from 'react'
import type { GameState } from '../../../packages/engine/state'
import type { SoloDifficulty } from '../../../packages/engine/setup'
import type { Action } from '../../../packages/engine/actions'
import { DEFAULT_PORT } from '../../server/protocol'
import type { ClientMessage, ServerMessage } from '../../server/protocol'
import type { LogEntry } from './useGame'

const SERVER_URL = `ws://${window.location.hostname}:${DEFAULT_PORT}`

// Remote counterpart to useGame.ts's local mode — same return shape
// ({state, log, dispatch, startNewGame, abandonGame}) so App.tsx can swap
// between the two without RoundView/ResolveLog caring which is active. The
// server is authoritative here: dispatch only sends the action over the
// socket and waits for the resulting {type:'state'} broadcast — it never
// runs applyAction locally.
export function useRemoteGame() {
  const [state, setState] = useState<GameState | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [debugLog, setDebugLog] = useState<LogEntry[]>([])
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Opened imperatively from click handlers (not a useEffect) — React 18
  // StrictMode double-invokes effects in dev, which would open two sockets
  // and send two 'create' messages. useGame.ts hits the same class of issue
  // with its save-effect; same fix here, just applied to socket lifecycle.
  const connect = useCallback((onOpen: (ws: WebSocket) => void) => {
    wsRef.current?.close()
    const ws = new WebSocket(SERVER_URL)
    wsRef.current = ws
    setError(null)

    ws.addEventListener('message', (ev) => {
      const message: ServerMessage = JSON.parse(ev.data as string)
      if (message.type === 'joined') {
        setRoomCode(message.roomCode)
        setState(message.state)
        setLog(message.log.map((text) => ({ round: message.state.round, text })))
        setDebugLog(message.debugLog.map((text) => ({ round: message.state.round, text })))
        setError(null)
      } else if (message.type === 'state') {
        setState(message.state)
        if (message.logLines.length > 0) {
          setLog((prev) => [...prev, ...message.logLines.map((text) => ({ round: message.state.round, text }))])
        }
        if (message.debugLines.length > 0) {
          setDebugLog((prev) => [...prev, ...message.debugLines.map((text) => ({ round: message.state.round, text }))])
        }
      } else if (message.type === 'error') {
        setError(message.message)
      }
    })

    ws.addEventListener('open', () => onOpen(ws))
    ws.addEventListener('close', () => {
      if (wsRef.current === ws) wsRef.current = null
    })
  }, [])

  const startNewGame = useCallback(
    (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => {
      connect((ws) => {
        const message: ClientMessage = { type: 'create', seed, difficulty, season }
        ws.send(JSON.stringify(message))
      })
    },
    [connect],
  )

  const rejoinRoom = useCallback(
    (code: string) => {
      connect((ws) => {
        const message: ClientMessage = { type: 'join', roomCode: code }
        ws.send(JSON.stringify(message))
      })
    },
    [connect],
  )

  const dispatch = useCallback(
    (action: Action) => {
      if (!wsRef.current || !roomCode) return
      const message: ClientMessage = { type: 'action', roomCode, action }
      wsRef.current.send(JSON.stringify(message))
    },
    [roomCode],
  )

  const abandonGame = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    setState(null)
    setLog([])
    setDebugLog([])
    setRoomCode(null)
    setError(null)
  }, [])

  return { state, log, debugLog, dispatch, startNewGame, abandonGame, roomCode, error, rejoinRoom }
}
