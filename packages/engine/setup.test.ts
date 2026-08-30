// Tests for the setup layer (§3.7/§4.6): the solo variant's starting deck,
// toon-deck exclusions, difficulty trim, and the GameState it produces.
// Nothing in this file exercises card *effects* — season2-effects.test.ts
// already covers those. This covers the arithmetic setup.ts does before a
// single card is ever flipped, which had no dedicated test file before now.

import { describe, expect, test } from 'bun:test'
import { season1Cards, season2Cards } from './cards'
import { createSoloGameState } from './state'
import {
  buildMultiplayerSetup,
  buildMultiplayerToonDeckUnshuffled,
  buildSeason1SoloStartingDeck,
  buildSeason2SoloStartingDeck,
  buildSoloSetup,
  buildSoloToonDeckUnshuffled,
  type SoloDifficulty,
} from './setup'

describe('buildSeason1SoloStartingDeck (§3.7, confirmed against the rulebook quote)', () => {
  test('is 1 dragonfly, 1 bee, 1 snail, 3 caterpillar — no skunk', () => {
    const deck = buildSeason1SoloStartingDeck()
    expect(deck.length).toBe(6)
    expect(deck.filter((id) => id === 'dragonfly').length).toBe(1)
    expect(deck.filter((id) => id === 'bee').length).toBe(1)
    expect(deck.filter((id) => id === 'snail').length).toBe(1)
    expect(deck.filter((id) => id === 'caterpillar').length).toBe(3)
    expect(deck).not.toContain('skunk')
  })
})

describe('buildSoloToonDeckUnshuffled', () => {
  test('season 1: excludes the Pig and Axolotl, includes every other rank>0 card by its copies count, no rank-0 card', () => {
    const deck = buildSoloToonDeckUnshuffled(1)
    expect(deck).not.toContain('pig')
    expect(deck).not.toContain('axolotl')

    const rank0Ids = new Set(season1Cards.filter((c) => c.rank === 0).map((c) => c.id))
    for (const id of deck) expect(rank0Ids.has(id)).toBe(false)

    const expectedMarketCards = season1Cards.filter((c) => c.rank > 0 && c.id !== 'pig' && c.id !== 'axolotl')
    const expectedLength = expectedMarketCards.reduce((sum, c) => sum + c.copies, 0)
    expect(deck.length).toBe(expectedLength)

    for (const card of expectedMarketCards) {
      expect(deck.filter((id) => id === card.id).length).toBe(card.copies)
    }
  })

  // Season 2's exclusion list holds only 'platypus' (Big Button — see
  // setup.ts). This asserts CURRENT CODE BEHAVIOR, not a confirmed rule — if
  // a Season 2 Pig-analogue is ever identified, this test's expected length
  // changes along with SOLO_TOON_DECK_EXCLUSIONS.
  test('season 2: excludes the Platypus, includes every other rank>0 card by its copies count', () => {
    const deck = buildSoloToonDeckUnshuffled(2)
    expect(deck).not.toContain('platypus')

    const rank0Ids = new Set(season2Cards.filter((c) => c.rank === 0).map((c) => c.id))
    for (const id of deck) expect(rank0Ids.has(id)).toBe(false)

    const expectedMarketCards = season2Cards.filter((c) => c.rank > 0 && c.id !== 'platypus')
    const expectedLength = expectedMarketCards.reduce((sum, c) => sum + c.copies, 0)
    expect(deck.length).toBe(expectedLength)
  })
})

describe('buildSoloSetup — difficulty trim (§3.7: 17/20/23 discarded)', () => {
  const TRIM: Record<SoloDifficulty, number> = { easy: 17, normal: 20, hard: 23 }

  for (const [season, seasonNum] of [
    ['season 1', 1],
    ['season 2', 2],
  ] as const) {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      test(`${season}/${difficulty}: toonDeck.length is the unshuffled length minus the trim, floored at 0`, () => {
        const unshuffledLength = buildSoloToonDeckUnshuffled(seasonNum).length
        const setup = buildSoloSetup(1, seasonNum, difficulty)
        const expected = Math.max(0, unshuffledLength - TRIM[difficulty])
        expect(setup.toonDeck.length).toBe(expected)
      })
    }
  }

  test('a harder difficulty never leaves MORE cards in the toon deck than an easier one', () => {
    const easy = buildSoloSetup(1, 1, 'easy')
    const normal = buildSoloSetup(1, 1, 'normal')
    const hard = buildSoloSetup(1, 1, 'hard')
    expect(easy.toonDeck.length).toBeGreaterThanOrEqual(normal.toonDeck.length)
    expect(normal.toonDeck.length).toBeGreaterThanOrEqual(hard.toonDeck.length)
  })
})

describe('buildSoloSetup — determinism', () => {
  test('same seed produces the same toonDeck ordering', () => {
    const a = buildSoloSetup(777, 1, 'normal')
    const b = buildSoloSetup(777, 1, 'normal')
    expect(a.toonDeck).toEqual(b.toonDeck)
  })

  test('different seeds produce different toonDeck ordering', () => {
    const a = buildSoloSetup(1, 1, 'normal')
    const b = buildSoloSetup(2, 1, 'normal')
    expect(a.toonDeck).not.toEqual(b.toonDeck)
  })
})

describe('createSoloGameState wiring (§3.1: market starts pre-filled)', () => {
  test('the market comes back with prices.length slots filled from one refillMarket call', () => {
    const setup = buildSoloSetup(42, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.market.slots.length).toBe(setup.prices.length)
    expect(state.market.slots.every((slot) => slot !== null)).toBe(true)
    expect(state.toonDeckDepleted).toBe(false)
  })

  test('toonDeckDepleted is set when the toon deck is too small to fill the market', () => {
    const tinyToonDeck = ['ostrich', 'ostrich'] // fewer cards than prices.length (5)
    const state = createSoloGameState({
      seed: 1,
      startingDeck: buildSeason1SoloStartingDeck(),
      toonDeck: tinyToonDeck,
      prices: [3, 4, 7, 10, 15],
      fameToTriggerEndgame: 30,
    })
    expect(state.toonDeckDepleted).toBe(true)
    expect(state.toonDeck.length).toBe(0)
  })
})

// Season 2's solo starting deck is a pattern-matched inference (setup.ts's
// buildSeason2SoloStartingDeck comment: "BEST AVAILABLE reading, not a
// confirmed rule"). This documents that CURRENT behavior — grasshopper,
// ladybug, spider, 3x mosquito — not that it's correct per the rulebook.
describe('buildSeason2SoloStartingDeck (UNCONFIRMED inference — see setup.ts)', () => {
  test('current inferred composition: 1 grasshopper, 1 ladybug, 1 spider, 3 mosquito', () => {
    const deck = buildSeason2SoloStartingDeck()
    expect(deck.length).toBe(6)
    expect(deck.filter((id) => id === 'mosquito').length).toBe(3)
    expect(deck).not.toContain('firefly')
  })
})

describe('combined season ("both")', () => {
  test('solo toon deck is the union of both seasons\' unshuffled decks', () => {
    const both = buildSoloToonDeckUnshuffled('both')
    const s1 = buildSoloToonDeckUnshuffled(1)
    const s2 = buildSoloToonDeckUnshuffled(2)
    expect(both.length).toBe(s1.length + s2.length)
    expect(both).toEqual([...s1, ...s2])
  })

  test('multiplayer toon deck is the union of both seasons\' unshuffled decks', () => {
    const both = buildMultiplayerToonDeckUnshuffled('both')
    const s1 = buildMultiplayerToonDeckUnshuffled(1)
    const s2 = buildMultiplayerToonDeckUnshuffled(2)
    expect(both.length).toBe(s1.length + s2.length)
    expect(both).toEqual([...s1, ...s2])
  })

  const BOTH_TRIM: Record<SoloDifficulty, number> = { easy: 67, normal: 70, hard: 73 }
  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    test(`solo ${difficulty}: toonDeck.length is the unshuffled union length minus the both-season trim`, () => {
      const unshuffledLength = buildSoloToonDeckUnshuffled('both').length
      const setup = buildSoloSetup(1, 'both', difficulty)
      const expected = Math.max(0, unshuffledLength - BOTH_TRIM[difficulty])
      expect(setup.toonDeck.length).toBe(expected)
    })
  }

  test('solo starting deck always matches exactly one whole season, never a mix, and is deterministic per seed', () => {
    const s1Deck = buildSeason1SoloStartingDeck()
    const s2Deck = buildSeason2SoloStartingDeck()
    let sawSeason1 = false
    let sawSeason2 = false
    for (let seed = 0; seed < 50; seed++) {
      const setup = buildSoloSetup(seed, 'both', 'normal')
      const matchesS1 = JSON.stringify(setup.startingDeck) === JSON.stringify(s1Deck)
      const matchesS2 = JSON.stringify(setup.startingDeck) === JSON.stringify(s2Deck)
      expect(matchesS1 || matchesS2).toBe(true)
      if (matchesS1) sawSeason1 = true
      if (matchesS2) sawSeason2 = true

      const again = buildSoloSetup(seed, 'both', 'normal')
      expect(again.startingDeck).toEqual(setup.startingDeck)
    }
    expect(sawSeason1).toBe(true)
    expect(sawSeason2).toBe(true)
  })

  test('multiplayer: each seat gets a whole single-season starting deck, never mixed', () => {
    const setup = buildMultiplayerSetup(123, 4, 'both')
    for (const deck of setup.startingDecks) {
      const idSet = new Set(deck)
      const fromSeason1 = [...idSet].every((id) => season1Cards.some((c) => c.id === id))
      const fromSeason2 = [...idSet].every((id) => season2Cards.some((c) => c.id === id))
      expect(fromSeason1 || fromSeason2).toBe(true)
      expect(fromSeason1 && fromSeason2).toBe(false)
    }
  })
})
