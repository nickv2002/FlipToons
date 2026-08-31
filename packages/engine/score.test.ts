import { describe, expect, test } from 'bun:test'
import { cardsById } from './setup'
import { emptyGrid, placeCardFaceUp } from './grid'
import { scoreGrid, findFameLine, roundFameLookup } from './score'
import type { Grid } from './types'

const cards = cardsById()

// Fixed grid, per §4.5's known fame values:
//   Snail=2, Caterpillar=0 (x2), Skunk=0, Dragonfly=0+bonus, Bee=1
//
//   row 0:  Bee        Dragonfly   Snail
//   row 1:  Snail      Caterpillar Skunk
//
// Wait — only one Snail exists in the starting deck. Use the actual six:
// 2x Caterpillar, 1x Skunk, 1x Dragonfly, 1x Bee, 1x Snail.
function buildFixedGrid(placeOrder: { row: number; col: number; cardId: string }[]): Grid {
  const grid = emptyGrid()
  for (const { row, col, cardId } of placeOrder) {
    placeCardFaceUp(grid, { section: 'base', row, col }, cardId)
  }
  return grid
}

// row 0: bee        dragonfly   caterpillar
// row 1: caterpillar snail      skunk
const arrangement = [
  { row: 0, col: 0, cardId: 'bee' },
  { row: 0, col: 1, cardId: 'dragonfly' },
  { row: 0, col: 2, cardId: 'caterpillar' },
  { row: 1, col: 0, cardId: 'caterpillar' },
  { row: 1, col: 1, cardId: 'snail' },
  { row: 1, col: 2, cardId: 'skunk' },
]

describe('scoreGrid — hand-computed totals', () => {
  test('scores each of the six starting cards correctly', () => {
    const grid = buildFixedGrid(arrangement)
    const breakdown = scoreGrid(grid, cards)

    const byCardAndPos = new Map(breakdown.lines.map((l) => [`${l.pos.section === 'base' ? `${l.pos.row},${l.pos.col}` : ''}`, l]))

    const bee = byCardAndPos.get('0,0')!
    expect(bee.name).toBe('Bee')
    expect(bee.total).toBe(1)

    // Dragonfly at (0,1) is adjacent to bee (0,0), caterpillar (0,2), and
    // snail (1,1) — three distinct names, diagonals (caterpillar at 1,0 and
    // skunk at 1,2) excluded.
    const dragonfly = byCardAndPos.get('0,1')!
    expect(dragonfly.name).toBe('Dragonfly')
    expect(dragonfly.base).toBe(0)
    expect(dragonfly.total).toBe(3)

    const caterpillarTopRight = byCardAndPos.get('0,2')!
    expect(caterpillarTopRight.name).toBe('Caterpillar')
    expect(caterpillarTopRight.total).toBe(0)

    const caterpillarBottomLeft = byCardAndPos.get('1,0')!
    expect(caterpillarBottomLeft.name).toBe('Caterpillar')
    expect(caterpillarBottomLeft.total).toBe(0)

    const snail = byCardAndPos.get('1,1')!
    expect(snail.name).toBe('Snail')
    expect(snail.total).toBe(2)

    const skunk = byCardAndPos.get('1,2')!
    expect(skunk.name).toBe('Skunk')
    expect(skunk.total).toBe(0) // postFameHook intentionally not applied here (§10)

    expect(breakdown.total).toBe(1 + 3 + 0 + 0 + 2 + 0)
  })

  // §10: "scoreGrid is a pure function: the same grid scores identically
  // regardless of the order cards were placed in. This is the direct test
  // of correction #1 and the one most worth having." buildFixedGrid places
  // cards in `arrangement`'s order; this test places the SAME six cards at
  // the SAME positions in reverse order and asserts an identical breakdown.
  test('scores identically regardless of the order the cards were placed in', () => {
    const forward = scoreGrid(buildFixedGrid(arrangement), cards)
    const reversed = scoreGrid(buildFixedGrid(arrangement.slice().reverse()), cards)
    expect(reversed).toEqual(forward)
  })

  // The Flip-phase side of a partial grid (short deck -> null base slots) is
  // tested in flip.test.ts; this is the scoring-phase side, untested until
  // now — a grid scoreGrid has never actually seen with empty slots.
  test('scores a partial grid (some base slots null) without throwing, and empty slots contribute nothing', () => {
    const grid = buildFixedGrid(arrangement.slice(0, 4)) // only 4 of 6 slots filled
    expect(grid.base[1][1]).toBeNull()
    expect(grid.base[1][2]).toBeNull()
    expect(() => scoreGrid(grid, cards)).not.toThrow()
    const breakdown = scoreGrid(grid, cards)
    expect(breakdown.lines.length).toBe(4)
    expect(breakdown.total).toBe(breakdown.lines.reduce((sum, l) => sum + l.total, 0))
  })

  test('Dragonfly adjacent to two identical Caterpillars counts them once, not twice', () => {
    // row 0: caterpillar  dragonfly  caterpillar
    // row 1: bee          snail      skunk
    const grid = buildFixedGrid([
      { row: 0, col: 0, cardId: 'caterpillar' },
      { row: 0, col: 1, cardId: 'dragonfly' },
      { row: 0, col: 2, cardId: 'caterpillar' },
      { row: 1, col: 0, cardId: 'bee' },
      { row: 1, col: 1, cardId: 'snail' },
      { row: 1, col: 2, cardId: 'skunk' },
    ])
    const breakdown = scoreGrid(grid, cards)
    const dragonfly = breakdown.lines.find((l) => l.cardId === 'dragonfly')!

    // Adjacent to dragonfly (0,1): caterpillar (0,0), caterpillar (0,2), snail (1,1).
    // Distinct names: {Caterpillar, Snail} = 2, NOT 3.
    expect(dragonfly.total).toBe(2)
  })

  test('Dragonfly counts every face-up member of an adjacent stack, not just the top card', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'dragonfly')
    // stack bee + snail in the adjacent slot, both face-up
    grid.base[0][0] = { cards: ['bee', 'snail'], faceUp: [true, true] }
    let breakdown = scoreGrid(grid, cards)
    let dragonfly = breakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(dragonfly.total).toBe(2) // Bee, Snail — 2 distinct names

    // add a third, face-down member — must not change the count
    grid.base[0][0]!.cards.push('caterpillar')
    grid.base[0][0]!.faceUp.push(false)
    breakdown = scoreGrid(grid, cards)
    dragonfly = breakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(dragonfly.total).toBe(2)
  })

  test('extraRows cards score, and a base row-0 card counts an occupied extraRows[0] neighbour', () => {
    const grid = emptyGrid()
    grid.extraRows[0] = [null, { cards: ['snail'], faceUp: [true] }, null]
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'dragonfly')

    const breakdown = scoreGrid(grid, cards)
    const snailLine = breakdown.lines.find((l) => l.cardId === 'snail')!
    expect(snailLine.total).toBe(2)

    const dragonflyLine = breakdown.lines.find((l) => l.cardId === 'dragonfly')!
    expect(dragonflyLine.total).toBe(1) // Snail is its only adjacent name (via extraRows[0])

    expect(breakdown.total).toBe(3)
  })

  test('a card marked unencodable (effect-incomplete, not fame-incomplete) scores its fame normally', () => {
    // Eagle is `unencodable: true` in season1.ts (its onPlace effect target
    // machinery notwithstanding — see flip-effects.test.ts), but its fame
    // (base 4, no bonuses) is fully known. scoreGrid must NOT blank it —
    // that's the whole point of splitting `unencodable` from
    // `fameUnencodable` (see cards/types.ts's Card comment).
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'eagle')
    const breakdown = scoreGrid(grid, cards)
    const eagleLine = breakdown.lines.find((l) => l.cardId === 'eagle')!
    expect(eagleLine.needsRuling).toBeUndefined()
    expect(eagleLine.base).toBe(4)
    expect(eagleLine.total).toBe(4)
    expect(breakdown.total).toBe(4)
  })

  describe('Cow — deterministic max-of-adjacent-fame (per direct user ruling)', () => {
    test('copies the HIGHEST adjacent fame, not the first or a fixed one', () => {
      // row 0: cow(base[0][0])  bee(=1, base[0][1])   snail(=2, base[0][2])
      // row 1: (empty)          skunk(=0, base[1][1]) (empty)
      // Cow at (0,0) is adjacent to bee (0,1) [=1] and... nothing else
      // face-up in base (row 1,0 is empty). Use a richer arrangement so Cow
      // has multiple candidates to choose the max from.
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cow')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee') // fame 1
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'snail') // fame 2
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 1 }, 'skunk') // fame 0

      const breakdown = scoreGrid(grid, cards)
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.needsRuling).toBeUndefined()
      expect(cowLine.base).toBe(2) // snail's 2, the max of {bee:1, snail:2, skunk:0}
      expect(cowLine.total).toBe(2)
      expect(cowLine.copiedFrom?.cardId).toBe('snail')
      expect(breakdown.total).toBe(1 + 2 + 0 + 2) // bee + snail + skunk + cow's copied 2
    })

    test('adjacent to a stack: takes the max across every face-up stack member, not just the top', () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cow')
      // stack bee (fame 1) then snail (fame 2) at (0,0) — snail is on top
      grid.base[0][0] = { cards: ['bee', 'snail'], faceUp: [true, true] }

      const breakdown = scoreGrid(grid, cards)
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.total).toBe(2)
      expect(cowLine.copiedFrom?.cardId).toBe('snail')

      // now stack a THIRD card, snail (fame 2) again but face-DOWN on top —
      // must not be considered, and must not change the result
      grid.base[0][0]!.cards.push('snail')
      grid.base[0][0]!.faceUp.push(false)
      const breakdown2 = scoreGrid(grid, cards)
      const cowLine2 = breakdown2.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine2.total).toBe(2)
    })

    test('no adjacent face-up cards: needsRuling rather than a guessed default', () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cow')
      const breakdown = scoreGrid(grid, cards)
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.needsRuling).toBe(true)
      expect(cowLine.total).toBe(0)
      expect(breakdown.total).toBe(0)
    })

    test('Cow adjacent to Cow resolves through the chain once a non-Cow anchor is present', () => {
      // row 0: bee(fame1)  cowA        cowB
      // row 1: (empty)     (empty)     snail(fame2)
      // cowA is adjacent to bee(1) and cowB; cowB is adjacent to cowA and
      // snail(2). Neither is a genuine cycle — each has a non-Cow neighbor
      // reachable through the pair — so BOTH converge to 2, the highest
      // fame reachable anywhere in the connected chain: cowB can reach 2
      // directly from snail; cowA can only reach 2 by way of cowB once
      // cowB's value is known. This is why resolution is a value
      // RELAXATION (monotone max propagation, like Bellman-Ford), not a
      // single "wait until every neighbor is settled" pass — the latter
      // would deadlock on this exact mutual case.
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cow')
      const cowB = 'cow' // same id — Cow has copies:1 in season1.ts, but the
      // grid model doesn't enforce deck composition, so two Cow instances on
      // one grid is a legal (if not deck-legal) state to test the resolver.
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, cowB)
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'snail')

      const breakdown = scoreGrid(grid, cards)
      const cowLines = breakdown.lines.filter((l) => l.cardId === 'cow')
      expect(cowLines).toHaveLength(2)
      const atColA = cowLines.find((l) => l.pos.section === 'base' && l.pos.col === 1)!
      const atColB = cowLines.find((l) => l.pos.section === 'base' && l.pos.col === 2)!
      expect(atColA.needsRuling).toBeUndefined()
      expect(atColA.total).toBe(2) // reaches snail's 2 via cowB, beating its direct neighbor bee=1
      expect(atColB.needsRuling).toBeUndefined()
      expect(atColB.total).toBe(2) // max(cowA, snail=2)
    })

    test('a true Cow-only cycle (no non-Cow anchor anywhere in the chain) is needsRuling, not a crash or an arbitrary fixed point', () => {
      // Two Cows adjacent only to each other and to nothing else face-up.
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cow')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cow')
      const breakdown = scoreGrid(grid, cards)
      const cowLines = breakdown.lines.filter((l) => l.cardId === 'cow')
      expect(cowLines).toHaveLength(2)
      for (const line of cowLines) {
        expect(line.needsRuling).toBe(true)
        expect(line.total).toBe(0)
      }
      expect(breakdown.total).toBe(0)
    })
  })

  test('face-down cards contribute nothing', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['snail'], faceUp: [false] }
    const breakdown = scoreGrid(grid, cards)
    expect(breakdown.total).toBe(0)
    expect(breakdown.lines).toHaveLength(0)
  })
})

// Newly-implemented fame-bonus condition/query handlers, per the fame-audit
// task: every condition/query string in season1.ts/season2.ts that
// previously had no evaluateBonus handler at all (and so would have thrown,
// crashing scoreGrid for ANY grid containing that card) now either has a
// real handler (tested below) or is marked fameUnencodable (tested in the
// last block here).
describe('fame-audit: newly-implemented condition/query handlers', () => {
  test('Sheep — inMiddleColumn: +4 in the middle column, +0 elsewhere', () => {
    const gridMiddle = emptyGrid()
    placeCardFaceUp(gridMiddle, { section: 'base', row: 0, col: 1 }, 'sheep')
    expect(scoreGrid(gridMiddle, cards).lines[0].total).toBe(1 + 4)

    const gridSide = emptyGrid()
    placeCardFaceUp(gridSide, { section: 'base', row: 0, col: 0 }, 'sheep')
    expect(scoreGrid(gridSide, cards).lines[0].total).toBe(1)
  })

  test("Rooster — perCardRank13OrLowerIncludingSelf: a PER-count bonus, not the flat +1 the old ifCondition encoding would have given regardless of count", () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'rooster') // rank 13, counts itself
    let rooster = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'rooster')!
    expect(rooster.total).toBe(0 + 1 * 1) // just itself

    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'donkey') // rank 3, also <= 13
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'lion') // rank 16, > 13 — must NOT count
    rooster = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'rooster')!
    expect(rooster.total).toBe(0 + 1 * 2) // rooster + donkey, not lion — proves it's a count, not a flat bonus
  })

  test('Hen — perCardRank6OrHigherIncludingSelf: same PER-count fix as Rooster', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'hen') // rank 6, counts itself
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'mosquito') // rank 0, < 6 — must NOT count
    let hen = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'hen')!
    expect(hen.total).toBe(0 + 1 * 1)

    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'starfish') // rank 7, >= 6
    hen = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'hen')!
    expect(hen.total).toBe(0 + 1 * 2)
  })

  test('Lion — allFaceUpAdjacentRank16OrLower: vacuously true with no adjacent face-up cards', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'lion')
    const lion = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'lion')!
    expect(lion.total).toBe(3 + 4)
  })

  test('Lion — false once an adjacent face-up card is above rank 16', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'lion')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'turkey') // rank 20 > 16
    const lion = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'lion')!
    expect(lion.total).toBe(3)
  })

  test('Lion — true when every adjacent face-up card is rank 16 or lower', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'lion')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'donkey') // rank 3
    const lion = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'lion')!
    expect(lion.total).toBe(3 + 4)
  })

  test('Bull — atLeastOneFaceDownCardInGrid', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bull')
    let bull = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'bull')!
    expect(bull.total).toBe(3)

    grid.base[0][1] = { cards: ['snail'], faceUp: [false] }
    bull = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'bull')!
    expect(bull.total).toBe(3 + 7)
  })

  test('Deer — allFaceUpGridCardsUnique', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'deer')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
    let deer = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'deer')!
    expect(deer.total).toBe(3 + 5)

    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'bee') // duplicate name
    deer = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'deer')!
    expect(deer.total).toBe(3)
  })

  test('Bear — faceUpGridCard: counts every face-up card in the grid, including itself', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bear')
    let bear = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'bear')!
    expect(bear.total).toBe(1 + 1 * 1) // itself only

    placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'bee') // far away — not adjacency-based
    grid.base[0][1] = { cards: ['snail'], faceUp: [false] } // face-down — must not count
    bear = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'bear')!
    expect(bear.total).toBe(1 + 1 * 2) // bear + bee, not the face-down snail
  })

  test('Sloth — gridHasAtLeastEightCards: counts EVERY card including face-down, unlike Bear', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'sloth')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'snail')
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'skunk')
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 1 }, 'caterpillar')
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'dragonfly')
    let sloth = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'sloth')!
    expect(sloth.total).toBe(3) // 6 cards, below 8

    // stack two more (one face-down) to reach 8 total cards
    grid.base[0][1]!.cards.push('caterpillar')
    grid.base[0][1]!.faceUp.push(false)
    grid.base[0][2]!.cards.push('caterpillar')
    grid.base[0][2]!.faceUp.push(true)
    sloth = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'sloth')!
    expect(sloth.total).toBe(3 + 5) // 8 cards total (face-down one still counts as a card)
  })

  test('Clownfish — adjacentToAtLeastOneFishCard', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'clownfish')
    let clownfish = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'clownfish')!
    expect(clownfish.total).toBe(3)

    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'goldfish')
    clownfish = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'clownfish')!
    expect(clownfish.total).toBe(3 + 2)
  })

  test('Goldfish — fishTypeCard: counts every fish card in the grid, including itself', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'goldfish')
    let goldfish = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'goldfish')!
    expect(goldfish.total).toBe(1 + 1 * 1)

    placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'clownfish') // far away, still counts
    goldfish = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'goldfish')!
    expect(goldfish.total).toBe(1 + 1 * 2)
  })

  test('Shark — fishTypeCard: excludes itself (FAQ: the shark is not itself a fish type card)', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'shark')
    let shark = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'shark')!
    expect(shark.total).toBe(3) // no fish cards other than itself

    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'goldfish')
    shark = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'shark')!
    expect(shark.total).toBe(3 + 1) // goldfish only
  })

  test('Rhinoceros — adjacentOddRankCard', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'rhinoceros')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'donkey') // rank 3, odd
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'butterfly') // rank 4, even
    const rhino = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'rhinoceros')!
    expect(rhino.total).toBe(1 + 3 * 1) // only donkey counts
  })

  test('Hippopotamus — remainingDeckCard: needs remainingDeckSize threaded through scoreGrid', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'hippopotamus')

    expect(() => scoreGrid(grid, cards)).toThrow(/remainingDeckSize/)

    const breakdown = scoreGrid(grid, cards, 5)
    const hippo = breakdown.lines.find((l) => l.cardId === 'hippopotamus')!
    expect(hippo.total).toBe(0 + 2 * 5)
  })

  test('Capybara — atLeastThreeCardsRemainingInDeck: needs remainingDeckSize threaded through scoreGrid', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'capybara')

    expect(() => scoreGrid(grid, cards)).toThrow(/remainingDeckSize/)

    expect(scoreGrid(grid, cards, 2).lines[0].total).toBe(2) // below 3 — no bonus
    expect(scoreGrid(grid, cards, 3).lines[0].total).toBe(2 + 4) // at least 3 — bonus
  })

  test('Grasshopper — cardAboveInColumn: counts cards in the column above it (extraRows + base row 0), not its own slot', () => {
    const grid = emptyGrid()
    grid.base[1][0] = { cards: ['grasshopper'], faceUp: [true] }
    grid.base[0][0] = { cards: ['bee'], faceUp: [true] } // base row 0 — above base row 1
    grid.extraRows.push([{ cards: ['snail', 'mosquito'], faceUp: [false, true] }, null, null]) // extraRows[0] — above base row 0; face-down still counts
    const grasshopper = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'grasshopper')!
    expect(grasshopper.total).toBe(1 + 1 * 3) // bee (1) + snail/mosquito (2) above, regardless of face state

    // Cards stacked in Grasshopper's own slot don't count — only the column does.
    const gridSameSlot = emptyGrid()
    gridSameSlot.base[1][0] = { cards: ['bee', 'grasshopper'], faceUp: [true, true] }
    const gh2 = scoreGrid(gridSameSlot, cards).lines.find((l) => l.cardId === 'grasshopper')!
    expect(gh2.total).toBe(1)
  })

  test('Spider — cardBelowInColumn: counts cards in the column below it (base row 1), not its own slot', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['spider'], faceUp: [true] }
    grid.base[1][0] = { cards: ['bee', 'snail'], faceUp: [true, false] } // base row 1 — below base row 0
    const spider = scoreGrid(grid, cards).lines.find((l) => l.cardId === 'spider')!
    expect(spider.total).toBe(1 + 1 * 2) // bee + snail below, regardless of face state

    // Cards stacked in Spider's own slot don't count — only the column does.
    const gridSameSlot = emptyGrid()
    gridSameSlot.base[0][0] = { cards: ['spider', 'bee'], faceUp: [true, true] }
    const spider2 = scoreGrid(gridSameSlot, cards).lines.find((l) => l.cardId === 'spider')!
    expect(spider2.total).toBe(1)
  })
})

describe('fame-audit: cards marked fameUnencodable because required state does not exist yet', () => {
  // Mirrors the Platypus regression in season2-effects.test.ts: each of
  // these previously had NO evaluateBonus handler for its condition/query,
  // which meant scoreGrid THREW (crashing the whole breakdown, not just
  // this card's line) for any grid containing one. Each now short-circuits
  // via `fameUnencodable` before evaluateBonus is ever called, same as
  // Platypus/Axolotl's Big Button gap — needsRuling, not a crash, and the
  // rest of the grid still scores normally. This also means each card's
  // otherwise-known base fame is blanked, not just its bonus (see the
  // comments on each card in season1.ts/season2.ts).
  const cases: { id: string; name: string }[] = [
    // Dog is deliberately NOT in this list any more — see the Dog-specific
    // dual-branch describe block below. It's fully encodable now via
    // scoreGrid's externalState.dogElsewhere parameter.
    // Cat/Tiger/Opossum are also no longer in this list — see the
    // 'dismissed-pile fame queries' describe block below. They're fully
    // encodable now via scoreGrid's externalState.dismissed parameter.
    // Camel is also no longer in this list — see the Camel describe block
    // below. It's fully encodable now via scoreGrid's
    // externalState.camelMarketCount parameter.
    // Fox is also no longer in this list — see the Fox describe block
    // below. It's fully encodable now via scoreGrid's
    // externalState.henOrRoosterInMarket parameter (or its own grid alone,
    // when a Hen/Rooster is already present there).
  ]

  for (const { id, name } of cases) {
    test(`${name} — needsRuling, not a crash, and doesn't blank the rest of the grid`, () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, id)
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      expect(() => scoreGrid(grid, cards)).not.toThrow()
      const breakdown = scoreGrid(grid, cards)
      const line = breakdown.lines.find((l) => l.cardId === id)!
      expect(line.needsRuling).toBe(true)
      expect(line.total).toBe(0)
      const beeLine = breakdown.lines.find((l) => l.cardId === 'bee')!
      expect(beeLine.needsRuling).toBeUndefined()
      expect(beeLine.total).toBe(1)
    })
  }
})

describe('Dog — dogInMarketOrOtherPlayerGrid, resolved via scoreGrid externalState (not fameUnencodable)', () => {
  test('externalState.dogElsewhere: true scores the +5 bonus', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    const breakdown = scoreGrid(grid, cards, undefined, { dogElsewhere: true })
    const line = breakdown.lines.find((l) => l.cardId === 'dog')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.dualBranch).toBeUndefined()
    expect(line.base).toBe(0)
    expect(line.total).toBe(5)
    expect(breakdown.total).toBe(5)
    expect(breakdown.totalBranches).toBeUndefined()
  })

  test('externalState.dogElsewhere: false scores 0, no bonus', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    const breakdown = scoreGrid(grid, cards, undefined, { dogElsewhere: false })
    const line = breakdown.lines.find((l) => l.cardId === 'dog')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.dualBranch).toBeUndefined()
    expect(line.total).toBe(0)
    expect(breakdown.total).toBe(0)
    expect(breakdown.totalBranches).toBeUndefined()
  })

  test('two Dogs, one grid, dogElsewhere: false — BOTH score 0, not 5 (own-grid exclusion: a second Dog in the SAME grid does not satisfy "elsewhere")', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'dog') // not adjacent to the first — irrelevant to this condition either way
    const breakdown = scoreGrid(grid, cards, undefined, { dogElsewhere: false })
    const dogLines = breakdown.lines.filter((l) => l.cardId === 'dog')
    expect(dogLines).toHaveLength(2)
    for (const line of dogLines) {
      expect(line.total).toBe(0)
    }
    expect(breakdown.total).toBe(0)
  })

  test('externalState omitted entirely — a single Dog reports both branches via dualBranch, not needsRuling', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    const breakdown = scoreGrid(grid, cards)
    const line = breakdown.lines.find((l) => l.cardId === 'dog')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.dualBranch).toBeDefined()
    expect(line.dualBranch).toHaveLength(2)
    expect(line.dualBranch![0].total).toBe(0)
    expect(line.dualBranch![1].total).toBe(5)
    expect(breakdown.totalBranches).toEqual([
      { label: 'if no Dog elsewhere', total: 0 },
      { label: 'if a Dog is present elsewhere', total: 5 },
    ])
  })

  test('externalState omitted, two Dogs in one grid — both branch off the SAME external fact together (0/0 or 5/5), not 2^n combinations', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'dog')
    const breakdown = scoreGrid(grid, cards)
    const dogLines = breakdown.lines.filter((l) => l.cardId === 'dog')
    expect(dogLines).toHaveLength(2)
    for (const line of dogLines) {
      expect(line.dualBranch![0].total).toBe(0)
      expect(line.dualBranch![1].total).toBe(5)
    }
    // false branch: both Dogs at 0 -> grid total 0. true branch: both at 5 -> grid total 10.
    expect(breakdown.totalBranches).toEqual([
      { label: 'if no Dog elsewhere', total: 0 },
      { label: 'if a Dog is present elsewhere', total: 10 },
    ])
  })

  test('omitted externalState alongside a normal card: the normal card scores plainly and is included in both totalBranches sums', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'dog')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee') // fame 1, unaffected by Dog's condition
    const breakdown = scoreGrid(grid, cards)
    const beeLine = breakdown.lines.find((l) => l.cardId === 'bee')!
    expect(beeLine.dualBranch).toBeUndefined()
    expect(beeLine.total).toBe(1)
    expect(breakdown.totalBranches).toEqual([
      { label: 'if no Dog elsewhere', total: 1 }, // 0 (dog) + 1 (bee)
      { label: 'if a Dog is present elsewhere', total: 6 }, // 5 (dog) + 1 (bee)
    ])
  })

  describe('Cow adjacent to an unresolved Dog', () => {
    // Regression: a naive Cow relaxation reads resolvedTotals, which a
    // dualBranch Dog is deliberately NOT added to. Without a guard, a Cow
    // with a second, already-resolved neighbor would silently copy that
    // OTHER neighbor's value and ignore the Dog entirely — wrong in
    // whichever branch the Dog's value would actually have won.
    test('externalState omitted — Cow adjacent to Dog and a lower-fame Snail is needsRuling, not silently copying the Snail', () => {
      const grid = emptyGrid()
      // row 0: cow  dog  bee
      // row 1: snail . .
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cow')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'dog')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'snail') // fame 2, adjacent to cow only
      const breakdown = scoreGrid(grid, cards)
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.needsRuling).toBe(true)
      expect(cowLine.dualBranch).toBeUndefined()
      expect(cowLine.needsRulingReason).toMatch(/Dog/)
    })

    test('externalState.dogElsewhere: true — Cow correctly copies the Dog\'s resolved 5, not the lower Snail', () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cow')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'dog')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'snail')
      const breakdown = scoreGrid(grid, cards, undefined, { dogElsewhere: true })
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.needsRuling).toBeUndefined()
      expect(cowLine.total).toBe(5)
      expect(cowLine.copiedFrom?.cardId).toBe('dog')
    })

    test('externalState.dogElsewhere: false — Cow correctly copies the Snail\'s 2 (Dog resolves to 0)', () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cow')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'dog')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'snail')
      const breakdown = scoreGrid(grid, cards, undefined, { dogElsewhere: false })
      const cowLine = breakdown.lines.find((l) => l.cardId === 'cow')!
      expect(cowLine.needsRuling).toBeUndefined()
      expect(cowLine.total).toBe(2)
      expect(cowLine.copiedFrom?.cardId).toBe('snail')
    })
  })
})

describe('Camel — noOneHasMoreCamelsThanYou, resolved via scoreGrid externalState.camelMarketCount (not fameUnencodable)', () => {
  test('camelMarketCount: 0 (no Camels in the market) — bonus applies, ties count as "no one has more"', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'camel')
    const breakdown = scoreGrid(grid, cards, undefined, { camelMarketCount: 0 })
    const line = breakdown.lines.find((l) => l.cardId === 'camel')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.base).toBe(2)
    expect(line.total).toBe(4)
    expect(breakdown.total).toBe(4)
  })

  test('camelMarketCount equal to your own grid\'s Camel count — still a tie, bonus applies', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'camel')
    const breakdown = scoreGrid(grid, cards, undefined, { camelMarketCount: 1 })
    const line = breakdown.lines.find((l) => l.cardId === 'camel')!
    expect(line.total).toBe(4)
  })

  test('camelMarketCount greater than your own grid\'s Camel count — no bonus, base fame only', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'camel')
    const breakdown = scoreGrid(grid, cards, undefined, { camelMarketCount: 2 })
    const line = breakdown.lines.find((l) => l.cardId === 'camel')!
    expect(line.total).toBe(2)
  })

  test('two Camels in your own grid outnumber a single market Camel — both score the bonus', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'camel')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'camel')
    const breakdown = scoreGrid(grid, cards, undefined, { camelMarketCount: 1 })
    const camelLines = breakdown.lines.filter((l) => l.cardId === 'camel')
    expect(camelLines).toHaveLength(2)
    for (const line of camelLines) expect(line.total).toBe(4)
  })

  test('externalState.camelMarketCount omitted — throws rather than silently scoring 0', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'camel')
    expect(() => scoreGrid(grid, cards)).toThrow(/camelMarketCount/)
  })
})

describe('Fox — henOrRoosterInMarketOrAnyGrid, resolved via scoreGrid externalState.henOrRoosterInMarket (not fameUnencodable)', () => {
  test('a Hen in Fox\'s own grid satisfies the condition — no externalState needed at all', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'fox')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'hen')
    const breakdown = scoreGrid(grid, cards) // no externalState at all
    const line = breakdown.lines.find((l) => l.cardId === 'fox')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.total).toBe(3 + 3) // base 3 + bonus 3
  })

  test('a Rooster in Fox\'s own grid also satisfies it — same as Hen', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'fox')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'rooster')
    const breakdown = scoreGrid(grid, cards)
    const line = breakdown.lines.find((l) => l.cardId === 'fox')!
    expect(line.total).toBe(3 + 3)
  })

  test('no Hen/Rooster in Fox\'s own grid, henOrRoosterInMarket: true — bonus applies', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'fox')
    const breakdown = scoreGrid(grid, cards, undefined, { henOrRoosterInMarket: true })
    const line = breakdown.lines.find((l) => l.cardId === 'fox')!
    expect(line.total).toBe(3 + 3)
  })

  test('no Hen/Rooster in Fox\'s own grid, henOrRoosterInMarket: false — base fame only', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'fox')
    const breakdown = scoreGrid(grid, cards, undefined, { henOrRoosterInMarket: false })
    const line = breakdown.lines.find((l) => l.cardId === 'fox')!
    expect(line.total).toBe(3)
  })

  test('no Hen/Rooster in own grid, externalState.henOrRoosterInMarket omitted — throws rather than silently scoring 0', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'fox')
    expect(() => scoreGrid(grid, cards)).toThrow(/henOrRoosterInMarket/)
  })
})

describe('dismissed-pile fame queries (Cat/Tiger/Opossum), resolved via scoreGrid externalState.dismissed', () => {
  test('Cat — dismissedStartingCard counts only rank-0 dismissed cards', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'cat')
    // 'snail' and 'bee' are rank 0 (starting cards); 'eagle' is rank 2 (a
    // market card) and must not count.
    const breakdown = scoreGrid(grid, cards, undefined, { dismissed: ['snail', 'bee', 'eagle'] })
    const line = breakdown.lines.find((l) => l.cardId === 'cat')!
    expect(line.needsRuling).toBeUndefined()
    expect(line.total).toBe(1 + 2) // base 1 + 2 rank-0 dismissed cards
  })

  test('Tiger — dismissedCard counts any dismissed card, any rank', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'tiger')
    const breakdown = scoreGrid(grid, cards, undefined, { dismissed: ['snail', 'bee', 'eagle'] })
    const line = breakdown.lines.find((l) => l.cardId === 'tiger')!
    expect(line.total).toBe(3 + 3) // base 3 + 3 dismissed cards of any rank
  })

  test('Opossum — dismissedIdenticalPair counts pairs, not singles', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'opossum')
    // Two snails (one pair) and one lone bee (not a pair) — expect exactly
    // one pair counted, not two singles.
    const breakdown = scoreGrid(grid, cards, undefined, { dismissed: ['snail', 'snail', 'bee'] })
    const line = breakdown.lines.find((l) => l.cardId === 'opossum')!
    expect(line.total).toBe(2 + 2) // base 2 + 1 pair * 2
  })

  test('Opossum — three of a kind is still only one pair (floor(3/2) = 1)', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'opossum')
    const breakdown = scoreGrid(grid, cards, undefined, { dismissed: ['snail', 'snail', 'snail'] })
    const line = breakdown.lines.find((l) => l.cardId === 'opossum')!
    expect(line.total).toBe(2 + 2) // base 2 + floor(3/2)=1 pair * 2
  })

  for (const id of ['cat', 'tiger', 'opossum']) {
    test(`${id} — omitting externalState.dismissed throws`, () => {
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, id)
      expect(() => scoreGrid(grid, cards)).toThrow()
    })
  }

  for (const id of ['cat', 'tiger', 'opossum']) {
    test(`${id} — immune: ['dismiss'], so it can never appear in its own dismissed pile (regression)`, () => {
      expect(cards[id].immune).toContain('dismiss')
    })
  }
})

describe('FameLine.stackIndex — disambiguating two lines sharing one slot', () => {
  test('a stacked slot produces two lines with distinct stackIndex, findable independently', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['bee', 'snail'], faceUp: [true, true] }
    const pos = { section: 'base', row: 0, col: 0 } as const
    const breakdown = scoreGrid(grid, cards)

    const beeLine = breakdown.lines.find((l) => l.cardId === 'bee')!
    const snailLine = breakdown.lines.find((l) => l.cardId === 'snail')!
    expect(beeLine.stackIndex).toBe(0)
    expect(snailLine.stackIndex).toBe(1)
    expect(findFameLine(breakdown, pos, 0)).toBe(beeLine)
    expect(findFameLine(breakdown, pos, 1)).toBe(snailLine)
  })

  // Dismissing the lower member of a stack SPLICES slot.cards/slot.faceUp
  // (phases.ts's dismiss), so the survivor's live array index shifts down —
  // no longer matching the FROZEN breakdown's stackIndex for it. Naively
  // looking the survivor up by its new live index would return the
  // DISMISSED card's line: a wrong fame number on a real card, not just a
  // missing badge. roundFameLookup must refuse instead of guessing.
  test('roundFameLookup withholds a slot whose card count no longer matches the snapshot, rather than misattributing a stale stackIndex', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['bee', 'snail'], faceUp: [true, true] }
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'caterpillar')
    const pos0 = { section: 'base', row: 0, col: 0 } as const
    const pos1 = { section: 'base', row: 0, col: 1 } as const
    const breakdown = scoreGrid(grid, cards)

    // Untouched grid: both slots' card counts match the snapshot.
    const lookupBefore = roundFameLookup(breakdown, grid)
    expect(lookupBefore(pos0, 0)).toBe(breakdown.lines.find((l) => l.cardId === 'bee')!.total)
    expect(lookupBefore(pos0, 1)).toBe(breakdown.lines.find((l) => l.cardId === 'snail')!.total)
    expect(lookupBefore(pos1, 0)).toBe(breakdown.lines.find((l) => l.cardId === 'caterpillar')!.total)

    // Simulate a dismiss of the stack's bottom card (index 0), as
    // phases.ts's dismiss does — splice, not null-out.
    grid.base[0][0]!.cards.splice(0, 1)
    grid.base[0][0]!.faceUp.splice(0, 1)
    expect(grid.base[0][0]!.cards).toEqual(['snail']) // survivor is now live index 0

    const lookupAfter = roundFameLookup(breakdown, grid)
    // The touched slot withholds entirely — no badge, not the bee's stale total.
    expect(lookupAfter(pos0, 0)).toBeUndefined()
    // An untouched slot elsewhere on the same grid is unaffected.
    expect(lookupAfter(pos1, 0)).toBe(breakdown.lines.find((l) => l.cardId === 'caterpillar')!.total)
  })

  // Panther's onPlace ('stackOnPreviousPlaced', season2.ts) APPENDS a card to
  // a slot rather than splicing — the opposite direction from a dismiss.
  // Every stackIndex the breakdown already knows about still points at the
  // same card it always did, so only the newly-appended index (no line for
  // it at all) should come back undefined.
  test('roundFameLookup keeps the original card badge when a new card is stacked ON TOP after the snapshot', () => {
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
    const pos = { section: 'base', row: 0, col: 0 } as const
    const breakdown = scoreGrid(grid, cards)

    // Simulate Panther stacking on top mid-Market-phase, after the breakdown snapshot.
    grid.base[0][0]!.cards.push('bee')
    grid.base[0][0]!.faceUp.push(false)

    const lookupAfter = roundFameLookup(breakdown, grid)
    expect(lookupAfter(pos, 0)).toBe(breakdown.lines.find((l) => l.cardId === 'caterpillar')!.total)
    expect(lookupAfter(pos, 1)).toBeUndefined()
  })

  // A face-down card never gets a breakdown line at all (score.ts only
  // scores face-up cards) — a stack with one anywhere in the middle
  // (Starfish's flipPreviousPlaced, season2.ts) used to have fewer LINES
  // than live cards even when nothing had changed since the snapshot,
  // which a line-count-based staleness check misread as "grown" and
  // blanked every card's badge above the face-down one, including ones
  // with a perfectly valid line waiting for them.
  test('roundFameLookup still finds a card above a face-down stack-mate, untouched since the snapshot', () => {
    const grid = emptyGrid()
    grid.base[0][0] = { cards: ['bee', 'caterpillar', 'snail'], faceUp: [true, false, true] }
    const pos = { section: 'base', row: 0, col: 0 } as const
    const breakdown = scoreGrid(grid, cards)

    const lookup = roundFameLookup(breakdown, grid)
    expect(lookup(pos, 0)).toBe(breakdown.lines.find((l) => l.cardId === 'bee')!.total)
    expect(lookup(pos, 1)).toBeUndefined() // face-down: no line, no badge
    expect(lookup(pos, 2)).toBe(breakdown.lines.find((l) => l.cardId === 'snail')!.total)
  })
})
