// A/B match benchmark sweeping core.ts's rollout-policy knobs
// (heuristicRolloutTemperature, maxScoredRolloutCandidates) for MATCH play
// specifically, via the per-call AiOptions overrides those knobs support —
// solo's own defaults/benches are untouched. Seat A stays at solo's
// defaults; seat B gets the candidate override.
//
// Supports multiple seasons in ONE run (comma-separated) through a single
// shared task queue/worker pool — see bench-ab-pool.ts's header.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-rollout-tuning.ts [games] [sims] [steps] [seasons] [temperatureB] [candidateCapB]
import type { Season } from '../cards/types'
import type { RolloutTuningTask } from './bench-rollout-tuning-worker'
import { runAbPool } from './bench-ab-pool'

const [gamesArg, simsArg, stepsArg, seasonsArg, temperatureArg, capArg] = process.argv.slice(2)
const gamesPerSeason = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const seasons: Season[] = (seasonsArg ?? '1').split(',').map((s) => (s === 'both' ? 'both' : (parseInt(s, 10) as 1 | 2)))
const temperatureB = temperatureArg ? parseFloat(temperatureArg) : undefined
const candidateCapB = capArg ? parseInt(capArg, 10) : undefined

await runAbPool<RolloutTuningTask>({
  seasons,
  gamesPerSeason,
  seedBase: 13000,
  workerUrl: new URL('./bench-rollout-tuning-worker.ts', import.meta.url),
  buildTask: (taskId, season, seed, aIsP0) => ({ taskId, season, seed, simulations, maxStepsPerPlayout, aIsP0, temperatureB, candidateCapB }),
  labelA: 'default',
  labelB: 'override',
  summaryTag: `B overrides: temp=${temperatureB ?? 'default'} cap=${candidateCapB ?? 'default'}`,
})
