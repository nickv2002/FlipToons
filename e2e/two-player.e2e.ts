import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

// A real two-seat game, driven through the browser from both sides.
//
// This is the test the engine and server suites can't be: it proves the whole
// stack lines up — that two independent browsers get DIFFERENT seats, that the
// UI actually stops you acting on someone else's turn, and that a game can be
// played from the lobby to a winner without either player getting stuck.
//
// The endgame threshold is set low (6 instead of 30) so a full game finishes
// in a couple of rounds. That knob exists on the create-room message precisely
// for this.
const FAME_THRESHOLD = '6'

type Player = { page: Page; name: string }

async function openPlayer(browser: Browser, name: string): Promise<Player> {
  // A fresh context per player: separate localStorage, so the two seats can't
  // accidentally share a stored reconnect token.
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  await page.getByTestId('go-multiplayer').click()
  await page.getByTestId('name-input').fill(name)
  return { page, name }
}

async function hostRoom(host: Player, opts: { seed?: string } = {}): Promise<string> {
  await host.page.getByTestId('player-count').selectOption('2')
  if (opts.seed) await host.page.getByTestId('seed').fill(opts.seed)
  await host.page.getByTestId('fame-threshold').fill(FAME_THRESHOLD)
  await host.page.getByTestId('host-game').click()
  await expect(host.page.getByTestId('lobby')).toBeVisible()
  return (await host.page.getByTestId('room-code').innerText()).trim()
}

async function joinRoom(guest: Player, roomCode: string): Promise<void> {
  await guest.page.getByTestId('room-code-input').fill(roomCode)
  await guest.page.getByTestId('join-game').click()
  await expect(guest.page.getByTestId('lobby')).toBeVisible()
}

// Who does the UI say is up? Read from the seat that is waiting, so this never
// depends on which browser happens to be ahead.
async function activePlayerIsMe(page: Page): Promise<boolean> {
  const text = await page.getByTestId('turn-indicator').innerText()
  return text.includes('Your turn')
}

async function visible(page: Page, testId: string): Promise<boolean> {
  return page.getByTestId(testId).isVisible().catch(() => false)
}

// What every seat thinks is going on, for a stall message that actually
// diagnoses. The distinction matters: ONE page saying "Your turn" while the
// other says "Waiting on …" is a test race. BOTH saying "Waiting on …" means a
// state broadcast never arrived — a real bug in the server or the client, and
// not something to paper over by loosening the loop.
// Clicks a control if it is there and live, and reports whether it actually
// landed. Every click in this file goes through here.
//
// The bounds are the point. Playwright's default click retries for the whole
// test budget, and in a two-browser game the DOM under a button changes
// constantly — a card deal animation makes it "not stable", an incoming state
// broadcast detaches it outright. Unbounded, one such click eats the entire
// test and reports a timeout rather than the thing that was actually wrong.
async function tryClick(page: Page, testId: string): Promise<boolean> {
  const target = page.getByTestId(testId)
  if (!(await target.isEnabled({ timeout: 1000 }).catch(() => false))) return false
  try {
    await target.click({ timeout: 2000 })
    return true
  } catch {
    // Stale read: the element was detached or disabled between the check and
    // the click. Re-read everything and try again next iteration.
    return false
  }
}

async function describeStall(players: Player[]): Promise<string> {
  const rows = await Promise.all(
    players.map(async ({ page, name }) => {
      const phase = await page.getByTestId('phase').innerText().catch(() => '(none)')
      const turn = await page.getByTestId('turn-indicator').innerText().catch(() => '(none)')
      return `  ${name}: phase=${phase} turn=${turn}`
    }),
  )
  return rows.join('\n')
}

// Answers any mandatory post-fame prompt (the Skunk) on either page until the
// Market phase actually opens.
//
// This POLLS rather than checking once: a click on one browser reaches the
// other only after a server round-trip, so "no prompt visible right now" does
// not mean "no prompt is coming". Checking once and moving on is how this test
// failed the first time it ran.
async function settleToMarket(players: Player[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await visible(players[0].page, 'turn-indicator')) return
    let clicked = false
    for (const { page } of players) {
      if (await tryClick(page, 'post-fame-option-0')) clicked = true
    }
    await players[0].page.waitForTimeout(clicked ? 80 : 150)
  }
  throw new Error(`settleToMarket: never reached the Market phase.\n${await describeStall(players)}`)
}

// Plays the match to its end screen, alternating between the two pages. The
// policy is deliberately dull — answer prompts, end turns, press the shared
// flip — because the point is that the FLOW works, not that anyone plays well.
async function playToEnd(players: Player[], maxSteps = 300): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    for (const { page } of players) {
      if (await visible(page, 'game-over')) return
    }

    let acted = false
    for (const { page } of players) {
      // The shared flip advance — either seat may press it, so whoever sees
      // the button first does.
      if (await tryClick(page, 'advance-flip')) {
        acted = true
        break
      }

      // A mandatory Skunk dismissal blocks the whole table until answered.
      if (await tryClick(page, 'post-fame-option-0')) {
        acted = true
        break
      }

      // A hired or dismissed Pig owes a deck, and holds its owner's turn open
      // until it gets one. The loop's policy never hires, so this shouldn't
      // fire today — it's here so that changing the policy doesn't silently
      // deadlock the game instead of failing usefully.
      if (await tryClick(page, 'deck-target-toonDeck')) {
        acted = true
        break
      }

      // Market turn: only the active seat can do anything. Gate on the
      // button being ENABLED, not merely present — the waiting seat renders
      // the same button behind a disabled fieldset.
      //
      // Every step here is bounded. isEnabled() WAITS for the element to
      // attach, so without a short timeout an iteration where no board is
      // rendered at all (postFameHooks, say) would burn the whole test
      // budget in one call. And the click itself is bounded because an
      // enabled-read can go stale in the moment between reading and
      // clicking — Playwright would then retry against a now-disabled
      // button until the test died, which is exactly how this hung before.
      if (await tryClick(page, 'end-turn')) {
        acted = true
        break
      }
    }

    // Settle after acting as well as after idling: re-reading the instant a
    // click lands is what manufactures the stale "it's my turn" read above.
    await players[0].page.waitForTimeout(acted ? 80 : 150)
  }
  throw new Error(`playToEnd: the game never reached an end screen.\n${await describeStall(players)}`)
}

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

    // Only the host is offered the start control.
    await expect(host.page.getByTestId('start-game')).toBeVisible()
    await expect(guest.page.getByTestId('waiting-for-host')).toBeVisible()

    await host.page.context().close()
    await guest.page.context().close()
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

    // Get into the Market phase.
    await host.page.getByTestId('advance-flip').click()
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

    await playToEnd([host, guest])

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

  test('each seat has its own board and its own fame', async ({ browser }) => {
    const host = await openPlayer(browser, 'Ana')
    const roomCode = await hostRoom(host, { seed: '11' })
    const guest = await openPlayer(browser, 'Bo')
    await joinRoom(guest, roomCode)
    await host.page.getByTestId('start-game').click()
    await host.page.getByTestId('advance-flip').click()

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
