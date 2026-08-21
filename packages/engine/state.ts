// GameState for the single-player (solo variant) round loop, per
// flip-toonz-structure-plan.md §4.2/§4.3, scoped to what a solo game
// actually needs (see task notes below on what's deliberately NOT here).
//
// Season-agnostic (§10) — this module takes cards/decks as plain data and
// never branches on Card.season; setup.ts is the season-aware layer that
// builds a Setup/GameState for a particular season (§4.6).

import type { CardId, PostMarketHook } from './cards/types'
import { emptyGrid } from './grid'
import type { Market } from './market'
import { emptyMarket, refillMarket } from './market'
import type { RngState } from './rng'
import { initRngState } from './rng'
import { cardsById } from './setup'
import type { FameBreakdown } from './score'
import type { Grid, GridPos } from './types'

export type Phase = 'flip' | 'checkFame' | 'postFameHooks' | 'market' | 'cleanup' | 'ended'

export type GameResult = 'win' | 'loss' | null

// A postMarketHook candidate snapshotted at the start of a runPostMarketHooks
// pass (phases.ts) — kept here, not phases.ts, so GameState can reference it
// without a circular import. Plain data, so it round-trips through the web
// client's JSON.stringify save (useGame.ts).
export type PostMarketCandidate = { pos: GridPos; index: number; cardId: CardId; hook: PostMarketHook }

// Set by phases.ts's runPostMarketHooks/resolvePostMarketChoice when
// Alligator's dismissAdjacentRight hook targets a stack with 2+ eligible
// (face-up, non-immune) cards — its own FAQ note says the player picks which
// one. While this is set, endMarketPhase has paused mid-sequence: `phase`
// stays 'market' and the remaining postMarketHook candidates wait in
// `remainingCandidates` until resolvePostMarketChoice is called.
export type PendingPostMarketChoice = {
  ownerCardId: CardId
  ownerPos: GridPos
  targetPos: GridPos
  options: { pos: GridPos; index: number; cardId: CardId }[]
  remainingCandidates: PostMarketCandidate[]
}

export type GameState = {
  phase: Phase
  round: number
  rng: RngState // pure numeric state, not a closure — see rng.ts's stepRng/shuffleWithState comment

  deck: CardId[] // shuffled at each Flip; no discard pile (§3.2/§4.2)
  grid: Grid
  dismissed: CardId[] // out of the game, face-up beside the deck (public — "a player may examine any player's dismissed cards at any time", §3.3a)

  // THIS round's score AND spending power (§4.2: "fame is one field, and
  // it's per-round"). Decremented by hire/dismiss during the Market phase,
  // reset to 0 at Cleanup. NOT the endgame-trigger value — see
  // fameGeneratedThisRound below for why that has to be a separate field.
  fame: number
  // The Check-Fame snapshot (§3.4: "once calculated, this amount does not
  // change until spent during the Market phase"). Set once at Check Fame,
  // never decremented by Market spending, reset to 0 at Cleanup alongside
  // `fame`. This is what Cleanup's fame-threshold trigger reads (§3.2:
  // "any player GENERATED >= fameToTriggerEndgame in the PREVIOUS Check
  // Fame") — using the spendable `fame` field instead would be a real bug:
  // the trigger round explicitly still runs its full Market phase (§3.2
  // point 2), so a player who reaches 30 and then spends down to 17 buying
  // a card must still win, not silently miss the threshold.
  fameGeneratedThisRound: number
  lastCheckFame: FameBreakdown | null

  actionsRemaining: number // Market-phase actions left this round (0 outside Market)

  // Cards Snake's toon-deck stack drew that have their own onHire effects
  // (Peacock, currently the only one) — set during Flip, resolved and
  // cleared during postFameHooks (see flip.ts's FlipResult comment for why
  // it can't just fire immediately during Flip).
  pendingOnHireCardIds: CardId[]

  toonDeck: CardId[] // shared draw pile
  // Set true the moment ANY refill (hire/dismiss/decay/Cleanup's own) comes
  // up SHORT — a market slot needed a card and the toon deck had none left
  // to give it — and never cleared. Deliberately NOT set just because the
  // toon deck's count happens to reach exactly zero: a refill that drains
  // the last card while still filling every slot isn't a failure (house
  // rule — the player should keep playing as long as the market can still
  // be kept full; only an actual failed draw ends the game). Per §3.2.2's
  // instruction to return this as a fact from the market refill rather than
  // re-deriving it later — Cleanup reads this flag, it does not re-check
  // toonDeck.length itself.
  toonDeckDepleted: boolean
  market: Market
  nextInsertionSeq: number // monotonic counter for market.ts's insertion-order tiebreak (§3.6)

  fameToTriggerEndgame: number // §3.7's solo win condition: 30, but tunable (§3.0)
  result: GameResult // null until phase === 'ended'

  // Non-null only while endMarketPhase is paused mid-sequence waiting on
  // Alligator's stack-target choice — see PendingPostMarketChoice's comment.
  pendingPostMarketChoice: PendingPostMarketChoice | null

  // --- Deliberately NOT here — see the task report for the full reasoning ---
  //
  // criticsChoiceHolder (§3.2.1, §4.2): SKIPPED for solo, not merely
  // unimplemented. Its only mechanical effect is +3 fame during the FINAL
  // FLIP. Solo's own win condition (§3.7 — "generate 30 fame before the
  // toon deck depletes") resolves at a normal Cleanup, off a normal Check
  // Fame snapshot; solo has no Final Flip at all, because the Final Flip's
  // entire purpose in the rules is a CROSS-PLAYER "most fame wins"
  // comparison (§3.2's FinalFlip block) that a one-player game has no use
  // for. No Final Flip -> the +3 bonus never has a phase to apply in ->
  // the token can never affect a solo game's outcome. The award condition
  // itself is also degenerate at one player ("the player with the most
  // fame" is trivially the only player), and the tie-for-most removal
  // branch is unreachable (a tie requires >= 2 players). Building
  // criticsChoiceHolder here would be machinery with no path to ever
  // matter, which the task explicitly says to skip rather than build.
  //
  // action log (§4.7): not built this pass — not in the task's "What to
  // build" list (1-4), and every phase function below is already a pure
  // GameState -> GameState transform, which is what an action-log replayer
  // would call regardless; adding the log itself is a thin wrapper for a
  // later pass, not a design decision this pass needs to make.
}

export function createSoloGameState(params: {
  seed: number
  startingDeck: CardId[]
  toonDeck: CardId[] // already trimmed for difficulty (setup.ts's buildSoloToonDeck)
  prices: number[]
  fameToTriggerEndgame: number
}): GameState {
  const cards = cardsById()
  // §3.1: the market starts already filled — "reveal the top five cards of
  // the shared toon deck and place one under each price card, sorted by
  // rank" — so setup does one refillMarket() against an EMPTY market before
  // round 1's Flip, not an empty market that only fills after a Market
  // phase runs.
  const initialRefill = refillMarket(emptyMarket(params.prices), params.toonDeck, cards, 0)

  return {
    phase: 'flip',
    round: 1,
    rng: initRngState(params.seed),
    deck: params.startingDeck.slice(),
    grid: emptyGrid(),
    dismissed: [],
    fame: 0,
    fameGeneratedThisRound: 0,
    lastCheckFame: null,
    actionsRemaining: 0,
    pendingOnHireCardIds: [],
    toonDeck: initialRefill.toonDeck,
    toonDeckDepleted: initialRefill.short,
    market: initialRefill.market,
    nextInsertionSeq: initialRefill.nextInsertionSeq,
    fameToTriggerEndgame: params.fameToTriggerEndgame,
    result: null,
    pendingPostMarketChoice: null,
  }
}
