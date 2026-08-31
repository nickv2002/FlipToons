// Public surface of the Monte Carlo AI. `core.ts` is transport-agnostic
// (see its own header comment); this module wires it to solo's adapter for
// the one concrete use that exists today. A multiplayer adapter (over
// matchActions.ts's applyMatchAction) is a later addition — the core search
// doesn't need to change to add one, only a second adapter alongside
// soloAdapter.ts.
import type { Action } from '../actions'
import type { GameState } from '../state'
import { chooseBestAction, evaluateAction, evaluateCandidates, playAutomatically as playAutomaticallyCore } from './core'
import type { AiOptions, AutoplayResult, ScoredAction } from './core'
import { buildNewGameState, soloAdapter } from './soloAdapter'

export type { AiOptions, AutoplayResult, ScoredAction }
export { buildNewGameState }

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
