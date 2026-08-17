import type { LogEntry } from '../useGame'

export type ResolveLogProps = {
  log: LogEntry[]
}

// Mirrors what tui.ts's `out` callback prints to the terminal — a running
// log of flips/scoring/hires/dismisses, newest at the bottom.
export function ResolveLog({ log }: ResolveLogProps) {
  return (
    <div className="resolve-log">
      {log.map((entry, i) => (
        <pre className="resolve-log__entry" key={i}>
          <span className="resolve-log__round">R{entry.round}</span> {entry.text}
        </pre>
      ))}
    </div>
  )
}
