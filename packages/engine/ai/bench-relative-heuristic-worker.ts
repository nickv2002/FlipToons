// Isolates a candidate RELATIVE-STANDING heuristic from the shipped
// matchScoreState (own-view-only). Match play is decided by standing
// relative to opponents at the Final Flip (CLAUDE.md: "no cumulative score
// anywhere... what decides a match is standing relative to the other
// seats"), which is exactly what matchReward's own fameLead already
// measures for the TERMINAL/near-terminal reward — but matchScoreState (the
// heuristicScore hook that biases WHICH candidate a rollout step samples)
// only ever looks at the bot's own view, with no notion of whether the
// opponent is ahead or behind. This bench tests whether folding a
// same-shaped lead signal into the ROLLOUT heuristic itself helps.
//
// Seat A: the real, shipped buildMatchAdapter (matchScoreState, own-view
// only). Seat B: the same adapter with heuristicScore swapped for a
// candidate that adds bot-live-fame-minus-best-opponent-live-fame
// (normalized by fameToTriggerEndgame) on top of matchScoreState. Both
// seats otherwise identical (same opponentActionFor, same sim budget) — any
// win-rate gap is purely from this one heuristic change.
import type { Season } from '../cards/types'
import { buildNewMatch, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import type { AiAdapter } from './core'
import { matchScoreState, liveGridFame } from './heuristic'
import { applyMatchAction } from '../matchActions'
import type { MatchAction } from '../matchActions'
import type { Match, PlayerId } from '../state'
import { viewOf } from '../state'
import { playerIndex } from '../match'

export type RelativeHeuristicTask = {
  taskId: number
  seed: number
  season: Season
  simulations: number
  maxStepsPerPlayout: number
  aIsP0: boolean
  leadWeight: number
}
export type RelativeHeuristicResult = {
  taskId: number
  season: Season
  winner: 'A' | 'B' | 'tie' | 'notEnded'
  turns: number
}

const MAX_TURNS = 500

function relativeScoreState(match: Match, botSeatId: PlayerId, leadWeight: number): number {
  const index = playerIndex(match, botSeatId)
  const own = matchScoreState(viewOf(match, index))
  const threshold = match.shared.fameToTriggerEndgame || 1
  const ownLive = liveGridFame(viewOf(match, index))
  let bestOpponentLive = 0
  for (let i = 0; i < match.players.length; i++) {
    if (i === index) continue
    bestOpponentLive = Math.max(bestOpponentLive, liveGridFame(viewOf(match, i)))
  }
  const leadSignal = (ownLive - bestOpponentLive) / threshold
  return own + leadWeight * leadSignal
}

function relativeAdapter(botSeatId: PlayerId, leadWeight: number): AiAdapter<Match, MatchAction> {
  const real = buildMatchAdapter(botSeatId)
  return {
    ...real,
    heuristicScore(match) {
      return relativeScoreState(match, botSeatId, leadWeight)
    },
  }
}

function runGame(task: RelativeHeuristicTask): RelativeHeuristicResult {
  const seatA: PlayerId = task.aIsP0 ? 'p0' : 'p1'
  const seatB: PlayerId = task.aIsP0 ? 'p1' : 'p0'
  const adapterA = buildMatchAdapter(seatA) // shipped matchScoreState, own-view only
  const adapterB = relativeAdapter(seatB, task.leadWeight) // candidate: + opponent-lead term
  const opts = { simulations: task.simulations, maxStepsPerPlayout: task.maxStepsPerPlayout }

  let match: Match = buildNewMatch(task.seed, 2, task.season)
  let turns = 0
  while (match.shared.phase !== 'ended' && turns < MAX_TURNS) {
    if (adapterA.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatA, chooseBestAction(adapterA, match, opts)).match
    } else if (adapterB.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatB, chooseBestAction(adapterB, match, opts)).match
    } else if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
      match = applyMatchAction(match, seatA, { kind: 'advanceFlip' }).match
    } else {
      throw new Error(`bench-relative-heuristic-worker: stuck in phase '${match.shared.phase}' with no decider`)
    }
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, season: task.season, winner: 'notEnded', turns }
  if (match.shared.winnerId === seatA) return { taskId: task.taskId, season: task.season, winner: 'A', turns }
  if (match.shared.winnerId === seatB) return { taskId: task.taskId, season: task.season, winner: 'B', turns }
  return { taskId: task.taskId, season: task.season, winner: 'tie', turns }
}

declare const self: {
  onmessage: ((event: { data: RelativeHeuristicTask }) => void) | null
  postMessage: (data: RelativeHeuristicResult) => void
}

self.onmessage = (event) => {
  self.postMessage(runGame(event.data))
}
