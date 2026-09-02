// Isolates matchAdapter.ts's opponentActionFor change from the earlier
// heuristicScore change: BOTH seats here use the real buildMatchAdapter
// (heuristicScore-weighted rollouts, identical sim budget) for their OWN
// real decisions. The only difference is which policy stands in for the
// OTHER seat inside each seat's own rollouts (adapter.apply's internal
// fast-forward, never the outer real-game loop — see bench-match-worker.ts's
// header for why that distinction matters and the bug it fixes). Seat A's
// adapter is the real one (opponentActionFor's bounded-greedy policy). Seat
// B's adapter is the same adapter with `apply` swapped to a hand-rolled
// passive stand-in for rollouts only (matches the pre-change behavior: pick
// the first option, and on an ordinary Market turn always just end it).
import type { Season } from '../cards/types'
import { buildNewMatch, buildMatchAdapter } from './matchAdapter'
import { chooseBestAction } from './core'
import type { AiAdapter } from './core'
import { applyMatchAction } from '../matchActions'
import type { MatchAction } from '../matchActions'
import { activePlayerId, playerIndex } from '../match'
import type { Match, PlayerId } from '../state'

export type OpponentPolicyTask = {
  taskId: number
  seed: number
  season: Season
  simulations: number
  maxStepsPerPlayout: number
  aIsP0: boolean
}
export type OpponentPolicyResult = {
  taskId: number
  season: Season
  winner: 'A' | 'B' | 'tie' | 'notEnded'
  turns: number
}

const MAX_TURNS = 500
const MAX_ADVANCE_STEPS = 2000

// Pre-change opponent stand-in used ONLY inside seat B's own rollouts, to
// model whoever ISN'T B (i.e. seat A, hypothetically) during B's search.
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
  if (match.shared.phase === 'gridReset') {
    return { kind: 'bigButtonDecision', use: false }
  }
  if (match.shared.phase === 'market') {
    if (player.pendingPostMarketChoice) {
      const o = player.pendingPostMarketChoice.options[0]!
      return { kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }
    }
    if (player.pendingDeckPlacement) {
      return { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } }
    }
    return { kind: 'endTurn' }
  }
  return { kind: 'advanceFlip' }
}

// Fast-forwards a CLONED rollout state (never the real match) past every
// decision that isn't seatB's own, using the passive stand-in — the direct
// analog of matchAdapter.ts's advanceToBotDecision, reimplemented here only
// because that function is hardwired to opponentActionFor.
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
    throw new Error(`bench-opponent-policy-worker: stuck in phase '${m.shared.phase}'`)
  }
  throw new Error('bench-opponent-policy-worker: exceeded MAX_ADVANCE_STEPS')
}

function passiveOpponentAdapter(botSeatId: PlayerId): AiAdapter<Match, MatchAction> {
  const real = buildMatchAdapter(botSeatId)
  return {
    ...real,
    apply(match, action) {
      const applied = applyMatchAction(match, botSeatId, action).match
      return passiveAdvance(applied, botSeatId, real.legalCandidates)
    },
  }
}

function runGame(task: OpponentPolicyTask): OpponentPolicyResult {
  const seatA: PlayerId = task.aIsP0 ? 'p0' : 'p1'
  const seatB: PlayerId = task.aIsP0 ? 'p1' : 'p0'
  const adapterA = buildMatchAdapter(seatA) // real bounded-greedy opponent modeling, in its own rollouts
  const adapterB = passiveOpponentAdapter(seatB) // pre-change passive opponent modeling, in its own rollouts
  const opts = { simulations: task.simulations, maxStepsPerPlayout: task.maxStepsPerPlayout }

  let match: Match = buildNewMatch(task.seed, 2, task.season)
  let turns = 0
  while (match.shared.phase !== 'ended' && turns < MAX_TURNS) {
    // Real decisions for the REAL match are always each seat's own top-level
    // search — never the rollout stand-in. adapter.legalCandidates(match)
    // answers "is this genuinely my decision right now" without resolving
    // anything, which is exactly the check needed here (mirrors
    // matchAdapter.ts's own legalCandidates semantics for each seat).
    if (adapterA.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatA, chooseBestAction(adapterA, match, opts)).match
    } else if (adapterB.legalCandidates(match).length > 0) {
      match = applyMatchAction(match, seatB, chooseBestAction(adapterB, match, opts)).match
    } else if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
      match = applyMatchAction(match, seatA, { kind: 'advanceFlip' }).match
    } else {
      throw new Error(`bench-opponent-policy-worker: stuck in phase '${match.shared.phase}' with no decider`)
    }
    turns++
  }

  if (match.shared.phase !== 'ended') return { taskId: task.taskId, season: task.season, winner: 'notEnded', turns }
  if (match.shared.winnerId === seatA) return { taskId: task.taskId, season: task.season, winner: 'A', turns }
  if (match.shared.winnerId === seatB) return { taskId: task.taskId, season: task.season, winner: 'B', turns }
  return { taskId: task.taskId, season: task.season, winner: 'tie', turns }
}

declare const self: {
  onmessage: ((event: { data: OpponentPolicyTask }) => void) | null
  postMessage: (data: OpponentPolicyResult) => void
}

self.onmessage = (event) => {
  self.postMessage(runGame(event.data))
}
