#!/usr/bin/env bash
# Full AI autoplay of a solo game from the CLI (tui.ts --ai), no human input.
# ai.ts's Monte-Carlo evaluator makes every Market decision; --seed also
# drives the AI's own decision rng, so the same seed reproduces identically.
# Exit code: 0 on a win, 1 on a loss, 2 if ai.ts's own round/wall-clock cap
# stopped the game before a win/loss, 124 if THIS wrapper's OS-level timeout
# had to kill it (see below).
# Remaining args forwarded verbatim (e.g. --seed=N, --difficulty=..., --season=...).
#
# ai.ts's playAutomatically() has its own in-process round cap and wall-clock
# cap (packages/engine/ai.ts) — those are the normal way a run ends without a
# win/loss. This wrapper's timeout is a second, OS-level backstop: it fires
# even if a bug somewhere stalls the process before it ever gets back to
# ai.ts's own deadline check (e.g. stuck inside a single synchronous call),
# which is how three `tui.ts --ai` runs were once left running for 10+ hours
# at 100% CPU with nothing to kill them. `make stop` / scripts/stop.sh kills
# any that still get through.
set -euo pipefail
cd "$(dirname "$0")/.."

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

if [[ -n "$TIMEOUT_BIN" ]]; then
  exec "$TIMEOUT_BIN" --signal=KILL 10m bun run packages/engine/tui.ts --ai "$@"
else
  echo "warning: no 'timeout'/'gtimeout' on PATH (brew install coreutils) — running without the OS-level time backstop, relying only on ai.ts's own in-process cap." >&2
  exec bun run packages/engine/tui.ts --ai "$@"
fi
