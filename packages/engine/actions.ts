// The pure action layer between a transport (React state, a WebSocket
// connection, a test) and the engine — the reducer shape
// (state, action) -> { state, logLines } is transport-free and UI-free on
// purpose, so apps/web's useGame.ts and apps/server's room loop both import
// this SAME module instead of each re-deriving the action vocabulary (see
// flip-toonz-structure-plan.md §6's client/server split, and §8's original
// key-files list, which named this file here from the start).
import type { CardId, EffectChoices } from './cards/types'
import { occupiedSlots } from './grid'
import { hireCost } from './market'
import {
  dismiss,
  dismissCostFor,
  endMarketPhase,
  hire,
  resolvePostMarketChoice,
  runCheckFame,
  runCleanup,
  runFlip,
  runPostFameHooks,
} from './phases'
import { cardsById } from './setup'
import { createSoloGameState } from './state'
import type { GameState } from './state'
import { buildSoloSetup } from './setup'
import type { SoloDifficulty } from './setup'
import type { GridPos } from './types'
import { formatBreakdown } from './score'
import { shuffleWithState } from './rng'

export type Action =
  | { kind: 'flip' }
  | { kind: 'checkFame' } // flip -> checkFame is already done by runFlip; this runs the actual scoring (plan §5: "this is the single view that teaches the game" — kept as its own step so the breakdown has a moment on screen before Market)
  | { kind: 'continueToMarket' } // postFameHooks (a pass-through in solo — see phases.ts's header comment) -> market
  | { kind: 'hire'; slotIndex: number; choices?: EffectChoices } // choices resolves the hired card's own onHire prompt, if any — see hireChoices.ts
  | { kind: 'dismiss'; pos: GridPos; index: number; choices?: EffectChoices } // choices resolves the dismissed card's own onDismiss prompt (Crow), if any
  | { kind: 'endMarket' }
  | { kind: 'resolvePostMarketChoice'; pos: GridPos; index: number } // answers GameState.pendingPostMarketChoice — Alligator's stack-target pick
  | { kind: 'advanceCleanup' }

export type ApplyResult = { state: GameState; logLines: string[] }

const cards = cardsById()

export function buildNewGameState(seed: number, difficulty: SoloDifficulty, season: 1 | 2): GameState {
  const setup = buildSoloSetup(seed, season, difficulty)
  return createSoloGameState({
    seed: setup.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
}

// Mirrors tui.ts's listDismissEntries exactly — reading-order index over
// every FACE-UP card in the grid, stacks expanded. Both the display and the
// dismiss action must use the SAME order, or the number shown wouldn't
// match what gets dismissed.
export type DismissEntry = { index: number; pos: GridPos; stackIndex: number; cardId: CardId; cost: number }

export function listDismissEntries(state: GameState): DismissEntry[] {
  const entries: DismissEntry[] = []
  let i = 0
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, stackIndex) => {
      if (!slot.faceUp[stackIndex]) return
      const cost = dismissCostFor(state.grid, pos, stackIndex, cards)
      entries.push({ index: i, pos, stackIndex, cardId, cost })
      i++
    })
  }
  return entries
}

// Whether the player has ANY legal Market action left — a hireable slot
// they can afford, or a dismissible (non-immune) grid card they can afford.
// Drives the web UI's auto-end (useGame.ts): once this goes false there's
// nothing left to decide, so sitting in the Market phase waiting for a
// manual "End Market phase" click is pure friction, not a real choice.
export function hasAnyLegalMarketAction(state: GameState): boolean {
  // A pending post-Market choice (Alligator's stack-target pick) means
  // hire()/dismiss() are already refusing to run (phases.ts) until it's
  // resolved — false here regardless of actionsRemaining/affordability.
  if (state.pendingPostMarketChoice) return false
  if (state.phase !== 'market' || state.actionsRemaining <= 0) return false

  const canHire = state.market.slots.some(
    (cardId, slotIndex) => cardId !== null && state.fame >= hireCost(state.market, slotIndex),
  )
  if (canHire) return true

  return listDismissEntries(state).some(({ cardId, cost }) => {
    if (cards[cardId].immune?.includes('dismiss')) return false
    return state.fame >= cost
  })
}

// Same message-cleanup tui.ts applies before showing a rejected action to
// the player (strips the internal "phases.ts: fn — " prefix); a real
// phase-machine bug (assertPhase's message shape) is rethrown instead of
// being turned into a friendly log line, same split as tui.ts's
// rethrowIfEngineBug/playerFacingMessage.
function isEngineBug(err: unknown): boolean {
  return err instanceof Error && /^phases\.ts: \w+ called in phase/.test(err.message)
}

function playerFacingMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^phases\.ts: \w+ — /, '')
}

function posLabel(pos: GridPos): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

// The UI never dispatches 'checkFame' / 'continueToMarket' / 'advanceCleanup'
// directly any more (see the module comment on the Action union) — the goal
// is zero-click auto-advance through every no-decision phase, so a round
// goes straight from cleanup into the next market screen (or into 'ended')
// with no intermediate screens shown at all, not even a brief flash. This
// helper is the single place that cascade lives: given a state that may be
// sitting in 'cleanup', 'flip', 'checkFame', or 'postFameHooks' (any prefix
// of that sequence — callers enter at whichever phase they're already in),
// it drives forward phase-by-phase until landing on 'market' or 'ended',
// appending the same log lines each individual action used to produce so no
// information is lost by removing the intermediate screens.
export function advanceThroughPassthroughPhases(state: GameState, logLines: string[]): GameState {
  let next = state

  if (next.phase === 'cleanup') {
    const roundJustEnded = next.round
    const fameThisRound = next.fameGeneratedThisRound
    const threshold = next.fameToTriggerEndgame
    next = runCleanup(next)
    if (next.phase === 'ended') {
      logLines.push(
        next.result === 'win'
          ? `YOU WIN — reached ${fameThisRound}/${threshold} fame in round ${roundJustEnded}.`
          : `YOU LOSE — the toon deck depleted and the market could not refill (round ${roundJustEnded}).`,
      )
      return next
    }
    logLines.push(`Round ${roundJustEnded} complete. Fame resets to 0. Advancing to round ${next.round}.`)
  }

  if (next.phase === 'flip') {
    // Season 1 has no Return-to-deck effect, so the pre-flip shuffle order
    // IS the actual reveal order — a pure re-derivation of runFlip's own
    // internal shuffle (same deck, same rng state), not a second live
    // shuffle. Matches tui.ts's flip-order preview line.
    const preview = shuffleWithState(next.deck, next.rng).result
    logLines.push(`Round ${next.round}: flip order — ${preview.map((id) => cards[id]?.name ?? id).join(', ') || '(empty deck)'}`)
    next = runFlip(next, logLines)
    logLines.push(`${next.deck.length} card(s) left in your deck.`)
  }

  if (next.phase === 'checkFame') {
    next = runCheckFame(next)
    if (next.lastCheckFame) logLines.push(formatBreakdown(next.lastCheckFame))
  }

  if (next.phase === 'postFameHooks') {
    // Provably a pass-through in solo — see phases.ts's runPostFameHooks
    // header comment (Skunk/Firefly are both starting-deck-only and solo's
    // setup swaps the least-fame starter out).
    next = runPostFameHooks(next)
  }

  return next
}

// tui.ts's runMarketPhase: "actionsRemaining hit 0 without an explicit
// `end` — auto-close the Market phase rather than offering an action that
// would only throw." Same rule here, run after every successful hire/dismiss.
function closeMarketIfExhausted(state: GameState, logLines: string[]): GameState {
  if (state.phase === 'market' && state.actionsRemaining <= 0) {
    logLines.push('No Market actions remaining — ending the Market phase.')
    let next = endMarketPhase(state, logLines)
    if (next.pendingPostMarketChoice) return next // paused — waiting on Alligator's stack-target choice
    if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines)
    return next
  }
  return state
}

// House rule, explicitly requested: the physical rulebook's documented
// timing (flip-toonz-structure-plan.md line ~716 — "reaching the fame
// threshold still allows that round's full Market phase," trigger evaluated
// at Cleanup) is deliberately overridden here. The instant a player's
// spendable `fame` reaches the threshold — at Check Fame, or mid-Market via
// a gainFame effect like Peacock's — the game ends right there instead of
// waiting for that round's Market phase (or Cleanup) to run.
function checkInstantWin(state: GameState): GameState {
  if (state.phase === 'ended' || state.fame < state.fameToTriggerEndgame) return state
  return { ...state, phase: 'ended', result: 'win' }
}

export function applyAction(state: GameState, action: Action): ApplyResult {
  const result = applyActionRaw(state, action)
  const won = checkInstantWin(result.state)
  if (won === result.state) return result
  return { state: won, logLines: [...result.logLines, `YOU WIN — reached ${won.fame}/${won.fameToTriggerEndgame} fame.`] }
}

function applyActionRaw(state: GameState, action: Action): ApplyResult {
  const logLines: string[] = []

  if (action.kind === 'flip') {
    // Cascades all the way through checkFame and postFameHooks (both
    // no-decision pass-throughs) so the caller always lands on 'market' —
    // see advanceThroughPassthroughPhases above.
    const next = advanceThroughPassthroughPhases(state, logLines)
    return { state: next, logLines }
  }

  if (action.kind === 'checkFame') {
    const next = runCheckFame(state)
    if (next.lastCheckFame) logLines.push(formatBreakdown(next.lastCheckFame))
    return { state: next, logLines }
  }

  if (action.kind === 'continueToMarket') {
    // Provably a pass-through in solo — see phases.ts's runPostFameHooks
    // header comment (Skunk/Firefly are both starting-deck-only and solo's
    // setup swaps the least-fame starter out).
    const next = runPostFameHooks(state)
    return { state: next, logLines }
  }

  if (action.kind === 'hire') {
    const cardId = state.market.slots[action.slotIndex]
    const price = action.slotIndex >= 0 && action.slotIndex < state.market.prices.length ? hireCost(state.market, action.slotIndex) : undefined
    try {
      let next = hire(state, action.slotIndex, action.choices)
      const card = cards[cardId!]
      logLines.push(`Hired ${card.name} for ${price} fame.`)
      if (card.unencodable) logLines.push(`  Note: ${card.name}'s effect is not simulated by the engine — resolve it manually if it matters.`)
      next = closeMarketIfExhausted(next, logLines)
      return { state: next, logLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      logLines.push(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines }
    }
  }

  if (action.kind === 'dismiss') {
    const slot = action.pos.section === 'base' ? state.grid.base[action.pos.row]?.[action.pos.col] : state.grid.extraRows[action.pos.row]?.[action.pos.col]
    const cardId = slot?.cards[action.index]
    try {
      const cost = dismissCostFor(state.grid, action.pos, action.index, cards)
      let next = dismiss(state, action.pos, action.index, action.choices)
      const card = cardId ? cards[cardId] : undefined
      logLines.push(`Dismissed ${card?.name ?? cardId} at ${posLabel(action.pos)} for ${cost} fame.`)
      if (card?.unencodable) logLines.push(`  Note: ${card.name}'s effect is not simulated by the engine — resolve it manually if it matters.`)
      next = closeMarketIfExhausted(next, logLines)
      return { state: next, logLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      logLines.push(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines }
    }
  }

  if (action.kind === 'endMarket') {
    if (state.pendingPostMarketChoice) {
      logLines.push(`Can't do that: resolve the pending Alligator choice first.`)
      return { state, logLines }
    }
    let next = endMarketPhase(state, logLines)
    if (next.pendingPostMarketChoice) return { state: next, logLines } // paused — waiting on Alligator's stack-target choice
    logLines.push('Ended the Market phase.')
    if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines)
    return { state: next, logLines }
  }

  if (action.kind === 'resolvePostMarketChoice') {
    if (!state.pendingPostMarketChoice) {
      logLines.push(`Can't do that: there's no pending choice to resolve.`)
      return { state, logLines }
    }
    try {
      let next = resolvePostMarketChoice(state, { pos: action.pos, index: action.index }, logLines)
      if (next.pendingPostMarketChoice) return { state: next, logLines } // another Alligator needs a choice too
      logLines.push('Ended the Market phase.')
      if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines)
      return { state: next, logLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      logLines.push(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines }
    }
  }

  if (action.kind === 'advanceCleanup') {
    const roundJustEnded = state.round
    const fameThisRound = state.fameGeneratedThisRound
    const threshold = state.fameToTriggerEndgame
    const next = runCleanup(state)
    if (next.phase === 'ended') {
      logLines.push(
        next.result === 'win'
          ? `YOU WIN — reached ${fameThisRound}/${threshold} fame in round ${roundJustEnded}.`
          : `YOU LOSE — the toon deck depleted and the market could not refill (round ${roundJustEnded}).`,
      )
    } else {
      logLines.push(`Round ${roundJustEnded} complete. Fame resets to 0. Advancing to round ${next.round}.`)
    }
    return { state: next, logLines }
  }

  throw new Error(`actions.ts: unhandled action kind`)
}
