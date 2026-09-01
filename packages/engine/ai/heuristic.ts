// A cheap, non-cheating state evaluator for the Monte Carlo AI's rollout
// policy and reward fallback (core.ts's optional `heuristicScore` hook,
// soloAdapter.ts's `reward()`). "Non-cheating" means every input here is
// either a static Card field or GameState the player already sees on screen
// (grid, market, dismissed pile, remaining deck COUNT) — never shuffled
// future draw order or any other hidden state.
//
// Reuses score.ts's scoreGrid directly rather than re-deriving per-card fame
// logic: scoreGrid already generically evaluates every FameBonus/GridQuery
// kind across all 62+ cards and both seasons, which is exactly what keeps
// this general instead of hardcoding card names. The externalState inputs it
// needs (dogElsewhere, camelMarketCount, henOrRoosterInMarket,
// bigButtonFaceDown) are resolved the same way runCheckFame resolves them —
// phases.ts's dogElsewhereFromMarket/camelMarketCountFromMarket/
// henOrRoosterInMarketFromMarket, reused rather than duplicated — the only
// difference is this is evaluated mid-Market-phase against the LIVE grid,
// not the frozen post-Check-Fame snapshot, which is the whole point: it
// tells a rollout what the grid is worth *right now*, not what it was worth
// last time Check Fame ran.
import { dogElsewhereFromMarket, camelMarketCountFromMarket, henOrRoosterInMarketFromMarket, dismissCostFor } from '../phases'
import { scoreGrid } from '../score'
import { cardsById } from '../setup'
import { occupiedSlots } from '../grid'
import { effectSynergyCredit, isDeadWeight } from './cardValue'
import type { GameState } from '../state'
import type { Card } from '../cards/types'

const cards = cardsById()

// Live "what would I score if Check Fame ran right now" grid value. Solo has
// no other players, so otherGrids is always empty — same reduction the
// solo-specific resolvers in phases.ts already make.
function liveGridFame(state: GameState): number {
  const breakdown = scoreGrid(state.grid, cards, state.deck.length, {
    dogElsewhere: dogElsewhereFromMarket(state),
    dismissed: state.dismissed,
    camelMarketCount: camelMarketCountFromMarket(state),
    henOrRoosterInMarket: henOrRoosterInMarketFromMarket(state),
    bigButtonFaceDown: !state.bigButtonFaceUp,
  })
  return breakdown.total
}

// Modest additive credit for committing to a `typeTags` synergy (e.g.
// season 2's fish cards — Goldfish/Starfish/Clownfish-shaped cards querying
// `fishTypeCard`, cards/types.ts). Generic over any future typed synergy:
// keyed on the tag STRING, never a card name. Counts every same-tagged card
// visible on screen — state.deck plus the occupied grid, both information
// the player already has — and credits each deck card by how many OTHER
// same-tagged cards it already shares company with, so a 4th fish is worth
// more than the 1st, without hardcoding "fish" anywhere. Swept 0.15 -> 0.5 ->
// 1.5 on the exact 40-seed benchmark: season 1/'both' stayed pinned exactly
// at baseline (82.5%/90.0%, bit-for-bit) through all three, but season 2
// went 57.5% -> 57.5% -> 55.0% — i.e. the only magnitude that changed
// anything made season 2 WORSE (the AI starts over-valuing weak fish cards
// it should be passing on). Kept at 0.15 — the largest value confirmed to
// change zero decisions relative to the pure baseline.
const SYNERGY_CREDIT_PER_MATCH = 0.15

function typeTagSynergyBonus(state: GameState): number {
  const tagCounts = new Map<string, number>()
  const countCard = (card: Card | undefined) => {
    if (!card?.typeTags) return
    for (const tag of card.typeTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  for (const cardId of state.deck) countCard(cards[cardId])
  for (const { slot } of occupiedSlots(state.grid)) {
    for (const cardId of slot.cards) countCard(cards[cardId])
  }

  let bonus = 0
  for (const cardId of state.deck) {
    const card = cards[cardId]
    if (!card?.typeTags) continue
    for (const tag of card.typeTags) {
      const others = Math.max(0, (tagCounts.get(tag) ?? 0) - 1)
      bonus += others * SYNERGY_CREDIT_PER_MATCH
    }
  }
  return bonus
}

// Sum of cardValue.ts's NARROW effectSynergyCredit (gainFame-by-amount +
// auto-dismiss top-up only — see that function's comment for why it
// deliberately excludes fame.base/DYNAMIC_FAME_ESTIMATE/BONUS_UPSIDE_CREDIT)
// plus the typeTags synergy bonus above, over state.deck, normalized by
// threshold like the other signals. A card with none of these signals
// contributes exactly 0, which is what keeps this additive rather than a
// broad reweighting: a deck of ordinary cards scores identically to the
// pre-existing 3-signal heuristic (see EFFECT_SYNERGY_WEIGHT below).
function effectSynergySignal(state: GameState): number {
  let total = 0
  for (const cardId of state.deck) {
    const card = cards[cardId]
    if (card) total += effectSynergyCredit(card)
  }
  total += typeTagSynergyBonus(state)
  return total
}

// A single scalar, roughly in [0, ~1.1], higher is better for the AI. Four
// visible signals, weighted:
//   - liveFame: the live grid's current worth against the win threshold —
//     the dominant signal, since it directly answers "am I on track to win".
//   - spendable fame: `state.fame` is both this round's scoring input NOT
//     yet reflected in the grid (a hire just bought hasn't been flipped) and
//     the player's remaining buying power — a candidate that hoards fame
//     with nothing to show for it on the grid is worse than one that
//     converted it, so this is a smaller secondary weight, not a proxy for
//     the same thing liveFame measures.
//   - a depletion penalty mirroring soloAdapter's existing reward() docking,
//     kept here so both call sites (rollout bias and reward fallback) agree
//     on what "trending toward a loss" looks like.
//   - effect synergy (cardValue.ts's effectSynergyCredit + typeTags synergy
//     above): a SMALL, NARROWLY-SCOPED additive top-up for state.deck. This
//     file's original 3-signal formula, run on the exact 40-seed benchmark
//     (packages/engine/ai/bench.ts), reproduces season 1 82.5% / season 2
//     57.5% / 'both' 90.0% BIT FOR BIT (confirmed by stashing this file back
//     to its git-HEAD/pre-this-work state and rerunning) — that IS the
//     baseline this signal must not regress. An earlier version of this
//     signal (deckPotential, summing the FULL fame-inclusive
//     staticCardValue over state.deck, plus a dead-weight penalty over
//     structurally-worthless cards) measured worse even with its own
//     effect-credit term zeroed out, because folding a full fame-based
//     per-card value into a state-level signal reweights EVERY card's
//     decision, not just the ones this pass is trying to improve — that
//     broad reweighting is what cost season 1/'both' across every earlier
//     sweep. This replacement keeps the weight scoped to exactly the two new
//     signals (typeTags synergy, auto-dismiss effects) and carries no
//     deadWeight penalty at all. Auto-dismiss elevation
//     (cardValue.ts's AUTO_DISMISS_BONUS) is disabled (0) — every nonzero
//     magnitude tried measurably regressed season 1 without reliably
//     helping season 2, because the Alligator-shaped postMarketHook kind it
//     targets exists in season 1's deck too, so it isn't season-2-specific.
//     typeTags synergy (SYNERGY_CREDIT_PER_MATCH above) is kept at a small
//     value verified to change ZERO decisions relative to the pure 3-signal
//     baseline at this weight — every magnitude large enough to move season
//     2 at all also cost season 1 a real (non-noise, this AI is
//     deterministic per seed) game or more, so it's kept here at the largest
//     value confirmed identical to baseline.
const EFFECT_SYNERGY_WEIGHT = 0.02

// Generic PENALTY for a structurally dead-weight card (cardValue.ts's
// isDeadWeight — zero fame, no bonuses, no effect of any kind; e.g. season
// 2's Mosquito) still sitting on the live grid, sized to its LIVE dismiss
// cost right now (phases.ts's dismissCostFor, reused directly rather than
// re-derived — that function is generic over any card whose banner grants an
// adjacency discount, e.g. Ladybug's "ADJACENT CARDS COST 3 INSTEAD OF 5 TO
// DISMISS"; the id check lives entirely inside dismissCostFor itself, so
// this file stays keyed on structure, never a card name). This must be a
// penalty that SHRINKS as the live cost drops and vanishes once the card is
// actually dismissed (0 units) — a credit-for-holding shape was tried first
// and inverted the incentive: it rewarded PARKING a discount-eligible card
// next to a dead-weight one and then leaving both in place, since the credit
// disappeared the moment the dead-weight card was actually dismissed. That
// version cost season 2 real games (52.5% vs the 57.5% flat-budget baseline
// on the 40-seed bench) instead of helping. This shape is monotone the right
// way at every step: full sticker cost while undiscounted and un-dismissed,
// a smaller penalty once a live adjacency discount applies (so parking the
// discount card next to it scores as an improvement), and 0 once dismissed
// (the best outcome) — rewarding the setup AND the payoff instead of only
// the setup.
//
// MEASURED AND DISABLED: at 0.05 (season-2-only bench, 40 seeds, flat
// 150/150 budget), this monotone-correct version still measured 55.0% vs the
// confirmed true baseline of 57.5% (heuristic.ts stashed back to pre-this-
// signal HEAD, same bench invocation) — it did not clear the +/-2-game noise
// floor at this seed count, same story cardValue.ts's AUTO_DISMISS_BONUS
// documents for its own effect kind. Kept at 0 rather than deleted: the
// discount-awareness this task asked for is real (dismissCostFor's own
// adjacency logic is exercised, not re-derived) and a future differently-
// scoped version may want the same machinery.
const DEAD_WEIGHT_DISCOUNT_WEIGHT = 0

// Weight for deckConservationSignal below. Swept on the 40-seed season-2
// bench (which the signal targets, being 0 whenever lowDeckFactor is 0 —
// see that function): 0.05 -> 57.5% (no change from the 57.5% baseline),
// 0.1 -> 52.5% (worse), 0.2 -> 65.0% (the best point found), 0.25 -> 60.0%,
// 0.35 -> 57.5% (back to baseline) — non-monotone, so 0.2 was kept rather
// than assumed to be a floor on a still-improving curve. At 0.2, season 1
// and 'both' both reproduced their exact pre-signal baselines bit-for-bit
// (82.5%/33-40 and 90.0%/36-40, 90.9%/88.9% split) — this signal moves
// season 2 without perturbing either.
const DECK_CONSERVATION_WEIGHT = 0.2

function deadWeightDismissCostPenalty(state: GameState): number {
  let penalty = 0
  for (const { pos, slot } of occupiedSlots(state.grid)) {
    slot.cards.forEach((cardId, stackIndex) => {
      if (!slot.faceUp[stackIndex]) return
      const card = cards[cardId]
      if (!card || !isDeadWeight(card)) return
      penalty += dismissCostFor(state.grid, pos, stackIndex, cards)
    })
  }
  return penalty
}

// "Deck running low" detector, from public state only (state.toonDeck.length,
// state.market.slots.length — both on-screen: the remaining-draws counter
// and the visible market row). NOTE: this is `state.toonDeck` — the shared
// draw pile that market refills consume from and that
// `state.toonDeckDepleted` tracks — NOT `state.deck`, which is this round's
// already-drawn 6-card flip deck (reshuffled from the grid at every
// Cleanup) and has nothing to do with depletion; conflating the two was
// this signal's first bug (it made lowDeckFactor nonzero from turn one in
// both seasons, since a fresh game's `state.deck` is only 6 cards deep —
// caught by the season 1 bench regressing before any weight was even large
// enough to plausibly explain it). state.toonDeckDepleted
// (phases.ts/market.ts's `refillMarket` `short` flag) fires the instant a
// refill needs more cards than `state.toonDeck.length` has — i.e. the real
// trigger is toon-deck size relative to how many cards ONE refill can
// consume, not an absolute constant, so this is scaled by
// `state.market.slots.length` rather than a fixed number (keeps this
// identical across season 1/2's different market/deck sizes without ever
// branching on season). A refill in the worst case (the whole market
// bought/decayed out) needs up to `slots.length` cards, so "safe" is
// defined as at least two full refills of runway
// (LOW_DECK_MARKET_MULTIPLE = 2) still sitting in the toon deck; below
// that, the factor ramps linearly to 1 as the toon deck empties, giving the
// signal below room to bias the rollout's choice of WHICH card to
// dismiss/hire before the deck is one bad refill from `toonDeckDepleted`,
// not only once it's unavoidable.
const LOW_DECK_MARKET_MULTIPLE = 2

function lowDeckFactor(state: GameState): number {
  const marketSize = state.market.slots.length || 1
  const safeDeck = marketSize * LOW_DECK_MARKET_MULTIPLE
  if (state.toonDeck.length >= safeDeck) return 0
  return 1 - state.toonDeck.length / safeDeck
}

// Deck-conservation bias, scoped to fire ONLY once lowDeckFactor is nonzero
// (0 the rest of the game, same additive-and-narrow shape as
// effectSynergySignal/typeTagSynergyBonus above). Per the user's explicit
// direction ("prioritize dismisses/hires that don't burn draws when the
// deck is running low... rather than optimizing purely for this round's
// fame") — the lever is WHICH card gets dismissed, not whether to dismiss at
// all (every dismiss permanently shrinks the shared deck; that's the core
// rule, see CLAUDE.md, not something to avoid).
//
// dismissedComposition credits state.dismissed for holding structurally
// dead-weight cards (cardValue.ts's isDeadWeight — zero fame, no bonuses, no
// effect), so that between two rollout branches that differ only in WHICH
// card got dismissed, the one that spent its one-way trip to the dismissed
// pile on a card already worth nothing scores higher.
//
// SWEPT: a symmetric version that also penalized dismissing a
// non-dead-weight card (VALUABLE_DISMISS_PENALTY nonzero, matching
// DEAD_WEIGHT_DISMISS_CREDIT) measured WORSE than a pure credit-only
// version on the 40-seed season-2 bench (52.5%/57.5%/65.0% at penalty
// weights 0.4/0/0 respectively, same DEAD_WEIGHT_DISMISS_CREDIT/overall-
// weight otherwise) — penalizing a valuable dismissal discourages exactly
// the sacrifice a low-deck game sometimes needs to make room for a strong
// hire, which a pure "reward the good target when you do dismiss junk"
// credit doesn't. Kept at 0.
const DEAD_WEIGHT_DISMISS_CREDIT = 0.6
const VALUABLE_DISMISS_PENALTY = 0
// MEASURED AND DISABLED: a nonzero direct runway credit (tried at 0.05,
// weighted against `state.deck` — the WRONG field at the time, see below)
// unconditionally rewards ANY state with more cards left in the deck, which
// doesn't distinguish "avoided a needless deck-consuming effect" from
// "hasn't taken any action yet" — it made the easy-difficulty regression
// test in ai.test.ts blow through its 15s budget (games stalling out at
// maxSteps rather than converging), because hoarding the deck by not acting
// scores exactly as well under this term as hoarding it by choosing a
// better target. Left at 0 in favor of dismissedComposition alone, which
// only fires ON a dismiss and only rewards target SELECTION, never
// inaction.
const DECK_RUNWAY_CREDIT_PER_CARD = 0

function deckConservationSignal(state: GameState): number {
  const factor = lowDeckFactor(state)
  if (factor <= 0) return 0

  let dismissedComposition = 0
  for (const cardId of state.dismissed) {
    const card = cards[cardId]
    if (!card) continue
    dismissedComposition += isDeadWeight(card) ? DEAD_WEIGHT_DISMISS_CREDIT : -VALUABLE_DISMISS_PENALTY
  }
  const deckRunway = state.toonDeck.length * DECK_RUNWAY_CREDIT_PER_CARD

  return factor * (dismissedComposition + deckRunway)
}

export function scoreState(state: GameState): number {
  const threshold = state.fameToTriggerEndgame || 1
  const fameSignal = liveGridFame(state) / threshold
  const spendableSignal = state.fame / threshold
  const depletionPenalty = state.toonDeckDepleted ? 0.1 : 0
  const effectSynergySignalValue = (effectSynergySignal(state) / threshold) * EFFECT_SYNERGY_WEIGHT
  const deadWeightDismissCostPenaltyValue = (deadWeightDismissCostPenalty(state) / threshold) * DEAD_WEIGHT_DISCOUNT_WEIGHT
  const deckConservationSignalValue = (deckConservationSignal(state) / threshold) * DECK_CONSERVATION_WEIGHT
  return Math.max(
    0,
    0.75 * fameSignal +
      0.25 * spendableSignal -
      depletionPenalty +
      effectSynergySignalValue -
      deadWeightDismissCostPenaltyValue +
      deckConservationSignalValue,
  )
}
