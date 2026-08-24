# FlipToons — startup targets for the various ways to play, plus the usual
# test/typecheck checks. Each target just execs a scripts/*.sh wrapper (see
# that directory for what each mode actually is); this file is the index.

.PHONY: help web server play stop test typecheck lint e2e e2e-long

.DEFAULT_GOAL := help

## Show this list of targets and what they do
help:
	@awk '/^## / { desc = substr($$0, 4); next } /^[a-zA-Z0-9_-]+:/ && desc { printf "  \033[36m%-15s\033[0m %s\n", substr($$1, 1, length($$1)-1), desc; desc = "" }' $(MAKEFILE_LIST)

## GUI: local-only web client (Vite dev server, no server process)
web:
	./scripts/web.sh

## GUI: standalone WS server only (pair with `make web`, then "Host a table")
server:
	./scripts/server.sh

## GUI: web client + server together, for room-code hosted/resumable games
play:
	./scripts/play.sh

## Stop anything this repo has running: web dev server and WS server
stop:
	./scripts/stop.sh

## bun test, from repo root
test:
	bun test

## bunx tsc --noEmit, from repo root
# All three projects. The root config covers packages/ only; apps/server and
# apps/web have their own, and for a long time nothing ran them — which is how
# a wrong field name in the server reached a commit.
typecheck:
	bunx tsc --noEmit -p .
	bunx tsc --noEmit -p apps/server/tsconfig.json
	bunx tsc --noEmit -p apps/web/tsconfig.json

## oxlint over the whole repo (config in .oxlintrc.json)
# DEFAULT RECOMMENDED RULES ONLY, deliberately. The baseline when this landed
# was 8 findings (5 unused imports, 3 statement-position ternaries) and is now
# 0, so a non-zero exit here means something new. Stylistic/opinionated rule
# sets are NOT enabled: this codebase is internally consistent, and switching
# them on would produce an unbounded diff rather than find bugs. Type-aware
# checking is `make typecheck`'s job — it covers all three tsconfigs.
lint:
	bunx --bun oxlint

## Browser end-to-end tests (Playwright starts both servers itself)
e2e:
	bunx playwright test

## Long-form 2-player game at the real fame threshold — a debugging harness, NOT part of `make e2e`
e2e-long:
	FLIPTOONS_LONGFORM=1 bunx playwright test e2e/longform.e2e.ts
