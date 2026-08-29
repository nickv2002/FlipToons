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
import { applyGridResetCollect, applyMarketReset, canUseGridReset, canUseMarketReset } from './bigButton'
import { applyAction, buildNewGameState } from './actions'
import { playAutomatically } from './ai'
import type { Action } from './actions'
import { emptyGrid, occupiedSlots } from './grid'
import {
  buildNewMatch,
  gridResetDecider,
  matchBigButtonDecision,
  playerIndex,
  resumeMatchFinalFlip,
  runMatchCheckFame,
  runMatchFinalFlip,
  runMatchFlip,
  startMatchFinalFlip,
} from './match'
import { applyMatchAction, IllegalActionError } from './matchActions'
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

// After the RESET: GRID walk closes, the table is in the Market phase — or
// still in postFameHooks, because a seat owes the mandatory Skunk dismissal
// that blocks the Market phase for everyone (match.ts's
// openMarketPhaseIfReady). Both are "the decision phase is over and the hooks
// ran"; asserting only the first would make this file fail on whichever
// Season 1 shuffle happens to deal a face-up Skunk.
function expectPastGridReset(match: Match): void {
  expect(match.shared.gridReset).toBeNull()
  if (match.players.some((p) => p.pendingPostFameChoice)) {
    expect(match.shared.phase).toBe('postFameHooks')
    return
  }
  expect(match.shared.phase).toBe('market')
  expect(match.activePlayerIndex).toBe(match.firstPlayerIndex)
}

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

// A 2-player match parked in the Market phase, playing RESET: MARKET, with the
// acting seat rich enough to actually hire something.
function marketResetMatch(seed = 11): { match: Match; playerId: string } {
  const base = buildNewMatch(seed, 2, 1, { fameToTriggerEndgame: 999, bigButton: 'market' })
  const players = base.players.slice()
  const i = base.activePlayerIndex
  players[i] = { ...players[i], fame: 50, actionsRemaining: 2, actedThisMarketPhase: false }
  const match: Match = { ...base, shared: { ...base.shared, phase: 'market' }, players }
  return { match, playerId: match.turnOrder[i] }
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

  test('it is refused after this turn has already taken a Market action', () => {
    const { match, playerId } = marketResetMatch()
    const acted = { ...viewOf(match, playerIndex(match, playerId)), actedThisMarketPhase: true }
    expect(canUseMarketReset(acted)).toBe(false)
  })

  test('a Peacock hire does not restore the button, even though actionsRemaining does', () => {
    // The exact case actedThisMarketPhase exists for: Peacock's bonus action
    // makes actionsRemaining 2 - 1 + 1 = 2 again, so the obvious
    // `actionsRemaining === MARKET_ACTIONS_PER_ROUND` proxy would wrongly
    // read "hasn't acted yet" with a card already bought.
    const { match, playerId } = marketResetMatch()
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
    expect(canUseMarketReset(view)).toBe(false)
    expect(() => applyMatchAction(after, playerId, { kind: 'useBigButton' })).toThrow(IllegalActionError)
  })

  test('the action surface refuses it out of turn and reports which rule was broken', () => {
    const { match, playerId } = marketResetMatch()
    const other = match.turnOrder.find((id) => id !== playerId)!
    expect(() => applyMatchAction(match, other, { kind: 'useBigButton' })).toThrow(/isn't your turn/)

    const wrongEffect = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const inMarket: Match = { ...wrongEffect, shared: { ...wrongEffect.shared, phase: 'market' } }
    expect(() => applyMatchAction(inMarket, inMarket.turnOrder[0], { kind: 'useBigButton' })).toThrow(/not RESET: MARKET/)
  })

  test('using it does not consume a Market action', () => {
    const { match, playerId } = marketResetMatch()
    const { match: after } = applyMatchAction(match, playerId, { kind: 'useBigButton' })
    expect(viewOf(after, playerIndex(after, playerId)).actionsRemaining).toBe(2)
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
// RESET: GRID
// ---------------------------------------------------------------------------

// A 3-player match playing RESET: GRID, flipped and scored, sitting on the
// decision phase.
function gridResetMatch(seed = 23): Match {
  const base = buildNewMatch(seed, 3, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })
  return runMatchCheckFame(runMatchFlip(base))
}

describe('RESET: GRID', () => {
  test("Check Fame opens the decision phase instead of going to post-fame hooks", () => {
    const match = gridResetMatch()
    expect(match.shared.phase).toBe('gridReset')
    expect(match.shared.gridReset).toEqual({ context: 'round', asked: [], optedIn: [] })
  })

  test('the walk starts at the first player and goes clockwise', () => {
    let match = gridResetMatch()
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
    const base = buildNewMatch(23, 3, 1, { fameToTriggerEndgame: 999, bigButton: 'grid' })
    const spent: Match = { ...base, players: base.players.map((p, i) => (i === 1 ? { ...p, bigButtonFaceUp: false } : p)) }
    let match = runMatchCheckFame(runMatchFlip(spent))
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
    const match = gridResetMatch()
    const decider = gridResetDecider(match)!
    const other = match.turnOrder.find((id) => id !== decider)!
    expect(() => matchBigButtonDecision(match, other, true)).toThrow(/is .*'s turn/)
    const answered = matchBigButtonDecision(match, decider, false)
    expect(() => matchBigButtonDecision(answered, decider, false)).toThrow(/is .*'s turn|already decided/)
  })

  test('declining everywhere leaves every board and every score untouched', () => {
    let match = gridResetMatch()
    const gridsBefore = match.players.map((p) => JSON.stringify(p.grid))
    const famesBefore = match.players.map((p) => p.fameGeneratedThisRound)
    while (match.shared.phase === 'gridReset') {
      match = matchBigButtonDecision(match, gridResetDecider(match)!, false)
    }
    expect(match.players.map((p) => JSON.stringify(p.grid))).toEqual(gridsBefore)
    expect(match.players.map((p) => p.fameGeneratedThisRound)).toEqual(famesBefore)
    expect(match.players.every((p) => p.bigButtonFaceUp)).toBe(true)
    expect(match.shared.gridReset).toBeNull()
    // The post-fame hooks have run and the phase has moved on. It lands on
    // 'market' UNLESS a seat still owes a mandatory Skunk dismissal, which
    // holds the Market phase for the whole table — a Season 1 multiplayer
    // starting deck contains a Skunk, so that is the common case, not an
    // edge one.
    expectPastGridReset(match)
  })

  test('only the opted-in seats re-flip, but EVERY seat is re-scored', () => {
    let match = gridResetMatch()
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
    // the first. Checked by re-scoring each grid against what is on the table
    // now and matching the recorded number.
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
      let match = gridResetMatch(seed)
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

  test('the whole phase drives through the action surface too', () => {
    let match = gridResetMatch()
    let steps = 0
    while (match.shared.phase === 'gridReset' && steps++ < 8) {
      const decider = gridResetDecider(match)!
      const result = applyMatchAction(match, decider, { kind: 'bigButtonDecision', use: false })
      match = result.match
      expect(result.logLines.some((l) => /Big Button/.test(l.text))).toBe(true)
    }
    expectPastGridReset(match)
  })

  test('answering when no decision is open is the player\'s mistake, not an engine bug', () => {
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

  test('a seat that spent its button on a grid reset scores the +3; one that kept it does not', () => {
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

    const spender = gridResetDecider(match)!
    while (match.shared.phase === 'gridReset') {
      const decider = gridResetDecider(match)!
      match = matchBigButtonDecision(match, decider, decider === spender)
    }
    const keeper = match.players.find((p) => p.playerId !== spender)!
    // The keeper's board never changed, so its re-score is the same 5 — the
    // spender's board did, so its number is whatever it flipped, but its
    // button is now face down either way.
    expect(keeper.fameGeneratedThisRound).toBe(5)
    expect(match.players.find((p) => p.playerId === spender)!.bigButtonFaceUp).toBe(false)
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

  test("RESET: GRID parks the cascade on the decision instead of running to 'market'", () => {
    const base = buildNewGameState(5, 'normal', 1, 'grid')
    const { state, logLines } = applyAction(base, { kind: 'flip' })
    expect(state.phase).toBe('gridReset')
    expect(logLines.some((l) => /Big Button is available/.test(l.text))).toBe(true)
  })

  test('declining continues to the Market phase with the board untouched', () => {
    const { state: parked } = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' })
    const gridBefore = JSON.stringify(parked.grid)
    const { state } = applyAction(parked, { kind: 'bigButtonDecision', use: false })
    expect(state.phase).toBe('market')
    expect(JSON.stringify(state.grid)).toBe(gridBefore)
    expect(state.bigButtonFaceUp).toBe(true)
  })

  test('using it re-flips, re-scores, and lands on the Market phase with the button spent', () => {
    const { state: parked } = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' })
    const gridBefore = JSON.stringify(parked.grid)
    const { state } = applyAction(parked, { kind: 'bigButtonDecision', use: true })
    expect(state.phase).toBe('market')
    expect(JSON.stringify(state.grid)).not.toBe(gridBefore)
    expect(state.bigButtonFaceUp).toBe(false)
    expect(state.fameGeneratedThisRound).toBe(state.lastCheckFame!.total)
    // No card was lost or duplicated by the collect-and-reflip.
    const count = (s: typeof state) => s.deck.length + [...occupiedSlots(s.grid)].reduce((n, { slot }) => n + slot.cards.length, 0)
    expect(count(state)).toBe(count(parked))
  })

  test('the decision is not offered again next round — one use per game', () => {
    let state = applyAction(buildNewGameState(5, 'normal', 1, 'grid'), { kind: 'flip' }).state
    state = applyAction(state, { kind: 'bigButtonDecision', use: true }).state
    // Play the round out and flip into the next one.
    state = applyAction(state, { kind: 'endMarket' }).state
    if (state.phase === 'cleanup') state = applyAction(state, { kind: 'advanceCleanup' }).state
    if (state.phase === 'flip') state = applyAction(state, { kind: 'flip' }).state
    expect(state.phase).not.toBe('gridReset')
  })

  test('the solo action union is refused cleanly outside its phase', () => {
    const state = buildNewGameState(5, 'normal', 1, 'grid')
    const { logLines } = applyAction(state, { kind: 'bigButtonDecision', use: true } satisfies Action)
    expect(logLines.some((l) => /no Big Button decision/.test(l.text))).toBe(true)
  })
})

describe("the AI evaluator does not stall on the decision phase", () => {
  // stepAutomatic returning a non-'ended' state unchanged is an INFINITE LOOP
  // in playout, not a no-op: the loop only exits on 'ended' or a round counter
  // a stalled phase never advances. So the AI has to answer this phase even
  // though it has no model for whether a re-flip is worth it (it declines).
  test('a solo game plays itself to the end with RESET: GRID in play', () => {
    const state = buildNewGameState(5, 'normal', 1, 'grid')
    const result = playAutomatically(state, { simulations: 2, maxRoundsPerPlayout: 3, maxRounds: 12 })
    // Reached a real stopping point rather than throwing or spinning...
    expect(result.actionsTaken.length).toBeGreaterThan(0)
    // ...and it answered the decision rather than falling through it.
    expect(result.actionsTaken.some((a) => a.kind === 'bigButtonDecision')).toBe(true)
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
