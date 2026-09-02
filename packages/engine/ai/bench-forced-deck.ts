// Paired starting-deck-shape benchmark: forces solo 'both' mode's starting
// deck to season 1 or season 2 (instead of setup.ts's pickStartingDeckSeason
// coin flip) so the two conditions can be compared against the IDENTICAL
// combined market pool at the same seed. bench.ts's own 'both' mode can't do
// this — it coin-flips the split, so a season-1-start and season-2-start
// game there never share a seed, which makes it useless for isolating
// "does starting-deck SHAPE matter, holding the market pool fixed."
//
// This is how the season2-gap-findings.md S1-start/S2-start gap (see that
// file) was validated: the same seed list run once forced to season 1, once
// forced to season 2, with per-seed win/loss compared directly rather than
// just aggregate rates — pairing removes most of the shuffle-order variance
// that otherwise dominates at these seed counts.
//
// Parallelized the same way bench.ts is: one worker pool, one task per game,
// pulled off a shared queue.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-forced-deck.ts [poolSize] [seeds] [sims] [steps]
//
// All args optional, in order:
//   poolSize   toon deck size after the season-1/season-2 shuffle+slice
//              (default 35 — both-mode's own normal-difficulty trim)
//   seeds      seed count PER forced-season condition (default 40)
//   sims       AiOptions.simulations (default core.ts's own default)
//   steps      AiOptions.maxStepsPerPlayout (default core.ts's own default)
//
// Examples:
//   bun run packages/engine/ai/bench-forced-deck.ts             # pool=35, 40 seeds/side
//   bun run packages/engine/ai/bench-forced-deck.ts 32 100       # pool=32, 100 seeds/side
//   bun run packages/engine/ai/bench-forced-deck.ts 35 40 1500 1500  # 10x-budget diagnostic
import type { ForcedDeckTask, ForcedDeckResult } from './bench-forced-deck-worker'

const [poolSizeArg, seedsArg, simsArg, stepsArg] = process.argv.slice(2)

const poolSize = parseInt(poolSizeArg ?? '35', 10)
const seedCount = parseInt(seedsArg ?? '40', 10)
const simulations = simsArg ? parseInt(simsArg, 10) : 150
const maxStepsPerPlayout = stepsArg ? parseInt(stepsArg, 10) : 150

const SEED_BASE = 9000
const MAX_POOL_SIZE = 16
const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
const POOL_SIZE_WORKERS = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE))

const tasks: ForcedDeckTask[] = []
let nextTaskId = 0
for (const forcedStartSeason of [1, 2] as const) {
  for (let i = 0; i < seedCount; i++) {
    tasks.push({ taskId: nextTaskId++, forcedStartSeason, seed: SEED_BASE + i, poolSize, simulations, maxStepsPerPlayout })
  }
}

const resultsBySeason = new Map<1 | 2, Map<number, ForcedDeckResult>>([
  [1, new Map()],
  [2, new Map()],
])

let nextIndex = 0
let completed = 0
const total = tasks.length
const overallStart = Date.now()

function runPoolWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench-forced-deck-worker.ts', import.meta.url).href)
    let settled = false
    const dispatchNext = () => {
      if (nextIndex >= tasks.length) {
        settled = true
        worker.terminate()
        resolve()
        return
      }
      worker.postMessage(tasks[nextIndex++])
    }
    worker.onmessage = (event: MessageEvent<ForcedDeckResult>) => {
      resultsBySeason.get(event.data.forcedStartSeason)!.set(event.data.seed, event.data)
      completed++
      dispatchNext()
    }
    worker.onerror = (err) => {
      if (!settled) {
        settled = true
        reject(err)
        worker.terminate()
      }
    }
    dispatchNext()
  })
}

const workerPromises: Promise<void>[] = []
for (let i = 0; i < POOL_SIZE_WORKERS; i++) workerPromises.push(runPoolWorker())
await Promise.all(workerPromises)

console.log(
  `--- forced-starting-deck paired benchmark: pool=${poolSize}, n=${seedCount}/side, ${POOL_SIZE_WORKERS} workers, sims=${simulations} steps=${maxStepsPerPlayout} ---`,
)
for (const forcedStartSeason of [1, 2] as const) {
  const results = [...resultsBySeason.get(forcedStartSeason)!.values()]
  const wins = results.filter((r) => r.win).length
  const notEnded = results.filter((r) => !r.ended).length
  console.log(
    `forced_season_${forcedStartSeason}_start: ${wins}/${results.length} wins (${((wins / results.length) * 100).toFixed(1)}%)` +
      (notEnded ? `, ${notEnded} did not terminate` : ''),
  )
}

const s1 = resultsBySeason.get(1)!
const s2 = resultsBySeason.get(2)!
let s1WonS2Lost = 0
for (const [seed, r1] of s1) {
  const r2 = s2.get(seed)
  if (r1.win && r2 && !r2.win) s1WonS2Lost++
}
console.log(`Paired seeds where season-1-start won but season-2-start lost: ${s1WonS2Lost}/${seedCount}`)
console.log(`(wall clock: ${((Date.now() - overallStart) / 1000).toFixed(1)}s, ${total} games total)`)
