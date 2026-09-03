// Shared "N/total done" progress ticker for the bench CLI drivers
// (bench.ts, bench-match.ts, bench-opponent-policy.ts,
// bench-rollout-tuning.ts) — logs a line every 10s so a long pooled run
// shows live progress instead of going silent until the final summary.
export function startProgressTicker(getCompleted: () => number, total: number, intervalMs = 10000): () => void {
  const start = Date.now()
  const timer = setInterval(() => {
    const completed = getCompleted()
    const elapsedS = ((Date.now() - start) / 1000).toFixed(0)
    console.log(`  ${completed}/${total} done (${elapsedS}s elapsed)`)
  }, intervalMs)
  return () => clearInterval(timer)
}
