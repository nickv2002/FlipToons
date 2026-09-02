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
// Supports multiple seasons in ONE run (comma-separated, e.g. "1,2") through
// a single shared task queue/worker pool — bench-ab-pool.ts's own header
// explains why that matters (running seasons as separate processes
// oversubscribes the machine).
//
// Usage (bun):
//   bun run packages/engine/ai/bench-match.ts [games] [sims] [steps] [seasons]
//   bun run packages/engine/ai/bench-match.ts 40 150 150 1,2
import type { Season } from '../cards/types'
import type { BenchMatchTask } from './bench-match-worker'
import { runAbPool } from './bench-ab-pool'

const [gamesArg, simsArg, stepsArg, seasonsArg] = process.argv.slice(2)
const gamesPerSeason = parseInt(gamesArg ?? '20', 10)
const simulations = parseInt(simsArg ?? '150', 10)
const maxStepsPerPlayout = parseInt(stepsArg ?? '150', 10)
const seasons: Season[] = (seasonsArg ?? '1').split(',').map((s) => (s === 'both' ? 'both' : (parseInt(s, 10) as 1 | 2)))

await runAbPool<BenchMatchTask>({
  seasons,
  gamesPerSeason,
  seedBase: 9000,
  workerUrl: new URL('./bench-match-worker.ts', import.meta.url),
  buildTask: (taskId, season, seed, aIsP0) => ({ taskId, season, seed, simulations, maxStepsPerPlayout, aIsP0 }),
  labelA: 'heuristic',
  labelB: 'baseline',
})
