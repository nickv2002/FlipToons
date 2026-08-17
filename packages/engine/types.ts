// Grid/deck types for Step 0 (the flip scorer), per flip-toonz-structure-plan.md
// §4.3. This is deliberately a subset of the eventual GameState (§4.2) — no
// phase machine, no players, no market — just what a single Flip + Check Fame
// needs.

import type { CardId } from './cards/types'

// bottom -> top; usually 0 or 1 deep, but a stack can grow (Ostrich, Turkey, ...)
export type Slot = {
  cards: CardId[]
  faceUp: boolean[]
}

export type Grid = {
  base: (Slot | null)[][] // 2 rows x 3 cols — the six slots that must be occupied
  // 3-col-wide rows stacked above `base`, bottom-to-top: extraRows[0] sits
  // directly above base row 0, extraRows[1] above extraRows[0], and so on.
  // Created by Monkey/Gorilla; none of these are among the six base slots.
  // Grown LAZILY — starts as [] and a new row is pushed only when a
  // relocating card needs to land above the current topmost occupied row in
  // its column (see grid.ts's extraRowSlotAbove). A 2-wide fixed array
  // (the old `extraRow: (Slot|null)[]`) could not represent the documented
  // unbounded stacking case (Season 2 FAQ, §3.3/§4.3) — this replaces it.
  extraRows: (Slot | null)[][]
}

export type Deck = CardId[]

// A position in the grid, spanning both `base` and `extraRows` as described
// in §4.3: "adjacent(pos) = orthogonal neighbours only, across extraRows and
// base as one 3-wide column stack." `row` on the 'extra' variant indexes
// into `extraRows` (0 = the row directly above base row 0).
export type GridPos =
  | { section: 'base'; row: number; col: number }
  | { section: 'extra'; row: number; col: number }
