// Driver for bench-nplayer-worker.ts — see its header for what this
// measures (this session's shipped changes vs. the pre-session baseline, at
// player counts beyond the 2 seats they were actually validated at).
//
// Usage (bun):
//   bun run packages/engine/ai/bench-nplayer.ts [games] [players] [sims] [steps] [season]
import type { Season } from '../cards/types'
import type { NPlayerTask, NPlayerResult } from './bench-nplayer-worker'
import { startProgressTicker } from './bench-progress'

const [gamesArg, playersArg, simsArg, stepsArg, seasonArg] = process.argv.slice(2)
const games = parseInt(gamesArg ?? '16', 10)
const playerCount = parseInt(playersArg ?? '3', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const season: Season = seasonArg === 'both' ? 'both' : (parseInt(seasonArg ?? '1', 10) as 1 | 2)

const SEED_BASE = 17000
const MAX_POOL_SIZE = 16
const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
const POOL_SIZE = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE, games))

const tasks: NPlayerTask[] = []
for (let i = 0; i < games; i++) {
  tasks.push({ taskId: i, seed: SEED_BASE + i, season, playerCount, simulations, maxStepsPerPlayout, candidateSeatIndex: i % playerCount })
}

let winsCandidate = 0
let winsBaseline = 0
let ties = 0
let notEnded = 0
let completed = 0
const overallStart = Date.now()

let nextIndex = 0
function runPoolWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench-nplayer-worker.ts', import.meta.url).href)
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

    worker.onmessage = (event: MessageEvent<NPlayerResult>) => {
      const { winner, turns, taskId } = event.data
      if (winner === 'candidate') winsCandidate++
      else if (winner === 'baseline') winsBaseline++
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

const winRateCandidate = ((winsCandidate / games) * 100).toFixed(1)
console.log(
  `${playerCount}-player season ${season} sims=${simulations} steps=${maxStepsPerPlayout} games=${games} pool=${POOL_SIZE}: ` +
    `candidate ${winsCandidate}/${games} (${winRateCandidate}%), baseline-seat-won ${winsBaseline}/${games}, ties ${ties}` +
    (notEnded ? `, ${notEnded} did not terminate` : '') +
    ` — ${((Date.now() - overallStart) / 1000).toFixed(1)}s total`,
)
