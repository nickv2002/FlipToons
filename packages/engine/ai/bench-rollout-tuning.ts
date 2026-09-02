// A/B match benchmark sweeping core.ts's rollout-policy knobs
// (heuristicRolloutTemperature, maxScoredRolloutCandidates) for MATCH play
// specifically, via the per-call AiOptions overrides those knobs now
// support — solo's own defaults/benches are untouched. Seat A stays at
// solo's defaults; seat B gets the candidate override. Worker-pool
// parallelized, same shape as bench-match.ts/bench-opponent-policy.ts.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-rollout-tuning.ts [games] [sims] [steps] [season] [temperatureB] [candidateCapB]
import type { Season } from '../cards/types'
import type { RolloutTuningTask, RolloutTuningResult } from './bench-rollout-tuning-worker'
import { startProgressTicker } from './bench-progress'

const [gamesArg, simsArg, stepsArg, seasonArg, temperatureArg, capArg] = process.argv.slice(2)
const games = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const season: Season = seasonArg === 'both' ? 'both' : (parseInt(seasonArg ?? '1', 10) as 1 | 2)
const temperatureB = temperatureArg ? parseFloat(temperatureArg) : undefined
const candidateCapB = capArg ? parseInt(capArg, 10) : undefined

const SEED_BASE = 13000
const MAX_POOL_SIZE = 16
const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
const POOL_SIZE = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE, games))

const tasks: RolloutTuningTask[] = []
for (let i = 0; i < games; i++) {
  tasks.push({ taskId: i, seed: SEED_BASE + i, season, simulations, maxStepsPerPlayout, aIsP0: i % 2 === 0, temperatureB, candidateCapB })
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
    const worker = new Worker(new URL('./bench-rollout-tuning-worker.ts', import.meta.url).href)
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

    worker.onmessage = (event: MessageEvent<RolloutTuningResult>) => {
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

const stopTicker = startProgressTicker(() => completed, games)
const workerPromises: Promise<void>[] = []
for (let i = 0; i < POOL_SIZE; i++) workerPromises.push(runPoolWorker())
await Promise.all(workerPromises)
stopTicker()

const winRateA = ((winsA / games) * 100).toFixed(1)
const winRateB = ((winsB / games) * 100).toFixed(1)
console.log(
  `season ${season} sims=${simulations} steps=${maxStepsPerPlayout} games=${games} pool=${POOL_SIZE} ` +
    `[B overrides: temp=${temperatureB ?? 'default'} cap=${candidateCapB ?? 'default'}]: ` +
    `default-A ${winsA}/${games} (${winRateA}%), override-B ${winsB}/${games} (${winRateB}%), ties ${ties}` +
    (notEnded ? `, ${notEnded} did not terminate` : '') +
    ` — ${((Date.now() - overallStart) / 1000).toFixed(1)}s total`,
)
