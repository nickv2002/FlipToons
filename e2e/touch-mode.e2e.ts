import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Touch mode defaults ON (settings.ts) — this spec seeds it explicitly rather
// than relying on the default, so it stays correct if the default ever
// changes. Every other spec seeds it OFF via helpers.ts's disableTouchMode,
// to keep their direct hire/dismiss clicks working unchanged.
const SETTINGS_STORAGE_KEY = 'fliptoons.settings.v1'

async function enableTouchMode(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [SETTINGS_STORAGE_KEY, JSON.stringify({ touchMode: true, lastName: '' })] as [string, string],
  )
}

async function startSolo(page: Page): Promise<void> {
  await enableTouchMode(page)
  await page.goto('/')
  await page.getByTestId('mode-solo').click()
  await page.getByTestId('season-1').click()
  await page.getByRole('button', { name: 'Start Game' }).click()
  await expect(page.getByRole('button', { name: 'End Market phase' })).toBeVisible()
}

// Grid dismiss is used as the touch target rather than a market hire: Slot.tsx
// deliberately never gates dismiss on affordability (the badge just colors
// red — see its NOTE), so a dismissable grid card is available every round
// regardless of how much fame the opening flip generated. A market hire is
// not guaranteed affordable at round start.
function firstDismissable(page: Page) {
  return page.locator('.round-view__grid-pane .card--clickable:not([disabled])').first()
}

test.describe('touch mode', () => {
  test('single tap opens the zoom sheet with card text and a contextual action', async ({ page }) => {
    await startSolo(page)
    await expect(page.getByTestId('touch-mode-toggle').locator('input')).not.toBeChecked()

    const card = firstDismissable(page)
    await expect(card).toBeVisible()
    const cardName = (await card.locator('.card__name').innerText()).trim()

    await card.click()

    const sheet = page.locator('.card-zoom-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(cardName)

    const action = page.getByTestId('card-zoom-action')
    await expect(action).toBeVisible()
    await expect(action).toContainText('Dismiss')

    await action.click()
    await expect(sheet).toHaveCount(0)
  })

  test('double tap fires the action directly, bypassing the sheet', async ({ page }) => {
    await startSolo(page)

    const card = firstDismissable(page)
    await expect(card).toBeVisible()
    const dismissedBefore = await page.getByRole('button', { name: /^Dismissed / }).innerText()

    await card.dblclick()

    await expect(page.locator('.card-zoom-sheet')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Dismissed / })).not.toHaveText(dismissedBefore)
  })

  test('turning Single-Tap Mode on from the header restores direct clicks', async ({ page }) => {
    await startSolo(page)

    await page.getByTestId('touch-mode-toggle').locator('input').check()

    const card = firstDismissable(page)
    await expect(card).toBeVisible()
    await card.click()

    await expect(page.locator('.card-zoom-sheet')).toHaveCount(0)
  })

  test('the mode explanation is tap-to-toggle, not hover-only', async ({ page }) => {
    await startSolo(page)

    const hint = page.getByTestId('touch-mode-hint')
    await expect(hint).toHaveCount(0)

    await page.getByTestId('touch-mode-hint-button').click()
    await expect(hint).toBeVisible()

    await page.getByTestId('touch-mode-hint-button').click()
    await expect(hint).toHaveCount(0)
  })

  test('rules text stays out of the grid/market in touch mode, but shows in the zoom sheet', async ({ page }) => {
    await startSolo(page)

    // Suppressed in place, regardless of which cards this round dealt.
    await expect(page.locator('.round-view__grid-pane .card__text')).toHaveCount(0)
    await expect(page.locator('.market .card__text')).toHaveCount(0)

    const card = firstDismissable(page)
    await card.click()
    await expect(page.locator('.card-zoom-sheet')).toBeVisible()
  })

  test('an unaffordable market card is still tappable to view details, with no action offered', async ({ page }) => {
    await startSolo(page)

    const unaffordable = page.locator('.market .card__price--unaffordable').locator('xpath=ancestor::button[1]').first()
    await expect(unaffordable).toBeVisible()
    await unaffordable.click()

    const sheet = page.locator('.card-zoom-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('card-zoom-action')).toHaveCount(0)
  })
})
