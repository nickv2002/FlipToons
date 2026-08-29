import type { ReactNode } from 'react'

// One definition of "a labelled count", so a number and the control that opens
// what it counts are the same object rather than two things at opposite ends
// of the screen. Before this, "Remaining deck (7)" was a button in the round
// header while the deck it counted was inert text in the board heading below
// it, and the dismissed pile had the reverse arrangement.
//
// A chip with `onClick` renders as a <button>; without one it renders as a
// <span>. That distinction is load-bearing, not cosmetic: your own deck opens
// a list overlay, an opponent's does not (their undrawn deck isn't viewable),
// so an opponent's deck chip must not look pressable.
export type CounterChipProps = {
  label: string
  value: ReactNode
  onClick?: () => void
  title?: string
  // Draws the value in the accent/positive/warning hue. Default is neutral.
  tone?: 'neutral' | 'accent' | 'positive' | 'warning'
  testId?: string
}

export function CounterChip({ label, value, onClick, title, tone = 'neutral', testId }: CounterChipProps) {
  const className = `counter-chip counter-chip--${tone}${onClick ? ' counter-chip--button' : ''}`
  const inner = (
    <>
      <span className="counter-chip__label">{label}</span>
      <span className="counter-chip__value">{value}</span>
    </>
  )
  if (!onClick) {
    return (
      <span className={className} title={title} data-testid={testId}>
        {inner}
      </span>
    )
  }
  return (
    <button type="button" className={className} title={title} data-testid={testId} onClick={onClick}>
      {inner}
    </button>
  )
}
