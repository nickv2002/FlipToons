import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { GridPos, Slot as SlotData } from '../../../../packages/engine/types'
import { Card } from './Card'
import type { DismissEntry } from '../../../../packages/engine/actions'
import type { DismissTarget } from '../../../../packages/engine/hireChoices'
import { DEAL_STAGGER_MS } from '../dealAnimation'

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
  // Effect-choice picker mode (e.g. Butterfly's dismissByName): when set,
  // the whole grid renders instead of a filtered list, so the player picks
  // from the real board layout — only cards matching `choiceOptions` are
  // clickable/priced at `choiceCost`, every other card (face-up or not)
  // renders inert/greyed via the same Card `disabled` styling dismiss uses.
  choiceOptions?: DismissTarget[]
  choiceCost?: number
  choiceDisabled?: boolean
  onChoice?: (target: DismissTarget) => void
  // This board is being SHOWN, not played — an opponent's grid, or your own
  // outside the Market phase. Cards render as inert <div>s rather than
  // enabled-but-inactionable buttons, and nothing is greyed: a board at rest
  // should look the same whoever it belongs to.
  readOnly?: boolean
}

// NOTE: dismiss cost is NOT gated on affordability the way Market.tsx gates
// hire — the badge below shows each entry's real cost (DismissEntry.cost,
// computed via phases.ts's dismissCostFor, including Ladybug-adjacency and
// Rat-in-stack discounts), and clicking one still goes through even if it's
// unaffordable, caught by actions.ts's try/catch and surfaced in the log,
// same as tui.ts's playerFacingMessage path — no client-side affordability
// gate here. `fame` is only used to color the badge red as a heads-up.
export function Slot({ pos, slot, cards, dismissEntries, onDismiss, slotIndex, fame, choiceOptions, choiceCost, choiceDisabled, onChoice, readOnly }: SlotProps) {
  if (!slot) {
    return <div className="slot slot--empty" />
  }

  return (
    <div className="slot">
      {slot.cards.map((cardId, i) => {
        const faceUp = slot.faceUp[i]
        const card = cards[cardId]
        if (choiceOptions) {
          const target = faceUp
            ? choiceOptions.find((t) => t.pos.section === pos.section && t.pos.row === pos.row && t.pos.col === pos.col && t.index === i)
            : undefined
          return (
            <div className={`slot__member${i > 0 ? ' slot__member--stacked' : ''}`} key={`${i}-${cardId ?? 'empty'}`}>
              <Card
                card={card}
                faceUp={faceUp}
                dismissCost={target ? choiceCost : undefined}
                onClick={target && !choiceDisabled ? () => onChoice!(target) : undefined}
                disabled={faceUp && (!target || !!choiceDisabled)}
              />
            </div>
          )
        }
        const dismissEntry = faceUp ? dismissEntries?.find((e) => e.pos.section === pos.section && e.pos.row === pos.row && e.pos.col === pos.col && e.stackIndex === i) : undefined
        const dismissCost = dismissEntry?.cost
        const immuneToDismiss = faceUp && card.immune?.includes('dismiss')
        return (
          <div className={`slot__member${i > 0 ? ' slot__member--stacked' : ''}`} key={`${i}-${cardId ?? 'empty'}`}>
            <Card
              card={card}
              faceUp={faceUp}
              dismissCost={onDismiss ? dismissCost : undefined}
              dismissImmune={onDismiss ? immuneToDismiss : undefined}
              dismissUnaffordable={onDismiss && dismissCost !== undefined && fame !== undefined ? fame < dismissCost : undefined}
              onClick={dismissEntry && !immuneToDismiss && onDismiss ? () => onDismiss(pos, dismissEntry.stackIndex) : undefined}
              disabled={faceUp && onDismiss !== undefined && (immuneToDismiss || !dismissEntry)}
              dealDelayMs={slotIndex !== undefined ? slotIndex * DEAL_STAGGER_MS : undefined}
              readOnly={readOnly}
            />
          </div>
        )
      })}
    </div>
  )
}
