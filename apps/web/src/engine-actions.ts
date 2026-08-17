// The pure action layer between React and the engine. Deliberately not
// inline in the useGame hook: a step-5 server will want to validate/replay
// the same `Action` union without React in the loop, so the reducer shape
// (state, action) -> { state, logLines } is kept transport-free and
// hook-free on purpose (see flip-toonz-structure-plan.md §6's client/server
// split — this is the seam that lets that land later without a rewrite).
import type { CardId } from '../../../packages/engine/cards/types'
import { occupiedSlots } from '../../../packages/engine/grid'
import { hireCost } from '../../../packages/engine/market'
import {
  dismiss,
  endMarketPhase,
  hire,
  runCheckFame,
  runCleanup,
  runFlip,
  runPostFameHooks,
} from '../../../packages/engine/phases'
import { cardsById } from '../../../packages/engine/setup'
import { createSoloGameState } from '../../../packages/engine/state'
import type { GameState } from '../../../packages/engine/state'
import { buildSoloSetup } from '../../../packages/engine/setup'
import type { SoloDifficulty } from '../../../packages/engine/setup'
import type { GridPos } from '../../../packages/engine/types'
import { formatBreakdown } from '../../../packages/engine/score'
import { shuffleWithState } from '../../../packages/engine/rng'

export type Action =
  | { kind: 'flip' }
  | { kind: 'checkFame' } // flip -> checkFame is already done by runFlip; this runs the actual scoring (plan §5: "this is the single view that teaches the game" — kept as its own step so the breakdown has a moment on screen before Market)
  | { kind: 'continueToMarket' } // postFameHooks (a pass-through in solo — see phases.ts's header comment) -> market
  | { kind: 'hire'; slotIndex: number }
  | { kind: 'dismiss'; pos: GridPos; index: number }
  | { kind: 'endMarket' }
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
export type DismissEntry = { index: number; pos: GridPos; stackIndex: number; cardId: CardId }

export function listDismissEntries(state: GameState): DismissEntry[] {
  const entries: DismissEntry[] = []
  let i = 0
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, stackIndex) => {
      if (!slot.faceUp[stackIndex]) return
      entries.push({ index: i, pos, stackIndex, cardId })
      i++
    })
  }
  return entries
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

// tui.ts's runMarketPhase: "actionsRemaining hit 0 without an explicit
// `end` — auto-close the Market phase rather than offering an action that
// would only throw." Same rule here, run after every successful hire/dismiss.
function closeMarketIfExhausted(state: GameState, logLines: string[]): GameState {
  if (state.phase === 'market' && state.actionsRemaining <= 0) {
    logLines.push('No Market actions remaining — ending the Market phase.')
    return endMarketPhase(state)
  }
  return state
}

export function applyAction(state: GameState, action: Action): ApplyResult {
  const logLines: string[] = []

  if (action.kind === 'flip') {
    // Season 1 has no Return-to-deck effect, so the pre-flip shuffle order
    // IS the actual reveal order — a pure re-derivation of runFlip's own
    // internal shuffle (same deck, same rng state), not a second live
    // shuffle. Matches tui.ts's flip-order preview line.
    const preview = shuffleWithState(state.deck, state.rng).result
    const next = runFlip(state)
    logLines.push(`Round ${state.round}: flip order — ${preview.map((id) => cards[id]?.name ?? id).join(', ') || '(empty deck)'}`)
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
      let next = hire(state, action.slotIndex)
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
      let next = dismiss(state, action.pos, action.index)
      const card = cardId ? cards[cardId] : undefined
      logLines.push(`Dismissed ${card?.name ?? cardId} at ${posLabel(action.pos)}.`)
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
    const next = endMarketPhase(state)
    logLines.push('Ended the Market phase.')
    return { state: next, logLines }
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

  throw new Error(`engine-actions.ts: unhandled action kind`)
}
