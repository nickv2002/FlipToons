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

// A plain 2-player match parked in the Market phase, no Pig anywhere — the
// base for the placement tests, which inject `pendingDeckPlacement` directly.
function marketPhaseMatch(): { match: Match; playerId: string } {
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

// A 2-player match parked in the Market phase with the Pig sitting in market
// slot 0 and the acting seat able to afford it — the real, unfaked setup for
// a Pig hire.
function matchWithPigInMarket(): { match: Match; playerId: string; slotIndex: number } {
  const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
  const slotIndex = 0
  const market = {
    prices: base.shared.market.prices,
    slots: base.shared.market.slots.slice(),
    insertionSeq: base.shared.market.insertionSeq.slice(),
  }
  market.slots[slotIndex] = 'pig' as CardId
  // Multiplayer setup leaves the real Pig in the toon deck; pull it out so
  // the one in the market is the ONLY copy and the zone census below is
  // unambiguous.
  const toonDeck = base.shared.toonDeck.filter((id) => id !== 'pig')
  const players = base.players.slice()
  const i = base.activePlayerIndex
  players[i] = { ...players[i], fame: market.prices[slotIndex] + 5, actionsRemaining: 2 }
  const match: Match = {
    ...base,
    shared: { ...base.shared, phase: 'market', market, toonDeck },
    players,
  }
  return { match, playerId: match.turnOrder[i], slotIndex }
}

// Every zone in the match that a card can legally sit in. The Pig's whole
// problem is that it moves BETWEEN zones across seats, so "it is in exactly
// one place" is the assertion that matters — `not.toContain` on a single
// deck would have missed the bug this file was rewritten for.
function zoneCensus(match: Match, cardId: CardId): string[] {
  const found: string[] = []
  match.players.forEach((p, i) => {
    p.deck.forEach((id) => { if (id === cardId) found.push(`p${i}.deck`) })
    p.dismissed.forEach((id) => { if (id === cardId) found.push(`p${i}.dismissed`) })
    cardIdsInGrid(p.grid).forEach((id) => { if (id === cardId) found.push(`p${i}.grid`) })
  })
  match.shared.toonDeck.forEach((id) => { if (id === cardId) found.push('toonDeck') })
  match.shared.market.slots.forEach((id) => { if (id === cardId) found.push('market') })
  return found
}

describe('detaching the card (phases.ts)', () => {
  test('a REAL hire takes the Pig straight back out of the deck it just entered', () => {
    // hire() appends the purchased card to the player's DECK (phases.ts:
    // `deck: [...state.deck, cardId]`) — it never touches the grid. An
    // earlier version of placeSelfInAnyDeck searched the grid and then threw,
    // so this exact path — the card's only real trigger — crashed the turn.
    const { match, playerId, slotIndex } = matchWithPigInMarket()
    const i = playerIndex(match, playerId)
    const deckBefore = match.players[i].deck
    const fameBefore = match.players[i].fame
    const price = match.shared.market.prices[slotIndex]

    const after = applyMatchAction(match, playerId, { kind: 'hire', slotIndex }).match
    const me = after.players[i]

    // Exactly equal, not merely "doesn't contain pig": hire appends and the
    // effect splices, so equality also catches an off-by-one splice.
    expect(me.deck).toEqual(deckBefore)
    expect(me.pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'hire' })
    expect(me.fame).toBe(fameBefore - price)
    expect(me.actionsRemaining).toBe(1)
    // Detached from every zone while it waits for a destination.
    expect(zoneCensus(after, 'pig')).toEqual([])
  })

  test('a dismissed Pig comes back OUT of the dismissed pile', () => {
    // Otherwise it would be in two places at once — the rules send it to a
    // deck INSTEAD of out of the game.
    const { match, playerId } = matchWithPigInMarket()
    const i = playerIndex(match, playerId)
    const view = { ...match.players[i], ...match.shared, dismissed: ['bee' as CardId, 'pig' as CardId] }
    const after = applyEffects(view, cards['pig'], cards['pig'].onDismiss)

    expect(after.dismissed).toEqual(['bee'])
    expect(after.pendingDeckPlacement).toEqual({ cardId: 'pig', source: 'dismiss' })
  })

  test('it throws rather than silently vanishing if the card is nowhere', () => {
    const { match, playerId } = matchWithPigInMarket()
    const i = playerIndex(match, playerId)
    // Genuinely absent from BOTH zones the effect can detach from.
    const view = { ...match.players[i], ...match.shared, deck: [], dismissed: [] }
    expect(() => applyEffects(view, cards['pig'], cards['pig'].onHire)).toThrow(/neither in the deck nor the dismissed pile/)
  })

  test('hire to placement, end to end: it lands in the opponent\'s deck and nowhere else', () => {
    const { match, playerId, slotIndex } = matchWithPigInMarket()
    const hired = applyMatchAction(match, playerId, { kind: 'hire', slotIndex }).match
    const victim = hired.turnOrder.find((id) => id !== playerId)!
    const after = applyMatchAction(hired, playerId, {
      kind: 'resolveDeckPlacement',
      target: { kind: 'player', playerId: victim },
    }).match

    const victimIndex = playerIndex(after, victim)
    expect(zoneCensus(after, 'pig')).toEqual([`p${victimIndex}.deck`])
    expect(after.players[playerIndex(after, playerId)].pendingDeckPlacement).toBeNull()
  })
})

describe('placing it (match.ts)', () => {
  function pendingMatch(): { match: Match; playerId: string } {
    const { match, playerId } = marketPhaseMatch()
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
    const { match, playerId } = marketPhaseMatch()
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
    // Ending it would strand the card outside every zone in the game — and
    // the prompt is turn-gated, so the seat could never be asked again.
    const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const match: Match = { ...base, shared: { ...base.shared, phase: 'market' } }
    const idx = match.activePlayerIndex
    const players = match.players.slice()
    players[idx] = { ...players[idx], actionsRemaining: 0, pendingDeckPlacement: { cardId: 'pig', source: 'hire' } }
    const stuck: Match = { ...match, players }
    const actor = stuck.turnOrder[idx]

    // The explicit click is refused...
    expect(() => applyMatchAction(stuck, actor, { kind: 'endTurn' })).toThrow(IllegalActionError)

    // ...and once the placement is answered, the turn closes on its own —
    // this seat had no actions left, so the placement was the only thing
    // holding it open.
    const after = applyMatchAction(stuck, actor, { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } })
    expect(after.match.players[idx].pendingDeckPlacement).toBeNull()
    expect(after.match.activePlayerIndex).not.toBe(idx)
  })
})

// --- helpers ---------------------------------------------------------------

function cardIdsInGrid(grid: ReturnType<typeof buildNewMatch>['players'][0]['grid']): CardId[] {
  return occupiedSlots(grid).flatMap(({ slot }) => slot.cards)
}

describe('the pending prompt freezes the rest of the turn', () => {
  function stuckMatch(): { match: Match; actor: string; idx: number } {
    const base = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const idx = base.activePlayerIndex
    const players = base.players.slice()
    players[idx] = { ...players[idx], fame: 50, actionsRemaining: 1, pendingDeckPlacement: { cardId: 'pig', source: 'hire' } }
    return { match: { ...base, shared: { ...base.shared, phase: 'market' }, players }, actor: base.turnOrder[idx], idx }
  }

  test('you cannot hire or dismiss while a card is still owed a deck', () => {
    const { match, actor } = stuckMatch()
    expect(() => applyMatchAction(match, actor, { kind: 'hire', slotIndex: 0 })).toThrow(IllegalActionError)
    expect(() => applyMatchAction(match, actor, { kind: 'dismiss', pos: { section: 'base', row: 0, col: 0 }, index: 0 })).toThrow(IllegalActionError)
  })

  test('the refusal names the card, so the player knows what is blocking them', () => {
    const { match, actor } = stuckMatch()
    expect(() => applyMatchAction(match, actor, { kind: 'endTurn' })).toThrow(/Pig/)
  })
})
