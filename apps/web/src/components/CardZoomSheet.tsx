import type { ReactNode } from 'react'
import type { Card as CardData } from '../../../../packages/engine/cards/types'
import { Card } from './Card'

// Touch mode's tap target: shown instead of firing hire/dismiss directly, so
// a tap can be used to read a card's full text before committing to the
// action a double-tap would fire immediately. Adapted from CardListOverlay's
// backdrop-click-to-close + stopPropagation() panel pattern.
export type ZoomRequest = {
  card: CardData
  actionLabel?: ReactNode
  onAction?: () => void
}

export type CardZoomSheetProps = ZoomRequest & {
  onClose: () => void
}

export function CardZoomSheet({ card, actionLabel, onAction, onClose }: CardZoomSheetProps) {
  return (
    <div className="card-zoom-sheet__backdrop" onClick={onClose}>
      <div className="card-zoom-sheet" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="card-zoom-sheet__close btn-pill" onClick={onClose}>
          Close
        </button>
        <Card card={card} readOnly />
        {actionLabel && onAction && (
          <button
            type="button"
            className="card-zoom-sheet__action btn-pill"
            data-testid="card-zoom-action"
            onClick={() => {
              onAction()
              onClose()
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}
