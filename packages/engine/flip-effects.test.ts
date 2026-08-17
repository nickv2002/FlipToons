// Tests for the onPlace effect vocabulary added alongside the 13
// previously-`unencodable` Season 1 market cards (see cards/season1.ts and
// flip.ts). Uses buildExplicitDeck / flipDeck directly — none of these
// cards are starting cards, so buildSeason1StartingDeck() can never
// exercise them (see setup.ts's buildExplicitDeck comment).

import { describe, expect, test } from 'bun:test'
import { flipDeck } from './flip'
import { getSlot } from './grid'
import { buildExplicitDeck, cardsById } from './setup'

const cards = cardsById()

function place(...ids: string[]) {
  const deck = buildExplicitDeck(ids, cards)
  return flipDeck(deck, cards, { toonDeck: [], dismissed: [] })
}

describe('Ostrich — stackNextRevealed (the deferred "next revealed card" primitive)', () => {
  test('the next revealed card stacks on the Ostrich instead of taking a new slot, and its own ability still resolves', () => {
    // ostrich, bee, snail, dragonfly, skunk, caterpillar — 6 cards, but bee
    // stacks onto ostrich's slot, so only 5 base slots get used and the
    // deck (if it had a 6th) would keep flipping. Here exactly 6 cards for
    // 5 slots + 1 stacked, so the deck should NOT fully drain into 6
    // separate slots — one slot holds 2 cards.
    const { grid, remainingDeck } = place('ostrich', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(remainingDeck).toHaveLength(0)
    const ostrichSlot = grid.base[0][0]!
    expect(ostrichSlot.cards).toEqual(['ostrich', 'bee'])
    expect(ostrichSlot.faceUp).toEqual([true, true])
    // bee's own onPlace (none) is irrelevant, but confirm it's face-up and
    // scored — i.e. its ability/fame is NOT suppressed the way Eagle's
    // flip-target is.
    // 5 more base slots get filled by the remaining 4 cards... wait: with
    // one slot consumed by the ostrich+bee stack, only 5 base slots exist
    // for {snail, dragonfly, skunk, caterpillar} = 4 cards, leaving one
    // base slot empty (deck exhausted).
    const filledBaseCount = grid.base.flat().filter((s) => s !== null).length
    expect(filledBaseCount).toBe(5) // ostrich+bee's slot, plus 4 more
  })

  test('final-slot edge case: Ostrich as the 6th card does not trigger a 7th reveal', () => {
    const { grid, remainingDeck } = place('bee', 'snail', 'dragonfly', 'skunk', 'caterpillar', 'ostrich', 'bee')
    expect(remainingDeck).toEqual(['bee']) // the 7th card is never drawn
    expect(grid.base[1][2]!.cards).toEqual(['ostrich'])
  })
})

describe('Eagle — flipNextRevealed', () => {
  test('flips the next revealed card face-down, and that card\'s own onPlace ability does NOT activate', () => {
    // eagle, then turkey (which would normally stack on the previous
    // placed card = eagle, via stackOnPreviousPlaced) — if turkey's ability
    // is suppressed by being flipped, it must land in a normal empty slot
    // instead, face-down.
    const { grid } = place('eagle', 'turkey', 'bee', 'snail', 'dragonfly', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['eagle'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
    // turkey landed in the NEXT empty slot (not stacked on eagle), face-down
    expect(grid.base[0][1]!.cards).toEqual(['turkey'])
    expect(grid.base[0][1]!.faceUp).toEqual([false])
  })

  test('immune target (Rabbit): Eagle has no effect, Rabbit resolves its own placement normally', () => {
    // eagle, then rabbit (immune: ['flip']) with no rabbit/face-down card
    // yet on the grid, so rabbit's own onPlace falls back to the next empty
    // slot, face-up, ability fully active (though rabbit's onPlace has no
    // further effect once placed normally, this confirms it wasn't flipped).
    const { grid } = place('eagle', 'rabbit', 'bee', 'snail', 'dragonfly', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['eagle'])
    expect(grid.base[0][1]!.cards).toEqual(['rabbit'])
    expect(grid.base[0][1]!.faceUp).toEqual([true]) // NOT flipped — Rabbit is immune
  })

  test('final-slot edge case (UNCONFIRMED reading, see season1.ts): Eagle as the 6th card does not trigger a 7th reveal', () => {
    const { grid, remainingDeck } = place('bee', 'snail', 'dragonfly', 'skunk', 'caterpillar', 'eagle', 'turkey')
    expect(remainingDeck).toEqual(['turkey']) // never drawn
    expect(grid.base[1][2]!.cards).toEqual(['eagle'])
    expect(grid.base[1][2]!.faceUp).toEqual([true]) // Eagle itself was placed normally, not flipped
  })
})

describe('Rabbit — stackOnFirstMatchOrFaceDown', () => {
  test('stacks on the first face-up Rabbit already in the grid, in reading order', () => {
    const { grid, remainingDeck } = place('rabbit', 'bee', 'snail', 'rabbit', 'dragonfly', 'skunk', 'caterpillar')
    // Final state: the 1st rabbit landed at base[0][0] (no earlier
    // rabbit/face-down existed yet), and the 2nd rabbit's search then found
    // THAT rabbit and stacked on it instead of taking a fresh slot.
    expect(grid.base[0][0]!.cards).toEqual(['rabbit', 'rabbit'])
    // remaining 5 cards {bee, snail, dragonfly, skunk, caterpillar} fill the
    // other 5 base slots exactly
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(6) // one stacked slot + 5 singles = 6 occupied base positions
    expect(remainingDeck).toHaveLength(0)
  })

  test('stacks on the first face-down card if no face-up Rabbit exists yet', () => {
    // eagle flips the next card (bee) face-down; rabbit's search then
    // finds that face-down bee (reading order hits it before any empty
    // slot search would matter) and stacks on it rather than taking a
    // fresh slot.
    const { grid } = place('eagle', 'bee', 'rabbit', 'snail', 'dragonfly', 'skunk')
    expect(grid.base[0][0]!.cards).toEqual(['eagle'])
    // rabbit stacked on the face-down bee (flipped by eagle), not a fresh slot
    expect(grid.base[0][1]!.cards).toEqual(['bee', 'rabbit'])
    expect(grid.base[0][1]!.faceUp).toEqual([false, true])
  })

  test('falls back to the next empty base slot when no Rabbit or face-down card exists (unconfirmed assumption)', () => {
    const { grid } = place('rabbit', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    // no earlier rabbit or face-down card exists when rabbit is placed
    // first, so it just takes base[0][0] normally.
    expect(grid.base[0][0]!.cards).toEqual(['rabbit'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
  })
})

describe('Monkey — moveToExtraRowIfUpperRow', () => {
  test('placed in the upper row: relocates to extraRow at the same column, vacating its base slot for the next card', () => {
    const { grid } = place('bee', 'monkey', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    // bee takes base[0][0]. monkey would take base[0][1] (upper row) -> relocates to extraRow[1].
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.extraRows[0][1]!.cards).toEqual(['monkey'])
    // the NEXT revealed card (snail) fills the vacated base[0][1] slot
    expect(grid.base[0][1]!.cards).toEqual(['snail'])
    // remaining cards fill the rest in reading order
    expect(grid.base[0][2]!.cards).toEqual(['dragonfly'])
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['caterpillar'])
  })

  test('placed in the lower row: no relocation, stays in place', () => {
    const { grid } = place('bee', 'snail', 'dragonfly', 'monkey', 'skunk', 'caterpillar')
    // monkey is the 4th card -> base[1][0] (lower row)
    expect(grid.base[1][0]!.cards).toEqual(['monkey'])
    expect(grid.extraRows.every((row) => row.every((s) => s === null))).toBe(true)
  })

  test('a SECOND Monkey landing in the same upper-row column as a first stacks a second extra row above it, rather than colliding or using a different column (row-ordering reading — see grid.ts\'s extraRowSlotAbove)', () => {
    // bee -> base[0][0]. monkey1 -> base[0][1] (upper row, col 1) ->
    // relocates to extraRows[0][1], vacating base[0][1]. monkey2 -> the
    // vacated base[0][1] is next-empty again -> also upper row, col 1 ->
    // relocates to extraRows[1][1] (extraRows[0][1] is now occupied by
    // monkey1, so the helper stacks a SECOND row rather than looking
    // elsewhere). snail finally backfills base[0][1] for good. The rest
    // fill normally (deliberately not deck-legal — see this file's header).
    const { grid, remainingDeck } = place('bee', 'monkey', 'monkey', 'snail', 'dragonfly', 'skunk', 'caterpillar', 'dog')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.extraRows[0][1]!.cards).toEqual(['monkey']) // first monkey
    expect(grid.extraRows[1][1]!.cards).toEqual(['monkey']) // second monkey, stacked directly above the first
    expect(grid.base[0][1]!.cards).toEqual(['snail']) // finally backfilled, third card revealed after the second monkey
    expect(grid.base[0][2]!.cards).toEqual(['dragonfly'])
    expect(grid.base[1][0]!.cards).toEqual(['skunk'])
    expect(grid.base[1][1]!.cards).toEqual(['caterpillar'])
    expect(grid.base[1][2]!.cards).toEqual(['dog'])
    expect(remainingDeck).toHaveLength(0)
  })

  test('a very large all-Monkey deck hits MAX_FLIP_ITERATIONS — Monkey vacates its own base slot every time, so the same slot reopens for as long as monkeys keep coming', () => {
    // Every monkey lands in base[0][0] (leftmost-topmost empty slot, always
    // reopened by the previous monkey's own relocation), stacking a new
    // extraRows row each time — grid.base[0][0] never permanently fills as
    // long as the deck keeps supplying monkeys. UNLIKE Return-based cards
    // (Crab), relocation does NOT put the card back in remainingDeck, so
    // this only actually hits the iteration cap (rather than legitimately
    // running out of deck first, per §3.5's "place as many as possible")
    // when the deck has more monkeys than MAX_FLIP_ITERATIONS — a
    // synthetic, not realistically reachable, quantity (Monkey is
    // copies: 2 in season1.ts). This demonstrates the guard exists and
    // works for this shape too, without claiming it's reachable in a real
    // game the way the Crab stall is. This is also the case this task's
    // Gorilla-stall concern actually describes; see this pass's report for
    // why Gorilla itself (which does NOT vacate its own slot) turns out
    // unable to reproduce it at all, bounded or not.
    const ids = Array.from({ length: 600 }, () => 'monkey')
    expect(() => place(...ids)).toThrow(/exceeded \d+ iterations/)
  })
})

describe('Elephant — flipPreviousPlaced (LAST PLACED CARD by identity, surviving relocation)', () => {
  test('flips the immediately-previous placed card unless it is immune', () => {
    const { grid } = place('bee', 'elephant', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.cards).toEqual(['bee'])
    expect(grid.base[0][0]!.faceUp).toEqual([false]) // flipped by elephant
    expect(grid.base[0][1]!.cards).toEqual(['elephant'])
    expect(grid.base[0][1]!.faceUp).toEqual([true]) // elephant itself is unaffected
  })

  test('ignored if Elephant is the first card placed', () => {
    const { grid } = place('elephant', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.cards).toEqual(['elephant'])
    expect(grid.base[0][0]!.faceUp).toEqual([true])
    // no crash, and nothing else is retroactively flipped
    expect(grid.base[0][1]!.faceUp).toEqual([true])
  })

  test('does not flip an immune target (e.g. another Elephant, which is itself immune: flip)', () => {
    const { grid } = place('elephant', 'elephant', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.faceUp).toEqual([true]) // first elephant is immune to being flipped
    expect(grid.base[0][1]!.cards).toEqual(['elephant'])
  })

  test('targets the LAST PLACED CARD BY IDENTITY, even after it has relocated (Monkey -> extraRow)', () => {
    // bee, monkey (relocates to extraRow[1], vacating base[0][1]), then
    // elephant — the "last placed card" at the moment elephant resolves is
    // MONKEY (not whatever backfilled base[0][1] — snail, placed after
    // monkey but before elephant here... need monkey to be the IMMEDIATELY
    // preceding placement). Deck: bee, monkey, elephant.
    // Flip order: bee -> base[0][0]. monkey -> targets base[0][1] (upper
    // row) -> relocates to extraRow[1], vacating base[0][1]. elephant is
    // revealed next: it fills the vacated base[0][1] (nextEmptyBaseSlot
    // finds it), and its flipPreviousPlaced targets monkey — whose CURRENT
    // position is extraRow[1], not its original base[0][1].
    const { grid } = place('bee', 'monkey', 'elephant', 'snail', 'dragonfly', 'skunk')
    expect(grid.extraRows[0][1]!.cards).toEqual(['monkey'])
    expect(grid.extraRows[0][1]!.faceUp).toEqual([false]) // flipped by elephant, AT ITS RELOCATED POSITION
    expect(grid.base[0][1]!.cards).toEqual(['elephant']) // elephant backfilled monkey's vacated slot
    expect(grid.base[0][0]!.faceUp).toEqual([true]) // bee (elephant's actual "one before monkey") is untouched
  })
})

describe('Turkey — stackOnPreviousPlaced (same identity-tracking primitive as Elephant)', () => {
  test('stacks on the immediately-previous placed card', () => {
    const { grid, remainingDeck } = place('bee', 'turkey', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.cards).toEqual(['bee', 'turkey'])
    // only 5 base slots consumed by 6 cards (turkey stacked, not a new slot)
    const filled = grid.base.flat().filter((s) => s !== null)
    expect(filled).toHaveLength(5)
    expect(remainingDeck).toHaveLength(0)
  })

  test('ignored if Turkey is the first card placed', () => {
    const { grid } = place('turkey', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar')
    expect(grid.base[0][0]!.cards).toEqual(['turkey'])
  })

  test('targets the LAST PLACED CARD BY IDENTITY, even after it has relocated (Monkey -> extraRow)', () => {
    const { grid } = place('bee', 'monkey', 'turkey', 'snail', 'dragonfly', 'skunk')
    expect(grid.extraRows[0][1]!.cards).toEqual(['monkey', 'turkey']) // turkey stacked on monkey's RELOCATED position
    expect(grid.base[0][1]!.cards).toEqual(['snail']) // the slot monkey vacated, backfilled by the card after turkey
  })
})

describe('getSlot sanity (used throughout above)', () => {
  test('returns null for an unoccupied position', () => {
    const { grid } = place('bee')
    expect(getSlot(grid, { section: 'base', row: 1, col: 2 })).toBeNull()
  })
})

describe('Snake — dismissOwnDeckTopAndStackFromToonDeck (fully encoded, see season1.ts)', () => {
  test('main line: dismisses the top of its own deck, and stacks the toon deck top onto its own slot', () => {
    const deck = buildExplicitDeck(['snake', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar'], cards)
    const toonDeck = buildExplicitDeck(['ostrich'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual(['bee']) // top of its own deck, not immune
    expect(result.grid.base[0][0]!.cards).toEqual(['snake', 'ostrich'])
    expect(result.grid.base[0][0]!.faceUp).toEqual([true, true])
    expect(result.toonDeck).toEqual([])
    expect(result.toonDeckEmptiedDuringFlip).toBe(true)
    expect(result.pendingOnHireCardIds).toEqual([]) // ostrich has no onHire effects
  })

  test('a Peacock drawn from the toon deck is queued in pendingOnHireCardIds (its onHire bonus resolves later, in postFameHooks)', () => {
    const deck = buildExplicitDeck(['snake', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar'], cards)
    const toonDeck = buildExplicitDeck(['peacock'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.grid.base[0][0]!.cards).toEqual(['snake', 'peacock']) // still placed face-up in the grid normally
    expect(result.grid.base[0][0]!.faceUp).toEqual([true, true])
    expect(result.pendingOnHireCardIds).toEqual(['peacock'])
  })

  test('Rabbit and Turkey drawn from the toon deck are NOT queued — the FAQ\'s "stack it on the snake" for them is just confirming the normal placement above, no extra onHire effect', () => {
    const deckR = buildExplicitDeck(['snake', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar'], cards)
    const resultR = flipDeck(deckR, cards, { toonDeck: buildExplicitDeck(['rabbit'], cards), dismissed: [] })
    expect(resultR.pendingOnHireCardIds).toEqual([])

    const deckT = buildExplicitDeck(['snake', 'bee', 'snail', 'dragonfly', 'skunk', 'caterpillar'], cards)
    const resultT = flipDeck(deckT, cards, { toonDeck: buildExplicitDeck(['turkey'], cards), dismissed: [] })
    expect(resultT.pendingOnHireCardIds).toEqual([])
  })

  test('immune-card fallback: an immune top-of-deck card is placed to the right of Snake instead of dismissed', () => {
    const deck = buildExplicitDeck(['snake', 'cat', 'snail', 'dragonfly', 'skunk'], cards) // cat: immune: ['dismiss']
    const toonDeck = buildExplicitDeck(['sheep'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual([]) // cat was NOT dismissed
    expect(result.grid.base[0][1]!.cards).toEqual(['cat']) // placed to the right of snake (base[0][0]) instead
    expect(result.grid.base[0][0]!.cards).toEqual(['snake', 'sheep']) // toon-deck draw still stacks unconditionally
  })

  test('final-slot fallback: an immune top-of-deck card with no slot to Snake\'s right returns to the deck bottom', () => {
    // bee/snail/dragonfly/skunk/caterpillar (no onPlace effects) fill the
    // first 5 base slots in reading order; snake is drawn 6th, landing in
    // the grid's final slot (base[1][2]) with nothing to its right.
    const deck = buildExplicitDeck(['bee', 'snail', 'dragonfly', 'skunk', 'caterpillar', 'snake', 'cat'], cards)
    const toonDeck = buildExplicitDeck(['sheep'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.grid.base[1][2]!.cards).toEqual(['snake', 'sheep'])
    expect(result.dismissed).toEqual([]) // cat, immune, was not dismissed
    expect(result.remainingDeck).toContain('cat') // returned to the deck bottom, not placed anywhere (no slot to the right)
  })

  test('empty player deck: still draws unconditionally from the toon deck, even with nothing to dismiss', () => {
    const deck = buildExplicitDeck(['snake'], cards) // nothing left in the player's deck after snake is drawn
    const toonDeck = buildExplicitDeck(['sheep'], cards)
    const result = flipDeck(deck, cards, { toonDeck, dismissed: [] })
    expect(result.dismissed).toEqual([])
    expect(result.grid.base[0][0]!.cards).toEqual(['snake', 'sheep'])
    expect(result.toonDeck).toEqual([])
  })
})
