import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { disableTouchMode } from './helpers'

// Solo regression, through the browser.
//
// This exists because the multiplayer work edited NewGameForm — deleting the
// join step, the host-mode cards, and the whole hostOnline branch — and every
// other e2e spec clicks straight past that screen into multiplayer. tsc and
// `vite build` catch broken types and imports; they do not catch a config
// panel that renders fine but whose Start button no longer starts anything.
//
// Solo is also the well-playtested mode, so it's the one where a silent
// regression would be most expensive.

async function startSolo(page: Page, season: 1 | 2): Promise<void> {
  await disableTouchMode(page)
  await page.goto('/')
  // Solo card -> config panel: season and difficulty are cards on the panel
  // now, not separate buttons on the picker.
  await page.getByTestId('mode-solo').click()
  await page.getByTestId(`season-${season}`).click()
  await page.getByRole('button', { name: 'Start Game' }).click()
}

// Solo lands directly in the Market phase — actions.ts cascades
// flip -> checkFame -> postFameHooks in one step, by design.
async function playOneRound(page: Page): Promise<void> {
  const endMarket = page.getByRole('button', { name: 'End Market phase' })
  await expect(endMarket).toBeVisible()
  await endMarket.click()
}

test.describe('solo still works through the web UI', () => {
  for (const season of [1, 2] as const) {
    test(`a Season ${season} solo game starts and plays two rounds`, async ({ page }) => {
      await startSolo(page, season)

      // The board is dealt and the Market phase is live.
      await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
      await expect(page.getByText('Actions remaining')).toBeVisible()

      await playOneRound(page)
      // Round 2 deals automatically — solo never waits on anyone.
      await playOneRound(page)

      // Still in a game, not crashed out to the menu.
      await expect(page.getByRole('button', { name: 'Abandon game' })).toBeVisible()
    })
  }

  test('solo says "Abandon game", multiplayer does not borrow that wording', async ({ page }) => {
    await startSolo(page, 1)
    await expect(page.getByRole('button', { name: 'Abandon game' })).toBeVisible()
    await expect(page.getByTestId('end-turn')).toHaveText('End Market phase')
  })

  test('a solo game resumes after a reload', async ({ page }) => {
    // useGame's localStorage save/resume — untouched by this work, but it
    // shares the App-level mode routing that multiplayer's stored seat now
    // also feeds into, so it's worth asserting the two don't collide.
    await startSolo(page, 1)
    await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
  })

  test('the menu offers multiplayer without a stored seat hijacking solo', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('mode-host')).toBeVisible()
    await expect(page.getByTestId('mode-join')).toBeVisible()
    // A fresh browser has no seat remembered, so it must open on the picker
    // with solo offered, not inside a multiplayer panel.
    await expect(page.getByTestId('mode-solo')).toBeVisible()
  })
})
