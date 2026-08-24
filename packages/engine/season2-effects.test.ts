// Tests for the Season 2 onPlace effect vocabulary added this pass — Mole,
// Starfish, Swordfish, Salamander, Coyote, Crab, Zebra — plus the Goat
// upper-row regression this pass is required to guard (score.ts's
// evaluateBonus previously had NO handler for 'inUpperRow' at all, so Goat
// would have thrown if scored; it's added alongside these).
//
// Deliberately mixes season1/season2 card ids in one deck for readable,
// deterministic fillers with known ranks/fame and no onPlace effects of
// their own — not deck-legal, but neither is the same trick score.test.ts's
// two-Cow test already uses, and for the same reason: it's a legal GRID
// STATE, which is all flipDeck/scoreGrid ever look at.

import { describe, expect, test } from 'bun:test'
import { flipDeck } from './flip'
import { emptyGrid, extraRowSlotAbove, isFull, placeCardFaceUp } from './grid'
import { scoreGrid } from './score'
import { buildExplicitDeck, cardsById } from './setup'

const cards = cardsById()

function place(...ids: string[]) {
  const deck = buildExplicitDeck(ids, cards)
  return flipDeck(deck, cards, { toonDeck: [], dismissed: [] })
}

describe('Mole — stackOnAboveIfLowerRow', () => {
  test('placed in the lower row: stacks on the card directly above, vacating its own slot', () => {
    // bee -> base[0][0]. snail -> base[0][1]. caterpillar -> base[0][2].
    // mole is the 4th card -> base[1][0] (lower row) -> relocates onto
    // base[0][0] (bee), stacking. The vacated base[1][0] is refilled by the
    // next card (skunk).
    const { grid, remainingDeck } = place('bee', 'snail', 'caterpillar', 'mole', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['bee', 'mole'])
    expect(grid.base[0][0]!.faceUp).toEqual([true, true])
    expect(grid.base[1][0]!.cards).toEqual(['skunk']) // backfilled mole's vacated slot
    expect(grid.base[1][1]!.cards).toEqual(['dragonfly'])
    expect(remainingDeck).toHaveLength(0)
    // only 5 base slots consumed (mole's stack + 4 singles)
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(5)
  })

  test('placed in the upper row: no relocation, stays in place', () => {
    const { grid } = place('mole', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['mole'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
  })
})

describe('Starfish — stackOnPreviousPlaced + flipPreviousPlaced (composite of two existing primitives)', () => {
  test('flips the previous placed card AND stacks itself on it', () => {
    const { grid } = place('bee', 'starfish', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['bee', 'starfish'])
    expect(grid.base[0][0]!.faceUp).toEqual([false, true]) // bee flipped, starfish itself unaffected
    // only 5 base slots consumed (starfish stacked, not a new slot)
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(5)
  })

  test('previous placed card immune to flip (Rabbit): stack still happens, flip does not', () => {
    const { grid } = place('rabbit', 'starfish', 'bee', 'snail', 'caterpillar', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['rabbit', 'starfish'])
    expect(grid.base[0][0]!.faceUp).toEqual([true, true]) // rabbit stays face-up (immune), starfish still stacked
  })

  test('ignored if Starfish is the first card placed', () => {
    const { grid } = place('starfish', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['starfish'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
  })
})

describe('Swordfish — flipPreviousPlaced + flipNextRevealed (dual flip, two existing primitives)', () => {
  test('flips BOTH the previous placed card and the next revealed card', () => {
    const { grid, flipNotes } = place('bee', 'swordfish', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.base[0][0]!.faceUp).toEqual([false]) // flipped by swordfish (previous)
    expect(grid.base[0][1]!.cards).toEqual(['swordfish'])
    expect(grid.base[0][1]!.faceUp).toEqual([true]) // swordfish itself unaffected
    expect(grid.base[0][2]!.cards).toEqual(['snail'])
    expect(grid.base[0][2]!.faceUp).toEqual([false]) // flipped by swordfish (next revealed)
    // snail's own onPlace (none) is irrelevant; it lands in a normal slot, just face-down
    expect(grid.base[1][0]!.cards).toEqual(['caterpillar']) // unaffected, placed normally after
    // both flip effects fire from the same Swordfish placement, at different
    // points in the loop — two separate flipNotes lines, not a duplicate
    expect(flipNotes).toContain('Swordfish flips Bee face-down at row 0, col 0.')
    expect(flipNotes).toContain('Swordfish flips Snail face-down at row 0, col 2.')
  })

  test('as the first card placed: no previous card to flip, next-revealed flip still applies', () => {
    const { grid } = place('swordfish', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['swordfish'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
    expect(grid.base[0][1]!.cards).toEqual(['bee'])
    expect(grid.base[0][1]!.faceUp).toEqual([false]) // still flipped, despite no previous-placed target existing
  })
})

describe('Salamander — returnNextRevealedIfRankAtMost (deferred conditional RETURN)', () => {
  test('next revealed card at rank <= 1 is returned: never placed on its first reveal, redrawn LAST (bottom-of-deck reading)', () => {
    // salamander(rank1) -> base[0][0]. Next revealed is bee (season1
    // starter, rank 0) — rank 0 <= 1, so it's returned to the BOTTOM of
    // the deck instead of being placed (see flip.ts's
    // returnCardToDeckBottom), so every other undrawn card fills its slot
    // first, and bee is only redrawn once nothing else is left.
    const { grid, remainingDeck } = place('salamander', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['salamander'])
    expect(grid.base[0][1]!.cards).toEqual(['snail'])
    expect(grid.base[0][2]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['dragonfly'])
    expect(grid.base[1][2]!.cards).toEqual(['bee']) // redrawn last, after everything else
    expect(remainingDeck).toHaveLength(0)
  })

  test('next revealed card above rank 1 is placed normally, no return', () => {
    // salamander(rank1) -> base[0][0]. Next revealed is snail (rank 0)...
    // use a card with rank > 1 instead: groundhog (rank 2).
    const { grid, remainingDeck } = place('salamander', 'groundhog', 'bee', 'snail', 'caterpillar', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['salamander'])
    expect(grid.base[0][1]!.cards).toEqual(['groundhog']) // placed normally, not returned
    expect(remainingDeck).toHaveLength(0)
  })

  test('final-slot edge case: Salamander as the 6th card does not trigger a 7th reveal', () => {
    const { grid, remainingDeck } = place('bee', 'snail', 'caterpillar', 'skunk', 'dragonfly', 'salamander', 'bee')
    expect(remainingDeck).toEqual(['bee']) // the 7th card is never drawn, pending discarded unapplied
    expect(grid.base[1][2]!.cards).toEqual(['salamander'])
  })
})

describe('Coyote — returnPreviousPlacedOrStack (GRID-return with immune fallback to stack)', () => {
  test('returns the previous placed card and takes its slot; the returned card is redrawn LAST (bottom-of-deck reading)', () => {
    const { grid, remainingDeck } = place('bee', 'coyote', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['coyote']) // took bee's slot
    expect(grid.base[0][1]!.cards).toEqual(['snail'])
    expect(grid.base[0][2]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['dragonfly'])
    expect(grid.base[1][2]!.cards).toEqual(['bee']) // bee redrawn last, after everything else
    expect(remainingDeck).toHaveLength(0)
  })

  test('ignored if Coyote is the first card placed', () => {
    const { grid } = place('coyote', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['coyote'])
  })

  test('previous placed card immune to return (another Coyote): stacks instead of returning', () => {
    const { grid, remainingDeck } = place('coyote', 'coyote', 'bee', 'snail', 'caterpillar', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['coyote', 'coyote']) // second coyote stacked, first NOT returned
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(5) // one stacked slot + 4 singles
    expect(remainingDeck).toHaveLength(0)
  })

  // §7 item 3b, second detail: "If a player's deck has no cards when a card
  // is returned, the returned card becomes their deck and they continue
  // their Flip phase if any empty slots remain in their grid." Coyote is
  // deliberately the LAST of exactly 6 cards in the deck, so by the time it
  // resolves its return, `remainingDeck` has already gone to zero via the
  // shift() that drew Coyote itself — the Return then pushes skunk (the
  // previous placed card) back on, taking the deck from 0 to 1, and the
  // flip loop's own `remainingDeck.length > 0` check is what "continues the
  // Flip phase" resolves to, with no special-case code anywhere. Traced:
  // bee/snail/caterpillar/dragonfly/skunk fill 5 of 6 base slots in order;
  // coyote (6th, last card in deck) returns skunk (the previous placed
  // card, at base[1][1]) and takes its slot — base[1][2] is still empty and
  // the deck is now [skunk] (length 1), so the loop keeps going and redraws
  // skunk into the last open slot, completing the grid.
  test('Return while the deck is empty: the returned card becomes the deck, and the Flip phase continues to fill the grid', () => {
    const { grid, remainingDeck } = place('bee', 'snail', 'caterpillar', 'dragonfly', 'skunk', 'coyote')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.base[0][1]!.cards).toEqual(['snail'])
    expect(grid.base[0][2]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][0]!.cards).toEqual(['dragonfly'])
    expect(grid.base[1][1]!.cards).toEqual(['coyote']) // took skunk's slot
    expect(grid.base[1][2]!.cards).toEqual(['skunk']) // skunk redrawn from the 1-card deck it became, filling the last slot
    expect(isFull(grid)).toBe(true)
    expect(remainingDeck).toHaveLength(0)
  })
})

describe('Crab — returnSelfIfMiddleColumn (self-RETURN)', () => {
  test('landing outside the middle column: no effect', () => {
    const { grid } = place('bee', 'snail', 'crab', 'caterpillar', 'skunk', 'dragonfly')
    // crab is the 3rd card -> base[0][2] (col 2, not middle) — stays put
    expect(grid.base[0][2]!.cards).toEqual(['crab'])
  })

  test('landing in the middle column: returns itself, is NOT redrawn immediately (bottom-of-deck reading), and lands safely once its turn comes back around', () => {
    // bee -> base[0][0]. crab -> base[0][1] (col 1, middle) -> returns
    // itself to the BOTTOM of the deck, vacating base[0][1]. Unlike the
    // rejected top-of-deck reading, crab is NOT immediately next up — snail
    // fills the vacated col 1 slot instead. crab is only redrawn once
    // every other card has come up, and by then col 1 (and the rest of row
    // 0) is already full, so it lands in row 1 without retriggering.
    const { grid, remainingDeck } = place('bee', 'crab', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.base[0][1]!.cards).toEqual(['snail']) // backfilled crab's vacated (middle) slot
    expect(grid.base[0][2]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['dragonfly']) // also middle column, but has no self-return effect
    expect(grid.base[1][2]!.cards).toEqual(['crab']) // redrawn last, lands in col 2 — no retrigger
    expect(remainingDeck).toHaveLength(0)
  })

  test('CONFIRMED STALL CONDITION, scoped to an all-Crab deck as the FAQ describes ("all-crab-deck stall condition"): every redraw into the middle column is ALSO a Crab, so the return never stops cycling', () => {
    // One filler (bee) takes col 0; every remaining card is a Crab. The
    // first Crab lands in col 1 (middle) and returns itself to the bottom
    // of the deck — but because EVERY other remaining card is also a Crab,
    // the next card up is another Crab, which lands right back in the same
    // now-empty col 1 slot and returns itself too, forever. This is the
    // narrower, FAQ-matching stall the bottom-of-deck reading predicts (as
    // opposed to the rejected top-of-deck reading, under which even a
    // single Crab in a mixed deck would stall — see returnCardToDeckBottom
    // in flip.ts). flipDeck's MAX_FLIP_ITERATIONS guard converts the hang
    // into a fast, diagnosable throw.
    expect(() => place('bee', 'crab', 'crab', 'crab', 'crab', 'crab')).toThrow(/exceeded \d+ iterations/)
  })
})

describe('Zebra — returnLowestRankOrStack (GRID-return with rank-based search targeting)', () => {
  test('returns the lowest-rank face-up card in the grid and takes its slot; the returned card is redrawn LAST (bottom-of-deck reading)', () => {
    // bee (season1, rank 0) and goat (season1, rank 6) are placed first;
    // zebra's search finds bee (rank 0) as the lowest and returns it.
    const { grid, remainingDeck } = place('bee', 'goat', 'zebra', 'snail', 'caterpillar', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['zebra']) // took bee's slot
    expect(grid.base[0][1]!.cards).toEqual(['goat']) // untouched — higher rank, not the target
    expect(grid.base[0][2]!.cards).toEqual(['snail'])
    expect(grid.base[1][0]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][1]!.cards).toEqual(['skunk'])
    expect(grid.base[1][2]!.cards).toEqual(['bee']) // bee redrawn last, after everything else
    expect(remainingDeck).toHaveLength(0)
  })

  test('ignored if Zebra is the first card placed (no face-up card yet to target)', () => {
    const { grid } = place('zebra', 'bee', 'snail', 'caterpillar', 'skunk', 'dragonfly')
    expect(grid.base[0][0]!.cards).toEqual(['zebra'])
  })

  test('lowest-rank target immune to return (Coyote): stacks instead of returning', () => {
    // coyote (rank 14, immune: ['return']) is the only face-up card when
    // zebra resolves its search — it's the (only, hence lowest-rank)
    // target, but it's immune, so zebra stacks on it instead.
    const { grid, remainingDeck } = place('coyote', 'zebra', 'bee', 'snail', 'caterpillar', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['coyote', 'zebra']) // stacked, coyote NOT returned
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(5) // one stacked slot + 4 singles
    expect(remainingDeck).toHaveLength(0)
  })
})

describe('Gorilla — moveNextRevealedToExtraRowIfUpperRow (Grid.extraRows multi-row support, this pass)', () => {
  test('placed in the upper row: stays in its own base slot, and the NEXT revealed card is diverted into the extra row above Gorilla\'s column instead of taking a base slot', () => {
    // bee -> base[0][0]. gorilla -> base[0][1] (upper row) -> stays put,
    // sets a pending "next revealed card goes to extraRows above col 1".
    // snail (next revealed) is diverted to extraRows[0][1] instead of
    // base[0][2]. dragonfly then backfills base[0][2].
    const { grid, remainingDeck } = place('bee', 'gorilla', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.base[0][1]!.cards).toEqual(['gorilla']) // Gorilla itself does NOT relocate — unlike Monkey
    expect(grid.extraRows[0][1]!.cards).toEqual(['snail']) // diverted, not a base slot
    expect(grid.base[0][2]!.cards).toEqual(['dragonfly']) // backfilled the slot snail would otherwise have taken
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['caterpillar'])
    expect(remainingDeck).toHaveLength(0)
  })

  test('placed in the lower row: no diversion, next card places normally', () => {
    const { grid } = place('bee', 'snail', 'dragonfly', 'gorilla', 'skunk', 'caterpillar')
    // gorilla is the 4th card -> base[1][0] (lower row) -> condition fails
    expect(grid.base[1][0]!.cards).toEqual(['gorilla'])
    expect(grid.base[1][1]!.cards).toEqual(['skunk']) // placed normally, not diverted
    expect(grid.extraRows).toHaveLength(0)
  })

  test('the diverted card\'s own onPlace ability still resolves (not suppressed, unlike Eagle\'s flip target)', () => {
    // gorilla -> base[0][0] (upper row) -> sets pending for col 0. elephant
    // (next revealed) is diverted to extraRows[0][0] instead of base[0][1].
    // Elephant's own flipPreviousPlaced ability should still fire, flipping
    // the previous placed card — gorilla itself (not immune to flip).
    const { grid } = place('gorilla', 'elephant', 'bee', 'snail', 'dragonfly', 'skunk')
    expect(grid.extraRows[0][0]!.cards).toEqual(['elephant'])
    expect(grid.base[0][0]!.cards).toEqual(['gorilla'])
    expect(grid.base[0][0]!.faceUp).toEqual([false]) // flipped by the diverted elephant's own ability
  })

  // ROW-ORDERING READING (task §2 / grid.ts's extraRowSlotAbove comment):
  // "if a card is already above the gorilla/monkey, the new row forms above
  // THAT CARD instead" is read as SAME COLUMN, stacking vertically — not a
  // different column in the same row. This is the concrete case the task
  // names directly: a second Gorilla trigger targeting a column that
  // already has an extraRows[0] occupant goes to extraRows[1] at that SAME
  // column, not to extraRows[0] at a different column. Flagged as an
  // implemented-but-unconfirmed reading, same as Return's destination was
  // before its confirmation.
  test('the shared extraRowSlotAbove helper stacks a second row in the SAME column, rather than using a different column of extraRows[0] (grid-level primitive, exercised directly)', () => {
    // Both Monkey and Gorilla route through this one function (grid.ts) for
    // "find where a relocated/diverted card belongs" — asserting it
    // directly here covers the row-ordering reading for both cards at once,
    // independent of either card's own placement plumbing.
    const grid = emptyGrid()
    const first = extraRowSlotAbove(grid, 1)
    expect(first).toEqual({ section: 'extra', row: 0, col: 1 })
    placeCardFaceUp(grid, first, 'snail') // occupy it (and grow extraRows), as a Gorilla diversion or Monkey relocation would
    const second = extraRowSlotAbove(grid, 1)
    expect(second).toEqual({ section: 'extra', row: 1, col: 1 }) // stacks in the SAME column, not a different column of row 0
  })

  test('an all-Gorilla deck completes normally without stalling — Gorilla, unlike Monkey, never vacates its own base slot, so it cannot reopen the same slot forever', () => {
    // Traced by hand: gorilla1 -> base[0][0] (sets pending col 0). gorilla2
    // -> diverted to extraRows[0][0] (extra section -> its own upper-row
    // condition can't fire -> no new pending). gorilla3 -> base[0][1] (next
    // empty base slot; sets pending col 1). gorilla4 -> diverted to
    // extraRows[0][1]. gorilla5 -> base[0][2] (sets pending col 2).
    // gorilla6 -> diverted to extraRows[0][2]. Base row 0 now full (3
    // gorillas); remaining gorillas fall to the lower row, which has no
    // effect, and fill normally. This terminates in a bounded number of
    // iterations (9, for a 6-base-slot grid with 3 diversions) — nothing
    // like the ever-taller unbounded growth a self-relocating card (Monkey)
    // can cause. See flip-effects.test.ts's Monkey stall test for the
    // genuine unbounded case this refactor's MAX_FLIP_ITERATIONS guard
    // exists for — Gorilla, contrary to this task's initial premise, turns
    // out not to be able to reproduce it (see this pass's report).
    const ids = Array.from({ length: 9 }, () => 'gorilla')
    const { grid, remainingDeck } = place(...ids)
    expect(isFull(grid)).toBe(true)
    expect(remainingDeck).toHaveLength(0)
  })
})

describe('Goat regression — inUpperRow must stay keyed to the grid BASE upper row, never an extra row', () => {
  test('scores its +3 bonus for a plain base-row-0 placement (evaluateBonus previously had no handler for inUpperRow at all)', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'goat')
    const breakdown = scoreGrid(grid, cards)
    const goatLine = breakdown.lines.find((l) => l.cardId === 'goat')!
    expect(goatLine.needsRuling).toBeUndefined()
    expect(goatLine.total).toBe(1 + 3) // base 1 + upper-row bonus 3
  })

  test('a base-row-0 Goat still scores its bonus with an extra row present above it (Season 2 FAQ: "if a monkey creates a new row above the upper row, the goat\'s ability still activates")', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'goat')
    // extraRows[0] sits ABOVE base row 0 — a Monkey/Gorilla-created row —
    // and must not be confused with, or disable, Goat's base-row-0 check.
    grid.extraRows[0] = [null, { cards: ['bee'], faceUp: [true] }, null]
    const breakdown = scoreGrid(grid, cards)
    const goatLine = breakdown.lines.find((l) => l.cardId === 'goat')!
    expect(goatLine.needsRuling).toBeUndefined()
    expect(goatLine.total).toBe(1 + 3) // still gets the upper-row bonus
  })

  test('a lower-row Goat does NOT get the upper-row bonus, extra row or not', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'goat')
    const breakdown = scoreGrid(grid, cards)
    const goatLine = breakdown.lines.find((l) => l.cardId === 'goat')!
    expect(goatLine.total).toBe(1) // base only, no bonus
  })

  test('a base-row-0 Goat still scores its bonus with TWO stacked extra rows present above it (extends the single-extra-row case above for the new multi-row model)', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'goat')
    grid.extraRows[0] = [null, { cards: ['bee'], faceUp: [true] }, null]
    grid.extraRows[1] = [null, { cards: ['snail'], faceUp: [true] }, null] // a SECOND extra row, stacked above the first
    const breakdown = scoreGrid(grid, cards)
    const goatLine = breakdown.lines.find((l) => l.cardId === 'goat')!
    expect(goatLine.needsRuling).toBeUndefined()
    expect(goatLine.total).toBe(1 + 3) // still gets the upper-row bonus — 'base' row 0 is unaffected by however many extra rows stack above it
  })

  test('a Goat placed directly INTO an extra row (hypothetical — no card does this yet) does NOT get the upper-row bonus, exercised through the real evaluateBonus handler', () => {
    // No card in the current table relocates something INTO an extra row
    // that then gets scored there other than via a base-row-0 placement, so
    // this constructs the grid state directly rather than via a real
    // card's placement effect — but it runs through score.ts's ACTUAL
    // 'inUpperRow' handler (via scoreGrid/evaluateBonus), not a
    // reimplementation of the condition. This is the regression the
    // tautological version of this test (an earlier draft that only
    // asserted `pos.section === 'base'` against itself) would have missed:
    // it would still have passed even if score.ts's own guard were deleted.
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'extra', row: 0, col: 1 }, 'goat')
    const breakdown = scoreGrid(grid, cards)
    const goatLine = breakdown.lines.find((l) => l.cardId === 'goat')!
    expect(goatLine.total).toBe(1) // base fame only — no upper-row bonus from an extra-row position
  })
})

describe('Face-down cards in an extra row resolve nothing — the general "all cards only resolve if face up" rule (user ruling, 2026-08-16), re-audited for the multi-row grid', () => {
  test('a face-down card in extraRows contributes no fame, no Dragonfly unique-adjacent-name bonus, and no Bear face-up-count', () => {
    const grid = emptyGrid()
    // dragonfly sits at base[0][0], adjacent (via extraRows[0][0]) ONLY to a
    // face-down card — no other face-up neighbour, so any nonzero bonus
    // would have to come from the face-down card. bear sits at base[1][2],
    // NOT adjacent to dragonfly, so it only interacts via its own
    // grid-wide face-up-card count.
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dragonfly')
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'bear')
    grid.extraRows[0] = [{ cards: ['snail'], faceUp: [false] }, null, null] // FACE DOWN, above dragonfly's column

    const breakdown = scoreGrid(grid, cards)

    const snailLine = breakdown.lines.find((l) => l.cardId === 'snail')
    expect(snailLine).toBeUndefined() // face-down cards get no fame line at all — scoreGrid only walks face-up cards (§3.3a)

    const dragonflyLine = breakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(dragonflyLine.total).toBe(0) // no unique-adjacent-name bonus — the face-down snail doesn't count

    const bearLine = breakdown.lines.find((l) => l.cardId === 'bear')!
    // Bear: "+1 per face-up card in your grid, including itself." Only
    // bear + dragonfly are face-up (2 cards) — the face-down snail must not
    // be counted, even though it occupies a slot in the grid.
    expect(bearLine.total).toBe(1 + 2 * 1) // Bear's base fame (1, per season1.ts) + 1 per face-up card, counting itself: bear + dragonfly = 2

    // Control: flip the SAME card face-up (nothing else about the grid
    // changes) and confirm dragonfly's bonus now DOES activate. Without
    // this, the test above would pass equally if base<->extra adjacency
    // were entirely broken (not just the face-down exclusion) — this is
    // what actually proves the face-down exclusion, rather than a broken
    // adjacency link, is what's producing the 0 above.
    grid.extraRows[0][0]!.faceUp[0] = true
    const flippedBreakdown = scoreGrid(grid, cards)
    const flippedDragonfly = flippedBreakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(flippedDragonfly.total).toBe(1) // now counts Snail as its one unique adjacent name
  })

  test('the extra-row adjacency chain is vertical, not mutual across every row: extraRows[1] is adjacent to extraRows[0] in the same column, NOT directly to base row 0', () => {
    // dragonfly at extraRows[1][1], bee at extraRows[0][1] (directly
    // below), snail at base[0][1] (two rows below dragonfly). Dragonfly
    // should see Bee (its one true neighbour) but NOT Snail — if the chain
    // were broken into "every extra row adjacent to base row 0 directly,"
    // or "every extra row mutually adjacent to every other," this would
    // score 2 instead of 1.
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'snail')
    placeCardFaceUp(grid, { section: 'extra', row: 0, col: 1 }, 'bee')
    placeCardFaceUp(grid, { section: 'extra', row: 1, col: 1 }, 'dragonfly')

    const breakdown = scoreGrid(grid, cards)
    const dragonflyLine = breakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(dragonflyLine.total).toBe(1) // Bee only — not Snail two rows down
  })
})

describe('Platypus — fame-audit finding: fameUnencodable (not just unencodable) is required', () => {
  test('scores as needsRuling rather than crashing scoreGrid, and does not blank the rest of the grid', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'platypus')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
    expect(() => scoreGrid(grid, cards)).not.toThrow()
    const breakdown = scoreGrid(grid, cards)
    const platypusLine = breakdown.lines.find((l) => l.cardId === 'platypus')!
    expect(platypusLine.needsRuling).toBe(true)
    expect(platypusLine.total).toBe(0)
    const beeLine = breakdown.lines.find((l) => l.cardId === 'bee')!
    expect(beeLine.needsRuling).toBeUndefined()
    expect(beeLine.total).toBe(1) // the rest of the grid still scores normally
  })
})

describe('Mongoose — dismissOwnDeckBottomAndDrawToonDeckTop (Group 3, fully encoded — see season2.ts)', () => {
  test('main line: dismisses the bottom of its own deck, and adds the toon deck top to the TOP of its own deck', () => {
    // deck order: mongoose, mosquito, grasshopper, ladybug, spider — mongoose
    // drawn first (base[0][0]); remainingDeck afterward is
    // [mosquito, grasshopper, ladybug, spider], whose BOTTOM is 'spider'.
    // The toon-deck card added to the TOP of the deck becomes the very NEXT
    // card the (still-running) Flip loop draws and places — it does not
    // just sit in remainingDeck, since the grid isn't full yet — so it ends
    // up placed immediately to Mongoose's right (base[0][1]).
    const deck = buildExplicitDeck(['mongoose', 'mosquito', 'grasshopper', 'ladybug', 'spider'], cards)
    const toonDeck = buildExplicitDeck(['mole'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual(['spider']) // bottom of its own deck, not immune
    expect(result.grid.base[0][1]!.cards).toEqual(['mole']) // drawn onto the deck top, then immediately placed next
    expect(result.toonDeck).toEqual([])
  })

  test('immune bottom-of-deck card: skips the dismissal but still draws unconditionally', () => {
    // 'cat' (season1, immune: ['dismiss']) as the bottom of the deck.
    const deck = buildExplicitDeck(['mongoose', 'mosquito', 'grasshopper', 'cat'], cards)
    const toonDeck = buildExplicitDeck(['mole'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual([]) // cat, immune, was NOT dismissed
    expect(result.grid.base[0][1]!.cards).toEqual(['mole']) // draw still happens, placed next
    const placedIds = result.grid.base.flat().filter((s) => s !== null).flatMap((s) => s!.cards)
    expect(placedIds).toContain('cat') // cat is still in play, untouched, just placed onto the grid like any other card
  })

  test('empty player deck after Mongoose is drawn: still draws unconditionally, nothing to dismiss', () => {
    const deck = buildExplicitDeck(['mongoose'], cards)
    const toonDeck = buildExplicitDeck(['mole'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual([])
    expect(result.grid.base[0][1]!.cards).toEqual(['mole']) // drawn onto the deck top, then immediately placed next
    expect(result.remainingDeck).toEqual([])
  })
})

describe('toonDeckDepleted regression: a Flip-phase-only draw (Snake/Mongoose) drains the toon deck just like a Market refill does', () => {
  test('Mongoose draining the last toon deck card sets toonDeckEmptiedDuringFlip', () => {
    const deck = buildExplicitDeck(['mongoose', 'mosquito'], cards)
    const toonDeck = buildExplicitDeck(['mole'], cards) // exactly one card — Mongoose's draw empties it
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.toonDeck).toEqual([])
    expect(result.toonDeckEmptiedDuringFlip).toBe(true)
  })

  test('a non-empty toon deck after the draw does NOT set the flag', () => {
    const deck = buildExplicitDeck(['mongoose', 'mosquito'], cards)
    const toonDeck = buildExplicitDeck(['mole', 'hen'], cards) // two cards — one left after the draw
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.toonDeck).toEqual(['hen'])
    expect(result.toonDeckEmptiedDuringFlip).toBe(false)
  })
})

describe('Mongoose drawing a stackOnPreviousPlaced card (Panther/Turkey) — reported playtest confusion', () => {
  test('Panther drawn by Mongoose stacks onto Mongoose\'s OWN slot, not the next empty one, and both events are explained in flipNotes', () => {
    // Same shape as the main-line test above, but the toon deck's top card
    // is Panther (stackOnPreviousPlaced) instead of a plain card like Mole.
    // determineTarget redirects Panther's placement onto the previously
    // placed card's slot — which is Mongoose's own slot, since Mongoose was
    // the last card placed before Panther is drawn/placed — so base[0][0]
    // ends up holding BOTH cards, and no card lands at base[0][1] from this
    // draw. This is the exact "same position, different card, no
    // explanation" confusion from the playtest log.
    const deck = buildExplicitDeck(['mongoose', 'mosquito', 'grasshopper', 'ladybug', 'spider'], cards)
    const toonDeck = buildExplicitDeck(['panther'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })

    expect(result.grid.base[0][0]!.cards).toEqual(['mongoose', 'panther']) // stacked, not base[0][1]
    expect(result.dismissed).toEqual(['spider'])

    expect(result.flipNotes).toContain('Mongoose dismissed Spider from the bottom of your deck.')
    expect(result.flipNotes).toContain(
      "Mongoose drew Panther from the toon deck onto the top of your deck — it'll be the next card revealed and placed this Flip if a slot remains.",
    )
    expect(result.flipNotes).toContain('Panther stacks on top of Mongoose at row 0, col 0 (stacks on the previously placed card).')
  })
})
