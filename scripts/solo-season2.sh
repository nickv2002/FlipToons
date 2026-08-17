#!/usr/bin/env bash
# Interactive TUI solo game, Season 2's variant (tui.ts --season=2). Prints
# an UNCONFIRMED banner before play starts — see setup.ts's
# buildSeason2SoloStartingDeck comment, this is a pattern-matched inference,
# not a confirmed rule. Remaining args forwarded verbatim (e.g. --seed=N,
# --difficulty=easy|normal|hard).
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun run packages/engine/tui.ts --season=2 "$@"
