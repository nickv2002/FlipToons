// Build-order step 7's simulation-based evaluator (flip-toonz-structure-plan.md
// §8): "the only real decision is hire-or-dismiss, a simulation-based
// evaluator (play N rounds with each candidate action, keep the best) gets
// you a competent opponent without a full game-tree search." Solo has no
// opponent to be competent AGAINST, so this lands as a decision-support
// advisor for that same hire/dismiss/end decision: given a GameState in the
// Market phase, Monte-Carlo playout each legal candidate action forward
// (continuing with a cheap random policy) and score by how often the
// playout reaches a win. Reuses actions.ts's transport-free applyAction
// reducer for every step, so this is the exact same state machine
// apps/web and apps/server already drive — no separate simulation model to
// keep in sync.
import { applyAction, listDismissEntries } from './actions'
import type { Action } from './actions'
import { hireCost } from './market'
import type { Rng } from './rng'
import { makeRng } from './rng'
import type { GameState } from './state'

export type AiOptions = {
  simulations?: number // playouts per candidate action
  maxRoundsPerPlayout?: number // safety cap so a stuck playout can't loop forever
  rng?: Rng // the AI's OWN decision randomness — deliberately separate from state.rng (the game's deterministic seed), since advisory playouts must never perturb the real game's shuffle sequence
}

const DEFAULT_SIMULATIONS = 24
const DEFAULT_MAX_ROUNDS_PER_PLAYOUT = 30

// Every action legal in the Market phase right now: each affordable hire
// slot, each affordable dismissable card, and always `endMarket`. Filters on
// affordability up front rather than letting applyAction's rejection path
// handle it — cheaper, and keeps the candidate list meaningful (a candidate
// you can't afford isn't a real choice).
function marketCandidates(state: GameState): Action[] {
  const candidates: Action[] = [{ kind: 'endMarket' }]
  if (state.phase !== 'market' || state.actionsRemaining <= 0) return candidates

  state.market.slots.forEach((cardId, slotIndex) => {
    if (cardId === null) return
    if (hireCost(state.market, slotIndex) <= state.fame) candidates.push({ kind: 'hire', slotIndex })
  })

  for (const entry of listDismissEntries(state)) {
    candidates.push({ kind: 'dismiss', pos: entry.pos, index: entry.stackIndex })
  }

  return candidates
}

// Cheap continuation policy used ONLY inside a playout, after the candidate
// action under evaluation has already been applied — a uniform-random pick
// among whatever's currently legal. This is intentionally not "smart"; the
// outer evaluateAction/chooseBestMarketAction loop is what does the actual
// comparison, by averaging outcomes across many such playouts per candidate.
function rolloutMarketAction(state: GameState, rng: Rng): Action {
  const candidates = marketCandidates(state)
  return candidates[Math.floor(rng() * candidates.length)]!
}

// One automatic step through phases that have no real decision (flip,
// checkFame, postFameHooks — a proven pass-through in solo, see actions.ts's
// own comment — and cleanup), or one rollout market action otherwise.
function stepAutomatic(state: GameState, rng: Rng): GameState {
  if (state.phase === 'flip') return applyAction(state, { kind: 'flip' }).state
  if (state.phase === 'checkFame') return applyAction(state, { kind: 'checkFame' }).state
  if (state.phase === 'postFameHooks') return applyAction(state, { kind: 'continueToMarket' }).state
  if (state.phase === 'market') return applyAction(state, rolloutMarketAction(state, rng)).state
  if (state.phase === 'cleanup') return applyAction(state, { kind: 'advanceCleanup' }).state
  return state // 'ended' — nothing left to step
}

function playout(state: GameState, rng: Rng, maxRounds: number): GameState {
  let s = state
  const startRound = state.round
  while (s.phase !== 'ended' && s.round - startRound < maxRounds) {
    s = stepAutomatic(s, rng)
  }
  return s
}

// A finished playout scores 1 (win) or 0 (loss). One that hit the round cap
// without ending scores partial credit off how close this round's fame
// generation got to the win threshold — never as high as an actual win, and
// docked slightly if the toon deck is already depleted (an early warning
// the playout is trending toward a loss it just hasn't reached yet).
function scoreOutcome(state: GameState): number {
  if (state.phase === 'ended') return state.result === 'win' ? 1 : 0
  const progress = Math.min(0.95, state.fameGeneratedThisRound / state.fameToTriggerEndgame)
  return Math.max(0, progress - (state.toonDeckDepleted ? 0.1 : 0))
}

export function evaluateAction(state: GameState, action: Action, opts: AiOptions = {}): number {
  const simulations = opts.simulations ?? DEFAULT_SIMULATIONS
  const maxRounds = opts.maxRoundsPerPlayout ?? DEFAULT_MAX_ROUNDS_PER_PLAYOUT
  const rng = opts.rng ?? makeRng(Date.now() >>> 0)

  let total = 0
  for (let i = 0; i < simulations; i++) {
    const afterAction = applyAction(state, action).state
    total += scoreOutcome(playout(afterAction, rng, maxRounds))
  }
  return total / simulations
}

export type ScoredAction = { action: Action; score: number }

// Ranked highest-score-first. Ties (e.g. two playouts both scoring 1.0)
// resolve by candidate order, which puts `endMarket` first (see
// marketCandidates) — a mild, deliberate bias toward not spending fame it
// found no evidence spending helps with, rather than an arbitrary hire.
export function evaluateMarketCandidates(state: GameState, opts: AiOptions = {}): ScoredAction[] {
  if (state.phase !== 'market') throw new Error('ai.ts: evaluateMarketCandidates — state is not in the market phase')
  return marketCandidates(state)
    .map((action) => ({ action, score: evaluateAction(state, action, opts) }))
    .sort((a, b) => b.score - a.score)
}

export function chooseBestMarketAction(state: GameState, opts: AiOptions = {}): Action {
  return evaluateMarketCandidates(state, opts)[0]!.action
}

export type AutoplayResult = { state: GameState; logLines: string[]; actionsTaken: Action[] }

// Drives an entire solo game to completion (or a round cap), using
// chooseBestMarketAction — the real search, not the cheap rollout policy —
// for every Market decision. This is the tui.ts --ai / apps/web "autoplay"
// entry point: same actions.ts reducer the human-driven paths use, so its
// log lines are the same shape a human's playthrough would produce.
export function playAutomatically(state: GameState, opts: AiOptions & { maxRounds?: number } = {}): AutoplayResult {
  const maxRounds = opts.maxRounds ?? 200
  const startRound = state.round
  let s = state
  const logLines: string[] = []
  const actionsTaken: Action[] = []

  while (s.phase !== 'ended' && s.round - startRound < maxRounds) {
    let action: Action
    if (s.phase === 'flip') action = { kind: 'flip' }
    else if (s.phase === 'checkFame') action = { kind: 'checkFame' }
    else if (s.phase === 'postFameHooks') action = { kind: 'continueToMarket' }
    else if (s.phase === 'market') action = chooseBestMarketAction(s, opts)
    else if (s.phase === 'cleanup') action = { kind: 'advanceCleanup' }
    else throw new Error(`ai.ts: playAutomatically — unhandled phase '${s.phase}'`)

    const result = applyAction(s, action)
    s = result.state
    logLines.push(...result.logLines)
    actionsTaken.push(action)
  }

  return { state: s, logLines, actionsTaken }
}
