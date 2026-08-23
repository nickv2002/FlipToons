import type { ReactNode } from 'react'
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Grid as GridData, GridPos } from '../../../../packages/engine/types'
import type { DismissEntry } from '../../../../packages/engine/actions'
import { Grid } from './Grid'

// One definition of "a board on this table", so your grid and everyone else's
// are drawn by the same code rather than by two layouts that drifted apart.
//
// The previous opponent rendering was a bare <Grid> in an unstyled <div> with
// a "deck 4 · dismissed 1" text run underneath, while your own board sat in a
// framed pane with a heading and a styled deck count. Same cards, two
// presentations — which read as two different kinds of thing.
export type BoardPaneProps = {
  title: ReactNode
  grid: GridData
  cards: Record<CardId, CardData>
  // Cards left undrawn in THIS board's own deck (per-player; the toon deck the
  // market refills from is shared and belongs to the market pane, not here).
  deckCount: number
  // Interactive (your board, your turn) only — see Slot.tsx.
  dismissEntries?: DismissEntry[]
  onDismiss?: (pos: GridPos, index: number) => void
  fame?: number
  readOnly?: boolean
  // Anything that belongs under the grid: an opponent's dismissed count, say.
  footer?: ReactNode
}

export function BoardPane({ title, grid, cards, deckCount, dismissEntries, onDismiss, fame, readOnly, footer }: BoardPaneProps) {
  return (
    <div className="round-view__grid-pane">
      <div className="round-view__grid-heading">
        <h2>{title}</h2>
        <span className="round-view__deck-count" title="Cards left undrawn in this player's deck">
          Deck: <strong>{deckCount}</strong> left
        </span>
      </div>
      <Grid grid={grid} cards={cards} dismissEntries={dismissEntries} onDismiss={onDismiss} fame={fame} readOnly={readOnly} />
      {footer}
    </div>
  )
}
