// Stage 3: the multiplayer action surface.
//
// The centrepiece is autoplayMatch below — it drives a whole 2-player game to
// its Final Flip through applyMatchAction and nothing else, the same way the
// server will. A phase machine that deadlocks, a turn that never passes, or a
// Cleanup that never runs shows up here as a hang or a thrown error rather
// than as a tester's bug report.

import { describe, expect, test } from 'bun:test'
import { buildNewMatch, playerIndex } from './match'
import { IllegalActionError, applyMatchAction, isPlayersTurn } from './matchActions'
import type { LogLine, MatchAction } from './matchActions'
import type { Match } from './state'

// Plays a match to completion with a simple deterministic policy: answer any
// prompt with its first legal option, never hire, just end each turn. Enough
// to exercise every phase transition without depending on market contents.
function autoplayMatch(match: Match, opts: { hire?: boolean } = {}): { match: Match; log: LogLine[]; steps: number } {
  let m = match
  const log: LogLine[] = []
  let steps = 0

  const act = (playerId: string, action: MatchAction) => {
    const r = applyMatchAction(m, playerId, action)
    m = r.match
    log.push(...r.logLines)
    steps++
  }

  while (m.shared.phase !== 'ended' && steps < 400) {
    // Any seat may press the shared advance.
    if (m.shared.phase === 'flip' || m.shared.phase === 'finalFlip') {
      act(m.turnOrder[0], { kind: 'advanceFlip' })
      continue
    }

    // Mandatory Skunk dismissals block the Market phase from opening.
    const owing = m.players.find((p) => p.pendingPostFameChoice)
    if (owing) {
      const o = owing.pendingPostFameChoice!.options[0]
      act(owing.playerId, { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index })
      continue
    }

    if (m.shared.phase === 'market') {
      const active = m.turnOrder[m.activePlayerIndex]
      const me = m.players[playerIndex(m, active)]
      if (me.pendingPostMarketChoice) {
        const o = me.pendingPostMarketChoice.options[0]
        act(active, { kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index })
        continue
      }
      // Optionally spend, to exercise the hire path and actually generate fame.
      if (opts.hire && me.actionsRemaining > 0) {
        const affordable = m.shared.market.slots.findIndex((c, i) => c !== null && m.shared.market.prices[i] <= me.fame)
        if (affordable >= 0) {
          try {
            act(active, { kind: 'hire', slotIndex: affordable })
            continue
          } catch (err) {
            if (!(err instanceof IllegalActionError)) throw err
          }
        }
      }
      act(active, { kind: 'endTurn' })
      continue
    }

    throw new Error(`autoplayMatch: stuck in phase '${m.shared.phase}'`)
  }

  return { match: m, log, steps }
}

describe('a full 2-player match through the action layer', () => {
  test('reaches a Final Flip and ends with a winner', () => {
    // A low threshold so the fame trigger fires in a couple of rounds rather
    // than a dozen — the same knob the browser end-to-end run uses.
    const played = autoplayMatch(buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 6 }), { hire: true })
    expect(played.match.shared.phase).toBe('ended')
    expect(played.match.shared.endgameTriggered).toBe(true)
    expect(played.steps).toBeLessThan(400) // i.e. it terminated, not hit the cap
    expect(played.match.shared.winnerId).not.toBeNull()
  })

  test('every seat actually took turns — the turn order really rotates', () => {
    const played = autoplayMatch(buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 6 }), { hire: true })
    const actors = new Set(played.log.map((l) => l.playerId).filter(Boolean))
    expect(actors).toContain('p0')
    expect(actors).toContain('p1')
  })

  test('the first-player marker rotates between rounds', () => {
    // Play far enough to cross at least one Cleanup, with the endgame out of
    // reach so the rounds keep coming.
    let m = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const seenFirstPlayers = new Set<number>()
    for (let i = 0; i < 3; i++) {
      const round = m.shared.round
      while (m.shared.round === round && m.shared.phase !== 'ended') {
        const before = m
        m = autoplayOneStep(m)
        if (m === before) break
      }
      seenFirstPlayers.add(m.firstPlayerIndex)
    }
    expect(seenFirstPlayers.size).toBeGreaterThan(1)
  })

  test('a 3-player and a 4-player match both play to a finish', () => {
    for (const n of [3, 4]) {
      const played = autoplayMatch(buildNewMatch(21, n, 1, { fameToTriggerEndgame: 6 }), { hire: true })
      expect(played.match.shared.phase).toBe('ended')
      expect(played.match.players).toHaveLength(n)
    }
  })

  test('a Season 2 match plays to a finish too', () => {
    const played = autoplayMatch(buildNewMatch(31, 2, 2, { fameToTriggerEndgame: 6 }), { hire: true })
    expect(played.match.shared.phase).toBe('ended')
  })
})

// One step of the same policy, for the round-boundary test above.
function autoplayOneStep(m: Match): Match {
  if (m.shared.phase === 'flip' || m.shared.phase === 'finalFlip') {
    return applyMatchAction(m, m.turnOrder[0], { kind: 'advanceFlip' }).match
  }
  const owing = m.players.find((p) => p.pendingPostFameChoice)
  if (owing) {
    const o = owing.pendingPostFameChoice!.options[0]
    return applyMatchAction(m, owing.playerId, { kind: 'resolvePostFameChoice', pos: o.pos, index: o.index }).match
  }
  if (m.shared.phase === 'market') {
    const active = m.turnOrder[m.activePlayerIndex]
    const me = m.players[playerIndex(m, active)]
    if (me.pendingPostMarketChoice) {
      const o = me.pendingPostMarketChoice.options[0]
      return applyMatchAction(m, active, { kind: 'resolvePostMarketChoice', pos: o.pos, index: o.index }).match
    }
    return applyMatchAction(m, active, { kind: 'endTurn' }).match
  }
  return m
}

describe('turn ownership', () => {
  function atMarket(seed = 11): Match {
    let m = buildNewMatch(seed, 2, 1, { fameToTriggerEndgame: 999 })
    m = applyMatchAction(m, 'p0', { kind: 'advanceFlip' }).match
    for (const p of m.players) {
      const pending = m.players[playerIndex(m, p.playerId)].pendingPostFameChoice
      if (pending) {
        m = applyMatchAction(m, p.playerId, { kind: 'resolvePostFameChoice', pos: pending.options[0].pos, index: pending.options[0].index }).match
      }
    }
    return m
  }

  test('an out-of-turn hire is refused as a player error, not an engine bug', () => {
    const m = atMarket()
    const waiting = m.turnOrder.find((id) => id !== m.turnOrder[m.activePlayerIndex])!
    expect(() => applyMatchAction(m, waiting, { kind: 'hire', slotIndex: 0 })).toThrow(IllegalActionError)
  })

  test('an out-of-turn endTurn is refused', () => {
    const m = atMarket()
    const waiting = m.turnOrder.find((id) => id !== m.turnOrder[m.activePlayerIndex])!
    expect(() => applyMatchAction(m, waiting, { kind: 'endTurn' })).toThrow(/isn't your turn/)
  })

  test('isPlayersTurn agrees with what the engine will accept', () => {
    const m = atMarket()
    const active = m.turnOrder[m.activePlayerIndex]
    expect(isPlayersTurn(m, active)).toBe(true)
    for (const id of m.turnOrder) if (id !== active) expect(isPlayersTurn(m, id)).toBe(false)
  })

  test('ending a turn passes it to the next seat', () => {
    const m = atMarket()
    const active = m.turnOrder[m.activePlayerIndex]
    const after = applyMatchAction(m, active, { kind: 'endTurn' }).match
    if (after.shared.phase === 'market') expect(after.turnOrder[after.activePlayerIndex]).not.toBe(active)
  })

  test('nobody gets a third Market action', () => {
    const m = atMarket()
    const active = m.turnOrder[m.activePlayerIndex]
    expect(m.players[playerIndex(m, active)].actionsRemaining).toBe(2)
  })

  test('the shared flip advance is NOT turn-gated — any seat may press it', () => {
    const m = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const notFirst = m.turnOrder[(m.firstPlayerIndex + 1) % m.turnOrder.length]
    expect(() => applyMatchAction(m, notFirst, { kind: 'advanceFlip' })).not.toThrow()
  })

  test('an unknown player id is rejected', () => {
    const m = buildNewMatch(11, 2)
    expect(() => applyMatchAction(m, 'nobody', { kind: 'advanceFlip' })).toThrow(/no player/)
  })

  test('answering a prompt you do not hold is a player error', () => {
    const m = buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 999 })
    const flipped = applyMatchAction(m, 'p0', { kind: 'advanceFlip' }).match
    const idle = flipped.players.find((p) => !p.pendingPostFameChoice)
    if (!idle) return // both seats owe a dismissal this seed; nothing to assert
    expect(() =>
      applyMatchAction(flipped, idle.playerId, { kind: 'resolvePostFameChoice', pos: { section: 'base', row: 0, col: 0 }, index: 0 }),
    ).toThrow(IllegalActionError)
  })
})

describe('log lines carry an actor and the round they happened in', () => {
  test('each line is attributed, and the round is stamped at write time', () => {
    const played = autoplayMatch(buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 6 }), { hire: true })
    expect(played.log.length).toBeGreaterThan(0)
    // Rounds are non-decreasing through the log — the old protocol tagged
    // every historical line with the room's CURRENT round on join, which
    // collapsed a joiner's whole history into one bucket.
    const rounds = played.log.map((l) => l.round)
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]).toBeGreaterThanOrEqual(rounds[i - 1])
    expect(new Set(rounds).size).toBeGreaterThan(1)
  })

  test('table-wide events are attributed to nobody, not to whoever clicked', () => {
    const played = autoplayMatch(buildNewMatch(11, 2, 1, { fameToTriggerEndgame: 6 }), { hire: true })
    const endgame = played.log.find((l) => l.text.includes('endgame is triggered'))
    expect(endgame).toBeDefined()
    expect(endgame!.playerId).toBeNull()
  })
})
