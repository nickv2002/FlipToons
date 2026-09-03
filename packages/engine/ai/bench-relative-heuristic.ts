// A/B match benchmark for a candidate RELATIVE-STANDING heuristic (own live
// fame minus best opponent's live fame, added to the shipped
// matchScoreState) vs. the shipped own-view-only matchScoreState. See
// bench-relative-heuristic-worker.ts's header for the full rationale.
//
// Supports multiple seasons in ONE run (comma-separated) through a single
// shared task queue/worker pool — see bench-ab-pool.ts's header.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-relative-heuristic.ts [games] [sims] [steps] [seasons] [leadWeight]
import type { Season } from '../cards/types'
import type { RelativeHeuristicTask } from './bench-relative-heuristic-worker'
import { runAbPool } from './bench-ab-pool'

const [gamesArg, simsArg, stepsArg, seasonsArg, leadWeightArg] = process.argv.slice(2)
const gamesPerSeason = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const seasons: Season[] = (seasonsArg ?? '1').split(',').map((s) => (s === 'both' ? 'both' : (parseInt(s, 10) as 1 | 2)))
const leadWeight = parseFloat(leadWeightArg ?? '0.5')

await runAbPool<RelativeHeuristicTask>({
  seasons,
  gamesPerSeason,
  seedBase: 15000,
  workerUrl: new URL('./bench-relative-heuristic-worker.ts', import.meta.url),
  buildTask: (taskId, season, seed, aIsP0) => ({ taskId, season, seed, simulations, maxStepsPerPlayout, aIsP0, leadWeight }),
  labelA: 'own-view',
  labelB: 'relative',
  summaryTag: `B leadWeight=${leadWeight}`,
})
