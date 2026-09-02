// Bot-vs-bot A/B match benchmark for matchAdapter.ts's heuristicScore
// addition, parallelized as a worker pool (mirrors bench.ts/bench-worker.ts's
// pattern) so many full games run concurrently instead of one at a time.
//
// Both seats search at the SAME simulation/step budget; seat A gets the real
// buildMatchAdapter (heuristicScore-weighted rollouts), seat B gets the same
// adapter with heuristicScore stripped (uniform-random rollouts — the
// pre-change behavior). Seat identity (A/B) alternates between p0/p1 every
// game so turn order can't bias the result. Any win-rate gap this measures
// is purely from rollout policy quality at a FIXED sim budget, never from
// spending more search.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-match.ts [games] [sims] [steps] [season]
import type { Season } from '../cards/types'
import type { BenchMatchTask, BenchMatchResult } from './bench-match-worker'

const [gamesArg, simsArg, stepsArg, seasonArg] = process.argv.slice(2)
const games = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const season: Season = seasonArg === 'both' ? 'both' : (parseInt(seasonArg ?? '1', 10) as 1 | 2)

const SEED_BASE = 9000
const MAX_POOL_SIZE = 16
const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
const POOL_SIZE = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE, games))

const tasks: BenchMatchTask[] = []
for (let i = 0; i < games; i++) {
  tasks.push({ taskId: i, seed: SEED_BASE + i, season, simulations, maxStepsPerPlayout, aIsP0: i % 2 === 0 })
}

let winsA = 0
let winsB = 0
let ties = 0
let notEnded = 0
let completed = 0
const overallStart = Date.now()

let nextIndex = 0
function runPoolWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench-match-worker.ts', import.meta.url).href)
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

    worker.onmessage = (event: MessageEvent<BenchMatchResult>) => {
      const { winner, turns, taskId } = event.data
      if (winner === 'A') winsA++
      else if (winner === 'B') winsB++
      else if (winner === 'tie') ties++
      else {
        notEnded++
        console.log(`  game ${taskId}: did not terminate after ${turns} turns`)
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

const winRateA = ((winsA / games) * 100).toFixed(1)
const winRateB = ((winsB / games) * 100).toFixed(1)
console.log(
  `season ${season} sims=${simulations} steps=${maxStepsPerPlayout} games=${games} pool=${POOL_SIZE}: ` +
    `heuristic-A ${winsA}/${games} (${winRateA}%), baseline-B ${winsB}/${games} (${winRateB}%), ties ${ties}` +
    (notEnded ? `, ${notEnded} did not terminate` : '') +
    ` — ${((Date.now() - overallStart) / 1000).toFixed(1)}s total`,
)
