// Tests for the Monte Carlo AI: core.ts's transport-agnostic search plus
// soloAdapter.ts's wiring to actions.ts. Kept deliberately small (few
// simulations, small round caps, 'easy' difficulty) so this file runs fast;
// correctness of the underlying phase machine is already covered by
// phases.test.ts and score.test.ts — this file only tests the search/
// evaluation layer on top.
import { describe, expect, test } from 'bun:test'
import { applyAction } from '../actions'
import { makeRng } from '../rng'
import { buildNewGameState, chooseBestSoloMarketAction, evaluateSoloAction, evaluateSoloMarketCandidates, playSoloAutomatically } from './index'

const FAST_OPTS = { simulations: 6, maxStepsPerPlayout: 20, rng: makeRng(1) }

function advanceToFirstMarket(seed: number) {
  let state = buildNewGameState(seed, 'easy', 1)
  while (state.phase !== 'market') {
    state = applyAction(state, { kind: 'flip' }).state
  }
  return state
}

describe('evaluateSoloMarketCandidates', () => {
  test('scores every affordable hire slot, every dismissable card, and endMarket', () => {
    const state = advanceToFirstMarket(1)
    const scored = evaluateSoloMarketCandidates(state, FAST_OPTS)

    expect(scored.length).toBeGreaterThan(0)
    expect(scored.some((s) => s.action.kind === 'endMarket')).toBe(true)
    for (const { score } of scored) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score)
    }
  })

  test("never proposes a hire the player can't currently afford", () => {
    const state = advanceToFirstMarket(2)
    const scored = evaluateSoloMarketCandidates(state, FAST_OPTS)
    for (const { action } of scored) {
      if (action.kind !== 'hire') continue
      const price = state.market.prices[action.slotIndex]!
      expect(price).toBeLessThanOrEqual(state.fame)
    }
  })

  test('throws outside the market phase', () => {
    const state = buildNewGameState(3, 'easy', 1) // phase 'flip'
    expect(() => evaluateSoloMarketCandidates(state, FAST_OPTS)).toThrow(/market phase/)
  })
})

describe('chooseBestSoloMarketAction', () => {
  test('returns one of the candidates evaluateSoloMarketCandidates scored', () => {
    const state = advanceToFirstMarket(4)
    const scored = evaluateSoloMarketCandidates(state, FAST_OPTS)
    const chosen = chooseBestSoloMarketAction(state, FAST_OPTS)
    expect(scored.map((s) => JSON.stringify(s.action))).toContain(JSON.stringify(chosen))
  })
})

describe('evaluateSoloAction', () => {
  test('is deterministic for a fixed rng seed', () => {
    const state = advanceToFirstMarket(5)
    const action = { kind: 'endMarket' as const }
    const a = evaluateSoloAction(state, action, { simulations: 6, maxStepsPerPlayout: 20, rng: makeRng(42) })
    const b = evaluateSoloAction(state, action, { simulations: 6, maxStepsPerPlayout: 20, rng: makeRng(42) })
    expect(a).toBe(b)
  })
})

describe('playSoloAutomatically', () => {
  test('drives a whole easy solo game to a real result (win or loss), reusing actions.ts\'s reducer', () => {
    const state = buildNewGameState(7, 'easy', 1)
    const result = playSoloAutomatically(state, { simulations: 4, maxStepsPerPlayout: 20, maxSteps: 200, rng: makeRng(7) })

    expect(result.state.phase).toBe('ended')
    expect(['win', 'loss']).toContain(result.state.result as string)
    expect(result.actionsTaken.length).toBeGreaterThan(0)
    const kinds = new Set(result.actionsTaken.map((a) => a.kind))
    for (const k of kinds) {
      expect(['flip', 'hire', 'dismiss', 'endMarket', 'resolvePostMarketChoice']).toContain(k)
    }
  })

  test('stops at maxSteps even if the game has not ended (safety cap, not expected in practice)', () => {
    const state = buildNewGameState(8, 'easy', 1)
    const result = playSoloAutomatically(state, { simulations: 2, maxStepsPerPlayout: 5, maxSteps: 1, rng: makeRng(8) })
    expect(result.actionsTaken.length).toBeLessThanOrEqual(1)
  })

  test(
    'reaches an actual WIN on easy difficulty across a batch of seeds, without throwing on choice cards',
    () => {
      let wins = 0
      const seeds = Array.from({ length: 12 }, (_, i) => 100 + i)
      for (const seed of seeds) {
        const state = buildNewGameState(seed, 'easy', 1)
        const result = playSoloAutomatically(state, { simulations: 8, maxStepsPerPlayout: 30, maxSteps: 200, rng: makeRng(seed) })
        expect(result.state.phase).toBe('ended')
        if (result.state.result === 'win') wins++
      }
      expect(wins).toBeGreaterThan(0)
    },
    // This batch's own options (sim=8/mspp=30) are intentionally far below
    // core.ts's tuned normal-difficulty defaults (150/150 — see core.ts's
    // comment) to stay a quick regression test, not a benchmark; ~5s for 12
    // easy-difficulty games is enough to bump past bun:test's default 5000ms
    // timeout on a loaded machine.
    15000,
  )
})
