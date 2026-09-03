// A/B match benchmark for matchAdapter.ts's opponentActionFor change
// (bounded-greedy vs the pre-change passive/first-option rollout stand-in),
// isolated from the heuristicScore change validated separately by
// bench-match.ts. Both seats get the real heuristicScore-weighted adapter
// for their OWN decisions; only their rollouts' opponent-modeling policy
// differs.
//
// Supports multiple seasons in ONE run (comma-separated) through a single
// shared task queue/worker pool — see bench-ab-pool.ts's header.
//
// Usage (bun):
//   bun run packages/engine/ai/bench-opponent-policy.ts [games] [sims] [steps] [seasons]
import type { Season } from '../cards/types'
import type { OpponentPolicyTask } from './bench-opponent-policy-worker'
import { runAbPool } from './bench-ab-pool'

const [gamesArg, simsArg, stepsArg, seasonsArg] = process.argv.slice(2)
const gamesPerSeason = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const seasons: Season[] = (seasonsArg ?? '1').split(',').map((s) => (s === 'both' ? 'both' : (parseInt(s, 10) as 1 | 2)))

await runAbPool<OpponentPolicyTask>({
  seasons,
  gamesPerSeason,
  seedBase: 11000,
  workerUrl: new URL('./bench-opponent-policy-worker.ts', import.meta.url),
  buildTask: (taskId, season, seed, aIsP0) => ({ taskId, season, seed, simulations, maxStepsPerPlayout, aIsP0 }),
  labelA: 'greedy-opponent',
  labelB: 'passive-opponent',
})
