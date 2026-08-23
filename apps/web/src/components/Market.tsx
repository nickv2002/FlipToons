import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Market as MarketData } from '../../../../packages/engine/market'
import { hireCost } from '../../../../packages/engine/market'
import { Card } from './Card'
import { DEAL_STAGGER_MS } from '../dealAnimation'

export type MarketProps = {
  market: MarketData
  cards: Record<CardId, CardData>
  fame: number
  onHire?: (slotIndex: number) => void
}

export function Market({ market, cards, fame, onHire }: MarketProps) {
  return (
    <div className="market">
      <div className="market__slots">
        {market.slots.map((cardId, i) => {
          const price = hireCost(market, i)
          const card = cardId ? cards[cardId] : undefined
          const affordable = fame >= price
          return (
            <Card
              key={`${i}-${cardId ?? 'empty'}`}
              testId={`market-slot-${i}`}
              card={card}
              price={price}
              emptyLabel={`${price} fame`}
              onClick={card && onHire ? () => onHire(i) : undefined}
              disabled={!card || !affordable}
              unaffordable={!!card && !affordable}
              compact
              dealDelayMs={card ? i * DEAL_STAGGER_MS : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}
