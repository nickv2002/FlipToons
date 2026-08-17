import type { Card as CardData } from '../../../../packages/engine/cards/types'

// One component reused across the grid, the market, and the dismissed-pile
// list (plan §8's "Key files" / §5's "one Card component reused across
// grid, market, and deck list"), parameterized by what each context needs
// to show rather than three near-duplicate components.
export type CardProps = {
  card?: CardData
  faceUp?: boolean // false renders a face-down back; omitted/true renders the front
  price?: number // market hire cost, shown as a badge
  dismissCost?: number // market-phase dismiss cost, shown as a badge
  onClick?: () => void
  disabled?: boolean
  emptyLabel?: string // e.g. "(empty)" for a vacant market/grid slot
}

export function Card({ card, faceUp = true, price, dismissCost, onClick, disabled, emptyLabel }: CardProps) {
  const clickable = !!onClick && !disabled

  if (!card) {
    return (
      <div className={`card card--empty${onClick ? ' card--clickable' : ''}`} onClick={clickable ? onClick : undefined}>
        <span className="card__empty-label">{emptyLabel ?? 'empty'}</span>
      </div>
    )
  }

  if (!faceUp) {
    return (
      <div className="card card--facedown">
        <span className="card__facedown-mark">?</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`card card--front${clickable ? ' card--clickable' : ''}${card.unencodable ? ' card--unencodable' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <div className="card__top">
        <span className="card__rank">rank {card.rank}</span>
        {price !== undefined && <span className="card__price">{price} fame</span>}
      </div>
      <div className="card__name">{card.name}</div>
      <div className="card__fame">
        fame: {card.fame.base === '=' ? 'varies' : card.fame.base}
        {card.fameUnencodable ? ' (needs ruling)' : ''}
      </div>
      {dismissCost !== undefined && <div className="card__dismiss-cost">dismiss: {dismissCost} fame</div>}
      {(card.rawBannerText || card.rawBodyText) && (
        <div className="card__text">
          {card.rawBannerText}
          {card.rawBannerText && card.rawBodyText ? ' — ' : ''}
          {card.rawBodyText}
        </div>
      )}
      {card.unencodable && (
        <div className="card__warning">
          ⚠ effect not simulated by the engine{card.unencodableReason ? ` (${card.unencodableReason})` : ''} — resolve it manually per the text above.
        </div>
      )}
    </button>
  )
}
