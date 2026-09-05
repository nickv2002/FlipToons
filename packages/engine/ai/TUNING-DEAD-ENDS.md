# Match AI tuning: dead ends

Parameter values and heuristic designs that were tried for the match-play Monte Carlo bot, measured with the A/B benches in this directory, and rejected. Recorded so a future tuning pass doesn't re-spend an evening re-discovering the same negative results. Every number below is a real bench result, reproducible with the command given — nothing here is a guess.

The shipped state (what these were tried _against_) is documented in `matchAdapter.ts` (`buildMatchAdapter`'s `heuristicScore` hook, `opponentActionFor`, `OPPONENT_POLICY_CANDIDATE_CAP`, `RELATIVE_LEAD_WEIGHT`) and `heuristic.ts` (`matchScoreState`). This file is the "don't" list; that code is the "do" list.

**The recurring shape.** Nearly every rejected value below shows the same pattern: a change that wins on season 1 loses on season 2, or vice versa. Season 1 and season 2 have different card pools and different market/deck sizes (see `CLAUDE.md`), and they respond to additive heuristic terms in opposite directions often enough that **a result on one season alone proves nothing** — always validate both seasons before trusting a tuning change. `bench-ab-pool.ts`'s multi-season support exists specifically so this is one run, not an excuse to skip season 2.

## Rejected: solo's full `scoreState` reused directly for match play

**What was tried:** wiring `heuristic.ts`'s existing solo `scoreState` straight into `matchAdapter.ts`'s `heuristicScore` hook, unmodified.

**Result:** season 1 **25.0%** win rate vs. the pre-heuristic uniform-random baseline (75.0% baseline) — a severe regression, not a wash. (`bench-match.ts`, 40 seeds, 150 sims/150 steps.)

**Why:** `scoreState` carries two terms — `deckConservationSignal` and a `toonDeckDepleted` penalty — that exist specifically to steer away from **solo's deck-depletion loss condition**. A match never ends that way (see `memory: project_deck_depletion_only_loss.md` — depletion-as-loss is solo-only). In a competitive seat-vs-seat game, "conserving" the shared deck while an opponent keeps converting fame is forfeiting tempo, not caution.

**Superseded by:** `heuristic.ts`'s `matchScoreState` — the same formula minus those two terms. Do not re-add deck-conservation/depletion terms to the match heuristic without a bench proving they help.

## Rejected: `OPPONENT_POLICY_CANDIDATE_CAP = 8` (shipped: 4)

**What was tried:** raising the bounded-greedy opponent-modeling cap (how many of an opponent's own candidates get scored per rollout step) from 4 to 8, hoping more thorough opponent modeling would sharpen the search further.

**Result:** 60.0% vs. the pre-heuristic baseline, statistically indistinguishable from cap=4's own 62.5% at this seed count (n=40, season 1) — and at meaningfully higher wall-clock cost per opponent decision. (`bench-match.ts` with `OPPONENT_POLICY_CANDIDATE_CAP` temporarily edited to 8, then reverted.)

**Why not adopted:** no measurable win for real cost. Kept at 4.

## Rejected: rollout temperature=0.3 + candidate-cap=5, combined

**What was tried:** lowering `core.ts`'s `HEURISTIC_ROLLOUT_TEMPERATURE` (default 0.5, more greedy sampling) together with raising `MAX_SCORED_ROLLOUT_CANDIDATES` (default 3) to 5, via `AiOptions`'s per-call overrides, for match play only.

**Result:** season 1 **42.5%** (worse than the defaults) / season 2 **62.5%** (better) — the disagreement shape again, at ~2x the wall-clock of the defaults. (`bench-rollout-tuning.ts`, 40 seeds/season, both seasons in one run.)

**Why not adopted:** no net win, real cost increase. `AiOptions` still exposes `heuristicRolloutTemperature`/`maxScoredRolloutCandidates` as a tested, working lever (`matchAdapter.ts` passes neither) — the mechanism is fine, this specific combination isn't.

## Rejected: candidate-cap=5 ALONE (temperature unchanged)

**What was tried:** isolating the cap change from the temperature change above, keeping temperature at the 0.5 default.

**Result — and the trap:** a small sample first (n=24, season 1 only) measured a promising **62.5%** win. The full validation (n=40, BOTH seasons) told a different story: season 1 **55.0%** (marginal, within noise at n=40) / season 2 **42.5%** (a real loss). The small-sample result did not replicate.

**Why this one is worth its own entry:** it's not just "this value doesn't work" — it's a warning about **trusting a small-sample, single-season result**. A promising read at n=24/one-season needs the full both-season bench (`bench-rollout-tuning.ts` with a season list, not a single season) before it's believed. This is exactly why `bench-ab-pool.ts` runs every requested season through one shared queue: so "run both seasons" is the default invocation, not an extra step someone skips under time pressure.

## Rejected: `RELATIVE_LEAD_WEIGHT = 0.5` (shipped: 0.2)

**What was tried:** the relative-standing term (own live fame minus best opponent's live fame, folded into `heuristicScore`) at a higher weight than what shipped.

**Result:** season 1 **40.0%** (worse than the plain-`matchScoreState` baseline) / season 2 **57.5%** (better). Same disagreement shape. (`bench-relative-heuristic.ts`, 40 seeds/season.)

**0.1 and 0.3 were also checked** (quick season-1-only brackets, n=24, against the shipped 0.2 as baseline) and both lost to 0.2: 0.1 → 41.7%, 0.3 → 37.5%. 0.2 is a real local peak, not an arbitrary pick between two failed extremes — but it has **not** been re-swept below 0.1 or above 0.5.

## Reproducing any of these

```
bun run packages/engine/ai/bench-match.ts <games> <sims> <steps> <seasons>
bun run packages/engine/ai/bench-opponent-policy.ts <games> <sims> <steps> <seasons>
bun run packages/engine/ai/bench-rollout-tuning.ts <games> <sims> <steps> <seasons> [temperatureB] [candidateCapB]
bun run packages/engine/ai/bench-relative-heuristic.ts <games> <sims> <steps> <seasons> [leadWeight]
```

`<seasons>` accepts a comma-separated list (`1,2`) — always check both before trusting a result, per the recurring-shape note above. All four are worker-pool parallelized (`bench-ab-pool.ts`); expect roughly 25-40 minutes for a full 40-seed/season run on a 16-core machine.
