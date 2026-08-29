// The Big Button mini-expansion's two reset effects, as pure PlayerView
// transforms (Referance/IMG_4308.HEIC — the only photographed page).
//
// Why its own module rather than more of phases.ts: BOTH action surfaces need
// these primitives, and matchActions.ts must not import actions.ts (see that
// file's header). Putting them here lets the solo reducer and the turn machine
// each reach the same code without either reaching through the other.
//
// The dependency runs ONE WAY: phases.ts imports this file (for
// hasAnyLegalMarketAction), so this file must never import phases.ts.
//
//   SETUP     "Place a Big Button card face up in front of each player.
//              Decide which reset effect card to use... Before creating the
//              market, shuffle the platypus toon cards into the toon deck."
//              (setup.ts owns the deck half; state.ts owns the per-player
//              face-up flag.)
//   PLAY      "players may flip their Big Button card face-down to activate
//              its reset effect."
//
// Flipping face down IS the whole cost — no fame, no action. It is once per
// game unless Axolotl (S1) or Platypus (S2) flips it back up.

import { emptyGrid, occupiedSlots } from './grid'
import type { CardId } from './cards/types'
import { emptyMarket, refillMarket } from './market'
import { shuffleWithState } from './rng'
import { cardsById } from './setup'
import type { PlayerView } from './state'
import type { Grid } from './types'

const cards = cardsById()

// ---------------------------------------------------------------------------
// RESET: MARKET
// ---------------------------------------------------------------------------
//
// "During the Market phase, a player may flip their face-up Big Button card
// face down to shuffle all toon cards in the market back into the toon deck.
// Then refill the market. This action must be taken on a player's turn before
// taking any market actions."
//
// The "before any market actions" clause is why PlayerState carries
// `actedThisMarketPhase` rather than this reading actionsRemaining — see that
// field's comment for the Peacock case that defeats the obvious proxy.
export function canUseMarketReset(view: PlayerView): boolean {
  return view.resetEffect === 'market' && view.bigButtonFaceUp && view.phase === 'market' && !view.actedThisMarketPhase
}

export function applyMarketReset(view: PlayerView): PlayerView {
  if (!canUseMarketReset(view)) {
    throw new Error('bigButton.ts: applyMarketReset — the Big Button is not available (already used, wrong reset effect, or this turn has already taken a Market action)')
  }

  // Shuffled with the ACTING player's own stream, for the same reason
  // match.ts's matchResolveDeckPlacement does: every seat has its own stream
  // (state.ts's makeMatch), so a shuffle of the SHARED deck has to be
  // attributed to someone specific to stay reproducible from the match seed.
  const returned = view.market.slots.filter((id): id is CardId => id !== null)
  const shuffled = shuffleWithState([...view.toonDeck, ...returned], view.rng)

  const refill = refillMarket(emptyMarket(view.market.prices), shuffled.result, cards, view.nextInsertionSeq)

  return {
    ...view,
    rng: shuffled.next,
    market: refill.market,
    toonDeck: refill.toonDeck,
    nextInsertionSeq: refill.nextInsertionSeq,
    // Mirrors phases.ts's applyRefillResult, which this module can't reach:
    // the flag is LATCHED, so `|| refill.short` and never a plain assignment.
    // A reset that grows the toon deck therefore cannot un-trigger a
    // depletion endgame an earlier round already armed — correct, since the
    // trigger is latched at Cleanup and never re-derived (match.ts).
    toonDeckDepleted: view.toonDeckDepleted || refill.short,
    bigButtonFaceUp: false,
  }
}

// The cards this reset put back into the toon deck, for a log line. Read off
// the market BEFORE applyMarketReset, since it empties it.
export function marketResetReturnedCards(view: PlayerView): CardId[] {
  return view.market.slots.filter((id): id is CardId => id !== null)
}

// ---------------------------------------------------------------------------
// RESET: GRID
// ---------------------------------------------------------------------------
//
// "After the Check Fame phase, starting with the first player, each player in
// clockwise order decides if they want to use their face-up Big Button card.
// All players who want to use their card simultaneously flip their Big Button
// card face down, collect the cards in their grid, add them to their deck,
// shuffle, and complete the Flip phase again. All players then repeat the
// Check Fame phase."
//
// The sequencing of the DECISIONS and the simultaneity of the RESETS are both
// real: a later decider sees what the earlier ones chose, but nobody's re-flip
// is visible to anyone until they have all committed. match.ts owns that walk
// (SharedState.gridReset); this module owns only the per-player transform.
export function canUseGridReset(view: PlayerView): boolean {
  return view.resetEffect === 'grid' && view.bigButtonFaceUp
}

function collectGridCards(grid: Grid): CardId[] {
  const ids: CardId[] = []
  for (const { slot } of occupiedSlots(grid)) ids.push(...slot.cards)
  return ids
}

// "flip their Big Button card face down, collect the cards in their grid, add
// them to their deck" — the shuffle and the re-flip are the CALLER's job,
// because runFlip already shuffles the deck itself and doing it here would
// shuffle twice. Deliberately says nothing about `phase`, so both the round
// and the Final Flip paths can use it unchanged.
//
// Fame is NOT reset: this is not a Cleanup. The second Check Fame overwrites
// fameGeneratedThisRound outright, which is the risk of pressing the button —
// a reset that scores worse can cost that player the endgame trigger and the
// Critic's Choice.
export function applyGridResetCollect(view: PlayerView): PlayerView {
  if (!canUseGridReset(view)) {
    throw new Error('bigButton.ts: applyGridResetCollect — the Big Button is not available (already used, or the reset effect in play is not RESET: GRID)')
  }
  return {
    ...view,
    deck: [...view.deck, ...collectGridCards(view.grid)],
    grid: emptyGrid(),
    bigButtonFaceUp: false,
  }
}
