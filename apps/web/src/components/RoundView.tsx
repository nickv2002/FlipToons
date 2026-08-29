import { useEffect, useRef, useState } from 'react'
import type { GameState } from '../../../../packages/engine/state'
import { cardsById } from '../../../../packages/engine/setup'
import { getSlot } from '../../../../packages/engine/grid'
import type { GridPos } from '../../../../packages/engine/types'
import type { Action } from '../../../../packages/engine/actions'
import { listDismissEntries, wouldHireEndInGuaranteedLoss } from '../../../../packages/engine/actions'
import type { CardId, EffectChoices } from '../../../../packages/engine/cards/types'
import { computePendingChoice, buildEffectChoices } from '../../../../packages/engine/hireChoices'
import type { PendingChoice } from '../../../../packages/engine/hireChoices'
import { roundFameLookup } from '../../../../packages/engine/score'
import { BoardPane } from './BoardPane'
import { ConfettiBurst } from './ConfettiBurst'
import { Market } from './Market'
import { BigButtonPrompt } from './BigButtonPrompt'
import { ChoicePrompt } from './ChoicePrompt'
import { EffectChoicePrompt, type EffectChoiceSelection } from './EffectChoicePrompt'
import { CardListOverlay } from './CardListOverlay'
import { CardZoomSheet, type ZoomRequest } from './CardZoomSheet'
import { TouchModeToggle } from './TouchModeToggle'
import { loadSettings, saveSettings } from '../settings'

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
  // See BoardPane's isOwn/isActive. Default true/true: solo is always both —
  // there's no "someone else's turn" to dim against. MatchView threads real
  // values through here for the seated player's own board.
  isOwn?: boolean
  isActive?: boolean
  // Raccoon at a table: MatchView threads the other seats' dismissed piles
  // through here so computePendingChoice (hireChoices.ts) can offer "any
  // dismissed card" rather than just this player's own. Solo omits both —
  // there is only ever one pile, so there is nothing to group by owner.
  otherDismissedPiles?: { playerId: string; cards: CardId[] }[]
  nameOf?: (playerId: string) => string
  myPlayerId?: string
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
  isOwn = true,
  isActive = true,
  otherDismissedPiles,
  nameOf,
  myPlayerId,
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
  const [touchMode, setTouchMode] = useState(() => loadSettings().touchMode)
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null)

  // The deal-in animation should play once per round's Flip, not every time
  // the grid re-renders — resolving a Butterfly/Panther dismiss-choice prompt
  // unmounts and remounts this whole subtree (see the `pending` branch
  // below), which would otherwise replay it. `state.round` only changes once
  // per Flip, so it's the signal for "this is actually a fresh deal."
  const animatedRoundRef = useRef<number | null>(null)
  const isFreshDeal = animatedRoundRef.current !== state.round
  useEffect(() => {
    animatedRoundRef.current = state.round
  }, [state.round])

  // Per-card "fame generated this round" badges. state.lastCheckFame is
  // already the frozen Check-Fame-time snapshot fameGeneratedThisRound is
  // computed from — reusing it means a dismissed card's badge just
  // disappears along with the card (lastCheckFame doesn't track later
  // dismissals), which is exactly the desired behavior, not a bug to guard.
  const roundFame = state.lastCheckFame ? roundFameLookup(state.lastCheckFame, state.finalGrid ?? state.grid) : undefined

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
    const choice = card ? computePendingChoice(state, card.onHire, cards, slotIndex, otherDismissedPiles) : null
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
        {state.result === 'win' && <ConfettiBurst />}
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
          <BoardPane title="Final grid" grid={state.finalGrid ?? state.grid} cards={cards} deckCount={state.finalDeckCount ?? state.deck.length} roundFame={roundFame} readOnly />
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
            <span className="round-view__score-label">Score this round</span>
            <span className="round-view__score-value">{state.fameGeneratedThisRound}</span>
            <span className="round-view__score-of">/ {state.fameToTriggerEndgame} to win</span>
          </span>
        )}
        <button type="button" onClick={() => setListOverlay('deck')}>
          Remaining deck ({state.deck.length})
        </button>
        <TouchModeToggle
          touchMode={touchMode}
          onChange={(next) => {
            setTouchMode(next)
            saveSettings({ touchMode: next })
          }}
        />
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

      {/* The Big Button's RESET: GRID decision. Solo is the one-seat case of
          the rulebook's clockwise walk, so the decision is always yours. */}
      {state.phase === 'gridReset' && (
        <fieldset className="round-view__controls" disabled={controlsDisabled}>
          <BigButtonPrompt isMyDecision onDecide={(use) => dispatch({ kind: 'bigButtonDecision', use })} />
        </fieldset>
      )}

      {state.phase === 'market' && alligatorChoice && (
        <fieldset className="round-view__controls" disabled={controlsDisabled}>
          <EffectChoicePrompt
            cardName={cards[alligatorChoice.ownerCardId].name}
            choice={{ kind: 'dismissAlligatorTarget', mandatory: true, cost: 0, options: alligatorChoice.options }}
            cards={cards}
            fame={state.fame}
            market={state.market.slots}
            onResolve={resolveAlligatorChoice}
          />
        </fieldset>
      )}
      {state.phase === 'market' && !alligatorChoice && !pending && hireWarning && (
        <fieldset className="round-view__controls" disabled={controlsDisabled}>
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
        </fieldset>
      )}
      {state.phase === 'market' && !alligatorChoice && pending && (
        <fieldset className="round-view__controls" disabled={controlsDisabled}>
          <EffectChoicePrompt
            cardName={pending.cardName}
            choice={pending.choice}
            cards={cards}
            fame={state.fame}
            market={state.market.slots}
            onResolve={resolvePending}
            nameOf={nameOf}
            myPlayerId={myPlayerId}
          />
        </fieldset>
      )}
      {state.phase === 'market' && !alligatorChoice && !pending && (
        <div className="round-view__phase round-view__phase--market">
          {/* The dismiss-pile button lives in BoardPane's own heading (see
              its controlsDisabled prop), which sits OUTSIDE this fieldset on
              purpose — viewing a public pile is not a turn action, so it
              stays clickable even while this player's controls are
              disabled, same as the Leave button above. Only the Grid itself
              (inside BoardPane) is gated by controlsDisabled. */}
          <BoardPane
            title="Your grid"
            grid={state.grid}
            cards={cards}
            deckCount={state.deck.length}
            dismissEntries={listDismissEntries(state)}
            onDismiss={(pos: GridPos, index: number) => handleDismiss(pos, index)}
            fame={state.fame}
            dismissedCount={state.dismissed.length}
            onShowDismissed={() => setListOverlay('dismissed')}
            animateDeal={isFreshDeal}
            isOwn={isOwn}
            isActive={isActive}
            roundFame={roundFame}
            touchMode={touchMode}
            onZoom={setZoomRequest}
            controlsDisabled={controlsDisabled}
          />
          <fieldset className="round-view__market-pane" disabled={controlsDisabled} data-testid="my-controls">
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
              animateDeal={isFreshDeal}
              onHire={(slotIndex) => handleHire(slotIndex)}
              touchMode={touchMode}
              onZoom={setZoomRequest}
            />
            <ChoicePrompt
              state={state}
              onEndMarket={() => dispatch({ kind: 'endMarket' })}
              onUseBigButton={() => dispatch({ kind: 'useBigButton' })}
              endLabel={endMarketLabel}
            />
          </fieldset>
        </div>
      )}
      {listOverlay === 'dismissed' && (
        <CardListOverlay title="Dismissed cards" cardIds={state.dismissed} cards={cards} onClose={() => setListOverlay(null)} />
      )}
      {listOverlay === 'deck' && (
        <CardListOverlay title="Remaining deck" cardIds={state.deck} cards={cards} onClose={() => setListOverlay(null)} />
      )}
      {zoomRequest && <CardZoomSheet {...zoomRequest} onClose={() => setZoomRequest(null)} />}
    </div>
  )
}
