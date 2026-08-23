import { expect, test } from '@playwright/test'
import {
  describeStall,
  hostRoom,
  joinRoom,
  openJoinPanel,
  openPlayer,
  playToEnd,
  settleToMarket,
  tryClick,
  visible,
  activePlayerIsMe,
} from './helpers'

// A real two-seat game, driven through the browser from both sides.
//
// This is the test the engine and server suites can't be: it proves the whole
// stack lines up — that two independent browsers get DIFFERENT seats, that the
// UI actually stops you acting on someone else's turn, and that a game can be
// played from the lobby to a winner without either player getting stuck.
//
// The play loop itself lives in ./helpers.ts, shared with the long-form
// debugging harness in longform.e2e.ts.

test.describe('a two-player game, played from both sides', () => {
  test('two browsers get different seats and see each other in the lobby', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host)

    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)

    // Both see both names.
    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('seat-list')).toContainText('Ana')
      await expect(p.page.getByTestId('seat-list')).toContainText('Bo')
    }

    // Nobody picked a table size when hosting, so the lobby is what says how
    // many are in and how many more will fit.
    await expect(host.page.getByTestId('seat-count')).toHaveText('Players (2 of 4)')

    // Only the host is offered the start control.
    await expect(host.page.getByTestId('start-game')).toBeVisible()
    await expect(host.page.getByTestId('start-game')).toContainText('2 players')
    await expect(guest.page.getByTestId('waiting-for-host')).toBeVisible()

    await host.page.context().close()
    await guest.page.context().close()
  })

  // The size of the table is now decided by who turns up, so a third player
  // joining the same room must be seated rather than refused.
  test('a third player can join a room that was never sized for them', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host)

    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    const third = await openPlayer(browser, 'Cy')
    await joinRoom(third, roomCode)

    for (const p of [host, guest, third]) {
      await expect(p.page.getByTestId('seat-list')).toContainText('Cy')
      await expect(p.page.getByTestId('seat-count')).toHaveText('Players (3 of 4)')
    }

    // All three are dealt in — the match was rebuilt at three seats on start,
    // and every seat kept the id its connection was pinned to.
    await host.page.getByTestId('start-game').click()
    for (const p of [host, guest, third]) {
      await expect(p.page.getByTestId('match')).toBeVisible()
      await expect(p.page.getByTestId('scoreboard')).toContainText('Cy')
      await expect(p.page.getByTestId('score-p2')).toBeVisible()
    }

    await host.page.context().close()
    await guest.page.context().close()
    await third.page.context().close()
  })

  test('a room code that does not exist says so instead of failing silently', async ({ browser }) => {
    const player = await openPlayer(browser, 'Ana')
    // The error banner used to render only once a match existed, so every
    // lobby-phase error — a dead code, "only the host can start", "need at
    // least 2 players" — arrived and was thrown away.
    await openJoinPanel(player)
    await player.page.getByTestId('room-code-input').fill('ZZZZZ')
    await player.page.getByTestId('join-game').click()

    await expect(player.page.getByTestId('match-error')).toBeVisible()
    await expect(player.page.getByTestId('match-error')).toContainText('ZZZZZ')
    // ...and we are still on the start screen, not a lobby that will never
    // advance.
    await expect(player.page.getByTestId('lobby')).toBeHidden()
    await expect(player.page.getByTestId('join-game')).toBeVisible()

    await player.page.context().close()
  })

  test('the room code works as a shareable ?room= link', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host)

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`/?room=${roomCode}`)
    // The link drops you on the join form with the code already filled in.
    await page.getByTestId('name-input').fill('Bo')
    await expect(page.getByTestId('room-code-input')).toHaveValue(roomCode)
    await page.getByTestId('join-game').click()
    await expect(page.getByTestId('lobby')).toBeVisible()

    await host.page.context().close()
    await context.close()
  })

  test('a player cannot act on the other player\'s turn', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()

    for (const p of [host, guest]) await expect(p.page.getByTestId('match')).toBeVisible()

    // Get into the Market phase. Nobody presses a Flip — the server runs it
    // as part of starting — so this only has to clear any Skunk prompt.
    await settleToMarket([host, guest])

    for (const p of [host, guest]) await expect(p.page.getByTestId('turn-indicator')).toBeVisible()

    // Exactly one of them is up, and the other is told who they're waiting on.
    const hostUp = await activePlayerIsMe(host.page)
    const guestUp = await activePlayerIsMe(guest.page)
    expect(hostUp).not.toBe(guestUp)

    const waiting = hostUp ? guest : host
    await expect(waiting.page.getByTestId('turn-indicator')).toContainText(hostUp ? 'Ana' : 'Bo')
    // The waiting seat's controls are dead — defense in depth over the
    // server's own rejection.
    //
    // Asserted on the BUTTON, not the <fieldset disabled> wrapping it:
    // Playwright's toBeDisabled() only recognises the native form controls
    // (button/input/select/...), so it reports a genuinely-disabled fieldset
    // as "enabled". The button is what the player actually clicks anyway.
    await expect(waiting.page.getByTestId('end-turn')).toBeDisabled()
    await expect(waiting.page.getByTestId('my-controls')).toHaveAttribute('disabled', '')
    // ...and the active seat's are live.
    const upNow = hostUp ? host : guest
    await expect(upNow.page.getByTestId('end-turn')).toBeEnabled()

    // What must NOT be disabled: leaving. The fieldset used to wrap the whole
    // RoundView, header included, so a seat waiting on someone who had dropped
    // mid-turn could not act AND could not get out.
    await expect(waiting.page.getByRole('button', { name: 'Leave game' })).toBeEnabled()
    await expect(waiting.page.getByRole('button', { name: /^Dismissed cards/ })).toBeEnabled()
    await expect(waiting.page.getByRole('button', { name: /^Remaining deck/ })).toBeEnabled()

    // And it works: clicking it actually leaves.
    await waiting.page.getByRole('button', { name: 'Leave game' }).click()
    await expect(waiting.page.getByTestId('match')).toBeHidden()

    await host.page.context().close()
    await guest.page.context().close()
  })

  test('a full game runs from the lobby to a winner, and both sides agree on it', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()

    for (const p of [host, guest]) await expect(p.page.getByTestId('match')).toBeVisible()

    await playToEnd([host, guest], { policy: 'pass' })

    // BOTH browsers must land on the same result — a game that ends only for
    // whoever clicked last is exactly the class of bug this test exists for.
    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('game-over')).toBeVisible({ timeout: 20_000 })
    }
    const hostResult = await host.page.getByTestId('result').innerText()
    const guestResult = await guest.page.getByTestId('result').innerText()

    // They're phrased from each seat's point of view ("You win!" vs "Ana
    // wins!"), so they agree on the OUTCOME rather than on the string.
    const hostWon = hostResult.includes('You win')
    const guestWon = guestResult.includes('You win')
    if (hostResult.includes('shared win')) {
      expect(guestResult).toContain('shared win')
    } else {
      expect(hostWon).not.toBe(guestWon)
    }

    // Each seat scored its own board — a shared fame pool would show the same
    // number twice for the same player on both screens AND identical boards.
    await expect(host.page.getByTestId('final-p0')).toBeVisible()
    await expect(host.page.getByTestId('final-p1')).toBeVisible()

    await host.page.context().close()
    await guest.page.context().close()
  })

  // The full-game test above proves the FLOW works, but its policy never
  // spends fame — so hire, dismiss, and every card effect they trigger go
  // completely unexercised, which is exactly the shape of gap that hid two
  // Pig bugs. This plays the same game for real, across several seeds,
  // because which cards come up (and therefore which effect prompts open) is
  // entirely a function of the seed.
  for (const seed of ['3', '11', '29']) {
    test(`a full game played for real — hiring, dismissing and effects — seed ${seed}`, async ({ browser }) => {
      // A bought game is several times longer than the pass-policy one — more
      // rounds, and an effect prompt to answer on many turns. Seed 11 runs to
      // about a minute, which is close enough to the 90s default to flake.
      test.setTimeout(180_000)
      const crashes: string[] = []
      const host = await openPlayer(browser, 'Ana')
      const guest = await openPlayer(browser, 'Bo')
      for (const p of [host, guest]) p.page.on('pageerror', (e) => crashes.push(e.message))
      const roomCode = await hostRoom(host, { seed })
      await joinRoom(guest, roomCode)
      await host.page.getByTestId('start-game').click()
      for (const p of [host, guest]) await expect(p.page.getByTestId('match')).toBeVisible()

      const tally = await playToEnd([host, guest], { policy: 'buy' })

      for (const p of [host, guest]) {
        await expect(p.page.getByTestId('game-over')).toBeVisible({ timeout: 20_000 })
      }

      // Without this the test silently degrades into the pass-policy one:
      // a run that never found an affordable card would still reach an end
      // screen and still go green, having proved nothing new.
      console.log(`seed ${seed}: ${tally.hires} hires, ${tally.dismisses} dismisses, ${tally.effectChoices} effect prompts answered`)
      expect(tally.hires).toBeGreaterThan(0)

      // Both seats must still agree on the outcome, same as the pass-policy
      // game — spending fame must not fork the two clients' view of who won.
      const hostResult = await host.page.getByTestId('result').innerText()
      const guestResult = await guest.page.getByTestId('result').innerText()
      if (hostResult.includes('shared win')) {
        expect(guestResult).toContain('shared win')
      } else {
        expect(hostResult.includes('You win')).not.toBe(guestResult.includes('You win'))
      }

      // No uncaught client exception anywhere in the run. Deliberately NOT an
      // assertion on the error banner: an illegal action is a normal race here
      // (a click can land the instant the turn changes hands) and the banner
      // persists until clicked, so that would flake. A genuine engine throw
      // shows up instead as the loop never reaching an end screen.
      expect(crashes).toEqual([])

      await host.page.context().close()
      await guest.page.context().close()
    })
  }

  test('each seat has its own board and its own fame', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()

    // The scoreboard lists both players separately for both viewers.
    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('score-p0')).toBeVisible()
      await expect(p.page.getByTestId('score-p1')).toBeVisible()
    }
    // And each viewer sees the OTHER player's board as an opponent board —
    // never their own.
    await expect(host.page.getByTestId('opponent-p1')).toBeVisible()
    await expect(host.page.getByTestId('opponent-p0')).toHaveCount(0)
    await expect(guest.page.getByTestId('opponent-p0')).toBeVisible()
    await expect(guest.page.getByTestId('opponent-p1')).toHaveCount(0)

    // Nobody was asked to press a Flip: the server ran it, and both boards
    // are on the table already.
    await expect(host.page.getByTestId('advance-flip')).toHaveCount(0)
    for (const p of [host, guest]) await expect(p.page.getByTestId('my-board')).toBeVisible()

    // Yours and theirs are drawn by the same BoardPane — one pane each, not a
    // framed board of your own next to a bare grid for everyone else.
    await expect(host.page.getByTestId('my-board').locator('.round-view__grid-pane')).toHaveCount(1)
    await expect(host.page.getByTestId('opponent-p1').locator('.round-view__grid-pane')).toHaveCount(1)
    // ...and an opponent's cards are inert: shown, not offered.
    await expect(host.page.getByTestId('opponent-p1').locator('button.card')).toHaveCount(0)

    await host.page.context().close()
    await guest.page.context().close()
  })

  // The endgame used to arrive with no warning: Cleanup latches the trigger
  // and hands straight to the Final Flip, which the server now resolves in the
  // same tick. A threshold of 1 makes round 1 the trigger round, so the notice
  // has to be up during that round's Market phase or never.
  test('the last round says so before the Final Flip decides it', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11', threshold: '1' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()
    await settleToMarket([host, guest])

    for (const p of [host, guest]) {
      await expect(p.page.getByTestId('endgame-notice')).toBeVisible()
      await expect(p.page.getByTestId('endgame-notice')).toContainText('last round')
    }

    await host.page.context().close()
    await guest.page.context().close()
  })

  test('a reload rejoins the same seat mid-game', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()
    await expect(guest.page.getByTestId('match')).toBeVisible()

    // Guest reloads — the seat is remembered, so they come straight back in
    // rather than landing on the start form.
    await guest.page.reload()
    await expect(guest.page.getByTestId('match')).toBeVisible({ timeout: 20_000 })
    await expect(guest.page.getByTestId('opponent-p0')).toBeVisible()

    await host.page.context().close()
    await guest.page.context().close()
  })
})
