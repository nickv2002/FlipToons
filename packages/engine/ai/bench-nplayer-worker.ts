// N-player generalization check for this session's three shipped match-AI
// changes (matchScoreState, bounded-greedy opponentActionFor,
// RELATIVE_LEAD_WEIGHT) — all three were validated only at 2 seats, but the
// feature's real scope is 2-4 players (CLAUDE.md). One seat ("candidate")
// uses the current shipped buildMatchAdapter; every other seat
// ("baseline") uses the pre-session equivalent: heuristicScore stripped
// AND opponentActionFor's rollout stand-in replaced with the old passive
// policy (first option; always just end a Market turn) — i.e. exactly what
// this whole session's search quality looked like before any of the three
// changes. Candidate seat index rotates across games so seat order can't
// bias the result. Reports candidate win rate vs "any baseline seat won".
import type { Season } from '../cards/types'
import { buildNewMatch, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import type { AiAdapter } from './core'
import { applyMatchAction } from '../matchActions'
import type { MatchAction } from '../matchActions'
import { activePlayerId, playerIndex } from '../match'
import type { Match, PlayerId } from '../state'

export type NPlayerTask = {
  taskId: number
  seed: number
  season: Season
  playerCount: number
  simulations: number
  maxStepsPerPlayout: number
  candidateSeatIndex: number
}
export type NPlayerResult = {
  taskId: number
  playerCount: number
  winner: 'candidate' | 'baseline' | 'tie' | 'notEnded'
  turns: number
}

const MAX_TURNS = 800
const MAX_ADVANCE_STEPS = 3000

function passiveActionFor(match: Match, playerId: PlayerId): MatchAction {
  const index = playerIndex(match, playerId)
  const player = match.players[index]!
  if (player.pendingPostFameChoice) {
    const o = player.pendingPostFameChoice.options[0]!
    return { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index }
  }
  if (player.pendingOnHireChoice) {
    const choice = player.pendingOnHireChoice.choice
    const first = choice.kind === 'discardMarketAndRefill' ? [choice.options[0]!] : choice.options[0]!
    return { kind: 'resolvePendingOnHireChoice', selection: first as never }
  }
  if (match.shared.phase === 'gridReset') return { kind: 'bigButtonDecision', use: false }
  if (match.shared.phase === 'market') {
    if (player.pendingPostMarketChoice) {
      const o = player.pendingPostMarketChoice.options[0]!
      return { kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }
    }
    if (player.pendingDeckPlacement) return { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } }
    return { kind: 'endTurn' }
  }
  return { kind: 'advanceFlip' }
}

function passiveAdvance(match: Match, botSeatId: PlayerId, legalCandidates: (m: Match) => MatchAction[]): Match {
  let m = match
  for (let steps = 0; steps < MAX_ADVANCE_STEPS; steps++) {
    if (m.shared.phase === 'ended') return m
    if (legalCandidates(m).length > 0) return m
    if (m.shared.phase === 'flip' || m.shared.phase === 'finalFlip') {
      m = applyMatchAction(m, botSeatId, { kind: 'advanceFlip' }).match
      continue
    }
    const owingOpponent = m.players.find((p) => p.pendingPostFameChoice || p.pendingOnHireChoice)
    if (owingOpponent) {
      m = applyMatchAction(m, owingOpponent.playerId, passiveActionFor(m, owingOpponent.playerId)).match
      continue
    }
    if (m.shared.phase === 'gridReset') {
      const decider = activePlayerId(m)
      m = applyMatchAction(m, decider, passiveActionFor(m, decider)).match
      continue
    }
    if (m.shared.phase === 'market') {
      const active = activePlayerId(m)
      if (active === botSeatId) return m
      m = applyMatchAction(m, active, passiveActionFor(m, active)).match
      continue
    }
    throw new Error(`bench-nplayer-worker: stuck in phase '${m.shared.phase}'`)
  }
  throw new Error('bench-nplayer-worker: exceeded MAX_ADVANCE_STEPS')
}

function baselineAdapter(botSeatId: PlayerId): AiAdapter<Match, MatchAction> {
  const real = buildMatchAdapter(botSeatId)
  return {
    ...real,
    heuristicScore: undefined,
    apply(match, action) {
      const applied = applyMatchAction(match, botSeatId, action).match
      return passiveAdvance(applied, botSeatId, real.legalCandidates)
    },
  }
}

function runGame(task: NPlayerTask): NPlayerResult {
  const seats: PlayerId[] = Array.from({ length: task.playerCount }, (_, i) => `p${i}` as PlayerId)
  const candidateSeat = seats[task.candidateSeatIndex]!
  const adapters = new Map<PlayerId, AiAdapter<Match, MatchAction>>()
  for (const seat of seats) adapters.set(seat, seat === candidateSeat ? buildMatchAdapter(seat) : baselineAdapter(seat))
  const opts = { simulations: task.simulations, maxStepsPerPlayout: task.maxStepsPerPlayout }

  let match: Match = buildNewMatch(task.seed, task.playerCount, task.season)
  let turns = 0
  while (match.shared.phase !== 'ended' && turns < MAX_TURNS) {
    let decided = false
    for (const seat of seats) {
      const adapter = adapters.get(seat)!
      if (adapter.legalCandidates(match).length > 0) {
        match = applyMatchAction(match, seat, chooseBestAction(adapter, match, opts)).match
        decided = true
        break
      }
    }
    if (!decided) {
      if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
        match = applyMatchAction(match, seats[0]!, { kind: 'advanceFlip' }).match
      } else {
        throw new Error(`bench-nplayer-worker: stuck in phase '${match.shared.phase}' with no decider`)
      }
    }
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, playerCount: task.playerCount, winner: 'notEnded', turns }
  if (match.shared.winnerId === candidateSeat) return { taskId: task.taskId, playerCount: task.playerCount, winner: 'candidate', turns }
  if (match.shared.winnerId === null) return { taskId: task.taskId, playerCount: task.playerCount, winner: 'tie', turns }
  return { taskId: task.taskId, playerCount: task.playerCount, winner: 'baseline', turns }
}

declare const self: {
  onmessage: ((event: { data: NPlayerTask }) => void) | null
  postMessage: (data: NPlayerResult) => void
}

self.onmessage = (event) => {
  self.postMessage(runGame(event.data))
}
