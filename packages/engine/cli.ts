#!/usr/bin/env bun
// Step 0 — the flip scorer. Runs one Flip phase and prints the finished grid
// plus an itemized fame breakdown, per flip-toonz-structure-plan.md §8's
// step-0 scope.
//
// Two modes:
//   bun run packages/engine/cli.ts <seed>
//     Season 1's starting deck, shuffled from a seed. (Original Step-0 mode
//     — kept working unchanged.)
//   bun run packages/engine/cli.ts --deck=rabbit,rabbit,elephant,monkey,bee,snail
//     An explicit, hand-picked deck, flipped in the exact order given (NOT
//     shuffled). Exists because none of the 13 market cards encoded after
//     Step 0 (Eagle, Donkey, Butterfly, Rabbit, Horse, Snake, Elephant,
//     Alligator, Monkey, Pig, Peacock, Cow, Axolotl) are starting cards, so
//     they're otherwise unreachable from the CLI. Unshuffled by design —
//     the point of this mode is deterministic manual testing of a specific
//     card interaction, not randomness.
//
// Either mode also accepts an optional --dog-elsewhere=true|false flag: it
// resolves Dog's 'dogInMarketOrOtherPlayerGrid' fame condition to a single
// branch (see score.ts's scoreGrid externalState parameter). Omitted (the
// default), a grid containing a Dog shows BOTH possible outcomes side by
// side in the fame breakdown instead of guessing.

import type { Card, CardId, PlaceEffect, PostFameHook } from './cards/types'
import { flipDeck } from './flip'
import { makeRng, shuffle } from './rng'
import { formatBreakdown, scoreGrid } from './score'
import { buildExplicitDeck, buildSeason1StartingDeck, cardsById } from './setup'
import type { Grid, Slot } from './types'

// ---------------------------------------------------------------------------
// Card rule text — for the visual grid render below. Prefers verbatim
// transcribed text (rawBannerText/rawBodyText) when the card has it; most
// starting/simple cards (e.g. Snail: `fame: { base: 2 }`, nothing else)
// don't, so this derives readable text from the structured fame.bonuses /
// onPlace / postFameHook fields instead. Display-only — none of this feeds
// back into scoring, which stays driven entirely by score.ts.
// ---------------------------------------------------------------------------

// 'inUpperRow' -> 'in upper row'; 'dogInMarketOrOtherPlayerGrid' -> 'dog in
// market or other player grid'. Good enough for a fallback description; the
// authoritative wording is rawBannerText/rawBodyText when present.
function humanize(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

function fameSummaryLine(card: Card): string {
  if (card.fame.base === '=') return "Fame: copies the highest adjacent face-up card's fame"
  const parts = [`Fame: ${card.fame.base}`]
  for (const b of card.fame.bonuses ?? []) {
    parts.push(b.kind === 'perQuery' ? `+${b.amount} per ${humanize(b.query)}` : `+${b.amount} if ${humanize(b.condition)}`)
  }
  return parts.join(', ')
}

function placeEffectText(effect: PlaceEffect): string {
  switch (effect.kind) {
    case 'stackOnPreviousPlaced':
      return 'Stacks on the previously placed card'
    case 'stackNextRevealed':
      return 'Stacks the next revealed card on this card'
    case 'flipNextRevealed':
      return 'Flips the next revealed card'
    case 'flipPreviousPlaced':
      return 'Flips the previously placed card'
    case 'stackOnFirstMatchOrFaceDown':
      return `Stacks on the first ${effect.matchCardId} or face-down card in the grid`
    case 'moveToExtraRowIfUpperRow':
      return 'IF placed in the upper row, moves to a row above'
    case 'stackOnAboveIfLowerRow':
      return 'IF placed in the lower row, stacks on the card directly above'
    case 'returnNextRevealedIfRankAtMost':
      return `Returns the next revealed card if its rank is at most ${effect.maxRank}`
    case 'returnPreviousPlacedOrStack':
      return 'Returns the previously placed card (stacks on it instead if immune)'
    case 'returnSelfIfMiddleColumn':
      return 'IF placed in the middle column, returns itself'
    case 'returnLowestRankOrStack':
      return 'Returns the lowest-rank face-up card in the grid (stacks on it instead if immune)'
    case 'moveNextRevealedToExtraRowIfUpperRow':
      return 'IF placed in the upper row, diverts the next revealed card to a row above instead'
    case 'dismissOwnDeckTopAndStackFromToonDeck':
      return "Dismisses the top card of your deck (or places it to the right if immune) and stacks the toon deck's top card on this card"
    case 'dismissOwnDeckBottomAndDrawToonDeckTop':
      return "Dismisses the bottom card of your deck unless immune, and adds the toon deck's top card to the top of your deck"
    case 'other':
      return effect.text
  }
}

function postFameHookText(hook: PostFameHook): string {
  const effectText =
    hook.effect.kind === 'dismiss' ? 'dismiss a card from your grid for free' : `gain ${hook.effect.amount} fame`
  return `IF you have the least fame after Check Fame, ${effectText} (mandatory${hook.consumesAction ? '' : ', free action'})`
}

// All rule-text lines for one face-up card, in the order they'd read on the
// physical card: name/rank, fame, then ability text.
export function cardRuleLines(card: Card): string[] {
  const lines: string[] = [`${card.name} (rank ${card.rank})`, fameSummaryLine(card)]

  const rawLines: string[] = []
  if (card.rawBannerText) rawLines.push(card.rawBannerText)
  if (card.rawBodyText) rawLines.push(card.rawBodyText)

  if (rawLines.length > 0) {
    lines.push(...rawLines)
  } else {
    // No verbatim text stored — derive from structured onPlace/postFameHook
    // data (fame.bonuses is already folded into fameSummaryLine above, so
    // it's not repeated here).
    for (const effect of card.onPlace ?? []) lines.push(placeEffectText(effect))
    if (card.postFameHook) lines.push(postFameHookText(card.postFameHook))
  }

  if (card.dismissCost !== undefined) lines.push(`Dismiss cost: ${card.dismissCost} (instead of 5)`)
  if (card.immune?.length) lines.push(`Immune to: ${card.immune.join(', ')}`)
  if (card.fameUnencodable) lines.push(`[fame ruling: ${card.fameUnencodableReason ?? 'needs ruling'}]`)
  if (card.unencodable) lines.push(`[effect not yet simulated: ${card.unencodableReason ?? 'unimplemented'}]`)

  return lines
}

// ---------------------------------------------------------------------------
// Box-drawing grid render — one bordered box per slot, laid out in the real
// 3-column shape (any extra rows above, printed top row first, then the two
// base rows), each box showing every face-up card's rule text (wrapped to
// fit) and a plain [face-down] marker (no text) for face-down cards.
// ---------------------------------------------------------------------------

const BOX_INTERIOR_WIDTH = 28

export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word
    if (candidate.length <= width) {
      cur = candidate
      continue
    }
    if (cur) lines.push(cur)
    if (word.length > width) {
      // A single word longer than the box — hard-break it rather than
      // overflow the box border.
      let rest = word
      while (rest.length > width) {
        lines.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      cur = rest
    } else {
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines
}

// Unwrapped content lines for one slot (empty, single card, or a face-up/
// face-down stack — bottom to top, per Slot's doc comment), before wrapping.
function slotContentLines(slot: Slot | null, cards: Record<CardId, Card>): string[] {
  if (slot === null) return ['(empty)']
  const lines: string[] = []
  slot.cards.forEach((cardId, i) => {
    if (i > 0) lines.push('── stacked on ──')
    if (!slot.faceUp[i]) {
      lines.push('[face-down]')
      return
    }
    const card = cards[cardId]
    lines.push(...cardRuleLines(card))
  })
  return lines
}

function renderBoxRow(cellsContent: string[][], width: number): string[] {
  const wrapped = cellsContent.map((lines) => lines.flatMap((l) => wrapText(l, width)))
  const height = Math.max(1, ...wrapped.map((c) => c.length))
  const top = wrapped.map(() => `┌${'─'.repeat(width + 2)}┐`).join(' ')
  const bottom = wrapped.map(() => `└${'─'.repeat(width + 2)}┘`).join(' ')
  const contentRows: string[] = []
  for (let i = 0; i < height; i++) {
    contentRows.push(wrapped.map((c) => `│ ${(c[i] ?? '').padEnd(width)} │`).join(' '))
  }
  return [top, ...contentRows, bottom]
}

export function renderGridBoxes(grid: Grid, cards: Record<CardId, Card>): string {
  const output: string[] = []

  const printRow = (label: string, slots: (Slot | null)[]) => {
    output.push(label)
    output.push(...renderBoxRow(slots.map((s) => slotContentLines(s, cards)), BOX_INTERIOR_WIDTH))
  }

  // Extra rows print top-to-bottom (highest first), matching the base rows
  // printed top-to-bottom below them — same visual order as the physical
  // stack of rows growing upward from the base grid.
  for (let i = grid.extraRows.length - 1; i >= 0; i--) {
    printRow(`extra row ${i}:`, grid.extraRows[i])
  }
  grid.base.forEach((row, i) => {
    printRow(`row ${i}:`, row)
  })

  return output.join('\n')
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runWithDeck(deck: CardId[], label: string, dogElsewhere: boolean | undefined): void {
  const cards = cardsById()
  // Standalone flip (no Market phase in this CLI) — genuinely empty shared
  // toon deck/dismissed pile, same rationale as scoreGrid's `dismissed: []`
  // just below.
  const { grid, remainingDeck } = flipDeck(deck, cards, { toonDeck: [], dismissed: [] })

  console.log(label)
  console.log(`Flip order: ${deck.map((id) => cards[id]?.name ?? id).join(', ')}`)
  console.log()
  console.log('Grid:')
  console.log(renderGridBoxes(grid, cards))
  console.log()

  // A standalone flip (this CLI has no Market phase) genuinely has an empty
  // dismissed pile — `dismissed: []` here is accurate, not a stand-in for
  // missing state (see Cat/Tiger/Opossum's fame handlers in score.ts).
  const breakdown = scoreGrid(grid, cards, remainingDeck.length, { dogElsewhere, dismissed: [] })
  console.log('Fame breakdown:')
  console.log(formatBreakdown(breakdown))

  // Signal off what actually ended up on the FINISHED grid (breakdown.lines),
  // not the pre-flip deck: a Dog left undrawn (deck longer than six slots,
  // or returned to the deck by an unrelated effect) never reaches the grid
  // and shouldn't trigger this advisory.
  if (dogElsewhere === undefined && breakdown.lines.some((l) => l.dualBranch)) {
    console.log()
    console.log('(Dog present with --dog-elsewhere not given: both outcomes shown above. Pass --dog-elsewhere=true or --dog-elsewhere=false to resolve to one.)')
  }

  if (remainingDeck.length > 0) {
    console.log()
    console.log(`(${remainingDeck.length} card(s) left undrawn in deck: ${remainingDeck.map((id) => cards[id]?.name ?? id).join(', ')})`)
  }
}

export function run(seed: number, dogElsewhere?: boolean): void {
  const deck = shuffle(buildSeason1StartingDeck(), makeRng(seed))
  runWithDeck(deck, `Seed: ${seed}`, dogElsewhere)
}

export function runExplicitDeck(ids: CardId[], dogElsewhere?: boolean): void {
  const deck = buildExplicitDeck(ids)
  runWithDeck(deck, `Explicit deck: ${ids.join(',')}`, dogElsewhere)
}

// Only run when invoked directly (bun run cli.ts <seed>), not when imported
// by tests.
if (import.meta.main) {
  const args = process.argv.slice(2)
  const dogElsewhereArg = args.find((a) => a.startsWith('--dog-elsewhere='))
  const positional = args.filter((a) => a !== dogElsewhereArg)

  function parseDogElsewhere(): boolean | undefined {
    if (!dogElsewhereArg) return undefined
    const value = dogElsewhereArg.slice('--dog-elsewhere='.length)
    if (value === 'true') return true
    if (value === 'false') return false
    console.error(`Invalid --dog-elsewhere value: ${value} (expected true or false)`)
    process.exit(1)
  }

  const arg = positional[0]
  if (!arg) {
    console.error('Usage: bun run packages/engine/cli.ts <seed> [--dog-elsewhere=true|false]')
    console.error('   or: bun run packages/engine/cli.ts --deck=id1,id2,id3,... [--dog-elsewhere=true|false]')
    console.error('--dog-elsewhere resolves Dog\'s market/other-player-grid fame condition to one branch;')
    console.error('omitted, a Dog in the grid shows both possible outcomes side by side.')
    process.exit(1)
  }

  const dogElsewhere = parseDogElsewhere()

  if (arg.startsWith('--deck=')) {
    const ids = arg
      .slice('--deck='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) {
      console.error('--deck= requires at least one comma-separated card id')
      process.exit(1)
    }
    try {
      runExplicitDeck(ids, dogElsewhere)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  } else {
    const seed = Number(arg)
    if (!Number.isFinite(seed)) {
      console.error(`Invalid seed: ${arg}`)
      process.exit(1)
    }
    run(seed, dogElsewhere)
  }
}
