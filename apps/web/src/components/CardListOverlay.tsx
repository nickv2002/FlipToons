import type { CardId } from '../../../../packages/engine/types'
import type { Card as CardData } from '../../../../packages/engine/cards/types'
import { Card } from './Card'

export type CardListOverlayProps = {
  title: string
  cardIds: CardId[]
  cards: Record<string, CardData>
  onClose: () => void
}

export function CardListOverlay({ title, cardIds, cards, onClose }: CardListOverlayProps) {
  return (
    <div className="card-list-overlay__backdrop" onClick={onClose}>
      <div className="card-list-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="card-list-overlay__header">
          <h2>
            {title} <span className="card-list-overlay__count">({cardIds.length})</span>
          </h2>
          <button type="button" className="card-list-overlay__close" onClick={onClose}>
            Close
          </button>
        </div>
        {cardIds.length === 0 ? (
          <p className="card-list-overlay__empty">None.</p>
        ) : (
          <div className="card-list-overlay__cards">
            {cardIds.map((id, i) => (
              <Card key={`${id}-${i}`} card={cards[id]} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
