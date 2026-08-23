import { expect } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

// Shared machinery for the browser specs. Lives in a non-`.e2e.ts` file on
// purpose: playwright.config.ts matches `**/*.e2e.ts`, so this is imported
// rather than collected as a suite of its own.
//
// Both specs drive the same policy loop — the short games in
// two-player.e2e.ts and the long-form debugging harness in longform.e2e.ts —
// and a second copy of it would drift.

export type Player = { page: Page; name: string }

// The endgame threshold the standard suite uses. Deliberately far below the
// rulebook's 30 so a full game finishes in a couple of rounds; the long-form
// harness overrides it back up. That knob exists on the create-room message
// precisely for this.
export const SHORT_FAME_THRESHOLD = '6'

export async function openPlayer(browser: Browser, name: string): Promise<Player> {
  // A fresh context per player: separate localStorage, so the two seats can't
  // accidentally share a stored reconnect token.
  //
  // Stops at the launch screen: host and join are separate panels behind
  // separate cards now, and the name field belongs to whichever one you open,
  // so hostRoom/joinRoom fill it.
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  return { page, name }
}

export async function hostRoom(
  host: Player,
  opts: { seed?: string; threshold?: string; season?: 1 | 2 } = {},
): Promise<string> {
  await host.page.getByTestId('mode-host').click()
  await host.page.getByTestId('name-input').fill(host.name)
  if (opts.season) await host.page.getByTestId(`season-${opts.season}`).click()
  if (opts.seed) await host.page.getByTestId('seed').fill(opts.seed)
  await host.page.getByTestId('fame-threshold').fill(opts.threshold ?? SHORT_FAME_THRESHOLD)
  await host.page.getByTestId('host-game').click()
  await expect(host.page.getByTestId('lobby')).toBeVisible()
  return (await host.page.getByTestId('room-code').innerText()).trim()
}

export async function joinRoom(guest: Player, roomCode: string): Promise<void> {
  await openJoinPanel(guest)
  await guest.page.getByTestId('room-code-input').fill(roomCode)
  await guest.page.getByTestId('join-game').click()
  await expect(guest.page.getByTestId('lobby')).toBeVisible()
}

// The join panel with the name already filled — for specs that want to submit
// the form themselves (a bad room code, say).
export async function openJoinPanel(guest: Player): Promise<void> {
  await guest.page.getByTestId('mode-join').click()
  await guest.page.getByTestId('name-input').fill(guest.name)
}

// Who does the UI say is up? Read from the seat that is waiting, so this never
// depends on which browser happens to be ahead.
export async function activePlayerIsMe(page: Page): Promise<boolean> {
  const text = await page.getByTestId('turn-indicator').innerText()
  return text.includes('Your turn')
}

export async function visible(page: Page, testId: string): Promise<boolean> {
  return page.getByTestId(testId).isVisible().catch(() => false)
}

// Is anything matching this selector in the DOM right now? count() reads the
// current DOM and returns immediately — no implicit wait, which is what keeps
// the play loop's per-step cost flat.
export async function present(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count().catch(() => 0)) > 0
}

// Clicks a control if it is there and live, and reports whether it actually
// landed. Every click in these specs goes through here or tryClickFirst.
//
// The bounds are the point. Playwright's default click retries for the whole
// test budget, and in a two-browser game the DOM under a button changes
// constantly — a card deal animation makes it "not stable", an incoming state
// broadcast detaches it outright. Unbounded, one such click eats the entire
// test and reports a timeout rather than the thing that was actually wrong.
export async function tryClick(page: Page, testId: string): Promise<boolean> {
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

// Same bounds as tryClick, for controls addressed by CSS rather than a bare
// test id — a dismissible grid card is identified by being the clickable one.
export async function tryClickFirst(page: Page, selector: string): Promise<boolean> {
  const target = page.locator(selector).first()
  if ((await target.count().catch(() => 0)) === 0) return false
  try {
    await target.click({ timeout: 2000 })
    return true
  } catch {
    return false
  }
}

// What every seat thinks is going on, for a stall message that actually
// diagnoses. The distinction matters: ONE page saying "Your turn" while the
// other says "Waiting on …" is a test race. BOTH saying "Waiting on …" means a
// state broadcast never arrived — a real bug in the server or the client, and
// not something to paper over by loosening the loop.
export async function describeStall(players: Player[]): Promise<string> {
  const rows = await Promise.all(
    players.map(async ({ page, name }) => {
      // Bounded: this is the message that EXPLAINS a stall, so it must not
      // become part of one.
      // The phase chip only renders for phases a player acts in (MatchView's
      // phaseLabel), so a stall mid-postFameHooks shows no chip at all — the
      // round is always there and keeps the line informative.
      const round = await page.getByTestId('round').innerText({ timeout: 2000 }).catch(() => '(none)')
      const phase = await page.getByTestId('phase').innerText({ timeout: 2000 }).catch(() => '(no phase chip)')
      const turn = await page.getByTestId('turn-indicator').innerText({ timeout: 2000 }).catch(() => '(none)')
      return `  ${name}: ${round} phase=${phase} turn=${turn}`
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
export async function settleToMarket(players: Player[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await visible(players[0].page, 'turn-indicator')) return
    let clicked = false
    for (const { page } of players) {
      if (await tryClickFirst(page, '[data-testid="post-fame-prompt"] [data-testid^="effect-choice-option"]')) clicked = true
    }
    await players[0].page.waitForTimeout(clicked ? 80 : 150)
  }
  throw new Error(`settleToMarket: never reached the Market phase.\n${await describeStall(players)}`)
}

// What a run actually did. The counts let a test assert the game was really
// played rather than passed through; the name lists are what make the
// long-form harness a debugging tool instead of a fourth pass/fail test.
export type PlayTally = {
  hires: number
  dismisses: number
  effectChoices: number
  // Card names, in the order they happened. Read off each button's `title`
  // before clicking it — Card.tsx already puts card.name there for compact
  // cards, so no extra markup is needed.
  hiredCards: string[]
  dismissedCards: string[]
  // Which card opened each effect prompt, scraped from the prompt's own
  // "{cardName}: …" line.
  effectPrompts: string[]
  // Every distinct error-banner text seen while playing. Illegal-action
  // banners are normal here (a click can land exactly as the turn changes
  // hands); a "Server error" one is an engine throw and a real find.
  errors: string[]
  // Blow-by-blow, for reading after the fact.
  transcript: string[]
}

export type PlayOptions = {
  //   'pass'  answer prompts and end turns. Deliberately
  //           dull: the point is that the FLOW works, not that anyone plays
  //           well. Never spends fame, so the Market phase's real decisions —
  //           hire, dismiss, and every card effect they trigger — go untouched.
  //   'buy'   the same, but each seat spends its turn: hire a market card it
  //           can afford, else dismiss something off its own board, and answer
  //           whatever effect prompt that opens.
  policy?: 'pass' | 'buy'
  maxSteps?: number
  dismissBudget?: number
  // Which affordable market slot to take. Slots are ordered by rank, so
  // 'priciest' biases toward the high-rank cards that actually carry effects
  // — worth it for a long run whose point is triggering them. 'cheapest'
  // reaches an endgame sooner, which is what the short games want.
  hirePreference?: 'cheapest' | 'priciest'
  // Give up after this much wall time and throw a PlayStallError carrying the
  // tally. Set it BELOW the Playwright test timeout so the caller gets a
  // chance to write its report instead of being killed mid-loop.
  deadlineMs?: number
  // Try dismiss BEFORE hire while the budget lasts. Long games only. In a
  // short game (threshold 6) a seat's fame barely covers one action, so
  // dismissing first means never hiring at all — which failed the standard
  // suite's `hires > 0` assertion outright.
  dismissFirst?: boolean
  // Called once per step with a one-line description, for live progress on a
  // run that takes minutes.
  onNote?: (note: string) => void
}

// See the dismiss branch below for why this is a budget and not a free choice.
export const DISMISSES_PER_SEAT = 1

export function emptyTally(): PlayTally {
  return { hires: 0, dismisses: 0, effectChoices: 0, hiredCards: [], dismissedCards: [], effectPrompts: [], errors: [], transcript: [] }
}

// Thrown when the loop gives up. Carries the tally so a caller can still write
// its report — on a stall that report is the whole point.
export class PlayStallError extends Error {
  constructor(message: string, readonly tally: PlayTally) {
    super(message)
  }
}

export async function playToEnd(players: Player[], opts: PlayOptions = {}): Promise<PlayTally> {
  const policy = opts.policy ?? 'pass'
  const maxSteps = opts.maxSteps ?? 300
  const perSeatDismisses = opts.dismissBudget ?? DISMISSES_PER_SEAT
  const hirePreference = opts.hirePreference ?? 'cheapest'
  const dismissFirst = opts.dismissFirst ?? false
  const dismissBudget = new Map<Page, number>()
  const tally = emptyTally()
  // Wall-clock bound as well as a step bound. Steps are a poor proxy for time
  // — a step that finds nothing to click costs a fraction of one that clicks —
  // and a run that blows the Playwright test timeout dies WITHOUT reporting.
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity

  const note = (text: string) => {
    tally.transcript.push(text)
    opts.onNote?.(text)
  }

  let lastRound = ''
  let step = 0
  for (; step < maxSteps && Date.now() < deadline; step++) {
    for (const { page } of players) {
      if (await visible(page, 'game-over')) {
        note('game over')
        return tally
      }
    }

    // Round/phase changes, so the transcript reads as a game rather than a
    // list of clicks.
    const marker = await roundMarker(players[0].page)
    if (marker && marker !== lastRound) {
      note(`— ${marker}`)
      lastRound = marker
    }
    await recordErrors(players, tally)

    let acted = false
    for (const { page, name } of players) {
      // There is no flip to press: the Flip takes no player input, so the
      // server advances it (rooms.ts's advanceSharedPhases) and the phase
      // arrives already revealed. What used to stall here was a Flip nobody
      // had clicked; a stall now means a prompt nobody answered.

      // A mandatory Skunk dismissal blocks the whole table until answered.
      if (await tryClickFirst(page, '[data-testid="post-fame-prompt"] [data-testid^="effect-choice-option"]')) {
        note(`${name}: answered a post-fame prompt`)
        acted = true
        break
      }

      // A hired or dismissed Pig owes a deck, and holds its owner's turn open
      // until it gets one.
      if (await tryClick(page, 'deck-target-toonDeck')) {
        note(`${name}: put the Pig back in the toon deck`)
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
        const who = await promptCardName(page)
        if (
          (await tryClickFirst(page, '[data-testid="effect-choice-skip"]')) ||
          (await tryClickFirst(page, '[data-testid="effect-choice-option-0"]:not([disabled])')) ||
          (await tryClickFirst(page, '[data-testid="effect-choice-confirm"]'))
        ) {
          tally.effectChoices++
          if (who) tally.effectPrompts.push(who)
          note(`${name}: answered ${who ?? 'an'} effect prompt`)
          acted = true
          break
        }
      }

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
        // In a LONG game, dismiss goes first while the budget lasts. Hiring
        // spends the seat's fame and a dismiss costs 5, so hire-first leaves
        // nothing to dismiss with and the budget is never touched at all — a
        // full run reported 27 hires and 0 dismisses. The budget is what keeps
        // this safe: a handful per seat across ten rounds, rather than the
        // every-turn stripping that stopped the first version of this loop
        // from ever producing a winner.
        //
        // Short games keep hire-first: there, one dismiss is the seat's whole
        // turn and hires stop happening entirely.
        //
        // Slot.tsx deliberately does NOT gate dismiss on affordability — it
        // lets the click through so the engine's error surfaces. So filter
        // here, or the budget gets spent on rejected clicks: an earlier run
        // burned all six on "cannot afford dismissing Bee".
        if (dismissFirst && (dismissBudget.get(page) ?? perSeatDismisses) > 0) {
          const target = page
            .locator('.round-view__grid-pane .card--clickable:not([disabled])')
            .filter({ hasNot: page.locator('.card__dismiss-cost--unaffordable') })
            .first()
          if ((await target.count().catch(() => 0)) > 0) {
            const card = await cardNameOf(target)
            try {
              await target.click({ timeout: 2000 })
              dismissBudget.set(page, (dismissBudget.get(page) ?? perSeatDismisses) - 1)
              tally.dismisses++
              if (card) tally.dismissedCards.push(card)
              note(`${name}: dismissed ${card ?? 'a card'}`)
              acted = true
              break
            } catch {
              // Stale read — try again next iteration.
            }
          }
        }

        // Match the BUTTON specifically: an empty market slot renders as a
        // div carrying the same test id, and a div is never :disabled — so a
        // testid-only match would "hire" a hole in the market.
        const affordable = page.locator('button[data-testid^="market-slot-"]:not([disabled])')
        const count = await affordable.count().catch(() => 0)
        if (count > 0) {
          // Slots run cheapest-first, so 'priciest' is simply the last one.
          const target = hirePreference === 'priciest' ? affordable.nth(count - 1) : affordable.first()
          const card = await cardNameOf(target)
          try {
            await target.click({ timeout: 2000 })
            tally.hires++
            if (card) tally.hiredCards.push(card)
            note(`${name}: hired ${card ?? 'a card'}`)
            acted = true
            break
          } catch {
            // Stale read — re-derive everything next iteration.
          }
        }

        // Hire-first's fallback: a turn with fame but nothing affordable in
        // the market. Same budget, same affordability filter as above.
        if (!dismissFirst && (dismissBudget.get(page) ?? perSeatDismisses) > 0) {
          const target = page
            .locator('.round-view__grid-pane .card--clickable:not([disabled])')
            .filter({ hasNot: page.locator('.card__dismiss-cost--unaffordable') })
            .first()
          if ((await target.count().catch(() => 0)) > 0) {
            const card = await cardNameOf(target)
            try {
              await target.click({ timeout: 2000 })
              dismissBudget.set(page, (dismissBudget.get(page) ?? perSeatDismisses) - 1)
              tally.dismisses++
              if (card) tally.dismissedCards.push(card)
              note(`${name}: dismissed ${card ?? 'a card'}`)
              acted = true
              break
            } catch {
              // Stale read — try again next iteration.
            }
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
  const why = step >= maxSteps ? `maxSteps (${maxSteps})` : `deadline (${opts.deadlineMs}ms)`
  throw new PlayStallError(
    `playToEnd: the game never reached an end screen — hit ${why}.\n${await describeStall(players)}`,
    tally,
  )
}

// --- transcript helpers ----------------------------------------------------

// Card.tsx puts "{name}\n{body text}" in the button's title for compact cards,
// which is every card in the market and in an effect prompt. First line only.
async function cardNameOf(target: ReturnType<Page['locator']>): Promise<string | null> {
  // Market and effect-prompt cards are `compact`, and Card.tsx only sets the
  // title for those — so a grid card (a dismiss target) has none. Fall back to
  // the rendered name. Without this the report read "dismisses: 6 (none)".
  const title = await target.getAttribute('title').catch(() => null)
  if (title) return title.split('\n')[0].trim()
  const name = target.locator('.card__name').first()
  if ((await name.count().catch(() => 0)) === 0) return null
  return (await name.innerText({ timeout: 1000 }).catch(() => '')).trim() || null
}

// EffectChoicePrompt renders "{cardName}: <what it wants>".
async function promptCardName(page: Page): Promise<string | null> {
  // Bounded for the same reason as recordErrors above.
  const text = await page.locator('.effect-choice__prompt').first().innerText({ timeout: 1000 }).catch(() => '')
  const colon = text.indexOf(':')
  return colon > 0 ? text.slice(0, colon).trim() : null
}

// The round, plus the phase chip when there is one. Reading the chip alone
// went blank in every phase MatchView deliberately doesn't label, which took
// the round changes out of the transcript with it.
async function roundMarker(page: Page): Promise<string | null> {
  const round = await page.getByTestId('round').innerText({ timeout: 1000 }).catch(() => null)
  const phase = await page.getByTestId('phase').innerText({ timeout: 500 }).catch(() => null)
  if (!round) return phase
  return phase ? `${round} · ${phase}` : round
}

// App.tsx renders server-sent errors in `match-error`. Record each distinct
// one: illegal actions are expected noise here, a "Server error" is not.
async function recordErrors(players: Player[], tally: PlayTally): Promise<void> {
  for (const { page, name } of players) {
    // count() FIRST. The banner is absent almost always, and innerText() on a
    // locator that matches nothing waits for the action timeout — which
    // Playwright defaults to unbounded, i.e. the whole test budget. Calling it
    // unguarded froze the very first step of the loop: ten minutes, zero
    // flips, an empty game log, and a transcript reading only "— flip".
    const banner = page.getByTestId('match-error').first()
    if ((await banner.count().catch(() => 0)) === 0) continue
    const text = await banner.innerText({ timeout: 1000 }).catch(() => '')
    if (!text) continue
    const line = `${name}: ${text.trim()}`
    if (!tally.errors.includes(line)) {
      tally.errors.push(line)
      tally.transcript.push(`!! ${line}`)
    }
  }
}
