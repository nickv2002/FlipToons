#!/usr/bin/env bash
# Full AI autoplay of a solo game from the CLI (tui.ts --ai), no human input.
# ai.ts's Monte-Carlo evaluator makes every Market decision; --seed also
# drives the AI's own decision rng, so the same seed reproduces identically.
# Exit code: 0 on a win, 1 on a loss (matches the interactive/scripted modes).
# Remaining args forwarded verbatim (e.g. --seed=N, --difficulty=..., --season=...).
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun run packages/engine/tui.ts --ai "$@"
