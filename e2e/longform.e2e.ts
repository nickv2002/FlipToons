import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyTally, hostRoom, joinRoom, openPlayer, playToEnd } from './helpers'
import type { PlayTally } from './helpers'

// A full-length two-seat game at the REAL fame threshold, run by hand.
//
// Not part of `make e2e` — it takes minutes. This is a debugging harness: run
// it when something smells wrong, read what it reports. `make e2e-long`.
//
// Why it exists. The standard suite's 'buy' games are played at a threshold of
// 6 so they finish in a couple of rounds, which caps how many cards ever get
// hired — across its three seeds that produced 2-5 hires each and exactly ONE
// effect prompt in total. Hire and dismiss are covered there; the card effects
// behind them are barely grazed. Only a full-length game hires enough cards to
// hit them.
//
// THE CEILING IS LOW, AND THAT IS THE CARD TABLE'S DOING, NOT THIS TEST'S.
// Exactly five cards in sixty-two carry an effect that opens a prompt, and
// they are split across seasons — so a single-season game can never reach more
// than three of them:
//
//   Butterfly  S1  rank 4   onHire  dismissByName (needs a Caterpillar out)
//   Horse      S1  rank 10  onHire  discardMarketAndRefill
//   Raccoon    S2  rank 8   onHire  hireFromDismissed
//   Panther    S2  rank 9   onHire  dismissChosenGridCard
//   Crow       S2  rank 13  onDismiss hireFromMarketAndRefill
//
// Hence: run BOTH seasons (three of the five are unreachable in Season 1), and
// judge a run by WHICH of the five it touched, never by a total. A run that
// reports zero prompts is information about the shuffle, not a failure.
const CHOICE_BEARING_CARDS = ['Butterfly', 'Horse', 'Raccoon', 'Panther', 'Crow']

// The rulebook number, as opposed to the standard suite's 6.
const FULL_FAME_THRESHOLD = '30'

// Deliberately not test-results/: that is Playwright's own output directory
// and gets wiped. A debugging artifact that vanishes on the next run is worse
// than one you have to go find.
const TRANSCRIPT_DIR = join(process.cwd(), '.longform')

// One seed per season by default — a threshold-30 game is several times longer
// than the 26s-1.1m the short ones take, so a multi-seed default would make
// the harness too slow to reach for. FLIPTOONS_SEEDS=3,11,29 to widen it.
const SEEDS = (process.env.FLIPTOONS_SEEDS ?? '11').split(',').map((s) => s.trim()).filter(Boolean)

test.describe('long-form game (debugging harness)', () => {
  // A skip rather than a testIgnore in playwright.config.ts: this way the
  // harness shows up as a skipped line in every `make e2e` run, so nobody
  // forgets it exists.
  test.skip(!process.env.FLIPTOONS_LONGFORM, 'long-form: run it with `make e2e-long`')

  for (const season of [1, 2] as const) {
    for (const seed of SEEDS) {
      test(`season ${season}, seed ${seed}: a full game at threshold ${FULL_FAME_THRESHOLD}`, async ({ browser }) => {
        test.setTimeout(600_000)

        const crashes: string[] = []
        const host = await openPlayer(browser, 'Ana')
        const guest = await openPlayer(browser, 'Bo')
        for (const p of [host, guest]) p.page.on('pageerror', (e) => crashes.push(e.message))

        const roomCode = await hostRoom(host, { seed, season, threshold: FULL_FAME_THRESHOLD })
        await joinRoom(guest, roomCode)
        await host.page.getByTestId('start-game').click()
        for (const p of [host, guest]) await expect(p.page.getByTestId('match')).toBeVisible()

        const started = Date.now()
        // The report is written in a finally, and a stall is exactly when it
        // matters most: a harness that only reports on success tells you
        // nothing on the run you actually needed to debug. The first version
        // did that and produced two silent 600s timeouts.
        let stall: unknown = null
        let tally = await playToEnd([host, guest], {
          policy: 'buy',
          // A full-length game runs many more rounds than the short ones, and
          // the loop takes several steps per turn.
          maxSteps: 20_000,
          // Comfortably under the 600s test timeout, so the loop gives up
          // while there is still time to write the transcript.
          deadlineMs: Number(process.env.FLIPTOONS_DEADLINE_MS ?? 480_000),
          // Market slots are ordered by rank, so the priciest affordable slot
          // is the highest-rank card in reach — which is where four of the
          // five choice-bearing cards sit. Biases against Butterfly (rank 4)
          // only, and that one is cheap enough to come up anyway.
          hirePreference: 'priciest',
          // More rounds means more room to dismiss without stripping a board
          // to the point where neither seat can reach the threshold.
          dismissBudget: 3,
          dismissFirst: true,
          // Live progress: a run this long should not look hung while it is
          // working, and the tail of this stream is the stall diagnosis.
          onNote: (n) => console.log(`    ${n}`),
        }).catch((err) => {
          stall = err
          return (err as { tally?: PlayTally }).tally ?? emptyTally()
        })
        const elapsed = Math.round((Date.now() - started) / 1000)

        const promptedCards = [...new Set(tally.effectPrompts)]
        const touched = CHOICE_BEARING_CARDS.filter(
          (c) => promptedCards.includes(c) || tally.hiredCards.includes(c) || tally.dismissedCards.includes(c),
        )
        const summary = [
          `season ${season}, seed ${seed} — ${elapsed}s`,
          `  hires:            ${tally.hires} (${unique(tally.hiredCards)})`,
          `  dismisses:        ${tally.dismisses} (${unique(tally.dismissedCards)})`,
          `  effect prompts:   ${tally.effectChoices} (${promptedCards.join(', ') || 'none'})`,
          // The line that answers "did this run cover anything new?". Of the
          // five cards that can open a prompt, which showed up at all.
          `  choice cards hit: ${touched.join(', ') || 'none'} (of ${CHOICE_BEARING_CARDS.join(', ')})`,
          `  error banners:    ${tally.errors.length === 0 ? 'none' : ''}`,
          ...tally.errors.map((e) => `    ${e}`),
        ].join('\n')
        console.log(summary)

        mkdirSync(TRANSCRIPT_DIR, { recursive: true })
        const file = join(TRANSCRIPT_DIR, `season${season}-seed${seed}.log`)
        writeFileSync(file, `${summary}\n\n--- transcript ---\n${tally.transcript.join('\n')}\n`)
        console.log(`  transcript:       ${file}`)

        // Surface the stall AFTER the transcript is on disk.
        if (stall) throw stall

        // Assertions are only for things that mean something is BROKEN.
        for (const p of [host, guest]) {
          await expect(p.page.getByTestId('game-over')).toBeVisible({ timeout: 20_000 })
        }

        const hostResult = await host.page.getByTestId('result').innerText()
        const guestResult = await guest.page.getByTestId('result').innerText()
        if (hostResult.includes('shared win')) {
          expect(guestResult).toContain('shared win')
        } else {
          expect(hostResult.includes('You win')).not.toBe(guestResult.includes('You win'))
        }

        expect(crashes).toEqual([])

        // An illegal-action banner is normal noise here — a click can land the
        // instant the turn changes hands. A "Server error" one is apps/worker's
        // response to a genuine engine throw, and on a first long run that is
        // more likely a real find than a harness bug. Read it before "fixing"
        // the test.
        expect(tally.errors.filter((e) => e.includes('Server error'))).toEqual([])

        // NOT asserted: coverage. See the header — with five choice-bearing
        // cards in sixty-two, a run touching none of them is information about
        // the shuffle, not a failure.

        await host.page.context().close()
        await guest.page.context().close()
      })
    }
  }
})

function unique(names: string[]): string {
  if (names.length === 0) return 'none'
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ')
}
