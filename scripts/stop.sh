#!/usr/bin/env bash
# Stops everything this repo's scripts can start: the Vite web dev server
# (port 5173) and the standalone WS server (port 8787).
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

if [[ "$killed_any" -eq 0 ]]; then
  echo "Nothing running."
fi
