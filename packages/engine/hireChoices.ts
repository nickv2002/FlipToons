// UI-facing helper for the small set of onHire/onDismiss effects that need
// a player choice before applyEffects (phases.ts) can resolve them —
// Butterfly/Panther/Raccoon/Crow/Horse (see cards/types.ts's Effect/
// EffectChoices comments for the full list). Neither tui.ts nor the old web
// client threaded EffectChoices through hire()/dismiss() at all (see
// ChoicePrompt.tsx's former header comment) — this module is what lets a
// real client compute "does this card need a prompt, and what are the legal
// options" from a GameState alone, BEFORE calling hire()/dismiss(), so it
// can show a picker and build the EffectChoices object the engine expects.
//
// Every one of today's choice-needing effects targets state that hire()/
// dismiss() themselves don't touch before firing onHire/onDismiss (the
// grid, the dismissed pile, the market) — see hire()'s own header comment
// ("no refill has happened yet at this point for anyone") — so it's safe to
// compute options from the PRE-action GameState, with one exception: Horse/
// Crow-style market-slot choices must exclude the slot the card being
// hired/dismissed itself occupies, since hire()/dismiss() vacate that slot
// before their card's own onHire/onDismiss fires.
import type { Card, CardId, Effect, EffectChoices } from './cards/types'
import { occupiedSlots } from './grid'
import type { GameState } from './state'
import type { GridPos } from './types'

export type DismissTarget = { pos: GridPos; index: number; cardId: CardId }

export type PendingChoice =
  | { kind: 'dismissByName'; mandatory: false; cost: number; options: DismissTarget[] }
  | { kind: 'dismissChosenGridCard'; mandatory: true; cost: number; options: DismissTarget[] }
  | { kind: 'hireFromDismissed'; mandatory: false; cost: number; options: CardId[] }
  | { kind: 'hireFromMarketAndRefill'; mandatory: false; cost: number; options: number[] }
  | { kind: 'discardMarketAndRefill'; mandatory: false; options: number[] }
  // Alligator's dismissAdjacentRight postMarketHook, when its target is a
  // stack of 2+ eligible cards — sourced from GameState.pendingPostMarketChoice
  // (phases.ts), not computed here like the other kinds above, since it's
  // driven by endMarketPhase rather than a hire()/dismiss() action.
  | { kind: 'dismissAlligatorTarget'; mandatory: true; cost: 0; options: DismissTarget[] }

function collectDismissTargets(state: GameState, cards: Record<CardId, Card>): DismissTarget[] {
  const targets: DismissTarget[] = []
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, index) => {
      if (!slot.faceUp[index]) return
      if (cards[cardId].immune?.includes('dismiss')) return
      targets.push({ pos, index, cardId })
    })
  }
  return targets
}

function occupiedMarketSlots(state: GameState, excludeSlotIndex?: number): number[] {
  const result: number[] = []
  state.market.slots.forEach((cardId, i) => {
    if (cardId !== null && i !== excludeSlotIndex) result.push(i)
  })
  return result
}

// At most one of today's cards' onHire/onDismiss arrays contains a
// choice-needing effect kind (the rest are choice-free — gainFame,
// bonusMarketAction, 'other') — this returns that single PendingChoice, or
// null when either no such effect exists on this card or one does but has
// no legal target (a true no-op, matching applyEffects's own silent-skip
// behavior — see e.g. dismissByName's "no-op if declined/no choice given").
export function computePendingChoice(
  state: GameState,
  effects: Effect[] | undefined,
  cards: Record<CardId, Card>,
  excludeMarketSlot?: number,
): PendingChoice | null {
  for (const effect of effects ?? []) {
    switch (effect.kind) {
      case 'dismissByName': {
        const options = collectDismissTargets(state, cards).filter((t) => t.cardId === effect.targetCardId)
        if (options.length === 0) continue
        return { kind: 'dismissByName', mandatory: false, cost: effect.cost, options }
      }
      case 'dismissChosenGridCard': {
        const options = collectDismissTargets(state, cards)
        if (options.length === 0) continue
        return { kind: 'dismissChosenGridCard', mandatory: true, cost: effect.cost, options }
      }
      case 'hireFromDismissed': {
        if (state.dismissed.length === 0) continue
        return { kind: 'hireFromDismissed', mandatory: false, cost: effect.cost, options: state.dismissed.slice() }
      }
      case 'hireFromMarketAndRefill': {
        const options = occupiedMarketSlots(state, excludeMarketSlot)
        if (options.length === 0) continue
        return { kind: 'hireFromMarketAndRefill', mandatory: false, cost: effect.cost, options }
      }
      case 'discardMarketAndRefill': {
        const options = occupiedMarketSlots(state, excludeMarketSlot)
        if (options.length === 0) continue
        return { kind: 'discardMarketAndRefill', mandatory: false, options }
      }
      default:
        continue
    }
  }
  return null
}

// Builds the EffectChoices object hire()/dismiss() expect from a player's
// resolved selection (or an explicit skip, for every kind but Panther's
// mandatory one — callers must not offer a skip option for 'mandatory: true').
export function buildEffectChoices(choice: PendingChoice, selection: DismissTarget | CardId | number | number[] | 'skip'): EffectChoices {
  if (selection === 'skip') {
    if (choice.kind === 'discardMarketAndRefill') return { discardMarketSlots: [] }
    return {}
  }
  switch (choice.kind) {
    case 'dismissByName': {
      const target = selection as DismissTarget
      return { dismissByName: { pos: target.pos, index: target.index } }
    }
    case 'dismissChosenGridCard': {
      const target = selection as DismissTarget
      return { dismissGridPos: { pos: target.pos, index: target.index } }
    }
    case 'hireFromDismissed': {
      return { hireFromDismissed: { cardId: selection as CardId } }
    }
    case 'hireFromMarketAndRefill': {
      return { hireFromMarketSlot: { slotIndex: selection as number } }
    }
    case 'discardMarketAndRefill': {
      return { discardMarketSlots: selection as number[] }
    }
    case 'dismissAlligatorTarget': {
      // Not resolved through hire()/dismiss()'s EffectChoices at all — this
      // kind is answered via the 'resolvePostMarketChoice' action instead
      // (see RoundView.tsx's resolveAlligatorChoice), which never calls this
      // function. Present only so the switch stays exhaustive.
      throw new Error(`hireChoices.ts: buildEffectChoices — 'dismissAlligatorTarget' is resolved via resolvePostMarketChoice, not EffectChoices`)
    }
  }
}
