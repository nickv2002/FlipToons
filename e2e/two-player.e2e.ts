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
// policy is one of two, chosen by the caller.
//
//   'pass'  answer prompts, end turns, press the shared flip. Deliberately
//           dull: the point is that the FLOW works, not that anyone plays
//           well. Never spends fame, so the Market phase's real decisions —
//           hire, dismiss, and every card effect they trigger — go untouched.
//   'buy'   the same, but each seat spends its turn: hire the first market
//           card it can afford, else dismiss something off its own board,
//           and answer whatever effect prompt that opens. This is the one
//           that exercises the card vocabulary.
//
// Returns a tally of what it actually managed to do, so a test can assert the
// game was really played rather than passed through — a 'buy' run that never
// found an affordable card would otherwise be the 'pass' test wearing a hat.
type PlayTally = { hires: number; dismisses: number; effectChoices: number }

// See the dismiss branch below for why this is a budget and not a free choice.
const DISMISSES_PER_SEAT = 1

async function playToEnd(
  players: Player[],
  opts: { policy?: 'pass' | 'buy'; maxSteps?: number } = {},
): Promise<PlayTally> {
  const policy = opts.policy ?? 'pass'
  const dismissBudget = new Map<Page, number>()
  const maxSteps = opts.maxSteps ?? 300
  const tally: PlayTally = { hires: 0, dismisses: 0, effectChoices: 0 }

  for (let step = 0; step < maxSteps; step++) {
    for (const { page } of players) {
      if (await visible(page, 'game-over')) return tally
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

      // An effect prompt from a hire or dismiss (Panther, Butterfly, Crow,
      // Horse, Alligator). Decline the optional ones and take the first
      // option on the mandatory ones — Horse's multi-select confirms with
      // nothing chosen, which is a legal and meaningful answer. This is
      // checked before the market below, because an open prompt blocks the
      // acting seat until it is answered.
      if (policy === 'buy' && (await present(page, '[data-testid="effect-choice"]'))) {
        if (
          (await tryClickFirst(page, '[data-testid="effect-choice-skip"]')) ||
          (await tryClickFirst(page, '[data-testid="effect-choice-option-0"]:not([disabled])')) ||
          (await tryClickFirst(page, '[data-testid="effect-choice-confirm"]'))
        ) {
          tally.effectChoices++
          acted = true
          break
        }
      }

      // Spend the turn. Hire beats dismiss because it grows the deck and so
      // keeps the game moving toward a real endgame; dismiss is the fallback
      // for a turn with fame but nothing affordable in the market.
      // My turn, with fame to spend. The gate is the `end-turn` BUTTON, not
      // the `my-controls` fieldset around it: Playwright's isEnabled only
      // understands native form controls and reports a disabled <fieldset> as
      // enabled. The button inside inherits the disable, so it tells the
      // truth.
      //
      // Every check below is a count(), which resolves against the current
      // DOM without waiting. That matters more than it looks: the obvious
      // version — loop slots 0..6 calling isEnabled — spends a full timeout
      // on each slot that doesn't exist, and a 2-player market has four. That
      // alone put ~3s into every step and stopped the game finishing at all.
      if (policy === 'buy' && (await present(page, 'button[data-testid="end-turn"]:not([disabled])'))) {
        // Match the BUTTON specifically: an empty market slot renders as a
        // div carrying the same test id, and a div is never :disabled — so a
        // testid-only match would "hire" a hole in the market.
        if (await tryClickFirst(page, 'button[data-testid^="market-slot-"]:not([disabled])')) {
          tally.hires++
          acted = true
          break
        }
        // Dismiss is deliberately RATIONED rather than used as the general
        // fallback. It is a real move and its onDismiss effects are worth
        // exercising, but a seat that dismisses every turn it can't afford a
        // hire strips its own board — and fame is scored FROM the board, so
        // both seats then sit below the endgame threshold forever and the
        // game never ends. The first version of this loop did exactly that:
        // 18 dismisses and 2 hires in 20 steps, no winner.
        //
        // A dismissible card renders clickable inside the grid pane; every
        // other card there is disabled, so "the first clickable one" is a
        // legal target by construction.
        if ((dismissBudget.get(page) ?? DISMISSES_PER_SEAT) > 0) {
          if (await tryClickFirst(page, '.round-view__grid-pane .card--clickable:not([disabled])')) {
            dismissBudget.set(page, (dismissBudget.get(page) ?? DISMISSES_PER_SEAT) - 1)
            tally.dismisses++
            acted = true
            break
          }
        }
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

// Same bounds as tryClick, for the one control that has no test id of its
// own: a dismissible grid card is identified by being the clickable one.
async function tryClickFirst(page: Page, selector: string): Promise<boolean> {
  const target = page.locator(selector).first()
  if ((await target.count().catch(() => 0)) === 0) return false
  try {
    await target.click({ timeout: 2000 })
    return true
  } catch {
    return false
  }
}

// Is anything matching this selector in the DOM right now? count() reads the
// current DOM and returns immediately — no implicit wait, which is what keeps
// the play loop's per-step cost flat.
async function present(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count().catch(() => 0)) > 0
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
