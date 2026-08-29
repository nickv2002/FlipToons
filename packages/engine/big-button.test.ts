// The Big Button mini-expansion (Referance/IMG_4308.HEIC).
//
// A per-player component with two possible reset effects, exactly one of which
// is chosen at setup and shared by the whole table:
//
//   RESET: MARKET  "During the Market phase, a player may flip their face-up
//                   Big Button card face down to shuffle all toon cards in the
//                   market back into the toon deck. Then refill the market.
//                   This action must be taken on a player's turn before taking
//                   any market actions."
//   RESET: GRID    "After the Check Fame phase, starting with the first
//                   player, each player in clockwise order decides if they
//                   want to use their face-up Big Button card. All players who
//                   want to use their card simultaneously flip their Big
//                   Button card face down, collect the cards in their grid,
//                   add them to their deck, shuffle, and complete the Flip
//                   phase again. All players then repeat the Check Fame phase."
//
// The load-bearing property this file exists to pin is NEGATIVE: with no reset
// effect chosen (the default) NOTHING here is reachable and nothing behaves
// differently, which is why the other 393 engine tests needed no edits.

import { describe, expect, test } from 'bun:test'
import { applyGridResetCollect, applyMarketReset, canUseGridReset, canUseGridResetNow, canUseMarketReset } from './bigButton'
import { applyAction, buildNewGameState } from './actions'
import { playAutomatically } from './ai'
import { emptyGrid, occupiedSlots } from './grid'
import {
  buildNewMatch,
  gridResetDecider,
  matchBigButtonDecision,
  playerIndex,
  runMatchCheckFame,
  runMatchCleanup,
  runMatchFinalFlip,
  runMatchFlip,
  runMatchPostFameHooks,
  resumeMatchFinalFlip,
  startMatchFinalFlip,
  strictlyLowestScorerIndex,
} from './match'
import { applyMatchAction, IllegalActionError } from './matchActions'
import { hasAnyLegalMarketAction } from './phases'
import { scoreGrid } from './score'
import {
  BIG_BUTTON_CARDS,
  buildMultiplayerToonDeckUnshuffled,
  buildSoloSetup,
  buildSoloToonDeckUnshuffled,
  cardsById,
  SOLO_BIG_BUTTON_EXTRA_TRIM,
} from './setup'
import { commitView, viewOf } from './state'
import type { CardId } from './cards/types'
import type { Match, PlayerView } from './state'

const cards = cardsById()

// ---------------------------------------------------------------------------
// Off by default — the property that makes this a safe addition
// ---------------------------------------------------------------------------

describe('with no reset effect chosen, nothing changes', () => {
  test('buildNewMatch and buildNewGameState default to resetEffect null', () => {
    expect(buildNewMatch(7, 2).shared.resetEffect).toBeNull()
    expect(buildNewGameState(7, 'normal', 1).resetEffect).toBeNull()
  })

  test("both seasons' Big Button cards stay out of every toon deck", () => {
    for (const season of [1, 2] as const) {
      for (const id of BIG_BUTTON_CARDS[season]) {
        expect(buildMultiplayerToonDeckUnshuffled(season)).not.toContain(id)
        expect(buildSoloToonDeckUnshuffled(season)).not.toContain(id)
      }
    }
  })

  test('neither reset is available to any seat, in any phase', () => {
    const match = buildNewMatch(7, 3, 1, { fameToTriggerEndgame: 999 })
    for (let i = 0; i < match.players.length; i++) {
      const view = viewOf(match, i)
      expect(canUseGridReset(view)).toBe(false)
      expect(canUseGridResetNow({ ...view, phase: 'market' })).toBe(false)
      expect(canUseMarketReset({ ...view, phase: 'market' })).toBe(false)
    }
  })

  test("Check Fame goes straight to post-fame hooks — the 'gridReset' phase is unreachable", () => {
    const match = runMatchCheckFame(runMatchFlip(buildNewMatch(7, 2, 1, { fameToTriggerEndgame: 999 })))
    expect(match.shared.phase).toBe('postFameHooks')
    expect(match.shared.gridReset).toBeNull()
  })

  test('the Final Flip still resolves synchronously through the old entry point', () => {
    const base = buildNewMatch(31, 3, 1, { fameToTriggerEndgame: 999 })
    const atFinal: Match = { ...base, shared: { ...base.shared, phase: 'finalFlip', endgameTriggered: true } }
    const outcome = runMatchFinalFlip(atFinal)
    expect(outcome.match.shared.phase).toBe('ended')
    expect(outcome.winners.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('setup deals the Big Button card only when the expansion is on', () => {
  test('the season-specific card comes back into the toon deck', () => {
    // Season 1's half is INFERRED (only the Season 2 setup card is
    // photographed) — see BIG_BUTTON_CARDS. This pins the pairing so a future
    // source contradicting it fails loudly here.
    expect(BIG_BUTTON_CARDS[1]).toEqual(['axolotl'])
    expect(BIG_BUTTON_CARDS[2]).toEqual(['platypus'])

    expect(buildMultiplayerToonDeckUnshuffled(1, true)).toContain('axolotl')
    expect(buildMultiplayerToonDeckUnshuffled(2, true)).toContain('platypus')
    // ...and only that card: the other season's stays out, and so does
    // anything else that was excluded for its own reasons.
    expect(buildMultiplayerToonDeckUnshuffled(1, true)).not.toContain('platypus')
  })

  test("the Pig's solo exclusion is untouched — it is a rulebook rule, not a capability gap", () => {
    expect(buildSoloToonDeckUnshuffled(1, true)).toContain('axolotl')
    expect(buildSoloToonDeckUnshuffled(1, true)).not.toContain('pig')
  })

  test('solo discards two additional toon cards ("when using this mini-expansion")', () => {
    const off = buildSoloSetup(9, 1, 'normal')
    const on = buildSoloSetup(9, 1, 'normal', { bigButton: 'market' })
    // Two extra trimmed, but one extra card (Axolotl x2 copies) also came
    // back in, so compare against the UNTRIMMED pools rather than assuming a
    // flat -2.
    const pool = { off: buildSoloToonDeckUnshuffled(1).length, on: buildSoloToonDeckUnshuffled(1, true).length }
    expect(off.toonDeck.length).toBe(pool.off - 20)
    expect(on.toonDeck.length).toBe(pool.on - 20 - SOLO_BIG_BUTTON_EXTRA_TRIM)
    expect(SOLO_BIG_BUTTON_EXTRA_TRIM).toBe(2)
    expect(on.resetEffect).toBe('market')
  })

  test('every seat starts with its Big Button face up', () => {
    const match = buildNewMatch(7, 4, 1, { bigButton: 'grid' })
    expect(match.players.every((p) => p.bigButtonFaceUp)).toBe(true)
    expect(match.shared.resetEffect).toBe('grid')
  })
})

// ---------------------------------------------------------------------------
// State plumbing
// ---------------------------------------------------------------------------

describe('the new PlayerState fields survive the view boundary', () => {
  // state.ts's PLAYER_FIELDS has a compile-time guard, but a key listed there
  // and then dropped by a hand-written commitView branch would still compile.
  test('viewOf -> commitView round-trips bigButtonFaceUp and actedThisMarketPhase', () => {
    const match = buildNewMatch(7, 2, 1, { bigButton: 'market' })
    const mutated: PlayerView = { ...viewOf(match, 0), bigButtonFaceUp: false, actedThisMarketPhase: true }
    const next = commitView(match, 0, mutated)
    expect(next.players[0].bigButtonFaceUp).toBe(false)
    expect(next.players[0].actedThisMarketPhase).toBe(true)
    // ...and only that seat's.
    expect(next.players[1].bigButtonFaceUp).toBe(true)
  })

  test('the shared reset effect round-trips too', () => {
    const match = buildNewMatch(7, 2, 1, { bigButton: 'grid' })
    expect(commitView(match, 0, viewOf(match, 0)).shared.resetEffect).toBe('grid')
  })
})

// ---------------------------------------------------------------------------
// RESET: MARKET
// ---------------------------------------------------------------------------

// A 2-player match parked in the Market phase, with the acting seat rich
// enough to actually hire something. Shared by both reset effects — which one
// is in play is the caller's choice, since RESET: GRID's in-round tests need
// exactly the same staging (Market phase, unacted, solvent) as RESET: MARKET's.
function inMarketPhase(seed: number, bigButton: 'market' | 'grid'): { match: Match; playerId: string } {
  const base = buildNewMatch(seed, 2, 1, { fameToTriggerEndgame: 999, bigButton })
  const players = base.players.slice()
  const i = base.activePlayerIndex
  players[i] = { ...players[i], fame: 50, actionsRemaining: 2, actedThisMarketPhase: false }
  const match: Match = { ...base, shared: { ...base.shared, phase: 'market' }, players }
  return { match, playerId: match.turnOrder[i] }
}

function marketResetMatch(seed = 11): { match: Match; playerId: string } {
  return inMarketPhase(seed, 'market')
}

describe('RESET: MARKET', () => {
  test('every market card goes back into the toon deck and the market refills', () => {
    const { match, playerId } = marketResetMatch()
    const before = viewOf(match, playerIndex(match, playerId))
    const occupiedBefore = before.market.slots.filter((id) => id !== null)

    const after = applyMarketReset(before)

    // Card conservation: nothing is created or destroyed, it just moves. The
    // market is refilled FROM the enlarged deck, so the two zones together
    // must hold exactly what they held before.
    const total = (v: PlayerView) => v.toonDeck.length + v.market.slots.filter((id) => id !== null).length
    expect(total(after)).toBe(total(before))
    expect(after.market.slots.filter((id) => id !== null).length).toBe(occupiedBefore.length)
    // A genuine reshuffle, not a no-op: the refilled row is drawn from a
    // shuffled deck, so it should differ from what was there.
    expect(after.market.slots).not.toEqual(before.market.slots)
    expect(after.bigButtonFaceUp).toBe(false)
  })

  test('it is once per game', () => {
    const { match, playerId } = marketResetMatch()
    const once = applyMarketReset(viewOf(match, playerIndex(match, playerId)))
    expect(canUseMarketReset(once)).toBe(false)
    expect(() => applyMarketReset(once)).toThrow(/not available/)
  })

  test('it is still legal after this turn has already taken a Market action', () => {
    // RESET: MARKET dropped the "before any market actions" gate on purpose,
    // at the user's request — it is free-floating so a player can reset
    // defensively after seeing what they can (or can't) afford, mid-turn.
    // actedThisMarketPhase still exists on PlayerState, but it is no longer
    // this predicate's business — see canUseMarketReset's own comment.
    const { match, playerId } = marketResetMatch()
    const acted = { ...viewOf(match, playerIndex(match, playerId)), actedThisMarketPhase: true }
    expect(canUseMarketReset(acted)).toBe(true)
  })

  test('the action surface refuses it out of turn and reports which rule was broken', () => {
    const { match, playerId } = marketResetMatch()
    const other = match.turnOrder.find((id) => id !== playerId)!
    expect(() => applyMatchAction(match, other, { kind: 'useBigButton' })).toThrow(/isn't your turn/)

    // 'useBigButton' dispatches on view.resetEffect itself (matchActions.ts),
    // so there is no "wrong effect" mismatch reachable through the action
    // surface any more — only "the mini-expansion isn't on at all".
    const off = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const inMarket: Match = { ...off, shared: { ...off.shared, phase: 'market' } }
    expect(() => applyMatchAction(inMarket, inMarket.turnOrder[0], { kind: 'useBigButton' })).toThrow(/not in play/)
  })

  test('using it does not consume a Market action, and a hire afterwards still works', () => {
    const { match, playerId } = marketResetMatch()
    const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
    const view = viewOf(after, playerIndex(after, playerId))
    expect(view.actionsRemaining).toBe(2)
    // Still the acting seat's turn, still the Market phase.
    expect(after.shared.phase).toBe('market')
    expect(after.turnOrder[after.activePlayerIndex]).toBe(playerId)
    // ...and a hire against the refilled row succeeds, proving the turn
    // machine sees this seat as still mid-turn rather than half-closed.
    const slotIndex = after.shared.market.slots.findIndex((id) => id !== null)
    expect(slotIndex).toBeGreaterThanOrEqual(0)
    expect(() => applyMatchAction(after, playerId, { kind: 'hire', slotIndex })).not.toThrow()
  })

  test('used after one Market action stays legal and keeps the turn open', () => {
    const { match, playerId } = marketResetMatch()
    const i = playerIndex(match, playerId)

    const slotIndex = match.shared.market.slots.findIndex((id) => id !== null)
    const { match: afterHire } = applyMatchAction(match, playerId, { kind: 'hire', slotIndex })
    expect(viewOf(afterHire, i).actionsRemaining).toBe(1)

    const { match: afterReset } = applyMatchAction(afterHire, playerId, { kind: 'useBigButton' })
    expect(viewOf(afterReset, i).bigButtonFaceUp).toBe(false)
    expect(afterReset.shared.phase).toBe('market')
    expect(afterReset.turnOrder[afterReset.activePlayerIndex]).toBe(playerId)
  })

  test('used after both Market actions are spent is still legal, and this press is what finally ends the turn', () => {
    const { match, playerId } = marketResetMatch()
    const i = playerIndex(match, playerId)

    let current = match
    for (let n = 0; n < 2; n++) {
      const slotIndex = current.shared.market.slots.findIndex((id) => id !== null)
      current = applyMatchAction(current, playerId, { kind: 'hire', slotIndex }).match
    }
    expect(viewOf(current, i).actionsRemaining).toBe(0)

    // Zero actions left, but the button was STILL a legal zero-cost move right
    // up until this press — hasAnyLegalMarketAction (not actionsRemaining) is
    // the sole auto-end authority, and pressing it is what finally makes that
    // predicate false (0 actions AND no live button), so THIS press is what
    // ends the turn, not the hire before it.
    const { match: afterReset } = applyMatchAction(current, playerId, { kind: 'useBigButton' })
    expect(viewOf(afterReset, i).bigButtonFaceUp).toBe(false)
    expect(afterReset.turnOrder[afterReset.activePlayerIndex]).not.toBe(playerId)
  })

  test('a broke seat with an unused button is not auto-skipped; with a spent one it is', () => {
    // hasAnyLegalMarketAction drives three auto-end paths. A free action it
    // doesn't know about silently costs the player their once-per-game button.
    const { match, playerId } = marketResetMatch()
    const i = playerIndex(match, playerId)
    const broke: Match = {
      ...match,
      players: match.players.map((p, j) => (j === i ? { ...p, fame: 0, grid: emptyGrid() } : p)),
    }
    const { match: kept } = applyMatchAction(broke, playerId, { kind: 'useBigButton' })
    // Still this seat's turn: the reset was legal, so nothing auto-ended
    // before they got to press it...
    expect(kept.shared.phase).toBe('market')

    // ...but a broke seat whose button is already spent has genuinely nothing
    // left, and the turn does move on.
    const spent: Match = {
      ...broke,
      players: broke.players.map((p, j) => (j === i ? { ...p, bigButtonFaceUp: false } : p)),
    }
    const { match: skipped } = applyMatchAction(spent, playerId, { kind: 'endTurn' })
    expect(skipped.turnOrder[skipped.activePlayerIndex]).not.toBe(playerId)
  })

  test('a short refill still latches the depletion trigger', () => {
    const { match, playerId } = marketResetMatch()
    const view = viewOf(match, playerIndex(match, playerId))
    // One card in the toon deck plus the market's own occupants is fewer than
    // the row needs once they are all shuffled back in... unless it isn't, so
    // strip the deck to nothing and keep only two market cards.
    const market = { ...view.market, slots: view.market.slots.map((id, k) => (k < 2 ? id : null)) }
    const starved: PlayerView = { ...view, toonDeck: [], market, toonDeckDepleted: false }
    const after = applyMarketReset(starved)
    expect(after.toonDeckDepleted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RESET: GRID — in-round, on your own Market turn
// ---------------------------------------------------------------------------
//
// No pre-turn walk any more in a normal round: Check Fame goes straight to
// postFameHooks (pinned above), and RESET: GRID becomes a start-of-your-own-
// Market-turn action instead, gated by canUseGridResetNow. The Final Flip
// keeps the old clockwise walk (it has no Market phase to hang this off) —
// those tests live in the 'the Final Flip pauses for the Big Button' block
// below.

describe('RESET: GRID (in-round)', () => {
  test('Check Fame hands straight to postFameHooks even with RESET: GRID in play — no pre-turn walk any more', () => {
    const match = runMatchCheckFame(runMatchFlip(buildNewMatch(7, 2, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })))
    expect(match.shared.phase).toBe('postFameHooks')
    expect(match.shared.gridReset).toBeNull()
  })

  test('legal at the start of your own turn; illegal out of turn, after any action, with a spent button, or under RESET: MARKET', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    expect(canUseGridResetNow(viewOf(match, i))).toBe(true)

    // Out of turn.
    const other = match.turnOrder.find((id) => id !== playerId)!
    expect(() => applyMatchAction(match, other, { kind: 'useBigButton' })).toThrow(/isn't your turn/)

    // After any action this turn — the exact case actedThisMarketPhase exists
    // for (Peacock's bonus action makes actionsRemaining 2 - 1 + 1 = 2 again,
    // so that alone can't stand in for "hasn't acted yet").
    const acted = { ...match, players: match.players.map((p, j) => (j === i ? { ...p, actedThisMarketPhase: true } : p)) }
    expect(canUseGridResetNow(viewOf(acted, i))).toBe(false)
    expect(() => applyMatchAction(acted, playerId, { kind: 'useBigButton' })).toThrow(IllegalActionError)

    // Already spent.
    const spent = { ...match, players: match.players.map((p, j) => (j === i ? { ...p, bigButtonFaceUp: false } : p)) }
    expect(canUseGridResetNow(viewOf(spent, i))).toBe(false)
    expect(() => applyMatchAction(spent, playerId, { kind: 'useBigButton' })).toThrow(IllegalActionError)

    // Wrong reset effect in play.
    const { match: marketMatch, playerId: marketPlayerId } = inMarketPhase(23, 'market')
    expect(canUseGridResetNow(viewOf(marketMatch, playerIndex(marketMatch, marketPlayerId)))).toBe(false)
  })

  // A Peacock hire, staged in market slot 0 — the case actedThisMarketPhase
  // exists for: the bonus action makes actionsRemaining 2 - 1 + 1 = 2 again,
  // so the obvious `actionsRemaining === MARKET_ACTIONS_PER_ROUND` proxy
  // would wrongly read "hasn't acted yet" with a card already bought.
  test('a Peacock hire does not restore the grid-reset gate, even though actionsRemaining does', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const market = {
      prices: match.shared.market.prices,
      slots: match.shared.market.slots.slice(),
      insertionSeq: match.shared.market.insertionSeq.slice(),
    }
    market.slots[0] = 'peacock' as CardId
    const staged: Match = { ...match, shared: { ...match.shared, market } }

    const { match: after } = applyMatchAction(staged, playerId, { kind: 'hire', slotIndex: 0 })
    const view = viewOf(after, i)
    expect(view.actionsRemaining).toBe(2) // the proxy would say "untouched"...
    expect(view.actedThisMarketPhase).toBe(true) // ...but this knows better
    expect(canUseGridResetNow(view)).toBe(false)
    expect(() => applyMatchAction(after, playerId, { kind: 'useBigButton' })).toThrow(IllegalActionError)
  })

  // RESETTER-ONLY RESCORE, pinned. This is a deliberate deviation from the
  // Final Flip's "ALL players then repeat the Check Fame phase" — see
  // match.ts's matchApplyGridReset header comment and this plan's Decisions
  // section. Re-scoring the whole table on every in-round button press would
  // turn one seat's decision into a table-wide recompute mid-Market-phase.
  test('resetter-only rescore — every OTHER seat is byte-identical', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const othersBefore = match.players.filter((_, j) => j !== i).map((p) => JSON.stringify(p))

    const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })

    const othersAfter = after.players.filter((_, j) => j !== i).map((p) => JSON.stringify(p))
    expect(othersAfter).toEqual(othersBefore)
    // The resetter's own grid and score, meanwhile, did change.
    expect(JSON.stringify(after.players[i].grid)).not.toBe(JSON.stringify(match.players[i].grid))
  })

  test('the turn does not end, actionsRemaining is intact, and a hire afterwards works', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
    expect(after.shared.phase).toBe('market')
    expect(after.turnOrder[after.activePlayerIndex]).toBe(playerId)
    expect(viewOf(after, i).actionsRemaining).toBe(2)

    const slotIndex = after.shared.market.slots.findIndex((id) => id !== null)
    expect(slotIndex).toBeGreaterThanOrEqual(0)
    expect(() => applyMatchAction(after, playerId, { kind: 'hire', slotIndex })).not.toThrow()
  })

  // Spendable fame takes the DELTA, not an overwrite, so a Firefly-style
  // bonus already banked this round survives the reset (phases.ts's
  // rescoreAfterGridReset). Staged directly: give the seat more `fame` than
  // `fameGeneratedThisRound`, exactly what a Firefly +2 would leave behind.
  test('spendable fame takes the delta — a Firefly-style bonus survives the reset', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const bonus = 2
    const staged: Match = {
      ...match,
      players: match.players.map((p, j) => (j === i ? { ...p, fame: p.fameGeneratedThisRound + bonus } : p)),
    }
    const { match: after } = applyMatchAction(staged, playerId, { kind: 'useBigButton' })
    const view = viewOf(after, i)
    expect(view.fame).toBe(view.fameGeneratedThisRound + bonus)
  })

  test('card conservation across collect + re-flip', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const countCards = (v: PlayerView) => v.toonDeck.length + v.deck.length + [...occupiedSlots(v.grid)].reduce((n, { slot }) => n + slot.cards.length, 0)
    const before = countCards(viewOf(match, i))
    const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
    expect(countCards(viewOf(after, i))).toBe(before)
  })

  // inMarketPhase's synthetic staging never ran a real Flip/Check Fame, so
  // its "pre-reset" fameGeneratedThisRound is always the pristine 0 a fresh
  // match starts with — every reset looks like a score INCREASE, and a
  // "down" seed can never be found through it. These two tests need a
  // genuinely flipped-and-scored match to find both directions, so they route
  // through the real pipeline instead. Skunk/Firefly-holding seeds are
  // skipped (null) rather than answered, since resolving that choice isn't
  // this test's business.
  function realMarketPhaseMatch(seed: number): Match | null {
    let match = runMatchCheckFame(runMatchFlip(buildNewMatch(seed, 2, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })))
    match = runMatchPostFameHooks({ ...match, shared: { ...match.shared, phase: 'postFameHooks' } })
    return match.shared.phase === 'market' ? match : null
  }

  // Sets a threshold that DISAGREES between the pre- and post-reset score —
  // the only way to prove Cleanup reads the post-reset number rather than
  // the pre-reset one, since a threshold both sides agree on can't tell the
  // two apart. Neutralizes the other confounders runMatchCleanup also reads:
  // the OTHER seat's fameGeneratedThisRound (the fame trigger is `players.some`),
  // toonDeckDepleted, and any pre-existing endgameTriggered.
  function stageDisagreement(seed: number, i: number, match: Match, after: Match): { threshold: number; direction: 'up' | 'down' } | null {
    const pre = match.players[i].fameGeneratedThisRound
    const post = after.players[i].fameGeneratedThisRound
    if (pre === post) return null
    return post > pre ? { threshold: post, direction: 'up' } : { threshold: pre, direction: 'down' }
  }

  function cleanAt(after: Match, i: number, threshold: number): Match {
    const staged: Match = {
      ...after,
      shared: { ...after.shared, fameToTriggerEndgame: threshold, endgameTriggered: false, toonDeckDepleted: false, phase: 'cleanup' },
      players: after.players.map((p, j) => (j === i ? p : { ...p, fameGeneratedThisRound: 0 })),
    }
    return runMatchCleanup(staged)
  }

  test('the endgame trigger reads the post-reset number at runMatchCleanup — proved in BOTH directions', () => {
    const found: Partial<Record<'up' | 'down', true>> = {}
    for (let seed = 1; seed < 200 && (!found.up || !found.down); seed++) {
      const match = realMarketPhaseMatch(seed)
      if (!match) continue
      const playerId = match.turnOrder[match.activePlayerIndex]
      const i = playerIndex(match, playerId)
      const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
      const staging = stageDisagreement(seed, i, match, after)
      if (!staging || found[staging.direction]) continue
      found[staging.direction] = true
      const cleaned = cleanAt(after, i, staging.threshold)
      const postCrosses = after.players[i].fameGeneratedThisRound >= staging.threshold
      expect(cleaned.shared.endgameTriggered).toBe(postCrosses)
      // And explicitly the INVERSE of what the pre-reset number would have
      // said, since that is the whole point of the two directions.
      const preCrossed = match.players[i].fameGeneratedThisRound >= staging.threshold
      expect(cleaned.shared.endgameTriggered).not.toBe(preCrossed)
    }
    expect(found.up).toBe(true)
    expect(found.down).toBe(true)
  })

  test('criticsChoiceHolder likewise reads the post-reset number — proved where the argmax actually moves', () => {
    let found = false
    for (let seed = 1; seed < 200 && !found; seed++) {
      const match = realMarketPhaseMatch(seed)
      if (!match) continue
      const playerId = match.turnOrder[match.activePlayerIndex]
      const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
      const preHighest = Math.max(...match.players.map((p) => p.fameGeneratedThisRound))
      const preHolder = match.players.find((p) => p.fameGeneratedThisRound === preHighest)!.playerId
      const postHighest = Math.max(...after.players.map((p) => p.fameGeneratedThisRound))
      const postHolder = after.players.find((p) => p.fameGeneratedThisRound === postHighest)!.playerId
      if (postHolder === preHolder) continue // the argmax has to actually move for this seed to prove anything
      found = true
      const staged: Match = { ...after, shared: { ...after.shared, fameToTriggerEndgame: postHighest, phase: 'cleanup' } }
      const cleaned = runMatchCleanup(staged)
      expect(cleaned.shared.criticsChoiceHolder).toBe(postHolder)
      expect(cleaned.shared.criticsChoiceHolder).not.toBe(preHolder)
    }
    expect(found).toBe(true)
  })

  // Skunk/Firefly (postFameHooks) already fired on PRE-reset numbers, before
  // the Market phase opened — that is the one thing this in-round reset
  // cannot retroactively change. matchApplyGridReset logs it when the reset
  // would have picked a different lowest scorer, so the divergence isn't
  // invisible to the table.
  test('the least-fame hook fired on pre-reset numbers — its beneficiary is unchanged by the reset, and the log names the divergence when it would have differed', () => {
    let found = false
    for (let seed = 1; seed < 60 && !found; seed++) {
      const { match, playerId } = inMarketPhase(seed, 'grid')
      const lowestBefore = strictlyLowestScorerIndex(match)
      const beneficiaryFameBefore = lowestBefore === null ? null : match.players[lowestBefore].fame
      const result = applyMatchAction(match, playerId, { kind: 'useBigButton' })
      if (!result.logLines.some((l) => /least-fame bonus already resolved/.test(l.text))) continue
      found = true
      // The divergence is real (post-reset picks someone else), but whatever
      // fame the pre-reset lowest scorer already banked from the hook is
      // untouched — postFameHooks ran strictly before this Market phase
      // opened, and an in-round reset never revisits it. Skip the check if
      // the beneficiary IS the resetter: matchApplyGridReset does adjust
      // their own fame (the delta-preserving rescore, pinned elsewhere), so
      // "unchanged" isn't the right assertion for that seat.
      if (lowestBefore !== null && beneficiaryFameBefore !== null && match.turnOrder[lowestBefore] !== playerId) {
        const idx: number = lowestBefore
        const before: number = beneficiaryFameBefore
        expect(result.match.players[idx].fame).toBe(before)
      }
    }
    expect(found).toBe(true)
  })

  test('hasAnyLegalMarketAction: a broke seat with an unspent grid button is not auto-skipped; with a spent one it is', () => {
    const { match, playerId } = inMarketPhase(23, 'grid')
    const i = playerIndex(match, playerId)
    const broke: Match = {
      ...match,
      players: match.players.map((p, j) => (j === i ? { ...p, fame: 0, grid: emptyGrid() } : p)),
    }
    expect(hasAnyLegalMarketAction(viewOf(broke, i))).toBe(true)

    const spent: Match = { ...broke, players: broke.players.map((p, j) => (j === i ? { ...p, bigButtonFaceUp: false } : p)) }
    expect(hasAnyLegalMarketAction(viewOf(spent, i))).toBe(false)
  })

  test('answering a bigButtonDecision when no Final Flip walk is open is the player\'s mistake, not an engine bug', () => {
    const match = buildNewMatch(7, 2, 1, { fameToTriggerEndgame: 999 })
    expect(() => applyMatchAction(match, match.turnOrder[0], { kind: 'bigButtonDecision', use: true })).toThrow(IllegalActionError)
  })
})

// ---------------------------------------------------------------------------
// RESET: GRID during the Final Flip
// ---------------------------------------------------------------------------

describe('the Final Flip pauses for the Big Button', () => {
  function atFinalFlip(seed = 41): Match {
    const base = buildNewMatch(seed, 3, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })
    return { ...base, shared: { ...base.shared, phase: 'finalFlip', endgameTriggered: true } }
  }

  // This walk (SEQUENCED decisions, SIMULTANEOUS resets, "everyone
  // re-scores") now exists ONLY here — a normal round's RESET: GRID moved
  // onto the resetting seat's own Market turn (see the 'RESET: GRID
  // (in-round)' describe block above), so these tests, which used to pin the
  // pre-Market walk every round opened, are rebased on the Final Flip's
  // gridReset instead.
  test('the walk starts at the first player and goes clockwise', () => {
    let match = startMatchFinalFlip(atFinalFlip()).match
    const order: string[] = []
    while (match.shared.phase === 'gridReset') {
      const decider = gridResetDecider(match)!
      order.push(decider)
      match = matchBigButtonDecision(match, decider, false)
    }
    const expected = [0, 1, 2].map((s) => match.turnOrder[(match.firstPlayerIndex + s) % 3])
    expect(order).toEqual(expected)
  })

  test('a seat whose button is already spent is never asked', () => {
    const base = buildNewMatch(41, 3, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })
    const spent: Match = { ...base, players: base.players.map((p, i) => (i === 1 ? { ...p, bigButtonFaceUp: false } : p)) }
    const spentAtFinal: Match = { ...spent, shared: { ...spent.shared, phase: 'finalFlip', endgameTriggered: true } }
    let match = startMatchFinalFlip(spentAtFinal).match
    const asked: string[] = []
    while (match.shared.phase === 'gridReset') {
      const decider = gridResetDecider(match)!
      asked.push(decider)
      match = matchBigButtonDecision(match, decider, false)
    }
    expect(asked).not.toContain(base.turnOrder[1])
    expect(asked).toHaveLength(2)
  })

  test('the decision is turn-gated and answered exactly once', () => {
    const match = startMatchFinalFlip(atFinalFlip()).match
    const decider = gridResetDecider(match)!
    const other = match.turnOrder.find((id) => id !== decider)!
    expect(() => matchBigButtonDecision(match, other, true)).toThrow(/is .*'s turn/)
    const answered = matchBigButtonDecision(match, decider, false)
    expect(() => matchBigButtonDecision(answered, decider, false)).toThrow(/is .*'s turn|already decided/)
  })

  test('declining everywhere leaves every board and every score untouched', () => {
    let match = startMatchFinalFlip(atFinalFlip()).match
    const gridsBefore = match.players.map((p) => JSON.stringify(p.grid))
    const famesBefore = match.players.map((p) => p.fameGeneratedThisRound)
    while (match.shared.phase === 'gridReset') {
      match = matchBigButtonDecision(match, gridResetDecider(match)!, false)
    }
    expect(match.players.map((p) => JSON.stringify(p.grid))).toEqual(gridsBefore)
    expect(match.players.map((p) => p.fameGeneratedThisRound)).toEqual(famesBefore)
    expect(match.players.every((p) => p.bigButtonFaceUp)).toBe(true)
    expect(match.shared.gridReset).toBeNull()
    expect(match.shared.phase).toBe('finalFlip')
  })

  test('only the opted-in seats re-flip, but EVERY seat is re-scored', () => {
    let match = startMatchFinalFlip(atFinalFlip()).match
    const resetter = gridResetDecider(match)!
    const gridsBefore = match.players.map((p) => JSON.stringify(p.grid))

    while (match.shared.phase === 'gridReset') {
      const decider = gridResetDecider(match)!
      match = matchBigButtonDecision(match, decider, decider === resetter)
    }

    const gridsAfter = match.players.map((p) => JSON.stringify(p.grid))
    const ri = playerIndex(match, resetter)
    expect(gridsAfter[ri]).not.toBe(gridsBefore[ri]) // re-flipped
    for (let i = 0; i < gridsAfter.length; i++) {
      if (i !== ri) expect(gridsAfter[i]).toBe(gridsBefore[i]) // untouched
    }

    // "All players then repeat the Check Fame phase" — every seat's stored
    // breakdown is the SECOND one, scored against the post-reset table, not
    // the first.
    for (const p of match.players) {
      expect(p.lastCheckFame).not.toBeNull()
      expect(p.fameGeneratedThisRound).toBe(p.lastCheckFame!.total)
    }
    expect(match.players[ri].bigButtonFaceUp).toBe(false)
    expect(match.players.filter((_, i) => i !== ri).every((p) => p.bigButtonFaceUp)).toBe(true)
  })

  test('a re-flip that scores worse really does cost that seat the fame', () => {
    // Not "it might" — search seeds for a case where it actually does, so the
    // overwrite is pinned rather than assumed.
    let found = false
    for (let seed = 1; seed < 60 && !found; seed++) {
      let match = startMatchFinalFlip(atFinalFlip(seed)).match
      if (match.shared.phase !== 'gridReset') continue
      const resetter = gridResetDecider(match)!
      const ri = playerIndex(match, resetter)
      const before = match.players[ri].fameGeneratedThisRound
      while (match.shared.phase === 'gridReset') {
        const decider = gridResetDecider(match)!
        match = matchBigButtonDecision(match, decider, decider === resetter)
      }
      if (match.players[ri].fameGeneratedThisRound < before) found = true
    }
    expect(found).toBe(true)
  })

  test('startMatchFinalFlip returns no outcome and parks on the decision phase', () => {
    const started = startMatchFinalFlip(atFinalFlip())
    expect(started.outcome).toBeNull()
    expect(started.match.shared.phase).toBe('gridReset')
    expect(started.match.shared.gridReset?.context).toBe('finalFlip')
  })

  test('the old synchronous entry point refuses rather than silently skipping the decision', () => {
    expect(() => runMatchFinalFlip(atFinalFlip())).toThrow(/paused on a Big Button decision/)
  })

  test('once every seat has answered, the endgame resolves to a winner', () => {
    let match = startMatchFinalFlip(atFinalFlip()).match
    while (match.shared.phase === 'gridReset') {
      match = matchBigButtonDecision(match, gridResetDecider(match)!, false)
    }
    // Back in 'finalFlip', ready for the tiebreak-and-score tail.
    expect(match.shared.phase).toBe('finalFlip')
    const outcome = resumeMatchFinalFlip(match)
    expect(outcome.match.shared.phase).toBe('ended')
    expect(outcome.match.shared.winnerId ?? outcome.winners[0]).toBeTruthy()
  })

  test('the action surface drives the paused endgame end to end and announces the winner once', () => {
    let match = atFinalFlip()
    const log: string[] = []
    let result = applyMatchAction(match, match.turnOrder[0], { kind: 'advanceFlip' })
    match = result.match
    log.push(...result.logLines.map((l) => l.text))
    expect(match.shared.phase).toBe('gridReset')
    expect(log.some((t) => /wins!|shared win/.test(t))).toBe(false) // nothing decided yet

    let steps = 0
    while (match.shared.phase === 'gridReset' && steps++ < 8) {
      result = applyMatchAction(match, gridResetDecider(match)!, { kind: 'bigButtonDecision', use: false })
      match = result.match
      log.push(...result.logLines.map((l) => l.text))
    }
    expect(match.shared.phase).toBe('ended')
    expect(log.filter((t) => /wins!|A shared win/.test(t))).toHaveLength(1)
    expect(log.filter((t) => t.startsWith('Final Flip: '))).toHaveLength(3)
  })

  test('a seat that resets during the Final Flip flips again and the result reads its new board', () => {
    let started = startMatchFinalFlip(atFinalFlip()).match
    const resetter = gridResetDecider(started)!
    const ri = playerIndex(started, resetter)
    const gridBefore = JSON.stringify(started.players[ri].grid)
    while (started.shared.phase === 'gridReset') {
      const decider = gridResetDecider(started)!
      started = matchBigButtonDecision(started, decider, decider === resetter)
    }
    expect(JSON.stringify(started.players[ri].grid)).not.toBe(gridBefore)
    expect(started.players[ri].bigButtonFaceUp).toBe(false)
    const outcome = resumeMatchFinalFlip(started)
    const score = outcome.scores.find((s) => s.playerId === resetter)!
    expect(score.total).toBe(outcome.match.players[ri].lastCheckFame!.total)
  })

  test('the tiebreak re-flips never re-open the decision — the buttons are already spent', () => {
    let match = startMatchFinalFlip(atFinalFlip()).match
    while (match.shared.phase === 'gridReset') {
      const decider = gridResetDecider(match)!
      match = matchBigButtonDecision(match, decider, true) // everyone spends
    }
    const outcome = resumeMatchFinalFlip(match)
    expect(outcome.match.shared.phase).toBe('ended')
    expect(outcome.match.players.every((p) => !p.bigButtonFaceUp)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Axolotl and Platypus
// ---------------------------------------------------------------------------

describe('the two Big Button cards are no longer unencodable', () => {
  test('neither carries an unencodable flag any more', () => {
    for (const id of ['axolotl', 'platypus']) {
      expect(cards[id].unencodable).toBeUndefined()
      expect(cards[id].unencodableReason).toBeUndefined()
      expect(cards[id].fameUnencodable).toBeUndefined()
      expect(cards[id].fameUnencodableReason).toBeUndefined()
    }
    expect(cards['axolotl'].onHire).toEqual([{ kind: 'flipOwnBigButtonFaceUp' }])
    expect(cards['platypus'].onHire).toEqual([{ kind: 'flipAllBigButtonsFaceUp' }])
  })

  // A match with `cardId` in market slot 0, every button already spent, and
  // the acting seat able to afford it.
  function matchWithCardInMarket(cardId: CardId, season: 1 | 2): { match: Match; playerId: string } {
    const base = buildNewMatch(11, 3, season, { fameToTriggerEndgame: 999, bigButton: 'market' })
    const market = {
      prices: base.shared.market.prices,
      slots: base.shared.market.slots.slice(),
      insertionSeq: base.shared.market.insertionSeq.slice(),
    }
    market.slots[0] = cardId
    const i = base.activePlayerIndex
    const match: Match = {
      ...base,
      shared: { ...base.shared, phase: 'market', market },
      players: base.players.map((p, j) => ({
        ...p,
        bigButtonFaceUp: false,
        fame: j === i ? 50 : p.fame,
        actionsRemaining: j === i ? 2 : p.actionsRemaining,
      })),
    }
    return { match, playerId: match.turnOrder[i] }
  }

  test("Axolotl flips only the hirer's button back up", () => {
    const { match, playerId } = matchWithCardInMarket('axolotl', 1)
    const { match: after } = applyMatchAction(match, playerId, { kind: 'hire', slotIndex: 0 })
    const i = playerIndex(after, playerId)
    expect(after.players[i].bigButtonFaceUp).toBe(true)
    expect(after.players.filter((_, j) => j !== i).every((p) => !p.bigButtonFaceUp)).toBe(true)
  })

  test("Platypus flips EVERY seat's button back up, not just the hirer's", () => {
    const { match, playerId } = matchWithCardInMarket('platypus', 2)
    const { match: after } = applyMatchAction(match, playerId, { kind: 'hire', slotIndex: 0 })
    expect(after.players.every((p) => p.bigButtonFaceUp)).toBe(true)
  })
})

describe("Platypus's fame reads the button", () => {
  test('5 face up, 8 face down, never needsRuling', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['platypus'], faceUp: [true] }
    expect(scoreGrid(grid, cards, undefined, { bigButtonFaceDown: false }).total).toBe(5)
    expect(scoreGrid(grid, cards, undefined, { bigButtonFaceDown: true }).total).toBe(8)
    expect(scoreGrid(grid, cards, undefined, { bigButtonFaceDown: true }).lines[0].needsRuling).toBeUndefined()
  })

  test('two Platypuses each score their own +3 — it is per-card, not per-player', () => {
    // The reason this belongs in scoreGrid's externalState and NOT in
    // roundFame.ts's player-modifier seam.
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['platypus'], faceUp: [true] }
    grid.base[0][1] = { cards: ['platypus'], faceUp: [true] }
    expect(scoreGrid(grid, cards, undefined, { bigButtonFaceDown: true }).total).toBe(16) // (5+3) x 2
  })

  test('a seat that spent its button on an in-round grid reset scores the +3; one that kept it does not', () => {
    const base = buildNewMatch(23, 2, 2, { fameToTriggerEndgame: 999, bigButton: 'grid' })
    // Both seats hold a Platypus, so the ONLY difference between them is the
    // button.
    const withPlatypus = (): Match => ({
      ...base,
      players: base.players.map((p) => {
        const grid = emptyGrid()
        grid.base[0][0] = { cards: ['platypus'], faceUp: [true] }
        return { ...p, grid }
      }),
    })

    let match = runMatchCheckFame({ ...withPlatypus(), shared: { ...base.shared, phase: 'checkFame' } })
    expect(match.players.every((p) => p.fameGeneratedThisRound === 5)).toBe(true) // both face up
    match = runMatchPostFameHooks({ ...match, shared: { ...match.shared, phase: 'postFameHooks' } })
    expect(match.shared.phase).toBe('market')

    const spender = match.turnOrder[match.activePlayerIndex]
    const { match: after } = applyMatchAction(match, spender, { kind: 'useBigButton' })
    const keeper = after.players.find((p) => p.playerId !== spender)!
    // The keeper's board never changed, so its re-score is the same 5 — the
    // spender's board did, so its number is whatever it flipped, but its
    // button is now face down either way. This is the resetter-only rescore:
    // the keeper's fameGeneratedThisRound and bigButtonFaceUp are both
    // untouched by the other seat's decision.
    expect(keeper.fameGeneratedThisRound).toBe(5)
    expect(after.players.find((p) => p.playerId === spender)!.bigButtonFaceUp).toBe(false)
    expect(keeper.bigButtonFaceUp).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Solo
// ---------------------------------------------------------------------------

describe('solo', () => {
  test('RESET: MARKET works through the solo action surface', () => {
    const base = buildNewGameState(5, 'normal', 1, 'market')
    const state = { ...base, phase: 'market' as const, fame: 50, actionsRemaining: 2 }
    const before = state.toonDeck.length + state.market.slots.filter((id) => id !== null).length
    const { state: after, logLines } = applyAction(state, { kind: 'useBigButton' })
    expect(after.bigButtonFaceUp).toBe(false)
    expect(after.toonDeck.length + after.market.slots.filter((id) => id !== null).length).toBe(before)
    expect(logLines.some((l) => /Used the Big Button/.test(l.text))).toBe(true)

    // Refused the second time, and reported as the player's mistake rather
    // than thrown.
    const { state: unchanged, logLines: refusal } = applyAction(after, { kind: 'useBigButton' })
    expect(unchanged).toBe(after)
    expect(refusal.some((l) => /already face down/.test(l.text))).toBe(true)
  })

  test('flip lands straight on the Market phase — no decision phase to park on any more', () => {
    const base = buildNewGameState(5, 'normal', 1, 'grid')
    const { state } = applyAction(base, { kind: 'flip' })
    expect(state.phase).toBe('market')
    expect(state.bigButtonFaceUp).toBe(true)
  })

  test('not offered after a hire — canUseGridResetNow gates on actedThisMarketPhase', () => {
    const { state: flipped } = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' })
    // Plenty of fame so the hire below doesn't exhaust hasAnyLegalMarketAction
    // and cascade the phase straight past the Market phase this test wants to
    // inspect.
    const parked = { ...flipped, fame: 20, actionsRemaining: 2, fameToTriggerEndgame: 999 }
    const slotIndex = parked.market.slots.findIndex((id) => id !== null)
    const { state: hired } = applyAction(parked, { kind: 'hire', slotIndex })
    expect(hired.phase).toBe('market')
    expect(hired.actedThisMarketPhase).toBe(true)
    const { state: after, logLines } = applyAction(hired, { kind: 'useBigButton' })
    expect(after.bigButtonFaceUp).toBe(true) // refused, so still face up
    expect(logLines.some((l) => /before you take any Market actions/.test(l.text))).toBe(true)
  })

  test('declining (simply not pressing it) leaves the board untouched through the Market phase', () => {
    const { state: parked } = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' })
    const gridBefore = JSON.stringify(parked.grid)
    expect(parked.phase).toBe('market')
    expect(JSON.stringify(parked.grid)).toBe(gridBefore)
    expect(parked.bigButtonFaceUp).toBe(true)
  })

  test('using it re-flips, re-scores, and stays on the Market phase with the button spent', () => {
    const { state: parked } = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' })
    const gridBefore = JSON.stringify(parked.grid)
    const { state } = applyAction(parked, { kind: 'useBigButton' })
    expect(state.phase).toBe('market')
    expect(JSON.stringify(state.grid)).not.toBe(gridBefore)
    expect(state.bigButtonFaceUp).toBe(false)
    expect(state.fameGeneratedThisRound).toBe(state.lastCheckFame!.total)
    // The turn/phase did not end: this does not consume an action.
    expect(state.actionsRemaining).toBe(parked.actionsRemaining)
    // No card was lost or duplicated by the collect-and-reflip.
    const count = (s: typeof state) => s.deck.length + [...occupiedSlots(s.grid)].reduce((n, { slot }) => n + slot.cards.length, 0)
    expect(count(state)).toBe(count(parked))
  })

  test('the decision is not offered again next round — one use per game', () => {
    let state = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' }).state
    state = applyAction(state, { kind: 'useBigButton' }).state
    expect(state.bigButtonFaceUp).toBe(false)
    // Play the round out and flip into the next one.
    state = applyAction(state, { kind: 'endMarket' }).state
    if (state.phase === 'cleanup') state = applyAction(state, { kind: 'advanceCleanup' }).state
    if (state.phase === 'flip') state = applyAction(state, { kind: 'flip' }).state
    expect(state.phase).not.toBe('gridReset')
    expect(state.bigButtonFaceUp).toBe(false)
    // And the button is refused rather than reoffered.
    const { logLines } = applyAction(state, { kind: 'useBigButton' })
    expect(logLines.some((l) => /already face down/.test(l.text))).toBe(true)
  })

  test('still offered next round if unused this round', () => {
    let state = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' }).state
    state = applyAction(state, { kind: 'endMarket' }).state
    if (state.phase === 'cleanup') state = applyAction(state, { kind: 'advanceCleanup' }).state
    if (state.phase === 'flip') state = applyAction(state, { kind: 'flip' }).state
    expect(state.bigButtonFaceUp).toBe(true)
    const { state: after } = applyAction(state, { kind: 'useBigButton' })
    expect(after.bigButtonFaceUp).toBe(false)
  })
})

describe("the AI evaluator does not stall on the decision phase", () => {
  // stepAutomatic returning a non-'ended' state unchanged is an INFINITE LOOP
  // in playout, not a no-op: the loop only exits on 'ended' or a round counter
  // a stalled phase never advances. Solo can no longer reach 'gridReset' at
  // all any more — RESET: GRID moved onto the Market phase's own
  // rolloutMarketAction/chooseBestMarketAction path (via 'useBigButton'),
  // which the evaluator still declines to consider a candidate, so this now
  // pins the INVERSE of the old assertion: a solo game with RESET: GRID in
  // play should play to a stopping point and NEVER reach 'gridReset'.
  test('a solo game plays itself to the end with RESET: GRID in play, and never reaches gridReset', () => {
    const state = buildNewGameState(5, 'normal', 1, 'grid')
    const result = playAutomatically(state, { simulations: 2, maxRoundsPerPlayout: 3, maxRounds: 12 })
    // Reached a real stopping point rather than throwing or spinning...
    expect(result.actionsTaken.length).toBeGreaterThan(0)
    // ...and the phase never becomes 'gridReset' — teaching the AI to weigh a
    // re-flip is new scope, so it never presses the button at all.
    expect(result.actionsTaken.some((a) => a.kind === 'useBigButton')).toBe(false)
    expect(result.state.phase).not.toBe('gridReset')
  })
})

// ---------------------------------------------------------------------------
// The primitives, guarded
// ---------------------------------------------------------------------------

describe('the reset primitives refuse to run when the button is not available', () => {
  test('applyGridResetCollect throws rather than silently spending a spent button', () => {
    const match = buildNewMatch(7, 2, 1, { bigButton: 'grid' })
    const spent: PlayerView = { ...viewOf(match, 0), bigButtonFaceUp: false }
    expect(() => applyGridResetCollect(spent)).toThrow(/not available/)
  })

  test('applyGridResetCollect refuses when the effect in play is RESET: MARKET', () => {
    const match = buildNewMatch(7, 2, 1, { bigButton: 'market' })
    expect(() => applyGridResetCollect(viewOf(match, 0))).toThrow(/not RESET: GRID/)
  })
})
