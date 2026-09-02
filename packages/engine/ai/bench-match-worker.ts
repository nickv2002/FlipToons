// Single-game worker for bench-match.ts's A/B pool. Runs one full 2-seat
// match: seat A uses buildMatchAdapter (heuristicScore-weighted rollouts),
// seat B uses the same adapter with heuristicScore stripped (uniform-random
// rollouts) — see bench-match.ts's header for why.
import type { Season } from '../cards/types'
import { buildNewMatch, advanceToBotDecision, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import type { AiAdapter } from './core'
import { applyMatchAction } from '../matchActions'
import type { Match, MatchAction, PlayerId } from '../state'

export type BenchMatchTask = {
  taskId: number
  seed: number
  season: Season
  simulations: number
  maxStepsPerPlayout: number
  aIsP0: boolean
}
export type BenchMatchResult = {
  taskId: number
  winner: 'A' | 'B' | 'tie' | 'notEnded'
  turns: number
}

const MAX_TURNS = 500

function rawAdapter(botSeatId: PlayerId): AiAdapter<Match, MatchAction> {
  const adapter = buildMatchAdapter(botSeatId)
  return { ...adapter, heuristicScore: undefined }
}

function runGame(task: BenchMatchTask): BenchMatchResult {
  const seatA: PlayerId = task.aIsP0 ? 'p0' : 'p1'
  const seatB: PlayerId = task.aIsP0 ? 'p1' : 'p0'
  const adapterA = buildMatchAdapter(seatA)
  const adapterB = rawAdapter(seatB)
  const opts = { simulations: task.simulations, maxStepsPerPlayout: task.maxStepsPerPlayout }

  let match: Match = buildNewMatch(task.seed, 2, task.season)
  let turns = 0
  while (match.shared.phase !== 'ended' && turns < MAX_TURNS) {
    const atA = advanceToBotDecision(match, seatA)
    if (atA.shared.phase === 'ended') {
      match = atA
      break
    }
    const legalA = adapterA.legalCandidates(atA)
    const seat = legalA.length > 0 ? seatA : seatB
    const at = seat === seatA ? atA : advanceToBotDecision(match, seatB)
    const adapter = seat === seatA ? adapterA : adapterB
    const action = chooseBestAction(adapter, at, opts)
    match = applyMatchAction(at, seat, action).match
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, winner: 'notEnded', turns }
  if (match.shared.winnerId === seatA) return { taskId: task.taskId, winner: 'A', turns }
  if (match.shared.winnerId === seatB) return { taskId: task.taskId, winner: 'B', turns }
  return { taskId: task.taskId, winner: 'tie', turns }
}

self.onmessage = (event: MessageEvent<BenchMatchTask>) => {
  const result = runGame(event.data)
  ;(self as unknown as Worker).postMessage(result)
}
