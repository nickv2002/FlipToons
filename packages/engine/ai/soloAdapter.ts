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
import { scoreState } from './heuristic'

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

// One candidate per legal option of a paused Snake-stacked onHire choice
// (Panther, Raccoon — see state.ts's pendingOnHireChoice comment), mirroring
// choicesForEffects/selectionsFor's own choice-to-candidate expansion above.
// Optional (mandatory: false) choices additionally get a 'skip' candidate.
function pendingOnHireCandidates(state: GameState): Action[] {
  const pending = state.pendingOnHireChoice
  if (!pending) return []
  const choice = pending.choice
  const selections: (DismissTarget | HireFromDismissedTarget | number | number[])[] =
    choice.kind === 'discardMarketAndRefill' ? choice.options.map((slot) => [slot]) : choice.options
  const built: Action[] = selections.map((selection) => ({ kind: 'resolvePendingOnHireChoice', selection }))
  return choice.mandatory ? built : [...built, { kind: 'resolvePendingOnHireChoice', selection: 'skip' }]
}

export const soloAdapter: AiAdapter<GameState, Action> = {
  legalCandidates(state) {
    if (state.phase === 'ended') return []
    if (state.pendingOnHireChoice) return pendingOnHireCandidates(state)
    if (state.phase !== 'market') return [{ kind: 'flip' }]
    // NOT pre-sorted here on purpose — legalCandidates is called on every
    // single rollout step (core.ts's rolloutStep), not just once per real
    // decision, so a per-call sort (each entry itself an applyAction +
    // scoreState) turned into the dominant cost of every playout regardless
    // of core.ts's own MAX_SCORED_ROLLOUT_CANDIDATES cap. core.ts's
    // evaluateCandidates does the equivalent tie-break sort itself, once per
    // real decision, using this same adapter.heuristicScore hook — see its
    // comment.
    return marketCandidates(state)
  },
  apply(state, action) {
    return applyAction(state, action).state
  },
  isTerminal(state) {
    return state.phase === 'ended'
  },
  // Terminal states score exactly 1 (win) / 0 (loss). A playout that hit
  // core.ts's maxStepsPerPlayout cap without reaching 'ended' is neither —
  // scoring it 0 (the old bug) makes every candidate look equally losing
  // whenever playouts commonly run long (season 2's bigger card pool means
  // more market steps per round — see soloAdapter's benchmark notes), which
  // collapses the ranking to candidate order (endMarket first) instead of
  // the actual search. Give partial credit off this round's FROZEN progress
  // toward the fame threshold (fameGeneratedThisRound, only updated at Check
  // Fame), docked further if the toon deck is already depleted.
  //
  // scoreState (live grid read) was tried here too — both alone and blended
  // 50/50 with this frozen formula — and rejected both times: several fame
  // bonuses read `externalState.dismissed` (Tiger/Cat-shaped cards) or an
  // adjacency condition a neighboring card can turn negative, so ANY live
  // weight in reward() makes repeatedly dismissing the grid down to
  // whichever single card scores best look like a winning strategy to the
  // search. Measured directly: with live-based reward (pure OR blended),
  // seed 102 (easy, season 1) never terminates — it dismisses every grid
  // card, every round, indefinitely (still going after 400 top-level
  // decisions); with the frozen-only formula below it plays out normally in
  // 101. fameGeneratedThisRound is immune to this because it doesn't move
  // until Check Fame actually re-runs, so hollowing out the grid mid-round
  // can't inflate it. scoreState still earns its keep elsewhere — the
  // rollout bias and the candidate pre-sort (both bounded, not the sole
  // driver of a real decision the way reward() is) — see core.ts.
  reward(state) {
    if (state.phase === 'ended') return state.result === 'win' ? 1 : 0
    const progress = Math.min(0.95, state.fameGeneratedThisRound / state.fameToTriggerEndgame)
    return Math.max(0, progress - (state.toonDeckDepleted ? 0.1 : 0))
  },
  clone(state) {
    return structuredClone(state)
  },
  heuristicScore: scoreState,
}

// Convenience constructor mirroring actions.ts's buildNewGameState, so
// callers driving the AI don't need to import both modules.
export { buildNewGameState }
