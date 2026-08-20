#!/usr/bin/env bun
// The interactive terminal front-end for FlipToons' solo mode. Defaults to
// Season 1 (confirmed against the rulebook quote, §3.7); Season 2 is
// reachable via --season=2 but is a pattern-matched inference, not a
// confirmed rule — see setup.ts's buildSeason2SoloStartingDeck comment.
// Selecting it prints a banner before play starts rather than presenting it
// as settled; playing it is how that inference gets confirmed or corrected,
// the same oracle spirit as Phase 0's CLI applied to setup instead of
// scoring. Zero dependencies: Node's built-in `node:readline/promises`,
// nothing else — plan §2's dependency-free-engine constraint extends to
// this terminal layer too.
//
// Loop shape, one iteration per phase transition (flip-toonz-structure-plan.md
// §3.2), driving the SAME phase functions phases.ts already tests:
//   flip -> checkFame -> postFameHooks -> market (up to 2 actions) -> cleanup
//     -> (loop back to flip, or ended)
//
// Entry points:
//   bun run packages/engine/tui.ts [--seed=N] [--difficulty=easy|normal|hard]
//     Interactive: prompts on stdin/stdout via readline.
//   bun run packages/engine/tui.ts --seed=N --script=hire:2,dismiss:1,end,...
//     (hire:/dismiss: numbers are 1-based, matching the printed [1], [2], ...
//     labels; h/d are accepted shorthand, e.g. h2,d1)
//   bun run packages/engine/tui.ts --seed=N --script-file=path/to/script.txt
//     Non-interactive: drives the exact same loop from a scripted action
//     list instead of a human at the keyboard — this is how tui.test.ts
//     proves a full game reaches a deterministic win/loss without a human,
//     and how this pass's own verification run was produced.
//   bun run packages/engine/tui.ts --ai [--seed=N] [--difficulty=easy|normal|hard]
//     Autoplay: drives an entire solo game to completion via ai.ts's
//     playAutomatically (no human, no script) — reuses --seed for the AI's
//     own decision rng too, so `--ai --seed=N` reproduces identically
//     run-to-run. Mutually exclusive with --script=/--script-file=.
//
// ARCHITECTURE NOTE: there is exactly ONE loop (`runSoloGame`), with the
// input source injected as an `Ask` function. Interactive supplies a
// readline-backed asker; scripted/test mode supplies an array-shift asker.
// A second, separate "test loop" would prove nothing about the real
// keyboard path — the whole point of the scripted mode is that it drives
// the identical code a human's keystrokes would.

import { readFileSync } from 'node:fs'
import * as readline from 'node:readline/promises'

import { playAutomatically } from './ai'
import { cardRuleLines, renderGridBoxes } from './cli'
import type { Card, CardId, EffectChoices } from './cards/types'
import { occupiedSlots } from './grid'
import { hireCost } from './market'
import { dismiss, dismissCostFor, endMarketPhase, hire, runCheckFame, runCleanup, runFlip, runPostFameHooks } from './phases'
import { makeRng, shuffleWithState } from './rng'
import { formatBreakdown } from './score'
import { buildExplicitDeck, buildSoloSetup, cardsById } from './setup'
import type { SoloDifficulty } from './setup'
import { createSoloGameState } from './state'
import type { GameState } from './state'
import type { GridPos } from './types'

export type Ask = (prompt: string) => Promise<string>
export type Out = (line: string) => void

// Visually de-prioritizes a listing the player can't currently afford —
// terminal analogue of the web GUI's `.card:disabled { opacity: 0.5 }`
// (apps/web/src/style.css). Plain ANSI dim/reset since tui.ts stays
// zero-dependency (see file header).
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`
}

// Zero-pads fame/rank numbers in the Market and dismiss listings to 2 digits
// (highest possible values: price 15, rank 26) purely so the columns line
// up — every card in this range is at most 2 digits, so this never
// truncates.
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Single-line rule-text summary for the Market/dismiss listings —
// cardRuleLines (cli.ts) returns one line per rule (name/rank, fame value,
// then ability/dismiss-cost/immunity text); the name/rank is already
// covered by the listing line itself here, so everything else (the card's
// own fame value AND its ability) gets appended — a card with no special
// ability (e.g. a plain Goat) still shows what it's worth.
function abilitySummary(card: Card): string {
  const [, ...detail] = cardRuleLines(card)
  return detail.join('; ')
}

// Horse's onHire ability (discardMarketAndRefill) is OPTIONAL and needs a
// player choice (which market slots to discard) — keyed on the effect
// KIND, not card.id, so any future card sharing this exact ability is
// covered automatically (same style as score.ts's hasDogElsewhereCondition).
function hasDiscardMarketAndRefillOnHire(card: Card): boolean {
  return (card.onHire ?? []).some((e) => e.kind === 'discardMarketAndRefill')
}

// Parses the player's answer to the discard-choice prompt: any digits found
// (comma/space/anything separated) become 1-based slot numbers, converted
// to the 0-based indices hire()'s `discardMarketSlots` expects. A blank or
// unparseable answer yields an empty array, i.e. decline — this ancillary
// prompt is deliberately forgiving rather than re-prompting on bad input,
// unlike the main hire/dismiss/end grammar.
function parseDiscardChoices(raw: string, slotCount: number): number[] {
  const numbers = raw.match(/\d+/g) ?? []
  const chosen = new Set<number>()
  for (const n of numbers) {
    const displayed = Number(n)
    if (displayed >= 1 && displayed <= slotCount) chosen.add(displayed - 1)
  }
  return [...chosen]
}

// ---------------------------------------------------------------------------
// Unencodable-effect surfacing (task item 2). 18-ish cards across the toon
// deck have `unencodable: true` — their fame is correct but their
// hire/dismiss/onPlace EFFECT isn't implemented. A player who hires/
// dismisses/flips one of these and sees nothing happen has hit a silent
// wrong answer. Every such card gets its rawBannerText/rawBodyText printed
// verbatim plus an explicit manual-resolution notice.
//
// Two cards are a special case: Peacock ("gain 2 and take a BONUS Market
// action") and Horse ("discard any number of market cards and refill") ask
// for phase-machine mutations this TUI has no affordance for (an extra
// action slot; a player-chosen market discard-and-refill). Printing "resolve
// it manually" for those would be misleading — there is no manual fix for
// "you get a 3rd Market action" at a shared terminal. They get an honest
// "the engine will not grant this" notice instead.
// ---------------------------------------------------------------------------
const ENGINE_CANNOT_GRANT_MANUALLY = new Set<CardId>(['peacock', 'horse'])

function posLabel(pos: GridPos): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

// The TUI has no interactive machinery for Alligator's stack-target choice
// (same situation phases.ts's runPostFameHooks already documents and throws
// for) — rather than silently defaulting to some card, fail loudly.
function assertNoPendingPostMarketChoice(state: GameState): void {
  if (state.pendingPostMarketChoice) {
    throw new Error(
      `tui.ts: Alligator's stack-target choice (at ${posLabel(state.pendingPostMarketChoice.targetPos)}) isn't supported in the TUI — resolve it manually or play this in the web UI`,
    )
  }
}

function printUnencodableNotice(card: Card, out: Out, context: string): void {
  out(`  ⚠ ${card.name} (${context}) — effect NOT implemented by the engine:`)
  if (card.rawBannerText) out(`      ${card.rawBannerText}`)
  if (card.rawBodyText) out(`      ${card.rawBodyText}`)
  if (!card.rawBannerText && !card.rawBodyText && card.unencodableReason) out(`      (${card.unencodableReason})`)
  if (ENGINE_CANNOT_GRANT_MANUALLY.has(card.id)) {
    out('      ⚠ This effect (an extra Market action / a player-chosen market discard-and-refill) cannot be manually enacted through this TUI — the engine will NOT grant it. Known limitation, not something to resolve by hand.')
  } else {
    out("      ⚠ This card's effect is not implemented by the engine — resolve it manually per the text above, using a physical card or your own judgement.")
  }
}

// ---------------------------------------------------------------------------
// Dismissable-card listing, shared between the display and the script/
// interactive parser: a flat, reading-order index over every FACE-UP card in
// the grid (stacks expanded). The number shown to the player IS the number
// `dismiss:<n>` selects — same list, same order, every time it's printed.
// ---------------------------------------------------------------------------
type DismissEntry = { index: number; pos: GridPos; stackIndex: number; cardId: CardId; cost: number }

function listDismissEntries(state: GameState, cards: Record<CardId, Card>): DismissEntry[] {
  const entries: DismissEntry[] = []
  let i = 0
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, stackIndex) => {
      if (!slot.faceUp[stackIndex]) return
      const cost = dismissCostFor(state.grid, pos, stackIndex, cards)
      entries.push({ index: i, pos, stackIndex, cardId, cost })
      i++
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Action parsing — one grammar shared by the interactive prompt and the
// scripted/test action list: `hire:<slot>`, `dismiss:<index>`, `end`
// (also accepts `hire N` / `dismiss N` with a space, for a human typing
// casually at the interactive prompt).
// ---------------------------------------------------------------------------
type Action = { kind: 'hire'; slot: number } | { kind: 'dismiss'; index: number } | { kind: 'end' } | { kind: 'invalid' }

function parseAction(raw: string): Action {
  const trimmed = raw.trim().toLowerCase()
  // A bare empty string is NOT treated as `end` — a stray Enter at the
  // interactive prompt would otherwise irrevocably close the Market phase.
  // (EOF is handled separately, by racing rl.question() against the
  // interface's 'close' event — see the import.meta.main block — so this
  // function no longer needs to double as the EOF signal.)
  if (trimmed === 'end' || trimmed === 'end-market' || trimmed === 'e') return { kind: 'end' }
  const m = trimmed.match(/^(hire|h|dismiss|d)[:\s]*(\d+)$/)
  if (!m) return { kind: 'invalid' }
  // Displayed numbering is 1-based (matches the printed [1], [2], ... labels
  // below); internally everything downstream — market.slots, dismissable[]
  // — stays 0-based, so convert here, at the one boundary between "what the
  // player typed" and "what the engine indexes".
  const displayed = Number(m[2])
  if (displayed < 1) return { kind: 'invalid' }
  const n = displayed - 1
  return m[1] === 'hire' || m[1] === 'h' ? { kind: 'hire', slot: n } : { kind: 'dismiss', index: n }
}

// The engine's own signal that the TUI's phase machine called a phase
// function out of order (assertPhase's exact message shape, phases.ts) —
// that is a bug in tui.ts itself, not bad player input, and must NOT be
// swallowed into a friendly re-prompt. Everything else hire/dismiss can
// throw (affordability, out-of-range slot, empty slot, immune card, no
// actions remaining) is player-input-shaped and gets a friendly re-prompt.
function rethrowIfEngineBug(err: unknown): void {
  if (err instanceof Error && /^phases\.ts: \w+ called in phase/.test(err.message)) throw err
}

// Strips the internal `phases.ts: <fn> — ` module/function prefix off a
// player-input-rejection error before it's shown at the prompt — the
// PLAYER doesn't need to know which internal function objected, just why
// their action didn't work (e.g. "cannot afford slot 0 (costs 3, have 2
// fame)"). Only ever called after rethrowIfEngineBug has already let a real
// phase-machine bug propagate, so this never hides one.
function playerFacingMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^phases\.ts: \w+ — /, '')
}

// phases.ts's hire() reports its 0-based market.slots index verbatim (e.g.
// "cannot afford slot 0 ..."); the player just typed a 1-based number for
// that same slot, so remap it back before display to avoid an off-by-one
// that looks like a bug.
function toDisplaySlotMessage(message: string): string {
  return message.replace(/\bslot (\d+)\b/, (_, n) => `slot ${Number(n) + 1}`)
}

// ---------------------------------------------------------------------------
// Market phase — the interactive core (task item 4).
// ---------------------------------------------------------------------------
async function runMarketPhase(initial: GameState, cards: Record<CardId, Card>, ask: Ask, out: Out): Promise<GameState> {
  let state = initial

  while (state.phase === 'market' && state.actionsRemaining > 0) {
    out('')
    out(`Fame available to spend: ${state.fame}`)
    out(`Market actions remaining this round: ${state.actionsRemaining}`)
    out('Market:')
    state.market.slots.forEach((cardId, i) => {
      const price = hireCost(state.market, i)
      const affordable = state.fame >= price
      const n = i + 1 // displayed numbering is 1-based; see parseAction
      if (cardId === null) {
        out(dim(`  [${n}] ${pad2(price)} fame — (empty)`))
        return
      }
      const card = cards[cardId]
      const ability = abilitySummary(card)
      const line = `  [${n}] ${pad2(price)} fame — ${card.name} (rank ${pad2(card.rank)})${card.unencodable ? '  [effect not simulated]' : ''}${ability ? `  — ${ability}` : ''}`
      out(affordable ? line : dim(line))
    })

    const dismissable = listDismissEntries(state, cards)
    if (dismissable.length > 0) {
      out('Your grid (dismissable face-up cards):')
      for (const e of dismissable) {
        const card = cards[e.cardId]
        const cost = e.cost
        const immune = card.immune?.includes('dismiss') ? '  [immune to dismiss]' : ''
        const ability = abilitySummary(card)
        const n = e.index + 1 // displayed numbering is 1-based; see parseAction
        const line = `  [${n}] ${pad2(cost)} fame — ${card.name} (rank ${pad2(card.rank)}) at ${posLabel(e.pos)}${immune}${ability ? `  — ${ability}` : ''}`
        out(state.fame >= cost ? line : dim(line))
      }
    } else {
      out('Your grid has no dismissable (face-up) cards.')
    }

    // Nothing left the player can afford (no hireable slot, no dismissable
    // card within budget) — auto-close rather than force an `e` the player
    // has no real choice about; note it in the log so it's clear this wasn't
    // a manual `end`.
    const anyHireAffordable = state.market.slots.some((cardId, i) => cardId !== null && state.fame >= hireCost(state.market, i))
    const anyDismissAffordable = dismissable.some((e) => state.fame >= e.cost)
    if (!anyHireAffordable && !anyDismissAffordable) {
      out('No affordable actions remain — auto-ending Market phase.')
      state = endMarketPhase(state)
      assertNoPendingPostMarketChoice(state)
      break
    }

    const raw = await ask('Action (hire:<n>/h<n> / dismiss:<n>/d<n>, 1-based, e.g. h1, d2 / e to end): ')
    const action = parseAction(raw)

    if (action.kind === 'invalid') {
      out(`Didn't understand "${raw}" — use hire:<n>, dismiss:<n> (numbers start at 1), or end.`)
      continue
    }

    if (action.kind === 'end') {
      state = endMarketPhase(state)
      assertNoPendingPostMarketChoice(state)
      break
    }

    if (action.kind === 'hire') {
      const cardId = state.market.slots[action.slot]
      const price = action.slot >= 0 && action.slot < state.market.prices.length ? hireCost(state.market, action.slot) : undefined
      const card = cardId ? cards[cardId] : undefined
      try {
        let choices: EffectChoices | undefined
        if (card && price !== undefined && state.fame >= price && hasDiscardMarketAndRefillOnHire(card)) {
          // Horse: hire() deliberately leaves this card's OWN vacated slot
          // unrefilled until this ability's choice resolves (phases.ts's
          // hasDiscardMarketAndRefillOnHire comment), so discardMarketSlots
          // indices below target THIS gapped market — the same one already
          // listed above this prompt, just with this slot now empty — not a
          // preview of some future refilled state.
          out(`${card.name}'s ability: the market now has a gap at [${action.slot + 1}] — discard any number of the OTHER slots too, and every gap refills together.`)
          const discardRaw = await ask(
            `${card.name}: discard any number of these market slots (comma-separated numbers, blank to discard none): `,
          )
          // Already-empty slots (Horse's own gap, or a short market) are
          // silently dropped rather than passed through — they're not a
          // real discard, and counting them would over-report "Discarded N"
          // below for a no-op.
          const discardSlots = parseDiscardChoices(discardRaw, state.market.slots.length).filter((i) => state.market.slots[i] !== null)
          if (discardSlots.length > 0) choices = { discardMarketSlots: discardSlots }
        }
        state = hire(state, action.slot, choices)
        out(`Hired ${card!.name} for ${price} fame.`)
        if (card!.unencodable) printUnencodableNotice(card!, out, 'hired')
        if (choices?.discardMarketSlots?.length) out(`Discarded ${choices.discardMarketSlots.length} additional market card(s); all gaps refilled.`)
      } catch (err) {
        rethrowIfEngineBug(err)
        out(`Can't do that: ${toDisplaySlotMessage(playerFacingMessage(err))}`)
      }
      continue
    }

    if (action.kind === 'dismiss') {
      const entry = dismissable[action.index]
      if (!entry) {
        out(`No dismissable card at index ${action.index + 1}.`)
        continue
      }
      try {
        const card = cards[entry.cardId]
        state = dismiss(state, entry.pos, entry.stackIndex)
        out(`Dismissed ${card.name} for ${entry.cost} fame.`)
        if (card.unencodable) printUnencodableNotice(card, out, 'dismissed')
      } catch (err) {
        rethrowIfEngineBug(err)
        out(`Can't do that: ${playerFacingMessage(err)}`)
      }
      continue
    }
  }

  // actionsRemaining hit 0 without an explicit `end` — auto-close the
  // Market phase rather than offering an action that would only throw
  // "no Market actions remaining this round".
  if (state.phase === 'market') {
    state = endMarketPhase(state)
    assertNoPendingPostMarketChoice(state)
  }
  return state
}

// ---------------------------------------------------------------------------
// The one game loop (task's architecture note above).
// ---------------------------------------------------------------------------
export async function runSoloGame(opts: { state: GameState; ask: Ask; out: Out }): Promise<GameState> {
  let state = opts.state
  const { ask, out } = opts
  const cards = cardsById()

  while (state.phase !== 'ended') {
    if (state.phase === 'flip') {
      out('')
      out(`=== Round ${state.round}: Flip ===`)
      // Season 1 has no Return-to-deck effect, so the pre-flip shuffle
      // order IS the actual reveal order — this is a pure re-derivation of
      // runFlip's own internal shuffle (same deck, same rng state), not a
      // second live shuffle: deterministic in, deterministic out.
      const preview = shuffleWithState(state.deck, state.rng).result
      out(`Flip order: ${preview.map((id) => cards[id]?.name ?? id).join(', ') || '(empty deck)'}`)

      const flipLogLines: string[] = []
      state = runFlip(state, flipLogLines)
      flipLogLines.forEach(out)
      out('')
      out(renderGridBoxes(state.grid, cards))

      const gridCardCount = occupiedSlots(state.grid).reduce((sum, { slot }) => sum + slot.cards.length, 0)
      out(`(${gridCardCount} card(s) in grid, ${state.deck.length} card(s) left undrawn in deck)`)

      // Manual-resolution notices for every unencodable card that's now
      // face-up in the grid, whatever put it there (placement, a prior
      // hire, a prior dismiss that left a stack-mate behind) — this is the
      // "lands in the grid" trigger from the task, done as one grid scan
      // per round rather than per-effect-kind logic.
      for (const { pos, slot } of occupiedSlots(state.grid)) {
        slot.cards.forEach((cardId, i) => {
          if (!slot.faceUp[i]) return
          const card = cards[cardId]
          if (card.unencodable) printUnencodableNotice(card, out, `in grid at ${posLabel(pos)}`)
        })
      }
      continue
    }

    if (state.phase === 'checkFame') {
      state = runCheckFame(state)
      out('')
      out('=== Check Fame ===')
      if (state.lastCheckFame) out(formatBreakdown(state.lastCheckFame))
      out(`Round fame generated: ${state.fameGeneratedThisRound}`)

      // Remaining fameUnencodable cards (Fox, this season — Camel/Cat/Tiger
      // are now fully resolved via scoreGrid's externalState) print as
      // "NEEDS RULING" in formatBreakdown already — dump the verbatim card
      // text alongside so the player can resolve it by hand instead of
      // guessing.
      for (const line of state.lastCheckFame?.lines ?? []) {
        if (!line.needsRuling) continue
        const card = cards[line.cardId]
        out(`  ⚠ ${card.name} NEEDS RULING: ${line.needsRulingReason}`)
        if (card.rawBannerText) out(`      ${card.rawBannerText}`)
        if (card.rawBodyText) out(`      ${card.rawBodyText}`)
      }
      continue
    }

    if (state.phase === 'postFameHooks') {
      // Provably a pass-through in solo (phases.ts's own header comment):
      // Skunk/Firefly are both rank-0, starting-deck-only cards, and solo's
      // setup swaps the least-fame starter out of the starting deck, so no
      // solo grid can ever contain a face-up postFameHook card. Confirmed
      // by reading runPostFameHooks's body, not assumed — no player input
      // needed here.
      state = runPostFameHooks(state)
      continue
    }

    if (state.phase === 'market') {
      out('')
      out('=== Market ===')
      state = await runMarketPhase(state, cards, ask, out)
      continue
    }

    if (state.phase === 'cleanup') {
      const roundJustEnded = state.round
      const fameThisRound = state.fameGeneratedThisRound
      const threshold = state.fameToTriggerEndgame
      state = runCleanup(state)

      if (state.phase === 'ended') {
        out('')
        out('=== Game Over ===')
        if (state.result === 'win') {
          out(`YOU WIN — reached ${fameThisRound}/${threshold} fame in round ${roundJustEnded}.`)
        } else {
          out(`YOU LOSE — the toon deck depleted and the market could not refill (round ${roundJustEnded}).`)
        }
      } else {
        out('')
        out(`Round ${roundJustEnded} complete. Fame resets to 0. Advancing to round ${state.round}.`)
      }
      continue
    }

    throw new Error(`tui.ts: runSoloGame — unhandled phase '${state.phase}'`)
  }

  return state
}

// ---------------------------------------------------------------------------
// Scripted (non-interactive) mode (task item 3) — drives runSoloGame via a
// pre-supplied action list instead of a human. Exhausting the script treats
// every remaining Market decision as an implicit `end` (never hires/
// dismisses further), which is also exactly the "spend nothing, just race
// the toon deck" shape phases.test.ts's own depletion test uses.
// ---------------------------------------------------------------------------
export function makeScriptedAsk(tokens: readonly string[]): Ask {
  let i = 0
  return async (_prompt: string) => {
    if (i >= tokens.length) return 'end'
    return tokens[i++]
  }
}

export function parseScript(raw: string): string[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Setup / CLI entry point.
// ---------------------------------------------------------------------------
export function buildInitialState(
  seed: number,
  difficulty: SoloDifficulty = 'normal',
  startingDeckOverride?: CardId[],
  season: 1 | 2 = 1,
): GameState {
  const setup = buildSoloSetup(seed, season, difficulty)
  return createSoloGameState({
    seed: setup.seed,
    startingDeck: startingDeckOverride ?? setup.startingDeck,
    toonDeck: setup.toonDeck,
    prices: setup.prices,
    fameToTriggerEndgame: setup.fameToTriggerEndgame,
  })
}

function parseArgs(argv: string[]): {
  seed: number
  difficulty: SoloDifficulty
  scriptTokens: string[] | null
  deckOverride: CardId[] | null
  season: 1 | 2
  ai: boolean
} {
  let seed = Date.now() >>> 0
  let difficulty: SoloDifficulty = 'normal'
  let scriptTokens: string[] | null = null
  let deckOverride: CardId[] | null = null
  let season: 1 | 2 = 1
  let ai = false

  for (const arg of argv) {
    if (arg === '--ai') {
      ai = true
    } else if (arg.startsWith('--seed=')) {
      seed = Number(arg.slice('--seed='.length))
    } else if (arg.startsWith('--difficulty=')) {
      const v = arg.slice('--difficulty='.length)
      if (v !== 'easy' && v !== 'normal' && v !== 'hard') {
        throw new Error(`tui.ts: invalid --difficulty=${v} (expected easy|normal|hard)`)
      }
      difficulty = v
    } else if (arg.startsWith('--season=')) {
      const v = arg.slice('--season='.length)
      if (v !== '1' && v !== '2') {
        throw new Error(`tui.ts: invalid --season=${v} (expected 1|2)`)
      }
      season = v === '2' ? 2 : 1
    } else if (arg.startsWith('--script=')) {
      scriptTokens = parseScript(arg.slice('--script='.length))
    } else if (arg.startsWith('--script-file=')) {
      scriptTokens = parseScript(readFileSync(arg.slice('--script-file='.length), 'utf8'))
    } else if (arg.startsWith('--deck=')) {
      // Manual/demo override of the starting deck — mirrors cli.ts's
      // --deck= flag. NOT the official solo starting deck (§3.7); useful
      // for deterministically exercising a specific outcome (e.g. a fast
      // win) without waiting out the real starting deck's slow fame curve.
      const ids = arg
        .slice('--deck='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      // Validate up front (same convention as cli.ts's --deck=) so a typo'd
      // id fails loudly at arg-parse, not deep inside the flip loop.
      deckOverride = buildExplicitDeck(ids)
    } else {
      throw new Error(`tui.ts: unrecognized argument "${arg}"`)
    }
  }
  if (!Number.isFinite(seed)) throw new Error('tui.ts: --seed must be a finite number')
  if (ai && scriptTokens) throw new Error('tui.ts: --ai is mutually exclusive with --script=/--script-file=')
  return { seed, difficulty, scriptTokens, deckOverride, season, ai }
}

// Season 2's solo variant is a pattern-matched inference, not a confirmed
// rule (see buildInitialState's header comment and setup.ts's
// buildSeason2SoloStartingDeck). Printed once, before the first phase, so it
// can never be mistaken for a settled rule mid-game.
const SEASON_2_UNCONFIRMED_BANNER =
  'Season 2 solo variant is an UNCONFIRMED best-available inference (see setup.ts) — playing this is how we find out if it\'s right.'

// Only run when invoked directly, not when imported by tests — same
// convention cli.ts already uses.
if (import.meta.main) {
  const { seed, difficulty, scriptTokens, deckOverride, season, ai } = parseArgs(process.argv.slice(2))
  const state = buildInitialState(seed, difficulty, deckOverride ?? undefined, season)
  const out: Out = (line) => console.log(line)
  if (season === 2) out(SEASON_2_UNCONFIRMED_BANNER)

  if (ai) {
    // Same --seed also drives the AI's own decision rng (deliberately
    // separate from the game's own state.rng — see ai.ts's AiOptions
    // comment), so `--ai --seed=N` is fully reproducible run-to-run.
    const result = playAutomatically(state, { rng: makeRng(seed) })
    for (const line of result.logLines) out(line)
    out('')
    out('=== Game Over ===')
    if (result.state.result === 'win') {
      out(`YOU WIN — reached ${result.state.fameGeneratedThisRound}/${result.state.fameToTriggerEndgame} fame in round ${result.state.round}.`)
    } else {
      out(`YOU LOSE — the toon deck depleted and the market could not refill (round ${result.state.round}).`)
    }
    process.exit(result.state.result === 'loss' ? 1 : 0)
  } else if (scriptTokens) {
    runSoloGame({ state, ask: makeScriptedAsk(scriptTokens), out })
      .then((final) => {
        process.exit(final.result === 'loss' ? 1 : 0)
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      })
  } else {
    // The readline interface is constructed ONLY here, inside the
    // import.meta.main guard — never at module scope and never inside
    // runSoloGame itself, so importing this module from a test (or from a
    // scripted run) never opens stdin and never hangs `bun test`.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    // stdin EOF (piped input runs out, or `< /dev/null`) fires 'close' on
    // the interface — but a PENDING rl.question() promise does not settle
    // when that happens (confirmed directly: it neither resolves nor
    // rejects). Nothing else keeps the event loop alive at that point, so
    // without racing against 'close' explicitly, the process just exits
    // silently mid-game with no win/loss ever reported — observed directly:
    // `bun run tui.ts --seed=N < /dev/null` printed the first Market prompt
    // and exited 0 without ever reaching Game Over. Racing rl.question()
    // against a promise that resolves on 'close' fixes this: whichever
    // settles first wins, and a close-triggered `ask` treats EOF the same
    // way scripted mode treats running out of tokens — every remaining
    // decision becomes an implicit `end`.
    let closed = false
    let resolveClosed: (() => void) | null = null
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    rl.on('close', () => {
      closed = true
      resolveClosed?.()
    })
    const ask: Ask = async (prompt) => {
      if (closed) return 'end'
      const result = await Promise.race([
        rl.question(prompt).then((answer) => ({ kind: 'answer' as const, answer })),
        closedPromise.then(() => ({ kind: 'closed' as const })),
      ])
      return result.kind === 'answer' ? result.answer : 'end'
    }
    runSoloGame({ state, ask, out })
      .then((final) => {
        rl.close()
        // Same exit-code convention as scripted mode (loss -> 1, win -> 0),
        // so a caller scripting either mode gets a consistent signal.
        process.exitCode = final.result === 'loss' ? 1 : 0
      })
      .catch((err) => {
        rl.close()
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      })
  }
}
