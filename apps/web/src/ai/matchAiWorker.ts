// Browser Web Worker running the Monte Carlo AI off the main thread, so a
// bot's turn doesn't freeze the UI mid-search. Vite ships this natively via
// `new Worker(new URL('./matchAiWorker.ts', import.meta.url), { type:
// 'module' })` — no bundler config needed (Vite 6). Same idea as
// packages/engine/ai/bench-worker.ts (a Bun worker for the offline
// benchmark); this is the browser counterpart, spawned per-tab instead of
// pooled.
//
// Also the orchestrator for a SECOND pool of workers (matchAiCandidateWorker.ts)
// that scores a hard/extreme-difficulty market decision's candidates in
// parallel instead of sequentially — see
// .claude/scratch/parallel-monte-carlo-ai-plan.md. Easy/normal difficulty and
// single-candidate decisions stay on the original, unchanged
// chooseBestMatchAction call: they're already sub-second, so paying
// worker-spawn overhead for them would be a net loss. Nesting a worker pool
// inside a worker is supported by browsers (this file already runs inside
// its own dedicated Worker spawned by useBotSeats.ts).
import type { Match, PlayerId } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import { chooseBestMatchAction, prepareMatchDecision } from '../../../../packages/engine/ai'
import type { MatchDifficulty } from '../../../../packages/engine/ai'
import type { CandidateWorkerRequest, CandidateWorkerResponse } from './matchAiCandidateWorker'

export type MatchAiWorkerRequest = { match: Match; botSeatId: PlayerId; difficulty: MatchDifficulty }
export type MatchAiWorkerResponse = { action: MatchAction } | { error: string }

// apps/web's tsconfig carries the "DOM" lib (for the rest of the app), which
// is incompatible with "WebWorker" in the same program — so, same workaround
// as bench-worker.ts, the worker globals used here are declared locally
// rather than pulling in webworker lib repo-wide.
declare const self: {
  onmessage: ((event: { data: MatchAiWorkerRequest }) => void) | null
  postMessage: (data: MatchAiWorkerResponse) => void
}

// TUNE ME — measured slow path (see plan doc): hard/extreme decisions with
// >3 legal candidates commonly ran 2-7s sequentially in a live-shaped match.
// Below this, fall back to the existing single-shot call so easy/normal
// difficulty never pays worker-spawn overhead for no benefit.
const PARALLEL_DIFFICULTIES = new Set<MatchDifficulty>(['hard', 'extreme'])
const PARALLEL_CANDIDATE_THRESHOLD = 3

// TUNE ME — conservative cap; this runs on a player's own device, not a
// benchmarking machine. navigator.hardwareConcurrency handles low-core
// devices automatically, this just prevents pathological over-spawning on a
// high-core-count one for a modest candidate count.
const MAX_POOL_SIZE = 8

function scoreOneCandidate(request: CandidateWorkerRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./matchAiCandidateWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<CandidateWorkerResponse>) => {
      worker.terminate()
      if ('error' in event.data) reject(new Error(event.data.error))
      else resolve(event.data.score)
    }
    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }
    worker.postMessage(request)
  })
}

// Pool-of-sub-workers dispatch queue, mirroring packages/engine/ai/bench.ts's
// Bun worker pool shape (one worker per pool slot, refilled from a queue as
// each finishes) — reused rather than reinvented. Spawned fresh for this ONE
// decision and every sub-worker terminates once its single candidate is
// scored (scoreOneCandidate above), rather than a persistent pool: simpler
// lifecycle, no cross-decision/cross-render worker state to manage, and the
// gate above ensures this only runs when the decision is already expensive
// enough to be worth the spawn cost.
async function scoreCandidatesInParallel(at: Match, botSeatId: PlayerId, candidates: MatchAction[], opts: { difficulty: MatchDifficulty }): Promise<number[]> {
  const poolSize = Math.min(navigator.hardwareConcurrency || 4, MAX_POOL_SIZE, candidates.length)
  const scores = Array.from<number>({ length: candidates.length })
  let nextIndex = 0

  async function runSlot(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= candidates.length) return
      // Distinct per-candidate seed: index folded in via a large odd
      // multiplier so concurrently-dispatched candidates (same Date.now()
      // millisecond) never share an RNG stream, keeping each candidate's
      // Monte Carlo sample independent.
      const seed = (Date.now() ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0
      scores[i] = await scoreOneCandidate({ at, botSeatId, action: candidates[i]!, opts, seed })
    }
  }

  await Promise.all(Array.from({ length: poolSize }, runSlot))
  return scores
}

async function chooseBestMatchActionParallel(match: Match, botSeatId: PlayerId, difficulty: MatchDifficulty): Promise<MatchAction> {
  const { at, candidates } = prepareMatchDecision(match, botSeatId)
  if (candidates.length === 0) {
    // Preserve the existing error path: chooseBestAction throws here too.
    return chooseBestMatchAction(match, botSeatId, { difficulty })
  }
  if (candidates.length === 1) return candidates[0]!

  if (!PARALLEL_DIFFICULTIES.has(difficulty) || candidates.length <= PARALLEL_CANDIDATE_THRESHOLD) {
    return chooseBestMatchAction(match, botSeatId, { difficulty })
  }

  const scores = await scoreCandidatesInParallel(at, botSeatId, candidates, { difficulty })

  // Same tie-break as core.ts's evaluateCandidates: first candidate (in
  // legalCandidates order) to reach the max score wins ties, regardless of
  // which sub-worker happened to respond last — strict `>`, not `>=`.
  let bestIndex = 0
  let bestScore = -Infinity
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! > bestScore) {
      bestScore = scores[i]!
      bestIndex = i
    }
  }
  return candidates[bestIndex]!
}

self.onmessage = (event) => {
  const { match, botSeatId, difficulty } = event.data
  chooseBestMatchActionParallel(match, botSeatId, difficulty)
    .then((action) => self.postMessage({ action }))
    .catch((e) => self.postMessage({ error: String(e) }))
}
