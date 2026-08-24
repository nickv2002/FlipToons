import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { GridPos, Slot as SlotData } from '../../../../packages/engine/types'
import { TappableCard } from './TappableCard'
import type { DismissEntry } from '../../../../packages/engine/actions'
import { DEAL_STAGGER_MS } from '../dealAnimation'
import type { ZoomRequest } from './CardZoomSheet'

export type SlotProps = {
  pos: GridPos
  slot: SlotData | null
  cards: Record<CardId, CardData>
  // Present only during Market phase — lets a face-up card in this slot be
  // clicked to dismiss it; absent elsewhere so the grid is inert outside Market.
  dismissEntries?: DismissEntry[]
  onDismiss?: (pos: GridPos, index: number) => void
  // Current player fame — only used to color an unaffordable dismiss cost
  // red (see NOTE below); dismiss stays clickable either way.
  fame?: number
  // Flat position across the whole grid (extra rows above base rows), used
  // only to stagger this slot's deal-in animation.
  slotIndex?: number
  // This board is being SHOWN, not played — an opponent's grid, or your own
  // outside the Market phase. Cards render as inert <div>s rather than
  // enabled-but-inactionable buttons, and nothing is greyed: a board at rest
  // should look the same whoever it belongs to.
  readOnly?: boolean
  // See BoardPane's animateDeal.
  animateDeal?: boolean
  // See BoardPane's roundFame.
  roundFame?: (pos: GridPos, stackIndex: number) => number | undefined
  // See BoardPane's touchMode/onZoom.
  touchMode?: boolean
  onZoom?: (req: ZoomRequest) => void
}

// NOTE: dismiss cost is NOT gated on affordability the way Market.tsx gates
// hire — the badge below shows each entry's real cost (DismissEntry.cost,
// computed via phases.ts's dismissCostFor, including Ladybug-adjacency and
// Rat-in-stack discounts), and clicking one still goes through even if it's
// unaffordable, caught by actions.ts's try/catch and surfaced in the log via
// its playerFacingMessage — no client-side affordability gate here. `fame` is
// only used to color the badge red as a heads-up.
export function Slot({ pos, slot, cards, dismissEntries, onDismiss, slotIndex, fame, readOnly, animateDeal = true, roundFame, touchMode, onZoom }: SlotProps) {
  if (!slot) {
    return <div className="slot slot--empty" />
  }

  return (
    <div className="slot">
      {slot.cards.map((cardId, i) => {
        const faceUp = slot.faceUp[i]
        const card = cards[cardId]
        const dismissEntry = faceUp ? dismissEntries?.find((e) => e.pos.section === pos.section && e.pos.row === pos.row && e.pos.col === pos.col && e.stackIndex === i) : undefined
        const dismissCost = dismissEntry?.cost
        const immuneToDismiss = faceUp && card.immune?.includes('dismiss')
        const canDismiss = dismissEntry && !immuneToDismiss && onDismiss
        const dismissUnaffordable = onDismiss && dismissCost !== undefined && fame !== undefined ? fame < dismissCost : false
        // The zoom sheet never offers an action you can't afford (unlike the
        // direct/double-tap dismiss below, which — per the NOTE above — is
        // deliberately let through unaffordable so the engine's own error
        // surfaces); this only trims what the sheet's button offers.
        const canOfferDismissInSheet = canDismiss && !dismissUnaffordable
        return (
          <div className={`slot__member${i > 0 ? ' slot__member--stacked' : ''}`} key={`${i}-${cardId ?? 'empty'}`}>
            <TappableCard
              card={card}
              faceUp={faceUp}
              dismissCost={onDismiss ? dismissCost : undefined}
              dismissImmune={onDismiss ? immuneToDismiss : undefined}
              dismissUnaffordable={onDismiss && dismissCost !== undefined ? dismissUnaffordable : undefined}
              onClick={canDismiss ? () => onDismiss(pos, dismissEntry.stackIndex) : undefined}
              disabled={faceUp && onDismiss !== undefined && !dismissEntry}
              dealDelayMs={animateDeal && slotIndex !== undefined ? slotIndex * DEAL_STAGGER_MS : undefined}
              readOnly={readOnly}
              roundFame={faceUp ? roundFame?.(pos, i) : undefined}
              touchMode={touchMode}
              onZoom={onZoom}
              zoomRequest={
                canDismiss
                  ? {
                      card,
                      actionLabel: canOfferDismissInSheet ? `Dismiss — ${dismissCost} fame` : undefined,
                      onAction: canOfferDismissInSheet ? () => onDismiss(pos, dismissEntry.stackIndex) : undefined,
                    }
                  : undefined
              }
            />
          </div>
        )
      })}
    </div>
  )
}
