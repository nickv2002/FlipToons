import type { GameState } from '../../../../packages/engine/state'

// Market-phase action BUTTONS only — the Big Button's two reset effects and
// the end-of-turn control. The fame/actions counters it used to carry moved
// into the market pane's heading (see RoundView), next to what they buy.
// Effect-specific player choices (Panther/Butterfly/Raccoon/Crow/Horse) are
// handled separately, by EffectChoicePrompt.tsx — RoundView.tsx swaps this
// out for that when a hire/dismiss needs one. Threading EffectChoices through
// hire()/dismiss() is what makes mandatory choice effects (Panther) resolvable
// at all: without them the engine throws, and optional ones silently decline.
import { canUseMarketReset, canUseGridResetNow } from '../../../../packages/engine/bigButton'

export type ChoicePromptProps = {
  state: GameState
  onEndMarket: () => void
  // Big Button, either reset effect. A single handler covers both — the
  // engine dispatches on state.resetEffect itself (matchActions.ts /
  // actions.ts), so the UI never needs to know which one it's pressing.
  // Absent (or a state where neither button is available) renders nothing at
  // all, so a table not playing the mini-expansion sees exactly what it saw
  // before.
  onUseBigButton?: () => void
  // Solo ends the whole Market PHASE; a multiplayer seat only ends its own
  // TURN — the phase closes when the turn order wraps.
  endLabel?: string
}

export function ChoicePrompt({ state, onEndMarket, onUseBigButton, endLabel = 'End Market phase' }: ChoicePromptProps) {
  // Deliberately asks the ENGINE whether each button is legal rather than
  // re-deriving the conditions here. RESET: MARKET's "before any market
  // actions" rule is gone by design (it's now free-floating); RESET: GRID's
  // start-of-turn gate is not the actionsRemaining check it looks like (see
  // state.ts's actedThisMarketPhase) — canUseGridResetNow is the one that
  // knows that.
  const canMarketReset = onUseBigButton !== undefined && canUseMarketReset(state)
  const canGridReset = onUseBigButton !== undefined && canUseGridResetNow(state)
  return (
    <div className="choice-prompt">
      {/* Spendable fame and actions remaining used to live here, BELOW the
          market they are spent on. They moved into the market pane's own
          heading, directly above the cards whose prices they have to cover. */}
      {canGridReset && (
        <button type="button" className="choice-prompt__big-button" data-testid="use-big-button-grid" onClick={onUseBigButton}>
          Use Big Button — reset your grid
        </button>
      )}
      {canMarketReset && (
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
