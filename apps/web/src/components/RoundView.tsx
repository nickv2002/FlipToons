import type { GameState } from '../../../../packages/engine/state'
import { cardsById } from '../../../../packages/engine/setup'
import type { GridPos } from '../../../../packages/engine/types'
import type { Action } from '../../../../packages/engine/actions'
import { listDismissEntries } from '../../../../packages/engine/actions'
import { Grid } from './Grid'
import { Market } from './Market'
import { FameBreakdown } from './FameBreakdown'
import { ChoicePrompt } from './ChoicePrompt'

const cards = cardsById()

export type RoundViewProps = {
  state: GameState
  dispatch: (action: Action) => void
  onAbandon: () => void
}

// Top-level per-phase orchestrator (plan §8's "Key files") — one phase of
// GameState.phase maps to one section here, matching the SAME phase
// sequence tui.ts's runSoloGame loop drives: flip -> checkFame ->
// postFameHooks -> market -> cleanup -> (loop, or ended).
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

      {state.phase === 'flip' && (
        <div className="round-view__phase">
          <h2>Flip</h2>
          <Grid grid={state.grid} cards={cards} />
          <button type="button" className="round-view__primary" onClick={() => dispatch({ kind: 'flip' })}>
            Flip
          </button>
        </div>
      )}

      {state.phase === 'checkFame' && (
        <div className="round-view__phase">
          <h2>Grid revealed</h2>
          <Grid grid={state.grid} cards={cards} />
          <button type="button" className="round-view__primary" onClick={() => dispatch({ kind: 'checkFame' })}>
            Check Fame
          </button>
        </div>
      )}

      {state.phase === 'postFameHooks' && (
        <div className="round-view__phase">
          <h2>Check Fame</h2>
          {state.lastCheckFame && <FameBreakdown breakdown={state.lastCheckFame} />}
          <button type="button" className="round-view__primary" onClick={() => dispatch({ kind: 'continueToMarket' })}>
            Continue to Market
          </button>
        </div>
      )}

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

      {state.phase === 'cleanup' && (
        <div className="round-view__phase">
          <h2>Cleanup</h2>
          <p>Grid collects back into your deck. Fame resets to 0.</p>
          <button type="button" className="round-view__primary" onClick={() => dispatch({ kind: 'advanceCleanup' })}>
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
