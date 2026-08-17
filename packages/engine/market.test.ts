import { describe, expect, test } from 'bun:test'
import type { Card, CardId } from './cards/types'
import { emptyMarket, hireCost, refillMarket, soloMarketDecay } from './market'

// A small synthetic card table — market.ts is season-agnostic and its
// correctness depends only on `rank`, not on any specific card's identity,
// so isolated tests build exactly the rank collisions they need rather than
// hunting for them in the real (mostly rank-unique) card table.
function card(id: CardId, rank: number): Card {
  return { id, name: id, season: 1, rank, copies: 99, fame: { base: 0 } }
}

const cardsById: Record<CardId, Card> = {
  r1: card('r1', 1),
  r2: card('r2', 2),
  r3a: card('r3a', 3),
  r3b: card('r3b', 3),
  r3c: card('r3c', 3),
  r5: card('r5', 5),
  r9: card('r9', 9),
  r1x: card('r1x', 1), // a second rank-1 card, distinct id, for the refill-then-resort test below
}

const PRICES = [3, 4, 7, 10, 15]

describe('refillMarket', () => {
  test('fills every empty slot from the toon deck, sorted by rank ascending', () => {
    const market = emptyMarket(PRICES)
    const toonDeck = ['r9', 'r1', 'r5', 'r2', 'r3a']
    const result = refillMarket(market, toonDeck, cardsById, 0)
    expect(result.market.slots).toEqual(['r1', 'r2', 'r3a', 'r5', 'r9'])
    expect(result.toonDeck).toEqual([])
    expect(result.short).toBe(false)
    expect(result.toonDeckEmpty).toBe(true)
  })

  test('refill-then-resort: buying a card can make a left-behind card MORE expensive', () => {
    // Market starts [r1(3), r2(4), r3a(7), r5(10), r9(15)]. r2 sits at
    // slot 1 (price 4).
    const market = emptyMarket(PRICES)
    const initial = refillMarket(market, ['r1', 'r2', 'r3a', 'r5', 'r9'], cardsById, 0)
    expect(initial.market.slots).toEqual(['r1', 'r2', 'r3a', 'r5', 'r9'])

    // Buy r3a (slot 2, price 7) — NOT the cheapest card, so r2 is
    // untouched by the removal itself. Refill draws r1x, which ties r1's
    // rank (1) and so sorts strictly ahead of r2 (rank 2). Re-sorting the
    // WHOLE row from scratch (not just filling the gap in place) means r2
    // is now the 3rd-cheapest card instead of the 2nd — it moves from
    // price 4 to price 7, MORE expensive, purely because of what refilled
    // elsewhere. This is the exact "refill, then re-sort" warning in §3.6.
    const afterBuy = {
      prices: initial.market.prices,
      slots: initial.market.slots.slice(),
      insertionSeq: initial.market.insertionSeq.slice(),
    }
    afterBuy.slots[2] = null
    afterBuy.insertionSeq[2] = null
    const refilled = refillMarket(afterBuy, ['r1x'], cardsById, initial.nextInsertionSeq)
    expect(refilled.market.slots).toEqual(['r1', 'r1x', 'r2', 'r5', 'r9'])
    expect(refilled.market.slots.indexOf('r2')).toBe(2) // was 1 (price 4), now 2 (price 7)
  })

  test('tiebreak: a newly-drawn card tied on rank lands in the more-right (pricier) slot, straddling a price boundary', () => {
    // r3a is already in the market (an earlier reveal, lower insertionSeq).
    // r3b arrives later at the SAME rank. Per §3.6, r3b must land to the
    // RIGHT of r3a — and since r3a occupies the slot priced 3 and r3b the
    // slot priced 4, this is exactly the "straddles a price boundary" case
    // called out in the task.
    const market = emptyMarket(PRICES)
    const incumbent = refillMarket(market, ['r3a'], cardsById, 0)
    // Manually seat r3a alone (simulating a market with one occupant and
    // four empty slots — refillMarket right-justifies short fills, so seat
    // it directly to test JUST the tie behavior deterministically).
    const seeded = {
      prices: PRICES,
      slots: [incumbent.market.slots[incumbent.market.slots.length - 1], null, null, null, null],
      insertionSeq: [incumbent.market.insertionSeq[incumbent.market.insertionSeq.length - 1], null, null, null, null],
    }
    expect(seeded.slots[0]).toBe('r3a')

    const result = refillMarket(seeded, ['r3b', 'r1', 'r5', 'r9'], cardsById, incumbent.nextInsertionSeq)
    // r1 (rank 1) -> slot 0; r3a (incumbent, lower seq) -> slot 1 (price 4);
    // r3b (arrival, higher seq, same rank as r3a) -> slot 2 (price 7) —
    // strictly to the right of the incumbent, never bumping it rightward.
    expect(result.market.slots).toEqual(['r1', 'r3a', 'r3b', 'r5', 'r9'])
  })

  test('tiebreak is deterministic across repeated runs (no reliance on Array.prototype.sort stability alone)', () => {
    const market = emptyMarket(PRICES)
    const toonDeck = ['r3a', 'r3b', 'r3c', 'r1', 'r5']
    const a = refillMarket(market, toonDeck, cardsById, 0)
    const b = refillMarket(market, toonDeck, cardsById, 0)
    expect(a.market.slots).toEqual(b.market.slots)
    expect(a.market.slots).toEqual(['r1', 'r3a', 'r3b', 'r3c', 'r5'])
  })

  test('a short refill (toon deck runs low but not out) is NOT toonDeckEmpty, and right-justifies remaining cards', () => {
    const market = emptyMarket(PRICES)
    const result = refillMarket(market, ['r1', 'r2'], cardsById, 0)
    expect(result.short).toBe(true)
    expect(result.toonDeckEmpty).toBe(true) // toon deck WAS fully consumed here — see the next test for short-but-not-empty
    expect(result.market.slots).toEqual([null, null, null, 'r1', 'r2']) // right-justified per §3.2.2's printed rule
  })

  test('a refill that leaves cards remaining in the toon deck is neither short nor toonDeckEmpty', () => {
    const market = emptyMarket(PRICES)
    const toonDeck = ['r1', 'r2', 'r3a', 'r5', 'r9', 'r3b', 'r3c']
    const result = refillMarket(market, toonDeck, cardsById, 0)
    expect(result.short).toBe(false)
    expect(result.toonDeckEmpty).toBe(false)
    expect(result.toonDeck).toEqual(['r3b', 'r3c'])
  })

  test('hireCost is purely positional: the price above the slot the card currently occupies', () => {
    const market = emptyMarket(PRICES)
    const result = refillMarket(market, ['r1', 'r2', 'r3a', 'r5', 'r9'], cardsById, 0)
    expect(hireCost(result.market, 0)).toBe(3)
    expect(hireCost(result.market, 4)).toBe(15)
  })
})

describe('soloMarketDecay', () => {
  test('discards exactly the leftmost and rightmost cards, then refills and re-sorts', () => {
    const market = emptyMarket(PRICES)
    const filled = refillMarket(market, ['r1', 'r2', 'r3a', 'r5', 'r9'], cardsById, 0)
    expect(filled.market.slots).toEqual(['r1', 'r2', 'r3a', 'r5', 'r9'])

    const decayed = soloMarketDecay(filled.market, ['r3b'], cardsById, filled.nextInsertionSeq)
    // r1 and r9 discarded; r3b drawn to refill; re-sorted: [r2, r3a, r3b, ...]
    // but only ONE replacement card was supplied (toon deck had just one
    // card left), so the market comes back short by one — right-justified.
    expect(decayed.market.slots).toContain('r2')
    expect(decayed.market.slots).not.toContain('r1')
    expect(decayed.market.slots).not.toContain('r9')
    // r2 + r3a + r5 survive the discard, r3b arrives as the one available
    // replacement (toon deck only had one card left) — 4 occupants, one
    // empty slot remains (right-justified, per §3.2.2).
    expect(decayed.market.slots.filter((s) => s !== null)).toHaveLength(4)
    expect(decayed.market.slots[0]).toBeNull()
  })

  test('fires as exactly one discard-refill-resort pass (two cards leave, not two per slot)', () => {
    const market = emptyMarket(PRICES)
    const filled = refillMarket(market, ['r1', 'r2', 'r3a', 'r5', 'r9'], cardsById, 0)
    const decayed = soloMarketDecay(filled.market, ['r3b', 'r3c'], cardsById, filled.nextInsertionSeq)
    const occupied = decayed.market.slots.filter((s) => s !== null)
    expect(occupied).toHaveLength(5) // fully refilled: r2, r3a, r5, and the two replacements
    expect(occupied).toContain('r3b')
    expect(occupied).toContain('r3c')
  })

  test('a refill failure during decay sets toonDeckEmpty, same as a Cleanup-time failure', () => {
    const market = emptyMarket(PRICES)
    const filled = refillMarket(market, ['r1', 'r2', 'r3a', 'r5', 'r9'], cardsById, 0)
    const decayed = soloMarketDecay(filled.market, [], cardsById, filled.nextInsertionSeq)
    expect(decayed.toonDeckEmpty).toBe(true)
    expect(decayed.short).toBe(true)
  })
})
