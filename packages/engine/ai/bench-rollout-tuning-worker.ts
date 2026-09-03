// Isolates core.ts's HEURISTIC_ROLLOUT_TEMPERATURE / MAX_SCORED_ROLLOUT_CANDIDATES
// tuning for MATCH play specifically, now that AiOptions can override both
// per-call (core.ts) without touching solo's validated defaults. Both seats
// use the real buildMatchAdapter (matchScoreState-weighted rollouts,
// bounded-greedy opponent modeling) for their own real decisions — seat A at
// core.ts's solo-tuned defaults, seat B at the candidate override — so any
// win-rate gap is purely from this one knob, at the SAME simulation budget.
import type { Season } from '../cards/types'
import { buildNewMatch, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import { applyMatchAction } from '../matchActions'
import type { Match, PlayerId } from '../state'

export type RolloutTuningTask = {
  taskId: number
  seed: number
  season: Season
  simulations: number
  maxStepsPerPlayout: number
  aIsP0: boolean
  temperatureB?: number
  candidateCapB?: number
}
export type RolloutTuningResult = {
  taskId: number
  season: Season
  winner: 'A' | 'B' | 'tie' | 'notEnded'
  turns: number
}

const MAX_TURNS = 500

function runGame(task: RolloutTuningTask): RolloutTuningResult {
  const seatA: PlayerId = task.aIsP0 ? 'p0' : 'p1'
  const seatB: PlayerId = task.aIsP0 ? 'p1' : 'p0'
  const adapterA = buildMatchAdapter(seatA)
  const adapterB = buildMatchAdapter(seatB)
  const optsA = { simulations: task.simulations, maxStepsPerPlayout: task.maxStepsPerPlayout }
  const optsB = {
    simulations: task.simulations,
    maxStepsPerPlayout: task.maxStepsPerPlayout,
    heuristicRolloutTemperature: task.temperatureB,
    maxScoredRolloutCandidates: task.candidateCapB,
  }

  let match: Match = buildNewMatch(task.seed, 2, task.season)
  let turns = 0
  while (match.shared.phase !== 'ended' && turns < MAX_TURNS) {
    if (adapterA.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatA, chooseBestAction(adapterA, match, optsA)).match
    } else if (adapterB.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatB, chooseBestAction(adapterB, match, optsB)).match
    } else if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
      match = applyMatchAction(match, seatA, { kind: 'advanceFlip' }).match
    } else {
      throw new Error(`bench-rollout-tuning-worker: stuck in phase '${match.shared.phase}' with no decider`)
    }
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, season: task.season, winner: 'notEnded', turns }
  if (match.shared.winnerId === seatA) return { taskId: task.taskId, season: task.season, winner: 'A', turns }
  if (match.shared.winnerId === seatB) return { taskId: task.taskId, season: task.season, winner: 'B', turns }
  return { taskId: task.taskId, season: task.season, winner: 'tie', turns }
}

declare const self: {
  onmessage: ((event: { data: RolloutTuningTask }) => void) | null
  postMessage: (data: RolloutTuningResult) => void
}

self.onmessage = (event) => {
  self.postMessage(runGame(event.data))
}
