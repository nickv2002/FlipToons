// The multiplayer action surface — the single entry point the server hands
// client messages to.
//
// This is a SEPARATE module from actions.ts rather than a widening of it, and
// deliberately so. actions.ts is the solo reducer, and three of the things it
// does are solo house rules that would be outright wrong at 2+ seats:
//
//   checkInstantWin           ends the game the moment fame hits the
//                             threshold, overriding the rulebook's "the
//                             trigger round still plays its full Market
//                             phase" timing (§3.2). Multiplayer LATCHES the
//                             trigger at Cleanup and plays on to the Final
//                             Flip. Reusing it here was flagged in the plan
//                             as the single highest-risk copy-paste in this
//                             work — so it isn't imported.
//   isGuaranteedLoss family   a UX shortcut that skips a Market phase whose
//                             outcome is already decided. A guaranteed loss
//                             for ONE player is not a guaranteed anything for
//                             a match, and the other seats still have real
//                             decisions to make.
//   the flip cascade          actions.ts drives flip -> checkFame ->
//                             postFameHooks -> market atomically so the solo
//                             UI always lands on 'market'. That cannot work
//                             when a phase can pause on ANOTHER player's
//                             pending choice.
//
// Keeping them in actions.ts, unimported, is what stops them leaking in.

import type { EffectChoices } from './cards/types'
import { formatBreakdown } from './score'
import type { DismissTarget, HireFromDismissedTarget } from './hireChoices'
import { applyMarketReset, canUseGridResetNow, canUseMarketReset, marketResetReturnedCards } from './bigButton'
import {
  activePlayerId,
  endMarketTurn,
  matchApplyGridReset,
  matchBigButtonDecision,
  matchDismiss,
  matchHire,
  matchResolveDeckPlacement,
  matchResolvePostFameChoice,
  matchResolvePendingOnHireChoice,
  matchResolvePostMarketChoice,
  playerIndex,
  runMatchCheckFame,
  runMatchCleanup,
  runMatchFlip,
  runMatchPostFameHooks,
  resumeMatchFinalFlip,
  startMatchFinalFlip,
} from './match'
import type { FinalFlipOutcome } from './match'
import type { DeckPlacementTarget } from './match'
import { getSlot, posLabel } from './grid'
import { hireCost } from './market'
import { dismissCostFor, hasAnyLegalMarketAction, unencodableNote } from './phases'
import { cardsById } from './setup'
import type { EngineLogLine, Match, PlayerId } from './state'
import { commitView, viewOf } from './state'
import type { GridPos } from './types'

const cards = cardsById()

// Wire shape for resolvePendingOnHireChoice's selection — a JSON-serializable
// union covering every hireChoices.ts PendingChoice option shape this can
// reach today (DismissTarget for dismissChosenGridCard, HireFromDismissedTarget
// for hireFromDismissed) plus 'skip'. Extend this union, not a generic `any`,
// if a future card drags a market-slot-choice kind into pendingOnHireCardIds.
export type OnHireSelection = DismissTarget | HireFromDismissedTarget | number | number[] | 'skip'

export type MatchAction =
  // Shared, NOT turn-gated: §6's MVP pacing, chosen by the user — all seats'
  // reveals advance together off one control. Any seat may press it.
  | { kind: 'advanceFlip' }
  // Per-player, NOT turn-gated: postFameHooks is a simultaneous phase, so a
  // seat holding a Skunk prompt answers it whenever they like. Nobody is
  // waiting for a turn to come round.
  | { kind: 'resolvePostFameChoice'; pos: GridPos; index: number }
  // Per-player, NOT turn-gated, same reasoning as resolvePostFameChoice above
  // — a Snake-deferred onHire choice (Panther's mandatory
  // dismissChosenGridCard, Raccoon's optional hireFromDismissed, or any
  // other choice-needing onHire kind). `selection` mirrors
  // hireChoices.ts's PendingChoice option shapes (the client selects one
  // entry verbatim from PendingOnHireChoice.choice.options and forwards it
  // here) plus 'skip', which only a non-mandatory choice may use.
  | { kind: 'resolvePendingOnHireChoice'; selection: OnHireSelection }
  // Turn-gated (§3.0: first player, then clockwise).
  | { kind: 'hire'; slotIndex: number; choices?: EffectChoices }
  | { kind: 'dismiss'; pos: GridPos; index: number; choices?: EffectChoices }
  | { kind: 'resolvePostMarketChoice'; pos: GridPos; index: number }
  | { kind: 'endTurn' }
  // Pig's destination deck. Turn-gated: it can only ever arise from the
  // acting player's own hire or dismiss.
  | { kind: 'resolveDeckPlacement'; target: DeckPlacementTarget }
  // Big Button. Turn-gated, dispatches on the table's resetEffect
  // (match.ts's PlayerView.resetEffect) since only one reset is ever in
  // play: RESET: MARKET is usable before, during or after any Market
  // action and never ends the turn; RESET: GRID is legal only at the start
  // of your own Market turn, before you've acted, and — like RESET:
  // MARKET — does not end the turn either. Costs no fame and no action
  // either way.
  | { kind: 'useBigButton' }
  // Big Button, RESET: GRID — the Final Flip's decision ONLY. Turn-gated on
  // the 'gridReset' phase's own clockwise walk, which the Final Flip alone
  // still opens (it has no Market phase to hang an in-round decision off).
  | { kind: 'bigButtonDecision'; use: boolean }

// A log line that knows WHO did it. The solo log was a bare string[] because
// there was only ever one actor; at N seats "Hired Elephant for 7 fame" is
// unreadable without a name attached.
//
// `round` is stamped at WRITE time, which fixes a real bug in the old
// protocol: the previous remote client tagged every historical line with the
// room's CURRENT round when a client joined, so a joiner's whole game history
// collapsed into one "Round N" bucket.
export type LogLine = EngineLogLine & { round: number }

export type MatchApplyResult = { match: Match; logLines: LogLine[]; debugLines: string[] }

// Thrown for anything the ACTING PLAYER did wrong — acting out of turn,
// answering a prompt they don't hold. Distinct from an engine bug so the
// server can show the first to the player and shout about the second.
export class IllegalActionError extends Error {}

export function isPlayersTurn(match: Match, playerId: PlayerId): boolean {
  return match.shared.phase === 'market' && activePlayerId(match) === playerId
}

function assertTurn(match: Match, playerId: PlayerId, what: string): void {
  if (match.shared.phase !== 'market') {
    throw new IllegalActionError(`You can only ${what} during the Market phase.`)
  }
  if (activePlayerId(match) !== playerId) {
    throw new IllegalActionError(`It isn't your turn — waiting on ${activePlayerId(match)}.`)
  }
}

// A Pig that has been detached from its zone but not yet given a destination
// is in NO zone at all — not a deck, not a grid, not the dismissed pile. The
// prompt is turn-gated, so if the turn closes the seat can never be asked
// again and the card is stranded outside the game permanently.
// afterMarketAction already declines to AUTO-close the turn for this reason;
// this covers the paths a player drives explicitly.
function assertNoPendingDeckPlacement(match: Match, playerId: PlayerId, what: string): void {
  const pending = match.players[playerIndex(match, playerId)].pendingDeckPlacement
  if (!pending) return
  throw new IllegalActionError(`Place ${cards[pending.cardId].name} in a deck before ${what}.`)
}

// Lifts a batch of engine-generated lines into the match log via `say`,
// preserving whatever attribution the engine already worked out (a card
// owner, or null for a genuinely table-wide event like market decay) —
// never overwriting it.
function forward(lines: EngineLogLine[], say: (text: string, who?: PlayerId | null) => void): void {
  for (const l of lines) say(l.text, l.playerId)
}

// endMarketTurn can, on the last seat's turn, run the 1-2 player market
// decay — every caller that closes a turn needs to both make the call and
// surface whatever it discarded, so that pairing lives here once rather
// than at each of the three call sites (an explicit endTurn, the
// auto-end in afterMarketAction, and the broke-seat skip loop in
// afterTurnBoundary).
function endTurnWithDecayLog(match: Match, playerId: PlayerId, say: (text: string, who?: PlayerId | null) => void): Match {
  const decayLines: EngineLogLine[] = []
  const next = endMarketTurn(match, playerId, decayLines)
  forward(decayLines, say)
  return next
}

// Applies one action on behalf of ONE player.
//
// SECURITY: `playerId` must be derived from the connection's assigned seat,
// never from a field in the client's message. A client-asserted id here would
// let anyone act as anyone.
export function applyMatchAction(match: Match, playerId: PlayerId, action: MatchAction): MatchApplyResult {
  const logLines: LogLine[] = []
  const debugLines: string[] = []
  const round = match.shared.round
  const say = (text: string, who: PlayerId | null = playerId) => logLines.push({ playerId: who, round, text })

  // Validates the seat exists before anything else, so a bogus id fails
  // uniformly rather than deep inside a phase transform.
  playerIndex(match, playerId)

  switch (action.kind) {
    case 'advanceFlip':
      return advanceFlip(match, logLines, debugLines, say)

    case 'resolvePostFameChoice': {
      const pending = match.players[playerIndex(match, playerId)].pendingPostFameChoice
      if (!pending) throw new IllegalActionError('You have no pending choice to answer.')
      const card = cards[pending.ownerCardId]
      const target = cards[pending.options.find((o) => o.pos === action.pos && o.index === action.index)?.cardId ?? '']
      let next: Match
      try {
        next = matchResolvePostFameChoice(match, playerId, { pos: action.pos, index: action.index })
      } catch (err) {
        // Same split as hire/dismiss: an illegal option is the player's
        // mistake, not a phase-machine bug.
        throw new IllegalActionError(err instanceof Error ? err.message : String(err))
      }
      say(`${card.name}: dismissed ${target?.name ?? 'a card'}.`)
      return { match: next, logLines, debugLines }
    }

    case 'resolvePendingOnHireChoice': {
      const pending = match.players[playerIndex(match, playerId)].pendingOnHireChoice
      if (!pending) throw new IllegalActionError('You have no pending choice to answer.')
      const card = cards[pending.cardId]
      let next: Match
      try {
        next = matchResolvePendingOnHireChoice(match, playerId, action.selection)
      } catch (err) {
        // Same split as resolvePostFameChoice: an illegal/mandatory-skip
        // selection is the player's mistake, not a phase-machine bug.
        throw new IllegalActionError(err instanceof Error ? err.message : String(err))
      }
      if (action.selection === 'skip') {
        say(`${card.name}: declined.`)
      } else {
        say(`${card.name}: resolved its When-Hired ability.`)
      }
      return { match: next, logLines, debugLines }
    }

    case 'hire': {
      assertTurn(match, playerId, 'hire')
      assertNoPendingDeckPlacement(match, playerId, 'taking another action')
      const cardId = match.shared.market.slots[action.slotIndex]
      const price =
        action.slotIndex >= 0 && action.slotIndex < match.shared.market.prices.length
          ? hireCost(match.shared.market, action.slotIndex)
          : undefined
      let next: Match
      try {
        next = matchHire(match, playerId, action.slotIndex, action.choices)
      } catch (err) {
        // Rejections a player can cause (not enough fame, no legal slot) come
        // back as a log line, matching actions.ts's isEngineBug split.
        throw new IllegalActionError(err instanceof Error ? err.message : String(err))
      }
      const card = cardId ? cards[cardId] : undefined
      say(`hired ${card?.name ?? 'a card'} for ${price} fame.`)
      if (card?.unencodable) say(unencodableNote(card))
      return afterMarketAction(next, playerId, logLines, debugLines, say)
    }

    case 'dismiss': {
      assertTurn(match, playerId, 'dismiss')
      assertNoPendingDeckPlacement(match, playerId, 'taking another action')
      const view = viewOf(match, playerIndex(match, playerId))
      const slot = getSlot(view.grid, action.pos)
      const cardId = slot?.cards[action.index]
      const cost = dismissCostFor(view.grid, action.pos, action.index, cards)
      let next: Match
      try {
        next = matchDismiss(match, playerId, action.pos, action.index, action.choices)
      } catch (err) {
        throw new IllegalActionError(err instanceof Error ? err.message : String(err))
      }
      const card = cardId ? cards[cardId] : undefined
      say(`dismissed ${card?.name ?? cardId} at ${posLabel(action.pos)} for ${cost} fame.`)
      if (card?.unencodable) say(unencodableNote(card))
      return afterMarketAction(next, playerId, logLines, debugLines, say)
    }

    case 'resolvePostMarketChoice': {
      assertTurn(match, playerId, 'answer that')
      const decayLines: EngineLogLine[] = []
      const next = matchResolvePostMarketChoice(match, playerId, { pos: action.pos, index: action.index }, decayLines)
      say('resolved a post-Market ability.')
      forward(decayLines, say)
      return afterTurnBoundary(next, logLines, debugLines)
    }

    case 'resolveDeckPlacement': {
      assertTurn(match, playerId, 'place that card')
      const pending = match.players[playerIndex(match, playerId)].pendingDeckPlacement
      if (!pending) throw new IllegalActionError('You have no card waiting for a deck.')
      const next = matchResolveDeckPlacement(match, playerId, action.target)
      const name = cards[pending.cardId].name
      say(
        action.target.kind === 'toonDeck'
          ? `put ${name} back into the toon deck (reshuffled).`
          : `put ${name} into ${action.target.playerId}'s deck.`,
      )
      // The placement may have been the last thing standing between this seat
      // and the end of its turn.
      return afterMarketAction(next, playerId, logLines, debugLines, say)
    }

    case 'useBigButton': {
      assertTurn(match, playerId, 'use your Big Button')
      assertNoPendingDeckPlacement(match, playerId, 'taking another action')
      const index = playerIndex(match, playerId)
      const view = viewOf(match, index)

      if (view.resetEffect === null) {
        throw new IllegalActionError('The Big Button mini-expansion is not in play.')
      }

      if (view.resetEffect === 'market') {
        // RESET: MARKET — "shuffle all toon cards in the market back into
        // the toon deck. Then refill the market." Free: no fame, no action,
        // and usable before, during or after any Market action (a
        // deliberate departure from the printed card's "before taking any
        // market actions" — see bigButton.ts's canUseMarketReset).
        if (!canUseMarketReset(view)) {
          throw new IllegalActionError('Your Big Button card is already face down — it has been used.')
        }
        const returned = marketResetReturnedCards(view)
        const next = commitView(match, index, applyMarketReset(view))
        say(`used the Big Button: shuffled ${returned.length} market card(s) back into the toon deck and refilled.`)
        // The refill can leave the market short, which is an ordinary
        // (latched) depletion trigger — and the reset may equally have been
        // the last legal thing this seat could do, so run the usual tail.
        return afterMarketAction(next, playerId, logLines, debugLines, say)
      }

      // RESET: GRID — "before taking any market actions" is still honored
      // here (unlike RESET: MARKET), which is exactly what
      // actedThisMarketPhase now exists for. Three distinguishable reasons,
      // since "you already used it" and "you already bought something"
      // suggest completely different next moves.
      if (!canUseGridResetNow(view)) {
        if (!view.bigButtonFaceUp) throw new IllegalActionError('Your Big Button card is already face down — it has been used.')
        throw new IllegalActionError('The Big Button must be used before you take any Market actions this turn.')
      }
      const flipNotes: EngineLogLine[] = []
      const next = matchApplyGridReset(match, playerId, flipNotes, debugLines)
      forward(flipNotes, say)
      const scored = next.players[index].lastCheckFame
      if (scored) say(formatBreakdown(scored))
      // Deliberately does NOT end the turn — RESET: GRID costs no action,
      // and matchApplyGridReset leaves phase/activePlayerIndex/
      // actionsRemaining/actedThisMarketPhase untouched, so the acting seat
      // can go on to hire or dismiss against their new grid immediately.
      return { match: next, logLines, debugLines }
    }

    case 'bigButtonDecision': {
      // RESET: GRID, Final Flip only — "each player in clockwise order
      // decides if they want to use their face-up Big Button card." A normal
      // round's decision moved onto the resetting seat's own Market turn
      // (the 'useBigButton' case above) and no longer opens 'gridReset' at
      // all, so this walk and this action kind now exist solely for the
      // Final Flip, which has no Market phase to hang an in-round decision
      // off. Its own phase and its own walk, so assertTurn (which is
      // Market-phase-specific) is wrong here.
      if (match.shared.phase !== 'gridReset') {
        throw new IllegalActionError('There is no Big Button decision to make right now.')
      }
      if (activePlayerId(match) !== playerId) {
        throw new IllegalActionError(`It isn't your decision yet — waiting on ${activePlayerId(match)}.`)
      }
      let next: Match
      try {
        next = matchBigButtonDecision(match, playerId, action.use)
      } catch (err) {
        throw new IllegalActionError(err instanceof Error ? err.message : String(err))
      }
      say(action.use ? 'used their Big Button — collecting their grid and flipping again.' : 'kept their Big Button.')

      // Still collecting decisions from the seats after this one.
      if (next.shared.phase === 'gridReset') return { match: next, logLines, debugLines }

      // GridResetState['context'] is narrowed to the literal 'finalFlip', so
      // every decision that gets here is unconditionally a Final Flip one —
      // the paused endgame can now finish.
      const outcome = resumeMatchFinalFlip(next, [], debugLines)
      sayFinalFlipOutcome(outcome, say)
      return { match: outcome.match, logLines, debugLines }
    }

    case 'endTurn': {
      assertTurn(match, playerId, 'end your turn')
      assertNoPendingDeckPlacement(match, playerId, 'ending your turn')
      say('ended their turn.')
      const next = endTurnWithDecayLog(match, playerId, say)
      return afterTurnBoundary(next, logLines, debugLines)
    }

    // Actions arrive over a socket as parsed JSON, so the TS union above is a
    // claim about well-behaved clients, not a runtime guarantee — an older
    // client or a fuzzer can name any kind. Without this the switch fell
    // through, the function returned undefined, and destructuring it threw a
    // TypeError the server then logged as an engine bug. It is a player
    // mistake, so it is reported as one.
    default:
      throw new IllegalActionError(`Unknown action "${(action as { kind?: unknown }).kind}".`)
  }
}

// Runs the shared reveal. In a normal round this is Flip -> Check Fame ->
// post-fame hooks, stopping wherever a player choice is owed; in the endgame
// it is the whole Final Flip, which resolves the match outright.
function advanceFlip(
  match: Match,
  logLines: LogLine[],
  debugLines: string[],
  say: (text: string, who?: PlayerId | null) => void,
): MatchApplyResult {
  if (match.shared.phase === 'finalFlip') {
    const flipNotes: EngineLogLine[] = []
    // Under RESET: GRID the Final Flip pauses after Check Fame for the table's
    // Big Button decision; `outcome` is null in exactly that case and the
    // 'bigButtonDecision' handler above finishes it.
    const started = startMatchFinalFlip(match, flipNotes, debugLines)
    forward(flipNotes, say)
    if (!started.outcome) return { match: started.match, logLines, debugLines }
    sayFinalFlipOutcome(started.outcome, say)
    return { match: started.outcome.match, logLines, debugLines }
  }

  if (match.shared.phase !== 'flip') {
    throw new IllegalActionError(`Nothing to reveal right now (phase: ${match.shared.phase}).`)
  }

  const flipNotes: EngineLogLine[] = []
  let next = runMatchFlip(match, flipNotes, debugLines)
  forward(flipNotes, say)

  next = runMatchCheckFame(next)
  for (const p of next.players) {
    if (p.lastCheckFame) say(formatBreakdown(p.lastCheckFame), p.playerId)
  }

  // NOT unconditional any more: runMatchCheckFame can hand back a 'gridReset'
  // phase (the Big Button's RESET: GRID decision), and runMatchPostFameHooks
  // asserts its own phase. The post-fame hooks still run — matchBigButtonDecision
  // runs them once the decisions are in.
  if (next.shared.phase === 'postFameHooks') next = runMatchPostFameHooks(next)
  return { match: next, logLines, debugLines }
}

// The Final Flip's result lines. Shared because the Final Flip now has two
// exits — straight through advanceFlip, or resumed after a Big Button
// decision — and they must report identically.
function sayFinalFlipOutcome(outcome: FinalFlipOutcome, say: (text: string, who?: PlayerId | null) => void): void {
  for (const s of outcome.scores) {
    const bonus = s.modifiers.map((m) => ` (+${m.amount} ${m.label})`).join('')
    say(`Final Flip: ${s.total} fame${bonus}.`, s.playerId)
  }
  if (outcome.tiebreakRounds > 0) {
    say(`Tied — ${outcome.tiebreakRounds} tiebreak re-flip${outcome.tiebreakRounds === 1 ? '' : 's'}.`, null)
  }
  say(outcome.winners.length === 1 ? `${outcome.winners[0]} wins!` : `A shared win: ${outcome.winners.join(' and ')}.`, null)
}

// After a hire/dismiss: match.ts closes a seat's turn on its own once their
// actions run out, which may in turn wrap the turn order and close the phase.
// A seat can also be left with actions but no fame to spend any of them on
// (every market slot and every dismissible grid card costs more than they
// have) — nothing left to decide, so this auto-ends the turn the same way
// solo's hasAnyLegalMarketAction drives useGame.ts's auto-end (see phases.ts;
// GameState and PlayerView are the same shape, so the one predicate serves
// both without matchActions.ts importing actions.ts — see this file's header).
function afterMarketAction(
  match: Match,
  playerId: PlayerId,
  logLines: LogLine[],
  debugLines: string[],
  say: (text: string, who?: PlayerId | null) => void,
): MatchApplyResult {
  const index = playerIndex(match, playerId)
  const me = match.players[index]
  // A Pig still owing a destination deck holds the turn open — ending it here
  // would strand the card outside every zone in the game.
  if (me.pendingDeckPlacement) return { match, logLines, debugLines }
  if (
    match.shared.phase === 'market' &&
    !me.pendingPostMarketChoice &&
    activePlayerId(match) === playerId &&
    !hasAnyLegalMarketAction(viewOf(match, index))
  ) {
    // hasAnyLegalMarketAction already covers actionsRemaining <= 0 — its two
    // zero-cost early-trues (canUseMarketReset, canUseGridResetNow) sit
    // BEFORE its own actionsRemaining gate (phases.ts), so a seat with a live
    // button is kept open here even at 0 actions, and a seat with neither
    // button and no actions left correctly falls through to false. The
    // separate `actionsRemaining <= 0` disjunct this used to carry is gone —
    // it would have ended the turn out from under an unspent button.
    say(me.actionsRemaining <= 0 ? 'has no actions left — ending their turn.' : 'can no longer afford any Market action — ending their turn.')
    return afterTurnBoundary(endTurnWithDecayLog(match, playerId, say), logLines, debugLines)
  }
  return { match, logLines, debugLines }
}

// Runs Cleanup automatically once the Market phase closes, and — before that
// — skips any seat a turn boundary hands play to that already has no legal
// Market action at the START of its turn (fame too low for every market slot
// and every dismissible grid card, before it has acted at all). Loops: with
// several seats all out of fame, each skip is itself a turn boundary that can
// hand off to another seat in the same shape.
function afterTurnBoundary(match: Match, logLines: LogLine[], debugLines: string[]): MatchApplyResult {
  let current = match
  while (current.shared.phase === 'market') {
    const playerId = activePlayerId(current)
    const index = playerIndex(current, playerId)
    if (current.players[index].pendingPostMarketChoice || hasAnyLegalMarketAction(viewOf(current, index))) break
    logLines.push({ playerId, round: current.shared.round, text: 'can no longer afford any Market action — ending their turn.' })
    const round = current.shared.round
    current = endTurnWithDecayLog(current, playerId, (text, who = null) => logLines.push({ playerId: who, round, text }))
  }
  match = current

  if (match.shared.phase !== 'cleanup') return { match, logLines, debugLines }
  const round = match.shared.round
  // Turn order for the round that's ending — firstPlayerIndex only rotates
  // to the NEXT round's first player inside runMatchCleanup itself
  // (match.ts), so it still names this round's first player here.
  const order = [...match.turnOrder.slice(match.firstPlayerIndex), ...match.turnOrder.slice(0, match.firstPlayerIndex)]
  const roundFame = order.map((playerId) => ({
    playerId,
    fame: match.players.find((p) => p.playerId === playerId)!.fameGeneratedThisRound,
  }))
  const next = runMatchCleanup(match)
  logLines.push({ playerId: null, round, text: `Round ${round} complete.`, roundFame })
  if (next.shared.criticsChoiceHolder && !match.shared.criticsChoiceHolder) {
    logLines.push({ playerId: next.shared.criticsChoiceHolder, round, text: "takes the Critic's Choice card." })
  }
  if (next.shared.endgameTriggered && !match.shared.endgameTriggered) {
    logLines.push({ playerId: null, round, text: 'The endgame is triggered — one Final Flip decides it.' })
  }
  return { match: next, logLines, debugLines }
}
