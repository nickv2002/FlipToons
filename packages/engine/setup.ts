// Setup helpers: building a starting deck and a card lookup table from the
// card data (packages/engine/cards). Per §4.6, setup is the only
// season-aware module — everything else in the engine takes cards as data
// and never branches on season.

import { allCards, season1Cards, season2Cards } from './cards'
import type { Card, CardId } from './cards/types'
import { makeRng, shuffle } from './rng'

// Season 1 starting deck (§3.1, §4.5): 2x Caterpillar, 1x Skunk,
// 1x Dragonfly, 1x Bee, 1x Snail — the six rank-0 season1Cards, expanded by
// their `copies` count.
export function buildSeason1StartingDeck(): CardId[] {
  const starters = season1Cards.filter((c) => c.rank === 0)
  const deck: CardId[] = []
  for (const card of starters) {
    for (let i = 0; i < card.copies; i++) deck.push(card.id)
  }
  return deck
}

export function cardsById(): Record<CardId, Card> {
  const map: Record<CardId, Card> = {}
  for (const card of allCards) map[card.id] = card
  return map
}

// None of the 13 market cards this pass encoded (Eagle, Donkey, Butterfly,
// Rabbit, Horse, Snake, Elephant, Alligator, Monkey, Pig, Peacock, Cow,
// Axolotl) are starting cards — buildSeason1StartingDeck() can never
// produce them, so there's no way to flip-test any of them through that
// path. This builds a deck directly from a hand-picked list of card ids
// instead, for manual/scripted testing (see cli.ts's --deck flag and
// flip-effects.test.ts). Validates every id up front — a typo'd or
// cross-season id here should fail loudly, not silently place `undefined`.
export function buildExplicitDeck(ids: CardId[], cards: Record<CardId, Card> = cardsById()): CardId[] {
  for (const id of ids) {
    if (!cards[id]) throw new Error(`setup.ts: buildExplicitDeck — unknown card id "${id}"`)
  }
  return ids.slice()
}

// ---------------------------------------------------------------------------
// The official solo variant (§3.7). Distinct from the sandbox
// buildSeason1StartingDeck() above: different starting deck, a toon deck
// with the Pig removed and a difficulty-sized trim, and (in state.ts/
// phases.ts) a different win condition. Market prices/width are NOT
// season-specific — see §3.6 — so they're not built here, just passed
// through by the caller (buildSoloSetup below).
// ---------------------------------------------------------------------------

export type SoloDifficulty = 'easy' | 'normal' | 'hard'

// §3.7: "discard 20 toon cards from the toon deck at setup (17 easy / 20
// normal / 23 hard)".
const SOLO_TOON_TRIM_BY_DIFFICULTY: Record<SoloDifficulty, number> = {
  easy: 17,
  normal: 20,
  hard: 23,
}

// §3.7, verbatim: "1 dragonfly, 1 bee, 1 snail, and 3 caterpillars (instead
// of 2 as in the multiplayer game)" — the 3rd caterpillar replaces the
// Skunk. CONFIRMED against the rulebook quote.
export function buildSeason1SoloStartingDeck(): CardId[] {
  return ['dragonfly', 'bee', 'snail', 'caterpillar', 'caterpillar', 'caterpillar']
}

// UNCONFIRMED — pattern-matched, not quoted anywhere. §3.7's quote is
// Season 1 only; §7 item 9 confirms the combined-season solo variant's
// discard tiers (67/70/73) without ever stating Season 2's starting-deck
// composition. The inference: Season 1's swap removes the least-fame card
// (Skunk) and adds a 3rd copy of the doubled fame-0 card (Caterpillar,
// copies: 2 in the multiplayer deck). Season 2's least-fame card is the
// Firefly (§3.4's correction — NOT the Ladybug), and Season 2's doubled
// fame-0 card is the Mosquito (copies: 2, same role Caterpillar plays in
// Season 1 — see cards/season2.ts). Mirroring the pattern: Firefly out,
// 3rd Mosquito in. This is the BEST AVAILABLE reading, not a confirmed
// rule — flagged here and in the task report rather than asserted as fact.
export function buildSeason2SoloStartingDeck(): CardId[] {
  return ['grasshopper', 'ladybug', 'spider', 'mosquito', 'mosquito', 'mosquito']
}

// §3.7: "The Pig is removed from the shared toon deck" — confirmed for
// Season 1 only. NOTHING in the transcribed rulebook/FAQ establishes a
// Season 2 analogue (no card is called out the way the Pig is), so this is
// deliberately left as an explicit "unknown" rather than guessing at a
// Pig-shaped Season 2 card. `excludeFromSoloToonDeck` is season-parameterized
// for exactly this reason: Season 1 gets ['pig'], Season 2 gets [] until a
// real source says otherwise.
const SOLO_TOON_DECK_EXCLUSIONS: Record<1 | 2, CardId[]> = {
  1: ['pig'],
  2: [], // UNCONFIRMED as "genuinely none" vs. "not yet found" — see comment above
}

// All of one season's MARKET cards (rank > 0 — rank-0 cards are
// starting-deck-only and never appear in the shared toon deck at all,
// regardless of season or solo/multiplayer), minus that season's solo
// exclusions, expanded by `copies`, in card-table order (shuffled by the
// caller before use — see buildSoloSetup).
export function buildSoloToonDeckUnshuffled(season: 1 | 2): CardId[] {
  const seasonCards = season === 1 ? season1Cards : season2Cards
  const excluded = new Set(SOLO_TOON_DECK_EXCLUSIONS[season])
  const marketCards = seasonCards.filter((c) => c.rank > 0 && !excluded.has(c.id))
  const deck: CardId[] = []
  for (const card of marketCards) {
    for (let i = 0; i < card.copies; i++) deck.push(card.id)
  }
  return deck
}

export type SoloSetup = {
  startingDeck: CardId[]
  toonDeck: CardId[] // shuffled and trimmed for difficulty — ready to hand to state.ts's createSoloGameState
  prices: number[] // §3.6: solo uses the 1-4 player row, 5 slots
  fameToTriggerEndgame: number // §3.7: 30, same knob as multiplayer (§3.0)
  seed: number
}

// Builds a complete solo Setup (§4.6/§3.7) for one season. The toon deck is
// shuffled once here (from `seed`) and then trimmed to size — discarding
// the LAST `trim` cards of an already-random shuffle is equivalent to a
// random discard, and keeps this whole function a pure, deterministic
// function of `seed`. The GameState created from this (state.ts's
// createSoloGameState) carries its OWN independent RngState for in-game
// shuffles (Flip phases) going forward — this setup-time shuffle is a
// one-off, not shared with that RngState.
export function buildSoloSetup(
  seed: number,
  season: 1 | 2 = 1,
  difficulty: SoloDifficulty = 'normal',
): SoloSetup {
  const rng = makeRng(seed)
  const shuffledToonDeck = shuffle(buildSoloToonDeckUnshuffled(season), rng)
  const trim = SOLO_TOON_TRIM_BY_DIFFICULTY[difficulty]
  const toonDeck = shuffledToonDeck.slice(0, Math.max(0, shuffledToonDeck.length - trim))

  return {
    startingDeck: season === 1 ? buildSeason1SoloStartingDeck() : buildSeason2SoloStartingDeck(),
    toonDeck,
    prices: [3, 4, 7, 10, 15],
    fameToTriggerEndgame: 30,
    seed,
  }
}
