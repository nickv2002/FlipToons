// Worker-thread body for bench.ts's pooled task queue. Each message is ONE
// individual game (one seed, in one season/difficulty combination) — not a
// whole season batch — so the pool below can keep every worker saturated
// until the last game finishes, rather than being bottlenecked by whichever
// batch happens to be slowest. Not a script meant to be run directly —
// bench.ts spawns a small pool of these (sized to the machine's core count)
// via `new Worker(new URL('./bench-worker.ts', import.meta.url))`, Bun's
// standard Web Worker API, and feeds each one task at a time as it finishes.
import type { SoloDifficulty } from '../setup'
import type { Season } from '../cards/types'
import { buildNewGameState, playSoloAutomatically } from './index'
import { makeRng } from '../rng'

export type BenchGameTask = {
  taskId: number
  season: Season
  seed: number
  simulations: number | undefined
  maxStepsPerPlayout: number | undefined
  difficulty: SoloDifficulty
}

export type BenchGameResult = {
  taskId: number
  season: Season
  win: boolean
  ended: boolean
  // Which season's starting deck was actually dealt for THIS game.
  // Meaningful only when the task's `season` is 'both' (setup.ts's
  // pickStartingDeckSeason coin-flips a whole season-1- or season-2-shaped
  // starting deck even in 'both' mode); omitted for a pure single-season run
  // where it would just echo `season`. Derived from state.deck right after
  // buildNewGameState — 'caterpillar' only ever appears in the season 1
  // starting deck (setup.ts's buildSeason1SoloStartingDeck), so its presence
  // is a cheap, exact tell.
  startingDeckSeason: 1 | 2 | undefined
}

// tsconfig here has no "webworker" lib (the engine package stays lib:
// ESNext-only), so the worker globals are declared locally rather than
// pulling in DOM/webworker types repo-wide.
declare const self: {
  onmessage: ((event: { data: BenchGameTask }) => void) | null
  postMessage: (data: BenchGameResult) => void
}

self.onmessage = (event) => {
  const { taskId, season, seed, simulations, maxStepsPerPlayout, difficulty } = event.data
  const state = buildNewGameState(seed, difficulty, season)
  const startingDeckSeason: 1 | 2 | undefined = season === 'both' ? (state.deck.includes('caterpillar') ? 1 : 2) : undefined
  const result = playSoloAutomatically(state, {
    simulations,
    maxStepsPerPlayout,
    maxSteps: 400,
    rng: makeRng(seed * 7 + 3),
  })
  const ended = result.state.phase === 'ended'
  const win = ended && result.state.result === 'win'
  const payload: BenchGameResult = { taskId, season, win, ended, startingDeckSeason }
  self.postMessage(payload)
}
