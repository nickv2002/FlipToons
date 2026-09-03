import { expect, test } from '@playwright/test'
import { openPlayer, playToEnd, settleToMarket, SHORT_FAME_THRESHOLD } from './helpers'

// Single-browser: these games have exactly one human seat, so there is no
// second page to drive — a bot's moves come from the client-side worker
// (useBotSeats), relayed to the server as ordinary `action` messages tagged
// `asSeat`. Proves the whole bot path: hosting a table with bot seats added
// from the host panel, the ordinary lobby (no more auto-start — the host
// presses Start themselves, same as any multiplayer room), the bot(s)
// actually taking their turns unattended, and the match reaching a real
// winner.
test.describe('bots', () => {
  test('a human plays a full game against one bot without a second browser', async ({ browser }) => {
    const human = await openPlayer(browser, 'Ana')

    await human.page.getByTestId('mode-host').click()
    await human.page.getByTestId('name-input').fill(human.name)
    await human.page.getByTestId('add-bot').click()
    await human.page.getByTestId('bot-0-difficulty-easy').click()
    await human.page.getByTestId('fame-threshold').fill(SHORT_FAME_THRESHOLD)
    await human.page.getByTestId('host-game').click()

    await expect(human.page.getByTestId('lobby')).toBeVisible()
    await expect(human.page.getByTestId('bot-badge')).toBeVisible()
    await human.page.getByTestId('start-game').click()

    await expect(human.page.getByTestId('opponent-boards')).toBeVisible({ timeout: 20_000 })

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

  test('two bots at different difficulties get distinct names and both take turns', async ({ browser }) => {
    const human = await openPlayer(browser, 'Ana')

    await human.page.getByTestId('mode-host').click()
    await human.page.getByTestId('name-input').fill(human.name)
    await human.page.getByTestId('add-bot').click()
    await human.page.getByTestId('bot-0-difficulty-easy').click()
    await human.page.getByTestId('add-bot').click()
    await human.page.getByTestId('bot-1-difficulty-hard').click()
    await human.page.getByTestId('fame-threshold').fill(SHORT_FAME_THRESHOLD)
    await human.page.getByTestId('host-game').click()

    await expect(human.page.getByTestId('lobby')).toBeVisible()
    await expect(human.page.getByTestId('bot-badge')).toHaveCount(2)
    await human.page.getByTestId('start-game').click()

    await expect(human.page.getByTestId('opponent-boards')).toBeVisible({ timeout: 20_000 })
    await expect(human.page.getByTestId('opponent-boards')).toContainText('Bot (Easy)')
    await expect(human.page.getByTestId('opponent-boards')).toContainText('Bot (Hard)')

    await settleToMarket([human])
    const tally = await playToEnd([human], { policy: 'buy', deadlineMs: 60_000 })

    await expect(human.page.getByTestId('game-over')).toBeVisible()
    expect(tally.errors.filter((e) => e.toLowerCase().includes('server error'))).toEqual([])

    await human.page.context().close()
  })
})
