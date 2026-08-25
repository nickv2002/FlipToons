import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Market as MarketData } from '../../../../packages/engine/market'
import { hireCost } from '../../../../packages/engine/market'
import { TappableCard } from './TappableCard'
import { DEAL_STAGGER_MS } from '../dealAnimation'
import type { ZoomRequest } from './CardZoomSheet'

export type MarketProps = {
  market: MarketData
  cards: Record<CardId, CardData>
  fame: number
  onHire?: (slotIndex: number) => void
  // See BoardPane's animateDeal — same "fresh deal this round" gate, since a
  // dismiss-choice prompt resolving remounts this pane too, not just the grid.
  animateDeal?: boolean
  // See BoardPane's touchMode/onZoom.
  touchMode?: boolean
  onZoom?: (req: ZoomRequest) => void
}

export function Market({ market, cards, fame, onHire, animateDeal = true, touchMode, onZoom }: MarketProps) {
  return (
    <div className="market">
      <div className="market__slots">
        {market.slots.map((cardId, i) => {
          const price = hireCost(market, i)
          const card = cardId ? cards[cardId] : undefined
          const affordable = fame >= price
          const canHire = card && onHire && affordable
          return (
            <TappableCard
              key={`${i}-${cardId ?? 'empty'}`}
              testId={`market-slot-${i}`}
              card={card}
              price={price}
              emptyLabel={`${price} fame`}
              onClick={canHire ? () => onHire(i) : undefined}
              // The tap-to-preview flow keeps an unaffordable card tappable so its
              // detail view is still reachable — only the real hire (and the
              // non-touch-mode direct click it stands in for) stays gated on
              // affordability.
              disabled={!card || (!touchMode && !affordable)}
              unaffordable={!!card && !affordable}
              compact
              dealDelayMs={animateDeal && card ? i * DEAL_STAGGER_MS : undefined}
              touchMode={touchMode}
              onZoom={onZoom}
              zoomRequest={
                card
                  ? { card, actionLabel: canHire ? `Hire — ${price} fame` : undefined, onAction: canHire ? () => onHire(i) : undefined }
                  : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}
