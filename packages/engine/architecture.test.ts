// Source-level architecture checks §10 calls out as "worth a grep in CI" —
// automated here instead of a one-off manual review step, so a regression
// actually fails `bun test` instead of relying on someone remembering to
// grep before merging.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

describe('no engine module branches on Card.season (§10)', () => {
  for (const file of SEASON_AGNOSTIC_MODULES) {
    test(`${file} has zero season-identifier hits outside comments`, () => {
      const source = stripLineComments(readFileSync(join(import.meta.dir, file), 'utf8'))
      const hits = source.match(new RegExp(SEASON_IDENTIFIER_PATTERN, 'g')) ?? []
      expect(hits).toEqual([])
    })
  }
})
