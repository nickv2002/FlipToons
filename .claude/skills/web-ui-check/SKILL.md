---
name: web-ui-check
description: Drive the FlipToons web client (make web) with headless Playwright to verify a UI change actually works in the browser — start a solo game, advance through rounds, exercise the changed UI, capture console errors. Use whenever a web UI change needs live verification instead of just typecheck/tests, per this project's CLAUDE.md rule that frontend changes must be exercised in a browser before being reported done.
---

# Web UI check (Playwright)

This project's CLAUDE.md requires frontend changes to be exercised in a real browser, not just typechecked. This skill bundles a reusable harness (`harness.mjs`, next to this file) that handles everything generic — booting the dev server, launching a headless browser, starting a solo game, advancing rounds, capturing console errors, tearing down cleanly. Only the actual check (exercising whatever you just changed) needs to be written per use.

Playwright itself isn't a project dependency — the harness bootstraps it into `~/.cache/fliptoons-web-ui-check` on first use (`bun add playwright` + `playwright install chromium` there, outside the repo, so `package.json`/the lockfile never change). Repeat runs skip straight to importing it — no network, no reinstall.

## Usage

Write a short script (scratchpad dir, not the repo) that imports `withGame` from the harness and does only the check-specific part:

```js
import { withGame } from '/Users/nick/Documents/nick-scripts/boardgame-testing/.claude/skills/web-ui-check/harness.mjs'

await withGame({ seed: 1, difficulty: 'normal', season: 1, rounds: 2 }, async ({ page, consoleErrors, pageErrors }) => {
  // exercise whatever the change actually is
  const copyButton = page.getByRole('button', { name: /Copy full detail log/i })
  await copyButton.click()
  await page.getByRole('button', { name: /Copied!/i }).first().waitFor({ state: 'visible', timeout: 2000 })

  // clipboard reads are pre-granted permission by the harness
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  if (clipboardText.length === 0) throw new Error('clipboard was empty')
  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join('; ')}`)
  console.log('OK')
})
```

Then run it: `bun run <path-to-script>.mjs`. `withGame` boots the dev server, opens the New Game form, starts a solo game with the given seed/difficulty/season, clicks "End Market phase" `rounds` times to fast-forward past every hire/dismiss decision, hands you a ready `page`, and — in a `finally`, even if your callback throws — closes the browser and kills the dev server (confirmed: killing just the `bun run dev` wrapper leaves its `vite` child running on the port, so the harness spawns it `detached` and kills the whole process group by negative PID; don't reimplement teardown by hand, use the harness).

If the check needs to exercise Market-phase UI itself (a specific hire/dismiss button, not just post-round state), don't use `advanceRounds` for that round — click the actual buttons in your callback instead; `rounds` is only for skipping past *uninteresting* rounds to get to the state you actually want to check.

`harness.mjs` also exports the individual pieces (`ensurePlaywright`, `startDevServer`, `stopDevServer`, `startSoloGame`, `advanceRounds`) if a check needs more control than `withGame` gives — e.g. multiple separate pages/contexts, or starting a game without immediately advancing rounds.

## Gotchas learned from prior runs

- A 0ms readback right after `.click()` on something that updates state asynchronously (e.g. a "Copied!" label flip after `navigator.clipboard.writeText` resolves) can race React's state update and read the stale value — use `.waitFor(...)` or Playwright's auto-retrying `expect(...)` rather than an instant synchronous check.
- Season 2 solo is an unconfirmed rules inference (see `setup.ts`) and the AI's internal search can hit a genuine pre-existing stall on some seeds (`flip.ts`'s `MAX_FLIP_ITERATIONS` guard) — if a run throws there, don't assume your change caused it; reproduce on `main` first (`git stash`) before treating it as a regression.
- `make web` alone (no server) is enough for anything in local solo mode — only reach for multiplayer/room-code testing if the check specifically needs it (the harness doesn't cover that path yet).
