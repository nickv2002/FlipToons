import { describe, expect, test } from 'bun:test'
import { emptyGrid, occupiedSlots, placeCardFaceUp } from './grid'
import { buildEffectChoices, computePendingChoice } from './hireChoices'
import { dismiss, hire } from './phases'
import { buildExplicitDeck, buildSoloSetup, cardsById } from './setup'
import { createSoloGameState } from './state'
import type { GameState } from './state'

const cards = cardsById()

// Same synthetic-Market-phase-state pattern phases.test.ts's own
// `marketState` helper uses (not exported from there, so re-derived here):
// each test hand-crafts exactly the market/grid/dismissed state its card's
// choice needs, bypassing a full Flip/CheckFame.
function marketState(seed: number): GameState {
  const setup = buildSoloSetup(seed, 1, 'normal')
  const state = createSoloGameState({
    seed: setup.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
  return { ...state, phase: 'market', actionsRemaining: 2, fame: 50 }
}

// Every one of these mirrors the matching case in phases.test.ts's Group 1
// ("onHire/onDismiss firing") — that file proves hire()/dismiss() apply an
// EffectChoices object correctly; this file proves hireChoices.ts computes
// the SAME choice (right options, right no-op cases) from a GameState
// BEFORE the action is dispatched, and that its buildEffectChoices output
// round-trips into a hire()/dismiss() call that behaves identically.
describe('hireChoices.ts — computePendingChoice / buildEffectChoices', () => {
  describe('Butterfly — dismissByName', () => {
    test('a face-up Caterpillar in the grid is offered as the only option', () => {
      const state = marketState(401)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
      const s = { ...state, grid }
      const choice = computePendingChoice(s, cards['butterfly'].onHire, cards, 0)
      expect(choice).toEqual({
        kind: 'dismissByName',
        mandatory: false,
        cost: 0,
        options: [{ pos: { section: 'base', row: 0, col: 0 }, index: 0, cardId: 'caterpillar' }],
      })
    })

    test('no Caterpillar anywhere in the grid — no-op, returns null (matches applyEffects\' own silent decline)', () => {
      const state = marketState(402)
      const choice = computePendingChoice({ ...state, grid: emptyGrid() }, cards['butterfly'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('a face-down Caterpillar is not a legal target', () => {
      const state = marketState(403)
      const grid = emptyGrid()
      grid.base[0][0] = { cards: ['caterpillar'], faceUp: [false] }
      const choice = computePendingChoice({ ...state, grid }, cards['butterfly'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('selecting the option round-trips through hire() exactly like a hand-built choices object', () => {
      let state = marketState(404)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
      const market = { prices: [3], slots: ['butterfly'], insertionSeq: [0] }
      state = { ...state, grid, market, toonDeck: [] }
      const choice = computePendingChoice(state, cards['butterfly'].onHire, cards, 0)!
      const before = state.fame
      state = hire(state, 0, buildEffectChoices(choice, choice.options[0]))
      expect(state.fame).toBe(before - 3)
      expect(state.dismissed).toContain('caterpillar')
    })

    test("buildEffectChoices('skip') declines — hire() applies no dismiss", () => {
      let state = marketState(405)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
      const market = { prices: [3], slots: ['butterfly'], insertionSeq: [0] }
      state = { ...state, grid, market, toonDeck: [] }
      const choice = computePendingChoice(state, cards['butterfly'].onHire, cards, 0)!
      state = hire(state, 0, buildEffectChoices(choice, 'skip'))
      expect(state.dismissed).not.toContain('caterpillar')
      expect(occupiedSlots(state.grid).length).toBe(1)
    })
  })

  describe('Panther — dismissChosenGridCard (MANDATORY)', () => {
    test('any face-up, non-immune grid card is offered', () => {
      const state = marketState(406)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
      const choice = computePendingChoice({ ...state, grid }, cards['panther'].onHire, cards, 0)
      expect(choice).toEqual({
        kind: 'dismissChosenGridCard',
        mandatory: true,
        cost: 0,
        options: [{ pos: { section: 'base', row: 0, col: 0 }, index: 0, cardId: 'bee' }],
      })
    })

    test('an empty grid has no legal target — null, matching applyEffects\' impossible-board no-op', () => {
      const state = marketState(407)
      const choice = computePendingChoice({ ...state, grid: emptyGrid() }, cards['panther'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('a dismiss-immune grid card is excluded from options', () => {
      const state = marketState(408)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'opossum') // immune: ['dismiss']
      const choice = computePendingChoice({ ...state, grid }, cards['panther'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('selecting the option round-trips through hire()', () => {
      let state = marketState(409)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
      const market = { prices: [3], slots: ['panther'], insertionSeq: [0] }
      state = { ...state, grid, market, toonDeck: [] }
      const choice = computePendingChoice(state, cards['panther'].onHire, cards, 0)!
      state = hire(state, 0, buildEffectChoices(choice, choice.options[0]))
      expect(state.dismissed).toContain('bee')
    })
  })

  describe('Raccoon — hireFromDismissed', () => {
    test('every card in the dismissed pile is offered', () => {
      const state = marketState(410)
      const choice = computePendingChoice({ ...state, dismissed: ['bee', 'snail'] }, cards['raccoon'].onHire, cards, 0)
      expect(choice).toEqual({
        kind: 'hireFromDismissed',
        mandatory: false,
        cost: 0,
        options: [{ cardId: 'bee' }, { cardId: 'snail' }],
      })
    })

    test('an empty dismissed pile — null', () => {
      const state = marketState(411)
      const choice = computePendingChoice({ ...state, dismissed: [] }, cards['raccoon'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('selecting an option round-trips through hire()', () => {
      let state = marketState(412)
      const market = { prices: [3], slots: ['raccoon'], insertionSeq: [0] }
      state = { ...state, market, dismissed: ['bee'], toonDeck: [] }
      const choice = computePendingChoice(state, cards['raccoon'].onHire, cards, 0)!
      const deckBefore = state.deck.length
      state = hire(state, 0, buildEffectChoices(choice, choice.options[0]))
      expect(state.dismissed).not.toContain('bee')
      expect(state.deck.length).toBe(deckBefore + 2) // raccoon itself + bee
    })
  })

  describe('Crow — hireFromMarketAndRefill (onDismiss)', () => {
    test('every occupied market slot is offered', () => {
      const state = marketState(413)
      const market = { prices: [3, 4], slots: ['ostrich', 'goat'], insertionSeq: [0, 1] }
      const choice = computePendingChoice({ ...state, market }, cards['crow'].onDismiss, cards)
      expect(choice).toEqual({ kind: 'hireFromMarketAndRefill', mandatory: false, cost: 0, options: [0, 1] })
    })

    test('an all-empty market — null', () => {
      const state = marketState(414)
      const market = { prices: [3], slots: [null], insertionSeq: [null] }
      const choice = computePendingChoice({ ...state, market }, cards['crow'].onDismiss, cards)
      expect(choice).toBeNull()
    })

    test('selecting an option round-trips through dismiss()', () => {
      let state = marketState(415)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'crow')
      const market = { prices: [3], slots: ['ostrich'], insertionSeq: [0] }
      const toonDeck = buildExplicitDeck(['sheep'], cards)
      state = { ...state, grid, market, toonDeck, nextInsertionSeq: 1, fame: 50 }
      const choice = computePendingChoice(state, cards['crow'].onDismiss, cards)!
      const deckBefore = state.deck.length
      state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0, buildEffectChoices(choice, choice.options[0]))
      expect(state.deck.length).toBe(deckBefore + 1)
      expect(state.deck).toContain('ostrich')
      expect(state.market.slots).toContain('sheep')
    })
  })

  describe('Horse — discardMarketAndRefill (onHire, multi-select)', () => {
    test('every OTHER occupied market slot is offered — excludes Horse\'s own slot', () => {
      const state = marketState(416)
      const market = { prices: [3, 4, 7], slots: ['horse', 'ostrich', 'goat'], insertionSeq: [0, 1, 2] }
      const choice = computePendingChoice({ ...state, market }, cards['horse'].onHire, cards, 0)
      expect(choice).toEqual({ kind: 'discardMarketAndRefill', mandatory: false, options: [1, 2] })
    })

    test('Horse alone in the market (no other slots) — null', () => {
      const state = marketState(417)
      const market = { prices: [3], slots: ['horse'], insertionSeq: [0] }
      const choice = computePendingChoice({ ...state, market }, cards['horse'].onHire, cards, 0)
      expect(choice).toBeNull()
    })

    test('selecting a subset round-trips through hire()', () => {
      let state = marketState(418)
      const market = { prices: [3, 4, 7], slots: ['horse', 'ostrich', 'goat'], insertionSeq: [0, 1, 2] }
      const toonDeck = buildExplicitDeck(['sheep', 'rabbit'], cards)
      state = { ...state, market, toonDeck, nextInsertionSeq: 3 }
      const choice = computePendingChoice(state, cards['horse'].onHire, cards, 0)!
      state = hire(state, 0, buildEffectChoices(choice, [1])) // discard just 'ostrich'
      expect(state.market.slots).not.toContain('ostrich')
      expect(state.market.slots).toEqual(['goat', 'sheep', 'rabbit'])
    })

    test("buildEffectChoices('skip') still refills Horse's own vacated slot (the discard is optional, the refill isn't)", () => {
      let state = marketState(419)
      const market = { prices: [3, 4, 7], slots: ['horse', 'ostrich', 'goat'], insertionSeq: [0, 1, 2] }
      const toonDeck = buildExplicitDeck(['sheep', 'rabbit'], cards)
      state = { ...state, market, toonDeck, nextInsertionSeq: 3 }
      const choice = computePendingChoice(state, cards['horse'].onHire, cards, 0)!
      state = hire(state, 0, buildEffectChoices(choice, 'skip'))
      expect(state.market.slots).toContain('ostrich')
      expect(state.market.slots).toContain('goat')
      expect(state.market.slots).not.toContain(null)
    })
  })

  describe('a choice-free card (e.g. plain Bee) never produces a pending choice', () => {
    test('returns null for onHire and onDismiss alike', () => {
      const state = marketState(420)
      expect(computePendingChoice(state, cards['bee'].onHire, cards, 0)).toBeNull()
      expect(computePendingChoice(state, cards['bee'].onDismiss, cards)).toBeNull()
    })
  })
})
