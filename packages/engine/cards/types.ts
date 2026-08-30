// Card schema per flip-toonz-structure-plan.md §4.4, extended only where the
// transcribed cards genuinely require it (see cards.csv at repo root for the
// full verbatim transcription this data was encoded from).

import type { GridPos } from '../types'

export type SeasonId = 1 | 2

// Setup-time season selection — distinct from SeasonId: a Card is always
// tagged with one concrete season, but a game/room can be configured to draw
// from both at once.
export type Season = SeasonId | 'both'

export type CardId = string

// A count over a grid query, or a flat conditional bonus. Kept intentionally
// small — grow only when a card can't be expressed (§4.4).
export type FameBonus =
  | { kind: 'perQuery'; query: GridQuery; amount: number }
  | { kind: 'ifCondition'; condition: string; amount: number } // condition is human text until a query vocabulary is built for it

export type GridQuery =
  | 'uniqueAdjacentName' // Dragonfly
  | 'cardAboveInColumn' // Grasshopper — despite the name, a COLUMN count (ruled directly by user 2026-08-20), not a same-slot stack count; see score.ts's countCardsInColumn
  | 'cardBelowInColumn' // Spider — column count, mirror of Grasshopper above
  | 'adjacentOddRankCard' // Rhinoceros
  | 'dismissedCard' // Tiger
  | 'dismissedStartingCard' // Cat
  | 'dismissedIdenticalPair' // Opossum
  | 'faceUpGridCard' // Bear
  | 'remainingDeckCard' // Hippopotamus
  | 'fishTypeCard' // Goldfish/Shark

export type FameRule = {
  base: number | '=' // '=' marks a dynamic fame value that isn't base+bonuses (Cow: copies an adjacent card's fame)
  bonuses?: FameBonus[]
}

export type Immunity = 'flip' | 'dismiss' | 'return'

export type Card = {
  id: CardId
  name: string
  season: SeasonId
  rank: number
  copies: number // starting-deck count for starter cards, toon-deck count for market cards — see cards.csv notes
  fame: FameRule
  typeTags?: string[] // e.g. ['fish']
  immune?: Immunity[]
  dismissCost?: number // overrides the default 5
  // Structured effects the current vocabulary can express:
  onPlace?: PlaceEffect[]
  onHire?: Effect[]
  onDismiss?: Effect[]
  postFameHook?: PostFameHook
  postMarketHook?: PostMarketHook
  // Anything not yet expressible: kept verbatim so no rules text is lost.
  //
  // Two DIFFERENT kinds of "not done yet", deliberately split (see the Step-4
  // task notes this was built from — conflating them made scoreGrid blank a
  // card's score whenever its *placement effect* was unimplemented, even
  // though its fame number was already correct and known):
  //
  // - `unencodable` / `unencodableReason` — the onPlace/onHire/onDismiss/
  //   postFameHook EFFECT is incomplete or absent; the raw text is the
  //   source of truth for it. This does NOT mean the fame value is wrong —
  //   most cards with this flag have a fully correct `fame` and should
  //   score normally once they're sitting on the grid. (Field name kept
  //   as-is, not renamed to `effectUnencodable`, specifically so
  //   cards/season2.ts — untouched this pass — doesn't need editing to keep
  //   compiling.)
  // - `fameUnencodable` / `fameUnencodableReason` — the FAME VALUE ITSELF
  //   can't be computed as a fixed number (e.g. the Cow's `fame.base: '='`,
  //   which copies a chosen adjacent card's fame). This is the ONLY flag
  //   scoreGrid consults to decide whether a card's score is untrustworthy —
  //   see score.ts.
  rawBannerText?: string
  rawBodyText?: string
  unencodable?: boolean
  unencodableReason?: string
  fameUnencodable?: boolean
  fameUnencodableReason?: string
  // Verbatim quote from the Season 1 rulebook's FAQ section (an OCR transcription
  // at rulespal.com/fliptoons/rulebook#faq of the actual physical rulebook —
  // same authority as rawBannerText/rawBodyText, not a separate/weaker source).
  faqNote?: string
}

export type PlaceEffect =
  | { kind: 'stackOnPreviousPlaced' } // Turkey — stacks on the LAST PLACED CARD, tracked by identity, even if it has since relocated
  | { kind: 'stackNextRevealed' } // Ostrich — the deferred "next revealed card" primitive
  | { kind: 'flipNextRevealed' } // Eagle — same deferred primitive, flips instead of stacks; no-op if the target is immune to 'flip'
  | { kind: 'flipPreviousPlaced' } // Elephant — flips the LAST PLACED CARD by identity; no-op if it's immune to 'flip', or if this is the first card placed
  | { kind: 'stackOnFirstMatchOrFaceDown'; matchCardId: CardId } // Rabbit — searches the grid in reading order for the first card matching `matchCardId` (face-up) or the first face-down card; falls back to the next empty base slot if neither exists (UNCONFIRMED assumption, see flip.ts)
  | { kind: 'moveToExtraRowIfUpperRow' } // Monkey — if placed in the upper base row, relocates itself into an extra row at the same column (stacking above any existing occupant there), vacating its base slot
  // --- Season 2 additions (this pass) ---
  | { kind: 'stackOnAboveIfLowerRow' } // Mole — IF placed in the lower row, stacks itself on the (positionally-determined, not identity-tracked) card directly above
  | { kind: 'returnNextRevealedIfRankAtMost'; maxRank: number } // Salamander — DEFERRED "next revealed card" primitive; if the target's rank qualifies, it is never placed on the grid at all (see returnCardToDeckTop in flip.ts — UNCONFIRMED return destination)
  | { kind: 'returnPreviousPlacedOrStack' } // Coyote — returns the LAST PLACED CARD (by identity) and takes its slot, unless it's immune to 'return', in which case Coyote stacks on it instead
  | { kind: 'returnSelfIfMiddleColumn' } // Crab — IF placed in the middle column (col 1, either row), returns itself (see flip.ts's stall-condition note — this can loop under the current UNCONFIRMED return-destination reading)
  | { kind: 'returnLowestRankOrStack' } // Zebra — finds the lowest-rank FACE-UP card anywhere in the grid (reading-order tiebreak) and returns it, taking its slot, unless it's immune to 'return', in which case Zebra stacks on it instead; no-op (falls back to default placement) if no face-up card exists yet
  | { kind: 'moveNextRevealedToExtraRowIfUpperRow' } // Gorilla — IF placed in the upper base row, the NEXT revealed card (deferred primitive, like Ostrich/Eagle) is diverted into an extra row above Gorilla's column instead of the grid, stacking above any existing occupant there; its own onPlace ability still resolves afterward (not suppressed, unlike Eagle's flip)
  // --- Group 3 additions (toonDeck threading — see flip.ts's FlipContext) ---
  | { kind: 'dismissOwnDeckTopAndStackFromToonDeck' } // Snake — dismisses the top of the player's own deck (fallback: place right of Snake, or back to deck bottom), then unconditionally stacks the toon deck's top card onto Snake's own slot
  | { kind: 'dismissOwnDeckBottomAndDrawToonDeckTop' } // Mongoose — dismisses the bottom of the player's own deck unless immune, then unconditionally draws the toon deck's top card onto the TOP of the player's deck
  | { kind: 'other'; text: string }

// Effects fired from `applyEffects` in phases.ts (Group 1/2 of the pass that
// added these), one firing point shared by onHire and onDismiss. Each kind
// below is either MANDATORY (fires unconditionally, throwing if a required
// player choice is missing while a legal target exists) or OPTIONAL ("you
// may..." — silently no-ops when the matching EffectChoices field is absent
// or 'decline', rather than guessing). See each kind's card-data comment in
// cards/season1.ts / cards/season2.ts for which is which.
export type Effect =
  | { kind: 'gainFame'; amount: number } // Peacock's flat +2 half
  | { kind: 'bonusMarketAction'; amount: number } // Peacock — OPTIONAL; additive on top of hire()'s own actionsRemaining decrement
  | { kind: 'dismissByName'; targetCardId: CardId; cost: number } // Butterfly — OPTIONAL, targets a face-up card matching targetCardId
  | { kind: 'dismissChosenGridCard'; cost: number } // Panther — MANDATORY (throws if declined while any legal target exists)
  // Raccoon — OPTIONAL, targets a card in GameState.dismissed. "ANY dismissed
  // card" (rawBannerText) means any player's at a table, not just the
  // hirer's own pile — like Pig above, phases.ts only ever removes from the
  // ACTING player's own view; match.ts's matchHire is what pulls a card out
  // of another seat's dismissed pile and hands it to this player's view
  // before applyEffects runs, via EffectChoices.hireFromDismissed's
  // ownerPlayerId below.
  | { kind: 'hireFromDismissed'; cost: number }
  | { kind: 'hireFromMarketAndRefill'; cost: number } // Crow — OPTIONAL, targets a market slot
  | { kind: 'discardMarketAndRefill' } // Horse — OPTIONAL, targets any number of market slots
  // Pig — MANDATORY, and the only effect in the vocabulary that reaches
  // ACROSS players: its FAQ says the card goes into "any player's deck or
  // back in the toon deck." A PlayerView can't see another seat's deck, so
  // this effect only detaches the card and records that a placement is owed;
  // match.ts resolves the target at the table level (matchResolveDeckPlacement).
  | { kind: 'placeSelfInAnyDeck' }
  // Axolotl (S1) — MANDATORY, no choice. "WHEN HIRED, FLIP YOUR BIG BUTTON
  // CARD FACE UP." Own-seat only, so phases.ts's applyEffects resolves it
  // whole.
  | { kind: 'flipOwnBigButtonFaceUp' }
  // Platypus (S2) — MANDATORY, no choice, and the SECOND effect in this
  // vocabulary that reaches ACROSS players (see placeSelfInAnyDeck above):
  // "WHEN HIRED, FLIP ALL BIG BUTTON CARDS FACE UP", every seat's, not just
  // the hirer's. A PlayerView can only see its own, so applyEffects does the
  // acting player's half and match.ts's matchHire does everyone else's.
  | { kind: 'flipAllBigButtonsFaceUp' }
  | { kind: 'other'; text: string }

// Player-choice payloads for the Effect kinds above, threaded through
// hire()/dismiss()/applyEffects (phases.ts). Every field is OPTIONAL on this
// type itself — whether a given field is required at runtime depends on
// whether the firing card's effect is mandatory (see Effect's comment) and
// whether a legal target exists at all.
export type EffectChoices = {
  dismissByName?: { pos: GridPos; index: number } // Butterfly's target Caterpillar slot; absent = decline
  dismissGridPos?: { pos: GridPos; index: number } // Panther's mandatory target
  // Raccoon. ownerPlayerId names whose dismissed pile the card is coming
  // from — a PlayerId (state.ts), spelled as `string` here to avoid a
  // circular import (state.ts imports this file, not the reverse). Absent
  // means "the acting player's own pile", which is the only case solo ever
  // produces.
  hireFromDismissed?: { cardId: CardId; ownerPlayerId?: string } | 'decline'
  hireFromMarketSlot?: { slotIndex: number } | 'decline' // Crow
  discardMarketSlots?: number[] // Horse — empty/absent = decline
}

// Post-Market self/other-triggered hooks (Group 2 of this pass), fired by
// phases.ts's runPostMarketHooks from endMarketPhase(), BEFORE the solo
// decay step. Every variant is free (no cost) per each card's own FAQ, and
// mandatory when it has a legal target — but `dismissAdjacentRight`
// (Alligator) is NOT choice-free: its own FAQ note ("if the target is a
// stack, dismiss any one card in the stack") means the player picks which
// card whenever 2+ eligible cards sit in the target slot (see
// GameState.pendingPostMarketChoice, phases.ts). The two `selfDismissIf` conditions check
// the card's CURRENT grid position at apply time (this engine tracks no
// placement history — a Donkey/Groundhog that got relocated by another
// card's effect is judged on where it actually ended up, not where it was
// first placed):
//   - 'inLowerRow' (Donkey): fires iff currently in base row 1.
//   - 'firstOrLastGridSlot' (Groundhog): fires iff currently in base[0][0]
//     or base[1][2] specifically — FAQ: "only the 6 base slots count," so
//     a Groundhog relocated into an extraRow never qualifies.
export type PostMarketHook =
  | { kind: 'selfDismissIf'; condition: 'inLowerRow' | 'firstOrLastGridSlot' } // Donkey / Groundhog
  | { kind: 'dismissAdjacentRight' } // Alligator — dismisses one card in the slot directly to its right, if any
  | { kind: 'dismissLowestRankInGrid' } // Vulture — dismisses the lowest-rank face-up card anywhere in the grid (reading-order tiebreak), which MAY be Vulture itself

export type PostFameHook = {
  condition: 'strictlyLowestFame'
  mandatory: boolean
  consumesAction: boolean
  effect: { kind: 'dismiss'; target: 'chooseOwnGridCard'; cost: number } | { kind: 'gainFame'; amount: number }
}
