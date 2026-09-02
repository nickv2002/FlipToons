// Transport-agnostic Monte Carlo evaluator/driver. Knows nothing about
// GameState, Match, actions.ts, or matchActions.ts — every game-specific
// concern (what's a legal move, how to apply one, when the game is over, who
// won) is supplied by an AiAdapter. This is what lets solo and a future
// multiplayer match share one search implementation: `matchActions.ts` must
// not import `actions.ts` (solo carries house rules — instant-win,
// guaranteed-loss shortcuts, the atomic flip cascade — that are wrong at a
// table), so the search itself has to live somewhere neither reducer is
// privileged, with a thin adapter on each side translating to/from it.
import type { Rng } from '../rng'
import { makeRng } from '../rng'

export type AiAdapter<S, A> = {
  // Every legal action in the current state, already fully formed — a card
  // whose hire/dismiss needs a player choice must come back as one candidate
  // PER legal choice, not a single candidate with the choice missing (an
  // adapter that emits an incomplete action is a bug in the adapter, not
  // something the core can validate).
  legalCandidates(state: S): A[]
  apply(state: S, action: A): S // pure
  isTerminal(state: S): boolean
  reward(state: S): number // meaningful only once isTerminal(state) — 1 win / 0 loss (or a shaped value in between), adapter-defined
  clone(state: S): S // an independent copy safe to branch a rollout from
  // OPTIONAL. When supplied, rolloutStep below weights its pick toward
  // higher-scoring candidates (softmax over each candidate's resulting-state
  // score) instead of picking uniformly at random. Absent, behavior is
  // UNCHANGED — core.ts stays adapter-agnostic either way: it only ever
  // calls this hook, never reasons about what S/A actually contain.
  heuristicScore?(state: S): number
}

export type AiOptions = {
  simulations?: number // playouts per candidate action
  maxStepsPerPlayout?: number // safety cap so a stuck playout can't loop forever
  rng?: Rng // the AI's OWN decision randomness — deliberately separate from any seed carried inside S, since advisory playouts must never perturb the real game's own RNG sequence
  // Both default to the solo-tuned constants below (HEURISTIC_ROLLOUT_TEMPERATURE/
  // MAX_SCORED_ROLLOUT_CANDIDATES) when omitted, so solo's behavior is
  // byte-identical unless a caller opts in — added so a DIFFERENT adapter
  // could sweep its own rollout-policy tuning without ever touching solo's
  // validated defaults.
  //
  // SWEPT for match play and left UNUSED (matchAdapter.ts passes neither).
  // bench-rollout-tuning.ts, 40 seeds/season, fixed 150-sim budget, vs.
  // these defaults:
  //   temperature=0.3 + cap=5 combined: 42.5% season 1 (worse) / 62.5%
  //     season 2 (better)
  //   cap=5 alone (temperature unchanged): 55.0% season 1 (marginal, within
  //     noise at n=40) / 42.5% season 2 (worse) — an EARLIER n=24,
  //     season-1-only read of this same combo looked like a clean 62.5% win
  //     and did NOT replicate at full scale, which is itself worth noting:
  //     a promising small-sample rollout-tuning result here needs the full
  //     both-season bench before it's trusted, not just a bigger n on one
  //     season.
  // Every variant tried shows the same per-season-disagreement shape
  // heuristic.ts's own history comments document repeatedly for OTHER
  // tuning attempts (something that helps season 1 hurts season 2, or vice
  // versa), at ~2x the wall-clock of the defaults. No net win found on this
  // axis; kept here as a real, tested lever in case a future signal (a
  // different candidate value, or a match-shaped heuristicScore change) is
  // worth re-sweeping against.
  heuristicRolloutTemperature?: number
  maxScoredRolloutCandidates?: number
}

// Tuned against a batch of 40 seeds/season at 'normal' difficulty after
// fixing soloAdapter.ts's reward-on-cap-hit bug (see its own comment): with
// the old 24/60 defaults, most season-2 playouts were still running (bigger
// card pool, more market steps per round — see soloAdapter's benchmark
// notes) when maxStepsPerPlayout cut them off, so the search was starved of
// real signal regardless of the reward fix. 150/150 reaches ~75%/~55% win
// rate on season 1/2 respectively (target was ~50% on each) at ~2.5-3s per
// full game — a batch of 40 games takes ~100-125s. Lower simulation counts
// (24-96) plateaued well under 50% on season 2 specifically; this is a
// deliberate cost/strength tradeoff, not the ceiling of what's tunable.
//
// UPDATE after adding heuristicScore-weighted rollouts (heuristic.ts): kept
// these defaults AS-IS — 150/150 with the heuristic on measured 82.5%/57.5%/
// 90.0% on season 1/2/both (40 seeds each, up from the ~75%/~55%/~65%
// pre-heuristic baseline, no regression on any season) — but per-game
// wall-clock rose to ~8-11s (heuristicScore-weighted rolloutStep applies
// several extra candidates per rollout step — see
// MAX_SCORED_ROLLOUT_CANDIDATES below — instead of one uniform pick). A
// reduced-budget sweep (100x100, 50x75; 20 seeds/season) was tried
// specifically to see whether the smarter rollouts could buy back that cost
// and came back strictly worse on BOTH axes, not just slower-for-the-same-
// quality: season 2 fell to 45% at 100x100 and 15% at 50x75, and per-game
// wall-clock at 50x75 (18s) was WORSE than full budget, not better — a
// weaker search takes longer to stumble into a terminal state, not shorter.
// Left unchanged rather than force a tradeoff that measured worse both ways.
const DEFAULT_SIMULATIONS = 150
const DEFAULT_MAX_STEPS_PER_PLAYOUT = 150
const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60 * 1000

// Softmax temperature for heuristic-weighted rollout sampling. Low enough to
// meaningfully favor better-looking candidates, high enough that the policy
// stays stochastic (a rollout is still a SAMPLE, not another best-action
// search — chooseBestAction already does exhaustive comparison via many such
// samples; a near-greedy rollout policy would just collapse every playout to
// the same line and lose the averaging benefit of Monte Carlo sampling).
const HEURISTIC_ROLLOUT_TEMPERATURE = 0.5

// Scoring a candidate means APPLYING it (adapter.apply runs the whole real
// reducer, not a cheap simulation of it) — so weighted rolloutStep's cost is
// proportional to the branching factor at every single rollout step, not
// just once per real decision the way it was under uniform-random picking.
// Left unbounded, a market phase with a dozen-plus hire/dismiss candidates
// (season 'both' especially) turned every playout step into a dozen-plus
// full applies instead of one, which measured as a ~15x wall-clock blowup on
// an unrelated regression test before this cap was added. Capping the
// scored SAMPLE bounds worst-case rollout cost to a small constant
// regardless of branching factor; the candidates left unscored this step
// just don't get a heuristic-informed weight (uniform miss), which is fine —
// a rollout step is a sample, not the real search, and which few candidates
// get scored varies playout to playout.
const MAX_SCORED_ROLLOUT_CANDIDATES = 3

// Cheap continuation policy used ONLY inside a playout, after the candidate
// action under evaluation has already been applied. Uniform-random among
// whatever's currently legal when the adapter supplies no heuristic; when it
// does, weighted toward higher-scoring resulting states via softmax sampling
// instead of a flat pick. Either way this is intentionally not exhaustive
// search — the outer evaluateAction/chooseBestAction loop is what does the
// actual comparison, by averaging outcomes across many such playouts per
// candidate; the heuristic only makes each individual playout's random walk
// a more realistic approximation of how the game is actually played.
// `count` indices in [0, n) without replacement, via partial Fisher-Yates —
// O(min(count, n)), never allocates/shuffles the full range when n is large.
function sampleIndices(n: number, count: number, rng: Rng): number[] {
  if (count >= n) return Array.from({ length: n }, (_, i) => i)
  const pool = Array.from({ length: n }, (_, i) => i)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (n - i))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, count)
}

function rolloutStep<S, A>(adapter: AiAdapter<S, A>, state: S, rng: Rng, temperature: number, candidateCap: number): S {
  const candidates = adapter.legalCandidates(state)
  if (candidates.length === 1) return adapter.apply(state, candidates[0]!)

  if (adapter.heuristicScore) {
    const heuristicScore = adapter.heuristicScore
    // apply() is documented pure (AiAdapter's contract) — it must not mutate
    // its `state` argument, so scoring a candidate's resulting state needs
    // no adapter.clone() here (an earlier version of this cloned per
    // candidate per rollout step and made soloAdapter's structuredClone the
    // dominant cost).
    const pool = sampleIndices(candidates.length, candidateCap, rng)
    const scores = pool.map((i) => heuristicScore(adapter.apply(state, candidates[i]!)))
    const max = Math.max(...scores)
    const weights = scores.map((s) => Math.exp((s - max) / temperature))
    const total = weights.reduce((sum, w) => sum + w, 0)
    let pick = rng() * total
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!
      if (pick <= 0) return adapter.apply(state, candidates[pool[i]!]!)
    }
    return adapter.apply(state, candidates[pool[pool.length - 1]!]!)
  }

  const action = candidates[Math.floor(rng() * candidates.length)]!
  return adapter.apply(state, action)
}

function playout<S, A>(adapter: AiAdapter<S, A>, state: S, rng: Rng, maxSteps: number, temperature: number, candidateCap: number): S {
  let s = state
  let steps = 0
  while (!adapter.isTerminal(s) && steps < maxSteps) {
    s = rolloutStep(adapter, s, rng, temperature, candidateCap)
    steps++
  }
  return s
}

export function evaluateAction<S, A>(adapter: AiAdapter<S, A>, state: S, action: A, opts: AiOptions = {}): number {
  const simulations = opts.simulations ?? DEFAULT_SIMULATIONS
  const maxSteps = opts.maxStepsPerPlayout ?? DEFAULT_MAX_STEPS_PER_PLAYOUT
  const rng = opts.rng ?? makeRng(Date.now() >>> 0)
  const temperature = opts.heuristicRolloutTemperature ?? HEURISTIC_ROLLOUT_TEMPERATURE
  const candidateCap = opts.maxScoredRolloutCandidates ?? MAX_SCORED_ROLLOUT_CANDIDATES

  let total = 0
  for (let i = 0; i < simulations; i++) {
    const afterAction = adapter.apply(adapter.clone(state), action)
    total += adapter.reward(playout(adapter, afterAction, rng, maxSteps, temperature, candidateCap))
  }
  return total / simulations
}

export type ScoredAction<A> = { action: A; score: number }

// Ranked highest-score-first; ties resolve by candidate order (whatever the
// adapter's legalCandidates puts first among equal scores).
//
// A heuristicScore-based pre-sort was tried here (break ties toward the
// heuristically-better candidate instead of raw array order) and reverted:
// with a small simulation count, most candidates' averaged reward ties or
// nearly ties (`evaluateAction`'s .sort below is STABLE, so a tie keeps
// whatever order it was handed), and it turns out soloAdapter's
// heuristicScore ranks "dismiss the whole grid" surprisingly high (several
// fame bonuses read the dismissed pile — see soloAdapter's own reward()
// comment for the measured seed). A pre-sort meant as a minor tie-break
// ended up deciding real games outright: seed 102 (easy, season 1) got
// stuck dismissing forever with the pre-sort in, and resolved normally at
// 90 real decisions with it out. Rollout-step weighting (below) doesn't
// have this failure mode — it only nudges a bounded RANDOM SAMPLE inside a
// playout, never deterministically decides a real top-level action — so it
// stays; only this pre-sort was removed.
export function evaluateCandidates<S, A>(adapter: AiAdapter<S, A>, state: S, opts: AiOptions = {}): ScoredAction<A>[] {
  return adapter
    .legalCandidates(state)
    .map((action) => ({ action, score: evaluateAction(adapter, state, action, opts) }))
    .sort((a, b) => b.score - a.score)
}

export function chooseBestAction<S, A>(adapter: AiAdapter<S, A>, state: S, opts: AiOptions = {}): A {
  const scored = evaluateCandidates(adapter, state, opts)
  if (scored.length === 0) throw new Error('ai/core.ts: chooseBestAction — no legal candidates in a non-terminal state')
  return scored[0]!.action
}

export type AutoplayResult<S, A> = { state: S; actionsTaken: A[] }

// Drives a state to a terminal one, using chooseBestAction — the real
// search, not the cheap rollout policy — for every decision.
export function playAutomatically<S, A>(
  adapter: AiAdapter<S, A>,
  state: S,
  opts: AiOptions & { maxSteps?: number; maxWallClockMs?: number } = {},
): AutoplayResult<S, A> {
  const maxSteps = opts.maxSteps ?? 400
  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS
  const deadline = Date.now() + maxWallClockMs

  let s = state
  const actionsTaken: A[] = []
  let steps = 0

  while (!adapter.isTerminal(s) && steps < maxSteps) {
    if (Date.now() > deadline) break
    const action = chooseBestAction(adapter, s, opts)
    s = adapter.apply(s, action)
    actionsTaken.push(action)
    steps++
  }

  return { state: s, actionsTaken }
}
