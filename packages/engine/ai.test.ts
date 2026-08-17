// Tests for ai.ts's simulation-based evaluator (build-order step 7, scoped
// to a solo decision-support advisor — see ai.ts's header comment for why).
// Kept deliberately small (few simulations, small round caps, 'easy'
// difficulty's short toon deck) so this file runs fast; correctness of the
// underlying phase machine is already covered by phases.test.ts and
// score.test.ts — this file only tests the search/evaluation layer on top.

import { describe, expect, test } from 'bun:test'
import { buildNewGameState } from './actions'
import { chooseBestMarketAction, evaluateAction, evaluateMarketCandidates, playAutomatically } from './ai'
import { makeRng } from './rng'
import { applyAction } from './actions'

const FAST_OPTS = { simulations: 6, maxRoundsPerPlayout: 8, rng: makeRng(1) }

function advanceToFirstMarket(seed: number) {
  let state = buildNewGameState(seed, 'easy', 1)
  while (state.phase !== 'market') {
    if (state.phase === 'flip') state = applyAction(state, { kind: 'flip' }).state
    else if (state.phase === 'checkFame') state = applyAction(state, { kind: 'checkFame' }).state
    else if (state.phase === 'postFameHooks') state = applyAction(state, { kind: 'continueToMarket' }).state
    else if (state.phase === 'cleanup') state = applyAction(state, { kind: 'advanceCleanup' }).state
    else throw new Error(`test setup: unexpected phase ${state.phase}`)
  }
  return state
}

describe('evaluateMarketCandidates', () => {
  test('scores every affordable hire slot, every dismissable card, and endMarket', () => {
    const state = advanceToFirstMarket(1)
    const scored = evaluateMarketCandidates(state, FAST_OPTS)

    expect(scored.length).toBeGreaterThan(0)
    expect(scored.some((s) => s.action.kind === 'endMarket')).toBe(true)
    for (const { score } of scored) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    // Sorted highest-score-first.
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score)
    }
  })

  test('never proposes a hire the player can\'t currently afford', () => {
    const state = advanceToFirstMarket(2)
    const scored = evaluateMarketCandidates(state, FAST_OPTS)
    for (const { action } of scored) {
      if (action.kind !== 'hire') continue
      const price = state.market.prices[action.slotIndex]!
      expect(price).toBeLessThanOrEqual(state.fame)
    }
  })

  test('throws outside the market phase', () => {
    const state = buildNewGameState(3, 'easy', 1) // phase 'flip'
    expect(() => evaluateMarketCandidates(state, FAST_OPTS)).toThrow(/market phase/)
  })
})

describe('chooseBestMarketAction', () => {
  test('returns one of the candidates evaluateMarketCandidates scored', () => {
    const state = advanceToFirstMarket(4)
    const scored = evaluateMarketCandidates(state, FAST_OPTS)
    const chosen = chooseBestMarketAction(state, FAST_OPTS)
    expect(scored.map((s) => JSON.stringify(s.action))).toContain(JSON.stringify(chosen))
  })
})

describe('evaluateAction', () => {
  test('is deterministic for a fixed rng seed', () => {
    const state = advanceToFirstMarket(5)
    const action = { kind: 'endMarket' as const }
    const a = evaluateAction(state, action, { simulations: 6, maxRoundsPerPlayout: 8, rng: makeRng(42) })
    const b = evaluateAction(state, action, { simulations: 6, maxRoundsPerPlayout: 8, rng: makeRng(42) })
    expect(a).toBe(b)
  })
})

describe('playAutomatically', () => {
  test('drives a whole easy solo game to a real result (win or loss), reusing actions.ts\'s reducer', () => {
    const state = buildNewGameState(7, 'easy', 1)
    const result = playAutomatically(state, { simulations: 4, maxRoundsPerPlayout: 6, maxRounds: 60, rng: makeRng(7) })

    expect(result.state.phase).toBe('ended')
    expect(['win', 'loss']).toContain(result.state.result as string)
    expect(result.logLines.length).toBeGreaterThan(0)
    expect(result.actionsTaken.length).toBeGreaterThan(0)
    // Every action actually taken came from the same vocabulary actions.ts
    // (and thus apps/web / apps/server) already speak.
    const kinds = new Set(result.actionsTaken.map((a) => a.kind))
    for (const k of kinds) {
      expect(['flip', 'checkFame', 'continueToMarket', 'hire', 'dismiss', 'endMarket', 'advanceCleanup']).toContain(k)
    }
  })

  test('stops at maxRounds even if the game has not ended (safety cap, not expected in practice)', () => {
    const state = buildNewGameState(8, 'easy', 1)
    const result = playAutomatically(state, { simulations: 2, maxRoundsPerPlayout: 3, maxRounds: 1, rng: makeRng(8) })
    expect(result.state.round - state.round).toBeLessThanOrEqual(1)
  })
})
