// Worker-side logging. Deliberately tiny and console-based, same as the Bun
// server this replaced: this repo has zero runtime dependencies and a
// logging library would be its first. `wrangler tail` / the dashboard capture
// console output directly, so there is no local-file concern here.
//
// The one thing every line must carry is the ROOM CODE, so a report of "our
// game froze" can be traced to the one Durable Object instance it happened
// in among however many rooms are live.

type Level = 'info' | 'warn' | 'error'

// `null` for anything not scoped to a room (a routing failure before a room
// was resolved).
export function log(level: Level, roomCode: string | null, message: string, extra?: unknown): void {
  const where = roomCode ? `[${roomCode}]` : '[worker]'
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${where} ${message}`
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (extra === undefined) write(line)
  else write(line, extra)
}
