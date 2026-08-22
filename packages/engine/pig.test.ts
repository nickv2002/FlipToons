// Stage 5: the Pig — "WHEN HIRED OR DISMISSED, PLACE THIS CARD IN ANY DECK."
//
// The only card in either season genuinely blocked on multiplayer. Its FAQ:
// "The pig can be placed in any player's deck or back in the toon deck.
// Shuffle the deck if placed in the toon deck."
//
// That makes it the one effect that reaches across seats, which is why it
// resolves in two halves: phases.ts detaches the card and records that a deck
// is owed, and match.ts places it — because a PlayerView cannot see another
// player's deck.

import { describe, expect, test } from 'bun:test'
import { buildNewMatch, deckPlacementTargets, matchResolveDeckPlacement, playerIndex } from './match'
import { applyMatchAction, IllegalActionError } from './matchActions'
import { occupiedSlots } from './grid'
import { cardsById, MULTIPLAYER_TOON_DECK_EXCLUSIONS, SOLO_TOON_DECK_EXCLUSIONS } from './setup'
import { applyEffects } from './phases'
import type { Match } from './state'
import type { CardId } from './cards/types'

const cards = cardsById()

// A 2-player match parked in the Market phase with the Pig sitting in the
// acting seat's grid, as a hire would have left it just before its effect
// fires.
function matchWithPigInGrid(): { match: Match; playerId: string } {
  const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
  const match: Match = { ...base, shared: { ...base.shared, phase: 'market' } }
  return { match, playerId: match.turnOrder[0] }
}

describe('the Pig is no longer unencodable', () => {
  test('it has real onHire and onDismiss effects and no unencodable flag', () => {
    const pig = cards['pig']
    expect(pig.unencodable).toBeUndefined()
    expect(pig.unencodableReason).toBeUndefined()
    expect(pig.onHire).toEqual([{ kind: 'placeSelfInAnyDeck' }])
    expect(pig.onDismiss).toEqual([{ kind: 'placeSelfInAnyDeck' }])
  })

  test('solo still excludes it from the toon deck; multiplayer keeps it', () => {
    // The card being encodable does not make it a solo card — solo setup
    // removes it outright, so none of this can come up there.
    expect(Object.values(SOLO_TOON_DECK_EXCLUSIONS).flat()).toContain('pig')
    expect(Object.values(MULTIPLAYER_TOON_DECK_EXCLUSIONS).flat()).not.toContain('pig')
  })
})

describe('detaching the card (phases.ts)', () => {
  test('a hired Pig leaves the grid and records that a deck is owed', () => {
    const { match, playerId } = matchWithPigInGrid()
    const i = playerIndex(match, playerId)
    // Put a Pig on the board, then fire its effect the way hire() would.
    const view = { ...match.players[i], ...match.shared }
    const withPig = { ...view, grid: gridWithCard(view.grid, 'pig') }
    const after = applyEffects(withPig, cards['pig'], cards['pig'].onHire)

    expect(cardIdsInGrid(after.grid)).not.toContain('pig')
    expect(after.pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'hire' })
  })

  test('a dismissed Pig comes back OUT of the dismissed pile', () => {
    // Otherwise it would be in two places at once — the rules send it to a
    // deck INSTEAD of out of the game.
    const { match, playerId } = matchWithPigInGrid()
    const i = playerIndex(match, playerId)
    const view = { ...match.players[i], ...match.shared, dismissed: ['bee' as CardId, 'pig' as CardId] }
    const after = applyEffects(view, cards['pig'], cards['pig'].onDismiss)

    expect(after.dismissed).toEqual(['bee'])
    expect(after.pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'dismiss' })
  })

  test('it throws rather than silently vanishing if the card is nowhere', () => {
    const { match, playerId } = matchWithPigInGrid()
    const i = playerIndex(match, playerId)
    const view = { ...match.players[i], ...match.shared }
    expect(() => applyEffects(view, cards['pig'], cards['pig'].onHire)).toThrow(/neither in the grid nor the dismissed pile/)
  })
})

describe('placing it (match.ts)', () => {
  function pendingMatch(): { match: Match; playerId: string } {
    const { match, playerId } = matchWithPigInGrid()
    const i = playerIndex(match, playerId)
    const players = match.players.slice()
    players[i] = { ...players[i], pendingDeckPlacement: { cardId: 'pig', source: 'hire' } }
    return { match: { ...match, players }, playerId }
  }

  test('every seat\'s deck is a legal destination, plus the toon deck', () => {
    const { match } = pendingMatch()
    // The FAQ says "any player's deck" — your OWN included, not just an
    // opponent's.
    expect(deckPlacementTargets(match)).toEqual([
      { kind: 'player', playerId: 'p0' },
      { kind: 'player', playerId: 'p1' },
      { kind: 'toonDeck' },
    ])
  })

  test('into another player\'s deck — the cross-player case that needed all this', () => {
    const { match, playerId } = pendingMatch()
    const victim = match.players[1].playerId
    const before = match.players[1].deck.length
    const after = matchResolveDeckPlacement(match, playerId, { kind: 'player', playerId: victim })

    expect(after.players[1].deck).toContain('pig')
    expect(after.players[1].deck).toHaveLength(before + 1)
    // And the acting player's own deck is untouched.
    expect(after.players[0].deck).not.toContain('pig')
    expect(after.players[0].pendingDeckPlacement).toBeNull()
  })

  test('into your own deck', () => {
    const { match, playerId } = pendingMatch()
    const after = matchResolveDeckPlacement(match, playerId, { kind: 'player', playerId })
    expect(after.players[0].deck).toContain('pig')
    expect(after.players[1].deck).not.toContain('pig')
  })

  test('into the toon deck, reshuffled', () => {
    const { match, playerId } = pendingMatch()
    const before = match.shared.toonDeck
    const after = matchResolveDeckPlacement(match, playerId, { kind: 'toonDeck' })

    expect(after.shared.toonDeck).toContain('pig')
    expect(after.shared.toonDeck).toHaveLength(before.length + 1)
    // The FAQ calls for a shuffle, so it must NOT simply be appended.
    expect(after.shared.toonDeck[after.shared.toonDeck.length - 1]).not.toBe('pig')
    // Shuffling consumed the acting player's own rng stream, keeping the
    // match reproducible from its seed.
    expect(after.players[0].rng).not.toEqual(match.players[0].rng)
  })

  test('the same seed places it identically every time', () => {
    const a = matchResolveDeckPlacement(pendingMatch().match, 'p0', { kind: 'toonDeck' })
    const b = matchResolveDeckPlacement(pendingMatch().match, 'p0', { kind: 'toonDeck' })
    expect(a.shared.toonDeck).toEqual(b.shared.toonDeck)
  })

  test('resolving with nothing pending is an error', () => {
    const { match, playerId } = matchWithPigInGrid()
    expect(() => matchResolveDeckPlacement(match, playerId, { kind: 'toonDeck' })).toThrow(/no card waiting for a deck/)
  })
})

describe('through the action layer', () => {
  function pendingMatch(): { match: Match; playerId: string } {
    const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const match: Match = { ...base, shared: { ...base.shared, phase: 'market' } }
    const players = match.players.slice()
    players[match.activePlayerIndex] = {
      ...players[match.activePlayerIndex],
      actionsRemaining: 1,
      pendingDeckPlacement: { cardId: 'pig', source: 'hire' },
    }
    return { match: { ...match, players }, playerId: match.turnOrder[match.activePlayerIndex] }
  }

  test('it is turn-gated — only the acting player answers it', () => {
    const { match, playerId } = pendingMatch()
    const other = match.turnOrder.find((id) => id !== playerId)!
    expect(() => applyMatchAction(match, other, { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } })).toThrow(IllegalActionError)
  })

  test('answering it without a pending card is a player error, not a crash', () => {
    const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const match: Match = { ...base, shared: { ...base.shared, phase: 'market' } }
    const active = match.turnOrder[match.activePlayerIndex]
    expect(() => applyMatchAction(match, active, { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } })).toThrow(IllegalActionError)
  })

  test('it logs where the card went', () => {
    const { match, playerId } = pendingMatch()
    const result = applyMatchAction(match, playerId, { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } })
    expect(result.logLines.some((l) => l.text.includes('toon deck') && l.text.includes('Pig'))).toBe(true)
  })

  test('a turn cannot end while the Pig still owes a deck', () => {
    // Ending it would strand the card outside every zone in the game.
    const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const match: Match = { ...base, shared: { ...base.shared, phase: 'market' } }
    const idx = match.activePlayerIndex
    const players = match.players.slice()
    players[idx] = { ...players[idx], actionsRemaining: 0, pendingDeckPlacement: { cardId: 'pig', source: 'hire' } }
    const stuck: Match = { ...match, players }

    // The auto-end path (actions exhausted) must decline to fire.
    const after = applyMatchAction(stuck, stuck.turnOrder[idx], { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } })
    // Once answered, the turn is free to close.
    expect(after.match.players[idx].pendingDeckPlacement).toBeNull()
  })
})

// --- helpers ---------------------------------------------------------------

function gridWithCard(grid: ReturnType<typeof buildNewMatch>['players'][0]['grid'], cardId: CardId) {
  const next = { base: grid.base.map((row) => row.slice()), extraRows: grid.extraRows.map((row) => row.slice()) }
  next.base[0][0] = { cards: [cardId], faceUp: [true] }
  return next
}

function cardIdsInGrid(grid: ReturnType<typeof buildNewMatch>['players'][0]['grid']): CardId[] {
  return occupiedSlots(grid).flatMap(({ slot }) => slot.cards)
}
