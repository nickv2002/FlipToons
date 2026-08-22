// End-to-end proof that the TUI's game loop (tui.ts's runSoloGame) actually
// drives a real solo game to completion via the scripted/non-interactive
// path — task item 3's "non-interactive test mode is required, not
// optional." Both tests reuse the same hand-constructed decks
// phases.test.ts already proves reach a deterministic win/loss, so a
// failure here isolates a bug in the TUI's phase-driving loop, not in the
// underlying engine (which phases.test.ts already covers independently).

import { describe, expect, test } from 'bun:test'
import { getSlot, occupiedSlots } from './grid'
import { runCheckFame, runFlip, runPostFameHooks } from './phases'
import { buildExplicitDeck, buildSoloSetup, cardsById } from './setup'
import { createSoloGameState } from './state'
import { makeScriptedAsk, parseScript, runSoloGame } from './tui'

const TUI_PATH = new URL('./tui.ts', import.meta.url).pathname

const cards = cardsById()

// Same 32-fame, order-independent deck phases.test.ts uses for its win test:
// alligator 6 + axolotl 7 + peacock 5 + horse 4 + bull 3 + bear (1+6) 7 = 32.
const HIGH_FAME_DECK = buildExplicitDeck(['alligator', 'axolotl', 'peacock', 'horse', 'bull', 'bear'], cards)

function collectOutput() {
  const lines: string[] = []
  return { lines, out: (line: string) => lines.push(line) }
}

describe('tui.ts scripted mode drives a real game end-to-end', () => {
  test('a high-fame deck reaches a WIN, with a hire and a dismiss exercised along the way', async () => {
    const setup = buildSoloSetup(101, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: HIGH_FAME_DECK,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()

    // Script: dismiss the first dismissable card (frees fame back, exercises
    // dismiss), hire market slot 0 (cheapest, exercises hire), then end the
    // Market phase. Scripted mode falls back to implicit `end` after the
    // script is exhausted, so subsequent rounds (there won't be any — this
    // deck wins round 1) need nothing further.
    const ask = makeScriptedAsk(parseScript('dismiss:1,hire:1,end'))
    const final = await runSoloGame({ state, ask, out })

    expect(final.phase).toBe('ended')
    expect(final.result).toBe('win')
    expect(lines.some((l) => l.includes('YOU WIN'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Dismissed '))).toBe(true)
    expect(lines.some((l) => l.startsWith('Hired '))).toBe(true)
  })

  test("a Dog in the grid resolves to ONE fame value (no dual-branch) via runCheckFame's own market-derived dogElsewhere — the actual before/after the Dog fix", async () => {
    // Deliberately puts a Dog in the STARTING deck (so it's face-up and
    // scored at Check Fame) and NO Dog anywhere in the toon deck (so the
    // market can never contain one either) — this exercises the false
    // branch through the real TUI display path, not just phases.ts
    // directly (phases.test.ts already covers both branches at the
    // engine level; this proves the TUI's printed breakdown reflects it).
    const setup = buildSoloSetup(104, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['dog', 'bee', 'snail', 'bee', 'snail', 'bee'], cards),
      toonDeck: buildExplicitDeck(['ostrich', 'eagle', 'goat', 'sheep', 'rabbit'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()
    const ask = makeScriptedAsk([]) // never spend — just observe the Check Fame print
    await runSoloGame({ state, ask, out })

    // BEFORE this pass's fix, a Dog with no externalState.dogElsewhere
    // given would print as a dual-branch line ("if no Dog elsewhere" / "if
    // a Dog is present elsewhere") — see score.ts's formatBreakdown. AFTER
    // the fix, runCheckFame always supplies dogElsewhere derived from
    // state.market, so a solo player should NEVER see that dual-branch
    // text, and the Dog's line should be a single resolved number.
    expect(lines.some((l) => l.includes('if no Dog elsewhere') || l.includes('if a Dog is present elsewhere'))).toBe(false)
    // Resolved to a single line ending "= 0" (no Dog elsewhere -> the +5
    // bonus doesn't apply), not a dual-branch "X (label) | Y (label)" line.
    const dogLine = lines.find((l) => l.includes('Dog') && l.includes('no Dog in the market'))
    expect(dogLine).toBeDefined()
    expect(dogLine).toMatch(/Dog\s+0 \+ 0 \(no Dog in the market or another player's grid\) = 0/)
  })

  test('Cat (formerly fameUnencodable) now scores normally off GameState.dismissed, not a NEEDS RULING blank', async () => {
    // Cat's dismissedStartingCard bonus is now fully encoded (Group 4 of
    // this pass — see score.ts's externalState.dismissed). A fresh game has
    // nothing dismissed yet, so Cat should score its plain base fame (1)
    // with a "0 dismissed starting card(s)" bonus line, not a NEEDS RULING
    // blank the way it did before this pass.
    const setup = buildSoloSetup(105, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['cat', 'bee', 'snail', 'bee', 'snail', 'bee'], cards),
      toonDeck: buildExplicitDeck(['ostrich', 'eagle', 'goat', 'sheep', 'rabbit'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()
    const ask = makeScriptedAsk([])
    await runSoloGame({ state, ask, out })

    expect(lines.some((l) => l.includes('Cat NEEDS RULING'))).toBe(false)
    const catLine = lines.find((l) => l.includes('Cat') && l.includes('dismissed starting card'))
    expect(catLine).toBeDefined()
    expect(catLine).toMatch(/Cat\s+1 \+ 0 \(0 dismissed starting card\(s\)\) = 1/)
  })

  test('a still-unencodable card (Axolotl — Big Button, out of scope this pass) hired from the market prints the manual-resolution notice, not silence', async () => {
    const setup = buildSoloSetup(102, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      // axolotl(7) + peacock(5) + horse(4) + alligator(6) + bear(1+6) +
      // bee(1) = 32 fame round 1 (same deterministic high-fame deck used in
      // phases.test.ts's HIGH_FAME_DECK) — comfortably affords Axolotl's
      // top-tier market price (15).
      startingDeck: buildExplicitDeck(['axolotl', 'peacock', 'horse', 'alligator', 'bear', 'bee'], cards),
      toonDeck: buildExplicitDeck(['axolotl', 'ostrich', 'goat', 'sheep', 'horse'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()

    // Find an AFFORDABLE Axolotl slot at runtime rather than hardcoding
    // an index (exact sort position could shift with a different fixture).
    // Only ever attempts one hire (`asked` guard) — retrying after a
    // successful hire would just spend down further, and this test only
    // needs to prove the notice fires once.
    let asked = false
    const ask: (p: string) => Promise<string> = async (_p) => {
      if (asked) return 'end'
      asked = true
      const fameLine = lines.slice().reverse().find((l) => l.startsWith('Fame available to spend:'))
      const fame = fameLine ? Number(fameLine.split(':')[1]) : 0
      // Market and dismiss lines share the same "[n] <cost> fame — <name>"
      // shape now that price/cost is printed before the name — the dismiss
      // listing's " at <pos>" suffix (absent from market lines) is what
      // distinguishes a Market-slot Axolotl from a grid Axolotl.
      const marketLineRe = /^\s*\[(\d+)\]\s*(\d+)\s*fame\s*—\s*Axolotl\s*\(rank\s*\d+\)(?!\s+at\s)/
      const marketLines = lines.slice().reverse().filter((l) => marketLineRe.test(l))
      for (const l of marketLines) {
        const m = l.match(marketLineRe)
        if (m && Number(m[2]) <= fame) return `hire:${m[1]}`
      }
      return 'end'
    }
    await runSoloGame({ state, ask, out })

    expect(lines.some((l) => l.includes('Hired Axolotl'))).toBe(true)
    expect(lines.some((l) => l.includes('effect NOT implemented by the engine'))).toBe(true)
    expect(lines.some((l) => l.includes('WHEN HIRED, FLIP YOUR BIG BUTTON CARD FACE UP'))).toBe(true)
    expect(lines.some((l) => l.includes("resolve it manually per the text above"))).toBe(true)
  })

  test('Butterfly (newly encoded this pass) hires cleanly with no manual-resolution notice — its optional onHire effect silently declines when the TUI supplies no choice', async () => {
    const setup = buildSoloSetup(102, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: buildExplicitDeck(['bee', 'snail', 'bee', 'snail', 'bee', 'snail'], cards),
      // 7 cards, not 5: the market only takes 5 at initial fill, leaving 2
      // behind so the round-1 guaranteed-loss short-circuit (actions.ts's
      // skipGuaranteedLossMarketPhase / tui.ts's mirrored check) doesn't fire
      // before the player gets to hire Butterfly — a 5-card deck would be
      // fully drained by the initial market fill, and solo's per-round
      // decay (market.ts's soloMarketDecay) always needs 2 more toon-deck
      // cards, which an already-empty deck can never supply.
      toonDeck: buildExplicitDeck(['butterfly', 'ostrich', 'goat', 'sheep', 'horse', 'eagle', 'donkey'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()

    let asked = false
    const ask: (p: string) => Promise<string> = async (_p) => {
      if (asked) return 'end'
      asked = true
      const fameLine = lines.slice().reverse().find((l) => l.startsWith('Fame available to spend:'))
      const fame = fameLine ? Number(fameLine.split(':')[1]) : 0
      const marketLineRe = /^\s*\[(\d+)\]\s*(\d+)\s*fame\s*—\s*Butterfly\s*\(rank\s*\d+\)(?!\s+at\s)/
      const marketLines = lines.slice().reverse().filter((l) => marketLineRe.test(l))
      for (const l of marketLines) {
        const m = l.match(marketLineRe)
        if (m && Number(m[2]) <= fame) return `hire:${m[1]}`
      }
      return 'end'
    }
    await runSoloGame({ state, ask, out })

    expect(lines.some((l) => l.includes('Hired Butterfly'))).toBe(true)
    expect(lines.some((l) => l.includes('effect NOT implemented by the engine'))).toBe(false)
  })

  test('a tiny toon deck loses to depletion, driven entirely by an empty script (implicit end every round)', async () => {
    const setup = buildSoloSetup(103, 1, 'normal')
    const state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      // Same tiny toon deck phases.test.ts uses for its depletion test.
      toonDeck: buildExplicitDeck(['ostrich', 'eagle', 'donkey', 'butterfly', 'dog', 'goat'], cards),
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    const { lines, out } = collectOutput()

    const ask = makeScriptedAsk([]) // no actions at all — every Market decision is an implicit `end`
    const final = await runSoloGame({ state, ask, out })

    expect(final.phase).toBe('ended')
    expect(final.result).toBe('loss')
    expect(final.toonDeckDepleted).toBe(true)
    expect(lines.some((l) => l.includes('YOU LOSE'))).toBe(true)
  })
})

// §10 calls for a property test that "replaying {seed, actions} reproduces
// identical state." §4.7's action log doesn't exist yet (state.ts says so
// explicitly), so there is no {seed, actions} representation to replay from
// — THIS IS A SUBSTITUTE, not §10's test: same seed + same scripted token
// list, run twice through the real TUI loop, asserting byte-identical final
// GameState. It's a weaker claim (it depends on the script matching what
// the game actually offers each round, not an arbitrary action log), and
// should not be read as closing §10's replay item — see §12's note.
describe('replay substitute: same seed + same script -> identical final state', () => {
  test('two independent runs of the same seed and script produce a deep-equal final GameState', async () => {
    const setup = buildSoloSetup(105, 1, 'normal')
    const script = parseScript('hire:1,dismiss:1,end,hire:1,end,end,end,end,end,end,end,end,end,end')

    async function play() {
      const state = createSoloGameState({
        seed: setup.seed,
        startingDeck: setup.startingDeck,
        toonDeck: setup.toonDeck,
        prices: setup.prices,
        fameToTriggerEndgame: setup.fameToTriggerEndgame,
      })
      const { out } = collectOutput()
      return runSoloGame({ state, ask: makeScriptedAsk(script.slice()), out })
    }

    const runA = await play()
    const runB = await play()

    expect(runA).toEqual(runB)
    expect(runA.result === 'win' || runA.result === 'loss').toBe(true)
  })
})

// listDismissEntries (tui.ts) filters occupiedSlots to face-up cards only —
// this proves that filtering holds through the real printed Market prompt,
// not just by reading the private function's source.
describe('tui.ts Market prompt never lists a face-down card as dismissable', () => {
  test('a card manually flipped face-down is excluded from the dismissable list, and the count matches face-up cards only', async () => {
    const setup = buildSoloSetup(6, 1, 'normal')
    let state = createSoloGameState({
      seed: setup.seed,
      startingDeck: setup.startingDeck,
      toonDeck: setup.toonDeck,
      prices: setup.prices,
      fameToTriggerEndgame: setup.fameToTriggerEndgame,
    })
    state = runPostFameHooks(runCheckFame(runFlip(state)))

    const found = occupiedSlots(state.grid)
      .flatMap(({ pos, slot }) => slot.cards.map((id, i) => ({ pos, id, i, faceUp: slot.faceUp[i] })))
      .find((c) => c.faceUp)
    expect(found).toBeDefined()
    if (!found) return
    const slot = getSlot(state.grid, found.pos)!
    slot.faceUp[found.i] = false // flip it face-down directly, same technique as phases.test.ts's dismiss tests
    const flippedCard = cards[found.id]

    const faceUpCount = occupiedSlots(state.grid).reduce((sum, { slot }) => sum + slot.faceUp.filter(Boolean).length, 0)

    const { lines, out } = collectOutput()
    await runSoloGame({ state, ask: makeScriptedAsk(parseScript('end')), out })

    const headerIndex = lines.findIndex((l) => l.startsWith('Your grid (dismissable face-up cards):'))
    expect(headerIndex).toBeGreaterThanOrEqual(0)
    const dismissLines: string[] = []
    for (let i = headerIndex + 1; i < lines.length && /^\s*\[\d+\]/.test(lines[i]); i++) {
      dismissLines.push(lines[i])
    }

    // Match on name + position, not name alone — the starting deck has
    // duplicate card names (e.g. two Bees), so a bare name check could pass
    // by matching a different face-up copy of the same card.
    const flippedPosLabel = found.pos.section === 'base' ? `row ${found.pos.row}, col ${found.pos.col}` : `extra row ${found.pos.row}, col ${found.pos.col}`
    expect(dismissLines.length).toBe(faceUpCount)
    expect(dismissLines.some((l) => l.includes(flippedCard.name) && l.includes(`at ${flippedPosLabel}`))).toBe(false)
  })
})

// --ai mode (Task 1) — end-to-end through the real CLI entry point (the
// import.meta.main block), not just the exported functions it calls,
// because the thing under test here is specifically the CLI's log
// printing/exit-code wiring, not ai.ts's own decision quality (ai.test.ts's
// job). Spawns `bun run tui.ts --ai ...` as a real subprocess so the actual
// process.exit(...) convention is observed, exactly as a caller scripting
// this mode would see it. Both fixed seeds below are pinned to a known
// result (seed=1 -> win, seed=42 -> loss) so this also proves the exit-code
// convention (0 on win, 1 on loss) holds for both outcomes, not just one.
describe('tui.ts --ai autoplay mode (CLI entry point)', () => {
  test('reaches a deterministic WIN with exit code 0 for a fixed seed, identically across two runs', async () => {
    const runOnce = () =>
      Bun.spawnSync(['bun', 'run', TUI_PATH, '--ai', '--seed=1', '--difficulty=easy'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

    const runA = runOnce()
    const runB = runOnce()

    const outA = runA.stdout.toString()
    const outB = runB.stdout.toString()

    expect(runA.exitCode).toBe(0)
    expect(runB.exitCode).toBe(0)
    expect(outA).toBe(outB)
    expect(outA).toContain('=== Game Over ===')
    expect(outA).toContain('YOU WIN')
  })

  test('reaches a deterministic LOSS with exit code 1 for a fixed seed, identically across two runs', async () => {
    // seed=42 flipped to a WIN once the market's refill timing was fixed to
    // match the confirmed rulebook text (once per turn, not once per
    // hire/dismiss — see phases.ts's hire() header comment): the toon deck
    // now depletes slower, so it no longer reliably loses. seed=3 still
    // reliably loses under the corrected timing.
    const runOnce = () =>
      Bun.spawnSync(['bun', 'run', TUI_PATH, '--ai', '--seed=3', '--difficulty=easy'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

    const runA = runOnce()
    const runB = runOnce()

    const outA = runA.stdout.toString()
    const outB = runB.stdout.toString()

    expect(runA.exitCode).toBe(1)
    expect(runB.exitCode).toBe(1)
    expect(outA).toBe(outB)
    expect(outA).toContain('=== Game Over ===')
    expect(outA).toContain('YOU LOSE')
  })

  test('--ai combined with --script= is rejected as mutually exclusive', () => {
    const run = Bun.spawnSync(['bun', 'run', TUI_PATH, '--ai', '--seed=1', '--script=end'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr.toString()).toContain('mutually exclusive')
  })
})
