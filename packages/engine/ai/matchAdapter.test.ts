// Tests for matchAdapter.ts: the Monte Carlo AI wired to matchActions.ts
// instead of actions.ts. Kept deliberately small (few simulations, small
// round caps, 'easy'-equivalent budgets) so this file runs fast — the
// underlying phase machine is already covered by match.test.ts/
// matchActions.test.ts; this file only tests the search/adapter layer.
import { describe, expect, test } from 'bun:test'
import { makeRng } from '../rng'
import { buildNewMatch, playerIndex } from '../match'
import type { Match } from '../state'
import { playAutomatically } from './core'
import { advanceToBotDecision, buildMatchAdapter, matchReward } from './matchAdapter'
import { chooseBestMatchAction, evaluateMatchCandidates } from './index'

const FAST_OPTS = { simulations: 5, maxStepsPerPlayout: 15, rng: makeRng(1) }

// A low endgame threshold so a full match search stays fast — the same
// trick matchActions.test.ts uses (buildNewMatch's own fameToTriggerEndgame
// override).
function newMatch(seed: number, players = 2): Match {
  return buildNewMatch(seed, players, 1, { fameToTriggerEndgame: 6 })
}

describe('advanceToBotDecision', () => {
  test('lands on a state where the bot has a real decision, or the match has ended', () => {
    const match = newMatch(1)
    const at = advanceToBotDecision(match, 'p0')
    const adapter = buildMatchAdapter('p0')
    expect(adapter.isTerminal(at) || adapter.legalCandidates(at).length > 0).toBe(true)
  })
})

describe('buildMatchAdapter', () => {
  test('apply does not mutate the match it is given', () => {
    const match = advanceToBotDecision(newMatch(2), 'p0')
    const before = structuredClone(match)
    const adapter = buildMatchAdapter('p0')
    const candidates = adapter.legalCandidates(match)
    expect(candidates.length).toBeGreaterThan(0)
    adapter.apply(match, candidates[0]!)
    expect(match).toEqual(before)
  })

  test('clone is an independent deep copy', () => {
    const match = advanceToBotDecision(newMatch(3), 'p0')
    const adapter = buildMatchAdapter('p0')
    const cloned = adapter.clone(match)
    expect(cloned).not.toBe(match)
    expect(cloned).toEqual(match)
    cloned.shared.round = match.shared.round + 999
    expect(match.shared.round).not.toBe(cloned.shared.round)
  })

  test('legalCandidates is empty once the match has ended', () => {
    const match = newMatch(4)
    const adapter = buildMatchAdapter('p0')
    const result = playAutomatically(adapter, advanceToBotDecision(match, 'p0'), {
      ...FAST_OPTS,
      maxSteps: 300,
      maxWallClockMs: 30_000,
    })
    expect(result.state.shared.phase).toBe('ended')
    expect(adapter.legalCandidates(result.state)).toEqual([])
  })
})

describe('chooseBestMatchAction', () => {
  test('picks one of the candidates evaluateMatchCandidates scored, for a live 2-seat match', () => {
    const match = newMatch(5)
    const scored = evaluateMatchCandidates(match, 'p0', { difficulty: 'easy', ...FAST_OPTS })
    const chosen = chooseBestMatchAction(match, 'p0', { difficulty: 'easy', ...FAST_OPTS })
    expect(scored.map((s) => JSON.stringify(s.action))).toContain(JSON.stringify(chosen))
  })

  test('throws when the named seat has no real decision right now', () => {
    // Advance to a state, then hand evaluateMatchCandidates the OTHER
    // seat's id while it's not their turn.
    const match = advanceToBotDecision(newMatch(6), 'p0')
    const otherSeat = match.turnOrder.find((id) => id !== match.turnOrder[match.activePlayerIndex])!
    if (match.shared.phase !== 'market') return // nothing to assert this seed
    expect(() => evaluateMatchCandidates(match, otherSeat, FAST_OPTS)).toThrow(/no legal decision/)
  })
})

describe('matchReward — adversarial, seed-102-class check', () => {
  // soloAdapter.ts's real bug (see its own reward() comment): a reward that
  // read the LIVE grid made repeatedly dismissing the bot's own grid look
  // like a winning move, because several fame bonuses read the dismissed
  // pile — the rollout looped dismissing forever on seed 102 instead of
  // ever reaching a terminal state. matchReward reads only
  // lastCheckFame-derived totals (matchRoundFame -> roundFame), frozen at
  // Check Fame, specifically to close that hole off. This asserts the
  // closed-off shape directly: reward must NOT increase just because the
  // bot's own grid changed without a Check Fame happening.
  test('reward is unaffected by dismissing the bot grid mid-turn, absent a Check Fame', () => {
    let match = advanceToBotDecision(newMatch(7), 'p0')
    // Drive to the bot's own market turn with something on the grid.
    let guard = 0
    while (match.shared.phase !== 'market' && guard < 200) {
      match = advanceToBotDecision(match, 'p0')
      guard++
    }
    const before = matchReward(match, 'p0')

    // Simulate "the grid emptied out under the bot" without a Check Fame
    // having run, by clearing the acting seat's grid directly and
    // re-measuring reward off the SAME (unchanged) lastCheckFame.
    const index = playerIndex(match, 'p0')
    const hollowed: Match = {
      ...match,
      players: match.players.map((p, i) => (i === index ? { ...p, grid: { slots: [], extraSlots: [] } as never } : p)),
    }
    const after = matchReward(hollowed, 'p0')
    expect(after).toBe(before)
  })

  test('a full search-driven playout terminates rather than looping non-terminal turns forever', () => {
    const match = newMatch(8)
    const adapter = buildMatchAdapter('p0')
    const result = playAutomatically(adapter, advanceToBotDecision(match, 'p0'), {
      ...FAST_OPTS,
      maxSteps: 250,
      maxWallClockMs: 30_000,
    })
    expect(result.state.shared.phase).toBe('ended')
    expect(result.actionsTaken.length).toBeGreaterThan(0)
    expect(result.actionsTaken.length).toBeLessThan(250)
  })
})
