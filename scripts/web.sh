#!/usr/bin/env bash
# GUI, local-only: the Vite dev server for apps/web, playing with the game
# state kept entirely in the browser (localStorage save/resume, no server).
# For a room-code, resumable-from-another-device session, use scripts/play.sh
# instead, which also starts apps/worker.
set -euo pipefail
cd "$(dirname "$0")/../apps/web"
exec bun run dev
