#!/usr/bin/env bash
# The Cloudflare Worker + Durable Object multiplayer server (apps/worker):
# seated 2-4 player matches, one Durable Object per room, room-code
# addressable. Not useful on its own without a client pointed at it —
# apps/web's "Host a table" / "Join a Game" cards on the launch screen are the
# client side. Use scripts/play.sh to start both together.
set -euo pipefail
cd "$(dirname "$0")/../apps/worker"
exec bunx wrangler dev
