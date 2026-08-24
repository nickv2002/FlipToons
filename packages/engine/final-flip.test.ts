// Stage 2: the endgame triggers, the Final Flip, the tiebreak re-flip loop,
// and the Critic's Choice +3.
//
// The thing most worth guarding here is the +3's GATE. The obvious
// implementation — `shared.phase === 'finalFlip'` — is wrong in a way that
// only shows up on the real code path: runMatchFlip hands off to Check Fame by
// setting `phase: 'checkFame'`, so by the time anyone is scored the phase no
// longer says 'finalFlip'. A test that hand-builds a state with
// `phase: 'finalFlip'` and calls roundFame directly passes against that broken
// gate. So the bonus is asserted through runMatchFinalFlip's actual output.

import { describe, expect, test } from 'bun:test'
import {
  buildNewMatch,
  matchRoundFame,
  runMatchCheckFame,
  runMatchCleanup,
  runMatchFinalFlip,
  runMatchFlip,
} from './match'
import { CRITICS_CHOICE_FINAL_FLIP_BONUS, playerFameModifiers, roundFame } from './roundFame'
import type { CardId } from './cards/types'
import { emptyGrid } from './grid'
import type { Match } from './state'
import { buildMultiplayerSetup } from './setup'

// Two seats whose Final Flip fame is FIXED regardless of shuffle order:
// caterpillar/snail/bee have no effects, no adjacency bonuses and no toon-deck
// draws, and each deck is exactly the six cards a grid holds, so every flip of
// it scores the same. That makes a tie reproducible instead of seed-hunted.
//   p0: 6 x caterpillar         -> 0 grid fame
//   p1: 4 x caterpillar + snail(2) + bee(1) -> 3 grid fame
const FLAT_DECK_0: CardId[] = Array(6).fill('caterpillar')
const FLAT_DECK_3: CardId[] = [...Array(4).fill('caterpillar'), 'snail', 'bee']

function flatTieMatch(criticsChoiceHolder: string | null): Match {
  const m = buildNewMatch(5, 2)
  return {
    ...m,
    shared: { ...m.shared, phase: 'finalFlip', endgameTriggered: true, criticsChoiceHolder },
    players: [
      { ...m.players[0], deck: [...FLAT_DECK_0] },
      { ...m.players[1], deck: [...FLAT_DECK_3] },
    ],
  }
}

// A match parked at the top of the Final Flip, as runMatchCleanup would leave
// it. `endgameTriggered` is the latch the +3 reads — see roundFame.ts.
function atFinalFlip(seed: number, playerCount: number, criticsChoiceHolder: string | null = null): Match {
  const m = buildNewMatch(seed, playerCount)
  return { ...m, shared: { ...m.shared, phase: 'finalFlip', endgameTriggered: true, criticsChoiceHolder } }
}

describe('winCondition (§3.2.2/§4.6)', () => {
  test('multiplayer reads a failed refill as an ordinary ending, not a loss', () => {
    expect(buildNewMatch(1, 2).shared.winCondition).toBe('highestFinalFlip')
    expect(buildMultiplayerSetup(1, 3).winCondition).toBe('highestFinalFlip')
  })
})

describe('endgame triggers, latched at Cleanup (§3.2.2)', () => {
  // Both triggers are OR'd and latched, so both firing in one round still
  // produces exactly ONE Final Flip rather than two.
  function atCleanup(match: Match): Match {
    return { ...match, shared: { ...match.shared, phase: 'cleanup' } }
  }

  test('fame trigger fires at exactly the threshold, not only above it', () => {
    const m = buildNewMatch(4, 2)
    const at30 = atCleanup({
      ...m,
      shared: { ...m.shared, fameToTriggerEndgame: 30 },
      players: [{ ...m.players[0], fameGeneratedThisRound: 30 }, { ...m.players[1], fameGeneratedThisRound: 12 }],
    })
    const after = runMatchCleanup(at30)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.phase).toBe('finalFlip')
  })

  test('one fame short does not trigger, and the round rolls on normally', () => {
    const m = buildNewMatch(4, 2)
    const at29 = atCleanup({
      ...m,
      shared: { ...m.shared, fameToTriggerEndgame: 30 },
      players: [{ ...m.players[0], fameGeneratedThisRound: 29 }, { ...m.players[1], fameGeneratedThisRound: 12 }],
    })
    const after = runMatchCleanup(at29)
    expect(after.shared.endgameTriggered).toBe(false)
    expect(after.shared.phase).toBe('flip')
    expect(after.shared.round).toBe(m.shared.round + 1)
  })

  test('depletion alone triggers the endgame — tested with a bare toon deck, not by draining one', () => {
    const m = buildNewMatch(4, 2)
    const depleted = atCleanup({ ...m, shared: { ...m.shared, toonDeck: [], toonDeckDepleted: true } })
    const after = runMatchCleanup(depleted)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.phase).toBe('finalFlip')
  })

  test('both triggers in one round still produce exactly one Final Flip', () => {
    const m = buildNewMatch(4, 2)
    const both = atCleanup({
      ...m,
      shared: { ...m.shared, fameToTriggerEndgame: 30, toonDeck: [], toonDeckDepleted: true },
      players: [{ ...m.players[0], fameGeneratedThisRound: 42 }, { ...m.players[1], fameGeneratedThisRound: 8 }],
    })
    const after = runMatchCleanup(both)
    expect(after.shared.phase).toBe('finalFlip')
    // The Final Flip resolves the match outright; there is no second one to run.
    const outcome = runMatchFinalFlip(after)
    expect(outcome.match.shared.phase).toBe('ended')
  })

  test('the trigger round has already played its FULL Market phase — Cleanup still collects and refills', () => {
    // The opposite of solo's checkInstantWin house rule, which ends the game
    // the moment fame hits the threshold.
    const m = buildNewMatch(4, 2)
    const triggered = atCleanup({
      ...m,
      shared: { ...m.shared, fameToTriggerEndgame: 30 },
      players: m.players.map((p) => ({ ...p, fameGeneratedThisRound: 30, fame: 17 })),
    })
    const after = runMatchCleanup(triggered)
    for (const p of after.players) {
      expect(p.fame).toBe(0)
      expect(p.grid).toEqual(emptyGrid())
    }
  })
})

describe("Critic's Choice +3 (§3.2.1)", () => {
  test('the holder scores exactly 3 more than they would without the card', () => {
    // Same seed both times, so the flip is identical and the ONLY difference
    // is who holds the card.
    const withHolder = runMatchFinalFlip(atFinalFlip(5, 2, 'p0'))
    const without = runMatchFinalFlip(atFinalFlip(5, 2, null))

    const holder = withHolder.scores.find((s) => s.playerId === 'p0')!
    const plain = without.scores.find((s) => s.playerId === 'p0')!
    expect(holder.total).toBe(plain.total + CRITICS_CHOICE_FINAL_FLIP_BONUS)

    // And nobody else moves.
    const other = withHolder.scores.find((s) => s.playerId === 'p1')!
    const otherPlain = without.scores.find((s) => s.playerId === 'p1')!
    expect(other.total).toBe(otherPlain.total)
    expect(other.modifiers).toEqual([])
  })

  test('the bonus is itemised, not folded into the grid total', () => {
    const outcome = runMatchFinalFlip(atFinalFlip(5, 2, 'p0'))
    const holder = outcome.scores.find((s) => s.playerId === 'p0')!
    expect(holder.modifiers).toEqual([
      { source: 'criticsChoice', label: "Critic's Choice (Final Flip)", amount: 3 },
    ])
  })

  test('no bonus outside the endgame, even while holding the card', () => {
    // A normal round: the card is held from the Cleanup that awarded it, but
    // it is worth nothing until the Final Flip.
    const m = buildNewMatch(5, 2)
    const midGame = { ...m, shared: { ...m.shared, criticsChoiceHolder: 'p0', endgameTriggered: false } }
    expect(playerFameModifiers({ playerId: 'p0' }, midGame.shared)).toEqual([])
    expect(roundFame({ playerId: 'p0', lastCheckFame: { total: 11, lines: [] } }, midGame.shared).total).toBe(11)
  })

  test('a tie for the lead removes the card from the game — nobody gets +3', () => {
    const m = buildNewMatch(4, 2)
    const tiedAtCleanup: Match = {
      ...m,
      shared: { ...m.shared, phase: 'cleanup', fameToTriggerEndgame: 30 },
      players: m.players.map((p) => ({ ...p, fameGeneratedThisRound: 33 })),
    }
    const after = runMatchCleanup(tiedAtCleanup)
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBeNull()
    for (const s of runMatchFinalFlip(after).scores) expect(s.modifiers).toEqual([])
  })

  test('34 beats 30 to the card', () => {
    const m = buildNewMatch(4, 2)
    const after = runMatchCleanup({
      ...m,
      shared: { ...m.shared, phase: 'cleanup', fameToTriggerEndgame: 30 },
      players: [
        { ...m.players[0], fameGeneratedThisRound: 30 },
        { ...m.players[1], fameGeneratedThisRound: 34 },
      ],
    })
    expect(after.shared.criticsChoiceHolder).toBe('p1')
  })

  test('a depletion-only ending awards no card (the rules condition the award on the fame trigger)', () => {
    const m = buildNewMatch(4, 2)
    const after = runMatchCleanup({
      ...m,
      shared: { ...m.shared, phase: 'cleanup', toonDeck: [], toonDeckDepleted: true },
      players: m.players.map((p) => ({ ...p, fameGeneratedThisRound: 9 })),
    })
    expect(after.shared.endgameTriggered).toBe(true)
    expect(after.shared.criticsChoiceHolder).toBeNull()
  })
})

describe('the Final Flip is Flip + Check Fame only (§3.2)', () => {
  test('it ends the match outright — no Market phase, no further Cleanup', () => {
    const outcome = runMatchFinalFlip(atFinalFlip(5, 3))
    expect(outcome.match.shared.phase).toBe('ended')
    expect(outcome.match.shared.result).toBe('win')
    // Nobody is handed Market actions on the way out.
    for (const p of outcome.match.players) expect(p.actionsRemaining).toBe(0)
  })

  test('every seat is flipped and scored', () => {
    const outcome = runMatchFinalFlip(atFinalFlip(5, 3))
    expect(outcome.scores).toHaveLength(3)
    for (const p of outcome.match.players) expect(p.lastCheckFame).not.toBeNull()
  })

  test('runMatchFlip refuses the Final Flip and names the right entry point', () => {
    // Routing the Final Flip through runMatchFlip would erase the only signal
    // that one was in progress and let it fall through into a Market phase.
    expect(() => runMatchFlip(atFinalFlip(5, 2))).toThrow(/runMatchFinalFlip/)
  })

  test('a Market phase cannot open once the endgame is latched', () => {
    const m = atFinalFlip(5, 2)
    const scored = runMatchCheckFame({ ...m, shared: { ...m.shared, phase: 'checkFame' } })
    expect(scored.shared.phase).not.toBe('market')
  })

  test('the winner is the highest Final Flip fame, +3 included', () => {
    const outcome = runMatchFinalFlip(atFinalFlip(5, 3, 'p1'))
    const top = Math.max(...outcome.scores.map((s) => s.total))
    for (const w of outcome.winners) {
      expect(outcome.scores.find((s) => s.playerId === w)!.total).toBe(top)
    }
  })
})

describe('the tiebreak re-flip loop (§3.2)', () => {
  // Ties are common in practice, not exotic: a Final Flip off a six-card
  // starting deck scores in the single digits, so seeds that tie are easy to
  // come by. These are real ties produced by the engine, not hand-built ones.

  test('a tied Final Flip re-flips until one player is ahead', () => {
    const outcome = runMatchFinalFlip(atFinalFlip(2, 2))
    expect(outcome.tiebreakRounds).toBeGreaterThan(0)
    expect(outcome.winners).toHaveLength(1)
    expect(outcome.match.shared.winnerId).toBe(outcome.winners[0])
  })

  test('it terminates even when several re-flips tie in a row', () => {
    // Seed 10 needs four consecutive re-flips at 2 players.
    const outcome = runMatchFinalFlip(atFinalFlip(10, 2))
    expect(outcome.tiebreakRounds).toBeGreaterThan(1)
    expect(outcome.winners).toHaveLength(1)
  })

  test('every seed resolves to a single winner well inside the cap', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const outcome = runMatchFinalFlip(atFinalFlip(seed, 2))
      expect(outcome.winners).toHaveLength(1)
      expect(outcome.tiebreakRounds).toBeLessThan(100)
    }
  })

  // REGRESSION (MatchView.tsx's EndScreen). A re-flip leaves every OTHER
  // seat's fameGeneratedThisRound exactly where the first flip left it, so
  // matchRoundFame keeps reporting the tie the engine has already broken. Any
  // client that recomputes the winner from those totals contradicts both
  // winnerId and the "X wins!" line the engine logged — which is precisely the
  // bug this pins. The UI must read shared.winnerId; these seeds are what make
  // the difference observable.
  test('a settled tiebreak leaves matchRoundFame still showing a tie — read winnerId, not the totals', () => {
    // Found by sweeping seeds 1-400 at 2/3/4 players: 32 of 1200 Final Flips
    // land here. All three of these are 3-player; 2 players cannot produce it,
    // because the re-flip winner is always the max of the two.
    const disagreeing = [98, 138, 152]
    for (const seed of disagreeing) {
      const outcome = runMatchFinalFlip(atFinalFlip(seed, 3))

      // The engine decided, and said so.
      expect(outcome.winners).toHaveLength(1)
      expect(outcome.match.shared.winnerId).toBe(outcome.winners[0])

      // ...but the recorded totals still tie, so the naive argmax a client
      // might reach for names more than one seat.
      const fames = matchRoundFame(outcome.match)
      const top = Math.max(...fames.map((f) => f.fame.total))
      const argmax = fames.filter((f) => f.fame.total === top).map((f) => f.playerId)
      expect(argmax.length).toBeGreaterThan(1)
      expect(argmax).toContain(outcome.match.shared.winnerId!)
    }
  })

  test('winnerId is set for every seed that resolves to one winner', () => {
    // The client's fallback to the tie set is correct ONLY where winnerId is
    // null, so a null with a single winner would silently route a decided
    // match through the co-win branch.
    for (const playerCount of [2, 3, 4]) {
      for (let seed = 1; seed <= 60; seed++) {
        const outcome = runMatchFinalFlip(atFinalFlip(seed, playerCount))
        expect(outcome.match.shared.winnerId).toBe(outcome.winners.length === 1 ? outcome.winners[0] : null)
      }
    }
  })

  test("spectators' state is untouched by a tiebreak they are not in", () => {
    // Three players; whoever is NOT tied must keep the exact board and score
    // their own Final Flip produced.
    const first = runMatchFinalFlip(atFinalFlip(2, 3))
    if (first.tiebreakRounds === 0) return // this seed settled outright; nothing to assert

    // Re-derive who sat out: anyone whose recorded fame is below the top.
    const top = Math.max(...first.scores.map((s) => s.total))
    const spectators = first.scores.filter((s) => s.total < top)
    expect(spectators.length).toBeGreaterThan(0)
    for (const s of spectators) {
      const p = first.match.players.find((x) => x.playerId === s.playerId)!
      // Their grid is still the one they flipped — a spectator whose grid had
      // been collected would be sitting behind an empty board.
      expect(p.grid.base.some((slot) => slot !== null)).toBe(true)
      expect(p.lastCheckFame!.total).toBe(s.total - s.modifiers.reduce((n, m) => n + m.amount, 0))
    }
  })

  test('the holder keeps the +3 through every re-flip', () => {
    // p0 scores 0 and holds the card; p1 scores 3. They are level at 3 on
    // every single flip, so the loop runs to the cap with the bonus still
    // applied — if the +3 were dropped after the first flip, p1 would pull
    // ahead and win on re-flip 1.
    const outcome = runMatchFinalFlip(flatTieMatch('p0'))
    expect(outcome.tiebreakRounds).toBe(100)
    const holder = outcome.scores.find((s) => s.playerId === 'p0')!
    expect(holder.modifiers).toEqual([
      { source: 'criticsChoice', label: "Critic's Choice (Final Flip)", amount: 3 },
    ])
    expect(holder.total).toBe(3)
    expect(outcome.scores.find((s) => s.playerId === 'p1')!.total).toBe(3)
  })

  test('the +3 can BREAK a tie that the grids alone would not', () => {
    // The same two decks with the card unheld: p1's 3 beats p0's 0 outright,
    // no tiebreak at all. Holding it is what levels them.
    const unheld = runMatchFinalFlip(flatTieMatch(null))
    expect(unheld.tiebreakRounds).toBe(0)
    expect(unheld.winners).toEqual(['p1'])
  })

  test('a hopeless tie ends in a shared win rather than a thrown error', () => {
    // Two seats with identical fixed-fame decks flip level forever. The cap
    // has to produce an ANSWER — throwing here would destroy a finished game.
    const m = buildNewMatch(5, 2)
    const clone: Match = {
      ...m,
      shared: { ...m.shared, phase: 'finalFlip', endgameTriggered: true },
      players: m.players.map((p) => ({ ...p, deck: [...FLAT_DECK_0] })),
    }
    const outcome = runMatchFinalFlip(clone)
    expect(outcome.tiebreakRounds).toBe(100)
    expect(outcome.winners).toEqual(['p0', 'p1'])
    expect(outcome.match.shared.winnerId).toBeNull()
    expect(outcome.match.shared.phase).toBe('ended')
  })
})

describe('matchRoundFame', () => {
  test('reports every seat without advancing the match', () => {
    const m = atFinalFlip(5, 3, 'p2')
    const before = JSON.stringify(m)
    const fames = matchRoundFame(m)
    expect(JSON.stringify(m)).toBe(before)
    expect(fames.map((f) => f.playerId)).toEqual(['p0', 'p1', 'p2'])
    expect(fames[2].fame.modifiers).toHaveLength(1)
  })
})
