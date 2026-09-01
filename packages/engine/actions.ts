// The pure action layer between a transport (React state, a WebSocket
// connection, a test) and the engine — the reducer shape
// (state, action) -> { state, logLines } is transport-free and UI-free on
// purpose, so apps/web's useGame.ts and apps/worker's room loop both import
// this SAME module instead of each re-deriving the action vocabulary (see
// flip-toonz-structure-plan.md §6's client/server split, and §8's original
// key-files list, which named this file here from the start).
import type { EffectChoices, Season } from './cards/types'
import { getSlot, posLabel } from './grid'
import { hireCost } from './market'
import {
  dismiss,
  dismissCostFor,
  endMarketPhase,
  hasAnyLegalMarketAction,
  hire,
  listDismissEntries,
  rescoreAfterGridReset,
  resolvePendingOnHireChoice,
  resolvePostMarketChoice,
  runCheckFame,
  runCleanup,
  runFlip,
  runPostFameHooks,
  unencodableNote,
} from './phases'
import type { DismissTarget, HireFromDismissedTarget } from './hireChoices'
import type { DismissEntry } from './phases'
export { hasAnyLegalMarketAction, listDismissEntries }
export type { DismissEntry }
import { applyGridResetCollect, applyMarketReset, canUseGridReset, canUseGridResetNow, canUseMarketReset, marketResetReturnedCards } from './bigButton'
import { cardsById } from './setup'
import { createSoloGameState } from './state'
import type { EngineLogLine, GameState, ResetEffect } from './state'
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
  // Answers GameState.pendingOnHireChoice — a Snake-stacked card's own
  // choice-needing onHire (Panther's mandatory dismissChosenGridCard,
  // Raccoon's optional hireFromDismissed). `selection` mirrors
  // hireChoices.ts's PendingChoice option shapes; 'skip' only for a
  // non-mandatory choice.
  | { kind: 'resolvePendingOnHireChoice'; selection: DismissTarget | HireFromDismissedTarget | number | number[] | 'skip' }
  | { kind: 'advanceCleanup' }
  // Big Button. A Market-phase action costing no fame and no action, that
  // dispatches on GameState.resetEffect since only one reset is ever in
  // play: RESET: MARKET is usable before, during or after any Market action;
  // RESET: GRID is legal only at the start of the round, before the first
  // hire/dismiss (there is no turn walk to answer — solo has one seat, so
  // the rulebook's clockwise walk collapses to this single action).
  | { kind: 'useBigButton' }

export type ApplyResult = { state: GameState; logLines: EngineLogLine[]; debugLines: string[] }

const cards = cardsById()

export function buildNewGameState(seed: number, difficulty: SoloDifficulty, season: Season, bigButton: ResetEffect | null = null): GameState {
  const setup = buildSoloSetup(seed, season, difficulty, { bigButton })
  return createSoloGameState({
    seed: setup.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
    resetEffect: setup.resetEffect,
  })
}

// Message-cleanup applied before showing a rejected action to the player
// (strips the internal "phases.ts: fn — " prefix); a real phase-machine bug
// (assertPhase's message shape) is rethrown instead of being turned into a
// friendly log line.
function isEngineBug(err: unknown): boolean {
  return err instanceof Error && /^phases\.ts: \w+ called in phase/.test(err.message)
}

function playerFacingMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^phases\.ts: \w+ — /, '')
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
export function advanceThroughPassthroughPhases(state: GameState, logLines: EngineLogLine[], debugLines: string[] = []): GameState {
  let next = state
  const say = (text: string) => logLines.push({ playerId: state.playerId, text })

  if (next.phase === 'cleanup') {
    const roundJustEnded = next.round
    const fameThisRound = next.fameGeneratedThisRound
    const threshold = next.fameToTriggerEndgame
    next = runCleanup(next)
    if (next.phase === 'ended') {
      say(
        next.result === 'win'
          ? `YOU WIN — reached ${fameThisRound}/${threshold} fame in round ${roundJustEnded}.`
          : `YOU LOSE — the toon deck depleted and the market could not refill (round ${roundJustEnded}).`,
      )
      return next
    }
    say(`Round ${roundJustEnded} complete. Fame resets to 0. Advancing to round ${next.round}.`)
  }

  if (next.phase === 'flip') {
    // Season 1 has no Return-to-deck effect, so the pre-flip shuffle order
    // IS the actual reveal order — a pure re-derivation of runFlip's own
    // internal shuffle (same deck, same rng state), not a second live
    // shuffle.
    const preview = shuffleWithState(next.deck, next.rng).result
    say(`Round ${next.round}: flip order — ${preview.map((id) => cards[id]?.name ?? id).join(', ') || '(empty deck)'}`)
    next = runFlip(next, logLines, debugLines)
    say(`${next.deck.length} card(s) left in your deck.`)
  }

  if (next.phase === 'checkFame') {
    next = runCheckFame(next)
    if (next.lastCheckFame) say(formatBreakdown(next.lastCheckFame))
  }

  // Solo can no longer land on 'gridReset' here: runCheckFame (phases.ts) is
  // unconditionally 'postFameHooks' now, since RESET: GRID moved onto the
  // player's own Market turn (bigButton.ts's canUseGridResetNow, the
  // 'useBigButton' handler below) rather than interrupting this cascade
  // before the Market phase even opens. 'gridReset' survives only for
  // multiplayer's Final Flip (match.ts), which solo never reaches (§3.7).

  if (next.phase === 'postFameHooks') {
    // The Skunk/Firefly hooks themselves are provably a pass-through in solo
    // (see phases.ts's runPostFameHooks header comment) — but a Snake-
    // stacked card's own onHire (Panther, Raccoon — see state.ts's
    // pendingOnHireChoice comment) is NOT: it's reachable in solo whenever a
    // season-'both' toon deck draws both Snake (S1) and a choice-needing
    // onHire card (both S2) together.
    next = runPostFameHooks(next)
    if (next.pendingOnHireChoice) {
      // Paused mid-postFameHooks waiting on that choice — do not cascade
      // into resolveEndOfRoundOutcome below, which assumes 'market' or
      // 'ended'. resolvePendingOnHireChoice (below) resumes this same
      // cascade once answered.
      return next
    }
  }

  return resolveEndOfRoundOutcome(next, logLines)
}

// Win check runs before the guaranteed-loss short circuit, not after.
// runPostFameHooks can push spendable `fame` over the threshold (Skunk/
// Firefly's least-fame bonus) without moving fameGeneratedThisRound, the
// frozen Check-Fame snapshot isGuaranteedLoss reads below — so a round that
// actually just won can still look "guaranteed lost" by that snapshot. If
// skipGuaranteedLossMarketPhase ran first and latched phase 'ended'/'loss',
// applyAction's own checkInstantWin call (which only fires pre-'ended')
// would never get a chance to override it. Checking win here first closes
// that gap.
function resolveEndOfRoundOutcome(state: GameState, logLines: EngineLogLine[]): GameState {
  const won = checkInstantWin(state)
  if (won !== state) {
    logLines.push({ playerId: state.playerId, text: `YOU WIN — reached ${won.fame}/${won.fameToTriggerEndgame} fame.` })
    return won
  }
  return skipGuaranteedLossMarketPhase(state, logLines)
}

// Guaranteed-loss short-circuit. soloMarketDecay (market.ts) unconditionally
// empties 2 market slots every round and needs 2 fresh toon-deck cards to
// refill them; toonDeck only ever shrinks (refills draw from it, nothing ever
// returns cards to it). So if this round hasn't already been won and
// toonDeckDepleted is already latched — the toon deck actually ran dry mid-
// refill, so the market genuinely cannot be filled at the start of a future
// turn — this round's loss is locked in before any Market action — no
// hire/dismiss choice can change it. Skip straight through Market's
// end-of-phase hooks/refill/decay and Cleanup instead of offering actions
// that can't matter (reported: a player hired a card as their "last action"
// immediately before a toon-deck-depleted loss, with no way to have avoided
// it). Called both from the 'flip' cascade above and from the
// 'continueToMarket' action below (ai.ts's autoplay dispatches that action
// directly, bypassing the cascade).
//
// A thin-but-not-depleted deck (fewer than the 2 fresh cards decay wants) is
// NOT on its own a guaranteed loss when the player still holds an unspent
// RESET: GRID button (canUseGridReset) — a future grid reset re-flips the
// board and can still reach the fame threshold regardless of how few toon-
// deck cards are left, so the round only locks in once that recovery path is
// gone too (reset spent/unavailable) or the deck is actually depleted, which
// no reset can undo either. Shared predicate: is `state` a round that's
// already lost no matter what Market actions (including a future grid
// reset) happen from here?
function isGuaranteedLoss(state: GameState): boolean {
  if (state.fameGeneratedThisRound >= state.fameToTriggerEndgame) return false
  if (state.toonDeckDepleted) return true
  return state.toonDeck.length < 2 && !canUseGridReset(state)
}

function skipGuaranteedLossMarketPhase(next: GameState, logLines: EngineLogLine[]): GameState {
  if (next.phase !== 'market' || next.pendingPostMarketChoice || !isGuaranteedLoss(next)) {
    return next
  }

  const playerId = next.playerId
  const roundJustEnded = next.round
  const fameThisRound = next.fameGeneratedThisRound
  const threshold = next.fameToTriggerEndgame
  let result = endMarketPhase(next, logLines)
  if (result.pendingPostMarketChoice) return result
  if (result.phase === 'cleanup') result = runCleanup(result)
  if (result.phase === 'ended' && result.result === 'loss') {
    logLines.push({
      playerId,
      text: `YOU LOSE — round ${roundJustEnded} generated ${fameThisRound}/${threshold} fame, short of the threshold, and the toon deck doesn't have enough cards left to refill the market — no action this round could have closed the gap.`,
    })
  }
  return result
}

// Web UI helper (RoundView.tsx): would hiring this card, with these choices,
// leave the round guaranteed-lost per isGuaranteedLoss above — either
// directly (a card whose onHire triggers its own immediate refill, like
// Horse/Crow, can exhaust the toon deck right then) or by leaving fewer than
// 2 toon-deck cards for the end-of-round decay to draw from? A plain hire
// never touches the toon deck itself, so this is normally only "true" once
// the deck was already this thin going in — but it's cheaper for the UI to
// ask this than to duplicate isGuaranteedLoss's fields. Lets the player
// confirm or cancel before an action they can't undo, instead of the round
// just ending on them (reported: a player hired a card as their "last
// action" immediately before a toon-deck-depleted loss, with no warning).
export function wouldHireEndInGuaranteedLoss(state: GameState, slotIndex: number, choices?: EffectChoices): boolean {
  let after: GameState
  try {
    after = hire(state, slotIndex, choices)
  } catch {
    return false // let the real hire() call surface the actual error
  }
  return isGuaranteedLoss(after)
}

// actionsRemaining hit 0 without an explicit `end` — auto-close the Market
// phase rather than offering an action that would only throw. Run after
// every successful hire/dismiss.
function closeMarketIfExhausted(state: GameState, logLines: EngineLogLine[], debugLines: string[]): GameState {
  // hasAnyLegalMarketAction is now the SOLE auto-end authority (it already
  // subsumes actionsRemaining <= 0 — see its own comment in phases.ts), so a
  // seat holding an unspent Big Button is kept open even at 0 actions. The
  // pendingPostMarketChoice guard matters on its own: the predicate reads
  // false mid-Alligator regardless of actions remaining, which would
  // otherwise close the phase out from under an unresolved stack-target pick
  // — useGame.ts:104 already carries the same guard for the same reason.
  if (state.phase === 'market' && !state.pendingPostMarketChoice && !hasAnyLegalMarketAction(state)) {
    logLines.push({ playerId: state.playerId, text: 'No Market actions remaining — ending the Market phase.' })
    let next = endMarketPhase(state, logLines)
    if (next.pendingPostMarketChoice) return next // paused — waiting on Alligator's stack-target choice
    if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines, debugLines)
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
  return {
    state: won,
    logLines: [...result.logLines, { playerId: won.playerId, text: `YOU WIN — reached ${won.fame}/${won.fameToTriggerEndgame} fame.` }],
    debugLines: result.debugLines,
  }
}

function applyActionRaw(state: GameState, action: Action): ApplyResult {
  const logLines: EngineLogLine[] = []
  const debugLines: string[] = []
  const say = (text: string) => logLines.push({ playerId: state.playerId, text })

  if (action.kind === 'flip') {
    // Cascades all the way through checkFame and postFameHooks (both
    // no-decision pass-throughs) so the caller always lands on 'market' —
    // see advanceThroughPassthroughPhases above.
    const next = advanceThroughPassthroughPhases(state, logLines, debugLines)
    return { state: next, logLines, debugLines }
  }

  if (action.kind === 'checkFame') {
    const next = runCheckFame(state)
    if (next.lastCheckFame) say(formatBreakdown(next.lastCheckFame))
    return { state: next, logLines, debugLines }
  }

  if (action.kind === 'continueToMarket') {
    // Provably a pass-through in solo — see phases.ts's runPostFameHooks
    // header comment (Skunk/Firefly are both starting-deck-only and solo's
    // setup swaps the least-fame starter out).
    const next = resolveEndOfRoundOutcome(runPostFameHooks(state), logLines)
    return { state: next, logLines, debugLines }
  }

  if (action.kind === 'hire') {
    const cardId = state.market.slots[action.slotIndex]
    const price = action.slotIndex >= 0 && action.slotIndex < state.market.prices.length ? hireCost(state.market, action.slotIndex) : undefined
    try {
      let next = hire(state, action.slotIndex, action.choices)
      const card = cards[cardId!]
      say(`Hired ${card.name} for ${price} fame.`)
      if (card.unencodable) say(unencodableNote(card))
      next = closeMarketIfExhausted(next, logLines, debugLines)
      return { state: next, logLines, debugLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      say(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines, debugLines }
    }
  }

  if (action.kind === 'dismiss') {
    const slot = getSlot(state.grid, action.pos)
    const cardId = slot?.cards[action.index]
    try {
      const cost = dismissCostFor(state.grid, action.pos, action.index, cards)
      let next = dismiss(state, action.pos, action.index, action.choices)
      const card = cardId ? cards[cardId] : undefined
      say(`Dismissed ${card?.name ?? cardId} at ${posLabel(action.pos)} for ${cost} fame.`)
      if (card?.unencodable) say(unencodableNote(card))
      next = closeMarketIfExhausted(next, logLines, debugLines)
      return { state: next, logLines, debugLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      say(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines, debugLines }
    }
  }

  if (action.kind === 'endMarket') {
    if (state.pendingPostMarketChoice) {
      say(`Can't do that: resolve the pending Alligator choice first.`)
      return { state, logLines, debugLines }
    }
    let next = endMarketPhase(state, logLines)
    if (next.pendingPostMarketChoice) return { state: next, logLines, debugLines } // paused — waiting on Alligator's stack-target choice
    say('Ended the Market phase.')
    if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines, debugLines)
    return { state: next, logLines, debugLines }
  }

  if (action.kind === 'resolvePostMarketChoice') {
    if (!state.pendingPostMarketChoice) {
      say(`Can't do that: there's no pending choice to resolve.`)
      return { state, logLines, debugLines }
    }
    try {
      let next = resolvePostMarketChoice(state, { pos: action.pos, index: action.index }, logLines)
      if (next.pendingPostMarketChoice) return { state: next, logLines, debugLines } // another Alligator needs a choice too
      say('Ended the Market phase.')
      if (next.phase === 'cleanup') next = advanceThroughPassthroughPhases(next, logLines, debugLines)
      return { state: next, logLines, debugLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      say(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines, debugLines }
    }
  }

  if (action.kind === 'resolvePendingOnHireChoice') {
    if (!state.pendingOnHireChoice) {
      say(`Can't do that: there's no pending choice to resolve.`)
      return { state, logLines, debugLines }
    }
    try {
      const next = resolvePendingOnHireChoice(state, action.selection)
      if (next.pendingOnHireChoice) return { state: next, logLines, debugLines } // another Snake-stacked card needs a choice too
      // resolvePendingOnHireChoice lands on 'market' once the queue drains —
      // resume the same cascade advanceThroughPassthroughPhases would have
      // continued into (win/guaranteed-loss checks), rather than leaving the
      // caller to re-derive them.
      return { state: resolveEndOfRoundOutcome(next, logLines), logLines, debugLines }
    } catch (err) {
      if (isEngineBug(err)) throw err
      say(`Can't do that: ${playerFacingMessage(err)}`)
      return { state, logLines, debugLines }
    }
  }

  if (action.kind === 'useBigButton') {
    if (state.resetEffect === null) {
      say("Can't do that: the Big Button mini-expansion is not in play.")
      return { state, logLines, debugLines }
    }

    if (state.resetEffect === 'market') {
      // RESET: MARKET. Free (no fame, no action), and usable before, during
      // or after any Market action — a deliberate departure from the printed
      // card's "before taking any market actions" (bigButton.ts's
      // canUseMarketReset).
      if (!canUseMarketReset(state)) {
        say("Can't do that: your Big Button card is already face down.")
        return { state, logLines, debugLines }
      }
      const returned = marketResetReturnedCards(state)
      const next = applyMarketReset(state)
      say(`Used the Big Button: shuffled ${returned.length} market card(s) back into the toon deck and refilled.`)
      // A reset that came up short latches toonDeckDepleted, which is exactly
      // what the guaranteed-loss short circuit reads — so run the same tail
      // every other Market-phase mutation gets rather than returning raw.
      return { state: skipGuaranteedLossMarketPhase(next, logLines), logLines, debugLines }
    }

    // RESET: GRID. "Before taking any market actions" IS still honored here
    // (unlike RESET: MARKET) — canUseGridResetNow is exactly
    // actedThisMarketPhase's remaining job. Solo is the degenerate case of
    // the rulebook's clockwise walk: one seat, so this single action
    // collapses what multiplayer answers as a per-seat turn-gated walk.
    if (!canUseGridResetNow(state)) {
      if (!state.bigButtonFaceUp) say("Can't do that: your Big Button card is already face down.")
      else say("Can't do that: the Big Button must be used before you take any Market actions this round.")
      return { state, logLines, debugLines }
    }
    // "collect the cards in their grid, add them to their deck, shuffle, and
    // complete the Flip phase again." runFlip does the shuffle itself, so
    // applyGridResetCollect deliberately doesn't. rescoreAfterGridReset
    // (phases.ts) is the delta-preserving rescore this in-round reset needs
    // instead of runCheckFame's plain overwrite — see its own comment for
    // why (a Firefly bonus already banked this round must survive). Lands
    // back on 'market' directly: this does not end the turn or consume an
    // action, so the round never leaves the Market phase at all.
    say('Used the Big Button: collecting the grid and flipping again.')
    let next = runFlip({ ...applyGridResetCollect(state), phase: 'flip' }, logLines, debugLines)
    next = { ...rescoreAfterGridReset({ ...next, phase: 'checkFame' }), phase: 'market' }
    if (next.lastCheckFame) say(formatBreakdown(next.lastCheckFame))
    // A re-flip can produce a guaranteed-loss round (the toon deck a Snake
    // drew from during this re-flip may not leave enough for the end-of-
    // round decay), so route through the same short circuit every other
    // Market-phase mutation gets. applyAction's own checkInstantWin wraps
    // every action kind uniformly, so a re-flip that crosses the threshold
    // is caught there without anything special here.
    return { state: skipGuaranteedLossMarketPhase(next, logLines), logLines, debugLines }
  }

  if (action.kind === 'advanceCleanup') {
    const roundJustEnded = state.round
    const fameThisRound = state.fameGeneratedThisRound
    const threshold = state.fameToTriggerEndgame
    const next = runCleanup(state)
    if (next.phase === 'ended') {
      say(
        next.result === 'win'
          ? `YOU WIN — reached ${fameThisRound}/${threshold} fame in round ${roundJustEnded}.`
          : `YOU LOSE — the toon deck depleted and the market could not refill (round ${roundJustEnded}).`,
      )
    } else {
      say(`Round ${roundJustEnded} complete. Fame resets to 0. Advancing to round ${next.round}.`)
    }
    return { state: next, logLines, debugLines }
  }

  throw new Error(`actions.ts: unhandled action kind`)
}
