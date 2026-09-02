import { expect, test } from '@playwright/test'
import { openPlayer, playToEnd, settleToMarket, SHORT_FAME_THRESHOLD } from './helpers'

// Single-browser: vs AI has exactly one human seat, so there is no second
// page to drive — the bot's moves come from the client-side worker
// (useVsAiMatch), relayed to the server as ordinary `action` messages tagged
// `asSeat`. Proves the whole vsAi path: room creation with a permanent bot
// seat, the lobby auto-starting with nobody to wait for, the bot actually
// taking its turns unattended, and the match reaching a real winner.
test.describe('vs AI', () => {
  test('a human plays a full game against a bot without a second browser', async ({ browser }) => {
    const human = await openPlayer(browser, 'Ana')

    await human.page.getByTestId('mode-vs-ai').click()
    await human.page.getByTestId('name-input').fill(human.name)
    await human.page.getByTestId('difficulty-easy').click()
    await human.page.getByTestId('fame-threshold').fill(SHORT_FAME_THRESHOLD)
    await human.page.getByTestId('start-vs-ai').click()

    // No lobby screen to wait on — the bot seat is already filled, so the
    // host's own arrival auto-starts the match.
    await expect(human.page.getByTestId('opponent-boards')).toBeVisible({ timeout: 20_000 })
    await expect(human.page.getByTestId('ai-badge')).toBeVisible()

    await settleToMarket([human])
    const tally = await playToEnd([human], { policy: 'buy', deadlineMs: 60_000 })

    await expect(human.page.getByTestId('game-over')).toBeVisible()
    // A winner is always named, or the totals are read as a genuine shared
    // win (MatchView.tsx's finalWinners) — either way the screen names
    // someone, unlike a stall.
    await expect(human.page.locator('.match__end')).not.toBeEmpty()
    expect(tally.errors.filter((e) => e.toLowerCase().includes('server error'))).toEqual([])

    await human.page.context().close()
  })
})
