// Public surface of the Monte Carlo AI. `core.ts` is transport-agnostic
// (see its own header comment); this module wires it to solo's adapter for
// the one concrete use that exists today. A multiplayer adapter (over
// matchActions.ts's applyMatchAction) is a later addition — the core search
// doesn't need to change to add one, only a second adapter alongside
// soloAdapter.ts.
import type { Action } from '../actions'
import type { MatchAction } from '../matchActions'
import type { Match, GameState, PlayerId } from '../state'
import { chooseBestAction, evaluateAction, evaluateCandidates, playAutomatically as playAutomaticallyCore } from './core'
import type { AiOptions, AutoplayResult, ScoredAction } from './core'
import { buildNewGameState, soloAdapter } from './soloAdapter'
import { buildMatchAdapter, advanceToBotDecision } from './matchAdapter'

export type { AiOptions, AutoplayResult, ScoredAction }
export { buildNewGameState }
export type MatchDifficulty = 'easy' | 'normal' | 'hard'

// Interactive tuning, distinct from core.ts's batch-benchmark defaults
// (DEFAULT_SIMULATIONS/DEFAULT_MAX_STEPS_PER_PLAYOUT/DEFAULT_MAX_WALL_CLOCK_MS
// — ~150x150 over up to 5 minutes) — those were tuned against an offline
// win-rate sweep, not a player waiting on a bot's turn at a live table. A
// few seconds is the budget a caller (a future server-side bot seat) should
// actually be spending per DECISION, not per game.
export const INTERACTIVE_MAX_WALL_CLOCK_MS: Record<MatchDifficulty, number> = {
  easy: 800,
  normal: 2000,
  hard: 4000,
}
const INTERACTIVE_SIMULATIONS: Record<MatchDifficulty, number> = {
  easy: 12,
  normal: 40,
  hard: 90,
}
const INTERACTIVE_MAX_STEPS_PER_PLAYOUT: Record<MatchDifficulty, number> = {
  easy: 40,
  normal: 60,
  hard: 90,
}

function interactiveOptsFor(difficulty: MatchDifficulty): AiOptions {
  return {
    simulations: INTERACTIVE_SIMULATIONS[difficulty],
    maxStepsPerPlayout: INTERACTIVE_MAX_STEPS_PER_PLAYOUT[difficulty],
  }
}

export type MatchAiOptions = AiOptions & { difficulty?: MatchDifficulty }

function resolveMatchOpts(opts: MatchAiOptions): AiOptions {
  const { difficulty, ...rest } = opts
  return { ...interactiveOptsFor(difficulty ?? 'normal'), ...rest }
}

export function evaluateMatchAction(match: Match, botSeatId: PlayerId, action: MatchAction, opts: MatchAiOptions = {}): number {
  const adapter = buildMatchAdapter(botSeatId)
  return evaluateAction(adapter, advanceToBotDecision(match, botSeatId), action, resolveMatchOpts(opts))
}

export function evaluateMatchCandidates(match: Match, botSeatId: PlayerId, opts: MatchAiOptions = {}): ScoredAction<MatchAction>[] {
  const adapter = buildMatchAdapter(botSeatId)
  const at = advanceToBotDecision(match, botSeatId)
  if (adapter.legalCandidates(at).length === 0) {
    throw new Error(`ai/index.ts: evaluateMatchCandidates — ${botSeatId} has no legal decision right now (phase: ${at.shared.phase})`)
  }
  return evaluateCandidates(adapter, at, resolveMatchOpts(opts))
}

export function chooseBestMatchAction(match: Match, botSeatId: PlayerId, opts: MatchAiOptions = {}): MatchAction {
  const adapter = buildMatchAdapter(botSeatId)
  const at = advanceToBotDecision(match, botSeatId)
  return chooseBestAction(adapter, at, resolveMatchOpts(opts))
}

export function evaluateSoloAction(state: GameState, action: Action, opts: AiOptions = {}): number {
  return evaluateAction(soloAdapter, state, action, opts)
}

export function evaluateSoloMarketCandidates(state: GameState, opts: AiOptions = {}): ScoredAction<Action>[] {
  if (state.phase !== 'market') throw new Error('ai/index.ts: evaluateSoloMarketCandidates — state is not in the market phase')
  return evaluateCandidates(soloAdapter, state, opts)
}

export function chooseBestSoloMarketAction(state: GameState, opts: AiOptions = {}): Action {
  if (state.phase !== 'market') throw new Error('ai/index.ts: chooseBestSoloMarketAction — state is not in the market phase')
  return chooseBestAction(soloAdapter, state, opts)
}

export function playSoloAutomatically(state: GameState, opts: AiOptions & { maxSteps?: number; maxWallClockMs?: number } = {}): AutoplayResult<GameState, Action> {
  return playAutomaticallyCore(soloAdapter, state, opts)
}
