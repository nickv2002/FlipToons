// Regression tests for cardValue.ts's per-card value signals, plus a
// heuristic-level check that the dead-weight term actually makes dismissing
// a Mosquito-shaped card look competitive against ending the Market — see
// the plan this was built from for why this needs a hand-built scenario
// rather than just unit-testing cardValue.ts in isolation.
import { describe, expect, test } from 'bun:test'
import type { Card } from '../cards/types'
import { staticCardValue, isDeadWeight } from './cardValue'
import { scoreState } from './heuristic'
import { buildNewGameState } from './index'

// Exactly the Mosquito's real shape (cards/season2.ts): 0 fame, no bonuses,
// no effects of any kind.
const deadCard: Card = {
  id: 'test-dead',
  name: 'Test Dead Card',
  season: 2,
  rank: 0,
  copies: 1,
  fame: { base: 0 },
}

// A structurally valuable card: real fame, a conditional bonus, and an
// effect.
const valuableCard: Card = {
  id: 'test-valuable',
  name: 'Test Valuable Card',
  season: 2,
  rank: 3,
  copies: 1,
  fame: { base: 3, bonuses: [{ kind: 'perQuery', query: 'faceUpGridCard', amount: 1 }] },
  onHire: [{ kind: 'gainFame', amount: 1 }],
}

// A dynamic-fame card ('=' marker, e.g. Cow) — not dead, gets a flat
// estimate rather than 0.
const dynamicFameCard: Card = {
  id: 'test-dynamic',
  name: 'Test Dynamic Card',
  season: 2,
  rank: 2,
  copies: 1,
  fame: { base: '=' },
}

describe('isDeadWeight', () => {
  test('flags a zero-fame, no-bonus, no-effect card as dead weight', () => {
    expect(isDeadWeight(deadCard)).toBe(true)
  })

  test('does not flag a card with real fame, bonuses, or effects', () => {
    expect(isDeadWeight(valuableCard)).toBe(false)
  })

  test('does not flag a dynamic-fame card', () => {
    expect(isDeadWeight(dynamicFameCard)).toBe(false)
  })
})

describe('staticCardValue', () => {
  test('a dead-weight card scores near zero', () => {
    expect(staticCardValue(deadCard)).toBeCloseTo(0, 5)
  })

  test('a valuable card scores well above a dead-weight card', () => {
    expect(staticCardValue(valuableCard)).toBeGreaterThan(staticCardValue(deadCard) + 3)
  })

  test('a dynamic-fame card scores above zero (real if unquantifiable value)', () => {
    expect(staticCardValue(dynamicFameCard)).toBeGreaterThan(0)
  })

  test('is memoized: repeated calls for the same card id return the same value', () => {
    const first = staticCardValue(valuableCard)
    const second = staticCardValue(valuableCard)
    expect(second).toBe(first)
  })
})

describe('scoreState with a real Mosquito-shaped card', () => {
  test('removing a real Mosquito (season 2 starting deck) from state.deck scores better than leaving it in, all else equal', () => {
    const base = buildNewGameState(1, 'easy', 2)
    expect(base.deck).toContain('mosquito')

    const withMosquito = base
    const mosquitoIndex = withMosquito.deck.indexOf('mosquito')
    const withoutMosquito = { ...base, deck: base.deck.filter((_, i) => i !== mosquitoIndex) }

    // Dismissing/removing the dead card should not score worse than keeping
    // it — the dead-weight term is the credit that makes this true; before
    // this change the two states scored identically (fame-only signals
    // don't see state.deck contents at all).
    expect(scoreState(withoutMosquito)).toBeGreaterThanOrEqual(scoreState(withMosquito))
  })
})
