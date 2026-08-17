// The solo round-loop phase machine, per flip-toonz-structure-plan.md §3.2,
// adapted to a single player per the task scope (§3.7's solo win/lose
// conditions supersede the multiplayer Final-Flip-most-fame-wins ending —
// see state.ts's GameState comment for why criticsChoiceHolder/Final Flip
// are skipped entirely, not merely unbuilt).
//
//   Flip        -> flipDeck() (reused, not duplicated) fills the grid
//   CheckFame   -> scoreGrid() (reused) computes this round's fame
//   postFameHooks -> Skunk/Firefly-style hooks (unreachable in solo — see
//                    runPostFameHooks below)
//   Market      -> up to 2 actions: hire() / dismiss()
//   Cleanup     -> collect grid -> deck, refill market, check both endgame
//                  triggers, reset fame, advance round (or end)
//
// Season-agnostic (§10) — every function here takes a GameState built from
// data and never branches on Card.season.

import type { Card, CardId, Effect, EffectChoices, PostMarketHook } from './cards/types'
import { adjacentFaceUpCardIds, cloneGrid, emptyGrid, findLowestRankFaceUpCard, getSlot, occupiedSlots, setSlot } from './grid'
import { flipDeck } from './flip'
import { hireCost, refillMarket, soloMarketDecay } from './market'
import { shuffleWithState } from './rng'
import { scoreGrid } from './score'
import { cardsById } from './setup'
import type { GameState } from './state'
import type { Grid, GridPos } from './types'

const DEFAULT_DISMISS_COST = 5
const MARKET_ACTIONS_PER_ROUND = 2

function assertPhase(state: GameState, phase: GameState['phase'], fn: string): void {
  if (state.phase !== phase) {
    throw new Error(`phases.ts: ${fn} called in phase '${state.phase}', expected '${phase}'`)
  }
}

// ---------------------------------------------------------------------------
// Flip
// ---------------------------------------------------------------------------

export function runFlip(state: GameState): GameState {
  assertPhase(state, 'flip', 'runFlip')
  const cards = cardsById()
  const shuffled = shuffleWithState(state.deck, state.rng)
  const flipResult = flipDeck(shuffled.result, cards, { toonDeck: state.toonDeck, dismissed: state.dismissed })

  return {
    ...state,
    rng: shuffled.next,
    grid: flipResult.grid,
    deck: flipResult.remainingDeck,
    toonDeck: flipResult.toonDeck,
    dismissed: flipResult.dismissed,
    // A Flip-phase toon-deck draw (Snake/Mongoose) counts toward the
    // depletion endgame trigger exactly like a Market-phase refill does
    // (§3.2.2) — OR'd, never cleared, same convention as
    // applyRefillResult's toonDeckDepleted below.
    toonDeckDepleted: state.toonDeckDepleted || flipResult.toonDeckEmptiedDuringFlip,
    phase: 'checkFame',
  }
}

// ---------------------------------------------------------------------------
// Check Fame
// ---------------------------------------------------------------------------

// Solo-specific resolution of the Dog's 'dogInMarketOrOtherPlayerGrid'
// condition (score.ts's scoreGrid header comment / cards/season1.ts's Dog
// entry): "a Dog in the market or any OTHER player's grid." Solo has no
// other players, so that reduces to "is a Dog occupying a market slot" —
// real, observable GameState the phase machine has and scoreGrid itself
// does not. Deliberately keyed on the literal card id 'dog', NOT on
// scanning for the 'dogInMarketOrOtherPlayerGrid' condition string the way
// score.ts's hasDogElsewhereCondition does: that string only tells you a
// card's FAME depends on Dog-elsewhere, not which id COUNTS AS a Dog for
// the census itself — there's no way to derive "what is a Dog" from the
// condition string, so this has to name the id directly.
function dogElsewhereFromMarket(state: GameState): boolean {
  return state.market.slots.some((id) => id === 'dog')
}

export function runCheckFame(state: GameState): GameState {
  assertPhase(state, 'checkFame', 'runCheckFame')
  const cards = cardsById()
  const breakdown = scoreGrid(state.grid, cards, state.deck.length, {
    dogElsewhere: dogElsewhereFromMarket(state),
    dismissed: state.dismissed,
  })

  return {
    ...state,
    fame: breakdown.total,
    fameGeneratedThisRound: breakdown.total, // the Check-Fame snapshot (§3.4) — see state.ts's field comment for why this differs from `fame`
    lastCheckFame: breakdown,
    phase: 'postFameHooks',
  }
}

// ---------------------------------------------------------------------------
// postFameHooks — least-fame abilities (Skunk/Firefly category, §3.4)
// ---------------------------------------------------------------------------
//
// PROVABLY UNREACHABLE for any solo config this pass builds, for a stronger
// reason than "solo's starting deck excludes it": Skunk and Firefly are
// both RANK-0, STARTING-DECK-ONLY cards (never toon-deck/market cards, in
// either season's card table — see cards/season1.ts, cards/season2.ts).
// Solo's setup swaps the least-fame starter out of the starting deck
// (buildSeason1SoloStartingDeck / buildSeason2SoloStartingDeck in setup.ts)
// and the market can never independently deal one in, so no solo grid can
// ever contain a face-up postFameHook card. This function is still written
// correctly (not skipped) because "unreachable given today's card table"
// is not the same guarantee as "unreachable forever" — a later season could
// add a market card with this hook — and per flip.ts/score.ts's own house
// style, an unhandled effect kind THROWS rather than silently no-oping.
//
// What IS implemented, for the hypothetical case: with one player, "least
// fame after Check Fame" is vacuously true (there's no one to be tied with
// or beaten by), so a flat-gain effect (Firefly's shape) applies
// automatically. A choice-requiring effect (Skunk's shape — "dismiss a
// card of your choosing") is NOT resolved automatically, since that needs
// interactive input this engine-only pass deliberately doesn't build (task
// scope: "Don't build any interactive/readline code") — it throws with a
// clear message instead of guessing which card to dismiss.
export function runPostFameHooks(state: GameState): GameState {
  assertPhase(state, 'postFameHooks', 'runPostFameHooks')
  const cards = cardsById()

  let fame = state.fame
  for (const { slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, i) => {
      if (!slot.faceUp[i]) return
      const card = cards[cardId]
      const hook = card.postFameHook
      if (!hook) return
      if (hook.condition !== 'strictlyLowestFame') {
        throw new Error(`phases.ts: runPostFameHooks — unhandled postFameHook condition '${hook.condition}' on ${card.name}`)
      }
      // Single player: vacuously "strictly lowest" (see header comment).
      if (hook.effect.kind === 'gainFame') {
        fame += hook.effect.amount
      } else {
        throw new Error(
          `phases.ts: runPostFameHooks — ${card.name}'s postFameHook needs a player choice (${hook.effect.kind}), which this engine-only pass has no interactive machinery to resolve; this should be unreachable given the current solo card table (see header comment) — investigate how it got here`,
        )
      }
    })
  }

  return { ...state, fame, actionsRemaining: MARKET_ACTIONS_PER_ROUND, phase: 'market' }
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

function applyRefillResult<T extends GameState>(
  state: T,
  refill: ReturnType<typeof refillMarket>,
): Pick<GameState, 'market' | 'toonDeck' | 'nextInsertionSeq' | 'toonDeckDepleted'> {
  return {
    market: refill.market,
    toonDeck: refill.toonDeck,
    nextInsertionSeq: refill.nextInsertionSeq,
    // OR, never cleared — once depleted, always depleted (§3.2.2).
    toonDeckDepleted: state.toonDeckDepleted || refill.toonDeckEmpty,
  }
}

// Hire — pay the price card above the slot, card goes to the DECK (§3.2).
// Refills + re-sorts the market afterward (the change that actually needs
// it: a slot just emptied).
export function hire(state: GameState, slotIndex: number, choices?: EffectChoices): GameState {
  assertPhase(state, 'market', 'hire')
  if (state.actionsRemaining <= 0) throw new Error('phases.ts: hire — no Market actions remaining this round')
  if (slotIndex < 0 || slotIndex >= state.market.slots.length) {
    throw new Error(`phases.ts: hire — slot index ${slotIndex} out of range`)
  }
  const cardId = state.market.slots[slotIndex]
  if (cardId === null) throw new Error(`phases.ts: hire — market slot ${slotIndex} is empty`)
  const price = hireCost(state.market, slotIndex)
  if (state.fame < price) {
    throw new Error(`phases.ts: hire — cannot afford slot ${slotIndex} (costs ${price}, have ${state.fame} fame)`)
  }

  const marketAfterRemoval = {
    prices: state.market.prices,
    slots: state.market.slots.slice(),
    insertionSeq: state.market.insertionSeq.slice(),
  }
  marketAfterRemoval.slots[slotIndex] = null
  marketAfterRemoval.insertionSeq[slotIndex] = null

  const cards = cardsById()
  const refill = refillMarket(marketAfterRemoval, state.toonDeck, cards, state.nextInsertionSeq)

  const hired: GameState = {
    ...state,
    fame: state.fame - price,
    deck: [...state.deck, cardId],
    actionsRemaining: state.actionsRemaining - 1,
    ...applyRefillResult(state, refill),
  }

  // onHire fires AFTER the above (post-decrement, post-refill) — see
  // applyEffects's header comment (Peacock's bonus action must be additive
  // on the decremented actionsRemaining, not a wash). Any choice indices in
  // `choices` (e.g. Crow's/Horse's market-slot targets) refer to the
  // POST-REFILL market — the same market a player/UI would actually be
  // looking at when making the choice, not the pre-hire snapshot.
  return applyEffects(hired, cards[cardId], cards[cardId].onHire, choices)
}

// Shared raw grid-removal primitive — used by public dismiss() below, by
// applyEffects's free-dismissal effect kinds (dismissByName/
// dismissChosenGridCard), and by Group 2's postMarket hooks. Deliberately
// "raw": it does NOT check immunity, does NOT charge fame, and does NOT push
// onto GameState.dismissed itself — every caller does those things in its
// own way (different costs, different immunity-check timing). Returns the
// removed CardId so the caller can push it onto `dismissed` — which every
// caller MUST do regardless of cost/kind, since Group 4's dismissed-pile
// fame queries (Cat/Tiger/Opossum) depend on every dismissal landing there.
export function removeCardRaw(grid: Grid, pos: GridPos, index: number): CardId {
  const slot = getSlot(grid, pos)
  if (!slot) throw new Error(`phases.ts: removeCardRaw — no slot at ${JSON.stringify(pos)}`)
  const [cardId] = slot.cards.splice(index, 1)
  slot.faceUp.splice(index, 1)
  if (slot.cards.length === 0) setSlot(grid, pos, null)
  return cardId
}

// Whether any face-up, dismiss-eligible (not immune: ['dismiss']) card
// exists anywhere in the grid — used to distinguish "mandatory effect with
// no legal target, so it silently no-ops" (an impossible board) from
// "mandatory effect with a legal target that the caller failed to supply a
// choice for" (a real missing-input bug, throws). See dismissChosenGridCard
// in applyEffects below (Panther).
function hasAnyDismissibleFaceUpCard(grid: Grid, cards: Record<CardId, Card>): boolean {
  for (const { slot } of occupiedSlots(grid)) {
    for (let i = 0; i < slot.cards.length; i++) {
      if (!slot.faceUp[i]) continue
      if (!cards[slot.cards[i]].immune?.includes('dismiss')) return true
    }
  }
  return false
}

// Generic firing point for a card's onHire/onDismiss effects (Group 1 of
// this pass). Called by hire()/dismiss() AFTER their own bookkeeping
// (actionsRemaining decrement, market refill) — see hire()'s Peacock note:
// a bonus market action must be ADDITIVE on top of the post-decrement
// state, not a wash, and must hold for any future bonus amount.
//
// Recursion note (deliberate, not an oversight): if an effect hires/dismisses
// a card that ITSELF has onHire/onDismiss effects (e.g. Raccoon hiring a
// Peacock out of the dismissed pile, or Crow hiring a Panther from the
// market), this does NOT recursively fire that card's own hooks — only a
// card hired/dismissed through the NORMAL hire()/dismiss() entry points
// gets its own onHire/onDismiss resolved. The plan is silent on this case;
// treating it as non-recursive avoids inventing a choices-threading/cycle-
// protection scheme this pass doesn't otherwise need.
export function applyEffects(state: GameState, card: Card, effects: Effect[] | undefined, choices?: EffectChoices): GameState {
  let next = state
  const cards = cardsById()

  for (const effect of effects ?? []) {
    switch (effect.kind) {
      case 'gainFame': {
        // Market-phase fame gain (Peacock's flat +2) touches spendable
        // `fame` only — NOT `fameGeneratedThisRound`, the frozen Check-Fame
        // snapshot the win trigger reads (state.ts's own field comment:
        // Market-phase spending/gain is explicitly NOT what that field
        // tracks).
        next = { ...next, fame: next.fame + effect.amount }
        break
      }
      case 'bonusMarketAction': {
        next = { ...next, actionsRemaining: next.actionsRemaining + effect.amount }
        break
      }
      case 'dismissByName': {
        // Butterfly: OPTIONAL — no-op if declined/no choice given.
        const choice = choices?.dismissByName
        if (!choice) break
        const slot = getSlot(next.grid, choice.pos)
        const targetId = slot?.cards[choice.index]
        if (!slot || targetId === undefined) {
          throw new Error(`phases.ts: applyEffects — dismissByName (${card.name}) target slot ${JSON.stringify(choice.pos)}#${choice.index} is empty`)
        }
        if (targetId !== effect.targetCardId) {
          throw new Error(
            `phases.ts: applyEffects — dismissByName (${card.name}) target at ${JSON.stringify(choice.pos)}#${choice.index} is '${targetId}', not '${effect.targetCardId}'`,
          )
        }
        if (!slot.faceUp[choice.index]) throw new Error(`phases.ts: applyEffects — dismissByName (${card.name}) cannot target a face-down card`)
        const targetCard = cards[targetId]
        if (targetCard.immune?.includes('dismiss')) throw new Error(`phases.ts: applyEffects — ${targetCard.name} is immune to dismiss`)
        if (next.fame < effect.cost) throw new Error(`phases.ts: applyEffects — cannot afford dismissByName's cost (${effect.cost})`)
        const grid = cloneGrid(next.grid)
        const removedId = removeCardRaw(grid, choice.pos, choice.index)
        next = { ...next, grid, dismissed: [...next.dismissed, removedId], fame: next.fame - effect.cost }
        break
      }
      case 'dismissChosenGridCard': {
        // Panther: MANDATORY, but only when a legal (face-up, non-immune)
        // target actually exists somewhere in the grid — an impossible
        // board silently no-ops rather than throwing (see
        // hasAnyDismissibleFaceUpCard's comment). Panther's own target is
        // an EXISTING grid card — Panther itself isn't on the grid yet when
        // its onHire fires (it's still sitting in the market/being moved to
        // the deck), so there's no risk of it targeting itself.
        if (!hasAnyDismissibleFaceUpCard(next.grid, cards)) break
        const choice = choices?.dismissGridPos
        if (!choice) {
          throw new Error(`phases.ts: applyEffects — ${card.name}'s mandatory dismissChosenGridCard needs choices.dismissGridPos (a legal target exists)`)
        }
        const slot = getSlot(next.grid, choice.pos)
        const targetId = slot?.cards[choice.index]
        if (!slot || targetId === undefined) {
          throw new Error(`phases.ts: applyEffects — dismissChosenGridCard (${card.name}) target slot ${JSON.stringify(choice.pos)}#${choice.index} is empty`)
        }
        if (!slot.faceUp[choice.index]) throw new Error(`phases.ts: applyEffects — dismissChosenGridCard (${card.name}) cannot target a face-down card`)
        const targetCard = cards[targetId]
        if (targetCard.immune?.includes('dismiss')) throw new Error(`phases.ts: applyEffects — ${targetCard.name} is immune to dismiss`)
        if (next.fame < effect.cost) throw new Error(`phases.ts: applyEffects — cannot afford dismissChosenGridCard's cost (${effect.cost})`)
        const grid = cloneGrid(next.grid)
        const removedId = removeCardRaw(grid, choice.pos, choice.index)
        next = { ...next, grid, dismissed: [...next.dismissed, removedId], fame: next.fame - effect.cost }
        break
      }
      case 'hireFromDismissed': {
        // Raccoon: OPTIONAL — no-op if declined/no choice given.
        const choice = choices?.hireFromDismissed
        if (!choice || choice === 'decline') break
        const idx = next.dismissed.indexOf(choice.cardId)
        if (idx === -1) throw new Error(`phases.ts: applyEffects — hireFromDismissed (${card.name}) target '${choice.cardId}' is not in the dismissed pile`)
        if (next.fame < effect.cost) throw new Error(`phases.ts: applyEffects — cannot afford hireFromDismissed's cost (${effect.cost})`)
        const dismissed = next.dismissed.slice()
        dismissed.splice(idx, 1)
        next = { ...next, dismissed, deck: [...next.deck, choice.cardId], fame: next.fame - effect.cost }
        break
      }
      case 'hireFromMarketAndRefill': {
        // Crow: OPTIONAL — no-op if declined/no choice given. Only the
        // Market-phase-dismissal-triggered case is reachable in this engine
        // (see crow's card-data comment for the Flip-phase gap this leaves
        // unencoded).
        const choice = choices?.hireFromMarketSlot
        if (!choice || choice === 'decline') break
        const slotIndex = choice.slotIndex
        if (slotIndex < 0 || slotIndex >= next.market.slots.length) {
          throw new Error(`phases.ts: applyEffects — hireFromMarketAndRefill (${card.name}) slot index ${slotIndex} out of range`)
        }
        const targetCardId = next.market.slots[slotIndex]
        if (targetCardId === null) throw new Error(`phases.ts: applyEffects — hireFromMarketAndRefill (${card.name}) market slot ${slotIndex} is empty`)
        if (next.fame < effect.cost) throw new Error(`phases.ts: applyEffects — cannot afford hireFromMarketAndRefill's cost (${effect.cost})`)
        const marketAfterRemoval = {
          prices: next.market.prices,
          slots: next.market.slots.slice(),
          insertionSeq: next.market.insertionSeq.slice(),
        }
        marketAfterRemoval.slots[slotIndex] = null
        marketAfterRemoval.insertionSeq[slotIndex] = null
        const refill = refillMarket(marketAfterRemoval, next.toonDeck, cards, next.nextInsertionSeq)
        next = {
          ...next,
          fame: next.fame - effect.cost,
          deck: [...next.deck, targetCardId],
          ...applyRefillResult(next, refill),
        }
        break
      }
      case 'discardMarketAndRefill': {
        // Horse: OPTIONAL — no-op if declined/empty. Discards the CHOSEN
        // slots (any number, player's choice) and refills; matches the
        // FAQ's "refill count equals the number discarded" (refillMarket's
        // own fill-then-resort logic already does this for free).
        const slots = choices?.discardMarketSlots
        if (!slots || slots.length === 0) break
        const marketAfterDiscard = {
          prices: next.market.prices,
          slots: next.market.slots.slice(),
          insertionSeq: next.market.insertionSeq.slice(),
        }
        for (const i of slots) {
          if (i < 0 || i >= marketAfterDiscard.slots.length) {
            throw new Error(`phases.ts: applyEffects — discardMarketAndRefill (${card.name}) slot index ${i} out of range`)
          }
          marketAfterDiscard.slots[i] = null
          marketAfterDiscard.insertionSeq[i] = null
        }
        const refill = refillMarket(marketAfterDiscard, next.toonDeck, cards, next.nextInsertionSeq)
        next = { ...next, ...applyRefillResult(next, refill) }
        break
      }
      case 'other':
        throw new Error(`phases.ts: applyEffects — effect 'other' (${JSON.stringify((effect as { text?: string }).text)}) on ${card.name} has no structured implementation`)
      default: {
        const exhaustive: never = effect
        throw new Error(`phases.ts: applyEffects — unhandled effect kind on ${card.name}: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  return next
}

// Group 6 — adjacency/stack-aware dismiss cost (Ladybug, Rat). Replaces
// dismiss()'s old inline `card.dismissCost ?? DEFAULT_DISMISS_COST`.
//   - Ladybug ("adjacent cards cost 3 instead of 5 to dismiss"): an adjacent
//     face-up Ladybug REPLACES the DEFAULT cost (5) with 3 — only when the
//     target card has NO explicit `dismissCost` override of its own.
//     Caterpillar's explicit `dismissCost: 3` stays 3 whether or not a
//     Ladybug is adjacent; it is untouched by this rule, not doubly
//     discounted or overridden.
//   - Rat ("cards in Rat's stack cost 1 fewer to dismiss"): a face-up Rat
//     anywhere in the SAME slot (stack) as the target subtracts 1.
//     UNCONFIRMED (no source resolves this either way, flagged here rather
//     than guessed silently): whether Rat discounts its OWN dismissal — this
//     reading says yes (a face-up Rat counts as "a Rat in its own stack"),
//     chosen for simplicity over inventing a self-exclusion rule no text
//     supports.
//   - Composition (both apply, e.g. a Rat stacked under a card adjacent to a
//     Ladybug): Ladybug's replacement is applied FIRST (5 -> 3), THEN Rat's
//     -1, THEN floor at 0 — also UNCONFIRMED, since no source composes the
//     two abilities; this is the plan's own documented reading.
function dismissCostFor(grid: Grid, pos: GridPos, index: number, cardsById: Record<CardId, Card>): number {
  const slot = getSlot(grid, pos)
  if (!slot) throw new Error(`phases.ts: dismissCostFor — no slot at ${JSON.stringify(pos)}`)
  const card = cardsById[slot.cards[index]]
  let cost = card.dismissCost ?? DEFAULT_DISMISS_COST

  if (card.dismissCost === undefined) {
    const adjacentIds = adjacentFaceUpCardIds(grid, pos)
    if (adjacentIds.includes('ladybug')) cost = 3
  }

  const hasFaceUpRatInStack = slot.cards.some((id, i) => id === 'rat' && slot.faceUp[i])
  if (hasFaceUpRatInStack) cost -= 1

  return Math.max(0, cost)
}

// Dismiss — pay 5 fame (or the card's own dismissCost) to remove a card
// from the grid permanently, face-up beside the deck (§3.2, §3.3a). Also
// refills+re-sorts the market afterward for consistency with hire (a no-op
// when the market wasn't touched, since there's nothing to fill/re-sort —
// see market.ts's refillMarket comment: "the ONE refillMarket used both
// after Market-phase actions").
export function dismiss(state: GameState, pos: GridPos, index?: number, choices?: EffectChoices): GameState {
  assertPhase(state, 'market', 'dismiss')
  if (state.actionsRemaining <= 0) throw new Error('phases.ts: dismiss — no Market actions remaining this round')

  const slot = getSlot(state.grid, pos)
  if (!slot || slot.cards.length === 0) throw new Error(`phases.ts: dismiss — no card at ${JSON.stringify(pos)}`)
  const idx = index ?? slot.cards.length - 1 // default: the top of the stack
  const cardId = slot.cards[idx]
  if (!slot.faceUp[idx]) throw new Error('phases.ts: dismiss — cannot dismiss a face-down card')

  const cards = cardsById()
  const card = cards[cardId]
  if (card.immune?.includes('dismiss')) {
    throw new Error(`phases.ts: dismiss — ${card.name} is immune to dismiss`)
  }
  const cost = dismissCostFor(state.grid, pos, idx, cards)
  if (state.fame < cost) {
    throw new Error(`phases.ts: dismiss — cannot afford dismissing ${card.name} (costs ${cost}, have ${state.fame} fame)`)
  }

  const grid = cloneGrid(state.grid)
  removeCardRaw(grid, pos, idx)

  const refill = refillMarket(state.market, state.toonDeck, cards, state.nextInsertionSeq)

  const dismissedState: GameState = {
    ...state,
    fame: state.fame - cost,
    grid,
    dismissed: [...state.dismissed, cardId],
    actionsRemaining: state.actionsRemaining - 1,
    ...applyRefillResult(state, refill),
  }

  // onDismiss fires AFTER the above (post-decrement, post-refill) — same
  // ordering rationale as hire()'s onHire call. `card` here is the DISMISSED
  // card (Crow), not whatever the effect subsequently hires.
  return applyEffects(dismissedState, card, card.onDismiss, choices)
}

// Ends the Market phase: the solo/2-player decay (§3.6, §3.2.2 item 17)
// fires ONCE here, after all Market actions for the round, never at
// Cleanup. Transitions straight to Cleanup.
// Adjacent-to-the-RIGHT position, within the same row/section — Alligator's
// directional target. Returns null at the row's rightmost column (nothing to
// the right), same "no target, silently no-op" convention as every other
// hook branch below.
function adjacentRightPos(grid: Grid, pos: GridPos): GridPos | null {
  if (pos.section === 'base') {
    if (pos.col + 1 < grid.base[pos.row].length) return { section: 'base', row: pos.row, col: pos.col + 1 }
    return null
  }
  if (pos.row < grid.extraRows.length && pos.col + 1 < grid.extraRows[pos.row].length) {
    return { section: 'extra', row: pos.row, col: pos.col + 1 }
  }
  return null
}

// Group 2 — postMarket self/other-triggered hooks (Donkey, Alligator,
// Groundhog, Vulture), fired from endMarketPhase() BEFORE the solo decay
// step (§3.2.2's decay is a separate, later step). Candidate cards are
// snapshotted ONCE, in grid reading order, before any hook applies — but
// each candidate is RE-CHECKED still present/face-up at its snapshotted
// (pos, index) at APPLICATION time, not just existence-checked up front: an
// earlier hook's dismissal can remove a later hook's own owner (Vulture
// dismissing Groundhog before Groundhog's turn) or shift stack indices
// within the same slot. Per Alligator/Vulture's own FAQ notes ("if
// dismissed during the Market phase, no longer fires" / "ignored if it has
// left the grid by then"), a missing/relocated owner is skipped silently —
// applied uniformly to Donkey/Groundhog too, for consistency, even though
// their own FAQ text doesn't spell out the interaction case explicitly.
export function runPostMarketHooks(state: GameState): GameState {
  const cards = cardsById()

  type Candidate = { pos: GridPos; index: number; cardId: CardId; hook: PostMarketHook }
  const candidates: Candidate[] = []
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, i) => {
      if (!slot.faceUp[i]) return
      const hook = cards[cardId].postMarketHook
      if (hook) candidates.push({ pos, index: i, cardId, hook })
    })
  }

  let next = state
  for (const c of candidates) {
    const slot = getSlot(next.grid, c.pos)
    if (!slot || slot.cards[c.index] !== c.cardId || !slot.faceUp[c.index]) continue // owner gone by the time its turn comes — skip silently

    if (c.hook.kind === 'selfDismissIf') {
      const inLowerRow = c.pos.section === 'base' && c.pos.row === 1
      const firstOrLast = c.pos.section === 'base' && ((c.pos.row === 0 && c.pos.col === 0) || (c.pos.row === 1 && c.pos.col === 2))
      const fires = c.hook.condition === 'inLowerRow' ? inLowerRow : firstOrLast
      if (!fires) continue
      if (cards[c.cardId].immune?.includes('dismiss')) continue
      const grid = cloneGrid(next.grid)
      const removedId = removeCardRaw(grid, c.pos, c.index)
      next = { ...next, grid, dismissed: [...next.dismissed, removedId] }
    } else if (c.hook.kind === 'dismissAdjacentRight') {
      const rightPos = adjacentRightPos(next.grid, c.pos)
      if (!rightPos) continue
      const rightSlot = getSlot(next.grid, rightPos)
      if (!rightSlot || rightSlot.cards.length === 0) continue
      const idx = rightSlot.cards.length - 1 // "if the target is a stack, dismiss any one card in the stack" (FAQ) — top of stack, same convention as dismiss()'s own default index
      if (!rightSlot.faceUp[idx]) continue // a face-down card cannot be dismissed
      const targetId = rightSlot.cards[idx]
      if (cards[targetId].immune?.includes('dismiss')) continue
      const grid = cloneGrid(next.grid)
      const removedId = removeCardRaw(grid, rightPos, idx)
      next = { ...next, grid, dismissed: [...next.dismissed, removedId] }
    } else if (c.hook.kind === 'dismissLowestRankInGrid') {
      // Plain reading (per this pass's plan): find the lowest-rank face-up
      // card GRID-WIDE first, THEN no-op if it turns out to be immune — NOT
      // "lowest among only the dismissible cards." This differs from
      // flip.ts's own findLowestRankTarget, which has no immunity concept
      // at all (Zebra/Coyote's return targets are resolved differently).
      const target = findLowestRankFaceUpCard(next.grid, cards)
      if (!target) continue
      if (cards[target.cardId].immune?.includes('dismiss')) continue
      const grid = cloneGrid(next.grid)
      const removedId = removeCardRaw(grid, target.pos, target.index)
      next = { ...next, grid, dismissed: [...next.dismissed, removedId] }
    }
  }

  return next
}

export function endMarketPhase(state: GameState): GameState {
  assertPhase(state, 'market', 'endMarketPhase')
  const afterHooks = runPostMarketHooks(state)
  const cards = cardsById()
  const decay = soloMarketDecay(afterHooks.market, afterHooks.toonDeck, cards, afterHooks.nextInsertionSeq)

  return {
    ...afterHooks,
    ...applyRefillResult(afterHooks, decay),
    actionsRemaining: 0,
    phase: 'cleanup',
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// Every card anywhere in the grid (face-up or face-down, every stack
// member) — "players collect their grid back into their deck" (§3.2)
// doesn't distinguish face state, and a face-down card is still a card
// physically sitting in the grid.
function collectGridCards(grid: Grid): CardId[] {
  const ids: CardId[] = []
  for (const { slot } of occupiedSlots(grid)) {
    ids.push(...slot.cards)
  }
  return ids
}

// Cleanup (§3.2): collect grid -> deck, refill the market (its own bullet,
// separate from the Market phase's per-action refills and the decay —
// idempotent/no-op if the market's already full), then check BOTH
// endgame triggers (§3.2.2, OR'd):
//   (a) fameGeneratedThisRound >= fameToTriggerEndgame  -> WIN (solo's own
//       §3.7 condition; reached via a normal Check Fame, no Final Flip
//       needed — see state.ts's GameState comment)
//   (b) toonDeckDepleted (set by ANY refill this round, not re-derived
//       here — §3.2.2)
// (a) is checked first: reaching 30 fame in the very round that also
// empties the toon deck should be a win, not a loss — the rules don't
// speak to simultaneity directly, but "generate 30 fame BEFORE the toon
// deck depletes" (§3.7) reads as fame-first when both land in the same
// round, since the round's Check Fame (which sets
// fameGeneratedThisRound) always happens strictly before that round's
// Market/Cleanup refills (which are what can set toonDeckDepleted).
// Otherwise: fame resets to 0, round increments, back to Flip.
export function runCleanup(state: GameState): GameState {
  assertPhase(state, 'cleanup', 'runCleanup')
  const cards = cardsById()

  const collectedDeck = [...state.deck, ...collectGridCards(state.grid)]
  const refill = refillMarket(state.market, state.toonDeck, cards, state.nextInsertionSeq)
  const refillFields = applyRefillResult(state, refill)

  const won = state.fameGeneratedThisRound >= state.fameToTriggerEndgame
  const lost = !won && refillFields.toonDeckDepleted

  // Every branch below moves the grid's cards into `collectedDeck` ("all
  // players collect their grid back into their deck", §3.2 — this applies
  // on the ending round too, nothing in the rules exempts it), so `grid`
  // must be cleared on ALL three branches, not just the "continue" one —
  // leaving it populated on the win/loss branches would double-count every
  // grid card (once in collectedDeck, once still sitting in the old grid).
  if (won) {
    return { ...state, ...refillFields, deck: collectedDeck, grid: emptyGrid(), phase: 'ended', result: 'win' }
  }
  if (lost) {
    return { ...state, ...refillFields, deck: collectedDeck, grid: emptyGrid(), phase: 'ended', result: 'loss' }
  }

  return {
    ...state,
    ...refillFields,
    deck: collectedDeck,
    grid: emptyGrid(),
    fame: 0,
    fameGeneratedThisRound: 0,
    round: state.round + 1,
    phase: 'flip',
  }
}
