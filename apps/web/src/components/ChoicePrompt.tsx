import type { GameState } from '../../../../packages/engine/state'

// Market-phase action controls only (Market actions remaining / End Market).
// Effect-specific player choices (Panther/Butterfly/Raccoon/Crow/Horse) are
// handled separately, by EffectChoicePrompt.tsx — RoundView.tsx swaps this
// out for that when a hire/dismiss needs one. Threading EffectChoices through
// hire()/dismiss() is what makes mandatory choice effects (Panther) resolvable
// at all: without them the engine throws, and optional ones silently decline.
import { canUseMarketReset } from '../../../../packages/engine/bigButton'

export type ChoicePromptProps = {
  state: GameState
  onEndMarket: () => void
  // Big Button, RESET: MARKET. Absent (or a state where the button isn't
  // available) renders nothing at all, so a table not playing the
  // mini-expansion sees exactly what it saw before.
  onUseBigButton?: () => void
  // Solo ends the whole Market PHASE; a multiplayer seat only ends its own
  // TURN — the phase closes when the turn order wraps.
  endLabel?: string
}

export function ChoicePrompt({ state, onEndMarket, onUseBigButton, endLabel = 'End Market phase' }: ChoicePromptProps) {
  // Deliberately asks the ENGINE whether the button is legal rather than
  // re-deriving the three conditions here — the "before any market actions"
  // rule in particular is not the actionsRemaining check it looks like (see
  // state.ts's actedThisMarketPhase).
  const canReset = onUseBigButton !== undefined && canUseMarketReset(state)
  return (
    <div className="choice-prompt">
      <div className="choice-prompt__stats">
        <div className="choice-prompt__stat">
          <span className="choice-prompt__stat-label">Actions remaining</span>
          <span className="choice-prompt__stat-value">{state.actionsRemaining}</span>
        </div>
        <div className="choice-prompt__stat">
          <span className="choice-prompt__stat-label">Spendable fame</span>
          <span className="choice-prompt__stat-value choice-prompt__currency">{state.fame}</span>
        </div>
      </div>
      <p className="choice-prompt__note">Fame resets to 0 after this phase — spend it or lose it.</p>
      {canReset && (
        <button type="button" className="choice-prompt__big-button" data-testid="use-big-button" onClick={onUseBigButton}>
          Use Big Button — reset the market
        </button>
      )}
      <button type="button" className="choice-prompt__end" data-testid="end-turn" onClick={onEndMarket}>
        {endLabel}
      </button>
    </div>
  )
}
