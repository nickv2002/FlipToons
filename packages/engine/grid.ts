// The grid model, per flip-toonz-structure-plan.md §4.3:
//   Slot = { cards: CardId[]; faceUp: boolean[] }   // bottom -> top
//   Grid = { base: 2x3 slots; extraRows: 3-wide rows stacked above base,
//            grown lazily, none of the six }
//
// This module is season-agnostic (plan §10's "no engine module branches on
// season" rule) — it takes CardIds and never looks at Card.season.

import type { Card, CardId } from './cards/types'
import type { Grid, GridPos, Slot } from './types'

const ROWS = 2
const COLS = 3

export function emptyGrid(): Grid {
  return {
    base: Array.from({ length: ROWS }, () => Array<Slot | null>(COLS).fill(null)),
    extraRows: [],
  }
}

// Deep copy — every Slot (and its cards/faceUp arrays) is a fresh object,
// so mutating the clone (e.g. phases.ts's dismiss, which needs to remove a
// single card from a slot without disturbing the GameState it was copied
// from) never reaches back into the original. Needed once a Grid lives
// inside a GameState that gets spread-copied on every phase transition
// (`{...state, grid: ...}`) — a shallow copy would still share every Slot
// object between "different" states.
function cloneSlot(slot: Slot | null): Slot | null {
  return slot === null ? null : { cards: slot.cards.slice(), faceUp: slot.faceUp.slice() }
}

export function cloneGrid(grid: Grid): Grid {
  return {
    base: grid.base.map((row) => row.map(cloneSlot)),
    extraRows: grid.extraRows.map((row) => row.map(cloneSlot)),
  }
}

// isFull(grid) = every base slot is occupied. This is the Flip loop
// condition — extraRows is deliberately not part of it (§4.3), and this
// checks base-slot occupancy directly rather than counting cards flipped, so
// it stays correct once stacking/relocation extend a round past six cards.
export function isFull(grid: Grid): boolean {
  return grid.base.every((row) => row.every((slot) => slot !== null))
}

// The next unoccupied base slot, filled left-to-right, top row then bottom
// row (reading order), per §3.3. Returns null once the grid is full.
export function nextEmptyBaseSlot(grid: Grid): { row: number; col: number } | null {
  for (let row = 0; row < grid.base.length; row++) {
    for (let col = 0; col < grid.base[row].length; col++) {
      if (grid.base[row][col] === null) return { row, col }
    }
  }
  return null
}

export function getSlot(grid: Grid, pos: GridPos): Slot | null {
  // Out of range reads as "no slot there" in BOTH sections, never a throw.
  // The extra-row arm has always been lazy-growth tolerant (below); the base
  // arm used to index straight in, so an off-grid row threw a TypeError on
  // `undefined[col]`. That matters because a GridPos can arrive from a client
  // action (actions.ts / matchActions.ts dismiss), where an out-of-range one
  // is a player mistake to be reported, not an engine fault to be shouted
  // about — and the call sites read the slot BEFORE entering their try.
  if (pos.section === 'base') return grid.base[pos.row]?.[pos.col] ?? null
  // A row that hasn't been created yet (pos.row >= extraRows.length) simply
  // has no slot there — same as any other null — so callers can freely probe
  // "is there anything above the top row" without special-casing lazy growth.
  if (pos.row >= grid.extraRows.length) return null
  return grid.extraRows[pos.row]?.[pos.col] ?? null
}

// Grows `extraRows` with empty rows, if needed, so index `row` exists.
function ensureExtraRow(grid: Grid, row: number): void {
  while (grid.extraRows.length <= row) {
    grid.extraRows.push(Array<Slot | null>(COLS).fill(null))
  }
}

export function setSlot(grid: Grid, pos: GridPos, slot: Slot | null): void {
  if (pos.section === 'base') {
    grid.base[pos.row][pos.col] = slot
    return
  }
  ensureExtraRow(grid, pos.row)
  grid.extraRows[pos.row][pos.col] = slot
}

// ROW-ORDERING READING (task §2 — this is the implemented reading, not yet
// directly confirmed by the user, flagged the same way the Return
// destination question was flagged before its confirmation):
//
// Per the Season 2 FAQ (quoted in Gorilla's card data): "the extra row is
// not itself considered 'the upper row', and if a card is already above the
// gorilla/monkey, the new row forms above that card instead — extra rows
// stack." Read literally, "above THAT CARD" pins the new row to the SAME
// COLUMN as the existing occupant, not to a different column in the
// existing row. So: a relocating card targeting column `col` walks straight
// UP column `col` (only that column, not the whole row) to the first empty
// row, growing a new row if every existing row already has an occupant in
// that column. It does NOT look for free space sideways in an existing row.
//
// Concrete case from the task: Gorilla in base row 0 col C, with a card
// already sitting in extraRows[0][C] (from an earlier Monkey/Gorilla). The
// newly relocated card goes to extraRows[1][C] — directly above the
// existing occupant, growing a second row — not to extraRows[0] at some
// other column. That's what this function implements.
export function extraRowSlotAbove(grid: Grid, col: number): GridPos {
  let row = 0
  while (getSlot(grid, { section: 'extra', row, col }) !== null) row++
  return { section: 'extra', row, col }
}

// Every position in column `col`, top to bottom: highest extra row first
// (extraRows stack upward — extraRows[N-1] is the topmost), down through
// extraRows[0], then base row 0, then base row 1 (the "lower row" per
// Donkey's card text). Used by Grasshopper/Spider's column-count bonuses
// (§4.4 GridQuery 'cardAboveInColumn'/'cardBelowInColumn') to walk the whole
// column regardless of how many extra rows currently exist.
export function columnPositions(grid: Grid, col: number): GridPos[] {
  const result: GridPos[] = []
  for (let row = grid.extraRows.length - 1; row >= 0; row--) result.push({ section: 'extra', row, col })
  for (let row = 0; row < ROWS; row++) result.push({ section: 'base', row, col })
  return result
}

// Places a single face-up card into a slot, creating the slot if empty or
// stacking on top ("new stacked cards always go on top", §3.3a) if occupied.
export function placeCardFaceUp(grid: Grid, pos: GridPos, cardId: CardId): void {
  const existing = getSlot(grid, pos)
  if (existing === null) {
    setSlot(grid, pos, { cards: [cardId], faceUp: [true] })
  } else {
    existing.cards.push(cardId)
    existing.faceUp.push(true)
  }
}

// Orthogonal neighbours of `pos`, per §4.3: "adjacent(pos) = orthogonal
// neighbours only, across extraRows and base as one 3-wide column stack. A
// card in an extra row is adjacent to whatever sits directly below it in the
// same column — base row 0 for extraRows[0], the extra row below it for
// every row above that — forming a VERTICAL CHAIN, not a mutual adjacency
// across every extra row (task §3: "a card in extraRows[1] col C should be
// adjacent to extraRows[0] col C, which is adjacent to base row 0 col C").
// Diagonals are never adjacent (§3.3a keyword glossary).
//
// This always returns the position one row up/down/sideways regardless of
// whether that row has actually been created yet (extraRows.length) —
// harmless, since a not-yet-created row's getSlot() is null and contributes
// no face-up card to any query; see grid.ts's getSlot. Symmetric with the
// original design where a single fixed-size extraRow always "existed" as a
// potential (usually-empty) position.
export function adjacentPositions(grid: Grid, pos: GridPos): GridPos[] {
  const result: GridPos[] = []

  if (pos.section === 'base') {
    const { row, col } = pos
    if (col > 0) result.push({ section: 'base', row, col: col - 1 })
    if (col < COLS - 1) result.push({ section: 'base', row, col: col + 1 })
    if (row > 0) result.push({ section: 'base', row: row - 1, col })
    if (row < ROWS - 1) result.push({ section: 'base', row: row + 1, col })
    // extraRows[0] sits directly above base row 0
    if (row === 0) result.push({ section: 'extra', row: 0, col })
  } else {
    const { row, col } = pos
    if (col > 0) result.push({ section: 'extra', row, col: col - 1 })
    if (col < COLS - 1) result.push({ section: 'extra', row, col: col + 1 })
    result.push({ section: 'extra', row: row + 1, col }) // the row above, if any
    // the row below: base row 0 for extraRows[0], the extra row below it otherwise
    if (row === 0) result.push({ section: 'base', row: 0, col })
    else result.push({ section: 'extra', row: row - 1, col })
  }

  return result
}

// Stack expansion: "All cards in a stack are considered adjacent to cards in
// neighboring spaces" (§3.3a) — but cards within a single stack are NOT
// adjacent to each other. So the adjacent *cards* of a position are every
// face-up card in every neighbouring slot, not the position's own stack.
export function adjacentFaceUpCardIds(grid: Grid, pos: GridPos): CardId[] {
  const ids: CardId[] = []
  for (const neighborPos of adjacentPositions(grid, pos)) {
    const slot = getSlot(grid, neighborPos)
    if (slot === null) continue
    for (let i = 0; i < slot.cards.length; i++) {
      if (slot.faceUp[i]) ids.push(slot.cards[i])
    }
  }
  return ids
}

// All (pos, slot) pairs across base + extraRows that are occupied, in
// reading order: base row-major, then extraRows bottom-to-top, each row
// left-to-right. (flip.ts's findLowestRankTarget/findRabbitOrFaceDownTarget-
// style callers rely on this order as their tiebreak.)
// Lowest-rank FACE-UP card anywhere in the grid (base + extraRows, stacks
// expanded), reading-order tiebreak — the same convention flip.ts's own
// findLowestRankTarget (Zebra) uses. Grown for Group 2's Vulture
// (dismissLowestRankInGrid, phases.ts's runPostMarketHooks). NOTE
// (deviation from the plan's illustrative sketch, and from the advisor
// guidance this pass followed): flip.ts's findLowestRankTarget is NOT
// refactored to call this — it returns a CardPointer shape entangled with
// flip.ts's own relocation/return machinery, and forcing the two to share
// one implementation risked destabilizing already-passing flip tests for a
// pass whose actual scope is Market-phase cards. This is accepted,
// reported duplication, not an oversight.
export function findLowestRankFaceUpCard(grid: Grid, cardsById: Record<CardId, Card>): { pos: GridPos; index: number; cardId: CardId } | null {
  let best: { pos: GridPos; index: number; cardId: CardId } | null = null
  let bestRank = Infinity
  for (const { pos, slot } of occupiedSlots(grid)) {
    for (let i = 0; i < slot.cards.length; i++) {
      if (!slot.faceUp[i]) continue
      const cardId = slot.cards[i]
      const rank = cardsById[cardId].rank
      if (rank < bestRank) {
        bestRank = rank
        best = { pos, index: i, cardId }
      }
    }
  }
  return best
}

export function occupiedSlots(grid: Grid): { pos: GridPos; slot: Slot }[] {
  const result: { pos: GridPos; slot: Slot }[] = []
  for (let row = 0; row < grid.base.length; row++) {
    for (let col = 0; col < grid.base[row].length; col++) {
      const slot = grid.base[row][col]
      if (slot !== null) result.push({ pos: { section: 'base', row, col }, slot })
    }
  }
  for (let row = 0; row < grid.extraRows.length; row++) {
    for (let col = 0; col < grid.extraRows[row].length; col++) {
      const slot = grid.extraRows[row][col]
      if (slot !== null) result.push({ pos: { section: 'extra', row, col }, slot })
    }
  }
  return result
}

// A GridPos as a log line reads it. Deliberately 0-indexed and raw: these
// strings go into the resolve log next to engine output, not onto a card in
// the UI (EffectChoicePrompt renders its own 1-indexed "Row 1 · Col 2" form
// for players choosing a target). Lived in four byte-identical copies —
// flip.ts, phases.ts, actions.ts and the web's FameBreakdown — which is three
// places for the format to drift out from under the log's own readers.
export function posLabel(pos: GridPos): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}
