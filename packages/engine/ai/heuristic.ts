// A cheap, non-cheating state evaluator for the Monte Carlo AI's rollout
// policy and reward fallback (core.ts's optional `heuristicScore` hook,
// soloAdapter.ts's `reward()`). "Non-cheating" means every input here is
// either a static Card field or GameState the player already sees on screen
// (grid, market, dismissed pile, remaining deck COUNT) — never shuffled
// future draw order or any other hidden state.
//
// Reuses score.ts's scoreGrid directly rather than re-deriving per-card fame
// logic: scoreGrid already generically evaluates every FameBonus/GridQuery
// kind across all 62+ cards and both seasons, which is exactly what keeps
// this general instead of hardcoding card names. The externalState inputs it
// needs (dogElsewhere, camelMarketCount, henOrRoosterInMarket,
// bigButtonFaceDown) are resolved the same way runCheckFame resolves them —
// phases.ts's dogElsewhereFromMarket/camelMarketCountFromMarket/
// henOrRoosterInMarketFromMarket, reused rather than duplicated — the only
// difference is this is evaluated mid-Market-phase against the LIVE grid,
// not the frozen post-Check-Fame snapshot, which is the whole point: it
// tells a rollout what the grid is worth *right now*, not what it was worth
// last time Check Fame ran.
import { dogElsewhereFromMarket, camelMarketCountFromMarket, henOrRoosterInMarketFromMarket } from '../phases'
import { scoreGrid } from '../score'
import { cardsById } from '../setup'
import type { GameState } from '../state'

const cards = cardsById()

// Live "what would I score if Check Fame ran right now" grid value. Solo has
// no other players, so otherGrids is always empty — same reduction the
// solo-specific resolvers in phases.ts already make.
function liveGridFame(state: GameState): number {
  const breakdown = scoreGrid(state.grid, cards, state.deck.length, {
    dogElsewhere: dogElsewhereFromMarket(state),
    dismissed: state.dismissed,
    camelMarketCount: camelMarketCountFromMarket(state),
    henOrRoosterInMarket: henOrRoosterInMarketFromMarket(state),
    bigButtonFaceDown: !state.bigButtonFaceUp,
  })
  return breakdown.total
}

// A single scalar, roughly in [0, ~1.1], higher is better for the AI. Three
// visible signals, weighted:
//   - liveFame: the live grid's current worth against the win threshold —
//     the dominant signal, since it directly answers "am I on track to win".
//   - spendable fame: `state.fame` is both this round's scoring input NOT
//     yet reflected in the grid (a hire just bought hasn't been flipped) and
//     the player's remaining buying power — a candidate that hoards fame
//     with nothing to show for it on the grid is worse than one that
//     converted it, so this is a smaller secondary weight, not a proxy for
//     the same thing liveFame measures.
//   - a depletion penalty mirroring soloAdapter's existing reward() docking,
//     kept here so both call sites (rollout bias and reward fallback) agree
//     on what "trending toward a loss" looks like.
export function scoreState(state: GameState): number {
  const threshold = state.fameToTriggerEndgame || 1
  const fameSignal = liveGridFame(state) / threshold
  const spendableSignal = state.fame / threshold
  const depletionPenalty = state.toonDeckDepleted ? 0.1 : 0
  return Math.max(0, 0.75 * fameSignal + 0.25 * spendableSignal - depletionPenalty)
}
