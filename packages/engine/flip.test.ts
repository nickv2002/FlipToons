import { describe, expect, test } from 'bun:test'
import { cardsById, buildSeason1StartingDeck } from './setup'
import { flipDeck } from './flip'
import { isFull } from './grid'
import { makeRng, shuffle } from './rng'
import { scoreGrid } from './score'

const cards = cardsById()

describe('flipDeck', () => {
  test('continues until all six base slots are occupied', () => {
    const deck = buildSeason1StartingDeck()
    const { grid, remainingDeck } = flipDeck(deck, cards, { toonDeck: [], dismissed: [] })
    expect(isFull(grid)).toBe(true)
    expect(remainingDeck).toHaveLength(0)
  })

  test('places all 6 starting cards (no placement effects to extend the draw in this pass)', () => {
    const deck = buildSeason1StartingDeck()
    const { grid } = flipDeck(deck, cards, { toonDeck: [], dismissed: [] })
    const placedIds = grid.base.flat().flatMap((slot) => slot?.cards ?? [])
    expect(placedIds.sort()).toEqual([...deck].sort())
  })

  test('a short deck flips a partial grid without error', () => {
    const shortDeck = ['bee', 'snail']
    const { grid, remainingDeck } = flipDeck(shortDeck, cards, { toonDeck: [], dismissed: [] })
    expect(isFull(grid)).toBe(false)
    expect(remainingDeck).toHaveLength(0)
    expect(grid.base[0][0]?.cards).toEqual(['bee'])
    expect(grid.base[0][1]?.cards).toEqual(['snail'])
    expect(grid.base[0][2]).toBeNull()
  })
})

describe('determinism', () => {
  test('same seed -> same flip order -> same grid -> same score', () => {
    const deckTemplate = buildSeason1StartingDeck()

    function flipWithSeed(seed: number) {
      const shuffled = shuffle(deckTemplate, makeRng(seed))
      const { grid } = flipDeck(shuffled, cards, { toonDeck: [], dismissed: [] })
      return { grid, score: scoreGrid(grid, cards) }
    }

    const run1 = flipWithSeed(20260815)
    const run2 = flipWithSeed(20260815)

    expect(run1.grid).toEqual(run2.grid)
    expect(run1.score).toEqual(run2.score)
  })

  test('different seeds produce different flip orders (not a hard guarantee, but true for these seeds)', () => {
    const deckTemplate = buildSeason1StartingDeck()
    const order1 = shuffle(deckTemplate, makeRng(1))
    const order2 = shuffle(deckTemplate, makeRng(2))
    expect(order1).not.toEqual(order2)
  })
})
