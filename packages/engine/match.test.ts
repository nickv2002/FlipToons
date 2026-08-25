// Tests for the Match boundary itself (state.ts's viewOf/commitView).
//
// These exist because the rest of the suite CANNOT cover this. PlayerView is
// structurally identical to the pre-split flat GameState, so all 266 engine
// tests pass without ever touching viewOf/commitView — green there means "solo
// still works", not "the per-player/shared split is correct". This file is the
// only thing asserting the latter.

import { describe, expect, test } from 'bun:test'
import { buildNewGameState } from './actions'
import { matchHire } from './match'
import { commitView, makeMatch, viewOf } from './state'
import type { Match } from './state'

function twoPlayerMatch() {
  return makeMatch(buildNewGameState(1234, 'normal', 1), [{ playerId: 'p1', startingDeck: ['caterpillar', 'bee', 'snail'], seed: 5678 }])
}

describe('viewOf', () => {
  test('joins the shared state with the addressed player’s slice', () => {
    const match = twoPlayerMatch()
    const view = viewOf(match, 1)

    expect(view.playerId).toBe('p1')
    expect(view.deck).toEqual(['caterpillar', 'bee', 'snail'])
    // Shared fields come from the single match.shared copy.
    expect(view.market).toEqual(match.shared.market)
    expect(view.toonDeck).toEqual(match.shared.toonDeck)
    expect(view.round).toBe(match.shared.round)
  })

  test('is a snapshot — mutating it does not touch the match', () => {
    const match = twoPlayerMatch()
    const view = viewOf(match, 0)
    const originalRound = match.shared.round

    view.round = 99
    view.fame = 42

    expect(match.shared.round).toBe(originalRound)
    expect(match.players[0].fame).toBe(0)
  })

  test('throws for an out-of-range player index', () => {
    expect(() => viewOf(twoPlayerMatch(), 7)).toThrow(/no player at index 7/)
  })
})

describe('commitView', () => {
  test('a shared mutation through one player’s view is visible to every other player', () => {
    const match = twoPlayerMatch()

    // Player 0 burns the shared toon deck down, the way a market refill would.
    const view = viewOf(match, 0)
    view.toonDeck = view.toonDeck.slice(0, 3)
    const after = commitView(match, 0, view)

    // There is exactly ONE shared copy, so player 1 sees it with no sync step.
    expect(after.shared.toonDeck).toHaveLength(3)
    expect(viewOf(after, 1).toonDeck).toHaveLength(3)
  })

  test('a per-player mutation stays private to that player', () => {
    const match = twoPlayerMatch()

    const view = viewOf(match, 0)
    view.fame = 17
    view.dismissed = ['skunk']
    const after = commitView(match, 0, view)

    expect(after.players[0].fame).toBe(17)
    expect(after.players[0].dismissed).toEqual(['skunk'])
    expect(after.players[1].fame).toBe(0)
    expect(after.players[1].dismissed).toEqual([])
    expect(viewOf(after, 1).fame).toBe(0)
  })

  test('rejects a stale view instead of silently clobbering shared state', () => {
    const match = twoPlayerMatch()

    // The tempting "simultaneous Flip" shape: project BOTH players up front,
    // mutate each, commit both. The second view was projected off the
    // pre-commit toon deck, so committing it would erase the first player's
    // draws and duplicate those cards across two grids.
    const a = viewOf(match, 0)
    const b = viewOf(match, 1)

    a.toonDeck = a.toonDeck.slice(1)
    const afterA = commitView(match, 0, a)

    b.toonDeck = b.toonDeck.slice(1)
    expect(() => commitView(afterA, 1, b)).toThrow(/stale view for player 1/)
  })

  test('re-projecting after each commit is the supported sequence', () => {
    const match = twoPlayerMatch()

    const a = viewOf(match, 0)
    a.toonDeck = a.toonDeck.slice(1)
    const afterA = commitView(match, 0, a)

    const b = viewOf(afterA, 1) // re-projected, so it sees player 0's draw
    b.toonDeck = b.toonDeck.slice(1)
    const afterB = commitView(afterA, 1, b)

    expect(afterB.shared.toonDeck).toHaveLength(match.shared.toonDeck.length - 2)
  })

  test('bumps the epoch on every commit', () => {
    const match = twoPlayerMatch()
    expect(match.shared.viewEpoch).toBe(0)

    const after = commitView(match, 0, viewOf(match, 0))
    expect(after.shared.viewEpoch).toBe(1)
    expect(commitView(after, 1, viewOf(after, 1)).shared.viewEpoch).toBe(2)
  })

  test('does not mutate the match it was given', () => {
    const match = twoPlayerMatch()
    const view = viewOf(match, 0)
    view.fame = 99
    commitView(match, 0, view)

    expect(match.players[0].fame).toBe(0)
    expect(match.shared.viewEpoch).toBe(0)
  })
})

describe('makeMatch', () => {
  test('seats every player with independent, non-aliased state', () => {
    const match = twoPlayerMatch()

    expect(match.players).toHaveLength(2)
    expect(match.turnOrder).toEqual(['p0', 'p1'])
    expect(match.firstPlayerIndex).toBe(0)
    expect(match.activePlayerIndex).toBe(0)

    // Aliasing here would be the classic multiplayer setup bug: two players
    // sharing one grid/deck array and stepping on each other.
    expect(match.players[0].grid).not.toBe(match.players[1].grid)
    expect(match.players[0].deck).not.toBe(match.players[1].deck)
    expect(match.players[0].dismissed).not.toBe(match.players[1].dismissed)
  })

  test('gives each seat its own RNG stream', () => {
    const match = twoPlayerMatch()
    expect(match.players[0].rng).not.toEqual(match.players[1].rng)
  })

  test('a 1-player match is just the solo game', () => {
    const solo = buildNewGameState(42, 'normal', 1)
    const match = makeMatch(solo)

    expect(match.players).toHaveLength(1)
    expect(match.turnOrder).toEqual(['p0'])
    // Round-tripping solo through the Match boundary changes nothing.
    const { viewEpoch: _epoch, ...roundTripped } = viewOf(match, 0)
    expect(roundTripped).toEqual(solo)
  })
})

// Raccoon's "you may hire ANY dismissed card" (cards/types.ts's Effect
// comment) reaches across the table — phases.ts's hire() only ever touches
// the acting player's own PlayerView.dismissed, so matchHire is what has to
// pull the card out of another seat's pile first. hireChoices.test.ts covers
// the same-seat/solo case; this covers the cross-seat one.
describe('matchHire — Raccoon pulling from another seat’s dismissed pile', () => {
  function raccoonMatch(): Match {
    const state = buildNewGameState(9001, 'normal', 1)
    const withMarket = { ...state, phase: 'market' as const, actionsRemaining: 2, fame: 50, market: { prices: [3], slots: ['raccoon'], insertionSeq: [0] } }
    return makeMatch(withMarket, [{ playerId: 'p1', startingDeck: ['caterpillar', 'bee', 'snail'], seed: 9002 }])
  }

  test('removes the card from the OTHER seat’s pile and hires it into the acting seat’s deck', () => {
    let match = raccoonMatch()
    match = { ...match, players: match.players.map((p, i) => (i === 1 ? { ...p, dismissed: ['bee'] } : p)) }

    const deckBefore = match.players[0].deck.length
    const next = matchHire(match, 'p0', 0, { hireFromDismissed: { cardId: 'bee', ownerPlayerId: 'p1' } })

    expect(next.players[1].dismissed).not.toContain('bee')
    expect(next.players[0].dismissed).not.toContain('bee')
    expect(next.players[0].deck.length).toBe(deckBefore + 2) // raccoon itself + bee
  })

  test('throws if the named card is not actually in that seat’s pile', () => {
    const match = raccoonMatch()
    expect(() => matchHire(match, 'p0', 0, { hireFromDismissed: { cardId: 'bee', ownerPlayerId: 'p1' } })).toThrow(
      /not in p1's dismissed pile/,
    )
  })

  test('an explicit ownerPlayerId matching the acting seat resolves locally, same as omitting it', () => {
    let match = raccoonMatch()
    match = { ...match, players: match.players.map((p, i) => (i === 0 ? { ...p, dismissed: ['bee'] } : p)) }

    const next = matchHire(match, 'p0', 0, { hireFromDismissed: { cardId: 'bee', ownerPlayerId: 'p0' } })

    expect(next.players[0].dismissed).not.toContain('bee')
    expect(next.players[1].dismissed).toEqual([])
  })
})
