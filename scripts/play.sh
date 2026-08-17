#!/usr/bin/env bash
# GUI, hosted: starts apps/server (ws://localhost:8787) and apps/web
# (http://localhost:5173) together, so "Host online" in the New Game form
# has a server to talk to and a room-code game can be resumed from another
# tab/device. Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_PORT=8787

cleanup() {
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "$ROOT/apps/server" && bun run index.ts) &
SERVER_PID=$!

echo "Waiting for the server on port $SERVER_PORT..."
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$SERVER_PORT" && break
  sleep 0.5
done

(cd "$ROOT/apps/web" && bun run dev) &
WEB_PID=$!

echo ""
echo "Server:  ws://localhost:$SERVER_PORT"
echo "Web app: see the Vite output above for the local URL (usually http://localhost:5173)"
echo "Ctrl-C to stop both."
wait
