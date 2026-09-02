// AiAdapter<Match, MatchAction> over matchActions.ts's applyMatchAction —
// the ONLY multiplayer reducer this touches, on purpose (matchActions.ts's
// own header: actions.ts's house rules — instant-win, guaranteed-loss
// shortcuts, the atomic flip cascade — are wrong at a table, so this module
// must not import actions.ts either).
//
// A single MatchAction only ever answers ONE seat's decision, but a search
// needs the WHOLE match to reach a terminal state, which means someone has
// to move every OTHER seat too. This adapter's `apply` does that itself:
// after applying the bot's chosen action, it fast-forwards through every
// phase/decision that isn't the bot's own — shared advances (`advanceFlip`,
// legal from any seat), simultaneous per-seat prompts belonging to
// opponents, and opponents' entire Market turns — using the same
// deterministic "always available first option" policy
// matchActions.test.ts's autoplayMatch fixture uses. Modeling opponents
// adversarially is out of scope for this chunk; this makes the search a
// solitaire problem again ("given the table plays this simple policy, what
// should I do") without pretending the other seats are inert.
import { canUseGridResetNow, canUseMarketReset } from '../bigButton'
import type { Card, CardId, Effect, EffectChoices } from '../cards/types'
import type { DismissTarget, HireFromDismissedTarget, PendingChoice } from '../hireChoices'
import { buildEffectChoices, computePendingChoice } from '../hireChoices'
import { activePlayerId, buildNewMatch, deckPlacementTargets, isSolo, matchRoundFame, playerIndex } from '../match'
import type { MatchAction } from '../matchActions'
import { applyMatchAction } from '../matchActions'
import { hireCost } from '../market'
import { hasAnyLegalMarketAction, listDismissEntries } from '../phases'
import { cardsById } from '../setup'
import type { Match, PlayerId, PlayerView } from '../state'
import { viewOf } from '../state'
import type { AiAdapter } from './core'

const cards = cardsById()

// Mirrors soloAdapter.ts's choicesForEffects/selectionsFor exactly — a
// PlayerView IS a GameState (state.ts: `export type GameState = PlayerView`),
// so hireChoices.ts's computePendingChoice/buildEffectChoices need no
// match-specific variant.
function choicesForEffects(view: PlayerView, effects: Effect[] | undefined, excludeMarketSlot?: number): (EffectChoices | undefined)[] {
  const choice = computePendingChoice(view, effects, cards, excludeMarketSlot)
  if (!choice) return [undefined]
  const selections = selectionsFor(choice)
  const built = selections.map((selection) => buildEffectChoices(choice, selection))
  return choice.mandatory ? built : [undefined, ...built]
}

function selectionsFor(choice: PendingChoice): (DismissTarget | HireFromDismissedTarget | number | number[])[] {
  switch (choice.kind) {
    case 'dismissByName':
    case 'dismissChosenGridCard':
    case 'hireFromDismissed':
      return choice.options
    case 'hireFromMarketAndRefill':
      return choice.options
    case 'discardMarketAndRefill':
      return choice.options.map((slot) => [slot])
    case 'dismissAlligatorTarget':
      // Reached via PlayerView.pendingPostMarketChoice, handled separately
      // below (marketDecisionCandidates), not through a card's own effects.
      return []
  }
}

// Candidates for the bot's own Market turn — hire, dismiss, endTurn, both Big
// Button resets, and whatever pending prompt has already paused this seat's
// turn (a post-Market choice or a Pig deck placement). matchActions.ts's
// assertTurn/assertNoPendingDeckPlacement mean at most one of these prompt
// branches is ever live at once.
function marketDecisionCandidates(match: Match, botSeatId: PlayerId): MatchAction[] {
  const index = playerIndex(match, botSeatId)
  const player = match.players[index]!

  if (player.pendingPostMarketChoice) {
    return player.pendingPostMarketChoice.options.map((o) => ({ kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }) as const)
  }
  if (player.pendingDeckPlacement) {
    return deckPlacementTargets(match).map((target) => ({ kind: 'resolveDeckPlacement', target }) as const)
  }

  const view = viewOf(match, index)
  const candidates: MatchAction[] = [{ kind: 'endTurn' }]
  if (canUseMarketReset(view)) candidates.push({ kind: 'useBigButton' })
  if (canUseGridResetNow(view)) candidates.push({ kind: 'useBigButton' })

  if (view.actionsRemaining <= 0) return candidates

  view.market.slots.forEach((cardId, slotIndex) => {
    if (cardId === null) return
    if (hireCost(view.market, slotIndex) > view.fame) return
    const card: Card = cards[cardId]!
    for (const choices of choicesForEffects(view, card.onHire, slotIndex)) {
      candidates.push({ kind: 'hire', slotIndex, choices })
    }
  })

  for (const entry of listDismissEntries(view)) {
    const card: Card = cards[entry.cardId as CardId]!
    if (card.immune?.includes('dismiss')) continue
    if (entry.cost > view.fame) continue
    for (const choices of choicesForEffects(view, card.onDismiss)) {
      candidates.push({ kind: 'dismiss', pos: entry.pos, index: entry.stackIndex, choices })
    }
  }

  return candidates
}

// Simultaneous, NOT turn-gated prompts (matchActions.ts's own comment on
// MatchAction) — the bot can owe one of these on ANY seat's turn, not just
// its own, so these are checked before whose-turn-is-it at all.
function ownPendingSimultaneousCandidates(match: Match, botSeatId: PlayerId): MatchAction[] | null {
  const index = playerIndex(match, botSeatId)
  const player = match.players[index]!

  if (player.pendingPostFameChoice) {
    return player.pendingPostFameChoice.options.map((o) => ({ kind: 'resolvePostFameChoice', pos: o.pos, index: o.index }) as const)
  }
  if (player.pendingOnHireChoice) {
    const choice = player.pendingOnHireChoice.choice
    const selections = choice.kind === 'discardMarketAndRefill' ? choice.options.map((slot) => [slot]) : choice.options
    const built: MatchAction[] = selections.map((selection) => ({ kind: 'resolvePendingOnHireChoice', selection }))
    return choice.mandatory ? built : [...built, { kind: 'resolvePendingOnHireChoice', selection: 'skip' }]
  }
  return null
}

function legalCandidates(match: Match, botSeatId: PlayerId): MatchAction[] {
  if (match.shared.phase === 'ended') return []

  const own = ownPendingSimultaneousCandidates(match, botSeatId)
  if (own) return own

  // gridReset only exists for the Final Flip walk now (see match.ts/
  // matchActions.ts's own comments) — a real decision only when it's the
  // bot's turn in that walk.
  if (match.shared.phase === 'gridReset') {
    if (activePlayerId(match) !== botSeatId) return []
    return [
      { kind: 'bigButtonDecision', use: true },
      { kind: 'bigButtonDecision', use: false },
    ]
  }

  if (match.shared.phase === 'market' && activePlayerId(match) === botSeatId) {
    return marketDecisionCandidates(match, botSeatId)
  }

  // flip / finalFlip (cascade-only — see this file's header), checkFame /
  // postFameHooks / cleanup (transient: matchActions.ts's advanceFlip drives
  // straight through all three in one call unless a pending choice pauses
  // it, and any such pause is already caught by ownPendingSimultaneousCandidates
  // or the gridReset branch above), and market phases belonging to another
  // seat: nothing for the bot to decide here.
  return []
}

// Deterministic single-option policy for a decision that belongs to someone
// OTHER than the bot — matches matchActions.test.ts's autoplayMatch fixture.
// Adversarial opponent modeling is out of scope for this chunk (see this
// file's header); this exists purely so a rollout can reach a terminal
// state at all.
function firstOptionActionFor(match: Match, playerId: PlayerId): MatchAction {
  const index = playerIndex(match, playerId)
  const player = match.players[index]!

  if (player.pendingPostFameChoice) {
    const o = player.pendingPostFameChoice.options[0]!
    return { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index }
  }
  if (player.pendingOnHireChoice) {
    const choice = player.pendingOnHireChoice.choice
    const first = choice.kind === 'discardMarketAndRefill' ? [choice.options[0]!] : choice.options[0]!
    return { kind: 'resolvePendingOnHireChoice', selection: first as never }
  }
  if (match.shared.phase === 'gridReset') {
    // Decline by default — keeping the button costs nothing, matching
    // matchActions.test.ts's fixture and the strandingSeat fallback's own
    // reasoning (state.ts/match.ts comments: spending a once-per-game
    // resource on a guess is the worse mistake of the two).
    return { kind: 'bigButtonDecision', use: false }
  }
  if (match.shared.phase === 'market') {
    if (player.pendingPostMarketChoice) {
      const o = player.pendingPostMarketChoice.options[0]!
      return { kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }
    }
    if (player.pendingDeckPlacement) {
      return { kind: 'resolveDeckPlacement', target: { kind: 'toonDeck' } }
    }
    return { kind: 'endTurn' }
  }
  return { kind: 'advanceFlip' }
}

const MAX_ADVANCE_STEPS = 2000

// Fast-forwards past every decision that ISN'T the bot's own, in place —
// shared advances, opponents' simultaneous prompts, and opponents' whole
// Market turns — until the match is terminal or it's genuinely the bot's
// turn to decide something. Exported so callers (index.ts's
// chooseBestMatchAction/evaluateMatchAction) can hand this adapter a match
// state mid-opponent-turn, not just one already sitting at a bot decision.
export function advanceToBotDecision(match: Match, botSeatId: PlayerId): Match {
  let m = match
  for (let steps = 0; steps < MAX_ADVANCE_STEPS; steps++) {
    if (m.shared.phase === 'ended') return m
    if (legalCandidates(m, botSeatId).length > 0) return m

    if (m.shared.phase === 'flip' || m.shared.phase === 'finalFlip') {
      m = applyMatchAction(m, botSeatId, { kind: 'advanceFlip' }).match
      continue
    }

    const own = ownPendingSimultaneousCandidates(m, botSeatId)
    if (own) return m // unreachable (legalCandidates already covers this), kept defensive

    // Simultaneous prompts (Skunk's pendingPostFameChoice, a Snake-stacked
    // pendingOnHireChoice) are NOT turn-gated and can belong to ANY seat,
    // independent of `phase`/activePlayerIndex — postFameHooks in
    // particular pauses on exactly these with no active-player concept at
    // all, so this has to be checked before the phase-specific branches
    // below, not folded into the market/gridReset cases.
    const owingOpponent = m.players.find((p) => p.pendingPostFameChoice || p.pendingOnHireChoice)
    if (owingOpponent) {
      m = applyMatchAction(m, owingOpponent.playerId, firstOptionActionFor(m, owingOpponent.playerId)).match
      continue
    }

    if (m.shared.phase === 'gridReset') {
      const decider = activePlayerId(m)
      m = applyMatchAction(m, decider, firstOptionActionFor(m, decider)).match
      continue
    }

    if (m.shared.phase === 'market') {
      const active = activePlayerId(m)
      if (active === botSeatId) return m // unreachable (legalCandidates already covers this), kept defensive
      m = applyMatchAction(m, active, firstOptionActionFor(m, active)).match
      continue
    }

    // checkFame / postFameHooks / cleanup are transient — matchActions.ts's
    // advanceFlip drives straight through them — so reaching one here with
    // no legal candidate and no known way forward is a phase-machine bug,
    // not a state this search should silently loop on.
    throw new Error(`ai/matchAdapter.ts: advanceToBotDecision — stuck in phase '${m.shared.phase}' with no way forward`)
  }
  throw new Error('ai/matchAdapter.ts: advanceToBotDecision — exceeded MAX_ADVANCE_STEPS, likely a phase-machine bug')
}

// Bot's fame minus the BEST opponent's fame, off match.ts's own per-seat
// fame reading (matchRoundFame — the same one the Final Flip itself uses to
// pick winnerId), never a bespoke recomputation.
function fameLead(match: Match, botSeatId: PlayerId): number {
  const fames = matchRoundFame(match)
  const bot = fames.find((f) => f.playerId === botSeatId)!.fame.total
  const bestOpponent = Math.max(0, ...fames.filter((f) => f.playerId !== botSeatId).map((f) => f.fame.total))
  return bot - bestOpponent
}

// Relative-standing reward — multiplayer has no fame THRESHOLD to clear
// (CLAUDE.md: "no cumulative score anywhere... don't invent one"), so
// soloAdapter.ts's win/loss-against-a-threshold reward has no equivalent
// here. What decides a match is standing relative to the other seats at the
// Final Flip, so that's what this measures too.
//
// Terminal: 1 for an outright win (`winnerId === botSeatId`), 0 for an
// outright loss, 0.5 for a genuinely shared win (`winnerId === null` — the
// tiebreak exhausted MAX_TIEBREAK_ROUNDS — AND the bot is among the tied
// leaders; see match.ts's own comment on why `winnerId` is the field to
// trust over a fame comparison). A shared win is worse than sole credit but
// clearly better than losing outright, so it sits at the midpoint rather
// than collapsing to either end.
//
// Non-terminal (maxStepsPerPlayout cut a playout off before 'ended'): partial
// credit from the CURRENT fame lead, normalized against fameToTriggerEndgame
// and clamped well below the terminal win value — same reasoning as
// soloAdapter.ts's frozen-progress fallback, and the same bug class it warns
// about. soloAdapter.ts hit a real bug here (seed 102, easy/season 1): a
// reward that read the LIVE grid made repeatedly dismissing the bot's own
// grid look like a winning move to the search, because several fame bonuses
// read the dismissed pile, and the rollout looped dismissing forever instead
// of ever reaching 'ended'. The equivalent trap here would be a reward that
// keeps climbing across NON-terminal steps that don't actually end the
// match (e.g. rewarding `endTurn` churn, or a reward that grows every time
// the bot passes through its own Market turn without the match progressing)
// — `fameLead` only reads scored totals (matchRoundFame, which composes
// scoreGrid + the Critic's Choice off each seat's already-frozen Check Fame
// result), never anything that changes turn-to-turn without a real Check
// Fame happening, and the [0, 0.5) clamp below means no amount of
// non-terminal fame lead can ever outscore an actual win.
export function matchReward(match: Match, botSeatId: PlayerId): number {
  if (match.shared.phase === 'ended') {
    if (match.shared.winnerId === botSeatId) return 1
    if (match.shared.winnerId !== null) return 0
    const fames = matchRoundFame(match)
    const top = Math.max(...fames.map((f) => f.fame.total))
    const botTotal = fames.find((f) => f.playerId === botSeatId)!.fame.total
    return botTotal === top ? 0.5 : 0
  }
  const lead = fameLead(match, botSeatId)
  const normalized = lead / Math.max(1, match.shared.fameToTriggerEndgame)
  return Math.max(0, Math.min(0.49, 0.25 + normalized * 0.25))
}

export function buildMatchAdapter(botSeatId: PlayerId): AiAdapter<Match, MatchAction> {
  return {
    legalCandidates(match) {
      return legalCandidates(match, botSeatId)
    },
    apply(match, action) {
      const applied = applyMatchAction(match, botSeatId, action).match
      return advanceToBotDecision(applied, botSeatId)
    },
    isTerminal(match) {
      return match.shared.phase === 'ended'
    },
    reward(match) {
      return matchReward(match, botSeatId)
    },
    clone(match) {
      return structuredClone(match)
    },
    // No heuristicScore hook yet — solo's scoreState (heuristic.ts) reads a
    // single GameState's grid/market; a match-shaped equivalent (reading the
    // bot's own view relative to the table) is a reasonable follow-up but
    // not required for this chunk, and core.ts's rolloutStep already
    // degrades cleanly (uniform-random) when a hook is absent.
  }
}

// Convenience re-exports mirroring soloAdapter.ts's own pattern, so a caller
// driving the match AI doesn't need to import match.ts separately just for
// match construction/turn-gating helpers.
export { buildNewMatch, isSolo, hasAnyLegalMarketAction }
