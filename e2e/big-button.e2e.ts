import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { disableTouchMode, hostRoom, joinRoom, openPlayer } from './helpers'

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
})

test.describe('Big Button — RESET: GRID (two seats)', () => {
  test('every seat is asked in turn, and the table moves on once they have answered', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { bigButton: 'grid', seed: '7' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)

    // Joiners never saw the host's panel, so the lobby has to say which reset
    // effect they are about to play with.
    await expect(guest.page.getByTestId('lobby-setup')).toContainText('reset grid')

    await host.page.getByTestId('start-game').click()

    // RESET: GRID is "after the Check Fame phase" — which is reached on the
    // very first round, before anyone has taken a Market turn.
    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('big-button-prompt')).toBeVisible()
      await expect(p.page.getByTestId('phase')).toHaveText('Big Button')
    }

    // Turn-gated, and its own clockwise walk — separate from the Market
    // phase's turn order. Exactly one seat is offered the buttons at a time.
    await answerDecider([host.page, guest.page], 'big-button-keep')
    const user = await answerDecider([host.page, guest.page], 'big-button-use')

    // Both seats land in the Market phase together once the walk is done.
    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('turn-indicator')).toBeVisible()
      await expect(p.page.getByTestId('big-button-prompt')).toHaveCount(0)
    }

    // The re-flip actually happened: the seat that pressed the button
    // collected its grid, shuffled it back into its deck and dealt a new one.
    // The engine suite covers resolveGridReset; this is the round trip.
    expect(await ownGrid(user.page)).not.toBe(user.gridBefore)

    // The seat that pressed it has spent it; the seat that kept it has not.
    // Both are public, and both are drawn on their own board's heading.
    const chips = host.page.getByTestId('big-button-chip')
    await expect(chips).toHaveCount(2)
    await expect(chips.filter({ hasText: 'used' })).toHaveCount(1)
    await expect(chips.filter({ hasText: 'ready' })).toHaveCount(1)

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

// Whichever page is currently being asked presses `testId`. The walk starts at
// the first player and skips spent buttons, so which browser is up is a
// property of the deal, not something a spec should assume.
//
// Gated on the turn indicator rather than on the buttons being present: both
// seats render the prompt, only the decider gets the buttons, and a seat that
// has just answered still has them in the DOM for the instant before the next
// state message lands. Clicking on "is it visible" alone raced that window.
type Decision = { page: Page; gridBefore: string }

async function answerDecider(pages: Page[], testId: string): Promise<Decision> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const page of pages) {
      const text = await page.getByTestId('turn-indicator').innerText().catch(() => '')
      if (!text.includes('Your decision')) continue
      const gridBefore = await ownGrid(page)
      await page.getByTestId(testId).click()
      // The answer has landed once this seat is no longer being asked. Gated
      // on the buttons rather than on the turn indicator: the LAST seat to
      // answer moves straight into the Market phase, where the same indicator
      // reads "Your turn" — which would pass a "no longer deciding" check for
      // entirely the wrong reason.
      await expect(page.getByTestId(testId)).toHaveCount(0)
      return { page, gridBefore }
    }
    await pages[0].waitForTimeout(100)
  }
  throw new Error(`answerDecider: no seat was offered the ${testId} decision`)
}

// The card names on this seat's own board, in order.
async function ownGrid(page: Page): Promise<string> {
  return (await page.getByTestId('my-board').locator('.card__name').allInnerTexts()).join('|')
}
