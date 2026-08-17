import type { Card } from './types'

// Transcribed from "Season 2 - Starters.jpeg" and "Season 2 cards.jpeg",
// cross-checked against the official FlipToons: Season 2 rulebook FAQ pages
// (Referance/IMG_4310.HEIC, IMG_4311.HEIC — Thunderworks Games). Verbatim
// source text lives in cards.csv at the repo root.
//
// Two corrections to flip-toonz-structure-plan.md §3.4 surfaced by this
// transcription: the least-fame card in Season 2 is Firefly, not Ladybug —
// Ladybug is an adjacent-dismiss-discount card (same shape as Caterpillar's
// self-discount, but applied to neighbors) — and Firefly's least-fame effect
// is "gain 2 fame", not a free dismissal like the Skunk's. See FAQ: "Only one
// player can benefit from the firefly's ability each round... In case of a
// tie, the firefly has no effect" — same tie handling as the Skunk.

export const season2Cards: Card[] = [
  // --- Starting deck (rank 0, 6 cards: 2x Mosquito, 1x Spider, 1x Grasshopper, 1x Ladybug, 1x Firefly) ---
  {
    id: 'grasshopper', name: 'Grasshopper', season: 2, rank: 0, copies: 1,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'cardAboveInStack', amount: 1 }] },
  },
  {
    id: 'mosquito', name: 'Mosquito', season: 2, rank: 0, copies: 2,
    fame: { base: 0 },
  },
  {
    id: 'ladybug', name: 'Ladybug', season: 2, rank: 0, copies: 1,
    fame: { base: 1 },
    rawBannerText: 'ADJACENT CARDS COST 3 INSTEAD OF 5 TO DISMISS',
    // Fully encodable now — dismiss()'s cost computation reads grid
    // adjacency directly via phases.ts's dismissCostFor, rather than a
    // per-card dismissCost field (which is self-only and can't express "my
    // NEIGHBORS get a discount").
  },
  {
    id: 'spider', name: 'Spider', season: 2, rank: 0, copies: 1,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'cardBelowInStack', amount: 1 }] },
  },
  {
    id: 'firefly', name: 'Firefly', season: 2, rank: 0, copies: 1,
    fame: { base: 1 },
    postFameHook: {
      condition: 'strictlyLowestFame',
      mandatory: true,
      consumesAction: false,
      effect: { kind: 'gainFame', amount: 2 },
    },
  },

  // --- Market deck (55 total copies across 26 ranks) ---
  {
    id: 'salamander', name: 'Salamander', season: 2, rank: 1, copies: 3,
    fame: { base: 3 },
    rawBodyText: 'IF the next revealed card is rank 1 or lower, return it',
    onPlace: [{ kind: 'returnNextRevealedIfRankAtMost', maxRank: 1 }],
    // Encoded this pass via the deferred "next revealed card" primitive
    // (same shape as Ostrich/Eagle) plus a new RETURN verb — see
    // flip.ts's returnCardToDeckBottom for the UNCONFIRMED return-destination
    // reading (bottom of the owning deck, redrawable later this same Flip
    // once every other undrawn card has come up first) this needs a direct
    // user ruling on.
  },
  {
    id: 'groundhog', name: 'Groundhog', season: 2, rank: 2, copies: 3,
    fame: { base: 3 },
    rawBodyText: 'After the Market phase, dismiss this card if first or last in your grid',
    postMarketHook: { kind: 'selfDismissIf', condition: 'firstOrLastGridSlot' },
    faqNote: 'FAQ: mandatory & free; only the 6 base slots count (base[0][0] or base[1][2] specifically) even if Groundhog is sitting in a stack there — an extraRow position never qualifies.',
  },
  {
    id: 'rat', name: 'Rat', season: 2, rank: 3, copies: 4,
    fame: { base: 1 },
    rawBannerText: "CARDS IN RAT'S STACK COST 1 FEWER TO DISMISS",
    onPlace: [{ kind: 'stackOnPreviousPlaced' }],
    // Fully encodable now — see phases.ts's dismissCostFor. FAQ: ignored if
    // Rat is face-down or no longer in the grid (covered for free by
    // dismissCostFor's `slot.faceUp[i]` check — a face-down or removed Rat
    // simply doesn't match); cost floors at 0.
  },
  {
    id: 'goldfish', name: 'Goldfish', season: 2, rank: 4, copies: 5,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'fishTypeCard', amount: 1 }] },
    typeTags: ['fish'],
    immune: ['flip'],
  },
  {
    id: 'mole', name: 'Mole', season: 2, rank: 5, copies: 2,
    fame: { base: 3 },
    rawBodyText: 'IF placed in the lower row, stack this card on the card above',
    onPlace: [{ kind: 'stackOnAboveIfLowerRow' }],
    // Encoded this pass — new POSITIONAL (not identity-tracked) target
    // primitive; see flip.ts's 'stackOnAboveIfLowerRow' case.
  },
  {
    id: 'hen', name: 'Hen', season: 2, rank: 6, copies: 3,
    fame: { base: 0, bonuses: [{ kind: 'ifCondition', condition: 'perCardRank6OrHigherIncludingSelf', amount: 1 }] },
  },
  {
    id: 'starfish', name: 'Starfish', season: 2, rank: 7, copies: 2,
    fame: { base: 4 },
    typeTags: ['fish'],
    immune: ['flip'],
    rawBodyText: 'Flip the previous placed card unless it cannot be flipped and stack this card on it',
    onPlace: [{ kind: 'stackOnPreviousPlaced' }, { kind: 'flipPreviousPlaced' }],
    // Encoded this pass by COMBINING two primitives Season 1 already built
    // (Turkey's stackOnPreviousPlaced + Elephant's flipPreviousPlaced) on
    // one card — no new vocabulary needed. determineTarget resolves the
    // self-stack target BEFORE placement, using the pre-placement
    // `lastPlaced`; the flip is then applied to that same previous card
    // (by identity) right after Starfish is placed. "Unless it cannot be
    // flipped" governs only the flip half — the stack half is unconditional.
  },
  {
    id: 'raccoon', name: 'Raccoon', season: 2, rank: 8, copies: 2,
    fame: { base: 3 },
    rawBannerText: 'WHEN HIRED, YOU MAY HIRE ANY DISMISSED CARD FOR 0',
    onHire: [{ kind: 'hireFromDismissed', cost: 0 }],
  },
  {
    id: 'panther', name: 'Panther', season: 2, rank: 9, copies: 2,
    fame: { base: 2 },
    onPlace: [{ kind: 'stackOnPreviousPlaced' }],
    rawBannerText: 'WHEN HIRED, DISMISS A FACE-UP CARD IN YOUR GRID FOR 0',
    onHire: [{ kind: 'dismissChosenGridCard', cost: 0 }],
    // Panther's mandatory target is an EXISTING face-up grid card — Panther
    // itself isn't on the grid yet when its onHire fires (it's mid-transit
    // from market slot to deck), so it can never target itself.
  },
  {
    id: 'opossum', name: 'Opossum', season: 2, rank: 10, copies: 2,
    fame: { base: 2, bonuses: [{ kind: 'perQuery', query: 'dismissedIdenticalPair', amount: 2 }] },
    immune: ['dismiss'],
    // Fully encodable now — same 'externalState.dismissed' path as Season
    // 1's Cat/Tiger (score.ts). Opossum is immune: ['dismiss'], so it can
    // never appear in its own dismissed pile.
  },
  {
    id: 'mongoose', name: 'Mongoose', season: 2, rank: 11, copies: 2,
    fame: { base: 2 },
    rawBodyText: 'Dismiss the bottom card of your deck unless it cannot be dismissed, and add the top card of the toon deck to the top of your deck',
    onPlace: [{ kind: 'dismissOwnDeckBottomAndDrawToonDeckTop' }],
    // Fully encoded this pass (Group 3) — see flip.ts's
    // 'dismissOwnDeckBottomAndDrawToonDeckTop' case: the draw is
    // unconditional (fires even when the dismiss half is skipped for an
    // immune bottom card), matching the FAQ. The dismissed card's own
    // onDismiss "resolving after the Flip phase" is a GENERAL deferred-
    // post-Flip limitation (no card's onDismiss fires from anywhere but
    // dismiss(), the Market phase, today) — not specific to Mongoose (see
    // Snake's parallel gap, season1.ts), so `unencodable` is dropped here
    // rather than kept for a limitation that isn't really about this card.
  },
  {
    id: 'capybara', name: 'Capybara', season: 2, rank: 12, copies: 2,
    fame: { base: 2, bonuses: [{ kind: 'ifCondition', condition: 'atLeastThreeCardsRemainingInDeck', amount: 4 }] },
  },
  {
    id: 'crow', name: 'Crow', season: 2, rank: 13, copies: 2,
    fame: { base: 2 },
    rawBannerText: 'WHEN DISMISSED, YOU MAY HIRE A CARD IN THE MARKET FOR 0 AND REFILL',
    onDismiss: [{ kind: 'hireFromMarketAndRefill', cost: 0 }],
    // FAQ's "Market phase vs Flip phase" timing split: only the
    // Market-phase-dismissal case is reachable in this engine — there is no
    // other onDismiss trigger path (dismiss() is the sole place onDismiss
    // fires from). The Flip-phase-dismissal case (were one to exist) is not
    // encoded; see snake/mongoose's card-data comments for the same class
    // of deferred-post-Flip gap.
  },
  {
    id: 'coyote', name: 'Coyote', season: 2, rank: 14, copies: 2,
    fame: { base: 5 },
    immune: ['return'],
    rawBodyText: 'Return the previous placed card unless it cannot be returned, and place this card in its space; if it cannot be returned, stack the coyote on it instead (FAQ)',
    onPlace: [{ kind: 'returnPreviousPlacedOrStack' }],
    // Encoded this pass — GRID-return (an already-placed card is pulled off
    // the grid, unlike Salamander's deferred pre-placement return) with an
    // immune-to-return fallback to stacking. See flip.ts's
    // resolveGridReturnTarget and the UNCONFIRMED return-destination note
    // on returnCardToDeckBottom.
  },
  {
    id: 'clownfish', name: 'Clownfish', season: 2, rank: 15, copies: 2,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'adjacentToAtLeastOneFishCard', amount: 2 }] },
    typeTags: ['fish'],
    immune: ['flip'],
  },
  {
    id: 'fox', name: 'Fox', season: 2, rank: 16, copies: 2,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'henOrRoosterInMarketOrAnyGrid', amount: 3 }] },
    // FLAG-AUDIT FINDING (this pass): 'henOrRoosterInMarketOrAnyGrid' needs
    // the shared market plus EVERY player's grid (not just the owner's,
    // unlike Dog/Camel's "other player" phrasing) — none of which exist in
    // this single-grid Step-0 engine. Previously unimplemented (throws,
    // crashes scoreGrid for any grid with a Fox). fameUnencodable blanks
    // the whole line, including the known base fame of 3.
    fameUnencodable: true,
    fameUnencodableReason:
      "fame bonus condition 'henOrRoosterInMarketOrAnyGrid' needs the shared market and every player's grid, which don't exist in this single-grid engine — deliberately not faking that state",
  },
  {
    id: 'crab', name: 'Crab', season: 2, rank: 17, copies: 2,
    fame: { base: 5 },
    rawBodyText: 'IF placed in the middle column, return this card',
    onPlace: [{ kind: 'returnSelfIfMiddleColumn' }],
    // Encoded this pass — self-return conditional on landing in the middle
    // column (col 1, either row). The FAQ's "all-crab-deck stall
    // condition" mention directly shaped the return-destination reading:
    // an earlier "top of deck, immediately redrawable" draft made ANY
    // single Crab landing in the middle column stall forever (it vacates
    // its own slot and redraws itself right back into the same
    // leftmost-empty slot), which is strictly broader than what the FAQ
    // describes — so this pass switched to bottom-of-deck (see flip.ts's
    // returnCardToDeckBottom comment), under which a lone Crab never
    // stalls but a deck of nothing but Crabs still does, matching the
    // FAQ's scope. Still UNCONFIRMED, still needs a direct ruling — see
    // this pass's report. The extra-row and stacked-in-middle-column FAQ
    // nuances mentioned in
    // the original reason are NOT specially handled — `.col === 1` applies
    // uniformly to both grid sections; best-effort, not confirmed.
  },
  {
    id: 'swordfish', name: 'Swordfish', season: 2, rank: 18, copies: 2,
    fame: { base: 8 },
    typeTags: ['fish'],
    immune: ['flip'],
    rawBodyText: 'Flip the previous placed card unless it cannot be flipped, and flip the next revealed card unless it cannot be flipped',
    onPlace: [{ kind: 'flipPreviousPlaced' }, { kind: 'flipNextRevealed' }],
    // Encoded this pass by combining Elephant's flipPreviousPlaced (fires
    // immediately) and Eagle's flipNextRevealed (deferred pending) — both
    // primitives already existed, unmodified.
  },
  {
    id: 'gorilla', name: 'Gorilla', season: 2, rank: 19, copies: 2,
    fame: { base: 5 },
    rawBodyText: 'IF placed in the upper row, place the next revealed card in a row above',
    onPlace: [{ kind: 'moveNextRevealedToExtraRowIfUpperRow' }],
    faqNote:
      'FAQ: a second geometry-changing card alongside the Monkey; the extra row is not itself the "upper row" (so a card diverted there doesn\'t retrigger a Monkey/Gorilla check, and a Gorilla itself diverted into an extra row by an earlier Gorilla does not refire), and if a card is already above the gorilla/monkey, the new row forms above THAT CARD instead — extra rows stack. ' +
      'Implemented (this pass) atop grid.ts\'s extraRowSlotAbove/Grid.extraRows (types.ts), which replaced the old single-row Grid.extraRow specifically to support this unbounded stacking. Row-ordering reading — same column, growing upward — is documented at extraRowSlotAbove\'s definition; still not directly confirmed by the user, flagged there and in this pass\'s report.',
  },
  {
    id: 'vulture', name: 'Vulture', season: 2, rank: 20, copies: 1,
    fame: { base: 6 },
    rawBodyText: 'After the Market phase, dismiss the lowest rank card in your grid unless it cannot be dismissed',
    postMarketHook: { kind: 'dismissLowestRankInGrid' },
    faqNote: 'FAQ: ignored if the vulture itself has left the grid by then. "Unless it cannot be dismissed" is read as: find the lowest-rank face-up card in the grid FIRST, then no-op only if THAT card is immune — not "search among only the dismissible cards."',
  },
  {
    id: 'zebra', name: 'Zebra', season: 2, rank: 21, copies: 2,
    fame: { base: 5 },
    immune: ['return'],
    rawBodyText: 'Return the lowest rank card in your grid and place this card in its space',
    onPlace: [{ kind: 'returnLowestRankOrStack' }],
    // Encoded this pass — GRID-return with rank-based search targeting
    // (reading-order tiebreak on equal ranks; face-down cards are
    // automatically excluded since findLowestRankTarget only looks at
    // face-up cards, matching the FAQ without a special case). Falls back
    // to normal placement if there's no face-up card yet (covers "ignored
    // if zebra is the first card placed" the same way). See flip.ts's
    // resolveGridReturnTarget / findLowestRankTarget and the UNCONFIRMED
    // return-destination note on returnCardToDeckBottom.
  },
  {
    id: 'shark', name: 'Shark', season: 2, rank: 22, copies: 1,
    fame: { base: 3, bonuses: [{ kind: 'perQuery', query: 'fishTypeCard', amount: 1 }] },
    immune: ['flip'],
    // FAQ explicitly excludes the Shark itself from the fish type, unlike Goldfish/Starfish/Clownfish/Swordfish.
  },
  {
    id: 'rhinoceros', name: 'Rhinoceros', season: 2, rank: 23, copies: 1,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'adjacentOddRankCard', amount: 3 }] },
  },
  {
    id: 'hippopotamus', name: 'Hippopotamus', season: 2, rank: 24, copies: 1,
    fame: { base: 0, bonuses: [{ kind: 'perQuery', query: 'remainingDeckCard', amount: 2 }] },
  },
  {
    id: 'sloth', name: 'Sloth', season: 2, rank: 25, copies: 1,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'gridHasAtLeastEightCards', amount: 5 }] },
    onPlace: [{ kind: 'stackOnPreviousPlaced' }],
  },
  {
    id: 'platypus', name: 'Platypus', season: 2, rank: 26, copies: 2,
    fame: { base: 5, bonuses: [{ kind: 'ifCondition', condition: 'bigButtonCardFaceDown', amount: 3 }] },
    rawBannerText: 'WHEN HIRED, FLIP ALL BIG BUTTON CARDS FACE UP',
    unencodable: true,
    unencodableReason: '"big button card" is a component from the Big Button mini-expansion (see Referance/*.HEIC rulebook photos) that has no representation anywhere in the current rules model',
    // FLAG-AUDIT FINDING (this pass): unlike Axolotl (Season 1, same Big
    // Button gap), Platypus's FAME BONUS itself — not just its onHire
    // effect — references Big Button state ('bigButtonCardFaceDown'),
    // which scoreGrid cannot evaluate. Axolotl's fame is a plain number
    // (7) with no such reference, so `unencodable` alone was correct for
    // it. Platypus needs BOTH flags: `unencodable` for the onHire text
    // (unchanged) AND `fameUnencodable` here, because the fame VALUE
    // itself — not just an effect — can't be computed as a fixed number.
    // Without this flag, scoreGrid's computeCardFame would call
    // evaluateBonus on 'bigButtonCardFaceDown', which has no handler and
    // THROWS (score.ts's evaluateBonus fails loudly on any unrecognized
    // condition — verified: it does NOT silently skip a bonus and score a
    // wrong/lower total) — crashing the entire scoreGrid() call for any
    // grid containing a Platypus, not just returning a bad number for this
    // one card. Setting `fameUnencodable` routes it through score.ts's
    // needsRuling path instead, which blanks only this card's line
    // (total: 0, needsRuling: true) and lets the rest of the grid still
    // score normally.
    fameUnencodable: true,
    fameUnencodableReason:
      "fame bonus condition 'bigButtonCardFaceDown' references the Big Button mini-expansion component, which (like the rest of Big Button — see Axolotl, season1.ts) has no representation anywhere in the current rules model — deliberately NOT inventing one",
  },
]
