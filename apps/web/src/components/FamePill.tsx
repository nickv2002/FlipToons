import type { ReactNode } from 'react'

// The bare gold coin mark, no number attached — FamePill's building block.
function FameCoin() {
  return (
    <span className="fame-coin" aria-hidden="true">
      F
    </span>
  )
}

// A fame amount rendered as a gold coin pill, in place of the word "fame" —
// shorter and easier to pick out at a glance than "N fame" repeated across
// prices, badges, and totals. `.fame-pill`/`.fame-coin` (style.css) started
// as Card's card-specific round-fame badge (commit dc7ce9e) and were
// generalized here once other components started reusing them.
export function FamePill({ value, title }: { value: ReactNode; title?: string }) {
  return (
    <span className="fame-pill" title={title}>
      {value}
      <FameCoin />
    </span>
  )
}
