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
  resolvePostMarketChoice,
  runCheckFame,
  runFlip,
  runMarketDecay,
  runPostFameHooks,
  runPostMarketHooks,
  resolvePostFameChoice,
  runStandardRefill,
} from './phases'
import { emptyGrid, occupiedSlots } from './grid'
import type { Match, PlayerId, PlayerView } from './state'
import { commitView, createSoloGameState, makeMatch, viewOf } from './state'
import { buildMultiplayerSetup } from './setup'
import type { CardId } from './cards/types'
import type { Grid, GridPos } from './types'

// Builds a ready-to-play N-player match: shared market already filled from
// the season's full toon deck (Pig included, no difficulty trim — both of
// those are solo-only), prices keyed off player count, one starting deck and
// one RNG stream per seat.
export function buildNewMatch(seed: number, playerCount: number, season: 1 | 2 = 1): Match {
  const setup = buildMultiplayerSetup(seed, playerCount, season)
  const first = createSoloGameState({
    seed: setup.playerSeeds[0],
    startingDeck: setup.startingDecks[0],
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
    playerId: 'p0',
  })
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
  if (match.shared.phase !== 'flip' && match.shared.phase !== 'finalFlip') {
    throw new Error(`match.ts: runMatchFlip called in phase '${match.shared.phase}'`)
  }
  let next = match
  for (let i = 0; i < next.players.length; i++) {
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
  return { ...next, shared: { ...next.shared, phase: 'checkFame' } }
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
  // Snapshot the grids BEFORE scoring anyone. Check Fame is simultaneous, so
  // every seat must be scored against the same board — and nothing here
  // mutates a grid anyway, but taking the snapshot up front makes that
  // independence explicit rather than incidental.
  const grids = match.players.map((p) => p.grid)

  let next = match
  for (let i = 0; i < next.players.length; i++) {
    const others = grids.filter((_, j) => j !== i)
    next = withPlayer(next, i, (view) => {
      const scored = runCheckFame({ ...view, phase: 'checkFame' }, others)
      return { ...scored, phase: view.phase }
    })
  }
  return { ...next, shared: { ...next.shared, phase: 'postFameHooks' } }
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
  if (afterChoice.players[index].pendingPostMarketChoice) return afterChoice
  return endMarketTurn(afterChoice, playerId, logLines)
}

// phases.ts's resolvePostMarketChoice resumes the whole solo end-of-phase
// sequence (refill + decay + phase transition) once the hooks finish. Under a
// turn machine those steps belong to endMarketTurn, so this stops at the hook
// boundary and leaves the timing to the caller.
function resolvePostMarketChoiceOnly(view: PlayerView, choice: { pos: GridPos; index: number }, logLines?: string[]): PlayerView {
  const pending = view.pendingPostMarketChoice
  if (!pending) throw new Error('match.ts: resolvePostMarketChoiceOnly — no pending post-Market choice')
  // Resolve against a state whose remaining candidates are the ONLY ones left,
  // then stop; resolvePostMarketChoice returns early (still phase 'market')
  // whenever another choice is needed, and otherwise would run the solo
  // finishEndMarketPhase — which the phase pin below neutralizes.
  const resolved = resolvePostMarketChoice(view, choice, logLines)
  return { ...resolved, phase: 'market', actionsRemaining: view.actionsRemaining }
}

// Ends ONE seat's Market turn: fire that seat's post-market hooks, refill the
// shared market, then either pass to the next seat or — if the turn order has
// wrapped — close the phase for the whole table.
export function endMarketTurn(match: Match, playerId: PlayerId, logLines?: string[]): Match {
  const index = assertActive(match, playerId, 'endMarketTurn')

  const afterHooks = withPlayer(match, index, (view) => {
    const hooked = runPostMarketHooks(view, logLines)
    if (hooked.pendingPostMarketChoice) return hooked // paused on an Alligator stack-target pick
    return { ...runStandardRefill(hooked), actionsRemaining: 0 }
  })

  // Paused mid-hooks — the turn does NOT pass; this seat still owes a choice.
  if (afterHooks.players[index].pendingPostMarketChoice) return afterHooks

  const nextIndex = (index + 1) % afterHooks.turnOrder.length
  const wrapped = nextIndex === afterHooks.firstPlayerIndex
  if (!wrapped) return { ...afterHooks, activePlayerIndex: nextIndex }

  return closeMarketPhase(afterHooks)
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
