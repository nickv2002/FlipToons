// Shared multi-season A/B pool runner for the three bot-vs-bot benches
// (bench-match.ts, bench-opponent-policy.ts, bench-rollout-tuning.ts).
// Mirrors bench.ts's own multi-season pattern (comma-separated seasons, ONE
// shared task queue, ONE worker pool sized to the machine regardless of how
// many seasons are requested) — running seasons as SEPARATE processes each
// spins up its own pool, so two seasons side by side can oversubscribe the
// machine 2x; one shared queue keeps the worker count capped at POOL_SIZE
// no matter how many seasons are in the run.
import type { Season } from '../cards/types'
import { startProgressTicker } from './bench-progress'

export type AbTask = { taskId: number; season: Season; aIsP0: boolean }
export type AbResult = { taskId: number; season: Season; winner: 'A' | 'B' | 'tie' | 'notEnded'; turns: number }

const MAX_POOL_SIZE = 16

type SeasonAgg = { winsA: number; winsB: number; ties: number; notEnded: number; total: number }

export async function runAbPool<Task extends AbTask>(opts: {
  seasons: Season[]
  gamesPerSeason: number
  seedBase: number
  workerUrl: URL
  buildTask: (taskId: number, season: Season, seed: number, aIsP0: boolean) => Task
  labelA: string
  labelB: string
  summaryTag?: string // extra bracketed info for the report line, e.g. cap/temperature overrides
}): Promise<void> {
  const { seasons, gamesPerSeason, seedBase, workerUrl, buildTask, labelA, labelB, summaryTag } = opts

  const tasks: Task[] = []
  let nextTaskId = 0
  for (const season of seasons) {
    for (let i = 0; i < gamesPerSeason; i++) {
      tasks.push(buildTask(nextTaskId, season, seedBase + i, nextTaskId % 2 === 0))
      nextTaskId++
    }
  }
  const total = tasks.length

  const aggBySeason = new Map<string, SeasonAgg>()
  for (const season of seasons) aggBySeason.set(String(season), { winsA: 0, winsB: 0, ties: 0, notEnded: 0, total: gamesPerSeason })

  const cpuCount = (require('node:os') as typeof import('node:os')).cpus().length
  const POOL_SIZE = Math.max(1, Math.min(cpuCount, MAX_POOL_SIZE, total))

  let completed = 0
  const overallStart = Date.now()

  let nextIndex = 0
  function runPoolWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl.href)
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

      worker.onmessage = (event: MessageEvent<AbResult>) => {
        const { winner, turns, taskId, season } = event.data
        const agg = aggBySeason.get(String(season))!
        if (winner === 'A') agg.winsA++
        else if (winner === 'B') agg.winsB++
        else if (winner === 'tie') agg.ties++
        else {
          agg.notEnded++
          console.log(`  game ${taskId} (season ${season}): did not terminate after ${turns} turns`)
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

  const stopTicker = startProgressTicker(() => completed, total)
  const workerPromises: Promise<void>[] = []
  for (let i = 0; i < POOL_SIZE; i++) workerPromises.push(runPoolWorker())
  await Promise.all(workerPromises)
  stopTicker()

  const tag = summaryTag ? ` [${summaryTag}]` : ''
  for (const season of seasons) {
    const agg = aggBySeason.get(String(season))!
    const winRateA = ((agg.winsA / agg.total) * 100).toFixed(1)
    const winRateB = ((agg.winsB / agg.total) * 100).toFixed(1)
    console.log(
      `season ${season}${tag}: ${labelA}-A ${agg.winsA}/${agg.total} (${winRateA}%), ${labelB}-B ${agg.winsB}/${agg.total} (${winRateB}%), ties ${agg.ties}` +
        (agg.notEnded ? `, ${agg.notEnded} did not terminate` : ''),
    )
  }
  console.log(`(pool=${POOL_SIZE}, ${total} games total: ${((Date.now() - overallStart) / 1000).toFixed(1)}s)`)
}
