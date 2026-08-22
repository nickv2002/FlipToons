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

import type { Card, CardId, Effect, EffectChoices } from './cards/types'
import { adjacentFaceUpCardIds, cloneGrid, emptyGrid, findLowestRankFaceUpCard, getSlot, occupiedSlots, setSlot } from './grid'
import { flipDeck } from './flip'
import { hireCost, refillMarket, soloMarketDecay } from './market'
import { shuffleWithState } from './rng'
import { scoreGrid } from './score'
import { cardsById } from './setup'
import type { GameState, PendingPostMarketChoice, PostMarketCandidate } from './state'
import type { Grid, GridPos } from './types'

function posLabel(pos: GridPos): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

function samePos(a: GridPos, b: GridPos): boolean {
  return a.section === b.section && a.row === b.row && a.col === b.col
}

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

export function runFlip(state: GameState, logLines?: string[], debugLines?: string[]): GameState {
  assertPhase(state, 'flip', 'runFlip')
  const cards = cardsById()
  const shuffled = shuffleWithState(state.deck, state.rng)
  const flipResult = flipDeck(shuffled.result, cards, { toonDeck: state.toonDeck, dismissed: state.dismissed })
  logLines?.push(...flipResult.flipNotes)
  debugLines?.push(...flipResult.debugNotes)

  return {
    ...state,
    rng: shuffled.next,
    grid: flipResult.grid,
    deck: flipResult.remainingDeck,
    toonDeck: flipResult.toonDeck,
    dismissed: flipResult.dismissed,
    pendingOnHireCardIds: [...state.pendingOnHireCardIds, ...flipResult.pendingOnHireCardIds],
    // Snake/Mongoose's toon-deck draws are bonus/optional (an empty toon
    // deck there is explicitly not an error — see flip.ts), so they never
    // count toward the depletion endgame trigger; toonDeckDepleted carries
    // forward unchanged via the `...state` spread above. Only a Market-
    // phase refill that actually comes up short (applyRefillResult below)
    // can set it.
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
//
// MULTIPLAYER: `otherGrids` carries every OTHER player's grid. Solo passes
// none, which reduces this to the market-only check described above — the
// exact behavior this had before the split, by construction rather than by a
// separate code path.
function countFaceUpInGrid(grid: Grid, ids: readonly CardId[]): number {
  let n = 0
  for (const { slot } of occupiedSlots(grid)) {
    slot.cards.forEach((cardId, i) => {
      if (slot.faceUp[i] && ids.includes(cardId)) n++
    })
  }
  return n
}

function dogElsewhereFromMarket(state: GameState, otherGrids: Grid[] = []): boolean {
  if (state.market.slots.some((id) => id === 'dog')) return true
  // "any OTHER player's grid" — Dog excludes its own grid, because the
  // condition is about OTHER Dogs. This is the one resolver of the three that
  // is self-excluding; see Fox below for the contrast.
  return otherGrids.some((g) => countFaceUpInGrid(g, ['dog']) > 0)
}

// Solo-specific resolution of the Camel's 'noOneHasMoreCamelsThanYou'
// condition (score.ts's evaluateBonus / cards/season1.ts's Camel entry):
// "the players' grids and/or the market." Solo has no other players, so
// (same reduction as Dog above) this reduces to "how many Camels are in
// the shared market" — real, observable GameState the phase machine has
// and scoreGrid itself does not.
//
// MULTIPLAYER: score.ts compares `ownCamelCount >= camelMarketCount`, so what
// this must return is the HIGHEST Camel count held by anyone else — the
// market, or any other player's grid — not a sum. That makes the comparison
// read exactly as the FAQ states it: "no one has STRICTLY MORE camels than
// you," with ties still qualifying.
function camelMarketCountFromMarket(state: GameState, otherGrids: Grid[] = []): number {
  const marketCount = state.market.slots.filter((id) => id === 'camel').length
  return Math.max(marketCount, ...otherGrids.map((g) => countFaceUpInGrid(g, ['camel'])), 0)
}

// Solo-specific resolution of the Fox's 'henOrRoosterInMarketOrAnyGrid'
// condition (score.ts's evaluateBonus / cards/season2.ts's Fox entry): the
// own-grid half is ordinary grid state score.ts checks directly, so only
// the shared market needs a real, observable GameState input — same
// reduction as Dog/Camel above, keyed on the literal ids 'hen'/'rooster'
// for the same reason dogElsewhereFromMarket names 'dog' directly.
//
// MULTIPLAYER: Fox's text is "in the market or ANY grid" — with no "other".
// Unlike Dog, it is NOT self-excluding: it checks for a DIFFERENT card
// (Hen/Rooster), so the Fox owner's own grid counts too. score.ts already
// checks the own-grid half directly, so only the market plus every other
// player's grid needs supplying here.
function henOrRoosterInMarketFromMarket(state: GameState, otherGrids: Grid[] = []): boolean {
  if (state.market.slots.some((id) => id === 'hen' || id === 'rooster')) return true
  return otherGrids.some((g) => countFaceUpInGrid(g, ['hen', 'rooster']) > 0)
}

export function runCheckFame(state: GameState, otherGrids: Grid[] = []): GameState {
  assertPhase(state, 'checkFame', 'runCheckFame')
  const cards = cardsById()
  const breakdown = scoreGrid(state.grid, cards, state.deck.length, {
    dogElsewhere: dogElsewhereFromMarket(state, otherGrids),
    dismissed: state.dismissed,
    camelMarketCount: camelMarketCountFromMarket(state, otherGrids),
    henOrRoosterInMarket: henOrRoosterInMarketFromMarket(state, otherGrids),
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
// `isStrictlyLowestFame` defaults to true, which is solo's vacuous truth (one
// player is trivially the lowest scorer). Multiplayer passes the real answer
// — see match.ts's runMatchPostFameHooks. Skunk's FAQ is explicit about the
// tie case: "Only one player can benefit from the skunk's ability each round.
// In case of a tie, the skunk has no effect." Hence STRICTLY lowest: a tie
// for last means the hook does not fire for anyone.
export function runPostFameHooks(state: GameState, isStrictlyLowestFame = true): GameState {
  assertPhase(state, 'postFameHooks', 'runPostFameHooks')
  const cards = cardsById()

  let fame = state.fame
  let pendingPostFameChoice = state.pendingPostFameChoice
  for (const { slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, i) => {
      if (!slot.faceUp[i]) return
      const card = cards[cardId]
      const hook = card.postFameHook
      if (!hook) return
      if (hook.condition !== 'strictlyLowestFame') {
        throw new Error(`phases.ts: runPostFameHooks — unhandled postFameHook condition '${hook.condition}' on ${card.name}`)
      }
      if (!isStrictlyLowestFame) return
      if (hook.effect.kind === 'gainFame') {
        // Firefly — flat, no choice needed.
        fame += hook.effect.amount
        return
      }
      // Skunk — "dismiss a card of your choosing", mandatory and free
      // (consumesAction: false, so it does NOT eat one of the two Market
      // actions). Its own FAQ confirms the Skunk may dismiss ITSELF, so it is
      // not excluded from its own option list. Immune cards are, as everywhere
      // else. No legal target -> nothing to ask, so no prompt is raised.
      const options: { pos: GridPos; index: number; cardId: CardId }[] = []
      for (const { pos, slot: s } of occupiedSlots(state.grid)) {
        s.cards.forEach((id, idx) => {
          if (!s.faceUp[idx]) return
          if (cards[id].immune?.includes('dismiss')) return
          options.push({ pos, index: idx, cardId: id })
        })
      }
      if (options.length === 0) return
      pendingPostFameChoice = { ownerCardId: cardId, cost: hook.effect.cost, options }
    })
  }

  // A pending choice pauses the phase: the Market phase must not open for this
  // seat until the mandatory dismissal is resolved.
  if (pendingPostFameChoice) {
    return { ...state, fame, pendingPostFameChoice }
  }

  let next: GameState = { ...state, fame, actionsRemaining: MARKET_ACTIONS_PER_ROUND, phase: 'market', pendingOnHireCardIds: [] }

  // Snake's deferred "if the stacked card has a When-Hired ability,
  // resolve it after the Flip phase is complete" (FAQ) — see flip.ts's
  // dismissOwnDeckTopAndStackFromToonDeck case. Applied AFTER the Market-
  // phase actionsRemaining reset above, so Peacock's bonus action is
  // additive on top of the normal 2, not a wash (same ordering concern as
  // hire()'s own onHire-firing comment).
  for (const cardId of state.pendingOnHireCardIds) {
    next = applyEffects(next, cards[cardId], cards[cardId].onHire)
  }

  return next
}

// Answers a pending Skunk dismissal, then finishes the postFameHooks pass the
// prompt interrupted. Free (cost 0 per the card data) and does NOT consume a
// Market action — the FAQ is explicit that a player who benefits from the
// Skunk "still take[s] up to two actions in the Market phase."
export function resolvePostFameChoice(state: GameState, choice: { pos: GridPos; index: number }): GameState {
  const pending = state.pendingPostFameChoice
  if (!pending) throw new Error('phases.ts: resolvePostFameChoice — this state has no pending post-fame choice')

  const target = pending.options.find((o) => o.index === choice.index && samePos(o.pos, choice.pos))
  if (!target) {
    throw new Error(`phases.ts: resolvePostFameChoice — ${JSON.stringify(choice)} is not one of the ${pending.options.length} legal option(s)`)
  }
  if (state.fame < pending.cost) {
    throw new Error(`phases.ts: resolvePostFameChoice — cannot afford the ${pending.cost} fame cost`)
  }

  const grid = cloneGrid(state.grid)
  const removedId = removeCardRaw(grid, target.pos, target.index)

  // The hook has now fired, so re-running the pass would re-prompt off the
  // same Skunk. Open the Market phase directly instead.
  const cards = cardsById()
  let next: GameState = {
    ...state,
    grid,
    dismissed: [...state.dismissed, removedId],
    fame: state.fame - pending.cost,
    pendingPostFameChoice: null,
    actionsRemaining: MARKET_ACTIONS_PER_ROUND,
    phase: 'market',
    pendingOnHireCardIds: [],
  }
  for (const cardId of state.pendingOnHireCardIds) {
    next = applyEffects(next, cards[cardId], cards[cardId].onHire)
  }
  return next
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
    // OR, never cleared — once a refill actually comes up short (a slot
    // needed a card and none was available), always depleted. The toon
    // deck's count merely reaching zero on a refill that still filled every
    // slot does NOT count (house rule — see state.ts's toonDeckDepleted
    // comment).
    toonDeckDepleted: state.toonDeckDepleted || refill.short,
  }
}

// Hire — pay the price card above the slot, card goes to the DECK (§3.2).
// CONFIRMED from the printed rulebook ("Refill the Market: Once a player
// has completed their actions, if there are fewer than five cards in the
// market, reveal cards... and rearrange... by rank"): refill is NOT a
// per-action thing — it fires ONCE, after all of a turn's Market actions
// are done (phases.ts's endMarketPhase). hire() therefore deliberately
// leaves the vacated slot EMPTY; it does NOT call refillMarket itself. The
// one confirmed exception is Horse's own ability ("If a player hires a
// horse, immediately discard any number of cards in the market, reveal an
// equal number of new cards... and arrange them by rank") — a card-specific
// IMMEDIATE refill, handled entirely by applyEffects's discardMarketAndRefill
// case below (which also covers Horse's own vacated slot — see its comment).
export function hire(state: GameState, slotIndex: number, choices?: EffectChoices): GameState {
  assertPhase(state, 'market', 'hire')
  if (state.pendingPostMarketChoice) throw new Error('phases.ts: hire — a pending post-Market choice must be resolved first')
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
  const card = cards[cardId]

  const hired: GameState = {
    ...state,
    fame: state.fame - price,
    deck: [...state.deck, cardId],
    actionsRemaining: state.actionsRemaining - 1,
    market: marketAfterRemoval,
  }

  // onHire fires AFTER the above (post-decrement) — see applyEffects's
  // header comment (Peacock's bonus action must be additive on the
  // decremented actionsRemaining, not a wash). Choice indices in `choices`
  // (e.g. Horse's/Crow's market-slot targets) refer to THIS still-gapped
  // market (this card's own vacated slot included), not a refilled one — no
  // refill has happened yet at this point for anyone.
  return applyEffects(hired, card, card.onHire, choices)
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
// Where is this card id sitting in the grid, if anywhere? Only used by
// placeSelfInAnyDeck, whose card (Pig) has copies: 1 — so "the first match"
// is unambiguously "the one that just triggered".
function findCardInGrid(grid: Grid, cardId: CardId): { pos: GridPos; index: number } | null {
  for (const { pos, slot } of occupiedSlots(grid)) {
    const index = slot.cards.indexOf(cardId)
    if (index >= 0) return { pos, index }
  }
  return null
}

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
        // Horse: CONFIRMED FAQ exception to the normal once-per-turn refill
        // (see hire()'s header comment) — its own ability refills
        // IMMEDIATELY. The discard choice itself is OPTIONAL ("any number" —
        // zero is a legal, meaningful choice), but this refill always runs
        // regardless: hire() deliberately left THIS card's own vacated slot
        // unrefilled (every hire does, now — see hire()'s comment), and this
        // is the only place that slot gets filled BEFORE the normal
        // end-of-turn point — USER-DIRECTED: combine this card's own gap
        // with any additionally-chosen slots into ONE refillMarket call
        // (not two sequential ones), even when zero additional slots are
        // chosen, so the player never has to separately wait for Horse's own
        // vacancy to resolve. Skipping this entirely on decline would leave
        // it to the normal end-of-turn refill instead — also correct, but
        // not what was asked for here.
        const additionalSlots = choices?.discardMarketSlots ?? []
        const marketAfterDiscard = {
          prices: next.market.prices,
          slots: next.market.slots.slice(),
          insertionSeq: next.market.insertionSeq.slice(),
        }
        for (const i of additionalSlots) {
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
      case 'placeSelfInAnyDeck': {
        // Pig (its own FAQ: "can be placed in any player's deck or back in
        // the toon deck"). MANDATORY, and the one effect in the vocabulary
        // that reaches ACROSS players — so this half only DETACHES the card
        // from wherever it just landed and records that a destination is
        // owed. A PlayerView cannot see another seat's deck; match.ts's
        // matchResolveDeckPlacement does the actual placing.
        //
        // Where "wherever it just landed" is depends on the trigger: hire()
        // has already placed it in the grid, dismiss() has already pushed it
        // onto the dismissed pile.
        const found = findCardInGrid(next.grid, card.id)
        if (found) {
          const grid = cloneGrid(next.grid)
          removeCardRaw(grid, found.pos, found.index)
          next = { ...next, grid, pendingDeckPlacement: { cardId: card.id, source: 'hire' } }
          break
        }
        const dismissedIdx = next.dismissed.lastIndexOf(card.id)
        if (dismissedIdx >= 0) {
          next = {
            ...next,
            dismissed: [...next.dismissed.slice(0, dismissedIdx), ...next.dismissed.slice(dismissedIdx + 1)],
            pendingDeckPlacement: { cardId: card.id, source: 'dismiss' },
          }
          break
        }
        throw new Error(`phases.ts: placeSelfInAnyDeck — ${card.name} is neither in the grid nor the dismissed pile`)
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
export function dismissCostFor(grid: Grid, pos: GridPos, index: number, cardsById: Record<CardId, Card>): number {
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
// from the grid permanently, face-up beside the deck (§3.2, §3.3a). Doesn't
// touch the market at all — dismiss removes from the player's OWN GRID, not
// a market slot, and (per hire()'s header comment) refill only happens
// ONCE, at the end of the Market phase, not per action.
export function dismiss(state: GameState, pos: GridPos, index?: number, choices?: EffectChoices): GameState {
  assertPhase(state, 'market', 'dismiss')
  if (state.pendingPostMarketChoice) throw new Error('phases.ts: dismiss — a pending post-Market choice must be resolved first')
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

  const dismissedState: GameState = {
    ...state,
    fame: state.fame - cost,
    grid,
    dismissed: [...state.dismissed, cardId],
    actionsRemaining: state.actionsRemaining - 1,
  }

  // onDismiss fires AFTER the above (post-decrement) — same ordering
  // rationale as hire()'s onHire call. `card` here is the DISMISSED card
  // (Crow), not whatever the effect subsequently hires. Crow's own
  // hireFromMarketAndRefill (applyEffects below) is its own confirmed
  // card-specific immediate market action, same category as Horse's.
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
// Shared candidate-processing loop, used both for a fresh
// runPostMarketHooks pass and for resuming one after resolvePostMarketChoice
// answers an Alligator stack-target prompt. Returns early — with
// pendingPostMarketChoice set and the remaining candidates stashed for later
// — the moment a dismissAdjacentRight target has 2+ eligible cards; every
// other candidate before that point has already been applied to the
// returned state.
function applyPostMarketCandidates(state: GameState, candidates: PostMarketCandidate[], cards: Record<CardId, Card>, logLines?: string[]): GameState {
  let next = state

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
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
      logLines?.push(`Dismissed ${cards[removedId].name} at ${posLabel(c.pos)} (${cards[c.cardId].name}).`)
    } else if (c.hook.kind === 'dismissAdjacentRight') {
      const rightPos = adjacentRightPos(next.grid, c.pos)
      if (!rightPos) continue
      const rightSlot = getSlot(next.grid, rightPos)
      if (!rightSlot || rightSlot.cards.length === 0) continue
      // Eligible = every face-up, non-immune card ANYWHERE in the stack, not
      // just the top — the FAQ's "if the target is a stack, dismiss any one
      // card in the stack" means (a) a face-down top no longer blocks a
      // dismissible face-up card underneath it, and (b) an immune top (e.g.
      // Cat) no longer blocks a dismissible face-up card underneath it
      // either — immunity protects the immune card itself, not the whole
      // stack it happens to sit atop. Both are rules changes from the old
      // top-of-stack-only behavior, which no-op'd the entire hook on either
      // condition regardless of what else was in the stack.
      const eligible: { pos: GridPos; index: number; cardId: CardId }[] = []
      rightSlot.cards.forEach((cardId, idx) => {
        if (!rightSlot.faceUp[idx]) return
        if (cards[cardId].immune?.includes('dismiss')) return
        eligible.push({ pos: rightPos, index: idx, cardId })
      })
      if (eligible.length === 0) continue
      if (eligible.length > 1) {
        return {
          ...next,
          pendingPostMarketChoice: {
            ownerCardId: c.cardId,
            ownerPos: c.pos,
            targetPos: rightPos,
            options: eligible,
            remainingCandidates: candidates.slice(i + 1),
          },
        }
      }
      const target = eligible[0]
      const grid = cloneGrid(next.grid)
      const removedId = removeCardRaw(grid, target.pos, target.index)
      next = { ...next, grid, dismissed: [...next.dismissed, removedId] }
      logLines?.push(`Dismissed ${cards[removedId].name} at ${posLabel(target.pos)} (${cards[c.cardId].name} at ${posLabel(c.pos)}).`)
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
      logLines?.push(`Dismissed ${cards[removedId].name} at ${posLabel(target.pos)} (${cards[c.cardId].name}).`)
    }
  }

  return { ...next, pendingPostMarketChoice: null }
}

export function runPostMarketHooks(state: GameState, logLines?: string[]): GameState {
  const cards = cardsById()

  const candidates: PostMarketCandidate[] = []
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, i) => {
      if (!slot.faceUp[i]) return
      const hook = cards[cardId].postMarketHook
      if (hook) candidates.push({ pos, index: i, cardId, hook })
    })
  }

  return applyPostMarketCandidates(state, candidates, cards, logLines)
}

// CONFIRMED rulebook text ("Once a player has completed their actions...
// reveal cards... until there are five available and rearrange... by
// rank"): THIS is the standard once-per-turn refill — the one place any
// gaps hire()/dismiss() left mid-turn (every hire but Horse leaves one;
// dismiss never touches the market) actually get filled. Must run BEFORE
// the decay step below: soloMarketDecay reads literal positions 0 and
// length-1 as "leftmost"/"rightmost" (market.ts's own comment), which
// only means what it says once the market is full/right-justified — an
// interior gap from an un-refilled mid-turn hire would corrupt that.
// STAGE 1 HAZARD (multiplayer), flagged here because the per-player/shared
// split does NOT surface it in the signature: this function writes both
// `actionsRemaining: 0` (per-player) and `phase: 'cleanup'` (SHARED) in one
// return. Committed from one player's view, that ends the Market phase for
// the whole table while the other seats still have turns to take. When the
// turn machine lands, the phase transition has to move out of this per-player
// function and fire only when activePlayerIndex wraps; the standard refill
// stays per-turn and the 1-2 player decay fires once, after the last seat.
// runCleanup's `phase`/`round` writes have the same shape.
function finishEndMarketPhase(state: GameState): GameState {
  const cards = cardsById()
  const standardRefill = refillMarket(state.market, state.toonDeck, cards, state.nextInsertionSeq)
  const afterStandardRefill = { ...state, ...applyRefillResult(state, standardRefill) }

  const decay = soloMarketDecay(afterStandardRefill.market, afterStandardRefill.toonDeck, cards, afterStandardRefill.nextInsertionSeq)

  return {
    ...afterStandardRefill,
    ...applyRefillResult(afterStandardRefill, decay),
    actionsRemaining: 0,
    phase: 'cleanup',
  }
}

// The standard once-per-TURN refill, split out of finishEndMarketPhase so the
// multiplayer turn machine can fire it after each seat's actions while the
// decay and the phase transition stay once-per-ROUND (§3.2.2's "there are now
// two places a refill happens"). Solo still reaches it via
// finishEndMarketPhase, unchanged.
export function runStandardRefill(state: GameState): GameState {
  const cards = cardsById()
  const refill = refillMarket(state.market, state.toonDeck, cards, state.nextInsertionSeq)
  return { ...state, ...applyRefillResult(state, refill) }
}

// The 1-2 player market decay (§3.6). Fires ONCE per round, after the LAST
// seat's refill — never per turn, never at Cleanup. Must run after a standard
// refill has closed any mid-turn gaps: it reads literal positions 0 and
// length-1 as leftmost/rightmost, which only means what it says once the
// market is full.
export function runMarketDecay(state: GameState): GameState {
  const cards = cardsById()
  const decay = soloMarketDecay(state.market, state.toonDeck, cards, state.nextInsertionSeq)
  return { ...state, ...applyRefillResult(state, decay) }
}

export function endMarketPhase(state: GameState, logLines?: string[]): GameState {
  assertPhase(state, 'market', 'endMarketPhase')
  if (state.pendingPostMarketChoice) {
    throw new Error('phases.ts: endMarketPhase — a pending post-Market choice must be resolved first (call resolvePostMarketChoice)')
  }
  const afterHooks = runPostMarketHooks(state, logLines)
  if (afterHooks.pendingPostMarketChoice) return afterHooks // paused — waiting on Alligator's stack-target choice, still phase 'market'
  return finishEndMarketPhase(afterHooks)
}

// Resolves a pending Alligator stack-target choice (GameState.
// pendingPostMarketChoice), then resumes the rest of that endMarketPhase
// pass — any later postMarketHook candidates, then the standard refill/decay/
// phase transition, exactly as if the whole sequence had run uninterrupted.
export function resolvePostMarketChoice(state: GameState, choice: { pos: GridPos; index: number }, logLines?: string[]): GameState {
  const pending = state.pendingPostMarketChoice
  if (!pending) throw new Error('phases.ts: resolvePostMarketChoice — this state has no pending post-Market choice')

  const target = pending.options.find((o) => o.index === choice.index && samePos(o.pos, choice.pos))
  if (!target) {
    throw new Error(`phases.ts: resolvePostMarketChoice — ${JSON.stringify(choice)} is not one of the ${pending.options.length} legal option(s)`)
  }

  const cards = cardsById()
  const grid = cloneGrid(state.grid)
  const removedId = removeCardRaw(grid, target.pos, target.index)
  const next: GameState = {
    ...state,
    grid,
    dismissed: [...state.dismissed, removedId],
    pendingPostMarketChoice: null,
  }
  logLines?.push(`Dismissed ${cards[removedId].name} at ${posLabel(target.pos)} (${cards[pending.ownerCardId].name} at ${posLabel(pending.ownerPos)}).`)

  const afterHooks = applyPostMarketCandidates(next, pending.remainingCandidates, cards, logLines)
  if (afterHooks.pendingPostMarketChoice) return afterHooks // another Alligator needs a choice too
  return finishEndMarketPhase(afterHooks)
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
//   (b) toonDeckDepleted (set by any refill this round that actually came
//       up short — a slot needed a card the toon deck didn't have — not
//       re-derived here; a house rule loosening of §3.2.2's literal "the
//       toon deck is ever depleted": the toon deck's count merely reaching
//       zero on a refill that still filled every slot does not end the
//       game — see state.ts's toonDeckDepleted comment)
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
