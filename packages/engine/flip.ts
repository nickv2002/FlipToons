// The Flip loop, per flip-toonz-structure-plan.md §3.2 / §3.3:
//   shuffle deck face-down
//   reveal one card at a time into the grid, left to right, top row then
//     bottom row, into the next unoccupied BASE slot
//   placement abilities resolve BEFORE the next card is revealed
//   repeat until all six base slots are occupied, or the deck is exhausted
//     (place as many as possible)
//
// Season-agnostic (§10) — takes CardIds and Card data, never branches on
// Card.season.
//
// This pass implements the `onPlace` effect vocabulary needed by Season 1's
// Ostrich, Eagle, Rabbit, Elephant, Turkey, and Monkey (see cards/types.ts's
// PlaceEffect comments). Two pieces of loop state make these possible:
//
//   - `pending`: a deferred effect set by a card's own onPlace resolution
//     that applies to whichever card gets revealed NEXT (Ostrich/Eagle).
//   - `lastPlaced`: a pointer — {cardId, pos, index}, NOT a bare position —
//     to the most recently placed card, kept up to date across relocation
//     (Monkey moving itself) so Elephant/Turkey can find "the previous
//     placed card, even if it has since moved" (§7 4a/the Elephant/Turkey
//     FAQ notes) without an ambiguous search-by-CardId (CardId is a card
//     TYPE id, not a per-copy instance id — two Ostrich copies in one grid
//     would make a name-based search ambiguous).
//
// Any onPlace effect kind this pass doesn't implement still throws loudly
// (rather than silently no-op'ing) — a card that reaches the loop with an
// effect kind nobody's handled would otherwise flip fine but silently do
// nothing, which is worse than a crash.

import type { Card, CardId } from './cards/types'
import { emptyGrid, extraRowSlotAbove, getSlot, isFull, nextEmptyBaseSlot, occupiedSlots, placeCardFaceUp, setSlot } from './grid'
import type { Deck, Grid, GridPos, Slot } from './types'

// Group 3 addition (Snake/Mongoose) — the shared toon deck and dismissed
// pile flipDeck needs to reach into for its two toonDeck-threading cards.
// Same convention as `remainingDeck`: flipDeck clones these at entry and
// mutates the clones, never the caller's arrays.
export type FlipContext = {
  toonDeck: CardId[]
  dismissed: CardId[]
}

export type FlipResult = {
  grid: Grid
  remainingDeck: Deck
  toonDeck: CardId[]
  dismissed: CardId[]
  // Set true iff a Snake/Mongoose toon-deck draw DURING this Flip drained
  // the toon deck to empty. Diagnostic only — these draws are optional/
  // bonus (an already-empty toon deck is explicitly not an error here, see
  // the 'stackToonDeckDraw'/'dismissOwnDeckBottomAndDrawToonDeckTop' cases
  // below), so unlike a Market-phase refill's `short`, this does NOT feed
  // GameState.toonDeckDepleted — only an actual failed/needed draw
  // (refillMarket's `short`) ends the game (house rule, see state.ts's
  // toonDeckDepleted comment).
  toonDeckEmptiedDuringFlip: boolean
  // Cards drawn face-up onto the grid via Snake's toon-deck stack (below)
  // that themselves carry onHire effects — Peacock, currently the only
  // card in the table that qualifies. The card is already scored normally
  // through the ordinary face-up-in-grid path; this is ONLY the queue for
  // its separate onHire-shaped bonus effects (Peacock's +2 fame / extra
  // Market action), which the FAQ says resolve "after the Flip phase is
  // complete" — i.e. too late to fire here, during Flip itself. Consumed
  // by phases.ts's runPostFameHooks, which is the next phase-machine step
  // after Flip that can safely add to `fame`/`actionsRemaining` without
  // Check Fame's snapshot immediately overwriting it.
  pendingOnHireCardIds: CardId[]
  // Player-facing log lines for events the post-Flip grid can't explain by
  // itself — see applyOnPlaceEffects's `notes` param comment. Consumed by
  // actions.ts's advanceThroughPassthroughPhases right after the "flip
  // order" preview line.
  flipNotes: string[]
  // Verbose per-card trace of target-determination and redirect decisions —
  // the same information flipNotes summarizes for the player, but complete
  // and mechanical rather than curated, for diagnosing surprising card
  // interactions (e.g. why a card ended up in an unexpected stack after a
  // return/relocate chain). See flipDeck's debugNotes comment.
  debugNotes: string[]
}

type CardPointer = { cardId: CardId; pos: GridPos; index: number }

type Pending =
  | { kind: 'stack'; pos: GridPos }
  | { kind: 'flip' }
  | { kind: 'returnIfRankAtMost'; maxRank: number }
  | { kind: 'moveToExtraRow'; col: number } // Gorilla — see applyOnPlaceEffects's 'moveNextRevealedToExtraRowIfUpperRow'
  | null

// RETURN (Salamander/Coyote/Crab/Zebra, Season 2). CONFIRMED against the
// physical Season 2 rulebook's "Keywords" page (Referance/IMG_4309.HEIC,
// read directly 2026-08-15, not FAQ/OCR): "Return: Place a card face down
// on the bottom of a player's deck. If a player's deck has no cards when a
// card is returned, the returned card becomes their deck and they continue
// their Flip phase if any empty slots remain in their grid." Bottom-of-deck
// was the reading already implemented here (previously flagged unconfirmed,
// now settled) — see below for why bottom (not top) was chosen even before
// this confirmation.
//
// BOTH remaining details from that Keywords quote are now reflected here,
// confirmed rather than open:
//
// (1) FACE DOWN. `Deck` (types.ts) is `CardId[]` — it carries no per-card
//     face state, only `Slot.faceUp` (a GRID concept) does. Per the Flip
//     keyword's own definition, "face down" only has teeth for a card that
//     "takes a slot in a player's grid" — a card sitting in a deck occupies
//     no slot and generates no fame either way, so there's no state left
//     for "face down" to change once the card leaves the grid. §6's "Deck
//     secrecy: deliberately not a concern" confirms nothing in this engine
//     ever treats deck contents as hidden or specially-marked, for any
//     card. So "face down" here reads as "not shown to other players while
//     it sits in the deck" (an out-of-model UI/fairness note, not rules
//     state) rather than a flag that persists and changes how the card
//     resolves on its next draw — when redrawn, it goes through the exact
//     same `placeCardFaceUp` path as any other card and reveals face-up
//     with its abilities intact. This is NOT a silent pick: the one case
//     where the two readings would observably diverge is a card that gets
//     RETURNED WHILE ALREADY FACE-DOWN IN THE GRID (e.g. Eagle's
//     flipNextRevealed flips X face-down, X becomes `lastPlaced`, then a
//     Coyote/Zebra later returns X) — reachable today, not hypothetical.
//     Under the "face-down state persists into the deck" reading, X would
//     have to come back out face-down (or need a whole new re-flip
//     ability to reveal it, which no card grants); under this engine's
//     reading, X simply redraws face-up like anything else, which is the
//     behavior implemented below (returnCardToDeckBottom takes only a
//     CardId, discarding whatever face state the card had in the grid —
//     there is nothing else it could do, since Deck has no field to put a
//     face state in).
// (2) THE EMPTY-DECK SPECIAL CASE — "a lone returned card becomes the
//     deck, and the Flip phase continues if slots remain" — falls out of
//     the plain-array model for free, with no special-case code: Return
//     only ever fires as part of resolving a card that was JUST drawn via
//     `remainingDeck.shift()`, and `returnCardToDeckBottom`'s push happens
//     synchronously within that same iteration, before flipDeck's `while`
//     loop re-checks `remainingDeck.length > 0`. So if the shift that
//     triggered a Return happened to drain the deck to zero, the push puts
//     it right back to one, and the loop's own condition is what "the
//     Flip phase continues" resolves to — there's no separate exhausted
//     state to special-case around. See season2-effects.test.ts's "Return
//     while the deck is empty" test for a traced example (Coyote drawn as
//     the deck's last card, returning the previously-placed card, which
//     becomes the sole remaining deck and gets redrawn to complete the
//     grid).
//
// The "optional or mandatory" question the user raised is still open —
// this Keywords entry doesn't say either way; each card's own text/FAQ
// (e.g. "unless it cannot be returned") governs applicability, but none of
// the transcribed text marks Return as a player choice the way the
// Skunk's dismissal is "you may."
//
// An earlier draft of this primitive tried "top of deck, redrawable
// immediately" instead (simpler on its face, and matches how "the top card
// of your deck" is referenced elsewhere in this card set — Snake,
// Mongoose). It was rejected by a concrete falsification, not just a
// preference: Crab returns ITSELF, so it vacates its own slot rather than
// immediately refilling it the way Coyote/Zebra do. Combined with
// nextEmptyBaseSlot() always refilling the leftmost-topmost empty slot,
// "redrawable immediately" meant ANY single Crab landing in the middle
// column — not just an all-crab deck — would redraw itself into the exact
// same slot and loop forever. Season 2's own Crab entry (season2.ts)
// preserves a paraphrase from cards.csv's transcription notes, "end Flip
// phase leaving crab(s) in deck," describing the FAQ's stall condition as
// scoped to an ALL-CRAB deck specifically. Bottom-of-deck reproduces
// exactly that scope: a lone Crab's slot gets filled by whatever's next in
// line (no stall), while a deck of nothing but Crabs cycles every
// remaining copy through the middle column forever (a genuine stall) — see
// season2-effects.test.ts's Crab tests for both cases. Top-of-deck predicts
// a strictly broader stall than the rulebook describes, which is why this
// pass settled on bottom instead — still not a confirmed rule, still needs
// a direct ruling (see this pass's report), just the better-supported of
// the two candidates.
function returnCardToDeckBottom(remainingDeck: Deck, cardId: CardId): void {
  remainingDeck.push(cardId)
}

// Removes a single card from a slot (splice, not the whole slot), nulling
// the slot out if that was its last card — the same vacate bookkeeping
// relocateCard does on its `from` side, factored out for reuse by every
// "return" effect (which removes a DIFFERENT card than the one being
// placed, so relocateCard's move-and-place shape doesn't fit).
function removeCardFromSlot(grid: Grid, pos: GridPos, index: number): void {
  const slot = getSlot(grid, pos)
  if (!slot) throw new Error(`flip.ts: removeCardFromSlot — no slot at ${JSON.stringify(pos)}`)
  slot.cards.splice(index, 1)
  slot.faceUp.splice(index, 1)
  if (slot.cards.length === 0) setSlot(grid, pos, null)
}

// Shared resolution for Coyote/Zebra's "return TARGET and take its slot,
// unless TARGET is immune to 'return', in which case stack on it instead."
// Returns the GridPos the acting card (Coyote/Zebra) should be placed at —
// TARGET's slot either way, now-empty (returned) or still-occupied (stack
// fallback, so placeCardFaceUp's default stack-on-top behavior takes over).
function resolveGridReturnTarget(
  grid: Grid,
  cardsById: Record<CardId, Card>,
  remainingDeck: Deck,
  target: CardPointer,
  actorCard: Card,
  notes: string[],
  debugNotes: string[],
): GridPos {
  const targetCard = cardsById[target.cardId]
  if (!targetCard) throw new Error(`flip.ts: resolveGridReturnTarget — unknown card id ${target.cardId}`)
  if (targetCard.immune?.includes('return')) {
    notes.push(`${actorCard.name} can't return ${targetCard.name} at ${posLabel(target.pos)} (immune) — stacks on it instead.`)
    debugNotes.push(`${actorCard.name}: return target ${targetCard.name} at ${posLabel(target.pos)} is immune to return — falling back to stack`)
    return target.pos // "if it cannot be returned, stack ... on it instead" — leave the slot occupied, caller stacks on top
  }
  removeCardFromSlot(grid, target.pos, target.index)
  returnCardToDeckBottom(remainingDeck, target.cardId)
  notes.push(`${actorCard.name} returns ${targetCard.name} to the bottom of the deck and takes its place at ${posLabel(target.pos)}.`)
  debugNotes.push(`${actorCard.name}: returned ${targetCard.name} (was at ${posLabel(target.pos)}) to deck bottom, takes that slot`)
  return target.pos
}

// Searches every FACE-UP card in the grid (base + extraRow, stacks
// expanded — face-down cards "have no ... rank" per the Season 1 rulebook's
// Flip keyword, so they're never valid targets, matching Zebra's FAQ) for
// the lowest `rank`, in reading order (occupiedSlots' base-row-major-then-
// extraRow order, then bottom-to-top within a slot) as the tiebreak, same
// convention as Rabbit's search. Returns null if there is no face-up card
// anywhere (covers "ignored if zebra is the first card placed" for free —
// no special case needed).
//
// UNCONFIRMED: occupiedSlots() includes extraRow, so this search can find
// (and Zebra can return-and-take-the-place-of) a card sitting in a Monkey/
// Gorilla-created extra row — meaning Zebra could end up occupying the
// extra row itself, outside the six base slots. Arguably consistent with
// the rulebook FAQ's "this additional row is considered part of the
// player's grid" (Monkey's entry), but it's untested and not confirmed
// against any Zebra-specific source.
function findLowestRankTarget(grid: Grid, cardsById: Record<CardId, Card>): CardPointer | null {
  let best: CardPointer | null = null
  let bestRank = Infinity
  for (const { pos, slot } of occupiedSlots(grid)) {
    for (let i = 0; i < slot.cards.length; i++) {
      if (!slot.faceUp[i]) continue
      const cardId = slot.cards[i]
      const card = cardsById[cardId]
      if (!card) throw new Error(`flip.ts: findLowestRankTarget — unknown card id ${cardId}`)
      if (card.rank < bestRank) {
        bestRank = card.rank
        best = { cardId, pos, index: i }
      }
    }
  }
  return best
}

function toBasePos(rc: { row: number; col: number }): GridPos {
  return { section: 'base', row: rc.row, col: rc.col }
}

function isImmuneTo(card: Card, immunity: 'flip'): boolean {
  return card.immune?.includes(immunity) ?? false
}

// Single choke point for moving an already-placed card to a different slot,
// so every relocating effect (today: only Monkey) keeps `lastPlaced` correct
// automatically instead of every call site having to remember to. Removes
// the moved card from `from` (nulling the base slot if it's now empty —
// extraRow slots are left as empty stacks the same way) and places it
// face-up at `to`. Returns the new pointer.
function relocateCard(grid: Grid, from: GridPos, fromIndex: number, to: GridPos, cardId: CardId): CardPointer {
  const fromSlot = getSlot(grid, from)
  if (!fromSlot) throw new Error(`flip.ts: relocateCard — no slot at source position ${JSON.stringify(from)}`)
  fromSlot.cards.splice(fromIndex, 1)
  fromSlot.faceUp.splice(fromIndex, 1)
  if (fromSlot.cards.length === 0) setSlot(grid, from, null)

  placeCardFaceUp(grid, to, cardId)
  const toSlot = getSlot(grid, to)!
  return { cardId, pos: to, index: toSlot.cards.length - 1 }
}

// Searches base slots only, in reading order, per Rabbit's "Stack this card
// on the first RABBIT or face-down card in your grid." Two UNCONFIRMED
// reading calls, flagged in season1.ts and here:
//   - only the base grid is searched, not extraRow (no test needs it)
//   - "a face-down card" checks every card in a slot, not just the top of a
//     stack, since a face-down card contributes nothing regardless of depth
// Returns null if no such slot exists, in which case the caller falls back
// to the next empty base slot (also unconfirmed — the card text doesn't say
// what happens if the search comes up empty).
function findRabbitOrFaceDownTarget(grid: Grid, matchCardId: CardId): GridPos | null {
  for (let row = 0; row < grid.base.length; row++) {
    for (let col = 0; col < grid.base[row].length; col++) {
      const slot = grid.base[row][col]
      if (!slot) continue
      const hasMatch = slot.cards.some((id, i) => id === matchCardId && slot.faceUp[i])
      const hasFaceDown = slot.faceUp.some((fu) => !fu)
      if (hasMatch || hasFaceDown) return { section: 'base', row, col }
    }
  }
  return null
}

function hasOnPlaceKind(card: Card, kind: string): boolean {
  return (card.onPlace ?? []).some((e) => e.kind === kind)
}

// Resolves a card's own onPlace effects, AFTER it has been placed at `pos`
// (index `index` in that slot). Mutates `grid`/`remainingDeck` as needed and
// returns a `pending` value to install for the NEXT card revealed (or null),
// plus a possibly-updated `lastPlaced` pointer (only Monkey's relocation
// changes it away from the trivial {cardId, pos, index} the caller already
// computed).
function applyOnPlaceEffects(
  card: Card,
  grid: Grid,
  remainingDeck: Deck,
  toonDeck: CardId[],
  dismissed: CardId[],
  cardsById: Record<CardId, Card>,
  ctx: { pos: GridPos; index: number; previousPlaced: CardPointer | null; selfPointer: CardPointer },
  // Player-facing log lines for the two toon-deck-threading effects below
  // (Snake/Mongoose) — the only onPlace effects that consume/produce cards
  // the grid display alone can't explain (a dismissed deck-bottom card and a
  // drawn toon-deck card are both invisible to the post-Flip grid view).
  // Every other onPlace effect kind is fully legible from the grid itself
  // (a stack, a relocation, a face-down flip all show up there directly), so
  // this stays narrowly scoped to these two rather than becoming a general
  // per-effect log — see actions.ts's advanceThroughPassthroughPhases.
  notes: string[],
  debugNotes: string[],
): { pending: Pending; lastPlaced: CardPointer | null; toonDeckEmptied: boolean; onHireDeferredCardId: CardId | null } {
  let pending: Pending = null
  let lastPlaced: CardPointer | null = ctx.selfPointer
  let toonDeckEmptied = false
  let onHireDeferredCardId: CardId | null = null

  for (const effect of card.onPlace ?? []) {
    switch (effect.kind) {
      case 'stackNextRevealed': {
        // Ostrich: the NEXT revealed card stacks on Ostrich's own position.
        // Per the rulebook FAQ, the stacked card's own ability still
        // resolves afterward — Ostrich only reorders WHERE it lands, unlike
        // Eagle below, which suppresses the target's ability outright.
        pending = { kind: 'stack', pos: ctx.pos }
        break
      }
      case 'flipNextRevealed': {
        // Eagle: the NEXT revealed card gets flipped face-down unless
        // immune — see the immunity check in flipDeck, which is where this
        // is actually resolved (it depends on the target card, not Eagle).
        pending = { kind: 'flip' }
        break
      }
      case 'moveToExtraRowIfUpperRow': {
        // Monkey — confirmed by the card's own text and the rulebook FAQ
        // (§3.3, §7 4a): "IF placed in the upper row, move this card to a
        // row above." Only fires when Monkey landed in base row 0; a
        // lower-row Monkey has no effect. Two Monkeys (or a Monkey and a
        // Gorilla) landing in the upper row in the same column across a
        // round now stack vertically rather than collide — see
        // extraRowSlotAbove's row-ordering-reading comment in grid.ts for
        // the (still-unconfirmed) reasoning.
        if (ctx.pos.section === 'base' && ctx.pos.row === 0) {
          const to = extraRowSlotAbove(grid, ctx.pos.col)
          lastPlaced = relocateCard(grid, ctx.pos, ctx.index, to, card.id)
        }
        break
      }
      case 'moveNextRevealedToExtraRowIfUpperRow': {
        // Gorilla (Season 2, rank 19) — "IF placed in the upper row, place
        // the next revealed card in a row above." Same deferred "next
        // revealed card" primitive as Ostrich/Eagle above, but the target
        // that gets relocated is a DIFFERENT card (the next one revealed),
        // not Gorilla itself — Gorilla stays put in base row 0. Only fires
        // when Gorilla landed in base row 0; a lower-row Gorilla has no
        // effect, matching Monkey's own-relocation condition above.
        //
        // Not suppressing the diverted card's own onPlace ability: Gorilla's
        // text doesn't say "its ability does not activate" the way Eagle's
        // does — that phrase is specific to Eagle's card, not a property of
        // "next revealed card" effects in general (Ostrich's stacked target
        // also keeps its own ability). So the diverted card resolves
        // normally once it lands in the extra row, same as Ostrich's case.
        if (ctx.pos.section === 'base' && ctx.pos.row === 0) {
          pending = { kind: 'moveToExtraRow', col: ctx.pos.col }
        }
        break
      }
      case 'flipPreviousPlaced': {
        // Elephant: flips the LAST PLACED CARD (by identity, not position —
        // see the CardPointer comment above), unless it's immune to flip,
        // or this is the first card placed this Flip (FAQ: "if an elephant
        // is the first card placed in a player's grid, ignore its ability").
        // The actual check + flip needs `cardsById` (to read the target's
        // `immune` list), which this function doesn't have — it's performed
        // inline in flipDeck's main loop instead, right before this
        // function is called. Nothing to do here.
        break
      }
      case 'stackOnPreviousPlaced':
      case 'stackOnFirstMatchOrFaceDown':
      case 'returnPreviousPlacedOrStack':
      case 'returnLowestRankOrStack': {
        // All four are TARGET-DETERMINATION effects (they decide where the
        // card lands in the first place, including — for the return pair —
        // mutating some OTHER card out of the grid before this card takes
        // its slot), resolved in determineTarget BEFORE placement, not
        // here. Nothing left to do once the card is already sitting in the
        // right slot.
        break
      }
      case 'stackOnAboveIfLowerRow': {
        // Mole (Season 2, rank 5): "IF placed in the lower row, stack this
        // card on the card above." A POSITIONAL target, not an
        // identity-tracked one — the flip loop always fills base row 0
        // before row 1 (nextEmptyBaseSlot scans row-major), so by the time
        // any card lands in the lower row, the slot directly above it is
        // already occupied.
        if (ctx.pos.section === 'base' && ctx.pos.row === 1) {
          const above: GridPos = { section: 'base', row: 0, col: ctx.pos.col }
          const aboveSlot = getSlot(grid, above)
          const aboveCardId = aboveSlot?.cards[aboveSlot.cards.length - 1]
          const aboveCard = aboveCardId ? cardsById[aboveCardId] : undefined
          notes.push(
            `${card.name} was placed in the lower row at ${posLabel(ctx.pos)} and moves up to stack on ${aboveCard?.name ?? 'the card'} at ${posLabel(above)}.`,
          )
          debugNotes.push(`${card.name}: stackOnAboveIfLowerRow — placed at ${posLabel(ctx.pos)}, relocating to ${posLabel(above)} (onto ${aboveCard?.name ?? aboveCardId ?? 'empty'})`)
          lastPlaced = relocateCard(grid, ctx.pos, ctx.index, above, card.id)
        }
        break
      }
      case 'returnNextRevealedIfRankAtMost': {
        // Salamander: sets a DEFERRED pending, same shape as Ostrich/
        // Eagle's "next revealed card" primitives above, but resolved in
        // the main loop's returnIfRankAtMost branch below rather than by
        // redirecting a stack/flip target — a qualifying next-revealed card
        // is never placed on the grid at all.
        pending = { kind: 'returnIfRankAtMost', maxRank: effect.maxRank }
        break
      }
      case 'returnSelfIfMiddleColumn': {
        // Crab (Season 2, rank 17): "IF placed in the middle column,
        // return this card." A POST-placement self-mutation, structurally
        // like Monkey's relocation, but "return" instead of "move" —
        // removes Crab from its own just-filled slot and sends it to the
        // (UNCONFIRMED, see returnCardToDeckBottom above) bottom of its
        // owning deck, to possibly be redrawn later in the same Flip. Since Crab
        // no longer occupies the grid, "last placed card" reverts to
        // whatever was placed immediately before it (or null, if Crab was
        // the very first card placed this Flip).
        if (ctx.pos.col === 1) {
          removeCardFromSlot(grid, ctx.pos, ctx.index)
          returnCardToDeckBottom(remainingDeck, card.id)
          lastPlaced = ctx.previousPlaced
        }
        break
      }
      case 'dismissOwnDeckTopAndStackFromToonDeck': {
        // Snake (Season 1, rank 11) — fully encoded. (1) the player's own
        // deck-top dismissal, with its immune-target fallback (place to the
        // right of Snake, or back to the deck bottom if there's no slot to
        // the right in Snake's row — see the header comment on 'right'
        // below); (2) the unconditional toon-deck-top draw stacked onto
        // Snake's own slot (fires even when the player's deck was empty,
        // per the FAQ), which places the drawn card FACE UP — so it's
        // already scored normally by the ordinary face-up-in-grid path,
        // same as any other grid card; and (3) the FAQ's nested "if the
        // stacked card has a When-Hired ability (Peacock/Rabbit/Turkey),
        // resolve it after the Flip phase" chain — Rabbit/Turkey have no
        // onHire effect (the FAQ's "stack it on the snake" for them is just
        // confirming they DON'T do anything extra, which (2) already
        // achieves), and Peacock's onHire (+2 fame, +1 Market action) is
        // deferred via onHireDeferredCardId below rather than fired here,
        // since it must resolve AFTER Check Fame (see FlipResult's
        // pendingOnHireCardIds comment) or Check Fame's snapshot would
        // clobber it.
        if (remainingDeck.length > 0) {
          const topId = remainingDeck[0]
          const topCard = cardsById[topId]
          if (!topCard) throw new Error(`flip.ts: dismissOwnDeckTopAndStackFromToonDeck — unknown card id ${topId}`)
          remainingDeck.shift()
          if (!topCard.immune?.includes('dismiss')) {
            dismissed.push(topId)
            notes.push(`${card.name} dismissed ${topCard.name} from the top of your deck.`)
          } else {
            // "place it to the right of the snake instead, or return it to
            // the player's deck if the snake is in the final space of the
            // player's grid." UNCONFIRMED reading (per this pass's plan):
            // 'right' means same-row col+1 within the BASE grid — this
            // covers both the literal final-slot case (base[1][2], no
            // right neighbor) and any other rightmost-column placement
            // (base[0][2]) with one uniform rule, rather than special-
            // casing only the literal final slot.
            const right =
              ctx.pos.section === 'base' && ctx.pos.col < 2 ? { section: 'base' as const, row: ctx.pos.row, col: ctx.pos.col + 1 } : null
            if (right) {
              placeCardFaceUp(grid, right, topId)
              notes.push(`${card.name} could not dismiss ${topCard.name} (immune) — placed it to the right instead.`)
            } else {
              remainingDeck.push(topId) // back to the bottom of the deck
              notes.push(`${card.name} could not dismiss ${topCard.name} (immune) — returned it to the bottom of your deck.`)
            }
          }
        }
        // Unconditional toon-deck draw — "if a player's deck is depleted
        // before revealing the snake, you still stack a card from the deck
        // on the snake, even though no card is dismissed" (FAQ). If the
        // TOON deck itself is empty, there's simply nothing to draw — not
        // an error (a Flip-phase draw racing the toon deck to zero is a
        // real, expected depletion path, not a bug).
        if (toonDeck.length > 0) {
          const drawn = toonDeck.shift()!
          placeCardFaceUp(grid, ctx.pos, drawn)
          if (toonDeck.length === 0) toonDeckEmptied = true
          const drawnCard = cardsById[drawn]
          notes.push(`${card.name} drew ${drawnCard?.name ?? drawn} from the toon deck and stacked it face up on its own slot.`)
          if (drawnCard?.onHire?.length) onHireDeferredCardId = drawn
        }
        break
      }
      case 'dismissOwnDeckBottomAndDrawToonDeckTop': {
        // Mongoose (Season 2, rank 11). The dismissed card's own onDismiss
        // "resolving after the Flip phase" (FAQ) is the SAME general
        // deferred-post-Flip gap as Snake's nested chain above — no card's
        // onDismiss fires from anywhere but dismiss() (the Market phase)
        // today. This is NOT Mongoose-specific (any card could be the
        // bottom-of-deck target), so — per this pass's plan — Mongoose's
        // `unencodable` flag is DROPPED rather than kept for a limitation
        // that isn't really about Mongoose (see season2.ts's mongoose entry).
        //
        // UNCONFIRMED, deliberately NOT mirroring Snake's onHireDeferredCardId
        // above: unlike Snake, Mongoose does not place the drawn card itself
        // — it only "adds [it] to the top of your deck" — so the drawn card
        // re-enters the deck and gets flipped/placed LATER by this loop's
        // own ordinary draw, exactly like any other deck card. Card text
        // reads onHire ("WHEN HIRED...") as a Market-hire-specific trigger;
        // nothing in this card's text or the FAQ (unlike Snake's explicit
        // "if the stacked card has a When-Hired ability, resolve it after
        // the Flip phase" ruling) says a Mongoose-drawn card's onHire should
        // fire when it's later placed via ordinary Flip. If a future FAQ/
        // rulebook read says otherwise, this needs the same
        // onHireDeferredCardId treatment as Snake's case — but gated on the
        // drawn card actually reaching the grid this Flip (Mongoose can fill
        // the last base slot with the drawn card still sitting undrawn on
        // top of the deck), which Snake's placement-in-this-block doesn't
        // need to worry about.
        if (remainingDeck.length > 0) {
          const bottomId = remainingDeck[remainingDeck.length - 1]
          const bottomCard = cardsById[bottomId]
          if (!bottomCard) throw new Error(`flip.ts: dismissOwnDeckBottomAndDrawToonDeckTop — unknown card id ${bottomId}`)
          if (!bottomCard.immune?.includes('dismiss')) {
            remainingDeck.pop()
            dismissed.push(bottomId)
            notes.push(`${card.name} dismissed ${bottomCard.name} from the bottom of your deck.`)
          } else {
            notes.push(`${card.name} could not dismiss ${bottomCard.name} (immune) — the draw still happens.`)
          }
          // else: "unless it cannot be dismissed" — skip, still draws below.
        }
        if (toonDeck.length > 0) {
          const drawn = toonDeck.shift()!
          remainingDeck.unshift(drawn) // "add ... to the TOP of your deck"
          if (toonDeck.length === 0) toonDeckEmptied = true
          const drawnCard = cardsById[drawn]
          notes.push(
            `${card.name} drew ${drawnCard?.name ?? drawn} from the toon deck onto the top of your deck — it'll be the next card revealed and placed this Flip if a slot remains.`,
          )
        }
        break
      }
      case 'other':
        throw new Error(
          `flip.ts: onPlace effect 'other' (${JSON.stringify((effect as { text?: string }).text)}) on ${card.name} has no structured implementation — it's raw text only.`,
        )
      default: {
        const exhaustive: never = effect
        throw new Error(`flip.ts: unhandled onPlace effect kind on ${card.name}: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  return { pending, lastPlaced, toonDeckEmptied, onHireDeferredCardId }
}

// Draw until every base slot is occupied (isFull), or the deck runs out
// (§3.5's partial-grid case). Loop condition is base-slot occupancy, not a
// fixed card count — deliberately, so stacking/relocation cards that leave a
// slot unoccupied (§3.3) extend the draw correctly.
// A round should never legitimately need more than a handful of extra
// draws past six (stacking/relocation cards each buy at most one or two
// more) — this cap exists purely as a defensive backstop (per
// flip-toonz-structure-plan.md §10's "no round exceeds a sane flip
// ceiling"). Under the bottom-of-deck return reading it's mostly a pure
// safety net, but it's still load-bearing for one genuine case: an
// all-(or nearly-all)-Crab deck, where every card cycling back through the
// middle column is ALSO a Crab, so the stall the FAQ describes ("all-crab-
// deck stall condition") is real and never self-resolves — see
// returnCardToDeckBottom's comment above and season2-effects.test.ts.
// Without this guard that's a hang; with it, it's a fast, loud, diagnosable
// error (the physical rulebook's own resolution — "leaving crab(s) in
// deck" — implies the real game would just end the Flip phase there with a
// partial grid rather than erroring, which this Step-0 engine doesn't have
// a mechanism for yet; see this pass's report).
const MAX_FLIP_ITERATIONS = 500

function posLabel(pos: GridPos): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

function samePos(a: GridPos, b: GridPos): boolean {
  return a.section === b.section && a.row === b.row && a.col === b.col
}

export function flipDeck(deck: Deck, cardsById: Record<CardId, Card>, flipContext: FlipContext): FlipResult {
  const grid = emptyGrid()
  const remainingDeck = deck.slice()
  // Group 3 (Snake/Mongoose) — same clone-then-mutate convention as
  // `remainingDeck` above: never touch the caller's arrays directly.
  const toonDeck = flipContext.toonDeck.slice()
  const dismissed = flipContext.dismissed.slice()
  let toonDeckEmptiedDuringFlip = false
  const pendingOnHireCardIds: CardId[] = []
  // Player-facing notes for events the post-Flip grid can't explain on its
  // own — see applyOnPlaceEffects's `notes` param comment, and the
  // stack-redirect push below (why a card lands on an already-occupied
  // slot instead of the next empty one).
  const flipNotes: string[] = []
  // Verbose per-card trace for debugging card-interaction surprises (e.g.
  // "why did this card end up stacked where it did") — every card's
  // initial target position, plus every pending/redirect branch taken to
  // get there. Deliberately unconditional (cheap to build, opt-in to
  // display) rather than gated behind a flag threaded through the whole
  // engine — see actions.ts for the human-vs-debug display toggle.
  const debugNotes: string[] = []

  let pending: Pending = null
  let lastPlaced: CardPointer | null = null
  let iterations = 0

  while (!isFull(grid) && remainingDeck.length > 0) {
    iterations++
    if (iterations > MAX_FLIP_ITERATIONS) {
      throw new Error(
        `flip.ts: flipDeck exceeded ${MAX_FLIP_ITERATIONS} iterations without filling the grid — likely a returned/relocated card looping back into its own trigger condition (see the Crab stall-condition note on returnCardToDeckBottom)`,
      )
    }

    const cardId = remainingDeck.shift()!
    const card = cardsById[cardId]
    if (!card) throw new Error(`flip.ts: unknown card id ${cardId}`)

    if (pending?.kind === 'returnIfRankAtMost') {
      // Salamander: "IF the next revealed card is rank 1 or lower, return
      // it" — consumed here, one-shot, BEFORE any placement is attempted.
      // A qualifying card never touches the grid at all; a non-qualifying
      // card falls through to normal placement below exactly as if no
      // pending effect existed.
      const maxRank = pending.maxRank
      pending = null
      if (card.rank <= maxRank) {
        returnCardToDeckBottom(remainingDeck, cardId)
        continue
      }
    }

    let targetPos: GridPos
    let forceFaceDown = false
    let suppressOwnOnPlace = false

    if (pending?.kind === 'flip') {
      // Eagle's deferred flip. Immunity is resolved FIRST, before deciding
      // where the card lands — an immune target (e.g. Rabbit, which is also
      // `immune: ['flip']`) is entirely unaffected: no flip, and it falls
      // through to its own normal target-determination (which may itself be
      // Rabbit's stack-search, Turkey's stack-on-previous, or the default
      // next-empty-slot) exactly as if Eagle had never been placed.
      pending = null
      if (isImmuneTo(card, 'flip')) {
        targetPos = determineTarget(card, grid, lastPlaced, cardsById, remainingDeck, flipNotes, debugNotes)
        debugNotes.push(`${card.name}: immune to Eagle's flip — falls through to its own target-determination -> ${posLabel(targetPos)}`)
      } else {
        const next = nextEmptyBaseSlot(grid)
        if (!next) break // grid filled up; nothing left to reveal (shouldn't happen — isFull() guards the loop — but keep the guard honest)
        targetPos = toBasePos(next)
        forceFaceDown = true
        suppressOwnOnPlace = true // "its ability does not activate" (Eagle's own text)
        debugNotes.push(`${card.name}: Eagle's deferred flip forces face-down placement at ${posLabel(targetPos)}, own onPlace suppressed`)
      }
    } else if (pending?.kind === 'stack') {
      // Ostrich's deferred stack. Unlike Eagle, the stacked card's own
      // onPlace effects still resolve afterward — see the comment in
      // applyOnPlaceEffects's 'stackNextRevealed' case.
      targetPos = pending.pos
      pending = null
      debugNotes.push(`${card.name}: redirected onto Ostrich's deferred stack target ${posLabel(targetPos)}`)
    } else if (pending?.kind === 'moveToExtraRow') {
      // Gorilla's deferred relocation of the next revealed card. Its own
      // onPlace effects still resolve afterward, same as Ostrich's stack —
      // see the comment in applyOnPlaceEffects's
      // 'moveNextRevealedToExtraRowIfUpperRow' case.
      targetPos = extraRowSlotAbove(grid, pending.col)
      pending = null
      debugNotes.push(`${card.name}: redirected onto Gorilla's deferred extra-row target ${posLabel(targetPos)}`)
    } else {
      targetPos = determineTarget(card, grid, lastPlaced, cardsById, remainingDeck, flipNotes, debugNotes)
      debugNotes.push(`${card.name}: initial target ${posLabel(targetPos)}${lastPlaced ? ` (previous placed: ${cardsById[lastPlaced.cardId]?.name ?? lastPlaced.cardId} at ${posLabel(lastPlaced.pos)})` : ' (first card placed)'}`)
      // Turkey/Panther-style redirect: the card landed on an ALREADY-
      // OCCUPIED slot (the previously placed card's own position) instead
      // of the next empty base slot — without this note, the grid/log
      // shows the same position reporting a different card name with no
      // explanation (the exact confusion a Mongoose-drawn Panther produces:
      // it stacks onto Mongoose's own slot because Mongoose was the
      // immediately-preceding placed card).
      if (hasOnPlaceKind(card, 'stackOnPreviousPlaced') && lastPlaced && samePos(targetPos, lastPlaced.pos)) {
        const prevCard = cardsById[lastPlaced.cardId]
        flipNotes.push(`${card.name} stacks on top of ${prevCard?.name ?? lastPlaced.cardId} at ${posLabel(targetPos)} (stacks on the previously placed card).`)
      } else if (hasOnPlaceKind(card, 'stackOnFirstMatchOrFaceDown')) {
        const existing = getSlot(grid, targetPos)
        if (existing && existing.cards.length > 0) {
          flipNotes.push(`${card.name} stacks on top of the existing card(s) at ${posLabel(targetPos)}.`)
        }
      }
    }

    if (forceFaceDown) {
      placeCardFaceUp(grid, targetPos, cardId) // places face-up first (grid.ts has no face-down placement primitive)...
      const slot = getSlot(grid, targetPos)!
      slot.faceUp[slot.faceUp.length - 1] = false // ...then immediately flips it, before its onPlace ever runs
    } else {
      placeCardFaceUp(grid, targetPos, cardId)
    }

    const slotNow = getSlot(grid, targetPos)!
    const selfPointer: CardPointer = { cardId, pos: targetPos, index: slotNow.cards.length - 1 }
    const previousPlaced = lastPlaced
    lastPlaced = selfPointer

    if (!suppressOwnOnPlace) {
      // flipPreviousPlaced (Elephant) needs cardsById to check the target's
      // immunity, which applyOnPlaceEffects doesn't have — handle it here,
      // inline, rather than threading cardsById through every effect kind
      // for the sake of one case.
      //
      // LATENT GAP (not exercised by any card encoded so far, flagged for
      // whoever adds the next one): `previousPlaced` can go stale if a
      // grid-return (Coyote/Zebra) happened on the card placed immediately
      // before this one — the pointer's `.pos`/`.index` still name the
      // slot the returned card occupied, but that slot now holds whatever
      // replaced it (Coyote/Zebra itself). The lookup below re-reads
      // `targetSlot.cards[previousPlaced.index]` rather than trusting a
      // cached identity, so it flips whatever is ACTUALLY there now, not
      // necessarily the card this pointer was originally set for. No
      // current card combines flipPreviousPlaced with a preceding
      // grid-return, so this can't misfire today — but a future card that
      // does would flip the wrong thing.
      if (hasOnPlaceKind(card, 'flipPreviousPlaced') && previousPlaced) {
        const targetSlot = getSlot(grid, previousPlaced.pos)
        const targetCardId = targetSlot?.cards[previousPlaced.index]
        const targetCard = targetCardId ? cardsById[targetCardId] : undefined
        if (targetSlot && targetCard && !isImmuneTo(targetCard, 'flip')) {
          targetSlot.faceUp[previousPlaced.index] = false
        }
      }

      const result = applyOnPlaceEffects(
        card,
        grid,
        remainingDeck,
        toonDeck,
        dismissed,
        cardsById,
        {
          pos: targetPos,
          index: slotNow.cards.length - 1,
          previousPlaced,
          selfPointer,
        },
        flipNotes,
        debugNotes,
      )
      pending = result.pending
      lastPlaced = result.lastPlaced
      if (result.toonDeckEmptied) toonDeckEmptiedDuringFlip = true
      if (result.onHireDeferredCardId) pendingOnHireCardIds.push(result.onHireDeferredCardId)
    }
  }

  return { grid, remainingDeck, toonDeck, dismissed, toonDeckEmptiedDuringFlip, pendingOnHireCardIds, flipNotes, debugNotes }
}

// Target-determination for a card's OWN placement — i.e. deciding which
// slot it lands in, as opposed to what it does to some other card. Covers
// the default (next empty base slot) plus the two cards that redirect their
// own placement: Turkey (stacks on the previous placed card) and Rabbit
// (stacks on the first Rabbit-or-face-down card). Both fall back to the
// default when there's no valid target — Turkey per its own FAQ ("if a
// turkey is the first card placed... ignore its ability"), Rabbit per an
// UNCONFIRMED assumption (see findRabbitOrFaceDownTarget).
function determineTarget(
  card: Card,
  grid: Grid,
  lastPlaced: CardPointer | null,
  cardsById: Record<CardId, Card>,
  remainingDeck: Deck,
  notes: string[],
  debugNotes: string[],
): GridPos {
  if (hasOnPlaceKind(card, 'stackOnPreviousPlaced')) {
    if (lastPlaced) return lastPlaced.pos
  } else if (hasOnPlaceKind(card, 'stackOnFirstMatchOrFaceDown')) {
    const effect = (card.onPlace ?? []).find((e) => e.kind === 'stackOnFirstMatchOrFaceDown') as
      | { kind: 'stackOnFirstMatchOrFaceDown'; matchCardId: CardId }
      | undefined
    const found = effect ? findRabbitOrFaceDownTarget(grid, effect.matchCardId) : null
    if (found) return found
  } else if (hasOnPlaceKind(card, 'returnPreviousPlacedOrStack')) {
    // Coyote: "Return the previous placed card unless it cannot be
    // returned, and place this card in its space; if it cannot be
    // returned, stack the coyote on it instead." Falls back to default
    // placement if Coyote is the first card placed this Flip — same
    // precedent as Elephant/Turkey (no previous card to target).
    if (lastPlaced) return resolveGridReturnTarget(grid, cardsById, remainingDeck, lastPlaced, card, notes, debugNotes)
  } else if (hasOnPlaceKind(card, 'returnLowestRankOrStack')) {
    // Zebra: "Return the lowest rank card in your grid and place this card
    // in its space." FAQ: ignored if Zebra is the first card placed
    // (findLowestRankTarget returns null when the grid has no face-up card
    // yet, covering that for free), face-down cards are never a valid
    // target (also covered for free — see findLowestRankTarget), stacks
    // instead if the target can't be returned.
    const target = findLowestRankTarget(grid, cardsById)
    if (target) return resolveGridReturnTarget(grid, cardsById, remainingDeck, target, card, notes, debugNotes)
  }

  const next = nextEmptyBaseSlot(grid)
  if (!next) {
    throw new Error(`flip.ts: determineTarget — grid unexpectedly full while placing ${card.name}`)
  }
  return toBasePos(next)
}

// re-exported for tests that want to poke at slot contents directly without
// re-deriving the Slot type import path.
export type { Slot }
