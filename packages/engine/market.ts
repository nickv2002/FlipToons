// The market, per flip-toonz-structure-plan.md §3.6:
//   width = prices.length (never a literal 5 — solo/1-4p uses [3,4,7,10,15])
//   cards occupy slots sorted by rank, lowest = leftmost (cheapest)
//   refill, THEN re-sort — buying a cheap card can make a left-behind card
//     pricier
//   rank ties: stable sort by (rank, insertionIndex) ascending — the
//     newly-drawn card settles to the RIGHT of an equal-ranked incumbent
//   hire cost = the price card ABOVE the slot the card currently occupies
//     (positional, not attached to the card)
//
// Season-agnostic (§10) — takes CardIds/Cards as data, never branches on
// Card.season.

import type { Card, CardId } from './cards/types'

// `slots` is the public shape the task describes: `(CardId | null)[]`,
// index i costs `prices[i]`. `insertionSeq` is a same-length parallel array
// (null where the slot is empty) carrying WHEN each occupant was revealed
// from the toon deck — the load-bearing tiebreak key from §3.6 ("insertion
// index being the order cards were revealed from the toon deck — already
// deterministic from the seed"). It has to live somewhere: keeping it out
// of `slots` itself (rather than e.g. `{cardId, seq}[]`) is what keeps the
// public field exactly the `(CardId | null)[]` shape called for.
export type Market = {
  prices: number[]
  slots: (CardId | null)[]
  insertionSeq: (number | null)[]
}

export function emptyMarket(prices: number[]): Market {
  return {
    prices: prices.slice(),
    slots: Array<CardId | null>(prices.length).fill(null),
    insertionSeq: Array<number | null>(prices.length).fill(null),
  }
}

export function hireCost(market: Market, slotIndex: number): number {
  return market.prices[slotIndex]
}

export type RefillResult = {
  market: Market
  toonDeck: CardId[]
  nextInsertionSeq: number
  // A refill that didn't fill every empty slot because the toon deck ran
  // low/out mid-fill. NORMAL, not a trigger (§3.2.2: "a short refill is
  // normal, not a trigger") — the market just runs under-width.
  short: boolean
  // The toon deck is now FULLY EMPTY. THE depletion-trigger condition
  // (§3.2.2's printed-rulebook quote: "if the toon deck is ever depleted" —
  // not merely short of filling every slot). Callers OR this into
  // GameState.toonDeckDepleted rather than re-deriving it later by
  // inspecting toonDeck.length, per §3.2.2's explicit instruction: "Return
  // that as a fact from the market refill rather than re-deriving it."
  toonDeckEmpty: boolean
}

// The ONE refillMarket used everywhere the market gets refilled: the
// standard once-per-turn refill at the end of the Market phase (CONFIRMED
// rulebook text: "Once a player has completed their actions... reveal
// cards... and rearrange... by rank" — NOT per hire/dismiss action, see
// phases.ts's hire() header comment), Horse's/Crow's own card-specific
// IMMEDIATE refills, and the solo/2-player decay step (§3.2.2: "avoid two
// separate refill implementations"). Refill-then-resort:
//   1. Fill every empty slot by drawing from the front of the toon deck,
//      each draw stamped with a strictly increasing insertionSeq.
//   2. Re-sort the WHOLE row (existing occupants + newly drawn) by
//      (rank, insertionSeq) ascending — an EXPLICIT comparator, not
//      Array.prototype.sort's stability alone (§3.6's explicit warning).
//   3. If there are fewer occupants than slots (toon deck ran out), the
//      printed rulebook (§3.2.2 quote) has them "arranged under the highest
//      price cards" — i.e. right-justified, leaving the CHEAP (left) slots
//      empty, not the expensive ones. `startIdx` below implements both the
//      normal (full) and short (right-justified) case with one formula.
export function refillMarket(
  market: Market,
  toonDeck: CardId[],
  cardsById: Record<CardId, Card>,
  nextInsertionSeq: number,
): RefillResult {
  const remainingToonDeck = toonDeck.slice()
  const entries: { cardId: CardId; seq: number }[] = []

  for (let i = 0; i < market.slots.length; i++) {
    const cardId = market.slots[i]
    if (cardId !== null) entries.push({ cardId, seq: market.insertionSeq[i]! })
  }

  let seq = nextInsertionSeq
  let short = false
  for (let i = 0; i < market.slots.length; i++) {
    if (market.slots[i] !== null) continue // already occupied — nothing to draw for this slot
    if (remainingToonDeck.length === 0) {
      short = true
      continue
    }
    const cardId = remainingToonDeck.shift()!
    entries.push({ cardId, seq: seq++ })
  }

  entries.sort((a, b) => {
    const rankA = cardsById[a.cardId].rank
    const rankB = cardsById[b.cardId].rank
    if (rankA !== rankB) return rankA - rankB
    return a.seq - b.seq // tie -> earlier-revealed (lower seq) sorts first (left); later arrival lands to the right
  })

  const newSlots: (CardId | null)[] = Array(market.slots.length).fill(null)
  const newSeqs: (number | null)[] = Array(market.slots.length).fill(null)
  const startIdx = market.slots.length - entries.length // 0 when full; right-justifies when short
  entries.forEach((e, i) => {
    newSlots[startIdx + i] = e.cardId
    newSeqs[startIdx + i] = e.seq
  })

  return {
    market: { prices: market.prices, slots: newSlots, insertionSeq: newSeqs },
    toonDeck: remainingToonDeck,
    nextInsertionSeq: seq,
    short,
    toonDeckEmpty: remainingToonDeck.length === 0,
  }
}

// The 2-player/solo market decay (§3.6, §3.2.2 item 17): "discard the
// leftmost and rightmost cards in the market. Refill the market again and
// rearrange the cards by rank, as needed." Fires ONCE per round, at the end
// of the Market phase (phases.ts's endMarketPhase), never at Cleanup.
//
// "Leftmost and rightmost" is read as literal array POSITIONS 0 and
// `length-1`, not "the two cheapest/priciest occupied cards" — these only
// diverge once the market is already right-justified from a prior
// depletion (refillMarket's `short` case), by which point the game is
// already headed to a loss; not worth a special case for.
//
// Discarded cards leave the game entirely (not tracked in any pile this
// engine models) — the plan defines a per-player `dismissed` pile for grid
// dismissals specifically, and doesn't define a destination for
// market-decay discards; a `marketDiscard: CardId[]` field could be added
// later if the UI wants to show them, but nothing downstream needs it now.
export function soloMarketDecay(
  market: Market,
  toonDeck: CardId[],
  cardsById: Record<CardId, Card>,
  nextInsertionSeq: number,
): RefillResult {
  const decayed: Market = {
    prices: market.prices,
    slots: market.slots.slice(),
    insertionSeq: market.insertionSeq.slice(),
  }
  const lastIdx = decayed.slots.length - 1
  decayed.slots[0] = null
  decayed.insertionSeq[0] = null
  decayed.slots[lastIdx] = null
  decayed.insertionSeq[lastIdx] = null

  return refillMarket(decayed, toonDeck, cardsById, nextInsertionSeq)
}
