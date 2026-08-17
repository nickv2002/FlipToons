import { describe, expect, test } from 'bun:test'
import { adjacentFaceUpCardIds, adjacentPositions, emptyGrid, isFull, nextEmptyBaseSlot, placeCardFaceUp } from './grid'

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
