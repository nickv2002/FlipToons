// Per-candidate scoring sub-worker, spawned by matchAiWorker.ts's parallel
// orchestrator (see .claude/scratch/parallel-monte-carlo-ai-plan.md). Scores
// exactly ONE candidate action against an already fast-forwarded match state
// via evaluateMatchActionAt — the fast-forward itself (advanceToBotDecision)
// runs once in the orchestrator, not once per sub-worker. Same worker-globals
// workaround as matchAiWorker.ts (apps/web's tsconfig carries "DOM", which
// can't coexist with "WebWorker" in one program).
import type { Match, PlayerId } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import { evaluateMatchActionAt, type MatchAiOptions } from '../../../../packages/engine/ai'
import { makeRng } from '../../../../packages/engine/rng'

export type CandidateWorkerRequest = {
  at: Match // already fast-forwarded via prepareMatchDecision — see matchAiWorker.ts
  botSeatId: PlayerId
  action: MatchAction
  opts: MatchAiOptions
  seed: number // caller-assigned, distinct per candidate
}
export type CandidateWorkerResponse = { score: number } | { error: string }

declare const self: {
  onmessage: ((event: { data: CandidateWorkerRequest }) => void) | null
  postMessage: (data: CandidateWorkerResponse) => void
}

self.onmessage = (event) => {
  const { at, botSeatId, action, opts, seed } = event.data
  try {
    const score = evaluateMatchActionAt(at, botSeatId, action, { ...opts, rng: makeRng(seed) })
    self.postMessage({ score })
  } catch (e) {
    self.postMessage({ error: String(e) })
  }
}
