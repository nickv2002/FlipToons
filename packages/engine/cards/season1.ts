import type { Card } from './types'

// Transcribed from "Season 1 - Starters.jpeg" and "Season 1 cards.jpeg".
// Verbatim source text lives in cards.csv at the repo root — this file is
// the best-effort structured encoding of that transcription, not a
// re-transcription. Cross-check against cards.csv before trusting a number.
//
// `faqNote` fields quote the Season 1 rulebook's FAQ section, as transcribed
// (OCR) at rulespal.com/fliptoons/rulebook#faq and pasted in verbatim by the
// user 2026-08-15 — this is the actual rulebook FAQ text, not a paraphrase,
// and carries the same authority as the photographed Referance/*.HEIC pages.
// The rulebook's "Keywords" glossary (Adjacent/Dismiss/Flip/Stack/Stack
// Adjacency) is reproduced in full at the bottom of flip-toonz-structure-plan.md.

export const season1Cards: Card[] = [
  // --- Starting deck (rank 0, 6 cards total: 2x Caterpillar, 1x Skunk, 1x Dragonfly, 1x Bee, 1x Snail) ---
  {
    id: 'snail', name: 'Snail', season: 1, rank: 0, copies: 1,
    fame: { base: 2 },
  },
  {
    id: 'caterpillar', name: 'Caterpillar', season: 1, rank: 0, copies: 2,
    fame: { base: 0 },
    dismissCost: 3,
  },
  {
    id: 'dragonfly', name: 'Dragonfly', season: 1, rank: 0, copies: 1,
    fame: { base: 0, bonuses: [{ kind: 'perQuery', query: 'uniqueAdjacentName', amount: 1 }] },
    // Ruled by the user directly (2026-08-15): "unique" = distinct names among
    // orthogonally-adjacent cards (not unique within the whole grid). Resolves
    // structure-plan.md §7 question 4c.
  },
  {
    id: 'skunk', name: 'Skunk', season: 1, rank: 0, copies: 1,
    fame: { base: 0 },
    rawBodyText: 'If you have the least fame after the Check Fame phase, dismiss a card in your grid',
    postFameHook: {
      condition: 'strictlyLowestFame',
      mandatory: true,
      consumesAction: false,
      effect: { kind: 'dismiss', target: 'chooseOwnGridCard', cost: 0 },
    },
    faqNote: "FAQ: \"Only one player can benefit from the skunk's ability each round. In case of a tie, the skunk has no effect. The skunk's ability can be used to dismiss itself. This ability is mandatory and does not cost an action. If a player benefits from the skunk's ability, they still take up to two actions in the Market phase.\" Resolves structure-plan.md §7 question 4b's self-dismiss half; the face-up-in-grid-vs-anywhere-in-deck half is still open.",
  },
  {
    id: 'bee', name: 'Bee', season: 1, rank: 0, copies: 1,
    fame: { base: 1 },
  },

  // --- Market deck (55 total copies across 26 ranks) ---
  {
    id: 'ostrich', name: 'Ostrich', season: 1, rank: 1, copies: 3,
    fame: { base: 1 },
    onPlace: [{ kind: 'stackNextRevealed' }],
    rawBodyText: 'Stack the next revealed card on this card',
    faqNote: "FAQ: \"If an ostrich is placed as the final card of a player's grid, do not reveal or place another card. The next revealed card is stacked before its ability is resolved. If the next revealed card moves after being stacked on the ostrich, the next revealed card does not stack on the ostrich instead.\" This is an edge case on the base ability above (what happens when Ostrich fills the grid's final/6th slot) — not a general stop-reveals effect.",
  },
  {
    id: 'eagle', name: 'Eagle', season: 1, rank: 2, copies: 2,
    fame: { base: 4 }, // fame is fully encodable — only the onPlace effect was missing (see below)
    immune: ['flip'],
    onPlace: [{ kind: 'flipNextRevealed' }],
    rawBodyText: 'Flip the next revealed card unless it cannot be flipped (its ability does not activate)',
    faqNote: "FAQ: \"If an eagle is placed as the final card of a player's grid, do not reveal or place another card. Ignore any special effect or ability of the card flipped face down.\" Same edge-case pattern as Ostrich above. " +
      "IMPLEMENTATION NOTE: this final-slot edge case is handled for free by the flip loop's own isFull() check — if Eagle fills the grid's last slot, the loop exits before another card is drawn, so the pending flip effect is simply discarded, unapplied. This reading (that the 'do not reveal/place another card' sentence describes ONLY the final-slot case, not a general stop-reveals effect) matches the base ability text but is NOT confirmed against a photographed rulebook page beyond the rulespal.com FAQ transcription — see structure-plan.md §7 item 3.",
  },
  {
    id: 'donkey', name: 'Donkey', season: 1, rank: 3, copies: 2,
    fame: { base: 1, bonuses: [{ kind: 'ifCondition', condition: 'inLowerRow', amount: 5 }] },
    rawBodyText: 'If so, dismiss this card after the Market phase',
    postMarketHook: { kind: 'selfDismissIf', condition: 'inLowerRow' },
    // NOTE (deviation from the plan's illustrative sketch): the plan named
    // this variant `wasInLowerRow` (implying placement-time history is
    // tracked). This engine tracks no placement history at all — Mole/
    // Monkey/Coyote/Zebra/etc. can all relocate a card after the fact — so
    // this checks Donkey's CURRENT position at end-of-Market time instead,
    // and is named `inLowerRow` for what it actually evaluates.
    faqNote: "FAQ: \"If a donkey is placed in the upper row of a grid, it is not dismissed.\" Confirms the self-dismiss only fires for lower-row placement (matching the bonus condition's polarity above).",
  },
  {
    id: 'butterfly', name: 'Butterfly', season: 1, rank: 4, copies: 3,
    fame: { base: 2 },
    rawBannerText: 'When hired, you may dismiss a caterpillar for {{0}}',
    onHire: [{ kind: 'dismissByName', targetCardId: 'caterpillar', cost: 0 }],
    // NOTE (deviation from the plan's illustrative sketch): the plan wrote
    // `dismissByName: 'Caterpillar'` (display name). Every existing
    // target-matching primitive in this engine keys on CARD ID, not display
    // name (Rabbit's `matchCardId: CardId`, dogElsewhereFromMarket's literal
    // 'dog') — so this uses `targetCardId: 'caterpillar'` for consistency.
    faqNote: "FAQ: \"The butterfly's ability may only dismiss a face-up caterpillar in the player's grid.\"",
  },
  {
    id: 'dog', name: 'Dog', season: 1, rank: 5, copies: 4,
    fame: { base: 0, bonuses: [{ kind: 'ifCondition', condition: 'dogInMarketOrOtherPlayerGrid', amount: 5 }] },
    faqNote: "FAQ: \"Fame generated by the dog is not affected by changes to the market in the Market phase.\" Same locked-at-Check-Fame pattern used for Capybara/Hippopotamus/Fox in Season 2.",
    // DOG-SPECIFIC EXTERNAL STATE (this pass — see score.ts's scoreGrid):
    // the fame bonus condition 'dogInMarketOrOtherPlayerGrid' reaches the
    // shared market and every OTHER player's grid — state a single-grid
    // scoreGrid call doesn't have on its own. Rather than block it behind
    // `fameUnencodable` (needsRuling/0 unconditionally, as it was before
    // this pass), this is now a normal, fully-encodable fame rule that
    // reads an EXPLICIT external parameter (`externalState.dogElsewhere`
    // in scoreGrid) instead of grid state. When that parameter is omitted,
    // scoreGrid computes and shows BOTH branches (see FameLine.dualBranch)
    // rather than guessing or blanking. This dual-branch shape is
    // deliberately Dog-only — its condition is the one case with zero
    // local content (it can't check its own grid, since the condition is
    // ABOUT other Dogs). Camel and Fox reach the same
    // externalState.<field> pattern via a plain throw-when-missing
    // parameter instead (see score.ts's Camel/Fox header comments); only
    // Platypus (Big Button, a missing physical component) still stays
    // fameUnencodable.
  },
  {
    id: 'goat', name: 'Goat', season: 1, rank: 6, copies: 2,
    fame: { base: 1, bonuses: [{ kind: 'ifCondition', condition: 'inUpperRow', amount: 3 }] },
    faqNote: "FAQ: \"If a monkey creates a new row above the upper row, the goat's ability still activates.\" I.e. the Season 2 FAQ's 'an extra row is not the upper row' rule (which governs whether Monkey/Gorilla retrigger) does not disable Goat's own upper-row bonus.",
  },
  {
    id: 'sheep', name: 'Sheep', season: 1, rank: 7, copies: 2,
    fame: { base: 1, bonuses: [{ kind: 'ifCondition', condition: 'inMiddleColumn', amount: 4 }] },
  },
  {
    id: 'camel', name: 'Camel', season: 1, rank: 8, copies: 5,
    fame: { base: 2, bonuses: [{ kind: 'ifCondition', condition: 'noOneHasMoreCamelsThanYou', amount: 2 }] },
    faqNote: "FAQ: \"If there is a tie for most camels in the players' grids and/or the market, all tied players' camels generate four fame.\" Confirms the condition is 'no one else has STRICTLY MORE camels than you' — ties still qualify.",
    // 'noOneHasMoreCamelsThanYou' needs the shared market plus every OTHER
    // player's grid — same missing-state category as Dog above. Solo has no
    // other players (same reduction Dog's own solo resolution uses), so
    // this reduces to "your grid's Camel count >= the market's Camel
    // count" — fully encodable via scoreGrid's externalState.camelMarketCount
    // (see score.ts's evaluateBonus and phases.ts's runCheckFame), the same
    // explicit-external-parameter pattern as Dog's dogElsewhere, not
    // fameUnencodable.
  },
  {
    id: 'rabbit', name: 'Rabbit', season: 1, rank: 9, copies: 4,
    fame: { base: 3 },
    immune: ['flip'],
    onPlace: [{ kind: 'stackOnFirstMatchOrFaceDown', matchCardId: 'rabbit' }],
    rawBodyText: 'Stack this card on the first Rabbit or face-down card in your grid',
    // UNCONFIRMED ASSUMPTION (flagged here and in flip.ts's
    // findRabbitOrFaceDownTarget): if no face-up Rabbit and no face-down
    // card exist anywhere in the grid yet, this Rabbit is placed in the
    // next empty base slot as normal. The card text doesn't say what
    // happens when the search comes up empty.
  },
  {
    id: 'horse', name: 'Horse', season: 1, rank: 10, copies: 2,
    fame: { base: 4 },
    rawBannerText: 'When hired, discard any number of cards in the market and refill',
    onHire: [{ kind: 'discardMarketAndRefill' }],
    faqNote: 'FAQ: "If a player hires a horse, immediately discard any number of cards in the market, reveal an equal number of new cards from the deck, and arrange them by rank. Place the discarded cards face-up next to the toon deck." Refill count equals the number discarded, not a top-up to full width.',
  },
  {
    id: 'snake', name: 'Snake', season: 1, rank: 11, copies: 2,
    fame: { base: 1 },
    rawBodyText: 'Dismiss the top card of your deck and stack the top card from the toon deck on this card',
    onPlace: [{ kind: 'dismissOwnDeckTopAndStackFromToonDeck' }],
    // Fully encoded: the own-deck-top dismissal (with its immune-target
    // fallback), the unconditional toon-deck draw stacked face-up onto
    // Snake's own slot, and the FAQ's nested "if the stacked card has a
    // When-Hired ability (Peacock/Rabbit/Turkey), resolve it after the Flip
    // phase" chain. Rabbit/Turkey need no special handling — the FAQ's
    // "stack it on the snake" for them just confirms they do nothing extra
    // beyond the normal face-up placement above. Peacock's onHire (+2 fame,
    // +1 Market action) is deferred via GameState.pendingOnHireCardIds and
    // resolved in phases.ts's runPostFameHooks, since it must fire after
    // Check Fame or that phase's snapshot would clobber it — see
    // flip.ts's 'dismissOwnDeckTopAndStackFromToonDeck' case for the full
    // reasoning.
    faqNote: "FAQ: \"If the card on top of the player's deck cannot be dismissed, place it to the right of the snake instead, or return it to the player's deck if the snake is in the final space of the player's grid.\" (cont'd) \"If the player places a card with a 'When Hired' ability due to the snake's ability, resolve it after the Flip phase is complete. If the stacked card is a peacock, add the fame to the player's total and take an additional action in the Market phase. If it is a rabbit or turkey, stack it on the snake. If a player's deck is depleted before revealing the snake, you still stack a card from the deck on the snake, even though no card is dismissed.\"",
  },
  {
    id: 'elephant', name: 'Elephant', season: 1, rank: 12, copies: 2,
    fame: { base: 7 }, // fully encodable — only the onPlace effect was missing
    immune: ['flip'],
    onPlace: [{ kind: 'flipPreviousPlaced' }],
    rawBodyText: 'Flip the previous placed card unless it cannot be flipped',
    faqNote: 'FAQ: "If an elephant is the first card placed in a player\'s grid, ignore its ability. The elephant flips the last placed card, even if that card has moved to a new position." Matches the Season 2 rulebook\'s general "Previous Placed Card" glossary entry. Implemented via a {cardId, pos, index} pointer tracked through the flip loop (flip.ts) rather than a name-based search, so it correctly follows a card through relocation (e.g. Monkey moving into extraRow) and isn\'t confused by a duplicate-named card placed earlier in the same grid.',
  },
  {
    id: 'rooster', name: 'Rooster', season: 1, rank: 13, copies: 2,
    fame: { base: 0, bonuses: [{ kind: 'ifCondition', condition: 'perCardRank13OrLowerIncludingSelf', amount: 1 }] },
  },
  {
    id: 'cat', name: 'Cat', season: 1, rank: 14, copies: 2,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'dismissedStartingCard', amount: 1 }] },
    immune: ['dismiss'],
    // Fully encodable now that GameState.dismissed exists and is threaded
    // into scoreGrid via externalState.dismissed (score.ts) — see
    // runCheckFame in phases.ts. Cat is immune: ['dismiss'], so it can never
    // appear in its own dismissed pile.
  },
  {
    id: 'alligator', name: 'Alligator', season: 1, rank: 15, copies: 2,
    fame: { base: 6 },
    rawBodyText: 'After the Market phase, dismiss one card adjacent to the right of this card',
    postMarketHook: { kind: 'dismissAdjacentRight' },
    faqNote: 'FAQ: "The target of the alligator\'s ability generates fame in the Check Fame phase which can be spent in the Market phase, even though the target is dismissed at the end of the Market phase. If the target of the alligator\'s ability is a stack, dismiss any one card in the stack. If dismissed during the market phase, the alligator no longer dismisses a card." Confirms the dismissal happens strictly after Market actions are spent, and that stacks give a choice of which card to dismiss.',
  },
  {
    id: 'lion', name: 'Lion', season: 1, rank: 16, copies: 2,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'allFaceUpAdjacentRank16OrLower', amount: 4 }] },
  },
  {
    id: 'monkey', name: 'Monkey', season: 1, rank: 17, copies: 2,
    fame: { base: 3 }, // fully encodable — the extra-row relocation is now implemented (flip.ts's 'moveToExtraRowIfUpperRow')
    onPlace: [{ kind: 'moveToExtraRowIfUpperRow' }],
    rawBodyText: 'If placed in the upper row, move this card to a row above',
    faqNote: "FAQ: \"When a monkey is placed in the upper row of a player's grid, move the card above the upper row, creating an additional row. Place the next revealed card in the space the monkey was originally placed. This additional row is considered part of the player's grid, but does not fill one of the six slots of the player's grid and is not considered the 'upper row'.\" The 'place the next revealed card in the vacated space' half of this falls out automatically from nextEmptyBaseSlot() re-finding that slot once Monkey vacates it — no special-case code needed for that part.",
  },
  {
    id: 'pig', name: 'Pig', season: 1, rank: 18, copies: 1,
    fame: { base: -1 },
    rawBannerText: 'When hired or dismissed, place this card in any deck',
    // Encodable as of the multiplayer work: 'placeSelfInAnyDeck' detaches the
    // card and match.ts asks which deck it goes into (any seat's, or the toon
    // deck — reshuffled if so, per the FAQ below). Still never comes up in
    // solo, where setup excludes the Pig from the toon deck entirely.
    onHire: [{ kind: 'placeSelfInAnyDeck' }],
    onDismiss: [{ kind: 'placeSelfInAnyDeck' }],
    faqNote: 'FAQ: "The pig can be placed in any player\'s deck or back in the toon deck. Shuffle the deck if placed in the toon deck." Note: solo-play setup removes the Pig from the toon deck entirely (Referance rulebook photos) — this ability presumably doesn\'t come up in solo.',
  },
  {
    id: 'peacock', name: 'Peacock', season: 1, rank: 19, copies: 2,
    fame: { base: 5 },
    rawBannerText: 'When hired, gain {{2}} and take a bonus market action',
    onHire: [{ kind: 'gainFame', amount: 2 }, { kind: 'bonusMarketAction', amount: 1 }],
    // The +2 fame here touches spendable `fame` only, never
    // `fameGeneratedThisRound` (the frozen Check-Fame win-trigger snapshot)
    // — see applyEffects's 'gainFame' case in phases.ts.
  },
  {
    id: 'turkey', name: 'Turkey', season: 1, rank: 20, copies: 2,
    fame: { base: 5 },
    rawBodyText: 'Stack this card on the last card placed',
    onPlace: [{ kind: 'stackOnPreviousPlaced' }],
    faqNote: 'FAQ: "If a turkey is the first card placed in a player\'s grid, ignore its ability. A turkey is stacked on the last placed card, even if that card has moved to a new position in the grid." Matches Elephant\'s parallel clarification above.',
  },
  {
    id: 'bull', name: 'Bull', season: 1, rank: 21, copies: 1,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'atLeastOneFaceDownCardInGrid', amount: 7 }] },
    immune: ['flip'],
  },
  {
    id: 'tiger', name: 'Tiger', season: 1, rank: 22, copies: 1,
    fame: { base: 3, bonuses: [{ kind: 'perQuery', query: 'dismissedCard', amount: 1 }] },
    immune: ['dismiss'],
    // Fully encodable now — same 'externalState.dismissed' path as Cat
    // above. Tiger is immune: ['dismiss'], so it can never appear in its
    // own dismissed pile.
  },
  {
    id: 'deer', name: 'Deer', season: 1, rank: 23, copies: 1,
    fame: { base: 3, bonuses: [{ kind: 'ifCondition', condition: 'allFaceUpGridCardsUnique', amount: 5 }] },
  },
  {
    id: 'bear', name: 'Bear', season: 1, rank: 24, copies: 1,
    fame: { base: 1, bonuses: [{ kind: 'perQuery', query: 'faceUpGridCard', amount: 1 }] },
    faqNote: 'FAQ: "The bear counts all face-up stacked cards as well as itself." Confirms every face-up card across every stack counts, not one per slot.',
  },
  {
    id: 'cow', name: 'Cow', season: 1, rank: 25, copies: 1,
    fame: { base: '=' },
    rawBodyText: 'Copy the fame of one adjacent card',
    // Cow has NO onPlace/onHire/onDismiss effect at all — "copy the fame of
    // one adjacent card" is purely a FAME RULE, not a grid mutation. Per a
    // direct ruling from the user, this is DETERMINISTIC, not a player
    // choice: Cow's fame equals the MAXIMUM fame among its adjacent
    // face-up cards (stacks expanded — "may copy any one card's fame in
    // the stack" collapses to "copies the best one" for a rational player).
    // `fame.base === '='` alone is what scoreGrid keys off to run the
    // Cow-shaped resolution path (see score.ts's resolution pass 2) — no
    // `fameUnencodable` flag needed now that the value is deterministic.
    faqNote: 'FAQ: "If there is a stack adjacent to a cow, you may copy any one card\'s fame in the stack." Target selection reaches into a whole adjacent stack, not just its top card — read together with the user\'s ruling above, this means every face-up member of an adjacent stack is a separate candidate for the max, not just the top card.',
  },
  {
    id: 'axolotl', name: 'Axolotl', season: 1, rank: 26, copies: 2,
    fame: { base: 7 },
    rawBannerText: 'When hired, flip your Big Button card face up',
    // The Big Button mini-expansion is now modelled (state.ts's
    // PlayerState.bigButtonFaceUp / SharedState.resetEffect, and
    // bigButton.ts), so this is no longer `unencodable`. Axolotl is the
    // SEASON 1 half of the pair; Platypus (season2.ts) is the Season 2 half.
    // Only the Season 2 setup card is photographed (Referance/IMG_4308.HEIC,
    // marked "2" and naming platypus); the Season 1 pairing is inferred by
    // symmetry — same rank 26, same copies 2, same banner shape — the same
    // "best available reading" the solo Season 2 starting deck is built on
    // (setup.ts's buildSeason2SoloStartingDeck).
    //
    // With no reset effect in play (SharedState.resetEffect === null) this
    // effect still resolves — it just sets a flag nothing consults — and
    // setup.ts keeps Axolotl out of the toon deck entirely in that case, so
    // it can never actually be hired.
    onHire: [{ kind: 'flipOwnBigButtonFaceUp' }],
  },
]
