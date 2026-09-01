// Solo AI win-rate benchmark. Rerun this after any change to heuristic.ts,
// core.ts's search, or soloAdapter.ts to check for regressions and to sweep
// simulation/step budgets against win rate and wall-clock cost — this is
// the exact tool used to validate the heuristicScore addition (see
// core.ts's DEFAULT_SIMULATIONS/DEFAULT_MAX_STEPS_PER_PLAYOUT comment).
//
// Parallelized as a worker POOL: every individual game (one seed, in one
// season/difficulty combination) is flattened into an independent task and
// pushed onto a shared queue; a pool of workers (sized to the machine's core
// count, capped — see MAX_POOL_SIZE) pulls tasks off the queue as each one
// finishes its current game, rather than one worker per season batch running
// its 40 seeds serially inside. Seed assignment is fixed up front from
// (season, seedBase, index) and is identical regardless of execution order,
// so which games run and their outcomes are unaffected by the pool — only
// wall-clock time changes. Results are aggregated per season/difficulty once
// every task has resolved; the CLI/constants interface below is unchanged —
// this only changes how fast the games run, not what they measure or how
// you invoke them.
//
// Usage (bun, no node/npm/tsx — this repo's toolchain):
//   bun run packages/engine/ai/bench.ts [seasons] [seeds] [sims] [steps] [difficulty]
//
// All args optional, in order, with sane defaults:
//   seasons     comma-separated: "1,2,both" (default) or e.g. "1" or "both"
//   seeds       seed count per season (default 40)
//   sims        AiOptions.simulations (default core.ts's DEFAULT_SIMULATIONS)
//   steps       AiOptions.maxStepsPerPlayout (default core.ts's DEFAULT_MAX_STEPS_PER_PLAYOUT)
//   difficulty  'easy' | 'normal' | 'hard' (default 'normal')
//
// Examples:
//   bun run packages/engine/ai/bench.ts                  # 1,2,both x 40 seeds, tuned defaults
//   bun run packages/engine/ai/bench.ts both 40 100 100   # one season, reduced budget
//   bun run packages/engine/ai/bench.ts 2 20 50 75 easy   # quick smoke check
import type { SoloDifficulty } from '../setup'
import type { Season } from '../cards/types'
import type { BenchGameTask, BenchGameResult } from './bench-worker'

const [seasonsArg, seedsArg, simsArg, stepsArg, difficultyArg] = process.argv.slice(2)

const seasons: Season[] = (seasonsArg ?? '1,2,both').split(',').map((s) => (s === 'both' ? 'both' : (parseInt(s, 10) as 1 | 2)))
const seedCount = parseInt(seedsArg ?? '40', 10)
const simulations = simsArg ? parseInt(simsArg, 10) : undefined // undefined -> core.ts's own default
const maxStepsPerPlayout = stepsArg ? parseInt(stepsArg, 10) : undefined
const difficulty = (difficultyArg ?? 'normal') as SoloDifficulty

// Seed base offset by season so the same seed number across seasons still
// draws a different shuffle (buildNewGameState mixes season into its own
// deck-composition RNG regardless, but a fixed disjoint base per season
// keeps results reproducible run-to-run without seasons colliding).
const SEED_BASE = 5000

// Cap the pool well below "oversubscribe wildly" territory even on bigger
// machines; this machine has 16 real cores, so in practice cpuCount applies.
const MAX_POOL_SIZE = 16
const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
const POOL_SIZE = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE, seasons.length * seedCount))

// Build the flat task queue: one entry per (season, seed) pair, in the same
// order/seed assignment the old per-batch loop used, so results are
// identical regardless of how the pool schedules them.
type QueuedTask = BenchGameTask
const tasks: QueuedTask[] = []
let nextTaskId = 0
for (const season of seasons) {
  for (let i = 0; i < seedCount; i++) {
    tasks.push({
      taskId: nextTaskId++,
      season,
      seed: SEED_BASE + i,
      simulations,
      maxStepsPerPlayout,
      difficulty,
    })
  }
}

type StartingDeckAgg = { wins: number; notEnded: number; count: number }
type BatchAgg = {
  season: Season
  wins: number
  notEnded: number
  seedCount: number
  finishedAt: number // ms since overallStart when the batch's last task resolved
  // 'both' only: broken down by which season's starting deck was actually
  // dealt (setup.ts's pickStartingDeckSeason coin-flips this independently
  // of the mixed market pool). Unused for season 1/2 batches.
  byStartingDeck: Map<1 | 2, StartingDeckAgg>
}
// Keyed by String(season) since 'both' and numbers must coexist as keys.
const batchByKey = new Map<string, BatchAgg>()
for (const season of seasons) {
  batchByKey.set(String(season), {
    season,
    wins: 0,
    notEnded: 0,
    seedCount,
    finishedAt: 0,
    byStartingDeck: new Map([
      [1, { wins: 0, notEnded: 0, count: 0 }],
      [2, { wins: 0, notEnded: 0, count: 0 }],
    ]),
  })
}

const overallStart = Date.now()

let nextIndex = 0
let completed = 0
const total = tasks.length

function runPoolWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench-worker.ts', import.meta.url).href)
    let settled = false

    const dispatchNext = () => {
      if (nextIndex >= tasks.length) {
        settled = true
        worker.terminate()
        resolve()
        return
      }
      const task = tasks[nextIndex++]
      worker.postMessage(task)
    }

    worker.onmessage = (event: MessageEvent<BenchGameResult>) => {
      const { season, win, ended, startingDeckSeason } = event.data
      const agg = batchByKey.get(String(season))
      if (agg) {
        if (!ended) agg.notEnded++
        else if (win) agg.wins++
        agg.finishedAt = Date.now() - overallStart

        if (startingDeckSeason !== undefined) {
          const deckAgg = agg.byStartingDeck.get(startingDeckSeason)
          if (deckAgg) {
            deckAgg.count++
            if (!ended) deckAgg.notEnded++
            else if (win) deckAgg.wins++
          }
        }
      }
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
for (let i = 0; i < POOL_SIZE; i++) workerPromises.push(runPoolWorker())
await Promise.all(workerPromises)

for (const season of seasons) {
  const agg = batchByKey.get(String(season))!
  const elapsedS = agg.finishedAt / 1000
  const winRate = ((agg.wins / agg.seedCount) * 100).toFixed(1)
  console.log(
    `season ${String(season).padEnd(4)} difficulty=${difficulty}: ${agg.wins}/${agg.seedCount} wins (${winRate}%)` +
      (agg.notEnded ? `, ${agg.notEnded} did not terminate` : '') +
      ` — ${elapsedS.toFixed(1)}s total, ${(elapsedS / agg.seedCount).toFixed(2)}s/game` +
      ` [sims=${simulations ?? 'default'} steps=${maxStepsPerPlayout ?? 'default'}]`,
  )
  if (season === 'both') {
    for (const deckSeason of [1, 2] as const) {
      const deckAgg = agg.byStartingDeck.get(deckSeason)!
      if (deckAgg.count === 0) continue
      const deckWinRate = ((deckAgg.wins / deckAgg.count) * 100).toFixed(1)
      console.log(
        `both_season_${deckSeason}_start difficulty=${difficulty}: ${deckAgg.wins}/${deckAgg.count} wins (${deckWinRate}%)` +
          (deckAgg.notEnded ? `, ${deckAgg.notEnded} did not terminate` : ''),
      )
    }
  }
}
console.log(`(wall clock across pooled ${POOL_SIZE}-worker run, ${total} games total: ${((Date.now() - overallStart) / 1000).toFixed(1)}s)`)
