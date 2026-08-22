// Regression coverage for the guaranteed-loss short circuit's ordering bug:
// a round that has, in fact, just won via the house-rule instant-win
// (checkInstantWin — live `fame` crossing fameToTriggerEndgame) must not be
// declared a loss by skipGuaranteedLossMarketPhase, which predicts loss from
// `fameGeneratedThisRound`, the frozen Check-Fame snapshot. Those two numbers
// can diverge: Snake's onPlace stacks a toon-deck card face-up on itself and,
// per the card table's FAQ note (season1.ts's 'snake' entry), a stacked
// Peacock's +2 onHire fame is deferred to runPostFameHooks (phases.ts) so it
// lands AFTER Check Fame — it bumps `fame` without moving
// `fameGeneratedThisRound`. Reported in play: a player reached what should
// have been a winning score on their final turn and still saw a generic
// "toon deck depleted" loss.
import { describe, expect, test } from 'bun:test'
import { advanceThroughPassthroughPhases, applyAction } from './actions'
import { runCheckFame, runFlip } from './phases'
import { buildExplicitDeck, buildSoloSetup, cardsById } from './setup'
import { createSoloGameState } from './state'
import type { GameState } from './state'

const cards = cardsById()

// 5 rank-0 filler cards soak up the initial 5-slot market prefill, leaving
// 'peacock' as the toon deck's only remaining card — Snake's Flip-time draw
// takes it, and nothing is left for solo's per-round market decay (needs 2)
// to refill with, so isGuaranteedLoss's toonDeck-too-thin half is true.
const MARKET_FILLER = buildExplicitDeck(['dragonfly', 'bee', 'snail', 'caterpillar', 'caterpillar'], cards)
const TOON_DECK_WITH_ONLY_PEACOCK = [...MARKET_FILLER, ...buildExplicitDeck(['peacock'], cards)]

// snake, bear, axolotl, horse, alligator, rooster scores exactly 28 at Check
// Fame (< the 30-fame threshold) — matches the reported "hit 28 on my final
// turn" scenario. Snake's stacked Peacock then adds +2 in postFameHooks,
// landing on fame 30 — a real win — while fameGeneratedThisRound stays 28.
const SNAKE_PEACOCK_28_STARTING_DECK = buildExplicitDeck(['snake', 'bear', 'axolotl', 'horse', 'alligator', 'rooster'], cards)

function buildSnakePeacockState(): GameState {
  const setup = buildSoloSetup(1, 1, 'normal')
  return createSoloGameState({
    seed: setup.seed,
    startingDeck: SNAKE_PEACOCK_28_STARTING_DECK,
    toonDeck: TOON_DECK_WITH_ONLY_PEACOCK,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
}

describe('guaranteed-loss short circuit vs. a real win (Snake + deferred Peacock fame)', () => {
  test('fixture sanity: Check Fame lands on 28/30 with the toon deck too thin to refill', () => {
    let state = buildSnakePeacockState()
    state = runFlip(state)
    expect(state.toonDeck).toEqual([]) // Snake's draw took the only card — 0 left, refill needs 2
    expect(state.pendingOnHireCardIds).toEqual(['peacock']) // deferred, not yet applied
    state = runCheckFame(state)
    expect(state.fameGeneratedThisRound).toBe(28)
    expect(state.fameGeneratedThisRound).toBeLessThan(state.fameToTriggerEndgame)
  })

  test('advanceThroughPassthroughPhases (the flip-action cascade) resolves this as a WIN, not a loss', () => {
    let state = buildSnakePeacockState()
    state = runFlip(state)
    state = runCheckFame(state)
    // Enter the cascade already at 'postFameHooks', same as a caller landing
    // here mid-sequence (advanceThroughPassthroughPhases handles any prefix).
    const logLines: string[] = []
    const final = advanceThroughPassthroughPhases(state, logLines)

    expect(final.fame).toBe(30) // 28 + Peacock's deferred +2
    expect(final.phase).toBe('ended')
    expect(final.result).toBe('win')
    expect(logLines.some((l) => l.includes('YOU WIN'))).toBe(true)
    expect(logLines.some((l) => l.includes('YOU LOSE'))).toBe(false)
  })

  test('the flip action end-to-end (applyAction), the real dispatch path the UI uses, also resolves a WIN', () => {
    const state = buildSnakePeacockState()
    const result = applyAction(state, { kind: 'flip' })

    expect(result.state.phase).toBe('ended')
    expect(result.state.result).toBe('win')
    expect(result.logLines.some((l) => l.includes('YOU WIN'))).toBe(true)
  })

  test("the 'continueToMarket' action (ai.ts's autoplay entry point) resolves the same WIN, not the guaranteed-loss path", () => {
    let state = buildSnakePeacockState()
    state = runFlip(state)
    state = runCheckFame(state)
    // continueToMarket's handler runs postFameHooks itself, so hand it the
    // checkFame-phase state directly (mirrors ai.ts dispatching this action
    // instead of 'flip').
    const result = applyAction(state, { kind: 'continueToMarket' })

    expect(result.state.phase).toBe('ended')
    expect(result.state.result).toBe('win')
  })
})

describe('a genuine guaranteed loss (no fame divergence) still loses, with a specific message', () => {
  // Same thin-toon-deck shape, but no Snake/Peacock in play — Check-Fame
  // fame and fameGeneratedThisRound never diverge, so this is an ordinary,
  // correctly-predicted loss: short of the threshold, deck too thin to
  // refill. Distinguishes "the ordering fix didn't just make everything a
  // win" from the win-path tests above.
  test('advanceThroughPassthroughPhases ends the round as a loss and reports the actual fame/threshold', () => {
    const setup = buildSoloSetup(1, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['bear', 'axolotl', 'horse', 'alligator', 'rooster', 'snail'], cards),
      toonDeck: MARKET_FILLER, // fully consumed by the initial market prefill — 0 left, refill needs 2
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = runFlip(state)
    state = runCheckFame(state)
    expect(state.fameGeneratedThisRound).toBeLessThan(state.fameToTriggerEndgame)

    const logLines: string[] = []
    const final = advanceThroughPassthroughPhases(state, logLines)

    expect(final.phase).toBe('ended')
    expect(final.result).toBe('loss')
    const lossLine = logLines.find((l) => l.includes('YOU LOSE'))
    expect(lossLine).toBeDefined()
    expect(lossLine).toContain(`${state.fameGeneratedThisRound}/${state.fameToTriggerEndgame}`)
  })
})
