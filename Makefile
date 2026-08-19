# FlipToons — startup targets for the various ways to play, plus the usual
# test/typecheck checks. Each target just execs a scripts/*.sh wrapper (see
# that directory for what each mode actually is); this file is the index.
#
# Pass extra CLI flags through ARGS, e.g.:
#   make solo ARGS="--seed=1 --difficulty=hard"
#   make solo-ai ARGS="--seed=1 --season=2"

.PHONY: help solo solo-season2 solo-ai web server play test typecheck

.DEFAULT_GOAL := help

## Show this list of targets and what they do
help:
	@awk '/^## / { desc = substr($$0, 4); next } /^[a-zA-Z0-9_-]+:/ && desc { printf "  \033[36m%-15s\033[0m %s\n", substr($$1, 1, length($$1)-1), desc; desc = "" }' $(MAKEFILE_LIST)

## TUI: interactive Season 1 solo game (default season/difficulty; override via ARGS)
solo:
	./scripts/solo.sh $(ARGS)

## TUI: interactive Season 2 solo game (unconfirmed variant, see the script's comment)
solo-season2:
	./scripts/solo-season2.sh $(ARGS)

## TUI: AI autoplay of a full solo game, no human input
solo-ai:
	./scripts/solo-ai.sh $(ARGS)

## GUI: local-only web client (Vite dev server, no server process)
web:
	./scripts/web.sh

## GUI: standalone WS server only (pair with `make web` and check "Host online")
server:
	./scripts/server.sh

## GUI: web client + server together, for room-code hosted/resumable games
play:
	./scripts/play.sh

## bun test, from repo root
test:
	bun test

## bunx tsc --noEmit, from repo root
typecheck:
	bunx tsc --noEmit -p .
