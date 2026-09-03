import type { CSSProperties, ReactNode } from 'react'
import type { Card as CardData } from '../../../../packages/engine/cards/types'
import { cardEmoji, hasVendoredIcon, vendoredIconUrl } from '../cardIcons'
import { FamePill } from './FamePill'

// One component reused across the grid, the market, and the dismissed-pile
// list (plan §8's "Key files" / §5's "one Card component reused across
// grid, market, and deck list"), parameterized by what each context needs
// to show rather than three near-duplicate components.
export type CardProps = {
  card?: CardData
  faceUp?: boolean // false renders a face-down back; omitted/true renders the front
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
  // Same idea as the price badge's unaffordable styling (now rendered by the
  // slot wrapper, not Card) but for `dismissCost` — dismiss isn't
  // gated on affordability (Slot.tsx still lets the click through so the
  // engine's try/catch surfaces the real error), so this only changes the
  // badge's color to flag "can't afford this one" at a glance.
  dismissUnaffordable?: boolean
  emptyLabel?: ReactNode // e.g. "(empty)" for a vacant market/grid slot
  // Tighter font-size/padding/line-clamping for narrow contexts (the
  // market's single-row layout) — same markup, no separate component.
  compact?: boolean
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
  // "Fame generated this round" for THIS card — a snapshot taken at the
  // Flip→CheckFame transition, distinct from the static base-fame line
  // (card.fame.base) that's always shown. Undefined renders no badge.
  roundFame?: number
  // Suppresses the rules-text/warning lines for contexts where a card is
  // shown too small for them to be legible. Not tied to Single-Tap Mode —
  // TappableCard always shows full text now, since the modal vs. direct-
  // action choice that setting makes shouldn't also decide text visibility.
  hideText?: boolean
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

// Rooster/Hen (score.ts) encode a per-card COUNT bonus as `ifCondition` with
// a condition name that itself starts with "per" (see score.ts's comment on
// perCardRank13OrLowerIncludingSelf) — displaying that as "if per card..."
// reads as a typo, so strip the "if" for conditions already phrased as "per".
function fameBonusText(card: CardData): string[] {
  return (card.fame.bonuses ?? []).map((b) => {
    if (b.kind === 'ifCondition') {
      const words = humanize(b.condition)
      return words.startsWith('per ') ? `+${b.amount} fame ${words}` : `+${b.amount} fame if ${words}`
    }
    return `+${b.amount} fame per ${humanize(b.query)}`
  })
}

// Same bonuses as fameBonusText, but as JSX with the amount in a FamePill —
// for the visible card face, where the coin stands in for "fame" the same
// way it does everywhere else. fameBonusText stays string-only because the
// `title` tooltip (plain HTML attribute) can't hold JSX.
function fameBonusNodes(card: CardData): ReactNode[] {
  return (card.fame.bonuses ?? []).map((b, i) => {
    if (b.kind === 'ifCondition') {
      const words = humanize(b.condition)
      return (
        <span key={i}>
          +<FamePill value={b.amount} /> {words.startsWith('per ') ? words : `if ${words}`}
        </span>
      )
    }
    return (
      <span key={i}>
        +<FamePill value={b.amount} /> per {humanize(b.query)}
      </span>
    )
  })
}

// Joins a mix of plain strings and JSX nodes with a separator, the JSX
// equivalent of `.filter(Boolean).join(sep)` — used because bodyNodes mixes
// pill-bearing bonus text with plain banner/rawBodyText strings.
function joinNodes(nodes: ReactNode[], separator: string): ReactNode {
  return nodes.flatMap((n, i) => (i === 0 ? [n] : [separator, n]))
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

export function Card({ card, faceUp = true, dismissCost, dismissImmune, onClick, disabled, dismissUnaffordable, emptyLabel, compact, dealDelayMs, testId, readOnly, roundFame, hideText }: CardProps) {
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
    // No hidden-information concern: the client already holds this card's
    // real identity (face-down ids are never server-hidden), and a card is
    // only ever flipped face-down after being revealed once — so showing its
    // front dimmed leaks nothing the client doesn't already have. Omit
    // fame/dismiss badges, which don't apply while face-down.
    return (
      <div data-testid={testId} className={`card card--facedown${dealDelayMs !== undefined ? ' card--dealt' : ''}`} style={dealStyle}>
        <span className="card__facedown-tag">flipped down</span>
        <div className="card__header-row">
          <div className="card__name">{card.name}</div>
        </div>
        <div className="card__icon-row">
          <CardIcon id={card.id} />
          <span className="card__rank">rank {card.rank}</span>
        </div>
      </div>
    )
  }

  const structuredText = [...fameBonusText(card), ...(card.immune ?? []).map((i) => immunePhrase[i] ?? i)]
  const bannerText = card.rawBannerText ? sentenceCase(card.rawBannerText) : undefined
  // structuredText before rawBodyText: Donkey's rawBodyText is "If so,
  // dismiss this card after the Market phase", referring back to its fame
  // bonus condition ("+5 fame if in lower row") — the condition has to read
  // first or "if so" dangles with nothing to refer to.
  const bodyText = [bannerText, ...structuredText, card.rawBodyText].filter(Boolean).join(' — ')
  const bodyNodes = joinNodes([bannerText, ...fameBonusNodes(card), ...(card.immune ?? []).map((i) => immunePhrase[i] ?? i), card.rawBodyText].filter(Boolean), ' — ')
  const warningText = card.unencodable
    ? `⚠ effect not simulated by the engine${card.unencodableReason ? ` (${card.unencodableReason})` : ''} — resolve it manually per the text above.`
    : null

  const className = `card card--front${clickable ? ' card--clickable' : ''}${card.unencodable ? ' card--unencodable' : ''}${compact ? ' card--compact' : ''}${dealDelayMs !== undefined ? ' card--dealt' : ''}`
  const title = [card.name, bodyText, warningText].filter(Boolean).join('\n')

  // Identical class list and children either way, so a read-only card and an
  // interactive one at rest paint the same — every .card rule is on the class,
  // none of them on button semantics.
  const body = (
    <>
      <div className="card__header-row">
        <div className="card__name">{card.name}</div>
        {roundFame !== undefined && <FamePill value={roundFame} title="Fame this card generated this round" />}
      </div>
      <div className="card__icon-row">
        <CardIcon id={card.id} />
        <span className="card__rank">rank {card.rank}</span>
      </div>
      {dismissImmune ? (
        <div className="card__dismiss-cost card__dismiss-cost--immune">immune to dismiss</div>
      ) : (
        dismissCost !== undefined && (
          <div
            className={`card__dismiss-cost${clickable ? ' card__dismiss-cost--active' : ''}${dismissUnaffordable ? ' card__dismiss-cost--unaffordable' : ''}`}
          >
            dismiss: <FamePill value={dismissCost} />
          </div>
        )
      )}
      <div className="card__fame">
        Base: {card.fame.base === '=' ? 'varies' : <FamePill value={card.fame.base} />}
        {card.fameUnencodable ? ' (needs ruling)' : ''}
        {!hideText && bodyText ? <> | {bodyNodes}</> : ''}
      </div>
      {!hideText && warningText && <div className="card__warning">{warningText}</div>}
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
