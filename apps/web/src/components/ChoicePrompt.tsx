import type { GameState } from '../../../../packages/engine/state'

// Market-phase action controls only. tui.ts's runMarketPhase never threads
// EffectChoices (Panther/Butterfly/Raccoon/Crow/Horse-style player choices)
// through hire()/dismiss() — it calls them with no `choices` argument, so
// mandatory choice effects (Panther) throw and get caught as a rejected
// action, and optional ones (Butterfly/Raccoon/Crow/Horse) silently
// decline. This client matches that exactly rather than building choice UI
// tui.ts itself doesn't have — see the task report for the full note.
export type ChoicePromptProps = {
  state: GameState
  onEndMarket: () => void
}

export function ChoicePrompt({ state, onEndMarket }: ChoicePromptProps) {
  return (
    <div className="choice-prompt">
      <div className="choice-prompt__summary">
        Market actions remaining: <strong>{state.actionsRemaining}</strong> — spendable fame:{' '}
        <strong className="choice-prompt__currency">{state.fame}</strong> (resets to 0 after this phase — spend it or
        lose it)
      </div>
      <button type="button" className="choice-prompt__end" onClick={onEndMarket}>
        End Market phase
      </button>
    </div>
  )
}
