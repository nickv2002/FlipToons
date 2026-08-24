import type { GameState } from '../../../../packages/engine/state'

// Market-phase action controls only (Market actions remaining / End Market).
// Effect-specific player choices (Panther/Butterfly/Raccoon/Crow/Horse) are
// handled separately, by EffectChoicePrompt.tsx — RoundView.tsx swaps this
// out for that when a hire/dismiss needs one. Threading EffectChoices through
// hire()/dismiss() is what makes mandatory choice effects (Panther) resolvable
// at all: without them the engine throws, and optional ones silently decline.
export type ChoicePromptProps = {
  state: GameState
  onEndMarket: () => void
  // Solo ends the whole Market PHASE; a multiplayer seat only ends its own
  // TURN — the phase closes when the turn order wraps.
  endLabel?: string
}

export function ChoicePrompt({ state, onEndMarket, endLabel = 'End Market phase' }: ChoicePromptProps) {
  return (
    <div className="choice-prompt">
      <div className="choice-prompt__summary">
        Market actions remaining: <strong>{state.actionsRemaining}</strong> — spendable fame:{' '}
        <strong className="choice-prompt__currency">{state.fame}</strong> (resets to 0 after this phase — spend it or
        lose it)
      </div>
      <button type="button" className="choice-prompt__end" data-testid="end-turn" onClick={onEndMarket}>
        {endLabel}
      </button>
    </div>
  )
}
