// Single-game worker for bench-match.ts's A/B pool. Runs one full 2-seat
// match: seat A uses buildMatchAdapter (heuristicScore-weighted rollouts),
// seat B uses the same adapter with heuristicScore stripped (uniform-random
// rollouts) — see bench-match.ts's header for why.
//
// IMPORTANT: the outer loop below determines "whose real decision is this"
// via each seat's OWN adapter.legalCandidates(match) — never via
// advanceToBotDecision on the real match state. advanceToBotDecision's
// opponentActionFor stand-in exists ONLY to model a hypothetical opponent
// INSIDE one seat's own rollouts (adapter.apply, called from deep inside
// chooseBestAction's search) — using it to advance the REAL match between
// real turns would silently resolve the other seat's actual decisions with
// the cheap stand-in instead of that seat's own real search, which is not a
// bot-vs-bot game at all. This bug was caught before trusting any bench
// numbers from this file — see its fix commit.
import type { Season } from '../cards/types'
import { buildNewMatch, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import type { AiAdapter } from './core'
import { applyMatchAction } from '../matchActions'
import type { MatchAction } from '../matchActions'
import type { Match, PlayerId } from '../state'

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
  season: Season
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
    if (adapterA.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatA, chooseBestAction(adapterA, match, opts)).match
    } else if (adapterB.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatB, chooseBestAction(adapterB, match, opts)).match
    } else if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
      // Shared, neutral advance — legal from any seat, decides nothing.
      match = applyMatchAction(match, seatA, { kind: 'advanceFlip' }).match
    } else {
      throw new Error(`bench-match-worker: stuck in phase '${match.shared.phase}' with no decider`)
    }
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, season: task.season, winner: 'notEnded', turns }
  if (match.shared.winnerId === seatA) return { taskId: task.taskId, season: task.season, winner: 'A', turns }
  if (match.shared.winnerId === seatB) return { taskId: task.taskId, season: task.season, winner: 'B', turns }
  return { taskId: task.taskId, season: task.season, winner: 'tie', turns }
}

// tsconfig here has no "webworker" lib (the engine package stays lib:
// ESNext-only), so the worker globals are declared locally rather than
// pulling in DOM/webworker types repo-wide — mirrors bench-worker.ts.
declare const self: {
  onmessage: ((event: { data: BenchMatchTask }) => void) | null
  postMessage: (data: BenchMatchResult) => void
}

self.onmessage = (event) => {
  self.postMessage(runGame(event.data))
}
