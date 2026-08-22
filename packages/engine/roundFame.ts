// roundFame — the seam that keeps scoreGrid grid-pure while still letting a
// PLAYER-level fame modifier reach the final total.
//
// CLAUDE.md's standing invariant: "Fame is a pure function of the finished
// grid. scoreGrid takes only a grid and returns an itemized breakdown, never a
// running total mutated during play." The Critic's Choice (+3 during the Final
// Flip, §3.2.1) is the one rule that breaks that, and it breaks it at the
// PLAYER level, not the card level: the same six cards laid out identically
// score differently depending on who owns the board.
//
// So it does not go in score.ts. The composition is:
//
//     roundFame = scoreGrid(grid, …)        <- pure, grid-only, unchanged
//                 + playerFameModifiers(…)  <- player-level, lives here
//
// architecture.test.ts asserts score.ts never so much as mentions
// criticsChoiceHolder, and that one grid scores identically for the holder and
// a non-holder. That test is what stops this seam from quietly collapsing back
// into scoreGrid the next time someone needs "just one more" player-level
// bonus.

import type { FameBreakdown } from './score'
import type { PlayerState, SharedState } from './state'

// §3.2.1: "During the final flip, the player holding the critic's choice card
// generates 3 additional fame."
export const CRITICS_CHOICE_FINAL_FLIP_BONUS = 3

export type FameModifier = {
  source: 'criticsChoice'
  label: string
  amount: number
}

export type RoundFame = {
  // The untouched, grid-only breakdown. Kept whole rather than flattened so
  // the UI can render the per-slot itemisation exactly as it does mid-game.
  grid: FameBreakdown
  modifiers: FameModifier[]
  // grid.total + every modifier. THIS is the number that decides the winner.
  total: number
}

// Player-level fame adjustments for one seat, in one scoring pass.
//
// GATED ON `endgameTriggered`, NOT ON `phase === 'finalFlip'`. That looks like
// the wrong field and isn't: match.ts's runMatchFlip hands off to Check Fame by
// setting `phase: 'checkFame'`, so by the moment anyone is actually scored the
// phase no longer reads 'finalFlip' even though the Final Flip is exactly what
// is happening. `endgameTriggered` is latched once in runMatchCleanup and is
// never set during a normal round, so it is true across precisely the span the
// bonus applies to — including every tiebreak re-flip, which §3.2.1 keeps the
// holder's +3 through (the card is held for the duration of the Final Flip; the
// re-flip is part of resolving it, not a new round).
export function playerFameModifiers(
  player: Pick<PlayerState, 'playerId'>,
  shared: Pick<SharedState, 'endgameTriggered' | 'criticsChoiceHolder'>,
): FameModifier[] {
  if (!shared.endgameTriggered) return []
  if (shared.criticsChoiceHolder !== player.playerId) return []
  return [
    {
      source: 'criticsChoice',
      label: "Critic's Choice (Final Flip)",
      amount: CRITICS_CHOICE_FINAL_FLIP_BONUS,
    },
  ]
}

// Composes a stored grid breakdown with this seat's player-level modifiers.
//
// Takes the ALREADY-COMPUTED breakdown (player.lastCheckFame) rather than
// re-running scoreGrid, so it cannot disagree with what Check Fame recorded —
// re-scoring here would need the other seats' grids and the market snapshot to
// resolve Dog/Camel/Fox, and getting that snapshot subtly wrong is exactly how
// a "why is the final screen 2 off from the round screen" bug happens.
export function roundFame(
  player: Pick<PlayerState, 'playerId' | 'lastCheckFame'>,
  shared: Pick<SharedState, 'endgameTriggered' | 'criticsChoiceHolder'>,
): RoundFame {
  const grid: FameBreakdown = player.lastCheckFame ?? { total: 0, lines: [] }
  const modifiers = playerFameModifiers(player, shared)
  const total = modifiers.reduce((sum, m) => sum + m.amount, grid.total)
  return { grid, modifiers, total }
}
