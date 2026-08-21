#!/usr/bin/env bash
# Stops everything this repo's scripts can start: the Vite web dev server
# (port 5173), the standalone WS server (port 8787), and any TUI solo/AI
# game process (packages/engine/tui.ts) — whether launched via solo.sh,
# solo-ai.sh, solo-season2.sh, or run directly.
set -euo pipefail

killed_any=0

for port in 5173 8787; do
  PIDS="$(lsof -ti "tcp:$port" || true)"
  if [[ -n "$PIDS" ]]; then
    echo "Stopping process on port $port (pid: $PIDS)..."
    kill $PIDS 2>/dev/null || true
    killed_any=1
  fi
done

# Matches on the distinctive relative path, not an absolute one — solo.sh/
# solo-ai.sh/solo-season2.sh cd into the repo root and exec bun with a
# RELATIVE path (`bun run packages/engine/tui.ts ...`), so anchoring on
# $ROOT would miss exactly the processes those wrappers start. Specific
# enough (this project's own engine path) to not match anything unrelated.
TUI_PIDS="$(pgrep -f "bun run .*packages/engine/tui\.ts" || true)"
if [[ -n "$TUI_PIDS" ]]; then
  echo "Stopping TUI solo/AI game process(es) (pid: $TUI_PIDS)..."
  kill -9 $TUI_PIDS 2>/dev/null || true
  killed_any=1
fi

if [[ "$killed_any" -eq 0 ]]; then
  echo "Nothing running."
fi
