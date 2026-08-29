import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { activePlayerIsMe, disableTouchMode, hostRoom, joinRoom, openPlayer } from './helpers'

// The Big Button mini-expansion, from the browser.
//
// The engine, the Durable Object and the wire protocol carried this for a
// while before anything could switch it on: the solo form never passed a
// fourth argument to buildNewGameState and the host panel had no field for
// CreateRoomRequest.bigButton, so the "Use Big Button" control and the
// gridReset prompt were live code no player could reach. These specs exist so
// that can't quietly become true again.

test.describe('Big Button — RESET: MARKET (solo)', () => {
  test('is off unless you pick it', async ({ page }) => {
    await startSolo(page, null)
    // Not merely disabled — absent. With SharedState.resetEffect null there is
    // no button, no chip, and no gridReset phase to reach.
    await expect(page.getByTestId('big-button-chip')).toHaveCount(0)
    await expect(page.getByTestId('use-big-button')).toHaveCount(0)
  })

  test('resetting the market flips the button face down and refills the row', async ({ page }) => {
    await startSolo(page, 'market')

    const chip = page.getByTestId('big-button-chip')
    await expect(chip).toContainText('ready')

    const before = await marketNames(page)
    await page.getByTestId('use-big-button').click()

    // One use per game: the control goes away and the chip says so.
    await expect(chip).toContainText('used')
    await expect(page.getByTestId('use-big-button')).toHaveCount(0)

    // The whole market went back into the toon deck and was refilled from the
    // reshuffle, so the row is a different row. (Not "every name differs" —
    // a reshuffle can legitimately deal the same card back into a slot.)
    const after = await marketNames(page)
    expect(after).toHaveLength(before.length)
    expect(after.join('|')).not.toBe(before.join('|'))
  })

  // RESET: MARKET dropped its "before any market actions" gate on purpose —
  // it is free-floating and never ends the turn (matchActions.ts's
  // afterMarketAction), so a player can hire first and still reset
  // defensively afterward.
  test('the turn stays open after hiring, and after resetting', async ({ page }) => {
    await startSolo(page, 'market')

    const affordable = await hireCheapestCard(page)
    expect(affordable).toBe(true)

    // Still the Market phase, and the button is still there to press.
    await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
    const chip = page.getByTestId('big-button-chip')
    await expect(chip).toContainText('ready')

    await page.getByTestId('use-big-button').click()
    await expect(chip).toContainText('used')
    // Pressing it did not end the turn or the phase either.
    await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
  })
})

test.describe('Big Button — RESET: GRID (two seats, in-round)', () => {
  test('pressing it on your own Market turn resets only your own grid and keeps your turn open', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { bigButton: 'grid', seed: '7' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)

    // Joiners never saw the host's panel, so the lobby has to say which reset
    // effect they are about to play with.
    await expect(guest.page.getByTestId('lobby-setup')).toContainText('reset grid')

    await host.page.getByTestId('start-game').click()

    // RESET: GRID no longer opens a pre-turn walk in a normal round — it is a
    // start-of-your-own-Market-turn action, so both seats land straight in
    // the Market phase after the opening Flip/Check Fame.
    await expect(host.page.getByTestId('turn-indicator')).toBeVisible()
    await expect(guest.page.getByTestId('turn-indicator')).toBeVisible()
    await expect(host.page.getByTestId('big-button-prompt')).toHaveCount(0)

    const active = (await activePlayerIsMe(host.page)) ? host : guest
    const idle = active === host ? guest : host

    await expect(active.page.getByTestId('use-big-button-grid')).toBeVisible()

    const gridBefore = await ownGrid(active.page)
    await active.page.getByTestId('use-big-button-grid').click()

    // Own grid changed...
    await expect(async () => {
      expect(await ownGrid(active.page)).not.toBe(gridBefore)
    }).toPass()

    // ...it is still this seat's turn — RESET: GRID costs no action and does
    // not end the turn...
    await expect(active.page.getByRole('button', { name: /End (Market phase|turn)/ })).toBeVisible()
    await expect(active.page.getByTestId('use-big-button-grid')).toHaveCount(0)

    // ...their chip flips ready -> used while the opponent's stays ready.
    const activeChip = active.page.getByTestId('big-button-chip').first()
    await expect(activeChip).toContainText('used')
    const idleChip = idle.page.getByTestId('big-button-chip').first()
    await expect(idleChip).toContainText('ready')

    await host.page.context().close()
    await guest.page.context().close()
  })
})

test.describe('the log', () => {
  test('opens on demand and closes again', async ({ page }) => {
    await startSolo(page, null)
    // It used to be a permanent sidebar taking a third of the page.
    await expect(page.getByTestId('log-drawer')).toHaveCount(0)

    await page.getByTestId('open-log').click()
    await expect(page.getByTestId('log-drawer')).toBeVisible()
    await expect(page.getByTestId('log-drawer')).toContainText('New game')

    await page.getByTestId('close-log').click()
    await expect(page.getByTestId('log-drawer')).toHaveCount(0)
  })
})

async function startSolo(page: Page, bigButton: 'market' | 'grid' | null): Promise<void> {
  await disableTouchMode(page)
  await page.goto('/')
  await page.getByTestId('mode-solo').click()
  if (bigButton) await page.getByTestId(`big-button-${bigButton}`).click()
  await page.getByRole('button', { name: 'Start Game' }).click()
  await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
}

async function marketNames(page: Page): Promise<string[]> {
  return page.locator('.market .card__name').allInnerTexts()
}

// The card names on this seat's own board, in order.
async function ownGrid(page: Page): Promise<string> {
  return (await page.getByTestId('my-board').locator('.card__name').allInnerTexts()).join('|')
}

// Hires the first affordable market card, for the "turn stays open" checks
// above — returns false if nothing in the row is affordable (which would make
// the spec's premise false, not its assertions).
async function hireCheapestCard(page: Page): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const slot = page.getByTestId(`market-slot-${i}`)
    if ((await slot.count()) === 0) continue
    if (await slot.isEnabled().catch(() => false)) {
      await slot.click()
      return true
    }
  }
  return false
}
