// Cheap, general per-card value signals for the heuristic (heuristic.ts).
// Pure functions of a Card's existing typed fields — nothing keyed on card
// name or id, so any future card of the same shape is handled automatically.
// Memoized by CardId, mirroring setup.ts's cardsById() memoization pattern.
import type { Card, CardId, Effect, PlaceEffect, PostMarketHook } from '../cards/types'

// Tunable weights — kept small relative to liveGridFame's dominant signal in
// heuristic.ts's scoreState (see that file's weighting comment).
const DYNAMIC_FAME_ESTIMATE = 1.5 // flat estimate for fame.base === '=' (e.g. Cow) — real but unquantifiable upside
const BONUS_UPSIDE_CREDIT = 0.5 // flat credit for having any conditional FameBonus

// RESTORED BASELINE: staticCardValue's generic per-effect-kind credit is
// deliberately ZERO here — this exactly reproduces the pre-differentiation
// formula (fame.base/DYNAMIC_FAME_ESTIMATE + BONUS_UPSIDE_CREDIT-if-bonuses
// only, no generic "has an effect" term of any kind) that measured season 1
// 82.5% / season 2 57.5% / 'both' 90.0% on the exact 40-seed benchmark
// (confirmed bit-for-bit by stashing heuristic.ts back to its pre-this-work
// state and rerunning — see heuristic.ts's history comment). A prior
// differentiation pass gave every effect-bearing card a nonzero per-kind
// credit, which reweighted every effect-bearing card in the game, including
// ones with nothing to do with the two signals this file actually wants to
// add (typeTags synergy, auto-dismiss placement/hooks) — that unrelated
// reweighting is what dragged season 1/'both' down in every sweep. So: no
// generic credit here. The only additive value below, AUTO_DISMISS_BONUS,
// is restricted to the exact Snake/Mongoose/Vulture/Alligator-shaped kinds —
// swept from 0.05 up to 3, and EVERY nonzero value strong enough to change
// even one decision made season 2 WORSE, not better (e.g. 0.2 -> season 2
// 55.0% vs baseline 57.5%), while season 1/'both' stayed pinned exactly at
// baseline throughout (these two effect kinds exist in season 1's deck too,
// so this signal was never season-2-specific). There is no safe nonzero
// value of this term that helps, so it stays at 0 — the credit machinery is
// kept so a future differently-scoped signal can reuse it. (typeTags synergy
// is a second additive signal, but it needs live deck/grid state this
// per-card-only file doesn't have — see heuristic.ts's typeTagSynergyBonus,
// which the same sweep-to-safety story applies to.)
const AUTO_DISMISS_BONUS = 0

function isAutoDismissOnPlace(effect: PlaceEffect): boolean {
  return effect.kind === 'dismissOwnDeckTopAndStackFromToonDeck' || effect.kind === 'dismissOwnDeckBottomAndDrawToonDeckTop' // Snake / Mongoose
}

function isAutoDismissPostMarketHook(hook: PostMarketHook): boolean {
  return hook.kind === 'dismissAdjacentRight' || hook.kind === 'dismissLowestRankInGrid' // Alligator / Vulture
}

// gainFame-scales-by-amount credit — a refinement the ORIGINAL baseline had
// no notion of at all (it had zero effect-credit machinery), so there is no
// "restore" for this; it is new, additive, and applies only to the
// `gainFame` kind specifically (never a generic "any effect" credit).
const GAIN_FAME_CREDIT_PER_POINT = 0.5

function gainFameCredit(effects: Effect[] | undefined): number {
  if (!effects) return 0
  let credit = 0
  for (const effect of effects) {
    if (effect.kind === 'gainFame') credit += effect.amount * GAIN_FAME_CREDIT_PER_POINT
  }
  return credit
}

function autoDismissCredit(card: Card): number {
  let credit = 0
  if (card.onPlace) {
    for (const effect of card.onPlace) if (isAutoDismissOnPlace(effect)) credit += AUTO_DISMISS_BONUS
  }
  if (card.postMarketHook && isAutoDismissPostMarketHook(card.postMarketHook)) credit += AUTO_DISMISS_BONUS
  return credit
}

function hasAnyEffect(card: Card): boolean {
  return Boolean(
    (card.onPlace && card.onPlace.length > 0) ||
      (card.onHire && card.onHire.length > 0) ||
      (card.onDismiss && card.onDismiss.length > 0) ||
      card.postFameHook ||
      card.postMarketHook,
  )
}

const staticValueCache = new Map<CardId, number>()

// A rough, static "how good is this specific card" estimate — used to value
// cards sitting in state.deck (future potential) that scoreGrid can't see
// yet, since it only scores the live grid. NOT currently summed into
// heuristic.ts's scoreState (see effectSynergyCredit below and that file's
// EFFECT_SYNERGY_WEIGHT comment) — folding a full fame-based per-card value
// into a state-level deckPotential signal, even with zero generic effect
// credit, measurably cost season 1/'both' relative to the pre-existing
// 3-signal heuristic (see heuristic.ts's history comment). Kept exported and
// tested because it's still a reasonable general "how good is this card"
// estimate other call sites may want; it's just not part of the current
// scoreState wiring.
export function staticCardValue(card: Card): number {
  const cached = staticValueCache.get(card.id)
  if (cached !== undefined) return cached

  let value = typeof card.fame.base === 'number' ? card.fame.base : DYNAMIC_FAME_ESTIMATE
  if (card.fame.bonuses && card.fame.bonuses.length > 0) value += BONUS_UPSIDE_CREDIT
  value += gainFameCredit(card.onHire)
  value += gainFameCredit(card.onDismiss)
  value += autoDismissCredit(card)

  staticValueCache.set(card.id, value)
  return value
}

// The narrow slice of the above that scoreState actually uses: ONLY the new
// additive signals (gainFame-by-amount, auto-dismiss top-up) — deliberately
// EXCLUDES fame.base/DYNAMIC_FAME_ESTIMATE/BONUS_UPSIDE_CREDIT. Those three
// are nonzero for nearly every card in the game regardless of effect shape,
// so summing them into a per-state signal reweights decisions broadly rather
// than targeting the two things this pass is actually trying to improve
// (typeTags synergy, auto-dismiss effects) — exactly the failure mode that
// dragged season 1/'both' down. A card with none of the new signals
// contributes exactly 0 here, leaving scoreState's decision for that card
// identical to the pre-existing heuristic.
export function effectSynergyCredit(card: Card): number {
  return gainFameCredit(card.onHire) + gainFameCredit(card.onDismiss) + autoDismissCredit(card)
}

const deadWeightCache = new Map<CardId, boolean>()

// Structurally worthless: zero (or near-zero) fame, no conditional bonuses,
// and no effect of any kind — exactly the Mosquito's shape today, but
// derived structurally rather than by name so any future card shaped the
// same way is caught automatically.
const FAME_EPSILON = 1e-9

export function isDeadWeight(card: Card): boolean {
  const cached = deadWeightCache.get(card.id)
  if (cached !== undefined) return cached

  const zeroFame = typeof card.fame.base === 'number' && Math.abs(card.fame.base) < FAME_EPSILON
  const noBonuses = !card.fame.bonuses || card.fame.bonuses.length === 0
  const dead = zeroFame && noBonuses && !hasAnyEffect(card)

  deadWeightCache.set(card.id, dead)
  return dead
}
