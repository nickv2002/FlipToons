import { useState } from 'react'
import type { GameState } from '../../../../packages/engine/state'
import { cardsById } from '../../../../packages/engine/setup'
import type { GridPos } from '../../../../packages/engine/types'
import type { Action } from '../../../../packages/engine/actions'
import { listDismissEntries } from '../../../../packages/engine/actions'
import { computePendingChoice, buildEffectChoices } from '../../../../packages/engine/hireChoices'
import type { PendingChoice } from '../../../../packages/engine/hireChoices'
import { Grid } from './Grid'
import { Market } from './Market'
import { ChoicePrompt } from './ChoicePrompt'
import { EffectChoicePrompt, type EffectChoiceSelection } from './EffectChoicePrompt'

const cards = cardsById()

type Pending = { trigger: 'hire'; slotIndex: number; cardName: string; choice: PendingChoice } | { trigger: 'dismiss'; pos: GridPos; index: number; cardName: string; choice: PendingChoice }

export type RoundViewProps = {
  state: GameState
  dispatch: (action: Action) => void
  onAbandon: () => void
}

// Top-level per-phase orchestrator (plan §8's "Key files"). state.phase only
// ever rests at 'market' or 'ended' here — flip/checkFame/postFameHooks/
// cleanup are no-decision pass-throughs that actions.ts's applyAction now
// cascades through automatically (see advanceThroughPassthroughPhases),
// same sequence tui.ts's runSoloGame loop drives directly against phases.ts,
// just with zero intermediate screens shown in this UI.
export function RoundView({ state, dispatch, onAbandon }: RoundViewProps) {
  // Some cards' onHire/onDismiss effects need a player choice before the
  // action can resolve (Butterfly/Panther/Raccoon/Crow/Horse — see
  // hireChoices.ts). Rather than dispatching immediately, the click handlers
  // below first ask hireChoices.ts whether THIS card, in the CURRENT state,
  // actually needs one (most cards, and even Butterfly/Panther/Raccoon/Crow
  // when no legal target exists, don't) — only then does `pending` block the
  // rest of the Market phase behind a modal instead of firing the action
  // straight through, matching the fast, no-prompt path the UI already had
  // for every choice-free card.
  const [pending, setPending] = useState<Pending | null>(null)

  function handleHire(slotIndex: number) {
    const cardId = state.market.slots[slotIndex]
    const card = cardId ? cards[cardId] : undefined
    const choice = card ? computePendingChoice(state, card.onHire, cards, slotIndex) : null
    if (!choice || !card) {
      dispatch({ kind: 'hire', slotIndex })
      return
    }
    setPending({ trigger: 'hire', slotIndex, cardName: card.name, choice })
  }

  function handleDismiss(pos: GridPos, index: number) {
    const slot = pos.section === 'base' ? state.grid.base[pos.row]?.[pos.col] : state.grid.extraRows[pos.row]?.[pos.col]
    const cardId = slot?.cards[index]
    const card = cardId ? cards[cardId] : undefined
    const choice = card ? computePendingChoice(state, card.onDismiss, cards) : null
    if (!choice || !card) {
      dispatch({ kind: 'dismiss', pos, index })
      return
    }
    setPending({ trigger: 'dismiss', pos, index, cardName: card.name, choice })
  }

  function resolvePending(selection: EffectChoiceSelection) {
    if (!pending) return
    const choices = buildEffectChoices(pending.choice, selection)
    if (pending.trigger === 'hire') {
      dispatch({ kind: 'hire', slotIndex: pending.slotIndex, choices })
    } else {
      dispatch({ kind: 'dismiss', pos: pending.pos, index: pending.index, choices })
    }
    setPending(null)
  }

  // Alligator's stack-target choice — unlike `pending` above, this is
  // sourced from GameState itself (see state.ts's PendingPostMarketChoice
  // comment), since endMarketPhase can pause mid-sequence outside any
  // hire/dismiss action and must survive a page reload.
  const alligatorChoice = state.pendingPostMarketChoice
  function resolveAlligatorChoice(selection: EffectChoiceSelection) {
    if (!alligatorChoice || selection === 'skip') return
    const target = selection as { pos: GridPos; index: number }
    dispatch({ kind: 'resolvePostMarketChoice', pos: target.pos, index: target.index })
  }

  if (state.phase === 'ended') {
    return (
      <div className="round-view round-view--ended">
        <h2>{state.result === 'win' ? 'You win!' : 'You lose.'}</h2>
        <p>
          {state.result === 'win'
            ? `Reached ${state.fameToTriggerEndgame} fame before the toon deck depleted.`
            : 'The toon deck depleted and the market could not refill.'}
        </p>
        <button type="button" onClick={onAbandon}>
          Start a new game
        </button>
      </div>
    )
  }

  return (
    <div className="round-view">
      <div className="round-view__header">
        <span>Round {state.round}</span>
        <span className="round-view__score">
          Score this round: <strong>{state.fameGeneratedThisRound}</strong> / {state.fameToTriggerEndgame} to win
        </span>
        <button type="button" className="round-view__abandon" onClick={onAbandon}>
          Abandon game
        </button>
      </div>
      <div className="round-view__progress" title={`${state.fameGeneratedThisRound} of ${state.fameToTriggerEndgame} fame needed to win`}>
        <div
          className="round-view__progress-bar"
          style={{ width: `${Math.min(100, (state.fameGeneratedThisRound / state.fameToTriggerEndgame) * 100)}%` }}
        />
      </div>

      {state.phase === 'market' && alligatorChoice && (
        <EffectChoicePrompt
          cardName={cards[alligatorChoice.ownerCardId].name}
          choice={{ kind: 'dismissAlligatorTarget', mandatory: true, cost: 0, options: alligatorChoice.options }}
          cards={cards}
          fame={state.fame}
          market={state.market.slots}
          grid={state.grid}
          onResolve={resolveAlligatorChoice}
        />
      )}
      {state.phase === 'market' && !alligatorChoice && pending && (
        <EffectChoicePrompt
          cardName={pending.cardName}
          choice={pending.choice}
          cards={cards}
          fame={state.fame}
          market={state.market.slots}
          grid={state.grid}
          onResolve={resolvePending}
        />
      )}
      {state.phase === 'market' && !alligatorChoice && !pending && (
        <div className="round-view__phase round-view__phase--market">
          <div className="round-view__grid-pane">
            <div className="round-view__grid-heading">
              <h2>Your grid</h2>
              <span className="round-view__deck-count" title="Cards left undrawn in your deck">
                Deck: <strong>{state.deck.length}</strong> left
              </span>
            </div>
            <Grid
              grid={state.grid}
              cards={cards}
              dismissEntries={listDismissEntries(state)}
              onDismiss={(pos: GridPos, index: number) => handleDismiss(pos, index)}
            />
          </div>
          <div className="round-view__market-pane">
            <div className="round-view__grid-heading">
              <h2>Market</h2>
              <span className="round-view__deck-count" title="Cards left in the toon deck the market refills from">
                Deck: <strong>{state.toonDeck.length}</strong> left
              </span>
            </div>
            <Market
              market={state.market}
              cards={cards}
              fame={state.fame}
              state={state}
              onHire={(slotIndex) => handleHire(slotIndex)}
            />
            <ChoicePrompt state={state} onEndMarket={() => dispatch({ kind: 'endMarket' })} />
          </div>
        </div>
      )}
    </div>
  )
}
