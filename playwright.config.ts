import { defineConfig, devices } from '@playwright/test'

// End-to-end browser tests. These exist for the one thing no engine or server
// test can cover: that two real browsers, each holding their own seat, can
// actually play a game against each other through the UI.
//
// Both servers are started by Playwright so the suite is self-contained —
// `bunx playwright test` needs no `make play` running first.
export default defineConfig({
  testDir: './e2e',
  // Serial. The two "players" in a test are two browser contexts driving ONE
  // shared server-side match, and the WS server holds rooms in process memory.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bun run apps/server/index.ts',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bunx vite --port 5173 --strictPort',
      cwd: 'apps/web',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
