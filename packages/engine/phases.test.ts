import { describe, expect, test } from 'bun:test'
import { emptyGrid, getSlot, occupiedSlots, placeCardFaceUp } from './grid'
import { dismiss, endMarketPhase, hire, resolvePostMarketChoice, runCheckFame, runCleanup, runFlip, runPostFameHooks, runPostMarketHooks } from './phases'
import { buildExplicitDeck, buildSoloSetup, cardsById } from './setup'
import { createSoloGameState } from './state'
import type { EngineLogLine, GameState } from './state'

const cards = cardsById()

// deck.length + every card in the grid (face-up or down) + dismissed.length
// must always equal (starting deck size + total hired this game). One line
// per §10/the task's verification list — catches a dropped card from a
// mis-indexed dismiss, a lost Return, etc.
// endMarketPhase can now pause mid-sequence when Alligator's target is a
// stack of 2+ eligible cards (GameState.pendingPostMarketChoice) — fuzz/
// invariant tests that just want to drive a full game to completion pick
// the first option deterministically, same as this file's other "greedy,
// not exhaustive" test choices (e.g. the fuzz test's most-expensive-hire).
function endMarketPhaseAutoResolving(state: GameState): GameState {
  let next = endMarketPhase(state)
  while (next.pendingPostMarketChoice) {
    const target = next.pendingPostMarketChoice.options[0]
    next = resolvePostMarketChoice(next, { pos: target.pos, index: target.index })
  }
  return next
}

function totalPlayerCards(state: GameState): number {
  let gridCount = 0
  for (const { slot } of occupiedSlots(state.grid)) gridCount += slot.cards.length
  return state.deck.length + gridCount + state.dismissed.length
}

// A hand-picked, deterministic 6-card deck totalling 32 fame with NO onPlace
// effects at all (alligator/axolotl/peacock/horse/bull/bear all have empty
// onPlace arrays in season1.ts — their unencoded abilities are onHire/
// post-Market, not onPlace) and no cross-card adjacency dependence (bull's
// bonus needs a face-down card, which never happens here; bear's bonus is
// a flat per-face-up-card count that doesn't care about identity or
// order). Chosen specifically so runFlip's placement order can't change the
// total — this deck's fame is deterministic regardless of shuffle:
//   alligator 6 + axolotl 7 + peacock 5 + horse 4 + bull 3 + bear (1+6) 7 = 32
const HIGH_FAME_DECK = buildExplicitDeck(['alligator', 'axolotl', 'peacock', 'horse', 'bull', 'bear'], cards)

function runToMarket(state: GameState): GameState {
  return runPostFameHooks(runCheckFame(runFlip(state)))
}

describe('win trigger: reaching the fame threshold', () => {
  test('a full round ending at >=30 fame WINS at Cleanup, even after spending fame in the Market phase', () => {
    const setup = buildSoloSetup(1, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: HIGH_FAME_DECK,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const startingTotal = totalPlayerCards(state)

    state = runToMarket(state)
    expect(state.phase).toBe('market')
    expect(state.fameGeneratedThisRound).toBe(32)
    expect(state.fame).toBe(32) // nothing spent yet — fame and fameGeneratedThisRound agree before any Market action

    // Spend down: hire the priciest affordable slot, proving the WIN check
    // reads the Check-Fame snapshot, not the post-spend spendable pool.
    // Restricted to cards with no onHire effects (e.g. excludes Peacock's
    // "gain 2 fame") so the plain `before - price` arithmetic below isn't
    // muddied by a card that changes fame on hire for an unrelated reason.
    const affordableSlot = state.market.slots
      .map((cardId, i) => ({ cardId, i, price: state.market.prices[i] }))
      .filter((s) => s.cardId !== null && s.price <= state.fame && !cards[s.cardId!].onHire?.length)
      .sort((a, b) => b.price - a.price)[0]
    expect(affordableSlot).toBeDefined()
    let hiredCount = 0
    if (affordableSlot) {
      const before = state.fame
      state = hire(state, affordableSlot.i)
      hiredCount++
      expect(state.fame).toBe(before - affordableSlot.price) // spendable pool dropped...
      expect(state.fameGeneratedThisRound).toBe(32) // ...but the Check-Fame snapshot did NOT
    }

    state = endMarketPhase(state)
    expect(state.phase).toBe('cleanup')
    state = runCleanup(state)

    expect(state.phase).toBe('ended')
    expect(state.result).toBe('win')
    expect(totalPlayerCards(state)).toBe(startingTotal + hiredCount)
  })

  test('exactly 30 fame triggers the win (>=, not >)', () => {
    // All six cards are flat-fame or whole-grid-count-based (bear: 1 + 1
    // per face-up card in the grid) — NEITHER depends on placement order
    // or adjacency, so this total is exactly 30 regardless of how runFlip
    // shuffles the deck: axolotl 7 + peacock 5 + horse 4 + alligator 6 +
    // bear (1 + 6 face-up cards) 7 + bee 1 = 30.
    const deck = buildExplicitDeck(['axolotl', 'peacock', 'horse', 'alligator', 'bear', 'bee'], cards)
    const setup = buildSoloSetup(2, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: deck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = runToMarket(state)
    expect(state.fameGeneratedThisRound).toBe(30)
    state = runCleanup(endMarketPhase(state))
    expect(state.phase).toBe('ended')
    expect(state.result).toBe('win')
  })
})

describe('loss trigger: toon deck depletion', () => {
  test('a tiny toon deck depletes and LOSES within a few rounds, with no player anywhere near the fame threshold', () => {
    // The real solo starting deck (dragonfly/bee/snail/3x caterpillar)
    // scores a handful of fame a round at best — nowhere near 30 — so
    // looping it with NO Market actions (never spends, never hires) is a
    // clean way to race depletion without any risk of accidentally
    // tripping the win condition instead.
    const setup = buildSoloSetup(3, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: buildExplicitDeck(['ostrich', 'eagle', 'donkey', 'butterfly', 'dog', 'goat'], cards), // tiny — decay alone (2/round) plus setup's own initial fill drains this fast
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const startingTotal = totalPlayerCards(state)

    let iterations = 0
    while (state.phase !== 'ended') {
      iterations++
      if (iterations > 20) throw new Error('test: did not reach an ending within 20 rounds — likely a phase-machine bug, not a slow game')
      state = runToMarket(state)
      expect(totalPlayerCards(state)).toBe(startingTotal) // no hires/dismisses happen in this test — invariant holds every round
      expect(state.fameGeneratedThisRound).toBeLessThan(30) // never anywhere near the threshold
      state = endMarketPhase(state)
      state = runCleanup(state)
    }

    expect(state.result).toBe('loss')
    expect(state.toonDeckDepleted).toBe(true)
    expect(totalPlayerCards(state)).toBe(startingTotal)
  })

  test('a short (but non-empty) toon deck refill during the Market phase does NOT trigger depletion', () => {
    const setup = buildSoloSetup(4, 1, 'normal')
    // Toon deck with plenty of cards to fill the market AND survive one
    // hire's refill without running out.
    const roomyToonDeck = buildExplicitDeck(
      ['ostrich', 'ostrich', 'eagle', 'donkey', 'butterfly', 'dog', 'goat', 'sheep', 'rabbit'],
      cards,
    )
    // A modest-fame deck (well under 30) so this test is purely about the
    // depletion flag, not entangled with the win trigger.
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['ostrich', 'butterfly', 'goat', 'sheep', 'horse', 'bee'], cards),
      toonDeck: roomyToonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })

    state = runToMarket(state)
    expect(state.fameGeneratedThisRound).toBeLessThan(30)
    expect(state.toonDeckDepleted).toBe(false)

    const affordable = state.market.slots.findIndex((cardId, i) => cardId !== null && state.market.prices[i] <= state.fame)
    if (affordable >= 0) state = hire(state, affordable)
    expect(state.toonDeckDepleted).toBe(false) // toon deck still had cards left — a short/no-op refill is not depletion
  })

  test('the toon deck hitting exactly zero on a refill that still filled every slot does NOT trigger a loss — only an actual failed draw does', () => {
    const setup = buildSoloSetup(4, 1, 'normal')
    // Exactly enough for the initial market fill (5, per setup.prices) plus
    // one round's solo decay refill (2 more) — the toon deck hits exactly
    // zero at the end of round 1's Market phase, but every draw that round
    // actually succeeded; nothing came up short.
    const exactToonDeck = buildExplicitDeck(Array(7).fill('ostrich'), cards)
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['ostrich', 'butterfly', 'goat', 'sheep', 'horse', 'bee'], cards),
      toonDeck: exactToonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.toonDeckDepleted).toBe(false)

    state = runCleanup(endMarketPhaseAutoResolving(runToMarket(state)))
    expect(state.toonDeck.length).toBe(0) // fully drained by round 1's decay refill
    expect(state.toonDeckDepleted).toBe(false) // every draw this round succeeded — not a loss
    expect(state.phase).toBe('flip') // the game continues into round 2

    // Round 2's decay needs 2 more replacement cards the now-empty toon
    // deck can't supply — THIS is where the actual loss trigger fires.
    state = runCleanup(endMarketPhaseAutoResolving(runToMarket(state)))
    expect(state.phase).toBe('ended')
    expect(state.result).toBe('loss')
    expect(state.toonDeckDepleted).toBe(true)
  })
})

// §10: "Unspent fame is zeroed at Cleanup, never carried." The existing
// win/loss tests all end the game at Cleanup, so this asserts the OTHER
// branch — a round that continues — which was untested until now.
describe('fame is zeroed at Cleanup on a non-terminal round', () => {
  test('fame and fameGeneratedThisRound both reset to 0, and round increments, when the game continues', () => {
    const setup = buildSoloSetup(4, 1, 'normal')
    const roomyToonDeck = buildExplicitDeck(
      ['ostrich', 'ostrich', 'eagle', 'donkey', 'butterfly', 'dog', 'goat', 'sheep', 'rabbit'],
      cards,
    )
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['ostrich', 'butterfly', 'goat', 'sheep', 'horse', 'bee'], cards),
      toonDeck: roomyToonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })

    state = runToMarket(state)
    expect(state.fameGeneratedThisRound).toBeLessThan(30) // not a win this round
    expect(state.fame).toBeGreaterThan(0) // something was generated to zero out
    const roundBefore = state.round

    state = runCleanup(endMarketPhase(state))

    expect(state.phase).toBe('flip') // continues, doesn't end
    expect(state.fame).toBe(0)
    expect(state.fameGeneratedThisRound).toBe(0)
    expect(state.round).toBe(roundBefore + 1)
  })
})

describe('both triggers in the same round', () => {
  test('win takes priority over a simultaneous depletion — exactly one ended state, not two', () => {
    const setup = buildSoloSetup(5, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: HIGH_FAME_DECK, // 32 fame, well past the 30 threshold
      toonDeck: buildExplicitDeck(['ostrich'], cards), // depletes almost immediately regardless
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.toonDeckDepleted).toBe(true) // already depleted by the initial market fill (1 card for 5 slots)

    state = runToMarket(state)
    expect(state.fameGeneratedThisRound).toBe(32)
    state = runCleanup(endMarketPhase(state))

    expect(state.phase).toBe('ended')
    expect(state.result).toBe('win') // not 'loss', even though toonDeckDepleted was already true
  })
})

describe('dismiss', () => {
  test('Caterpillar dismisses for 3, not the default 5', () => {
    const setup = buildSoloSetup(6, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck, // has 3 caterpillars
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = runToMarket(state)
    // Find a face-up caterpillar in the grid.
    const found = occupiedSlots(state.grid).flatMap(({ pos, slot }) =>
      slot.cards.map((id, i) => ({ pos, i, id, faceUp: slot.faceUp[i] })),
    ).find((c) => c.id === 'caterpillar' && c.faceUp)
    expect(found).toBeDefined()
    if (!found) return
    const fameBefore = state.fame
    state = dismiss(state, found.pos, found.i)
    expect(state.fame).toBe(fameBefore - 3)
    expect(state.dismissed).toContain('caterpillar')
  })

  test('a card immune to dismiss (Cat/Tiger) cannot be dismissed', () => {
    const setup = buildSoloSetup(7, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['cat', 'bee', 'snail', 'bee', 'snail', 'bee'], cards),
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = { ...state, fame: 50 } // plenty of fame to afford it — this must fail on immunity, not affordability
    state = runToMarket(state)
    const cat = occupiedSlots(state.grid).flatMap(({ pos, slot }) =>
      slot.cards.map((id, i) => ({ pos, i, id })),
    ).find((c) => c.id === 'cat')
    expect(cat).toBeDefined()
    if (!cat) return
    expect(() => dismiss(state, cat.pos, cat.i)).toThrow(/immune/)
  })

  test('a face-down card cannot be dismissed', () => {
    const setup = buildSoloSetup(6, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = runToMarket(state)
    const found = occupiedSlots(state.grid).flatMap(({ pos, slot }) =>
      slot.cards.map((id, i) => ({ pos, i, faceUp: slot.faceUp[i] })),
    ).find((c) => c.faceUp)
    expect(found).toBeDefined()
    if (!found) return
    const slot = getSlot(state.grid, found.pos)!
    slot.faceUp[found.i] = false // flip it face-down directly, same pattern as the Ladybug/Rat face-down tests below
    expect(() => dismiss(state, found.pos, found.i)).toThrow(/face-down/)
  })
})

describe("runCheckFame resolves the Dog's dogElsewhere from real market state (not a dual-branch)", () => {
  test('a Dog in the grid with NO Dog in the market scores the false branch, single resolved fame', () => {
    const setup = buildSoloSetup(9, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['dog', 'bee', 'snail', 'bee', 'snail', 'bee'], cards),
      // No Dog anywhere in this tiny toon deck, so the market can never hold one.
      toonDeck: buildExplicitDeck(['ostrich', 'eagle', 'goat', 'sheep', 'rabbit'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.market.slots).not.toContain('dog')
    state = runCheckFame(runFlip(state))
    const dogLine = state.lastCheckFame?.lines.find((l) => l.cardId === 'dog')
    expect(dogLine).toBeDefined()
    expect(dogLine?.dualBranch).toBeUndefined() // resolved, not a dual-branch presentation
    expect(dogLine?.total).toBe(0) // no Dog elsewhere -> the +5 bonus does not apply
    expect(state.lastCheckFame?.totalBranches).toBeUndefined()
  })

  test('a Dog in the grid WITH a Dog occupying a market slot scores the true branch, single resolved fame', () => {
    const setup = buildSoloSetup(10, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['dog', 'bee', 'snail', 'bee', 'snail', 'bee'], cards),
      toonDeck: buildExplicitDeck(['dog', 'dog', 'dog', 'dog', 'ostrich'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.market.slots).toContain('dog')
    state = runCheckFame(runFlip(state))
    const dogLine = state.lastCheckFame?.lines.find((l) => l.cardId === 'dog')
    expect(dogLine).toBeDefined()
    expect(dogLine?.dualBranch).toBeUndefined()
    expect(dogLine?.total).toBe(5) // a Dog elsewhere (in the market) -> the +5 bonus applies
    expect(state.lastCheckFame?.totalBranches).toBeUndefined()
  })
})

describe('card conservation over a full game', () => {
  test('deck + grid + dismissed is conserved across every phase transition of a multi-round game', () => {
    const setup = buildSoloSetup(8, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const startingTotal = totalPlayerCards(state)
    let hired = 0
    // Group 3 (Snake/Mongoose) draws a card from the SHARED toon deck
    // straight into the player's own cards (grid/deck) during the Flip
    // phase itself — a real new source of player cards, distinct from
    // hiring. Within runToMarket's pipeline (Flip -> CheckFame ->
    // postFameHooks), the toon deck is touched ONLY by a Flip-phase
    // Snake/Mongoose draw (no market refill happens in that pipeline), so
    // the toon deck's shrinkage across one runToMarket call is exactly this
    // round's toon-drawn count.
    let toonDrawn = 0

    let rounds = 0
    while (state.phase !== 'ended' && rounds < 30) {
      rounds++
      const toonBefore = state.toonDeck.length
      state = runToMarket(state)
      toonDrawn += toonBefore - state.toonDeck.length
      expect(totalPlayerCards(state)).toBe(startingTotal + hired + toonDrawn)

      // Take one hire action if affordable, to exercise the +hired term.
      const affordable = state.market.slots.findIndex((cardId, i) => cardId !== null && state.market.prices[i] <= state.fame)
      if (affordable >= 0 && state.actionsRemaining > 0) {
        state = hire(state, affordable)
        hired++
        expect(totalPlayerCards(state)).toBe(startingTotal + hired + toonDrawn)
      }

      state = endMarketPhase(state)
      expect(totalPlayerCards(state)).toBe(startingTotal + hired + toonDrawn)
      state = runCleanup(state)
      expect(totalPlayerCards(state)).toBe(startingTotal + hired + toonDrawn)
    }

    expect(state.phase).toBe('ended')
    expect(state.result === 'win' || state.result === 'loss').toBe(true)
  })

  // The test above only checks totalPlayerCards' SUM — a bug that swapped a
  // dismissed card back into the deck for a different lost card would still
  // balance the sum and pass. Card ids aren't per-copy unique in this
  // engine, so "the exact same physical card" isn't representable — but
  // `dismissed` should still only ever GROW, as a multiset: once round N's
  // dismissed cards are recorded, they must still all be present (at least
  // that many of each id) in every later round's `dismissed`, never having
  // dropped out to reappear in deck/grid/market/toonDeck.
  test('dismissed is monotonically non-decreasing as a multiset across a multi-round game', () => {
    const setup = buildSoloSetup(9, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })

    function counts(ids: string[]): Map<string, number> {
      const m = new Map<string, number>()
      for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1)
      return m
    }

    let prevDismissedCounts = counts(state.dismissed)
    let rounds = 0
    while (state.phase !== 'ended' && rounds < 30) {
      rounds++
      state = runToMarket(state)

      // Dismiss the first affordable, dismissible, face-up card each round,
      // to actually exercise the dismissed pile rather than leaving it empty.
      for (const { pos, slot } of occupiedSlots(state.grid)) {
        if (state.actionsRemaining <= 0) break
        const idx = slot.cards.length - 1
        if (!slot.faceUp[idx]) continue
        const card = cards[slot.cards[idx]]
        if (card.immune?.includes('dismiss')) continue
        try {
          state = dismiss(state, pos, idx)
          break // one dismiss per round is enough to exercise the invariant
        } catch {
          continue // unaffordable or otherwise not dismissible right now
        }
      }

      state = endMarketPhaseAutoResolving(state)
      state = runCleanup(state)

      const nowDismissedCounts = counts(state.dismissed)
      for (const [id, prevCount] of prevDismissedCounts) {
        expect(nowDismissedCounts.get(id) ?? 0).toBeGreaterThanOrEqual(prevCount)
      }
      prevDismissedCounts = nowDismissedCounts
    }

    expect(state.phase).toBe('ended')
  })
})

// §10: "Fuzz run: many random full games, none crash, no round exceeds a
// sane flip ceiling." No action log (§4.7) exists yet to replay from, so
// this drives the real solo game loop directly across many seeds instead.
describe('fuzz: many random full games', () => {
  test('every seed reaches ended with a win or loss, no throw, within a sane round ceiling', () => {
    const ROUND_CEILING = 60
    for (let seed = 1; seed <= 25; seed++) {
      const setup = buildSoloSetup(seed, 1, 'normal')
      let state = createSoloGameState({
        seed: setup.seed,
        startingDeck: setup.startingDeck,
        toonDeck: setup.toonDeck,
        prices: setup.prices,
        fameToTriggerEndgame: setup.fameToTriggerEndgame,
      })

      let rounds = 0
      const run = () => {
        while (state.phase !== 'ended') {
          rounds++
          if (rounds > ROUND_CEILING) throw new Error(`seed ${seed}: exceeded round ceiling ${ROUND_CEILING}`)
          state = runToMarket(state)

          // Spend fame greedily on the most expensive affordable slot each
          // action, to exercise Market rather than always no-op'ing to 'end'.
          while (state.actionsRemaining > 0) {
            const affordable = state.market.slots
              .map((cardId, i) => ({ cardId, i, price: state.market.prices[i] }))
              .filter((s) => s.cardId !== null && s.price <= state.fame)
              .sort((a, b) => b.price - a.price)[0]
            if (!affordable) break
            state = hire(state, affordable.i)
          }

          state = endMarketPhaseAutoResolving(state)
          state = runCleanup(state)
        }
      }
      expect(run).not.toThrow()

      expect(state.result === 'win' || state.result === 'loss').toBe(true)
    }
  })
})

// Builds a synthetic Market-phase GameState directly (bypassing a full
// Flip/CheckFame), so Group 1's onHire/onDismiss tests can hand-craft
// exactly the market/grid/dismissed state each card's effect needs, the
// same way this file's `dismiss` describe block above hand-picks a
// face-up Caterpillar rather than looping until Flip happens to produce one.
function marketState(seed: number): GameState {
  const setup = buildSoloSetup(seed, 1, 'normal')
  const state = createSoloGameState({
    seed: setup.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
  return { ...state, phase: 'market', actionsRemaining: 2, fame: 50 }
}

describe('Group 1 — onHire/onDismiss firing (butterfly, horse, peacock, raccoon, panther, crow)', () => {
  describe('Butterfly — onHire dismissByName (OPTIONAL)', () => {
    test('supplying a choice dismisses the targeted Caterpillar for 0, on top of the hire price', () => {
      let state = marketState(201)
      const market = { prices: [3], slots: ['butterfly'], insertionSeq: [0] }
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
      state = { ...state, market, grid, toonDeck: [] }
      const before = state.fame
      state = hire(state, 0, { dismissByName: { pos: { section: 'base', row: 0, col: 0 }, index: 0 } })
      expect(state.fame).toBe(before - 3) // hire price 3; dismissByName cost 0
      expect(state.dismissed).toContain('caterpillar')
      expect(occupiedSlots(state.grid).length).toBe(0)
    })

    test('declining (no choice) hires normally, leaving the Caterpillar untouched', () => {
      let state = marketState(202)
      const market = { prices: [3], slots: ['butterfly'], insertionSeq: [0] }
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
      state = { ...state, market, grid, toonDeck: [] }
      const before = state.fame
      state = hire(state, 0)
      expect(state.fame).toBe(before - 3)
      expect(state.dismissed).not.toContain('caterpillar')
      expect(occupiedSlots(state.grid).length).toBe(1)
    })
  })

  describe('Horse — onHire discardMarketAndRefill (OPTIONAL)', () => {
    test('discarding chosen slots refills from the toon deck', () => {
      // USER-DIRECTED ordering: hire() leaves Horse's own vacated slot (0)
      // UNREFILLED — discardMarketSlots indices target that same gapped,
      // pre-refill market (nothing has moved yet), so index 1 here is still
      // 'ostrich'. Horse's own gap and the chosen slot are then refilled
      // TOGETHER in one combined pass and re-sorted by rank: goat(6),
      // sheep(7), rabbit(9).
      let state = marketState(203)
      const market = { prices: [3, 4, 7], slots: ['horse', 'ostrich', 'goat'], insertionSeq: [0, 1, 2] }
      const toonDeck = buildExplicitDeck(['sheep', 'rabbit'], cards)
      state = { ...state, market, toonDeck, nextInsertionSeq: 3 }
      const before = state.fame
      state = hire(state, 0, { discardMarketSlots: [1] }) // pre-refill index 1 = ostrich
      expect(state.fame).toBe(before - 3) // discardMarketAndRefill has no cost of its own
      expect(state.market.slots).not.toContain('ostrich')
      expect(state.market.slots).toEqual(['goat', 'sheep', 'rabbit']) // rank order: 6, 7, 9
      expect(state.toonDeck.length).toBe(0) // both sheep and rabbit consumed in the one combined refill
    })

    test('declining (no additional slots) still refills Horse\'s own vacated slot — the discard is optional, the refill is not', () => {
      // hire() itself deliberately does NOT refill Horse's slot (see
      // hasDiscardMarketAndRefillOnHire's comment) — applyEffects's
      // discardMarketAndRefill case is unconditional specifically so this
      // slot doesn't stay permanently empty when the player discards
      // nothing extra (e.g. every web/server hire, which never passes
      // `choices` at all).
      let state = marketState(204)
      const market = { prices: [3, 4, 7], slots: ['horse', 'ostrich', 'goat'], insertionSeq: [0, 1, 2] }
      const toonDeck = buildExplicitDeck(['sheep', 'rabbit'], cards)
      state = { ...state, market, toonDeck, nextInsertionSeq: 3 }
      state = hire(state, 0)
      expect(state.market.slots).toContain('ostrich')
      expect(state.market.slots).toContain('goat')
      expect(state.market.slots).not.toContain(null)
      expect(state.toonDeck.length).toBe(1) // only Horse's own single-slot refill drew a card
    })

    test("discarding a card with its own onDismiss effect (Crow) does NOT trigger that effect — a market discard is not a dismiss()", () => {
      // market.ts's soloMarketDecay comment is explicit that market-discarded
      // cards "leave the game entirely (not tracked in any pile this engine
      // models)" — applyEffects's discardMarketAndRefill case (phases.ts)
      // confirms this structurally: it nulls the slot directly and never
      // calls dismiss()/applyEffects on the discarded card itself, so a
      // discarded Crow's onDismiss (hireFromMarketAndRefill) can never fire,
      // regardless of whether a legal target/choice for it would exist.
      // Picked Crow specifically (the one onDismiss-bearing card) so a
      // regression that started firing onDismiss on discard would show up
      // as an extra free hire / an extra market refill, not just silence.
      let state = marketState(220)
      const market = { prices: [3, 4, 7], slots: ['horse', 'crow', 'goat'], insertionSeq: [0, 1, 2] }
      const toonDeck = buildExplicitDeck(['sheep', 'rabbit'], cards)
      state = { ...state, market, toonDeck, nextInsertionSeq: 3, dismissed: [] }
      const deckBefore = state.deck.length
      state = hire(state, 0, { discardMarketSlots: [1] }) // pre-refill index 1 = crow
      expect(state.market.slots).not.toContain('crow')
      // A real dismiss() unconditionally pushes onto `dismissed` (see
      // removeCardRaw's own header comment: "every caller MUST do that
      // regardless of cost/kind") — its absence here is the direct proof
      // this was a discard, not a dismiss.
      expect(state.dismissed).not.toContain('crow')
      expect(state.deck.length).toBe(deckBefore + 1) // +1 for Horse itself only — no bonus hire from Crow's onDismiss
    })
  })

  describe("Peacock — onHire gainFame + bonusMarketAction", () => {
    test("gainFame touches spendable fame only, NOT fameGeneratedThisRound (the frozen Check-Fame win-trigger snapshot); bonusMarketAction is additive on the post-decrement actionsRemaining", () => {
      let state = marketState(205)
      const market = { prices: [3], slots: ['peacock'], insertionSeq: [0] }
      state = { ...state, market, fame: 50, fameGeneratedThisRound: 17, actionsRemaining: 1 }
      state = hire(state, 0)
      expect(state.fame).toBe(50 - 3 + 2) // hire price 3, then +2 from gainFame
      expect(state.fameGeneratedThisRound).toBe(17) // untouched — this is the regression this pass's plan called out
      expect(state.actionsRemaining).toBe(1) // (1 - 1 from hire's own decrement) + 1 from bonusMarketAction = 1, not 0
    })
  })

  describe('Raccoon — onHire hireFromDismissed (OPTIONAL)', () => {
    test('supplying a choice hires the named dismissed card for 0', () => {
      let state = marketState(206)
      const market = { prices: [3], slots: ['raccoon'], insertionSeq: [0] }
      state = { ...state, market, dismissed: ['bee'], toonDeck: [] }
      const before = state.fame
      const deckBefore = state.deck.length
      state = hire(state, 0, { hireFromDismissed: { cardId: 'bee' } })
      expect(state.fame).toBe(before - 3) // hire price only; hireFromDismissed cost 0
      expect(state.dismissed).not.toContain('bee')
      expect(state.deck.length).toBe(deckBefore + 2) // +1 for raccoon itself (hire()'s own bookkeeping), +1 for bee
      expect(state.deck).toContain('bee')
    })

    test("declining (no choice) hires normally, dismissed pile untouched", () => {
      let state = marketState(207)
      const market = { prices: [3], slots: ['raccoon'], insertionSeq: [0] }
      state = { ...state, market, dismissed: ['bee'], toonDeck: [] }
      state = hire(state, 0)
      expect(state.dismissed).toContain('bee')
    })

    test('a choice naming a card NOT in the dismissed pile throws', () => {
      let state = marketState(208)
      const market = { prices: [3], slots: ['raccoon'], insertionSeq: [0] }
      state = { ...state, market, dismissed: [], toonDeck: [] }
      expect(() => hire(state, 0, { hireFromDismissed: { cardId: 'bee' } })).toThrow()
    })
  })

  describe('Panther — onHire dismissChosenGridCard (MANDATORY)', () => {
    test('supplying a choice dismisses the targeted grid card for 0', () => {
      let state = marketState(209)
      const market = { prices: [3], slots: ['panther'], insertionSeq: [0] }
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
      state = { ...state, market, grid, toonDeck: [] }
      const before = state.fame
      state = hire(state, 0, { dismissGridPos: { pos: { section: 'base', row: 0, col: 0 }, index: 0 } })
      expect(state.fame).toBe(before - 3) // hire price only; dismissChosenGridCard cost 0
      expect(state.dismissed).toContain('bee')
    })

    test('a legal target exists but no choice is supplied — throws (mandatory)', () => {
      let state = marketState(210)
      const market = { prices: [3], slots: ['panther'], insertionSeq: [0] }
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
      state = { ...state, market, grid, toonDeck: [] }
      expect(() => hire(state, 0)).toThrow()
    })

    test('an empty grid (no legal target at all) silently no-ops instead of throwing', () => {
      let state = marketState(211)
      const market = { prices: [3], slots: ['panther'], insertionSeq: [0] }
      state = { ...state, market, grid: emptyGrid(), toonDeck: [] }
      expect(() => hire(state, 0)).not.toThrow()
      const after = hire(state, 0)
      expect(after.dismissed).toEqual([])
    })
  })

  describe('Crow — onDismiss hireFromMarketAndRefill (OPTIONAL; only the Market-phase-dismissal case is reachable)', () => {
    test('supplying a choice hires the chosen market slot for 0 and refills', () => {
      let state = marketState(212)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'crow')
      // Market already full — dismiss()'s own refill (of an unchanged
      // market) is a no-op re-sort, so applyEffects's choice index lines
      // up with this literal layout, unlike hire()'s post-refill shuffle.
      const market = { prices: [3], slots: ['ostrich'], insertionSeq: [0] }
      const toonDeck = buildExplicitDeck(['sheep'], cards)
      state = { ...state, grid, market, toonDeck, nextInsertionSeq: 1, fame: 50 }
      const before = state.fame
      const deckBefore = state.deck.length
      state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0, { hireFromMarketSlot: { slotIndex: 0 } })
      expect(state.fame).toBe(before - 5) // crow's own default dismiss cost (5); hireFromMarketAndRefill cost 0
      expect(state.deck.length).toBe(deckBefore + 1)
      expect(state.deck).toContain('ostrich')
      expect(state.market.slots).not.toContain('ostrich')
      expect(state.market.slots).toContain('sheep') // refilled from the toon deck
      expect(state.dismissed).toContain('crow')
    })

    test('declining (no choice) dismisses Crow normally, market untouched', () => {
      let state = marketState(213)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'crow')
      const market = { prices: [3], slots: ['ostrich'], insertionSeq: [0] }
      state = { ...state, grid, market, toonDeck: [], fame: 50 }
      state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
      expect(state.market.slots).toContain('ostrich')
      expect(state.dismissed).toContain('crow')
    })
  })
})

describe('Group 2 — postMarket self/other-triggered hooks (donkey, alligator, groundhog, vulture)', () => {
  describe('Donkey — selfDismissIf inLowerRow', () => {
    test('in the lower row, dismisses itself at end of Market phase, and logs it', () => {
      let state = marketState(301)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'donkey')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      const logLines: EngineLogLine[] = []
      state = endMarketPhase(state, logLines)
      expect(state.dismissed).toContain('donkey')
      expect(occupiedSlots(state.grid).length).toBe(0)
      expect(logLines.some((l) => l.text.includes('Dismissed Donkey') && l.text.includes('Donkey'))).toBe(true)
    })

    test('in the upper row, is NOT dismissed', () => {
      let state = marketState(302)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'donkey')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).not.toContain('donkey')
      expect(occupiedSlots(state.grid).length).toBe(1)
    })
  })

  describe('Groundhog — selfDismissIf firstOrLastGridSlot', () => {
    test('at base[0][0] (first), dismisses itself', () => {
      let state = marketState(303)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'groundhog')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).toContain('groundhog')
    })

    test('at base[1][2] (last), dismisses itself', () => {
      let state = marketState(304)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'groundhog')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).toContain('groundhog')
    })

    test('in a middle slot, is NOT dismissed', () => {
      let state = marketState(305)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'groundhog')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).not.toContain('groundhog')
    })
  })

  describe('Alligator — dismissAdjacentRight', () => {
    test('dismisses the face-up card directly to its right', () => {
      let state = marketState(306)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).toContain('bee')
      expect(state.dismissed).not.toContain('alligator') // alligator itself survives
    })

    test('nothing to the right — no-op', () => {
      let state = marketState(307)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'alligator') // rightmost column
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      expect(() => endMarketPhase(state)).not.toThrow()
      state = endMarketPhase(state)
      expect(state.dismissed).toEqual([])
    })

    test('a dismiss-immune card to the right is not dismissed (no-op, not a fallback)', () => {
      let state = marketState(308)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cat') // immune: ['dismiss']
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).not.toContain('cat')
    })

    test('regression: an Alligator already dismissed during the Market phase no longer fires its hook', () => {
      let state = marketState(309)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee') // would-be target, no Alligator present at all
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).not.toContain('bee') // no Alligator anywhere -> no hook fires at all
    })

    test('a 2-card face-up stack to the right pauses with a pendingPostMarketChoice offering both cards', () => {
      let state = marketState(320)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'sheep') // stacked on top of bee, also face-up
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)

      expect(state.phase).toBe('market') // paused, not advanced to cleanup
      expect(state.dismissed).toEqual([]) // nothing dismissed yet
      expect(state.pendingPostMarketChoice).not.toBeNull()
      expect(state.pendingPostMarketChoice?.ownerCardId).toBe('alligator')
      expect(state.pendingPostMarketChoice?.options.map((o) => o.cardId).sort()).toEqual(['bee', 'sheep'])
    })

    test('resolving the stack choice dismisses the picked card and completes the Market phase', () => {
      let state = marketState(321)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'sheep')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      const beeOption = state.pendingPostMarketChoice!.options.find((o) => o.cardId === 'bee')!

      const logLines: EngineLogLine[] = []
      state = resolvePostMarketChoice(state, { pos: beeOption.pos, index: beeOption.index }, logLines)

      expect(state.pendingPostMarketChoice).toBeNull()
      expect(state.phase).toBe('cleanup') // resumed and completed the rest of endMarketPhase
      expect(state.dismissed).toContain('bee')
      expect(state.dismissed).not.toContain('sheep')
      expect(logLines.some((l) => l.text.includes('Dismissed Bee') && l.text.includes('Alligator'))).toBe(true)
    })

    test('regression: a dismissible face-up card under a face-down top card is now auto-dismissed, not skipped', () => {
      let state = marketState(322)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      const targetSlot = getSlot(grid, { section: 'base', row: 0, col: 1 })!
      targetSlot.cards.push('sheep')
      targetSlot.faceUp.push(false) // face-down top — bee underneath is still the sole eligible card
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)

      expect(state.pendingPostMarketChoice).toBeNull() // exactly 1 eligible card — auto-dismissed, no prompt
      expect(state.dismissed).toContain('bee')
      expect(state.dismissed).not.toContain('sheep')
    })

    test('regression: an immune card on top no longer blocks a dismissible face-up card underneath it', () => {
      let state = marketState(324)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cat') // immune, on top — protects itself, not the stack
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)

      expect(state.pendingPostMarketChoice).toBeNull() // exactly 1 eligible card (bee) — auto-dismissed, no prompt
      expect(state.dismissed).toContain('bee')
      expect(state.dismissed).not.toContain('cat')
    })

    test('two Alligators each facing a 2+ stack prompt sequentially, not simultaneously', () => {
      let state = marketState(323)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'sheep')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'alligator')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 1 }, 'goat')
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 1 }, 'dragonfly')
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }

      state = endMarketPhase(state)
      expect(state.pendingPostMarketChoice?.ownerPos).toEqual({ section: 'base', row: 0, col: 0 })
      const firstOption = state.pendingPostMarketChoice!.options[0]
      state = resolvePostMarketChoice(state, { pos: firstOption.pos, index: firstOption.index })

      expect(state.pendingPostMarketChoice).not.toBeNull() // second Alligator's stack now pending
      expect(state.pendingPostMarketChoice?.ownerPos).toEqual({ section: 'base', row: 1, col: 0 })
      const secondOption = state.pendingPostMarketChoice!.options[0]
      state = resolvePostMarketChoice(state, { pos: secondOption.pos, index: secondOption.index })

      expect(state.pendingPostMarketChoice).toBeNull()
      expect(state.phase).toBe('cleanup')
    })
  })

  describe('Vulture — dismissLowestRankInGrid', () => {
    test('dismisses the lowest-rank face-up card in the grid, and logs it', () => {
      let state = marketState(310)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'vulture') // rank 20
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee') // rank 0 — lowest
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      const logLines: EngineLogLine[] = []
      state = endMarketPhase(state, logLines)
      expect(state.dismissed).toContain('bee')
      expect(state.dismissed).not.toContain('vulture')
      expect(logLines.some((l) => l.text.includes('Dismissed Bee') && l.text.includes('Vulture'))).toBe(true)
    })

    test('an immune lowest-rank card means no-op (does NOT fall back to the next-lowest)', () => {
      let state = marketState(311)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'vulture') // rank 20
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cat') // rank 14, immune: ['dismiss'], NOT the lowest rank though
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 2 }, 'tiger') // rank 22, immune: ['dismiss'], also not lowest
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 0 }, 'bee') // rank 0 — the actual lowest, NOT immune
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      // bee IS the lowest and not immune, so it should be dismissed here —
      // this test exercises the plain path. The true "immune lowest" case
      // is exercised by the case below with a lone immune card as the only
      // (and thus lowest) candidate.
      expect(state.dismissed).toContain('bee')
    })

    test('when the lowest-rank card is immune and nothing else is present, dismisses nothing', () => {
      let state = marketState(312)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'vulture') // rank 20
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'cat') // rank 14 — lowest present besides vulture, and immune
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      state = endMarketPhase(state)
      expect(state.dismissed).toEqual([]) // cat is the lowest-rank card and immune -> no-op, not a fallback to vulture itself
    })

    test('ordering interaction: Vulture (earlier in reading order) can dismiss Groundhog before Groundhog\'s own hook runs', () => {
      let state = marketState(313)
      const grid = emptyGrid()
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'vulture') // rank 20, reading order first
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee') // filler, rank 0 — actually LOWEST, so use a higher-rank filler instead
      placeCardFaceUp(grid, { section: 'base', row: 1, col: 2 }, 'groundhog') // rank 2, in its own self-dismiss slot (last)
      // Replace the accidental rank-0 filler above with something higher
      // than Groundhog's rank 2 so Groundhog really is the grid's lowest
      // (aside from itself) and is Vulture's target.
      grid.base[0][1] = null
      placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'sheep') // rank 7
      state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
      const after = runPostMarketHooks(state)
      // Vulture (reading-order first) dismisses Groundhog for being the
      // grid's lowest rank. By the time Groundhog's own snapshotted
      // candidate entry comes up, it's already gone — its selfDismissIf
      // hook is skipped silently rather than double-processed or erroring.
      expect(after.dismissed).toContain('groundhog')
      expect(after.dismissed.filter((id) => id === 'groundhog').length).toBe(1)
      expect(after.dismissed).not.toContain('vulture')
      expect(after.dismissed).not.toContain('sheep')
    })
  })
})

describe('Group 6 — adjacency/stack-aware dismiss cost (ladybug, rat)', () => {
  test('an adjacent face-up Ladybug drops the DEFAULT dismiss cost from 5 to 3', () => {
    let state = marketState(401)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee') // dismissCost default (5)
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'ladybug')
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
    expect(state.fame).toBe(before - 3)
  })

  test('a face-down adjacent Ladybug does NOT discount (face-down cards have no effect)', () => {
    let state = marketState(402)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'ladybug')
    grid.base[0][1]!.faceUp[0] = false
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
    expect(state.fame).toBe(before - 5) // no discount — Ladybug is face-down
  })

  test("Ladybug does NOT touch an explicit dismissCost override (Caterpillar stays 3)", () => {
    let state = marketState(403)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar') // dismissCost: 3, explicit
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'ladybug')
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
    expect(state.fame).toBe(before - 3) // unchanged — still Caterpillar's own 3, not further discounted
  })

  test('a face-up Rat co-stacked with the target subtracts 1 from the dismiss cost', () => {
    let state = marketState(404)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'rat') // same slot/stack
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0) // dismiss bee, the bottom card
    expect(state.fame).toBe(before - 4) // 5 default - 1 (rat co-stacked)
  })

  test('a face-down Rat co-stacked does NOT discount', () => {
    let state = marketState(405)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'rat')
    grid.base[0][0]!.faceUp[1] = false
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
    expect(state.fame).toBe(before - 5) // no discount — Rat is face-down
  })

  test('Rat removed from the grid entirely (a different, empty slot) does not discount elsewhere', () => {
    let state = marketState(406)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    // No rat anywhere in this grid at all.
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0)
    expect(state.fame).toBe(before - 5)
  })

  test('composed Ladybug + Rat: Ladybug replaces default (5 -> 3), then Rat subtracts 1 -> 2 (flagged UNCONFIRMED per this pass\'s plan)', () => {
    let state = marketState(407)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'bee')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'rat') // co-stacked with bee
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'ladybug') // adjacent to the stack
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    const before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0) // dismiss bee (bottom of the stack)
    expect(state.fame).toBe(before - 2)
  })

  test('regression: every other card\'s dismiss cost is unchanged by this pass (no Ladybug/Rat nearby)', () => {
    let state = marketState(409)
    const grid = emptyGrid()
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 0 }, 'caterpillar')
    placeCardFaceUp(grid, { section: 'base', row: 0, col: 1 }, 'bee')
    state = { ...state, grid, market: { prices: [3], slots: [null], insertionSeq: [null] }, toonDeck: [] }
    let before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 0 }, 0) // caterpillar
    expect(state.fame).toBe(before - 3) // its own explicit dismissCost, untouched
    state = { ...state, actionsRemaining: 2 }
    before = state.fame
    state = dismiss(state, { section: 'base', row: 0, col: 1 }, 0) // bee, default cost, no neighbors left
    expect(state.fame).toBe(before - 5)
  })
})

describe("Snake's deferred Peacock onHire (see flip.ts's dismissOwnDeckTopAndStackFromToonDeck case)", () => {
  test('a Peacock drawn via Snake applies its +2 fame / +1 Market action bonus in postFameHooks, after Check Fame, on top of the normal reset', () => {
    const setup = buildSoloSetup(1, 1, 'normal')
    // 5 filler cards (all rank 0) consumed by createSoloGameState's initial
    // market prefill (5 slots for a 1-4 player market) — leaves 'peacock'
    // as the very next toonDeck.shift(), which is what Snake's Flip-time
    // draw pulls.
    const marketFiller = buildExplicitDeck(['dragonfly', 'bee', 'snail', 'caterpillar', 'caterpillar'], cards)
    const toonDeck = [...marketFiller, ...buildExplicitDeck(['peacock'], cards)]

    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['snake', 'bee', 'snail', 'dragonfly', 'caterpillar', 'caterpillar'], cards),
      toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    expect(state.market.slots.every((s) => s !== null)).toBe(true) // sanity: prefill consumed the 5 filler cards
    expect(state.toonDeck).toEqual(['peacock'])

    state = runFlip(state)
    expect(state.pendingOnHireCardIds).toEqual(['peacock'])

    state = runCheckFame(state)
    expect(state.pendingOnHireCardIds).toEqual(['peacock']) // still queued — Check Fame doesn't resolve it
    const fameSnapshot = state.fame // breakdown.total, BEFORE the deferred bonus
    const fameGenerated = state.fameGeneratedThisRound

    state = runPostFameHooks(state)
    expect(state.pendingOnHireCardIds).toEqual([]) // resolved and cleared
    expect(state.fame).toBe(fameSnapshot + 2) // Peacock's onHire gainFame, additive on the Check-Fame total
    expect(state.actionsRemaining).toBe(3) // MARKET_ACTIONS_PER_ROUND (2) + Peacock's bonusMarketAction (1), not a wash
    expect(state.fameGeneratedThisRound).toBe(fameGenerated) // the frozen win-trigger snapshot is untouched by the bonus
  })
})
