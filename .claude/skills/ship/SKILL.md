---
name: ship
description: Commit, push, and deploy FlipToons with minimal token output — checks exit status only, discards stdout/stderr from git/build/deploy noise. Use when the user says "ship this", "commit and deploy", or similar.
---

# ship

Token-slim commit → push → deploy for this repo. Run each step's real output to
`/dev/null` (keep stderr on failure) and report only pass/fail per step — never
paste git/bun/wrangler logs into the conversation on success.

1. `git add -A && git commit -m "<message>" >/dev/null` — write a real commit
   message per the repo's normal commit conventions (see CLAUDE.md / recent
   `git log`), not a placeholder. If there's nothing to commit, say so and skip
   to step 3 only if the user just wants a deploy of already-pushed code.
2. `git push >/dev/null 2>&1` — check `$?` only.
3. `make deploy >/tmp/ship-deploy.log 2>&1` — this runs `scripts/deploy.sh`
   (build apps/web, `wrangler deploy`, then verify the live site's asset hash
   matches). On success, extract and show just the final `verified: live site
   matches (...)` line from the log. On failure, `tail -n 30` the log — deploy
   failures need the real detail (wrong hash, DNS, wrangler error).

Report each step as one line: `commit ok`, `push ok`, `deploy ok — verified:
<hash>`. On any non-zero exit, stop and show the relevant tail of that step's
log, don't continue to the next step.
