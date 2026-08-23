// Source-level architecture checks §10 calls out as "worth a grep in CI" —
// automated here instead of a one-off manual review step, so a regression
// actually fails `bun test` instead of relying on someone remembering to
// grep before merging.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildNewMatch, runMatchFinalFlip, strictlyLowestScorerIndex } from './match'
import { roundFame } from './roundFame'
import { createSoloGameState, makeMatch } from './state'

// §10: "No engine module branches on `season`... scope it to IDENTIFIER
// usage (`\.season\b`, `season ===`, `SeasonId`), not the string, or it
// will false-positive on cards/season1.ts import paths in index.ts and
// setup.ts." setup.ts is deliberately excluded — §4.6 makes it "the only
// season-aware module" by design, not a violation.
const SEASON_AGNOSTIC_MODULES = ['phases.ts', 'score.ts', 'grid.ts', 'market.ts']
const SEASON_IDENTIFIER_PATTERN = /\.season\b|season\s*===|SeasonId/

// Strips `//` line comments before matching — these four files all have
// header comments explicitly DESCRIBING the season-agnostic invariant
// (e.g. "never branches on Card.season"), which would otherwise
// false-positive against the very pattern that documents compliance.
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

// CLAUDE.md's invariant: "Fame is a pure function of the finished grid."
// The Critic's Choice +3 is the one player-level fame rule, and it lives in
// roundFame.ts precisely so scoreGrid stays grid-only. This is a source-level
// grep because the behavioural test below can only prove the seam is intact
// TODAY — the grep is what stops someone reaching for `criticsChoiceHolder`
// inside score.ts the next time a player-level bonus is needed.
describe("the Critic's Choice never reaches scoreGrid", () => {
  test('score.ts does not mention criticsChoiceHolder or the +3 at all', () => {
    const source = readFileSync(join(import.meta.dir, 'score.ts'), 'utf8')
    expect(source).not.toMatch(/criticsChoice/i)
    expect(source).not.toMatch(/finalFlip/i)
  })

  test('score.ts imports nothing from roundFame.ts', () => {
    // The dependency runs one way only: roundFame composes score, never the
    // reverse.
    const source = readFileSync(join(import.meta.dir, 'score.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/roundFame'/)
  })

  test('an identical grid scores identically for the holder and a non-holder', () => {
    const m = buildNewMatch(5, 2)
    const held = { ...m.shared, endgameTriggered: true, criticsChoiceHolder: 'p0' }
    const grid = { total: 14, lines: [] }
    // scoreGrid's own output is untouched by who holds the card...
    expect(roundFame({ playerId: 'p0', lastCheckFame: grid }, held).grid.total).toBe(14)
    expect(roundFame({ playerId: 'p1', lastCheckFame: grid }, held).grid.total).toBe(14)
    // ...the difference lives entirely in the modifiers layer.
    expect(roundFame({ playerId: 'p0', lastCheckFame: grid }, held).total).toBe(17)
    expect(roundFame({ playerId: 'p1', lastCheckFame: grid }, held).total).toBe(14)
  })
})

// §3.7: a 1-player match is the same machine with one seat. It must never
// reach the cross-player machinery, which has no meaning at that size.
describe('a solo match never uses the multiplayer-only paths', () => {
  test('solo is vacuously its own lowest scorer and never consults turn order beyond seat 0', () => {
    const solo = makeMatch(
      createSoloGameState({ seed: 7, startingDeck: ['caterpillar'], toonDeck: [], prices: [3], fameToTriggerEndgame: 30 }),
    )
    expect(solo.turnOrder).toHaveLength(1)
    expect(strictlyLowestScorerIndex(solo)).toBe(0)
    expect(solo.shared.winCondition).toBe('soloFameTarget')
  })

  test('solo never enters the tiebreak loop — one seat is always uniquely the leader', () => {
    const solo = makeMatch(
      createSoloGameState({ seed: 7, startingDeck: ['caterpillar', 'bee'], toonDeck: [], prices: [3], fameToTriggerEndgame: 30 }),
    )
    const atFinal = { ...solo, shared: { ...solo.shared, phase: 'finalFlip' as const, endgameTriggered: true } }
    const outcome = runMatchFinalFlip(atFinal)
    expect(outcome.tiebreakRounds).toBe(0)
    expect(outcome.winners).toEqual(['p0'])
  })
})

describe('no engine module branches on Card.season (§10)', () => {
  for (const file of SEASON_AGNOSTIC_MODULES) {
    test(`${file} has zero season-identifier hits outside comments`, () => {
      const source = stripLineComments(readFileSync(join(import.meta.dir, file), 'utf8'))
      const hits = source.match(new RegExp(SEASON_IDENTIFIER_PATTERN, 'g')) ?? []
      expect(hits).toEqual([])
    })
  }
})

// actions.ts is the SOLO action surface and carries three house rules that are
// wrong at a table: checkInstantWin (which ends the game the moment fame hits
// the threshold, overriding the rulebook's "the trigger round still plays its
// full Market phase"), the isGuaranteedLoss family, and the atomic flip
// cascade. matchActions.ts reimplements what it needs instead of importing
// them. CLAUDE.md has said so since the split; nothing checked it until now.
describe('the multiplayer action surface stays clear of the solo one', () => {
  test('matchActions.ts imports nothing from actions.ts', () => {
    const source = readFileSync(join(import.meta.dir, 'matchActions.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/actions'/)
  })

  test('match.ts imports nothing from actions.ts either', () => {
    const source = readFileSync(join(import.meta.dir, 'match.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/actions'/)
  })
})
