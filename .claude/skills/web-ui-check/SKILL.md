---
name: web-ui-check
description: Drive the FlipToons web client (make web) with headless Playwright to verify a UI change actually works in the browser — start a solo game, advance through rounds, exercise the changed UI, capture console errors. Use whenever a web UI change needs live verification instead of just typecheck/tests, per this project's CLAUDE.md rule that frontend changes must be exercised in a browser before being reported done.
---

# Web UI check (Playwright)

This project's CLAUDE.md requires frontend changes to be exercised in a real browser, not just typechecked. This skill is the repeatable script for that: boot the Vite dev server, drive it headlessly with Playwright, verify the golden path, and tear down cleanly.

Playwright itself isn't a project dependency — run it via `bunx playwright` (downloads on first use; browsers cache under `~/Library/Caches/ms-playwright` so repeat runs are fast). No MCP Playwright server is configured for this project — write a throwaway Node/bun script instead.

## Steps

1. **Start the dev server in the background**, don't block on it:
   ```bash
   cd apps/web && bun run dev > /tmp/fliptoons-web.log 2>&1 &
   ```
   Poll `/tmp/fliptoons-web.log` for the printed `Local:` URL (Vite defaults to 5173 but falls back to the next free port if something else is already listening — don't hardcode it).

2. **Write a throwaway Playwright script** (e.g. to the scratchpad dir, not the repo) that:
   - Launches `chromium.launch({ headless: true })`.
   - Registers `page.on('console', ...)` and `page.on('pageerror', ...)` handlers up front — collect everything, don't just eyeball stdout.
   - Navigates to the dev server URL.
   - Starts a solo game: `page.getByLabel('Seed').fill(...)`, pick difficulty/season via `page.getByLabel(...).selectOption(...)` if the check needs a specific one, then `page.getByRole('button', { name: /Start game/i }).click()`.
   - Advances rounds by clicking `page.getByRole('button', { name: /End Market phase/i })` repeatedly (skips every hire/dismiss decision, which is fine for UI verification — the auto-end effect already fires once nothing's affordable, so this button may not always be present; check before clicking) until enough rounds have accumulated for the log/UI state under test.
   - Exercises whatever the actual change is (click the new button, fill the new field, whatever).
   - Asserts on the result — for clipboard checks, grant permissions first: `context.grantPermissions(['clipboard-read', 'clipboard-write'])`, then read back with `page.evaluate(() => navigator.clipboard.readText())` rather than trusting on-screen state alone.
   - Take a screenshot on any assertion failure (`page.screenshot({ path: ... })`) so a failure is diagnosable without re-running.

3. **Run it**: `bunx playwright <path-to-script>.mjs` (or `node` if bun's Playwright interop misbehaves — bun works fine as of this writing).

4. **Report**: what was verified, any console/page errors seen (these are real signal — don't discard them even if the visual check passed), and any layout issues from screenshots.

5. **Clean up**: `make stop` (kills anything this repo's Makefile started) — but check `make stop`'s output actually matched something; it only tracks processes it started itself, so a dev server left over from a previous manual `make web` (not started by this skill run) won't be touched by it. Kill the background job directly if `make stop` reports nothing:
   ```bash
   kill %1  # or: lsof -ti:PORT | xargs kill
   ```

## Gotchas learned from prior runs

- A 0ms readback right after `.click()` on something that updates state asynchronously (e.g. a "Copied!" label flip after `navigator.clipboard.writeText` resolves) can race React's state update and read the stale value — add a short wait (`page.waitForTimeout(100)`) or `expect(...).toHaveText(...)` (auto-retries) rather than an instant synchronous check.
- Season 2 solo is an unconfirmed rules inference (see `setup.ts`) and the AI's internal search can hit a genuine pre-existing stall on some seeds (`flip.ts`'s `MAX_FLIP_ITERATIONS` guard) — if a scripted run throws there, don't assume your change caused it; reproduce on `main` first (`git stash`) before treating it as a regression.
- `make web` alone (no server) is enough for anything in local solo mode — only reach for `make play` if the check specifically needs room-code/multiplayer behavior.
