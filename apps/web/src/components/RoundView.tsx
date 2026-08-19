import type { GameState } from '../../../../packages/engine/state'
import { cardsById } from '../../../../packages/engine/setup'
import type { GridPos } from '../../../../packages/engine/types'
import type { Action } from '../../../../packages/engine/actions'
import { listDismissEntries } from '../../../../packages/engine/actions'
import { Grid } from './Grid'
import { Market } from './Market'
import { ChoicePrompt } from './ChoicePrompt'

const cards = cardsById()

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
        <span>Fame this round: {state.fameGeneratedThisRound}</span>
        <span>Win at: {state.fameToTriggerEndgame} fame</span>
        <button type="button" className="round-view__abandon" onClick={onAbandon}>
          Abandon game
        </button>
      </div>

      {state.phase === 'market' && (
        <div className="round-view__phase round-view__phase--market">
          <div className="round-view__grid-pane">
            <h2>Your grid</h2>
            <Grid
              grid={state.grid}
              cards={cards}
              dismissEntries={listDismissEntries(state)}
              onDismiss={(pos: GridPos, index: number) => dispatch({ kind: 'dismiss', pos, index })}
            />
          </div>
          <div className="round-view__market-pane">
            <h2>Market</h2>
            <Market
              market={state.market}
              cards={cards}
              fame={state.fame}
              state={state}
              onHire={(slotIndex) => dispatch({ kind: 'hire', slotIndex })}
            />
            <ChoicePrompt state={state} onEndMarket={() => dispatch({ kind: 'endMarket' })} />
          </div>
        </div>
      )}
    </div>
  )
}
