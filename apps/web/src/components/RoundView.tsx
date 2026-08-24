import { useState } from 'react'
import type { GameState } from '../../../../packages/engine/state'
import { cardsById } from '../../../../packages/engine/setup'
import { getSlot } from '../../../../packages/engine/grid'
import type { Grid, GridPos } from '../../../../packages/engine/types'
import type { Action } from '../../../../packages/engine/actions'
import { listDismissEntries, wouldHireEndInGuaranteedLoss } from '../../../../packages/engine/actions'
import type { EffectChoices } from '../../../../packages/engine/cards/types'
import { computePendingChoice, buildEffectChoices } from '../../../../packages/engine/hireChoices'
import type { PendingChoice } from '../../../../packages/engine/hireChoices'
import { BoardPane } from './BoardPane'
import { Market } from './Market'
import { ChoicePrompt } from './ChoicePrompt'
import { EffectChoicePrompt, type EffectChoiceSelection } from './EffectChoicePrompt'
import { CardListOverlay } from './CardListOverlay'

const cards = cardsById()

type Pending = { trigger: 'hire'; slotIndex: number; cardName: string; choice: PendingChoice } | { trigger: 'dismiss'; pos: GridPos; index: number; cardName: string; choice: PendingChoice }
type ListOverlay = 'dismissed' | 'deck' | null
// A hire that's about to leave the round guaranteed-lost (actions.ts's
// wouldHireEndInGuaranteedLoss) — held back from dispatch until the player
// confirms, since the toon-deck-depleted loss it triggers can't be undone.
type HireWarning = { slotIndex: number; cardName: string; choices?: EffectChoices }

export type RoundViewProps = {
  state: GameState
  dispatch: (action: Action) => void
  onAbandon: () => void
  // Solo-only UX. The guaranteed-loss warning (actions.ts's
  // wouldHireEndInGuaranteedLoss) is a solo shortcut: a round that's already
  // lost for ONE player is not a lost game at a table, where the others still
  // have real decisions to make. Off in multiplayer.
  soloWarnings?: boolean
  // "Abandon game" reads wrong when three other people are still playing.
  leaveLabel?: string
  // See ChoicePrompt's endLabel.
  endMarketLabel?: string
  // Multiplayer: it is someone else's turn, so nothing on the board may be
  // touched. Applied HERE rather than by the caller wrapping the whole
  // component, because the header's Leave button and the deck/dismissed
  // overlays are not board actions — a native <fieldset disabled> reaches
  // every descendant control, so wrapping the lot took the exit away from
  // exactly the players who most need it (an opponent who dropped mid-turn
  // leaves everyone else waiting with nothing to click).
  controlsDisabled?: boolean
  // Multiplayer draws this round's fame against the endgame threshold once, in
  // the scoreboard above every board — so the header's own copy of the same
  // number and bar would be the second one on the screen. Solo has no
  // scoreboard, so it keeps it.
  showRoundScore?: boolean
  // Solo only (see useGame.ts): the round's grid as it stood right before
  // runCleanup emptied it into the deck. `state.grid` is already empty by
  // the time phase is 'ended', so the end screen falls back to it — always
  // absent in multiplayer, which never renders RoundView at phase 'ended'.
  finalGrid?: Grid | null
  // Paired with finalGrid, captured at the same moment. `state.deck.length`
  // is already the POST-cleanup count (grid folded back in) by the time
  // phase is 'ended' — pairing it with the pre-cleanup finalGrid would
  // count every card still on the board twice.
  finalDeckCount?: number | null
}

// Top-level per-phase orchestrator (plan §8's "Key files"). state.phase only
// ever rests at 'market' or 'ended' here — flip/checkFame/postFameHooks/
// cleanup are no-decision pass-throughs that actions.ts's applyAction now
// cascades through automatically (see advanceThroughPassthroughPhases), so
// none of them is ever a screen the player sees.
export function RoundView({
  state,
  dispatch,
  onAbandon,
  soloWarnings = true,
  leaveLabel = 'Abandon game',
  endMarketLabel,
  controlsDisabled = false,
  showRoundScore = true,
  finalGrid = null,
  finalDeckCount = null,
}: RoundViewProps) {
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
  const [listOverlay, setListOverlay] = useState<ListOverlay>(null)
  const [hireWarning, setHireWarning] = useState<HireWarning | null>(null)

  // Dispatches the hire unless doing so would leave the round guaranteed
  // lost (toon deck too depleted for solo's per-round decay to refill) — in
  // that case, hold it behind a confirm/cancel warning instead, since a
  // player reported hiring as their "last action" right before an
  // unavoidable loss with no way to have seen it coming.
  function dispatchOrWarnHire(slotIndex: number, cardName: string, choices?: EffectChoices) {
    if (soloWarnings && wouldHireEndInGuaranteedLoss(state, slotIndex, choices)) {
      setHireWarning({ slotIndex, cardName, choices })
      return
    }
    dispatch({ kind: 'hire', slotIndex, choices })
  }

  function handleHire(slotIndex: number) {
    const cardId = state.market.slots[slotIndex]
    const card = cardId ? cards[cardId] : undefined
    const choice = card ? computePendingChoice(state, card.onHire, cards, slotIndex) : null
    if (!choice || !card) {
      dispatchOrWarnHire(slotIndex, card?.name ?? String(cardId))
      return
    }
    setPending({ trigger: 'hire', slotIndex, cardName: card.name, choice })
  }

  function handleDismiss(pos: GridPos, index: number) {
    const slot = getSlot(state.grid, pos)
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
      dispatchOrWarnHire(pending.slotIndex, pending.cardName, choices)
    } else {
      dispatch({ kind: 'dismiss', pos: pending.pos, index: pending.index, choices })
    }
    setPending(null)
  }

  function confirmHireWarning() {
    if (!hireWarning) return
    dispatch({ kind: 'hire', slotIndex: hireWarning.slotIndex, choices: hireWarning.choices })
    setHireWarning(null)
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
            : `This round generated ${state.fameGeneratedThisRound}/${state.fameToTriggerEndgame} fame, short of the threshold, and the toon deck doesn't have enough cards left to refill the market — no action could have closed the gap.`}
        </p>
        <div className="round-view__card-list-buttons">
          <button type="button" onClick={() => setListOverlay('dismissed')}>
            Dismissed cards ({state.dismissed.length})
          </button>
          <button type="button" onClick={() => setListOverlay('deck')}>
            Remaining deck ({state.deck.length})
          </button>
        </div>
        <button type="button" onClick={onAbandon}>
          Start a new game
        </button>
        <div className="round-view__phase round-view__phase--market">
          <BoardPane title="Final grid" grid={finalGrid ?? state.grid} cards={cards} deckCount={finalDeckCount ?? state.deck.length} readOnly />
          <div className="round-view__market-pane">
            <div className="round-view__grid-heading">
              <h2>Final market</h2>
              <span className="round-view__deck-count" title="Cards left in the toon deck the market refills from">
                Deck: <strong>{state.toonDeck.length}</strong> left
              </span>
            </div>
            <Market market={state.market} cards={cards} fame={state.fame} />
          </div>
        </div>
        {listOverlay === 'dismissed' && (
          <CardListOverlay title="Dismissed cards" cardIds={state.dismissed} cards={cards} onClose={() => setListOverlay(null)} />
        )}
        {listOverlay === 'deck' && (
          <CardListOverlay title="Remaining deck" cardIds={state.deck} cards={cards} onClose={() => setListOverlay(null)} />
        )}
      </div>
    )
  }

  return (
    <div className="round-view">
      <div className="round-view__header">
        <span>Round {state.round}</span>
        {showRoundScore && (
          <span className="round-view__score">
            Score this round: <strong>{state.fameGeneratedThisRound}</strong> / {state.fameToTriggerEndgame} to win
          </span>
        )}
        <button type="button" onClick={() => setListOverlay('dismissed')}>
          Dismissed cards ({state.dismissed.length})
        </button>
        <button type="button" onClick={() => setListOverlay('deck')}>
          Remaining deck ({state.deck.length})
        </button>
        <button type="button" className="round-view__abandon" onClick={onAbandon}>
          {leaveLabel}
        </button>
      </div>
      {showRoundScore && (
        <div className="round-view__progress" title={`${state.fameGeneratedThisRound} of ${state.fameToTriggerEndgame} fame needed to win`}>
          <div
            className="round-view__progress-bar"
            style={{ width: `${Math.min(100, (state.fameGeneratedThisRound / state.fameToTriggerEndgame) * 100)}%` }}
          />
        </div>
      )}

      <fieldset className="round-view__controls" disabled={controlsDisabled} data-testid="my-controls">
      {state.phase === 'market' && alligatorChoice && (
        <EffectChoicePrompt
          cardName={cards[alligatorChoice.ownerCardId].name}
          choice={{ kind: 'dismissAlligatorTarget', mandatory: true, cost: 0, options: alligatorChoice.options }}
          cards={cards}
          fame={state.fame}
          market={state.market.slots}
          onResolve={resolveAlligatorChoice}
        />
      )}
      {state.phase === 'market' && !alligatorChoice && !pending && hireWarning && (
        <div className="hire-warning">
          <p className="hire-warning__prompt">
            Hiring {hireWarning.cardName} leaves too few cards in the toon deck for the market to refill this round — you'll lose as
            soon as the Market phase ends, and nothing else you do this round can change that.
          </p>
          <div className="hire-warning__actions">
            <button type="button" onClick={() => setHireWarning(null)}>
              Cancel
            </button>
            <button type="button" className="hire-warning__confirm" onClick={confirmHireWarning}>
              Hire anyway
            </button>
          </div>
        </div>
      )}
      {state.phase === 'market' && !alligatorChoice && pending && (
        <EffectChoicePrompt
          cardName={pending.cardName}
          choice={pending.choice}
          cards={cards}
          fame={state.fame}
          market={state.market.slots}
          onResolve={resolvePending}
        />
      )}
      {state.phase === 'market' && !alligatorChoice && !pending && (
        <div className="round-view__phase round-view__phase--market">
          <BoardPane
            title="Your grid"
            grid={state.grid}
            cards={cards}
            deckCount={state.deck.length}
            dismissEntries={listDismissEntries(state)}
            onDismiss={(pos: GridPos, index: number) => handleDismiss(pos, index)}
            fame={state.fame}
          />
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
              onHire={(slotIndex) => handleHire(slotIndex)}
            />
            <ChoicePrompt state={state} onEndMarket={() => dispatch({ kind: 'endMarket' })} endLabel={endMarketLabel} />
          </div>
        </div>
      )}
      </fieldset>
      {listOverlay === 'dismissed' && (
        <CardListOverlay title="Dismissed cards" cardIds={state.dismissed} cards={cards} onClose={() => setListOverlay(null)} />
      )}
      {listOverlay === 'deck' && (
        <CardListOverlay title="Remaining deck" cardIds={state.deck} cards={cards} onClose={() => setListOverlay(null)} />
      )}
    </div>
  )
}
