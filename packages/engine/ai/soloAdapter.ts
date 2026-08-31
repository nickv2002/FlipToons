// AiAdapter<GameState, Action> over actions.ts's applyAction — the ONLY
// place this AI touches solo's reducer. Solo's phase machine auto-cascades
// through every no-decision phase (flip -> checkFame -> postFameHooks ->
// cleanup) inside a single { kind: 'flip' } dispatch (see actions.ts's
// advanceThroughPassthroughPhases) and after every hire/dismiss/endMarket
// too (closeMarketIfExhausted) — so the only phase with a real decision to
// search over is 'market'; everywhere else there is exactly one legal
// candidate.
import type { Action } from '../actions'
import { applyAction, buildNewGameState, listDismissEntries } from '../actions'
import type { Card, CardId, Effect, EffectChoices } from '../cards/types'
import type { DismissTarget, HireFromDismissedTarget, PendingChoice } from '../hireChoices'
import { buildEffectChoices, computePendingChoice } from '../hireChoices'
import { hireCost } from '../market'
import { cardsById } from '../setup'
import type { GameState } from '../state'
import type { AiAdapter } from './core'

const cards = cardsById()

// One candidate per legal choice a card's onHire/onDismiss offers, rather
// than a single candidate with `choices` left unset — that's the bug the old
// ai.ts had: applyEffects throws for a MANDATORY choice effect (Panther's
// dismissChosenGridCard) when a legal target exists and no choices were
// supplied, so a candidate that skips a mandatory choice was never legal in
// the first place. Optional choices additionally get a "decline" candidate
// (no `choices` field at all — applyEffects no-ops on an absent choice).
//
// discardMarketAndRefill (Horse) is the one choice kind whose selection is a
// SET of market slots, not a single target — enumerating every subset would
// blow up the branching factor for a card that's already rare (5/62). This
// offers one candidate per single slot plus skip, not the full power set; a
// human player retains the option the AI doesn't search over.
function choicesForEffects(state: GameState, effects: Effect[] | undefined, excludeMarketSlot?: number): (EffectChoices | undefined)[] {
  const choice = computePendingChoice(state, effects, cards, excludeMarketSlot)
  if (!choice) return [undefined]

  const selections = selectionsFor(choice)
  const built = selections.map((selection) => buildEffectChoices(choice, selection))
  return choice.mandatory ? built : [undefined, ...built]
}

function selectionsFor(choice: PendingChoice): (DismissTarget | HireFromDismissedTarget | number | number[])[] {
  switch (choice.kind) {
    case 'dismissByName':
    case 'dismissChosenGridCard':
      return choice.options
    case 'hireFromDismissed':
      return choice.options
    case 'hireFromMarketAndRefill':
      return choice.options
    case 'discardMarketAndRefill':
      return choice.options.map((slot) => [slot])
    case 'dismissAlligatorTarget':
      // Never reached here — this kind comes from GameState.pendingPostMarketChoice
      // (handled separately below, via 'resolvePostMarketChoice'), not from
      // computePendingChoice off a hire/dismiss's own effects.
      return []
  }
}

function marketCandidates(state: GameState): Action[] {
  if (state.pendingPostMarketChoice) {
    return state.pendingPostMarketChoice.options.map((o) => ({ kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }) as const)
  }
  const candidates: Action[] = [{ kind: 'endMarket' }]
  if (state.phase !== 'market' || state.actionsRemaining <= 0) return candidates

  state.market.slots.forEach((cardId, slotIndex) => {
    if (cardId === null) return
    if (hireCost(state.market, slotIndex) > state.fame) return
    const card: Card = cards[cardId]!
    for (const choices of choicesForEffects(state, card.onHire, slotIndex)) {
      candidates.push({ kind: 'hire', slotIndex, choices })
    }
  })

  for (const entry of listDismissEntries(state)) {
    const card: Card = cards[entry.cardId as CardId]!
    for (const choices of choicesForEffects(state, card.onDismiss)) {
      candidates.push({ kind: 'dismiss', pos: entry.pos, index: entry.stackIndex, choices })
    }
  }

  return candidates
}

export const soloAdapter: AiAdapter<GameState, Action> = {
  legalCandidates(state) {
    if (state.phase === 'ended') return []
    if (state.phase !== 'market') return [{ kind: 'flip' }]
    return marketCandidates(state)
  },
  apply(state, action) {
    return applyAction(state, action).state
  },
  isTerminal(state) {
    return state.phase === 'ended'
  },
  reward(state) {
    return state.result === 'win' ? 1 : 0
  },
  clone(state) {
    return structuredClone(state)
  },
}

// Convenience constructor mirroring actions.ts's buildNewGameState, so
// callers driving the AI don't need to import both modules.
export { buildNewGameState }
