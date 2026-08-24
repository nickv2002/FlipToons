#!/usr/bin/env bash
# The standalone WS server (apps/server): seated 2-4 player matches held in
# memory, room-code addressable. Not useful on its own without a client
# pointed at it — apps/web's "Host a table" / "Join a Game" cards on the
# launch screen are the client side. Use scripts/play.sh to start both
# together.
set -euo pipefail
cd "$(dirname "$0")/../apps/server"
exec bun run index.ts
