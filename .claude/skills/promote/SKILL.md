---
name: promote
description: Merge the beta branch (beta.fliptoons.win) into main and deploy main to production (fliptoons.win). Use when the user says "promote beta", "promote to prod", or similar.
---

# promote

`beta` is the default working branch, deployed to the isolated `fliptoons-beta` Worker at beta.fliptoons.win. `main` is the production branch, deployed to `fliptoons` at fliptoons.win. This skill is the only sanctioned way `main` moves forward.

1. `git fetch origin` — then confirm the working tree is clean (`git status --porcelain`) and local `beta` matches `origin/beta` (`git rev-parse beta origin/beta`). If either check fails, stop and tell the user what's out of sync rather than guessing.
2. `git checkout main && git pull origin main`.
3. Build a summary of what's being promoted from `git log main..beta --oneline`, then merge with a generated message: `git merge --no-ff beta -m "Promote beta to main: <one-line summary of the commits above>"`. If the merge conflicts, stop and surface the conflict — do not resolve it automatically. Promotion is meant to be a deliberate, reviewable gate.
4. `git push origin main`.
5. `make deploy` — now running from `main`, `scripts/deploy.sh` deploys to production and polls fliptoons.win until it verifies the new build's asset hash is live.
6. `git checkout beta` — return to the default working branch.
7. Report the merge commit hash and the deploy script's final `verified: live site matches (...)` line. On any failure, stop at that step and show the relevant output — don't continue past a failed merge, push, or deploy.
