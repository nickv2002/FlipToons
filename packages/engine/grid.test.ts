import { describe, expect, test } from 'bun:test'
import { adjacentFaceUpCardIds, adjacentPositions, emptyGrid, getSlot, isFull, nextEmptyBaseSlot, placeCardFaceUp, posLabel } from './grid'

describe('grid', () => {
  test('emptyGrid is not full and has no cards', () => {
    const grid = emptyGrid()
    expect(isFull(grid)).toBe(false)
    expect(nextEmptyBaseSlot(grid)).toEqual({ row: 0, col: 0 })
  })

  test('nextEmptyBaseSlot fills left-to-right, top row then bottom row', () => {
    const grid = emptyGrid()
    const order: { row: number; col: number }[] = []
    for (let i = 0; i < 6; i++) {
      const pos = nextEmptyBaseSlot(grid)!
      order.push(pos)
      placeCardFaceUp(grid, { section: 'base', row: pos.row, col: pos.col }, `card${i}`)
    }
    expect(order).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ])
    expect(isFull(grid)).toBe(true)
    expect(nextEmptyBaseSlot(grid)).toBeNull()
  })

  test('placing a second card on an occupied slot stacks it on top', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'a')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'b')
    const slot = grid.base[0][0]!
    expect(slot.cards).toEqual(['a', 'b'])
    expect(slot.faceUp).toEqual([true, true])
  })

  test('adjacentPositions has no diagonals', () => {
    // center-top (0,1) is adjacent to (0,0), (0,2), (1,1), and extra[1] — not (1,0) or (1,2)
    const grid = emptyGrid()
    const adj = adjacentPositions(grid, { section: 'base', row: 0, col: 1 })
    expect(adj).toContainEqual({ section: 'base', row: 0, col: 0 })
    expect(adj).toContainEqual({ section: 'base', row: 0, col: 2 })
    expect(adj).toContainEqual({ section: 'base', row: 1, col: 1 })
    expect(adj).toContainEqual({ section: 'extra', row: 0, col: 1 })
    expect(adj).not.toContainEqual({ section: 'base', row: 1, col: 0 })
    expect(adj).not.toContainEqual({ section: 'base', row: 1, col: 2 })
  })

  test('extraRows[0] card is adjacent to the base row-0 card in the same column', () => {
    const grid = emptyGrid()
    const adj = adjacentPositions(grid, { section: 'extra', row: 0, col: 2 })
    expect(adj).toContainEqual({ section: 'base', row: 0, col: 2 })
  })

  test('adjacentFaceUpCardIds expands stacks: only face-up members count, and a card is not adjacent to its own stack-mates', () => {
    const grid = emptyGrid()
    // stack two cards in (0,0): one face-up, one face-down
    grid.base[0][0] = { cards: ['x', 'y'], faceUp: [true, false] }
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'z')

    const adjToZ = adjacentFaceUpCardIds(grid, { section: 'base', row: 0, col: 1 })
    expect(adjToZ).toEqual(['x']) // face-down 'y' excluded, face-up 'x' included

    const adjToStack = adjacentFaceUpCardIds(grid, { section: 'base', row: 0, col: 0 })
    expect(adjToStack).toEqual(['z']) // neither x nor y (own stack) appear
  })
})

describe('getSlot bounds', () => {
  // Both dismiss paths (actions.ts, RoundView.tsx) read the slot BEFORE
  // entering the try that turns a bad action into a player-facing log line,
  // and a GridPos can arrive from a client. An off-grid position must read as
  // "nothing there", never throw — the base arm used to index straight in and
  // died on `undefined[col]`.
  test('an off-grid position reads as empty in both sections, without throwing', () => {
    const grid = emptyGrid()
    expect(getSlot(grid, { section: 'base', row: 99, col: 0 })).toBeNull()
    expect(getSlot(grid, { section: 'base', row: 0, col: 99 })).toBeNull()
    expect(getSlot(grid, { section: 'extra', row: 99, col: 0 })).toBeNull()
    expect(getSlot(grid, { section: 'extra', row: 0, col: 99 })).toBeNull()
  })

  test('an in-range empty slot is null and an occupied one comes back', () => {
    const grid = emptyGrid()
    expect(getSlot(grid, { section: 'base', row: 0, col: 0 })).toBeNull()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
    expect(getSlot(grid, { section: 'base', row: 0, col: 0 })?.cards).toEqual(['caterpillar'])
  })
})

describe('posLabel', () => {
  // One definition now, shared by flip.ts, phases.ts, actions.ts and the web's
  // FameBreakdown — it used to be four byte-identical copies. Pinned so the
  // log format cannot drift for only some of its readers.
  test('names base and extra positions distinguishably, 0-indexed', () => {
    expect(posLabel({ section: 'base', row: 1, col: 2 })).toBe('row 1, col 2')
    expect(posLabel({ section: 'extra', row: 0, col: 1 })).toBe('extra row 0, col 1')
  })
})
