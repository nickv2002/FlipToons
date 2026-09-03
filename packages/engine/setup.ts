// Setup helpers: building a starting deck and a card lookup table from the
// card data (packages/engine/cards). Per §4.6, setup is the only
// season-aware module — everything else in the engine takes cards as data
// and never branches on season.

import { allCards, season1Cards, season2Cards } from './cards'
import type { Card, CardId, Season } from './cards/types'
import { makeRng, shuffle, type Rng } from './rng'
import type { ResetEffect, WinCondition } from './state'

export type { Season }

// Resolves a setup-time Season selection to a concrete season for one seat.
// `'both'` draws a single coin flip from the same rng stream setup already
// uses, so the whole setup function stays a pure function of `seed`.
// Concrete selections make zero extra rng() calls, so single-season behavior
// (and its existing test seeds) is untouched either way.
function pickStartingDeckSeason(rng: Rng, season: Season): 1 | 2 {
  if (season !== 'both') return season
  return rng() < 0.5 ? 1 : 2
}

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

// The card table, built once. `allCards` is a static import, so the answer can
// never change within a process — and this used to allocate a fresh 62-entry
// record on EVERY call, from fourteen separate call sites inside phases.ts
// alone, several of them per-placement or per-scoring.
//
// Callers must treat the result as read-only. Nothing in the repo writes to it
// (it is only ever read as `cards[id]`), and sharing one instance is what makes
// the module-scope `const cards = cardsById()` pattern the rest of the engine
// uses actually free.
let cardTable: Record<CardId, Card> | null = null

export function cardsById(): Record<CardId, Card> {
  if (cardTable) return cardTable
  const map: Record<CardId, Card> = {}
  for (const card of allCards) map[card.id] = card
  cardTable = map
  return map
}

// None of the 13 market cards this pass encoded (Eagle, Donkey, Butterfly,
// Rabbit, Horse, Snake, Elephant, Alligator, Monkey, Pig, Peacock, Cow,
// Axolotl) are starting cards — buildSeason1StartingDeck() can never
// produce them, so there's no way to flip-test any of them through that
// path. This builds a deck directly from a hand-picked list of card ids
// instead, for manual/scripted testing (see flip-effects.test.ts). Validates
// every id up front — a typo'd or
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

// §7 item 9: combined-season solo discard tiers — 67/70/73 — distinct from
// the single-season tiers above because the merged toon deck is roughly
// double the size.
const SOLO_TOON_TRIM_BY_DIFFICULTY_BOTH: Record<SoloDifficulty, number> = {
  easy: 67,
  normal: 70,
  hard: 73,
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

// ---------------------------------------------------------------------------
// The Big Button mini-expansion (Referance/IMG_4308.HEIC)
// ---------------------------------------------------------------------------
//
// Setup step 3: "Before creating the market, shuffle the platypus toon cards
// into the toon deck." So the season's Big Button card is excluded when the
// expansion is OFF and dealt when it is ON — the exclusion is a
// consequence of the expansion being absent, not a rule of its own.
//
// The photographed setup card is the SEASON 2 printing (a "2" in the corner;
// it names platypus only). Season 1's parallel is Axolotl, which the card
// table already pairs with Platypus: same rank (26), same copies (2), the
// same "flip your big button card face up" banner shape. Only the S2 photo
// exists, so the S1 half is INFERRED BY SYMMETRY — the same "best available
// reading, flagged not asserted" treatment buildSeason2SoloStartingDeck gets
// above. If a Season 1 setup card ever turns up and says otherwise, this is
// the one line to change.
export const BIG_BUTTON_CARDS: Record<1 | 2, CardId[]> = {
  1: ['axolotl'],
  2: ['platypus'],
}

// Solo play, verbatim: "When using this mini-expansion, discard two
// additional toon cards during setup."
export const SOLO_BIG_BUTTON_EXTRA_TRIM = 2

// §3.7: "The Pig is removed from the shared toon deck" — confirmed for
// Season 1 only. NOTHING in the transcribed rulebook/FAQ establishes a
// Season 2 analogue (no card is called out the way the Pig is), so this is
// deliberately left as an explicit "unknown" rather than guessing at a
// Pig-shaped Season 2 card. `excludeFromSoloToonDeck` is season-parameterized
// for exactly this reason: Season 1 gets ['pig'], Season 2 gets [] until a
// real source says otherwise.
//
// Axolotl (Season 1) and Platypus (Season 2) are excluded for a DIFFERENT
// reason, and the two must not be conflated: the Pig's removal is a
// RULEBOOK rule that holds unconditionally in solo, while those two are out
// only because the Big Button mini-expansion isn't in play. They used to be
// out permanently, as an engine-capability gap; now that bigButton.ts models
// the component, `bigButton` below puts them back whenever a reset effect is
// on the table. The Pig stays out either way.
export const SOLO_TOON_DECK_EXCLUSIONS: Record<1 | 2, CardId[]> = {
  1: ['pig', 'axolotl'],
  2: ['platypus'],
}

// The exclusions actually in force, given whether the Big Button
// mini-expansion is in play. Shared by the solo and multiplayer builders so
// there is one place that knows the Big Button card comes back.
function exclusionsFor(base: readonly CardId[], season: 1 | 2, bigButton: boolean): Set<CardId> {
  const set = new Set(base)
  if (bigButton) for (const id of BIG_BUTTON_CARDS[season]) set.delete(id)
  return set
}

// All of one season's MARKET cards (rank > 0 — rank-0 cards are
// starting-deck-only and never appear in the shared toon deck at all,
// regardless of season or solo/multiplayer), minus that season's solo
// exclusions, expanded by `copies`, in card-table order (shuffled by the
// caller before use — see buildSoloSetup).
function buildSoloToonDeckForOneSeason(season: 1 | 2, bigButton: boolean): CardId[] {
  const seasonCards = season === 1 ? season1Cards : season2Cards
  const excluded = exclusionsFor(SOLO_TOON_DECK_EXCLUSIONS[season], season, bigButton)
  const marketCards = seasonCards.filter((c) => c.rank > 0 && !excluded.has(c.id))
  const deck: CardId[] = []
  for (const card of marketCards) {
    for (let i = 0; i < card.copies; i++) deck.push(card.id)
  }
  return deck
}

// 'both' shuffles both seasons' market cards into one shared toon deck
// (§3.0: "Seasons 1 and 2 are shuffled together into one toon deck"), each
// season's own exclusions (Pig from S1 only, each season's own Big Button
// card) still applied before the union.
export function buildSoloToonDeckUnshuffled(season: Season, bigButton = false): CardId[] {
  if (season === 'both') return [...buildSoloToonDeckForOneSeason(1, bigButton), ...buildSoloToonDeckForOneSeason(2, bigButton)]
  return buildSoloToonDeckForOneSeason(season, bigButton)
}

// ---------------------------------------------------------------------------
// Multiplayer setup (§3.0, §3.6, §4.6). Distinct from the solo variant below
// in three specific ways, all of them setup-only:
//   - starting deck: the MULTIPLAYER deck (Skunk included), not solo's
//     3rd-Caterpillar swap
//   - toon deck: the Pig STAYS in (solo removes it, §3.7); no difficulty trim
//   - market width/prices key off PLAYER COUNT
// ---------------------------------------------------------------------------

// §3.6 / table row 13: market width and prices are a function of PLAYER COUNT
// ALONE — never of how many seasons are in play. A combined-season 3-player
// game still gets the 5-slot row. Kept as a table rather than an if/else so
// the 5-8 row is a data change, not a redesign, when that scope lands.
const PRICES_BY_PLAYER_COUNT: { maxPlayers: number; prices: number[] }[] = [
  { maxPlayers: 4, prices: [3, 4, 7, 10, 15] },
  { maxPlayers: 8, prices: [3, 3, 4, 7, 10, 15, 15] },
]

export function pricesForPlayerCount(playerCount: number): number[] {
  const row = PRICES_BY_PLAYER_COUNT.find((r) => playerCount <= r.maxPlayers)
  if (!row) throw new Error(`setup.ts: pricesForPlayerCount — unsupported player count ${playerCount}`)
  return row.prices.slice()
}

// §3.1/§4.5, verbatim: "2x Caterpillar, 1x Skunk, 1x Dragonfly, 1x Bee,
// 1x Snail" — the six rank-0 Season 1 cards expanded by `copies`. This is
// exactly buildSeason1StartingDeck above; named separately so the
// multiplayer call site reads intentionally and so a future divergence
// doesn't silently change the sandbox helper too.
export function buildSeason1MultiplayerStartingDeck(): CardId[] {
  return buildSeason1StartingDeck()
}

// Season 2's equivalent: its six rank-0 cards expanded by `copies`. Unlike
// buildSeason2SoloStartingDeck (which infers a Firefly-out/3rd-Mosquito-in
// swap by pattern-matching Season 1's solo rule), this needs no inference —
// it's just "that season's starting deck", the same rank-0 filter Season 1
// uses.
export function buildSeason2MultiplayerStartingDeck(): CardId[] {
  const starters = season2Cards.filter((c) => c.rank === 0)
  const deck: CardId[] = []
  for (const card of starters) {
    for (let i = 0; i < card.copies; i++) deck.push(card.id)
  }
  return deck
}

// The full market-card pool for one season, expanded by `copies`. No solo
// exclusions: the Pig stays in (its removal is explicitly a solo-setup rule,
// §3.7), and so does the season's Big-Button card — see
// MULTIPLAYER_TOON_DECK_EXCLUSIONS.
//
// Axolotl (S1) and Platypus (S2) are excluded ONLY when the Big Button
// mini-expansion is off — see SOLO_TOON_DECK_EXCLUSIONS. That condition is
// player-count-independent, so it reads the same here. This is NOT the same
// kind of exclusion as the Pig's, which is rulebook-mandated and solo-only.
export const MULTIPLAYER_TOON_DECK_EXCLUSIONS: Record<1 | 2, CardId[]> = {
  1: ['axolotl'],
  2: ['platypus'],
}

function buildMultiplayerToonDeckForOneSeason(season: 1 | 2, bigButton: boolean): CardId[] {
  const seasonCards = season === 1 ? season1Cards : season2Cards
  const excluded = exclusionsFor(MULTIPLAYER_TOON_DECK_EXCLUSIONS[season], season, bigButton)
  const marketCards = seasonCards.filter((c) => c.rank > 0 && !excluded.has(c.id))
  const deck: CardId[] = []
  for (const card of marketCards) {
    for (let i = 0; i < card.copies; i++) deck.push(card.id)
  }
  return deck
}

export function buildMultiplayerToonDeckUnshuffled(season: Season, bigButton = false): CardId[] {
  if (season === 'both') return [...buildMultiplayerToonDeckForOneSeason(1, bigButton), ...buildMultiplayerToonDeckForOneSeason(2, bigButton)]
  return buildMultiplayerToonDeckForOneSeason(season, bigButton)
}

export type MultiplayerSetup = {
  startingDecks: CardId[][] // one per seat, in seat order
  toonDeck: CardId[] // shuffled; NO difficulty trim (that's solo-only, §3.7)
  prices: number[]
  fameToTriggerEndgame: number // 30 at every player count (§3.0)
  seed: number
  playerSeeds: number[] // one per seat — see state.ts's makeMatch on per-player RNG
  // Round 1's first mover, randomized — an index into turnOrder (which is
  // always seat/join order, p0..p{n-1}), not a seat reassignment. Reuses the
  // existing round-to-round rotation mechanism (match.ts bumps
  // firstPlayerIndex by 1 mod seat count each Cleanup); this only randomizes
  // where that rotation starts. See makeMatch/buildNewMatch.
  firstPlayerIndex: number
  // Multiplayer reads a failed market refill as an ordinary ending that
  // proceeds to the Final Flip, not as solo's loss — see SharedState.winCondition.
  winCondition: WinCondition
  // Big Button: which reset effect card is on the table, or null for "the
  // mini-expansion is not in play" (the default). Also decides whether this
  // season's Big Button toon card is in `toonDeck` at all.
  resetEffect: ResetEffect | null
}

// §3.0: "The endgame threshold does not scale with player count — it is 30
// fame whether you're playing 2 or 8." Kept as a Setup field, not a constant,
// because it's the single most useful playtesting knob.
export const DEFAULT_FAME_TO_TRIGGER_ENDGAME = 30

// Assigns each seat a concrete starting-deck season for 'both' mode, capped
// at 4 seats per season (§3.0 — a physical-component limit; playerCount is
// itself capped at 4 today, so the cap can't yet bind, but is enforced here
// for correctness ahead of any future player-count increase). A season whose
// count has hit the cap is skipped in favor of the other.
function assignStartingDeckSeasons(rng: Rng, playerCount: number, season: Season): (1 | 2)[] {
  if (season !== 'both') return Array.from({ length: playerCount }, () => season)
  const MAX_PER_SEASON = 4
  const counts: Record<1 | 2, number> = { 1: 0, 2: 0 }
  return Array.from({ length: playerCount }, () => {
    let picked = pickStartingDeckSeason(rng, 'both')
    if (counts[picked] >= MAX_PER_SEASON) picked = picked === 1 ? 2 : 1
    counts[picked]++
    return picked
  })
}

function startingDeckForSeason(season: 1 | 2): CardId[] {
  return season === 1 ? buildSeason1MultiplayerStartingDeck() : buildSeason2MultiplayerStartingDeck()
}

export function buildMultiplayerSetup(
  seed: number,
  playerCount: number,
  season: Season = 1,
  options: { bigButton?: ResetEffect | null } = {},
): MultiplayerSetup {
  const resetEffect = options.bigButton ?? null
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 4) {
    throw new Error(`setup.ts: buildMultiplayerSetup — playerCount must be an integer 2-4 (got ${playerCount}); 5-8 player support is not built yet`)
  }
  const rng = makeRng(seed)
  // Seat season assignment is drawn before the toon-deck shuffle so this stays
  // a fixed, documented rng sequence — a pure function of `seed`. Concrete
  // seasons draw nothing extra, so single-season shuffles are unaffected.
  const seatSeasons = assignStartingDeckSeasons(rng, playerCount, season)
  const toonDeck = shuffle(buildMultiplayerToonDeckUnshuffled(season, resetEffect !== null), rng)
  // Drawn last off the same stream, after the seasons and toon deck, so the
  // randomized starting player stays a pure function of `seed` too.
  const firstPlayerIndex = Math.floor(rng() * playerCount)

  return {
    // Combined-season play: each seat independently gets a whole Season 1 or
    // Season 2 starting deck (never mixed), capped at 4 seats per season —
    // see assignStartingDeckSeasons.
    startingDecks: seatSeasons.map((s) => startingDeckForSeason(s)),
    toonDeck,
    prices: pricesForPlayerCount(playerCount),
    fameToTriggerEndgame: DEFAULT_FAME_TO_TRIGGER_ENDGAME,
    winCondition: 'highestFinalFlip',
    resetEffect,
    seed,
    // Derived from the match seed so the whole match stays a pure function of
    // it, but distinct per seat so no two players share a shuffle stream.
    playerSeeds: Array.from({ length: playerCount }, (_, i) => seed + i * 0x9e3779b1),
    firstPlayerIndex,
  }
}

export type SoloSetup = {
  startingDeck: CardId[]
  toonDeck: CardId[] // shuffled and trimmed for difficulty — ready to hand to state.ts's createSoloGameState
  prices: number[] // §3.6: solo uses the 1-4 player row, 5 slots
  fameToTriggerEndgame: number // §3.7: 30, same knob as multiplayer (§3.0)
  seed: number
  // Big Button — see MultiplayerSetup.resetEffect.
  resetEffect: ResetEffect | null
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
  season: Season = 1,
  difficulty: SoloDifficulty = 'normal',
  options: { bigButton?: ResetEffect | null } = {},
): SoloSetup {
  const resetEffect = options.bigButton ?? null
  const rng = makeRng(seed)
  // Solo has exactly one seat, so 'both' draws one coin flip for its starting
  // deck season — before the toon-deck shuffle, so setup stays a pure
  // function of `seed`. Concrete seasons draw nothing extra.
  const startingDeckSeason = pickStartingDeckSeason(rng, season)
  const shuffledToonDeck = shuffle(buildSoloToonDeckUnshuffled(season, resetEffect !== null), rng)
  // "When using this mini-expansion, discard two additional toon cards during
  // setup." Applied to the difficulty trim rather than as a separate step —
  // the trim is already "discard N from an already-random shuffle", so N+2 is
  // literally the same operation.
  const trimTable = season === 'both' ? SOLO_TOON_TRIM_BY_DIFFICULTY_BOTH : SOLO_TOON_TRIM_BY_DIFFICULTY
  const trim = trimTable[difficulty] + (resetEffect !== null ? SOLO_BIG_BUTTON_EXTRA_TRIM : 0)
  const toonDeck = shuffledToonDeck.slice(0, Math.max(0, shuffledToonDeck.length - trim))

  return {
    startingDeck: startingDeckSeason === 1 ? buildSeason1SoloStartingDeck() : buildSeason2SoloStartingDeck(),
    toonDeck,
    prices: [3, 4, 7, 10, 15],
    fameToTriggerEndgame: 30,
    resetEffect,
    seed,
  }
}
