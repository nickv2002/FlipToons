// The multiplayer turn machine (§3.2's round loop at N players).
//
// phases.ts holds the per-player transforms and is deliberately unaware of
// turn order — every function there operates on ONE player's view. This
// module owns everything that is about the TABLE: whose turn it is, when a
// phase actually ends, and which steps are once-per-round rather than
// once-per-turn.
//
// The split matters most in the Market phase. phases.ts's endMarketPhase does
// post-market hooks + refill + decay + the phase transition in one pass, which
// is correct only when there is exactly one seat. At N seats those have three
// different timings (§3.2.2 line 215, §3.6 row 17):
//
//   post-market hooks   per turn   (the acting player's own grid)
//   standard refill     per turn   (after each seat's actions)
//   market decay        per ROUND  (once, after the last seat, 1-2 players)
//   phase -> cleanup    per ROUND  (once, when the turn order wraps)
//
// Every function here follows state.ts's project -> mutate -> commit ->
// re-project discipline. Never hold two views at once; commitView's epoch
// check will throw if you do.

import type { EffectChoices } from './cards/types'
import {
  dismiss,
  endMarketPhase,
  hire,
  resumePostMarketHooks,
  runCheckFame,
  runFlip,
  runMarketDecay,
  runPostFameHooks,
  runPostMarketHooks,
  resolvePostFameChoice,
  runStandardRefill,
} from './phases'
import { emptyGrid, occupiedSlots } from './grid'
import { shuffleWithState } from './rng'
import type { Match, PlayerId, PlayerView } from './state'
import { commitView, createSoloGameState, makeMatch, viewOf } from './state'
import { buildMultiplayerSetup } from './setup'
import type { FameModifier, RoundFame } from './roundFame'
import { roundFame } from './roundFame'
import type { CardId } from './cards/types'
import type { Grid, GridPos } from './types'

// Builds a ready-to-play N-player match: shared market already filled from
// the season's full toon deck (Pig included, no difficulty trim — both of
// those are solo-only), prices keyed off player count, one starting deck and
// one RNG stream per seat.
// `fameToTriggerEndgame` is overridable because 30 fame is many rounds of
// play. Tests and the browser end-to-end run set it low to reach a Final Flip
// in a couple of rounds; it is also the single most useful playtesting knob
// (setup.ts's DEFAULT_FAME_TO_TRIGGER_ENDGAME).
export function buildNewMatch(
  seed: number,
  playerCount: number,
  season: 1 | 2 = 1,
  options: { fameToTriggerEndgame?: number } = {},
): Match {
  const setup = buildMultiplayerSetup(seed, playerCount, season)
  const first = createSoloGameState({
    seed: setup.playerSeeds[0],
    startingDeck: setup.startingDecks[0],
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: options.fameToTriggerEndgame ?? setup.fameToTriggerEndgame,
    playerId: 'p0',
  })
  // createSoloGameState defaults to solo's reading of a failed refill (a
  // loss); at 2+ seats it is an ordinary ending that goes to the Final Flip.
  first.winCondition = setup.winCondition
  return makeMatch(
    first,
    setup.startingDecks.slice(1).map((deck, i) => ({
      playerId: `p${i + 1}`,
      startingDeck: deck,
      seed: setup.playerSeeds[i + 1],
    })),
  )
}

export function isSolo(match: Match): boolean {
  return match.players.length === 1
}

export function playerIndex(match: Match, playerId: PlayerId): number {
  const i = match.players.findIndex((p) => p.playerId === playerId)
  if (i === -1) throw new Error(`match.ts: no player '${playerId}' in this match`)
  return i
}

export function activePlayerId(match: Match): PlayerId {
  return match.turnOrder[match.activePlayerIndex]
}

// Turn-ownership guard for the strictly turn-based Market phase (§3.0's
// "first player then clockwise"). Solo skips it — a 1-player match's only
// seat is always active — but the check is cheap and holds there too.
function assertActive(match: Match, playerId: PlayerId, fn: string): number {
  const index = playerIndex(match, playerId)
  if (index !== match.activePlayerIndex) {
    throw new Error(`match.ts: ${fn} — it is ${activePlayerId(match)}'s turn, not ${playerId}'s`)
  }
  return index
}

// Apply a per-player transform through the view boundary. The single place
// this module projects and commits, so the discipline is enforced in one spot
// rather than repeated at every call site.
function withPlayer(match: Match, index: number, fn: (view: PlayerView) => PlayerView): Match {
  return commitView(match, index, fn(viewOf(match, index)))
}

// ---------------------------------------------------------------------------
// Flip — rules-simultaneous, but SEQUENCED across seats
// ---------------------------------------------------------------------------
//
// §3.0 calls Flip simultaneous, and from a player's perspective it is: each
// seat reveals its own deck into its own grid. But Flip also DRAWS from the
// shared toon deck (Snake's stack effect), so the seats cannot literally run
// in parallel — each must see the toon deck as the previous seat left it.
//
// Sequencing them in turn order is deterministic and reproducible. It does not
// bias anyone's shuffle: each seat draws its flip order from its OWN rng
// stream (state.ts's makeMatch), so turn position never leaks into what a
// player reveals.
export function runMatchFlip(match: Match, logLines?: string[], debugLines?: string[]): Match {
  // The Final Flip has ONE entry point, runMatchFinalFlip, because it must not
  // fall through into Check Fame -> post-fame hooks -> Market the way a normal
  // round does. Routing it here instead would do exactly that: this function
  // hands off by setting `phase: 'checkFame'`, which erases the only signal
  // that a Final Flip was in progress.
  if (match.shared.phase !== 'flip') {
    throw new Error(`match.ts: runMatchFlip called in phase '${match.shared.phase}'` + (match.shared.phase === 'finalFlip' ? ' — use runMatchFinalFlip for the Final Flip' : ''))
  }
  const next = flipSeats(match, allSeats(match), logLines, debugLines)
  return { ...next, shared: { ...next.shared, phase: 'checkFame' } }
}

function allSeats(match: Match): number[] {
  return match.players.map((_, i) => i)
}

// Flips a SUBSET of seats, leaving the shared phase alone. Split out of
// runMatchFlip for the Final Flip's tiebreak, where only the tied players
// re-flip and everyone else's PlayerState must be left exactly as it is.
function flipSeats(match: Match, seats: number[], logLines?: string[], debugLines?: string[]): Match {
  let next = match
  for (const i of seats) {
    // Re-projected inside withPlayer on every iteration, so seat i+1 sees the
    // toon deck seat i actually left behind. Projecting all seats up front is
    // the bug commitView's epoch check exists to catch.
    next = withPlayer(next, i, (view) => {
      // runFlip advances the shared phase to 'checkFame'; that's a per-player
      // function writing a table-wide field, so it's forced back below and
      // set once, by this module, after every seat has flipped.
      const flipped = runFlip({ ...view, phase: 'flip' }, logLines, debugLines)
      return { ...flipped, phase: view.phase }
    })
  }
  return next
}

// ---------------------------------------------------------------------------
// Check Fame — simultaneous and automatic
// ---------------------------------------------------------------------------
//
// Genuinely simultaneous: scoring reads grids but mutates only the scoring
// player's own fame fields, so seat order cannot matter. Each seat is scored
// against every OTHER seat's grid for Dog/Camel/Fox.
export function runMatchCheckFame(match: Match): Match {
  if (match.shared.phase !== 'checkFame') {
    throw new Error(`match.ts: runMatchCheckFame called in phase '${match.shared.phase}'`)
  }
  const next = checkFameSeats(match, allSeats(match))
  return { ...next, shared: { ...next.shared, phase: 'postFameHooks' } }
}

// Scores a SUBSET of seats, leaving the shared phase alone.
//
// The subset chooses who gets SCORED, never who gets scored AGAINST: every
// seat is always measured against every other grid on the table. That matters
// in the Final Flip's tiebreak, where only the tied players re-flip — the
// spectators' Final Flip boards are still laid out in front of them, so a
// re-flipping player's Dog/Camel/Fox conditions must still see them. Reading
// only the tied players' grids there would silently change what those cards
// are worth partway through resolving one Final Flip.
function checkFameSeats(match: Match, seats: number[]): Match {
  // Snapshot the grids BEFORE scoring anyone. Check Fame is simultaneous, so
  // every seat must be scored against the same board — and nothing here
  // mutates a grid anyway, but taking the snapshot up front makes that
  // independence explicit rather than incidental.
  const grids = match.players.map((p) => p.grid)

  let next = match
  for (const i of seats) {
    const others = grids.filter((_, j) => j !== i)
    next = withPlayer(next, i, (view) => {
      const scored = runCheckFame({ ...view, phase: 'checkFame' }, others)
      return { ...scored, phase: view.phase }
    })
  }
  return next
}

// ---------------------------------------------------------------------------
// postFameHooks -> Market
// ---------------------------------------------------------------------------
//
// The Final Flip is Flip + Check Fame ONLY (§3.2) — no Market, no Cleanup —
// so this refuses to open a Market phase during one.
// Which seat, if any, is STRICTLY the lowest scorer this round — the trigger
// for Skunk/Firefly (§3.4). Skunk's FAQ: "Only one player can benefit from the
// skunk's ability each round. In case of a tie, the skunk has no effect." So a
// tie for last means no one qualifies, and solo is vacuously the lowest.
//
// Reads fameGeneratedThisRound (the frozen Check-Fame snapshot), not the
// spendable `fame`, so a Firefly's own +2 can't change who was lowest.
export function strictlyLowestScorerIndex(match: Match): number | null {
  if (match.players.length === 1) return 0
  const scores = match.players.map((p) => p.fameGeneratedThisRound)
  const low = Math.min(...scores)
  const tied = scores.filter((s) => s === low)
  if (tied.length !== 1) return null
  return scores.indexOf(low)
}

export function runMatchPostFameHooks(match: Match): Match {
  if (match.shared.phase !== 'postFameHooks') {
    throw new Error(`match.ts: runMatchPostFameHooks called in phase '${match.shared.phase}'`)
  }
  const lowest = strictlyLowestScorerIndex(match)

  let next = match
  for (let i = 0; i < next.players.length; i++) {
    next = withPlayer(next, i, (view) => {
      const hooked = runPostFameHooks({ ...view, phase: 'postFameHooks' }, i === lowest)
      return { ...hooked, phase: view.phase }
    })
  }
  return openMarketPhaseIfReady(next)
}

// The Market phase cannot open while any seat still owes a mandatory Skunk
// dismissal — that hook is explicitly resolved BEFORE the Market phase (§3.4).
// Callers poll this after each resolvePostFameChoice.
function openMarketPhaseIfReady(match: Match): Match {
  if (match.players.some((p) => p.pendingPostFameChoice)) return match
  // Defense in depth: the Final Flip is Flip + Check Fame only (§3.2). Nothing
  // should reach here during one, but if something ever does, refusing to open
  // a Market phase is far better than silently granting everyone 2 more
  // actions after the game was supposed to be over.
  if (match.shared.endgameTriggered) return match
  // §3.0: the Market phase starts with the first player and goes clockwise.
  return {
    ...match,
    shared: { ...match.shared, phase: 'market' },
    activePlayerIndex: match.firstPlayerIndex,
  }
}

// Answers one seat's pending Skunk dismissal. Deliberately NOT turn-gated:
// postFameHooks is a simultaneous phase, so whichever seat holds a prompt may
// answer it whenever they like — nobody is waiting on a turn to come round.
export function matchResolvePostFameChoice(match: Match, playerId: PlayerId, choice: { pos: GridPos; index: number }): Match {
  const index = playerIndex(match, playerId)
  if (!match.players[index].pendingPostFameChoice) {
    throw new Error(`match.ts: matchResolvePostFameChoice — ${playerId} has no pending post-fame choice`)
  }
  const resolved = withPlayer(match, index, (view) => {
    const done = resolvePostFameChoice({ ...view, phase: 'postFameHooks' }, choice)
    // resolvePostFameChoice opens the Market phase for a solo game; at N seats
    // that transition belongs to openMarketPhaseIfReady below.
    return { ...done, phase: view.phase }
  })
  return openMarketPhaseIfReady(resolved)
}

// ---------------------------------------------------------------------------
// Market — strictly turn-based
// ---------------------------------------------------------------------------

export function matchHire(match: Match, playerId: PlayerId, slotIndex: number, choices?: EffectChoices): Match {
  const index = assertActive(match, playerId, 'matchHire')
  return withPlayer(match, index, (view) => hire(view, slotIndex, choices))
}

export function matchDismiss(match: Match, playerId: PlayerId, pos: GridPos, cardIndex?: number, choices?: EffectChoices): Match {
  const index = assertActive(match, playerId, 'matchDismiss')
  return withPlayer(match, index, (view) => dismiss(view, pos, cardIndex, choices))
}

export function matchResolvePostMarketChoice(match: Match, playerId: PlayerId, choice: { pos: GridPos; index: number }, logLines?: string[]): Match {
  const index = assertActive(match, playerId, 'matchResolvePostMarketChoice')
  const afterChoice = withPlayer(match, index, (view) => resolvePostMarketChoiceOnly(view, choice, logLines))
  // The choice may have unblocked the rest of this seat's hooks; if none are
  // left pending, the turn can close.
  //
  // It closes through finishSeatTurn, NOT endMarketTurn: the hook pass is
  // already finished and resuming it is the resume function's job. Going back
  // through endMarketTurn re-ran runPostMarketHooks from scratch, and that
  // scan is stateless — every hook still standing in the grid fired a second
  // time.
  if (afterChoice.players[index].pendingPostMarketChoice) return afterChoice
  return finishSeatTurn(afterChoice, index)
}

// phases.ts's resolvePostMarketChoice resumes the whole solo end-of-phase
// sequence (refill + decay + phase transition) once the hooks finish. Under a
// turn machine those steps belong to the turn, so this uses the hook-only half
// and leaves the timing to the caller.
//
// The old version called the full solo function and then pinned `phase` and
// `actionsRemaining` back, on the theory that the pin undid it. It didn't: the
// refill and — worse — the 1-2 player decay had already written `market`,
// `toonDeck` and `nextInsertionSeq`, and the pin doesn't touch those. A 3-4
// player table burned two toon cards to a rule that doesn't apply to it, and a
// 1-2 player table on its last seat decayed twice in one round.
function resolvePostMarketChoiceOnly(view: PlayerView, choice: { pos: GridPos; index: number }, logLines?: string[]): PlayerView {
  const pending = view.pendingPostMarketChoice
  if (!pending) throw new Error('match.ts: resolvePostMarketChoiceOnly — no pending post-Market choice')
  return resumePostMarketHooks(view, choice, logLines)
}

// Ends ONE seat's Market turn: fire that seat's post-market hooks, then close
// the turn.
export function endMarketTurn(match: Match, playerId: PlayerId, logLines?: string[]): Match {
  const index = assertActive(match, playerId, 'endMarketTurn')

  const afterHooks = withPlayer(match, index, (view) => runPostMarketHooks(view, logLines))

  // Paused mid-hooks — the turn does NOT pass; this seat still owes a choice,
  // and matchResolvePostMarketChoice picks the sequence back up from here.
  if (afterHooks.players[index].pendingPostMarketChoice) return afterHooks

  return finishSeatTurn(afterHooks, index)
}

// The tail of a seat's Market turn, once its hooks are done however they got
// there: refill the shared market, then either pass to the next seat or — if
// the turn order has wrapped — close the phase for the whole table.
function finishSeatTurn(match: Match, index: number): Match {
  const afterRefill = withPlayer(match, index, (view) => ({ ...runStandardRefill(view), actionsRemaining: 0 }))

  const nextIndex = (index + 1) % afterRefill.turnOrder.length
  const wrapped = nextIndex === afterRefill.firstPlayerIndex
  if (!wrapped) return { ...afterRefill, activePlayerIndex: nextIndex }

  return closeMarketPhase(afterRefill)
}

// Once-per-round tail of the Market phase: the 1-2 player decay, then the
// transition to Cleanup. Deliberately NOT part of endMarketTurn's per-seat
// work — running the decay per turn would burn 2 toon cards per seat per
// round instead of 2 per round, racing an N-player game to depletion.
function closeMarketPhase(match: Match): Match {
  const decayed = match.players.length <= 2 ? withPlayer(match, match.firstPlayerIndex, (view) => runMarketDecay(view)) : match
  return { ...decayed, shared: { ...decayed.shared, phase: 'cleanup' } }
}

// ---------------------------------------------------------------------------
// Pig: "place this card in any deck"
// ---------------------------------------------------------------------------
//
// The only card whose effect crosses seats. phases.ts has already detached it
// (applyEffects' placeSelfInAnyDeck) and left a pendingDeckPlacement on the
// acting player; this puts it where they said. Table-level because the
// destination may be a deck the acting player's own view cannot reach.
export type DeckPlacementTarget = { kind: 'player'; playerId: PlayerId } | { kind: 'toonDeck' }

// Every legal destination, for a UI prompt: each seat's deck (your own
// included — the FAQ says "any player's deck", not "another player's"), plus
// the toon deck.
export function deckPlacementTargets(match: Match): DeckPlacementTarget[] {
  return [...match.players.map((p) => ({ kind: 'player' as const, playerId: p.playerId })), { kind: 'toonDeck' as const }]
}

export function matchResolveDeckPlacement(match: Match, playerId: PlayerId, target: DeckPlacementTarget): Match {
  const index = playerIndex(match, playerId)
  const pending = match.players[index].pendingDeckPlacement
  if (!pending) throw new Error(`match.ts: matchResolveDeckPlacement — ${playerId} has no card waiting for a deck`)

  const cleared = withPlayer(match, index, (view) => ({ ...view, pendingDeckPlacement: null }))

  if (target.kind === 'toonDeck') {
    // FAQ: "Shuffle the deck if placed in the toon deck." Shuffled with the
    // ACTING player's stream — the placement is their action, and every seat
    // has its own stream (state.ts's makeMatch), so it has to come from
    // somewhere specific to stay reproducible.
    return withPlayer(cleared, index, (view) => {
      const shuffled = shuffleWithState([...view.toonDeck, pending.cardId], view.rng)
      return { ...view, toonDeck: shuffled.result, rng: shuffled.next }
    })
  }

  // Into a seat's deck. NOT shuffled: the FAQ calls for a shuffle only for
  // the toon deck, and a player's deck is shuffled at the start of every Flip
  // anyway (phases.ts's runFlip), so the position it goes in never matters.
  const targetIndex = playerIndex(cleared, target.playerId)
  return withPlayer(cleared, targetIndex, (view) => ({ ...view, deck: [...view.deck, pending.cardId] }))
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function collectGridCards(grid: Grid): CardId[] {
  const ids: CardId[] = []
  for (const { slot } of occupiedSlots(grid)) ids.push(...slot.cards)
  return ids
}

// §3.2's Cleanup, in the order the rules require. The ordering is load-bearing
// and easy to get wrong: the Critic's Choice award reads
// fameGeneratedThisRound, so resetting fame before awarding would hand the
// token to an N-way tie at zero and silently remove it from the game every
// single round.
//
//   1. evaluate the endgame triggers (OR'd, latched once)
//   2. award the Critic's Choice
//   3. collect grids back into decks, refill the market, reset fame
//   4. rotate the first-player marker clockwise
export function runMatchCleanup(match: Match): Match {
  if (match.shared.phase !== 'cleanup') {
    throw new Error(`match.ts: runMatchCleanup called in phase '${match.shared.phase}'`)
  }

  // A card detached by placeSelfInAnyDeck (the Pig) and not yet given a
  // destination is in NO zone. Cleanup collects grids back into decks, so
  // reaching here with one outstanding would lose it silently and forever —
  // the prompt is turn-gated, and its seat's turn is over. matchActions.ts
  // guards every path a player can drive; this closes the CLASS, so any path
  // nobody has enumerated yet fails loudly instead of eating a card.
  const stranded = match.players.find((p) => p.pendingDeckPlacement !== null)
  if (stranded) {
    throw new Error(
      `match.ts: runMatchCleanup — ${stranded.playerId} still owes a deck for ${stranded.pendingDeckPlacement!.cardId}; the card would be lost`,
    )
  }

  // (1) Both triggers, OR'd (§3.2.2). Latched, never re-derived, so that both
  // firing in the same round still produces exactly ONE endgame.
  const threshold = match.shared.fameToTriggerEndgame
  const fameTriggered = match.players.some((p) => p.fameGeneratedThisRound >= threshold)
  const depletionTriggered = match.shared.toonDeckDepleted
  const endgameTriggered = match.shared.endgameTriggered || fameTriggered || depletionTriggered

  // (2) §3.2.1: awarded to the single highest scorer, and ONLY on the fame
  // trigger. A depletion-only ending awards nothing — the rules text
  // conditions the whole award on "if any player generated at least 30 fame",
  // and is silent on the depletion path. Flagged in the plan as the rulebook's
  // own gap; flip AWARD_ON_DEPLETION_ONLY_ENDING to change the reading.
  let criticsChoiceHolder = match.shared.criticsChoiceHolder
  if (fameTriggered && criticsChoiceHolder === null) {
    criticsChoiceHolder = awardCriticsChoice(match)
  }

  // (3) Collect + reset, per seat.
  let next = match
  for (let i = 0; i < next.players.length; i++) {
    next = withPlayer(next, i, (view) => ({
      ...view,
      deck: [...view.deck, ...collectGridCards(view.grid)],
      grid: emptyGrid(),
      fame: 0,
      fameGeneratedThisRound: 0,
      actionsRemaining: 0,
    }))
  }
  // One shared refill for the table (§3.2's own Cleanup bullet — a no-op when
  // the market is already full).
  next = withPlayer(next, 0, (view) => runStandardRefill(view))

  const shared = { ...next.shared, endgameTriggered, criticsChoiceHolder }

  if (endgameTriggered) {
    // §3.2: the trigger round has now played its FULL Market phase and
    // Cleanup. What follows is the truncated Final Flip, not another round.
    return { ...next, shared: { ...shared, phase: 'finalFlip' } }
  }

  // (4) §3.2: "pass the first player card clockwise."
  const firstPlayerIndex = (next.firstPlayerIndex + 1) % next.turnOrder.length
  return {
    ...next,
    shared: { ...shared, phase: 'flip', round: shared.round + 1 },
    firstPlayerIndex,
    activePlayerIndex: firstPlayerIndex,
  }
}

// §3.2.1: "the player who generated the most fame takes the critic's choice
// card... If multiple players generated at least 30 fame and are tied for the
// most fame, return the critic's choice card to the game box instead."
//
// So a TIE for the lead removes the card from the game entirely rather than
// leaving it unawarded-but-available; null covers both, and the latched
// endgameTriggered flag means this is only ever reached once.
function awardCriticsChoice(match: Match): PlayerId | null {
  const top = Math.max(...match.players.map((p) => p.fameGeneratedThisRound))
  const leaders = match.players.filter((p) => p.fameGeneratedThisRound === top)
  if (leaders.length !== 1) return null
  return leaders[0].playerId
}

// Solo keeps its own end-of-round path (actions.ts's win/loss handling); this
// module's Cleanup is the multiplayer one. Re-exported so callers that only
// import match.ts can still reach the per-player phase entry point.
export { endMarketPhase }

// ---------------------------------------------------------------------------
// The Final Flip (§3.2)
// ---------------------------------------------------------------------------
//
// "Flip and Check Fame ONLY" — no Market phase, no Cleanup, no post-fame
// hooks. Whoever generates the most fame wins, counting the Critic's Choice
// holder's +3 (roundFame.ts's seam, never scoreGrid).
//
// Note what this does NOT do: it never looks at anyone's accumulated score,
// because there isn't one. Fame is a single per-round number that is
// simultaneously your score, your spending power, and expiring (§4.2). The
// Final Flip is the whole scoring event; the rounds before it only decided
// who got to buy what.
//
// A safety cap on the tiebreak re-flip loop. Reaching it means many
// consecutive exact ties, which is vanishingly unlikely but not impossible
// with small decks. The behaviour at the cap is a SHARED win rather than a
// throw: a thrown error mid-Final-Flip destroys a finished game, while a
// co-win is a defensible answer to "these players genuinely could not be
// separated."
const MAX_TIEBREAK_ROUNDS = 100

export type FinalFlipOutcome = {
  match: Match
  // Every seat's Final Flip fame, in seat order, including the +3.
  scores: { playerId: PlayerId; total: number; modifiers: FameModifier[] }[]
  winners: PlayerId[] // more than one only at MAX_TIEBREAK_ROUNDS
  tiebreakRounds: number // 0 when the first flip settled it
}

// Runs the entire Final Flip, tiebreak loop included, to a decided winner.
//
// Synchronous and non-interactive on purpose: Flip and Check Fame are both
// automatic, and the Final Flip skips the two phases that can pause on a
// player choice (post-fame hooks and the Market phase). So unlike a normal
// round, there is nothing here to hand back to a client mid-way.
export function runMatchFinalFlip(match: Match, logLines?: string[], debugLines?: string[]): FinalFlipOutcome {
  if (match.shared.phase !== 'finalFlip') {
    throw new Error(`match.ts: runMatchFinalFlip called in phase '${match.shared.phase}', expected 'finalFlip'`)
  }

  // First flip: everyone.
  let next = flipSeats(match, allSeats(match), logLines, debugLines)
  next = checkFameSeats(next, allSeats(match))

  let contenders = leaders(next)
  let tiebreakRounds = 0

  // §3.2: "if there is a tie, the tied players flip again." Only they do —
  // every other seat's PlayerState is untouched, so their board stays on the
  // table (and stays visible to the re-flippers' Dog/Camel/Fox — see
  // checkFameSeats) and their score stands as already recorded.
  while (contenders.length > 1 && tiebreakRounds < MAX_TIEBREAK_ROUNDS) {
    tiebreakRounds++
    const seats = contenders.map((id) => playerIndex(next, id))

    // Collect grid + deck and reshuffle, exactly as Cleanup would — except
    // scoped to the tied seats and with no fame reset, since the Final Flip's
    // fame IS the result. runFlip does the reshuffle itself.
    for (const i of seats) {
      next = withPlayer(next, i, (view) => ({
        ...view,
        deck: [...view.deck, ...collectGridCards(view.grid)],
        grid: emptyGrid(),
      }))
    }

    next = flipSeats(next, seats, logLines, debugLines)
    next = checkFameSeats(next, seats)

    // Re-rank among the tied players only. A spectator who happened to score
    // higher than the re-flip produced does NOT re-enter contention — they
    // already lost the comparison that sent these two to a re-flip.
    contenders = leaders(next, contenders)
  }

  const scores = next.players.map((p) => {
    const rf = roundFame(p, next.shared)
    return { playerId: p.playerId, total: rf.total, modifiers: rf.modifiers }
  })

  const winners = contenders
  const ended: Match = {
    ...next,
    shared: {
      ...next.shared,
      phase: 'ended',
      // One winner sets winnerId; an exhausted tiebreak leaves it null and
      // reports the co-winners through `winners` instead.
      winnerId: winners.length === 1 ? winners[0] : null,
      result: 'win',
    },
  }

  return { match: ended, scores, winners, tiebreakRounds }
}

// The seat(s) with the highest roundFame, optionally restricted to a candidate
// set (the tiebreak's contenders).
function leaders(match: Match, among?: PlayerId[]): PlayerId[] {
  const pool = among ? match.players.filter((p) => among.includes(p.playerId)) : match.players
  const totals = pool.map((p) => ({ playerId: p.playerId, total: roundFame(p, match.shared).total }))
  const top = Math.max(...totals.map((t) => t.total))
  return totals.filter((t) => t.total === top).map((t) => t.playerId)
}

// Every seat's Final Flip fame without advancing anything — for the UI's
// scoreboard and for tests that want to inspect the +3 in isolation.
export function matchRoundFame(match: Match): { playerId: PlayerId; fame: RoundFame }[] {
  return match.players.map((p) => ({ playerId: p.playerId, fame: roundFame(p, match.shared) }))
}
