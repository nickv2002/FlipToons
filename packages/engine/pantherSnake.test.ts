// Regression test for the Panther/Snake deferred-onHire crash (see
// state.ts's PendingOnHireChoice comment and phases.ts's
// drainPendingOnHireCards): a Panther stacked under a Snake (only reachable
// with a season === 'both' toon deck, since Snake is S1 and Panther is S2)
// defers its mandatory dismissChosenGridCard onHire into
// pendingOnHireCardIds. The old code drained that queue unconditionally,
// AFTER already committing phase: 'market', which threw because Panther's
// onHire needs a choices.dismissGridPos and none was supplied.
//
// Also covers Raccoon — the one OPTIONAL choice-needing onHire kind that can
// end up in the same queue (hireFromDismissed) — to pin that the general
// drain/pause mechanism isn't Panther-specific.
import { describe, expect, test } from 'bun:test'
import { emptyGrid, placeCardFaceUp } from './grid'
import { resolvePendingOnHireChoice, runPostFameHooks } from './phases'
import { buildSoloSetup, cardsById } from './setup'
import { createSoloGameState } from './state'
import type { GameState } from './state'

const cards = cardsById()

function postFameHooksStateWith(pendingOnHireCardIds: GameState['pendingOnHireCardIds'], grid: GameState['grid']): GameState {
  const setup = buildSoloSetup(301, 'both', 'normal')
  const state = createSoloGameState({
    seed: setup.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
  return { ...state, phase: 'postFameHooks', fame: 20, fameGeneratedThisRound: 20, grid, pendingOnHireCardIds }
}

describe('Panther stacked under Snake (mandatory dismissChosenGridCard) no longer crashes', () => {
  test('a legal dismiss target pauses postFameHooks with pendingOnHireChoice instead of throwing', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    const state = postFameHooksStateWith(['panther'], grid)

    expect(() => runPostFameHooks(state)).not.toThrow()
    const paused = runPostFameHooks(state)

    expect(paused.phase).toBe('postFameHooks') // NOT 'market' — the whole bug was opening Market before this was answered
    expect(paused.pendingOnHireChoice).not.toBeNull()
    expect(paused.pendingOnHireChoice?.cardId).toBe('panther')
    expect(paused.pendingOnHireChoice?.choice.kind).toBe('dismissChosenGridCard')
    expect(paused.pendingOnHireChoice?.choice.mandatory).toBe(true)
    expect(paused.pendingOnHireCardIds).toEqual([]) // panther was shifted out of the queue while paused
  })

  test('resolving the choice dismisses the chosen card and opens Market only once the queue fully drains', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    const state = postFameHooksStateWith(['panther'], grid)
    const paused = runPostFameHooks(state)
    const choice = paused.pendingOnHireChoice!.choice
    if (choice.kind !== 'dismissChosenGridCard') throw new Error('expected dismissChosenGridCard')
    const target = choice.options[0]

    const resolved = resolvePendingOnHireChoice(paused, target)

    expect(resolved.pendingOnHireChoice).toBeNull()
    expect(resolved.phase).toBe('market') // queue fully drained -> Market opens
    expect(resolved.dismissed).toContain('bee')
    expect(resolved.actionsRemaining).toBe(2)
  })

  test('resolving with an illegal selection throws, and a skip is rejected for this mandatory choice', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    const state = postFameHooksStateWith(['panther'], grid)
    const paused = runPostFameHooks(state)

    expect(() => resolvePendingOnHireChoice(paused, 'skip')).toThrow()
    expect(() =>
      resolvePendingOnHireChoice(paused, { pos: { section: 'base', row: 1, col: 1 }, index: 0, cardId: 'bee' }),
    ).toThrow()
  })

  test('no legal dismiss target (empty grid) silently no-ops, matching applyEffects\' own no-op behavior, and opens Market directly', () => {
    const state = postFameHooksStateWith(['panther'], emptyGrid())
    const result = runPostFameHooks(state)
    expect(result.pendingOnHireChoice).toBeNull()
    expect(result.phase).toBe('market')
  })
})

describe('Raccoon stacked under Snake (optional hireFromDismissed) also pauses, and can be skipped', () => {
  test('a legal option pauses postFameHooks; skip resolves it without hiring anything', () => {
    const grid = emptyGrid()
    const state = { ...postFameHooksStateWith(['raccoon'], grid), dismissed: ['bee'] }

    const paused = runPostFameHooks(state)
    expect(paused.phase).toBe('postFameHooks')
    expect(paused.pendingOnHireChoice?.cardId).toBe('raccoon')
    expect(paused.pendingOnHireChoice?.choice.kind).toBe('hireFromDismissed')
    expect(paused.pendingOnHireChoice?.choice.mandatory).toBe(false)

    const resolved = resolvePendingOnHireChoice(paused, 'skip')
    expect(resolved.phase).toBe('market')
    expect(resolved.pendingOnHireChoice).toBeNull()
    expect(resolved.dismissed).toEqual(['bee']) // untouched — declined
  })
})

// Sanity: confirm the card table shape this whole scenario depends on hasn't
// silently changed underneath the test (Panther mandatory, both S1/S2 present).
test('sanity: panther is season 2, mandatory dismissChosenGridCard; snake is season 1', () => {
  expect(cards.panther.season).toBe(2)
  expect(cards.panther.onHire).toEqual([{ kind: 'dismissChosenGridCard', cost: 0 }])
  expect(cards.snake.season).toBe(1)
})
