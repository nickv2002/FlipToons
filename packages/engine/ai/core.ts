// Transport-agnostic Monte Carlo evaluator/driver. Knows nothing about
// GameState, Match, actions.ts, or matchActions.ts — every game-specific
// concern (what's a legal move, how to apply one, when the game is over, who
// won) is supplied by an AiAdapter. This is what lets solo and a future
// multiplayer match share one search implementation: `matchActions.ts` must
// not import `actions.ts` (solo carries house rules — instant-win,
// guaranteed-loss shortcuts, the atomic flip cascade — that are wrong at a
// table), so the search itself has to live somewhere neither reducer is
// privileged, with a thin adapter on each side translating to/from it.
import type { Rng } from '../rng'
import { makeRng } from '../rng'

export type AiAdapter<S, A> = {
  // Every legal action in the current state, already fully formed — a card
  // whose hire/dismiss needs a player choice must come back as one candidate
  // PER legal choice, not a single candidate with the choice missing (an
  // adapter that emits an incomplete action is a bug in the adapter, not
  // something the core can validate).
  legalCandidates(state: S): A[]
  apply(state: S, action: A): S // pure
  isTerminal(state: S): boolean
  reward(state: S): number // meaningful only once isTerminal(state) — 1 win / 0 loss (or a shaped value in between), adapter-defined
  clone(state: S): S // an independent copy safe to branch a rollout from
}

export type AiOptions = {
  simulations?: number // playouts per candidate action
  maxStepsPerPlayout?: number // safety cap so a stuck playout can't loop forever
  rng?: Rng // the AI's OWN decision randomness — deliberately separate from any seed carried inside S, since advisory playouts must never perturb the real game's own RNG sequence
}

const DEFAULT_SIMULATIONS = 24
const DEFAULT_MAX_STEPS_PER_PLAYOUT = 60
const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60 * 1000

// Cheap continuation policy used ONLY inside a playout, after the candidate
// action under evaluation has already been applied — uniform-random among
// whatever's currently legal. This is intentionally not "smart"; the outer
// evaluateAction/chooseBestAction loop is what does the actual comparison,
// by averaging outcomes across many such playouts per candidate.
function rolloutStep<S, A>(adapter: AiAdapter<S, A>, state: S, rng: Rng): S {
  const candidates = adapter.legalCandidates(state)
  const action = candidates[Math.floor(rng() * candidates.length)]!
  return adapter.apply(state, action)
}

function playout<S, A>(adapter: AiAdapter<S, A>, state: S, rng: Rng, maxSteps: number): S {
  let s = state
  let steps = 0
  while (!adapter.isTerminal(s) && steps < maxSteps) {
    s = rolloutStep(adapter, s, rng)
    steps++
  }
  return s
}

export function evaluateAction<S, A>(adapter: AiAdapter<S, A>, state: S, action: A, opts: AiOptions = {}): number {
  const simulations = opts.simulations ?? DEFAULT_SIMULATIONS
  const maxSteps = opts.maxStepsPerPlayout ?? DEFAULT_MAX_STEPS_PER_PLAYOUT
  const rng = opts.rng ?? makeRng(Date.now() >>> 0)

  let total = 0
  for (let i = 0; i < simulations; i++) {
    const afterAction = adapter.apply(adapter.clone(state), action)
    total += adapter.reward(playout(adapter, afterAction, rng, maxSteps))
  }
  return total / simulations
}

export type ScoredAction<A> = { action: A; score: number }

// Ranked highest-score-first; ties resolve by candidate order (whatever the
// adapter's legalCandidates puts first among equal scores).
export function evaluateCandidates<S, A>(adapter: AiAdapter<S, A>, state: S, opts: AiOptions = {}): ScoredAction<A>[] {
  return adapter
    .legalCandidates(state)
    .map((action) => ({ action, score: evaluateAction(adapter, state, action, opts) }))
    .sort((a, b) => b.score - a.score)
}

export function chooseBestAction<S, A>(adapter: AiAdapter<S, A>, state: S, opts: AiOptions = {}): A {
  const scored = evaluateCandidates(adapter, state, opts)
  if (scored.length === 0) throw new Error('ai/core.ts: chooseBestAction — no legal candidates in a non-terminal state')
  return scored[0]!.action
}

export type AutoplayResult<S, A> = { state: S; actionsTaken: A[] }

// Drives a state to a terminal one, using chooseBestAction — the real
// search, not the cheap rollout policy — for every decision.
export function playAutomatically<S, A>(
  adapter: AiAdapter<S, A>,
  state: S,
  opts: AiOptions & { maxSteps?: number; maxWallClockMs?: number } = {},
): AutoplayResult<S, A> {
  const maxSteps = opts.maxSteps ?? 400
  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS
  const deadline = Date.now() + maxWallClockMs

  let s = state
  const actionsTaken: A[] = []
  let steps = 0

  while (!adapter.isTerminal(s) && steps < maxSteps) {
    if (Date.now() > deadline) break
    const action = chooseBestAction(adapter, s, opts)
    s = adapter.apply(s, action)
    actionsTaken.push(action)
    steps++
  }

  return { state: s, actionsTaken }
}
