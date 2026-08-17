#!/usr/bin/env bash
# Interactive/scripted TUI solo game (packages/engine/tui.ts's default mode).
# Any args are forwarded verbatim: --seed=N --difficulty=easy|normal|hard
# --season=1|2 --script=... --script-file=... --deck=...
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun run packages/engine/tui.ts "$@"
