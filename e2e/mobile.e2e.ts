import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { disableTouchMode, hostRoom, joinRoom, openPlayer } from './helpers'

// Phone widths. Most players are on a phone, so this is the layout that
// matters most — and it is the one the other specs never look at, because
// they all run at Playwright's desktop default.
//
// The assertion that earns its keep is the horizontal-overflow one. A page
// that scrolls sideways on a phone is broken in a way no functional test
// notices, and three separate rules produced exactly that here: `.app__game`'s
// `1fr` track (which is `minmax(auto, 1fr)`, so it grows to the widest child's
// min-content and drags every sibling with it), the opponents grid's bare
// `minmax(320px, 1fr)` track, and an un-wrappable run of buttons in the top
// bar. All three passed every other check in the suite.

const PHONE = { width: 390, height: 844 }
const SMALL_PHONE = { width: 320, height: 720 }

// scrollWidth beyond clientWidth IS a sideways scrollbar. Zero, not "small".
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('phone layout', () => {
  test.use({ viewport: PHONE })

  test('a solo game fits the width, and the header stays put while you scroll', async ({ page }) => {
    await disableTouchMode(page)
    await page.goto('/')
    await page.getByTestId('mode-solo').click()
    await page.getByTestId('big-button-market').click()
    await page.getByRole('button', { name: 'Start Game' }).click()
    await expect(page.getByTestId('end-turn')).toBeVisible()

    expect(await horizontalOverflow(page)).toBe(0)

    // The play screen runs well past one screen on a phone, so the top bar is
    // sticky: "what am I being asked to do" and the way out both have to
    // survive a swipe.
    await page.evaluate(() => window.scrollTo(0, 800))
    await expect(page.getByTestId('round')).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Abandon game' })).toBeInViewport()
  })
})

test.describe('small phone layout', () => {
  test('a full table fits 320px with no sideways scroll', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    await host.page.setViewportSize(SMALL_PHONE)
    const roomCode = await hostRoom(host, { seed: '7' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    const third = await openPlayer(browser, 'Cy')
    await joinRoom(third, roomCode)
    await host.page.getByTestId('start-game').click()
    await expect(host.page.getByTestId('turn-indicator')).toBeVisible()

    // Two opponent boards below your own — the tallest, widest thing the app
    // ever draws.
    await expect(host.page.getByTestId('opponent-p1')).toBeVisible()
    expect(await horizontalOverflow(host.page)).toBe(0)

    await host.page.context().close()
    await guest.page.context().close()
    await third.page.context().close()
  })
})
