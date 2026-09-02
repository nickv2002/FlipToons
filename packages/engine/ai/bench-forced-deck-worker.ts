// Worker body for bench-forced-deck.ts. One game per task.
import { buildSoloToonDeckUnshuffled, buildSeason1SoloStartingDeck, buildSeason2SoloStartingDeck } from '../setup'
import { makeRng, shuffle } from '../rng'
import { createSoloGameState } from '../state'
import { playSoloAutomatically } from './index'

export type ForcedDeckTask = {
  taskId: number
  forcedStartSeason: 1 | 2
  seed: number
  poolSize: number
  simulations: number
  maxStepsPerPlayout: number
}
export type ForcedDeckResult = { taskId: number; forcedStartSeason: 1 | 2; seed: number; win: boolean; ended: boolean }

// Mirrors setup.ts's buildSoloSetup for 'both' mode exactly, except the
// starting-deck season is FORCED here instead of pickStartingDeckSeason's
// internal coin flip — that's the whole point: it lets a season-1-shaped and
// a season-2-shaped starting deck be compared against the IDENTICAL combined
// market pool, at the same seed, which bench.ts's normal 'both' mode cannot
// do (it coin-flips the split, so a season-1-start and season-2-start game
// never share a seed). Burns one rng() call first so the toon-deck shuffle
// stream matches what 'both' mode would actually have produced for that seed.
function buildForcedBothSetup(seed: number, forcedStartSeason: 1 | 2, poolSize: number) {
  const rng = makeRng(seed)
  rng()
  const fullPool = buildSoloToonDeckUnshuffled('both')
  const shuffled = shuffle(fullPool, rng)
  const toonDeck = shuffled.slice(0, Math.min(poolSize, shuffled.length))
  const startingDeck = forcedStartSeason === 1 ? buildSeason1SoloStartingDeck() : buildSeason2SoloStartingDeck()
  return { startingDeck, toonDeck }
}

declare const self: Worker
self.onmessage = (event: MessageEvent<ForcedDeckTask>) => {
  const t = event.data
  const setup = buildForcedBothSetup(t.seed, t.forcedStartSeason, t.poolSize)
  const state = createSoloGameState({
    seed: t.seed,
    startingDeck: setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: [3, 4, 7, 10, 15],
    fameToTriggerEndgame: 30,
  })
  const result = playSoloAutomatically(state, {
    maxSteps: 400,
    rng: makeRng(t.seed * 7 + 3),
    simulations: t.simulations,
    maxStepsPerPlayout: t.maxStepsPerPlayout,
  })
  const ended = result.state.phase === 'ended'
  const win = ended && result.state.result === 'win'
  postMessage({ taskId: t.taskId, forcedStartSeason: t.forcedStartSeason, seed: t.seed, win, ended } satisfies ForcedDeckResult)
}
