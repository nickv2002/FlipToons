import { useEffect, useRef, useState } from 'react'
import { activePlayerId } from '../../../packages/engine/match'
import type { Match } from '../../../packages/engine/state'
import type { MatchDifficulty } from '../../../packages/engine/ai'
import type { MatchClient } from './useMatch'
import type { MatchAiWorkerRequest, MatchAiWorkerResponse } from './ai/matchAiWorker'

export type BotSeat = { playerId: string; difficulty: MatchDifficulty }

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

export type UseBotSeatsResult = {
  thinkingSeatId: string | null
  error: string | null
}

// Wraps a useMatch() client with client-side compute for every bot seat in
// the room. Does nothing at all — no worker, no extra renders of consequence
// — when `bots` is empty, which is how plain multiplayer rooms (no bot
// seats) stay completely unaffected by this hook existing.
//
// Only one bot decision is ever driven at a time (same discipline the
// single-bot version had): each render picks the FIRST bot seat (in `bots`
// order) that currently has a pending decision, and re-scans after that
// move lands. Several bots never need to move simultaneously — the engine
// itself is turn-based/one-simultaneous-prompt-at-a-time — so this never
// starves a later bot, it only ever defers it by one render.
export function useBotSeats(match: MatchClient, bots: BotSeat[]): UseBotSeatsResult {
  const [thinkingSeatId, setThinkingSeatId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const inFlightRef = useRef(false)

  const botsKey = bots.map((b) => `${b.playerId}:${b.difficulty}`).join(',')

  // One persistent worker per room, torn down on unmount or when the set of
  // bot seats changes (leaving a room, joining another) — never per-decision,
  // so a multi-turn game doesn't pay a worker spin-up cost on every bot move.
  useEffect(() => {
    if (bots.length === 0) return
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
      inFlightRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botsKey])

  useEffect(() => {
    if (bots.length === 0 || !match.match) return
    if (inFlightRef.current) return
    const pending = bots.find((b) => isBotDecisionPending(match.match!, b.playerId))
    if (!pending) return

    const requestMatch = match.match
    inFlightRef.current = true
    setThinkingSeatId(pending.playerId)
    setError(null)

    if (!workerRef.current) {
      try {
        workerRef.current = new Worker(new URL('./ai/matchAiWorker.ts', import.meta.url), { type: 'module' })
      } catch (e) {
        inFlightRef.current = false
        setThinkingSeatId(null)
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    const worker = workerRef.current

    const onMessage = (event: MessageEvent<MatchAiWorkerResponse>) => {
      worker.removeEventListener('message', onMessage)
      inFlightRef.current = false
      setThinkingSeatId(null)
      if ('error' in event.data) {
        // Simplest acceptable fallback (see the plan this hook was built
        // from): surface it and stop. A stalled bot seat still has a live
        // socket, so the server's own disconnect-based turn timeout does NOT
        // apply here — this is a known gap, not an oversight, and inventing
        // a second recovery path client-side would be speculative.
        setError(event.data.error)
        return
      }
      match.act(event.data.action, pending.playerId)
    }
    worker.addEventListener('message', onMessage)
    const request: MatchAiWorkerRequest = { match: requestMatch, botSeatId: pending.playerId, difficulty: pending.difficulty }
    worker.postMessage(request)

    return () => {
      worker.removeEventListener('message', onMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botsKey, match.match])

  return { thinkingSeatId, error }
}
