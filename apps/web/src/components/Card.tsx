import type { CSSProperties } from 'react'
import type { Card as CardData } from '../../../../packages/engine/cards/types'
import { cardEmoji, hasVendoredIcon, vendoredIconUrl } from '../cardIcons'

// One component reused across the grid, the market, and the dismissed-pile
// list (plan §8's "Key files" / §5's "one Card component reused across
// grid, market, and deck list"), parameterized by what each context needs
// to show rather than three near-duplicate components.
export type CardProps = {
  card?: CardData
  faceUp?: boolean // false renders a face-down back; omitted/true renders the front
  price?: number // market hire cost, shown as a badge
  dismissCost?: number // market-phase dismiss cost, shown as a badge
  // True when the card is immune to dismiss — replaces the dismissCost
  // badge's "dismiss: N fame" with an "immune to dismiss" note instead of
  // showing a cost that can never actually be paid.
  dismissImmune?: boolean
  onClick?: () => void
  disabled?: boolean
  // A stable hook for the browser tests. The market and the effect-choice
  // prompts render Cards as their only clickable controls, and picking one
  // out by its rendered text is ambiguous the moment two slots hold the same
  // card — which is normal.
  testId?: string
  // True specifically when `disabled` is because the price exceeds current
  // fame (vs. e.g. an empty slot or dismiss-immunity) — lets the price
  // badge render in --color-negative instead of just the generic dimmed
  // `:disabled` opacity, so "can't afford this" reads at a glance instead
  // of looking identical to "not interactable for some reason".
  unaffordable?: boolean
  // Same idea as `unaffordable` above but for `dismissCost` — dismiss isn't
  // gated on affordability (Slot.tsx still lets the click through so the
  // engine's try/catch surfaces the real error), so this only changes the
  // badge's color to flag "can't afford this one" at a glance.
  dismissUnaffordable?: boolean
  emptyLabel?: string // e.g. "(empty)" for a vacant market/grid slot
  // Tighter font-size/padding/line-clamping for narrow contexts (the
  // market's single-row layout) — same markup, no separate component.
  compact?: boolean
  // Toggled-on styling for a multi-select context (Horse's discard-any-
  // number-of-market-cards choice) — distinct from `disabled`, which means
  // "not interactable," not "chosen."
  selected?: boolean
  // Staggered flip-in delay (ms) for a card that just got dealt into this
  // slot. Undefined means "don't animate" — the caller only supplies this
  // when the card is new, via remount-keying (see Market.tsx/Slot.tsx).
  dealDelayMs?: number
  // Renders the front as a <div> instead of a <button>: this card is being
  // SHOWN, not offered. Distinct from `disabled`, which still renders a
  // button (an offer you can't currently take, greyed to say so).
  //
  // Opponent boards used to render every face-up card as an enabled,
  // keyboard-focusable button with no onClick — Slot.tsx computes
  // `disabled` from `onDismiss !== undefined`, which opponents never get.
  // Reaching for `disabled` instead would have been worse: it would grey
  // every opponent card, which is exactly the presentation mismatch this
  // pass exists to remove.
  readOnly?: boolean
}

const immunePhrase: Record<string, string> = {
  flip: 'cannot be flipped',
  dismiss: 'cannot be dismissed',
  return: 'cannot be returned',
}

// camelCase condition/query identifiers (e.g. 'atLeastOneFaceDownCardInGrid')
// aren't natural-language on their own — the schema keeps them as plain
// identifiers instead of duplicating rulebook text (types.ts:15). Split them
// into words so cards whose whole ability lives in `fame.bonuses`/`immune`
// (no rawBannerText/rawBodyText at all) still show *something* in the market.
function humanize(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

// rawBannerText is transcribed verbatim from the physical card's banner,
// which is typeset in all-caps on the card itself (season1.ts/season2.ts) —
// that's correct as source data, but reads as shouting in the app's body
// text. Sentence-case it for display only; rawBodyText is normal mixed-case
// already and is left untouched.
function sentenceCase(text: string): string {
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function fameBonusText(card: CardData): string[] {
  return (card.fame.bonuses ?? []).map((b) =>
    b.kind === 'ifCondition' ? `+${b.amount} fame if ${humanize(b.condition)}` : `+${b.amount} fame per ${humanize(b.query)}`,
  )
}

function CardIcon({ id }: { id: string }) {
  if (hasVendoredIcon(id)) {
    return <img className="card__icon" src={vendoredIconUrl(id)} alt="" aria-hidden="true" />
  }
  const emoji = cardEmoji[id]
  if (!emoji) return null
  return (
    <span className="card__icon" aria-hidden="true">
      {emoji}
    </span>
  )
}

export function Card({ card, faceUp = true, price, dismissCost, dismissImmune, onClick, disabled, unaffordable, dismissUnaffordable, emptyLabel, compact, selected, dealDelayMs, testId, readOnly }: CardProps) {
  const clickable = !!onClick && !disabled && !readOnly
  const dealStyle = dealDelayMs !== undefined ? ({ '--deal-delay': `${dealDelayMs}ms` } as CSSProperties) : undefined

  if (!card) {
    return (
      <div data-testid={testId} className={`card card--empty${onClick ? ' card--clickable' : ''}`} onClick={clickable ? onClick : undefined}>
        <span className="card__empty-label">{emptyLabel ?? 'empty'}</span>
      </div>
    )
  }

  if (!faceUp) {
    return (
      <div data-testid={testId} className={`card card--facedown${dealDelayMs !== undefined ? ' card--dealt' : ''}`} style={dealStyle}>
        <span className="card__facedown-mark">?</span>
      </div>
    )
  }

  const structuredText = [...fameBonusText(card), ...(card.immune ?? []).map((i) => immunePhrase[i] ?? i)]
  const bannerText = card.rawBannerText ? sentenceCase(card.rawBannerText) : undefined
  const bodyText = [bannerText, card.rawBodyText, ...structuredText].filter(Boolean).join(' — ')
  const warningText = card.unencodable
    ? `⚠ effect not simulated by the engine${card.unencodableReason ? ` (${card.unencodableReason})` : ''} — resolve it manually per the text above.`
    : null

  const className = `card card--front${clickable ? ' card--clickable' : ''}${card.unencodable ? ' card--unencodable' : ''}${compact ? ' card--compact' : ''}${selected ? ' card--selected' : ''}${dealDelayMs !== undefined ? ' card--dealt' : ''}`
  const title = compact ? [card.name, bodyText, warningText].filter(Boolean).join('\n') : undefined

  // Identical class list and children either way, so a read-only card and an
  // interactive one at rest paint the same — every .card rule is on the class,
  // none of them on button semantics.
  const body = (
    <>
      <div className="card__top">
        <span className="card__rank">rank {card.rank}</span>
        {price !== undefined && (
          <span className={`card__price${unaffordable ? ' card__price--unaffordable' : ' card__price--affordable'}`}>{price} fame</span>
        )}
        {selected && (
          <span className="card__selected-mark" aria-hidden="true">
            ✓
          </span>
        )}
      </div>
      <div className="card__name-row">
        <CardIcon id={card.id} />
        <div className="card__name">{card.name}</div>
      </div>
      <div className="card__fame">
        fame: {card.fame.base === '=' ? 'varies' : card.fame.base}
        {card.fameUnencodable ? ' (needs ruling)' : ''}
      </div>
      {dismissImmune ? (
        <div className="card__dismiss-cost card__dismiss-cost--immune">immune to dismiss</div>
      ) : (
        dismissCost !== undefined && (
          <div
            className={`card__dismiss-cost${clickable ? ' card__dismiss-cost--active' : ''}${dismissUnaffordable ? ' card__dismiss-cost--unaffordable' : ''}`}
          >
            dismiss: {dismissCost} fame
          </div>
        )
      )}
      {bodyText && <div className="card__text">{bodyText}</div>}
      {warningText && <div className="card__warning">{warningText}</div>}
    </>
  )

  if (readOnly) {
    return (
      <div data-testid={testId} className={className} style={dealStyle} title={title}>
        {body}
      </div>
    )
  }

  return (
    <button type="button" data-testid={testId} className={className} onClick={onClick} disabled={disabled} style={dealStyle} title={title}>
      {body}
    </button>
  )
}
