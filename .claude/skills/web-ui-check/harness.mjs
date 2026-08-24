// Reusable Playwright harness for verifying apps/web changes in a real
// browser — see SKILL.md. Bootstraps Playwright into a scratch cache dir
// on first use (repo stays dependency-free — see the skill's design
// discussion) rather than adding it to package.json.
//
// Usage from a short per-check script:
//
//   import { withGame } from '<path-to-this-file>/harness.mjs'
//
//   await withGame({ rounds: 3 }, async ({ page, consoleErrors }) => {
//     // exercise whatever the change actually is
//     await page.getByRole('button', { name: 'Copy full detail log' }).click()
//     await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
//     console.log('console errors seen:', consoleErrors)
//   })
//
// withGame boots the dev server, starts a solo game, advances the
// requested number of rounds, calls your callback with a ready `page`, then
// tears everything down (browser + dev server) in a `finally` — even if
// your callback throws.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SKILL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SKILL_DIR, '..', '..', '..')
const PLAYWRIGHT_CACHE_DIR = join(homedir(), '.cache', 'fliptoons-web-ui-check')

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', ...opts })
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
    proc.on('error', reject)
  })
}

// Installs playwright (+ downloads its browser binaries) into a cache dir
// outside the repo the first time this runs; later runs just import it —
// no network, no package.json/lockfile changes in the repo itself.
async function ensurePlaywright() {
  const pkgPath = join(PLAYWRIGHT_CACHE_DIR, 'node_modules', 'playwright', 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(`[web-ui-check] bootstrapping playwright into ${PLAYWRIGHT_CACHE_DIR} (first run only)...`)
    await run('mkdir', ['-p', PLAYWRIGHT_CACHE_DIR])
    await run('bun', ['add', 'playwright'], { cwd: PLAYWRIGHT_CACHE_DIR })
    await run('bunx', ['playwright', 'install', 'chromium'], { cwd: PLAYWRIGHT_CACHE_DIR })
  }
  const entry = join(PLAYWRIGHT_CACHE_DIR, 'node_modules', 'playwright', 'index.mjs')
  return import(pathToFileURL(entry).href)
}

// Starts `bun run dev` for apps/web and resolves once Vite prints its Local
// URL — Vite falls back to the next free port if 5173 is taken, so this
// parses the real port rather than assuming one.
function startDevServer() {
  return new Promise((resolve, reject) => {
    // detached so it gets its own process group — `bun run dev` spawns vite
    // as a CHILD process, and killing just the `bun` wrapper leaves vite
    // running (confirmed directly: a plain proc.kill() orphaned vite on its
    // port). Killing the negative PID targets the whole group instead.
    const proc = spawn('bun', ['run', 'dev'], { cwd: join(REPO_ROOT, 'apps', 'web'), detached: true })
    let output = ''
    const timeout = setTimeout(() => reject(new Error('web-ui-check: dev server did not print a Local URL within 20s')), 20_000)
    const onData = (chunk) => {
      output += chunk.toString()
      const match = output.match(/Local:\s+(http:\/\/localhost:\d+\/)/)
      if (match) {
        clearTimeout(timeout)
        proc.stdout.off('data', onData)
        resolve({ proc, url: match[1] })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk))
    proc.on('error', reject)
  })
}

function stopDevServer(proc) {
  return new Promise((resolve) => {
    proc.once('exit', resolve)
    try {
      process.kill(-proc.pid, 'SIGTERM') // negative PID = whole process group (see startDevServer's detached: true)
    } catch {
      // group already gone
    }
    // Vite's dev server sometimes ignores a first SIGTERM if a request is
    // in flight — escalate rather than hang the script waiting on 'exit'.
    setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }, 3000)
  })
}

// Starts a solo game via the launch screen's two steps: the Solo mode card
// opens a config panel whose season and difficulty are big option cards, with
// a de-emphasized seed field at the bottom — see components/LaunchScreen.tsx
// and components/NewGameForm.tsx if these ever need updating.
async function startSoloGame(page, { seed = Date.now() >>> 0, difficulty = 'normal', season = 1 } = {}) {
  await page.getByTestId('mode-solo').click()
  await page.getByTestId(`season-${season}`).click()
  await page.getByTestId(`difficulty-${difficulty}`).click()
  await page.getByLabel('Seed').fill(String(seed))
  await page.getByTestId('start-solo').click()
}

// Advances N rounds the fast way: click "End Market phase" to skip every
// hire/dismiss decision (fine for UI verification, not for exercising
// market-action UI itself — write custom clicks in your callback for that).
// The button may be briefly absent right after a click while the next
// round's auto-advance cascade runs, so this polls rather than assuming
// it's always there.
async function advanceRounds(page, n) {
  for (let i = 0; i < n; i++) {
    const endMarketButton = page.getByRole('button', { name: /End Market phase/i })
    await endMarketButton.waitFor({ state: 'visible', timeout: 10_000 })
    await endMarketButton.click()
    await page.waitForTimeout(50) // let the cascade (checkFame -> ... -> next round) settle
  }
}

// Top-level convenience: bootstrap -> dev server -> browser -> solo game ->
// advance `rounds` -> your callback -> teardown (always, even on throw).
// Passes { page, context, consoleErrors, pageErrors } to the callback.
export async function withGame({ seed, difficulty, season, rounds = 0 } = {}, callback) {
  const { chromium } = await ensurePlaywright()
  const { proc: devServerProc, url } = await startDevServer()
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const page = await context.newPage()
    const consoleErrors = []
    const pageErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await page.goto(url)
    await startSoloGame(page, { seed, difficulty, season })
    if (rounds > 0) await advanceRounds(page, rounds)

    return await callback({ page, context, consoleErrors, pageErrors })
  } finally {
    await browser.close()
    await stopDevServer(devServerProc)
  }
}

export { ensurePlaywright, startDevServer, stopDevServer, startSoloGame, advanceRounds }
