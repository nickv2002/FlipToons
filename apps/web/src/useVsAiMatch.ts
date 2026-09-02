import { useEffect, useRef, useState } from 'react'
import { activePlayerId } from '../../../packages/engine/match'
import type { Match } from '../../../packages/engine/state'
import type { MatchDifficulty } from '../../../packages/engine/ai'
import type { MatchClient } from './useMatch'
import type { MatchAiWorkerRequest, MatchAiWorkerResponse } from './ai/matchAiWorker'

// Mirrors packages/engine/ai/matchAdapter.ts's legalCandidates just enough to
// answer "is it worth spawning a search right now" — the actual decision
// (including the exact same ordering: a seat's own simultaneous prompt
// before any turn-gated phase) is left entirely to chooseBestMatchAction
// inside the worker, which re-derives it from the authoritative Match. This
// is a cheap gate, not a second implementation of the engine's rules.
function isBotDecisionPending(match: Match, botSeatId: string): boolean {
  if (match.shared.phase === 'ended') return false
  const player = match.players.find((p) => p.playerId === botSeatId)
  if (player?.pendingPostFameChoice || player?.pendingOnHireChoice) return true
  if (match.shared.phase === 'gridReset' || match.shared.phase === 'market') {
    return activePlayerId(match) === botSeatId
  }
  return false
}

export type UseVsAiMatchResult = {
  aiThinking: boolean
  aiError: string | null
}

// Wraps a useMatch() client with a client-side bot seat. Does nothing at all
// — no worker, no extra renders of consequence — when `botSeatId` is null,
// which is how plain multiplayer rooms (vsAi: false, no isBot seat in the
// lobby) stay completely unaffected by this hook existing.
export function useVsAiMatch(match: MatchClient, botSeatId: string | null, difficulty: MatchDifficulty): UseVsAiMatchResult {
  const [aiThinking, setAiThinking] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const inFlightRef = useRef(false)

  // One persistent worker per room, torn down on unmount or when the seat
  // changes (leaving a room, joining another) — never per-decision, so a
  // multi-turn game doesn't pay a worker spin-up cost on every bot move.
  useEffect(() => {
    if (!botSeatId) return
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
      inFlightRef.current = false
    }
  }, [botSeatId])

  useEffect(() => {
    if (!botSeatId || !match.match) return
    if (inFlightRef.current) return
    if (!isBotDecisionPending(match.match, botSeatId)) return

    const requestMatch = match.match
    inFlightRef.current = true
    setAiThinking(true)
    setAiError(null)

    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./ai/matchAiWorker.ts', import.meta.url), { type: 'module' })
    }
    const worker = workerRef.current

    const onMessage = (event: MessageEvent<MatchAiWorkerResponse>) => {
      worker.removeEventListener('message', onMessage)
      inFlightRef.current = false
      setAiThinking(false)
      if ('error' in event.data) {
        // Simplest acceptable fallback (see the plan this hook was built
        // from): surface it and stop. A stalled bot seat still has a live
        // socket, so the server's own disconnect-based turn timeout does NOT
        // apply here — this is a known gap, not an oversight, and inventing
        // a second recovery path client-side would be speculative.
        setAiError(event.data.error)
        return
      }
      match.act(event.data.action, botSeatId)
    }
    worker.addEventListener('message', onMessage)
    const request: MatchAiWorkerRequest = { match: requestMatch, botSeatId, difficulty }
    worker.postMessage(request)

    return () => {
      worker.removeEventListener('message', onMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botSeatId, difficulty, match.match])

  return { aiThinking, aiError }
}
