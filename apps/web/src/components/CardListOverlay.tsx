// CardId lives in cards/types, not types — the old import here pointed at a
// module that only re-uses the name locally, so `cd apps/web && tsc` had been
// failing on it (pre-existing, unrelated to multiplayer).
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
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
          <button type="button" className="card-list-overlay__close btn-pill" onClick={onClose}>
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
