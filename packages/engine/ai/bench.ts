// Solo AI win-rate benchmark. Rerun this after any change to heuristic.ts,
// core.ts's search, or soloAdapter.ts to check for regressions and to sweep
// simulation/step budgets against win rate and wall-clock cost — this is
// the exact tool used to validate the heuristicScore addition (see
// core.ts's DEFAULT_SIMULATIONS/DEFAULT_MAX_STEPS_PER_PLAYOUT comment).
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
import { buildNewGameState, playSoloAutomatically } from './index'
import { makeRng } from '../rng'

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

for (const season of seasons) {
  let wins = 0
  let notEnded = 0
  const start = Date.now()
  for (let i = 0; i < seedCount; i++) {
    const seed = SEED_BASE + i
    const state = buildNewGameState(seed, difficulty, season)
    const result = playSoloAutomatically(state, {
      simulations,
      maxStepsPerPlayout,
      maxSteps: 400,
      rng: makeRng(seed * 7 + 3),
    })
    if (result.state.phase !== 'ended') {
      notEnded++
      continue
    }
    if (result.state.result === 'win') wins++
  }
  const elapsedS = (Date.now() - start) / 1000
  const winRate = ((wins / seedCount) * 100).toFixed(1)
  console.log(
    `season ${String(season).padEnd(4)} difficulty=${difficulty}: ${wins}/${seedCount} wins (${winRate}%)` +
      (notEnded ? `, ${notEnded} did not terminate` : '') +
      ` — ${elapsedS.toFixed(1)}s total, ${(elapsedS / seedCount).toFixed(2)}s/game` +
      ` [sims=${simulations ?? 'default'} steps=${maxStepsPerPlayout ?? 'default'}]`,
  )
}
