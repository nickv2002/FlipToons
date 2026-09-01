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

// 'finalFlip' is the multiplayer endgame's truncated round — Flip + Check
// Fame only, no Market and no Cleanup (§3.2). A 1-player match never enters
// it: solo resolves at a normal Cleanup off a normal Check Fame snapshot,
// because the Final Flip exists to run a CROSS-PLAYER "most fame wins"
// comparison that one player has no use for (§3.7).
export type Phase = 'flip' | 'checkFame' | 'gridReset' | 'postFameHooks' | 'market' | 'cleanup' | 'finalFlip' | 'ended'

// The Big Button mini-expansion (Referance/IMG_4308.HEIC). ONE reset effect
// card is chosen at setup and shared by the whole table; `null` means the
// expansion is not in play at all, which is the default and must stay a
// complete no-op — with it null the new 'gridReset' phase is unreachable and
// the Big Button toon cards stay excluded from every deck exactly as before.
export type ResetEffect = 'market' | 'grid'

// See SharedState.winCondition.
export type WinCondition = 'soloFameTarget' | 'highestFinalFlip'

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

// Set by phases.ts's runPostFameHooks when a postFameHook whose effect needs
// a player choice fires — Skunk's "dismiss a card of your choosing", the only
// one in either season's card table.
//
// This is unreachable in SOLO, which is why it did not exist before
// multiplayer: Skunk is a rank-0, starting-deck-only card, and solo's setup
// swaps it out of the starting deck (setup.ts's buildSeason1SoloStartingDeck
// puts a 3rd Caterpillar in its place). The MULTIPLAYER starting deck keeps
// the Skunk, so this fires in round 1 of essentially every Season 1 match.
export type PendingPostFameChoice = {
  ownerCardId: CardId
  cost: number
  options: { pos: GridPos; index: number; cardId: CardId }[]
}

// Set while a card deferred by Snake's stack (flip.ts's
// pendingOnHireCardIds) needs a player choice before its onHire can resolve
// — Panther's mandatory dismissChosenGridCard is the case that motivated
// this (a Snake-stacked Panther used to throw: both runPostFameHooks and
// resolvePostFameChoice drained pendingOnHireCardIds unconditionally, with
// no choices, AFTER already committing phase: 'market'). Mirrors
// PendingPostFameChoice's shape one level more general — `choice` is
// whatever hireChoices.ts's computePendingChoice returned for this card's
// onHire, so it covers every choice-needing onHire kind (including OPTIONAL
// ones like Raccoon's hireFromDismissed, not just Panther's mandatory one),
// not just Panther specifically. Non-null pauses the postFameHooks phase
// mid-queue: `pendingOnHireCardIds` still holds the cards not yet processed,
// and `cardId` here names the one currently waiting on an answer.
export type PendingOnHireChoice = {
  cardId: CardId
  choice: PendingChoiceLike
}

// A structural copy of hireChoices.ts's PendingChoice. state.ts cannot
// import that type directly: hireChoices.ts imports GameState FROM state.ts
// (for computePendingChoice's signature), so a state.ts -> hireChoices.ts
// type import would be circular. Keep this shape in lockstep with
// PendingChoice by hand — hireChoices.ts's own file header/PendingChoice
// comment is the place a new choice kind gets added, and this union must
// grow to match.
export type PendingChoiceLike =
  | { kind: 'dismissByName'; mandatory: false; cost: number; options: { pos: GridPos; index: number; cardId: CardId }[] }
  | { kind: 'dismissChosenGridCard'; mandatory: true; cost: number; options: { pos: GridPos; index: number; cardId: CardId }[] }
  | { kind: 'hireFromDismissed'; mandatory: false; cost: number; options: { cardId: CardId; ownerPlayerId?: PlayerId }[] }
  | { kind: 'hireFromMarketAndRefill'; mandatory: false; cost: number; options: number[] }
  | { kind: 'discardMarketAndRefill'; mandatory: false; options: number[] }
  | { kind: 'dismissAlligatorTarget'; mandatory: true; cost: 0; options: { pos: GridPos; index: number; cardId: CardId }[] }

// Set while a Pig owes a destination deck. The card has already been detached
// from wherever it landed (grid on hire, dismissed pile on dismiss) and is
// held here until the player names a deck — any seat's, or the toon deck.
//
// It lives on PlayerState because the CHOICE belongs to the acting player,
// even though the DESTINATION may be someone else's deck; resolving it is a
// table-level operation (match.ts's matchResolveDeckPlacement).
export type PendingDeckPlacement = {
  cardId: CardId
  source: 'hire' | 'dismiss'
}

// ---------------------------------------------------------------------------
// The per-player / shared split (Stage 0 of the multiplayer work)
// ---------------------------------------------------------------------------
//
// GameState used to be one flat object holding BOTH one player's private
// state and the state every player shares. Multiplayer needs those separated
// so there is exactly ONE market/toon deck for the table, not N copies that
// have to be kept in sync.
//
// The split is a clean partition — every field below lands in exactly one of
// PlayerState or SharedState, never both — which is what makes
//
//     PlayerView = PlayerState & SharedState
//
// structurally identical to the old flat GameState. That's deliberate: every
// function in phases.ts/flip.ts operates on a PlayerView and keeps its
// original signature, so the 819 lines of interleaved per-player/shared
// mutation in phases.ts (hire -> applyEffects -> refillMarket, all writing
// `market`/`toonDeck` mid-transform) did not have to be restructured.
//
// This is NOT the rejected "N GameStates kept in sync" design. A PlayerView
// is a TRANSIENT projection that exists for the duration of one action;
// `match.shared` is the single durable copy of the shared state. There is no
// fan-out and no sync step. The discipline is:
//
//     project (viewOf) -> mutate -> commit (commitView) -> project the next
//
// and it is enforced at runtime by `viewEpoch`, not left to convention — see
// commitView below.
export type PlayerId = string

// One line of engine-generated log output. `playerId` names whose action
// produced it — null only for genuinely table-wide events (market decay,
// the endgame trigger) that have no single owner, never as a default for
// "didn't bother to attribute it."
export type EngineLogLine = { playerId: PlayerId | null; text: string }

export type PlayerState = {
  playerId: PlayerId
  rng: RngState // per-player stream — see makeMatch for why it isn't shared

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

  // Non-null only while endMarketPhase is paused mid-sequence waiting on
  // Alligator's stack-target choice — see PendingPostMarketChoice's comment.
  // Per-player: it targets the acting player's OWN grid, so a hook pausing
  // player 2's turn must not block player 3.
  pendingPostMarketChoice: PendingPostMarketChoice | null

  // Non-null while this seat owes a Skunk dismissal before the Market phase
  // can open — see PendingPostFameChoice. Always null in solo.
  pendingPostFameChoice: PendingPostFameChoice | null

  // Non-null while a Snake-stacked card's onHire is waiting on a player
  // choice — see PendingOnHireChoice. Unlike pendingPostFameChoice this CAN
  // fire in solo: only season === 'both' toon decks can draw both Snake (S1)
  // and a choice-needing onHire card (Panther/Raccoon, both S2) together.
  pendingOnHireChoice: PendingOnHireChoice | null

  // Non-null while a hired/dismissed Pig is waiting to be put into a deck.
  // Always null in solo — the Pig is excluded from solo's toon deck.
  pendingDeckPlacement: PendingDeckPlacement | null

  // Big Button: "place a Big Button card face up in front of each player."
  // One use per game — flipping it face down IS the cost of its reset effect,
  // and nothing ever flips it back except Axolotl's/Platypus's onHire. It is
  // therefore NOT reset at Cleanup; runMatchCleanup's per-seat reset block is
  // exactly where someone would reflexively add it, so don't.
  //
  // Always present, even with SharedState.resetEffect null: a field that is
  // simply never consulted is cheaper than one every read site has to
  // ?? -default, and score.ts's Platypus condition wants a real boolean.
  bigButtonFaceUp: boolean

  // Whether this seat has taken a hire/dismiss yet in the CURRENT Market
  // phase. Exists solely for RESET: GRID's "this action must be taken on a
  // player's turn before taking any market actions" — RESET: MARKET's own
  // copy of that clause was deliberately relaxed (bigButton.ts's
  // canUseMarketReset no longer reads this field at all; it can be pressed
  // before, during, or after any Market action).
  //
  // `actionsRemaining === MARKET_ACTIONS_PER_ROUND` looks like the same
  // predicate and is not: hiring a Peacock decrements and then re-adds an
  // action (2 - 1 + 1 = 2), so the count is back where it started with a card
  // already bought. Set true in phases.ts's hire/dismiss, back to false at the
  // one place actionsRemaining is dealt out (the postFameHooks -> market
  // transition). Each seat gets exactly one turn per Market phase, so that
  // single reset point is enough — there is no per-turn reset to forget.
  actedThisMarketPhase: boolean
}

// See SharedState.gridReset. Narrowed to 'finalFlip' only: a normal round's
// RESET: GRID decision no longer opens this phase at all — it moved onto the
// resetting seat's own Market turn (bigButton.ts's canUseGridResetNow,
// matchActions.ts's 'useBigButton' case) so there is nothing left to walk
// clockwise through mid-round. The Final Flip has no Market phase to hang
// that decision off, so it still parks the table here (match.ts's
// startMatchFinalFlip / resumeMatchFinalFlip).
export type GridResetState = {
  context: 'finalFlip'
  asked: PlayerId[]
  optedIn: PlayerId[]
}

export type SharedState = {
  phase: Phase
  round: number

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

  // Stamped into every PlayerView by viewOf and checked by commitView. Guards
  // the project -> mutate -> commit discipline at runtime rather than leaving
  // it to convention — see commitView. Optional on the view type so the
  // engine's many hand-built test states stay valid literals.
  viewEpoch: number

  // §3.2.2: latched at Cleanup when EITHER endgame trigger fires — any player
  // generated >= fameToTriggerEndgame this round, or a market refill came up
  // short. The two are OR'd and both firing in one round still produces
  // exactly one Final Flip. Latching (rather than re-deriving) is what makes
  // that guarantee hold.
  endgameTriggered: boolean

  // §3.2.1: awarded at Cleanup to the single highest scorer when the FAME
  // trigger fires; null when unawarded, or when the leaders tied (the rules
  // say the card is returned to the box in that case). Worth +3 during the
  // Final Flip ONLY, via score.ts's separate playerFameModifiers seam — it
  // must never become a scoreGrid bonus.
  criticsChoiceHolder: PlayerId | null

  // Set when the match ends. Solo leaves it null and uses `result` instead.
  winnerId: PlayerId | null

  // §3.2.2 / §4.6: how the DEPLETION endgame trigger is INTERPRETED. Both
  // player counts detect it identically — refillMarket came up short — but
  // they draw opposite conclusions from it:
  //
  //   'soloFameTarget'    solo: running the toon deck dry is a LOSS. You were
  //                       racing a clock and the clock won (actions.ts).
  //   'highestFinalFlip'  multiplayer: it is an ordinary way for the game to
  //                       end. Proceed to the Final Flip; most fame wins.
  //
  // A field rather than a `players.length === 1` branch at the point of use,
  // so the two readings are named where they're decided (setup) instead of
  // rediscovered at every consumer.
  winCondition: WinCondition

  // Big Button (see Phase/ResetEffect above): which reset effect card is on
  // the table, or null for "the mini-expansion is not in play". Fixed at
  // setup and never changed during a match.
  resetEffect: ResetEffect | null

  // Non-null ONLY while the 'gridReset' phase is collecting decisions.
  //
  // RESET: GRID is "starting with the first player, each player in clockwise
  // order decides if they want to use their face-up Big Button card" — so the
  // decisions are SEQUENCED (a later decider sees what the earlier ones
  // chose) even though the resets themselves resolve simultaneously
  // afterwards. `asked` is how the walk knows when it has been all the way
  // round; `optedIn` is who actually resets when it has.
  //
  // `context` is load-bearing: the same phase is entered from a normal
  // round's Check Fame and from the Final Flip's, and it is the only thing
  // that tells the resolution step whether to hand off to postFameHooks or to
  // resume the Final Flip's tiebreak-and-score tail.
  gridReset: GridResetState | null

  // criticsChoiceHolder (§3.2.1) and the Final Flip land here in Stage 2.
  // They were previously documented as deliberately-skipped solo omissions;
  // that reasoning (no Final Flip in solo -> the +3 can never apply) still
  // holds for a 1-player match and is now expressed as a player-count
  // condition rather than a missing field.
}

// One player's transient working view: their private slice joined with the
// shared state. Structurally identical to the pre-split flat GameState, which
// is why phases.ts/flip.ts operate on it unchanged.
//
// finalGrid/finalDeckCount: set only by solo's runCleanup (phases.ts), never
// by multiplayer's separate runMatchCleanup (match.ts) — a snapshot of
// `grid`/`deck.length` taken the instant before Cleanup empties the grid and
// folds it into the deck, for the win/loss branches only. Captured inside
// the engine, atomically with the transition to 'ended', so it can't go
// stale even when a single dispatch cascades through an extra round (see
// actions.ts's advanceThroughPassthroughPhases) — reconstructing it in the
// UI from before/after closures is what used to desync it by a round.
export type PlayerView = PlayerState & Omit<SharedState, 'viewEpoch'> & {
  viewEpoch?: number
  finalGrid?: Grid | null
  finalDeckCount?: number | null
}

// Back-compat alias. Solo is the 1-player case of the same machine, so
// everything that used to take a GameState takes a PlayerView.
export type GameState = PlayerView

export type Match = {
  shared: SharedState
  players: PlayerState[]
  turnOrder: PlayerId[] // seat order; index into `players`
  firstPlayerIndex: number
  activePlayerIndex: number // only meaningful during 'market'
}

const PLAYER_FIELDS = [
  'playerId',
  'rng',
  'deck',
  'grid',
  'dismissed',
  'fame',
  'fameGeneratedThisRound',
  'lastCheckFame',
  'actionsRemaining',
  'pendingOnHireCardIds',
  'pendingPostMarketChoice',
  'pendingPostFameChoice',
  'pendingOnHireChoice',
  'pendingDeckPlacement',
  'bigButtonFaceUp',
  'actedThisMarketPhase',
] as const satisfies readonly (keyof PlayerState)[]

// `satisfies` only checks that every listed key EXISTS on PlayerState — it
// does not check the reverse. Without the guard below, adding a field to
// PlayerState and forgetting it here compiles cleanly and then silently drops
// that field on every single commitView, which surfaces later as a value that
// mysteriously resets to undefined. (Caught exactly that way while adding
// pendingDeckPlacement.) This turns the omission into a compile error naming
// the missing key.
type MissingPlayerFields = Exclude<keyof PlayerState, (typeof PLAYER_FIELDS)[number]>
const _playerFieldsAreExhaustive: MissingPlayerFields extends never
  ? true
  : ['state.ts: PLAYER_FIELDS is missing these PlayerState keys', MissingPlayerFields] = true
void _playerFieldsAreExhaustive

// Project player `index`'s slice joined with the shared state. The result is
// a snapshot: mutating it does not touch `match`.
export function viewOf(match: Match, index: number): PlayerView {
  const player = match.players[index]
  if (!player) throw new Error(`state.ts: viewOf — no player at index ${index}`)
  return { ...match.shared, ...player }
}

// Fold a mutated view back into the match. Shared fields land in the single
// `match.shared`; per-player fields land in `players[index]`.
//
// The epoch check is the teeth behind "one live view at a time". Without it,
// the natural-looking parallel Flip loop
//
//     const a = viewOf(m, 0), b = viewOf(m, 1)
//     m = commitView(commitView(m, 0, runFlip(a)), 1, runFlip(b))
//
// silently corrupts the game: `b` was projected off the pre-flip toon deck,
// so committing it clobbers the cards player 0's flip drew, duplicating them
// across two grids. Bumping the epoch on every commit turns that into a loud
// throw instead of a scoring bug someone finds three rounds later.
export function commitView(match: Match, index: number, view: PlayerView): Match {
  if (!match.players[index]) throw new Error(`state.ts: commitView — no player at index ${index}`)
  if (view.viewEpoch !== undefined && view.viewEpoch !== match.shared.viewEpoch) {
    throw new Error(
      `state.ts: commitView — stale view for player ${index} (view epoch ${view.viewEpoch}, match epoch ${match.shared.viewEpoch}). Views must be projected, mutated, and committed one at a time; re-project after every commit.`,
    )
  }

  const player = {} as PlayerState
  for (const key of PLAYER_FIELDS) {
    // Each key is its own property of both types; the cast is a
    // per-key-narrowing limitation, not a shape mismatch.
    ;(player as Record<string, unknown>)[key] = view[key]
  }

  const shared: SharedState = {
    phase: view.phase,
    round: view.round,
    toonDeck: view.toonDeck,
    toonDeckDepleted: view.toonDeckDepleted,
    market: view.market,
    nextInsertionSeq: view.nextInsertionSeq,
    fameToTriggerEndgame: view.fameToTriggerEndgame,
    result: view.result,
    endgameTriggered: view.endgameTriggered,
    criticsChoiceHolder: view.criticsChoiceHolder,
    winnerId: view.winnerId,
    winCondition: view.winCondition,
    resetEffect: view.resetEffect,
    gridReset: view.gridReset,
    viewEpoch: match.shared.viewEpoch + 1,
  }

  const players = match.players.slice()
  players[index] = player
  return { ...match, shared, players }
}

export function createSoloGameState(params: {
  seed: number
  startingDeck: CardId[]
  toonDeck: CardId[] // already trimmed for difficulty (setup.ts's buildSoloToonDeck)
  prices: number[]
  fameToTriggerEndgame: number
  playerId?: PlayerId
  // Big Button: which reset effect card is on the table. Omitted (undefined)
  // means the mini-expansion is not in play, which is the default.
  resetEffect?: ResetEffect | null
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
    playerId: params.playerId ?? 'p0',
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
    endgameTriggered: false,
    criticsChoiceHolder: null,
    winnerId: null,
    // Solo: a failed market refill is a loss, not a Final Flip.
    winCondition: 'soloFameTarget',
    pendingPostMarketChoice: null,
    pendingPostFameChoice: null,
    pendingOnHireChoice: null,
    pendingDeckPlacement: null,
    // "Place a Big Button card face up in front of each player" — face up is
    // the starting state whether or not the expansion is in play.
    bigButtonFaceUp: true,
    actedThisMarketPhase: false,
    resetEffect: params.resetEffect ?? null,
    gridReset: null,
  }
}

// Builds a Match from one already-constructed view plus each additional
// player's own starting deck. The shared state is taken from `first` — there
// is exactly one copy of it, which is the whole point of the split.
//
// Per-player RNG streams (not one shared stream consumed in turn order):
// with a shared stream, player 3's flip order would depend on how many
// toon-deck draws players 1-2's flips happened to trigger first, which makes
// a single player's game impossible to reproduce in isolation and leaks turn
// position into the shuffle. Each seat derives its own stream from the match
// seed and its index instead.
export function makeMatch(first: GameState, others: { playerId: PlayerId; startingDeck: CardId[]; seed: number }[] = []): Match {
  const { viewEpoch: _ignored, ...view } = first
  const shared: SharedState = {
    phase: view.phase,
    round: view.round,
    toonDeck: view.toonDeck,
    toonDeckDepleted: view.toonDeckDepleted,
    market: view.market,
    nextInsertionSeq: view.nextInsertionSeq,
    fameToTriggerEndgame: view.fameToTriggerEndgame,
    result: view.result,
    endgameTriggered: view.endgameTriggered,
    criticsChoiceHolder: view.criticsChoiceHolder,
    winnerId: view.winnerId,
    winCondition: view.winCondition,
    resetEffect: view.resetEffect,
    gridReset: view.gridReset,
    viewEpoch: 0,
  }

  const players: PlayerState[] = [
    {
      playerId: view.playerId,
      rng: view.rng,
      deck: view.deck,
      grid: view.grid,
      dismissed: view.dismissed,
      fame: view.fame,
      fameGeneratedThisRound: view.fameGeneratedThisRound,
      lastCheckFame: view.lastCheckFame,
      actionsRemaining: view.actionsRemaining,
      pendingOnHireCardIds: view.pendingOnHireCardIds,
      pendingPostMarketChoice: view.pendingPostMarketChoice,
      pendingPostFameChoice: view.pendingPostFameChoice,
      pendingOnHireChoice: view.pendingOnHireChoice,
      pendingDeckPlacement: view.pendingDeckPlacement,
      bigButtonFaceUp: view.bigButtonFaceUp,
      actedThisMarketPhase: view.actedThisMarketPhase,
    },
    ...others.map((o) => ({
      playerId: o.playerId,
      rng: initRngState(o.seed),
      deck: o.startingDeck.slice(),
      grid: emptyGrid(),
      dismissed: [] as CardId[],
      fame: 0,
      fameGeneratedThisRound: 0,
      lastCheckFame: null,
      actionsRemaining: 0,
      pendingOnHireCardIds: [] as CardId[],
      pendingPostMarketChoice: null,
      pendingPostFameChoice: null,
      pendingOnHireChoice: null,
      pendingDeckPlacement: null,
      bigButtonFaceUp: true,
      actedThisMarketPhase: false,
    })),
  ]

  const turnOrder = players.map((p) => p.playerId)
  return { shared, players, turnOrder, firstPlayerIndex: 0, activePlayerIndex: 0 }
}
