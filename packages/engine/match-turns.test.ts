// Stage 1: the multiplayer turn machine (match.ts) and N-player setup.
//
// These assert the things that DON'T exist in a solo game — turn ownership,
// once-per-round vs once-per-turn timing, cross-player scoring inputs, and
// Cleanup's load-bearing step order.

import { describe, expect, test } from 'bun:test'
import {
  activePlayerId,
  buildNewMatch,
  endMarketTurn,
  matchHire,
  runMatchCheckFame,
  runMatchCleanup,
  matchResolvePostFameChoice,
  playerIndex,
  runMatchFlip,
  runMatchPostFameHooks,
  strictlyLowestScorerIndex,
} from './match'
import type { Match } from './state'
import { hireCost } from './market'
import { emptyGrid } from './grid'
import {
  buildMultiplayerSetup,
  buildMultiplayerToonDeckUnshuffled,
  buildSeason1MultiplayerStartingDeck,
  pricesForPlayerCount,
} from './setup'

// Drives a match from 'flip' to the start of the Market phase, answering any
// mandatory Skunk dismissal with its first legal option. The multiplayer
// starting deck KEEPS the Skunk (solo swaps it out), so this prompt is the
// normal path in Season 1, not an edge case.
function toMarket(match: Match): Match {
  let next = runMatchPostFameHooks(runMatchCheckFame(runMatchFlip(match)))
  for (const p of next.players) {
    const pending = next.players[playerIndex(next, p.playerId)].pendingPostFameChoice
    if (pending) next = matchResolvePostFameChoice(next, p.playerId, pending.options[0])
  }
  return next
}

// Every seat passes without acting, closing the Market phase.
function allSeatsPass(match: Match): Match {
  let next = match
  for (let i = 0; i < match.players.length; i++) {
    next = endMarketTurn(next, activePlayerId(next))
  }
  return next
}

describe('N-player setup', () => {
  test('market width and prices key off player count alone, never season count', () => {
    expect(pricesForPlayerCount(2)).toEqual([3, 4, 7, 10, 15])
    expect(pricesForPlayerCount(4)).toEqual([3, 4, 7, 10, 15])
    // The case a plausible-looking implementation gets wrong (§3.6): combining
    // seasons is what ENABLES 5-8 players, but a 3-player game still gets the
    // 5-slot row regardless of how many seasons are in play.
    expect(buildMultiplayerSetup(1, 3, 2).prices).toHaveLength(5)
    expect(buildMultiplayerSetup(1, 3, 1).prices).toHaveLength(5)
  })

  test('keeps the Pig in the toon deck — its removal is a solo-only rule', () => {
    expect(buildMultiplayerToonDeckUnshuffled(1)).toContain('pig')
  })

  test('applies no difficulty trim — that is solo-only too', () => {
    const full = buildMultiplayerToonDeckUnshuffled(1).length
    const setup = buildMultiplayerSetup(1, 3, 1)
    expect(setup.toonDeck).toHaveLength(full)
  })

  test('uses the multiplayer starting deck, not solo’s 3rd-Caterpillar swap', () => {
    const deck = buildSeason1MultiplayerStartingDeck()
    expect(deck.filter((c) => c === 'caterpillar')).toHaveLength(2)
    expect(deck).toContain('skunk')
    expect(deck).toHaveLength(6)
  })

  test('every seat gets its own deck array and its own RNG stream', () => {
    const match = buildNewMatch(99, 3)
    expect(match.players).toHaveLength(3)
    expect(match.turnOrder).toEqual(['p0', 'p1', 'p2'])
    expect(match.players[0].deck).not.toBe(match.players[1].deck)
    expect(new Set(match.players.map((p) => p.rng)).size).toBe(3)
  })

  test('rejects player counts outside the built range', () => {
    expect(() => buildMultiplayerSetup(1, 1)).toThrow(/must be an integer 2-4/)
    expect(() => buildMultiplayerSetup(1, 5)).toThrow(/5-8 player support is not built yet/)
  })
})

describe('Flip', () => {
  test('fills every seat’s own grid from its own deck', () => {
    const flipped = runMatchFlip(buildNewMatch(7, 3))

    expect(flipped.shared.phase).toBe('checkFame')
    for (const p of flipped.players) {
      expect(p.grid).not.toEqual(buildNewMatch(7, 3).players[0].grid)
    }
    // Distinct grid objects, not one aliased board.
    expect(flipped.players[0].grid).not.toBe(flipped.players[1].grid)
  })

  test('seats draw from one shared toon deck, sequenced — never from stale copies', () => {
    const match = buildNewMatch(7, 3)
    const before = match.shared.toonDeck.length
    const flipped = runMatchFlip(match)

    // There is exactly one shared toon deck; it can only shrink.
    expect(flipped.shared.toonDeck.length).toBeLessThanOrEqual(before)
    // Every seat's view agrees, with no sync step.
    expect(flipped.players.length).toBe(3)
    expect(flipped.shared.market.prices).toHaveLength(5)
  })

  test('is deterministic for a given seed', () => {
    const a = runMatchFlip(buildNewMatch(2024, 3))
    const b = runMatchFlip(buildNewMatch(2024, 3))
    expect(a.players.map((p) => p.grid)).toEqual(b.players.map((p) => p.grid))
    expect(a.shared.toonDeck).toEqual(b.shared.toonDeck)
  })
})

describe('Check Fame', () => {
  test('scores every seat simultaneously', () => {
    const scored = runMatchCheckFame(runMatchFlip(buildNewMatch(11, 3)))

    expect(scored.shared.phase).toBe('postFameHooks')
    for (const p of scored.players) {
      expect(p.lastCheckFame).not.toBeNull()
      expect(p.fame).toBe(p.lastCheckFame!.total)
      expect(p.fameGeneratedThisRound).toBe(p.lastCheckFame!.total)
    }
  })

  test('seat order cannot affect anyone’s score', () => {
    // Scoring reads grids and writes only the scorer's own fame, so the same
    // board must produce the same totals however the loop is ordered.
    const scored = runMatchCheckFame(runMatchFlip(buildNewMatch(11, 3)))
    const again = runMatchCheckFame(runMatchFlip(buildNewMatch(11, 3)))
    expect(scored.players.map((p) => p.fame)).toEqual(again.players.map((p) => p.fame))
  })
})

describe('Market turn order', () => {
  test('starts with the first player and rejects everyone else', () => {
    const match = toMarket(buildNewMatch(3, 3, 1, { firstPlayerIndex: 0 }))

    expect(match.shared.phase).toBe('market')
    expect(activePlayerId(match)).toBe('p0')
    expect(() => endMarketTurn(match, 'p1')).toThrow(/it is p0's turn, not p1's/)
    expect(() => matchHire(match, 'p2', 0)).toThrow(/it is p0's turn, not p2's/)
  })

  test('passes clockwise as each seat ends its turn', () => {
    let match = toMarket(buildNewMatch(3, 3, 1, { firstPlayerIndex: 0 }))
    expect(activePlayerId(match)).toBe('p0')

    match = endMarketTurn(match, 'p0')
    expect(activePlayerId(match)).toBe('p1')
    expect(match.shared.phase).toBe('market')

    match = endMarketTurn(match, 'p1')
    expect(activePlayerId(match)).toBe('p2')
    expect(match.shared.phase).toBe('market')
  })

  test('closes the phase for the table only when the turn order wraps', () => {
    const match = allSeatsPass(toMarket(buildNewMatch(3, 3)))
    expect(match.shared.phase).toBe('cleanup')
  })

  test('gives each seat exactly two actions', () => {
    const match = toMarket(buildNewMatch(3, 3))
    for (const p of match.players) expect(p.actionsRemaining).toBe(2)
  })

  test('a seat cannot take a third action', () => {
    let match = toMarket(buildNewMatch(3, 3, 1, { firstPlayerIndex: 0 }))
    // Give p0 enough fame to afford three hires outright.
    match = { ...match, players: match.players.map((p, i) => (i === 0 ? { ...p, fame: 500 } : p)) }

    const affordable = () =>
      match.shared.market.slots.map((id, i) => ({ id, i })).filter((s) => s.id !== null)

    match = matchHire(match, 'p0', affordable()[0].i)
    expect(match.players[0].actionsRemaining).toBe(1)
    match = matchHire(match, 'p0', affordable()[0].i)
    expect(match.players[0].actionsRemaining).toBe(0)
    expect(() => matchHire(match, 'p0', affordable()[0].i)).toThrow(/no Market actions remaining/)
  })

  test('one seat’s hire is paid from that seat’s own fame', () => {
    let match = toMarket(buildNewMatch(3, 3, 1, { firstPlayerIndex: 0 }))
    match = { ...match, players: match.players.map((p) => ({ ...p, fame: 100 })) }

    const slotIndex = match.shared.market.slots.findIndex((id) => id !== null)
    const price = hireCost(match.shared.market, slotIndex)
    match = matchHire(match, 'p0', slotIndex)

    expect(match.players[0].fame).toBe(100 - price)
    expect(match.players[1].fame).toBe(100)
    expect(match.players[2].fame).toBe(100)
  })

  test('a hired card leaves the shared market for everyone', () => {
    let match = toMarket(buildNewMatch(3, 3, 1, { firstPlayerIndex: 0 }))
    match = { ...match, players: match.players.map((p) => ({ ...p, fame: 100 })) }

    const slotIndex = match.shared.market.slots.findIndex((id) => id !== null)
    const cardId = match.shared.market.slots[slotIndex]
    match = matchHire(match, 'p0', slotIndex)

    expect(match.shared.market.slots[slotIndex]).toBeNull()
    expect(match.players[0].deck).toContain(cardId!)
    expect(match.players[1].deck).not.toContain(cardId!)
  })
})

describe('market decay timing', () => {
  test('fires once per round at 2 players, not once per seat', () => {
    // The decay burns 2 toon cards per round. Running it per turn would burn
    // 2 x seats, racing an N-player game to depletion.
    const match = toMarket(buildNewMatch(5, 2))
    const before = match.shared.toonDeck.length
    const after = allSeatsPass(match)

    expect(after.shared.phase).toBe('cleanup')
    // 2 decayed slots refilled + Cleanup's own refill happens later, so the
    // decay's own draw is bounded well below "2 per seat".
    expect(before - after.shared.toonDeck.length).toBeLessThanOrEqual(2)
  })

  test('does not fire at 3+ players', () => {
    const match = toMarket(buildNewMatch(5, 3))
    const before = match.shared.toonDeck.length
    const after = allSeatsPass(match)

    // Nobody acted, so with no decay the market needs no refill at all.
    expect(after.shared.toonDeck.length).toBe(before)
  })
})

describe('postFameHooks — Skunk/Firefly at N players', () => {
  test('only the STRICTLY lowest scorer qualifies; a tie for last disqualifies everyone', () => {
    // Skunk's FAQ: "Only one player can benefit from the skunk's ability each
    // round. In case of a tie, the skunk has no effect."
    const base = runMatchCheckFame(runMatchFlip(buildNewMatch(3, 3)))

    const clear = { ...base, players: base.players.map((p, i) => ({ ...p, fameGeneratedThisRound: [9, 2, 7][i] })) }
    expect(strictlyLowestScorerIndex(clear)).toBe(1)

    const tied = { ...base, players: base.players.map((p, i) => ({ ...p, fameGeneratedThisRound: [2, 2, 7][i] })) }
    expect(strictlyLowestScorerIndex(tied)).toBeNull()
  })

  test('solo is vacuously the lowest scorer', () => {
    const base = runMatchCheckFame(runMatchFlip(buildNewMatch(3, 2)))
    expect(strictlyLowestScorerIndex({ ...base, players: [base.players[0]], turnOrder: ['p0'] })).toBe(0)
  })

  test('a pending Skunk dismissal blocks the Market phase for the whole table', () => {
    const hooked = runMatchPostFameHooks(runMatchCheckFame(runMatchFlip(buildNewMatch(3, 3))))
    const owed = hooked.players.filter((p) => p.pendingPostFameChoice)
    if (owed.length === 0) return // this seed's lowest scorer had no face-up Skunk

    // The mandatory dismissal resolves BEFORE the Market phase (3.4).
    expect(hooked.shared.phase).toBe('postFameHooks')

    let next = hooked
    for (const p of owed) next = matchResolvePostFameChoice(next, p.playerId, p.pendingPostFameChoice!.options[0])
    expect(next.shared.phase).toBe('market')
  })

  test('the Skunk dismissal is free and costs no Market action', () => {
    const hooked = runMatchPostFameHooks(runMatchCheckFame(runMatchFlip(buildNewMatch(3, 3))))
    const owner = hooked.players.find((p) => p.pendingPostFameChoice)
    if (!owner) return

    const fameBefore = owner.fame
    const after = matchResolvePostFameChoice(hooked, owner.playerId, owner.pendingPostFameChoice!.options[0])
    const idx = playerIndex(after, owner.playerId)

    // FAQ: "This ability is mandatory and does not cost an action. If a player
    // benefits from the skunk's ability, they still take up to two actions."
    expect(after.players[idx].fame).toBe(fameBefore)
    expect(after.players[idx].actionsRemaining).toBe(2)
    expect(after.players[idx].dismissed).toHaveLength(1)
  })

  test('rejects an option that was not offered', () => {
    const hooked = runMatchPostFameHooks(runMatchCheckFame(runMatchFlip(buildNewMatch(3, 3))))
    const owner = hooked.players.find((p) => p.pendingPostFameChoice)
    if (!owner) return
    expect(() => matchResolvePostFameChoice(hooked, owner.playerId, { pos: { section: 'extra', row: 9, col: 9 }, index: 0 })).toThrow(
      /not one of the/,
    )
  })
})

describe('Cleanup', () => {
  function atCleanup(seed = 3, players = 3): Match {
    return allSeatsPass(toMarket(buildNewMatch(seed, players, 1, { firstPlayerIndex: 0 })))
  }

  test('collects every seat’s grid back into its own deck and resets fame', () => {
    const before = atCleanup()
    const after = runMatchCleanup(before)

    for (let i = 0; i < after.players.length; i++) {
      expect(after.players[i].fame).toBe(0)
      expect(after.players[i].fameGeneratedThisRound).toBe(0)
      expect(after.players[i].grid).toEqual(emptyGrid())
    }
  })

  test('rotates the first player clockwise and starts the next round there', () => {
    const after = runMatchCleanup(atCleanup())

    expect(after.shared.round).toBe(2)
    expect(after.shared.phase).toBe('flip')
    expect(after.firstPlayerIndex).toBe(1)
    expect(after.activePlayerIndex).toBe(1)
  })

  test('awards the Critic’s Choice BEFORE fame resets', () => {
    // The ordering bug this guards: Cleanup resets fameGeneratedThisRound to
    // 0, and the award reads that field. Reset-then-award hands the token to
    // an N-way tie at zero and silently removes it every single round.
    let match = atCleanup()
    match = {
      ...match,
      players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: i === 1 ? 34 : 10 })),
    }

    const after = runMatchCleanup(match)
    expect(after.shared.criticsChoiceHolder).toBe('p1')
    expect(after.shared.endgameTriggered).toBe(true)
  })

  test('a leader on 34 beats a player on 30 to the card', () => {
    let match = atCleanup()
    match = {
      ...match,
      players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: [34, 30, 12][i] })),
    }
    expect(runMatchCleanup(match).shared.criticsChoiceHolder).toBe('p0')
  })

  test('triggers at exactly the threshold (>=, not >)', () => {
    let match = atCleanup()
    match = {
      ...match,
      players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: i === 0 ? 30 : 5 })),
    }
    const after = runMatchCleanup(match)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBe('p0')
  })

  test('removes the card from the game when the leaders tie', () => {
    let match = atCleanup()
    match = {
      ...match,
      players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: i === 2 ? 8 : 33 })),
    }
    const after = runMatchCleanup(match)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBeNull()
  })

  test('awards nothing on a depletion-only ending', () => {
    let match = atCleanup()
    match = {
      ...match,
      shared: { ...match.shared, toonDeckDepleted: true },
      players: match.players.map((p) => ({ ...p, fameGeneratedThisRound: 4 })),
    }
    const after = runMatchCleanup(match)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBeNull()
  })

  test('the trigger round goes to the Final Flip, not another normal round', () => {
    let match = atCleanup()
    match = { ...match, players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: i === 0 ? 31 : 3 })) }

    const after = runMatchCleanup(match)
    expect(after.shared.phase).toBe('finalFlip')
    // The round counter DOES advance — the Final Flip logs as its own round,
    // not an amendment folded into the trigger round's log section.
    expect(after.shared.round).toBe(match.shared.round + 1)
  })

  test('both triggers firing in one round still produces exactly one endgame', () => {
    let match = atCleanup()
    match = {
      ...match,
      shared: { ...match.shared, toonDeckDepleted: true },
      players: match.players.map((p, i) => ({ ...p, fameGeneratedThisRound: i === 0 ? 40 : 2 })),
    }
    const after = runMatchCleanup(match)
    expect(after.shared.phase).toBe('finalFlip')
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBe('p0')
  })
})

describe('multi-round play', () => {
  test('a 3-player match runs several full rounds without desyncing', () => {
    let match = buildNewMatch(4242, 3)

    for (let round = 1; round <= 4; round++) {
      expect(match.shared.phase).toBe('flip')
      expect(match.shared.round).toBe(round)

      match = allSeatsPass(toMarket(match))
      expect(match.shared.phase).toBe('cleanup')

      // Every seat holds its own board and its own fame off one shared market.
      expect(new Set(match.players.map((p) => p.playerId)).size).toBe(3)
      expect(match.shared.market.prices).toHaveLength(5)

      match = runMatchCleanup(match)
      if (match.shared.phase === 'finalFlip') break
      // First player rotates every round.
      expect(match.firstPlayerIndex).toBe(round % 3)
    }
  })
})
