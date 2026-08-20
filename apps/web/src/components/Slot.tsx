import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { GridPos, Slot as SlotData } from '../../../../packages/engine/types'
import { Card } from './Card'
import type { DismissEntry } from '../../../../packages/engine/actions'
import { DEAL_STAGGER_MS } from '../dealAnimation'

export type SlotProps = {
  pos: GridPos
  slot: SlotData | null
  cards: Record<CardId, CardData>
  // Present only during Market phase — lets a face-up card in this slot be
  // clicked to dismiss it; absent elsewhere so the grid is inert outside Market.
  dismissEntries?: DismissEntry[]
  onDismiss?: (pos: GridPos, index: number) => void
  // Flat position across the whole grid (extra rows above base rows), used
  // only to stagger this slot's deal-in animation.
  slotIndex?: number
}

// NOTE: dismiss cost is NOT gated on affordability the way Market.tsx gates
// hire — phases.ts's actual cost function (dismissCostFor, unexported) can
// diverge from the `card.dismissCost ?? 5` shown here (Ladybug-adjacency and
// Rat-in-stack modifiers), so a client-side affordability gate built on this
// approximation could wrongly disable a legal dismiss with no way to retry.
// The badge below is the same approximate display tui.ts itself uses; an
// actually-unaffordable dismiss is caught by actions.ts's try/catch
// and surfaced in the log, same as tui.ts's playerFacingMessage path.
export function Slot({ pos, slot, cards, dismissEntries, onDismiss, slotIndex }: SlotProps) {
  if (!slot) {
    return <div className="slot slot--empty" />
  }

  return (
    <div className="slot">
      {slot.cards.map((cardId, i) => {
        const faceUp = slot.faceUp[i]
        const card = cards[cardId]
        const dismissEntry = faceUp ? dismissEntries?.find((e) => e.pos.section === pos.section && e.pos.row === pos.row && e.pos.col === pos.col && e.stackIndex === i) : undefined
        const dismissCost = faceUp ? card.dismissCost ?? 5 : undefined
        const immuneToDismiss = faceUp && card.immune?.includes('dismiss')
        return (
          <div className={`slot__member${i > 0 ? ' slot__member--stacked' : ''}`} key={`${i}-${cardId ?? 'empty'}`}>
            <Card
              card={card}
              faceUp={faceUp}
              dismissCost={onDismiss ? dismissCost : undefined}
              onClick={dismissEntry && !immuneToDismiss && onDismiss ? () => onDismiss(pos, dismissEntry.stackIndex) : undefined}
              disabled={faceUp && onDismiss !== undefined && (immuneToDismiss || !dismissEntry)}
              dealDelayMs={slotIndex !== undefined ? slotIndex * DEAL_STAGGER_MS : undefined}
            />
            {faceUp && immuneToDismiss && <div className="slot__immune-note">immune to dismiss</div>}
          </div>
        )
      })}
    </div>
  )
}
