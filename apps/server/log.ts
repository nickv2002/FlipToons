// Server-side logging. Deliberately tiny and console-based: this repo has zero
// runtime dependencies and a logging library would be its first.
//
// The one thing every line must carry is the ROOM CODE. Before this, the
// server logged five errors and a startup banner, none of which said which
// room they came from — so a report of "our game froze" gave you a stack trace
// and no way to tell which of N in-flight rooms produced it.

type Level = 'info' | 'warn' | 'error'

// Rooms come and go constantly; the lifecycle lines are what make an error
// line readable in context (who was seated, when it started, when it was
// evicted). Warnings and errors always print; the info narration is dropped
// under `bun test`, which stands up real servers across dozens of rooms and
// would otherwise bury the test output. FLIPTOONS_QUIET=1 does the same for a
// normal run.
const quiet = process.env.FLIPTOONS_QUIET === '1' || process.env.NODE_ENV === 'test'

// `null` for anything not scoped to a room (startup, eviction sweeps).
export function log(level: Level, roomCode: string | null, message: string, extra?: unknown): void {
  if (level === 'info' && quiet) return
  const where = roomCode ? `[${roomCode}]` : '[server]'
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${where} ${message}`
  // Keep the raw error/extra as a second argument rather than stringifying it
  // — the console renders an Error's stack, a template literal would not.
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra === undefined) write(line)
  else write(line, extra)
}
