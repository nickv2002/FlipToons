// Browser Web Worker running the Monte Carlo AI off the main thread, so a
// bot's turn doesn't freeze the UI mid-search. Vite ships this natively via
// `new Worker(new URL('./matchAiWorker.ts', import.meta.url), { type:
// 'module' })` — no bundler config needed (Vite 6). Same idea as
// packages/engine/ai/bench-worker.ts (a Bun worker for the offline
// benchmark); this is the browser counterpart, spawned per-tab instead of
// pooled.
import type { Match, PlayerId } from '../../../../packages/engine/state'
import type { MatchAction } from '../../../../packages/engine/matchActions'
import { chooseBestMatchAction } from '../../../../packages/engine/ai'
import type { MatchDifficulty } from '../../../../packages/engine/ai'

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

self.onmessage = (event) => {
  const { match, botSeatId, difficulty } = event.data
  try {
    const action = chooseBestMatchAction(match, botSeatId, { difficulty })
    self.postMessage({ action })
  } catch (e) {
    self.postMessage({ error: String(e) })
  }
}
