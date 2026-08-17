import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Grid as GridData, GridPos } from '../../../../packages/engine/types'
import { Slot } from './Slot'
import type { DismissEntry } from '../../../../packages/engine/actions'

export type GridProps = {
  grid: GridData
  cards: Record<CardId, CardData>
  dismissEntries?: DismissEntry[]
  onDismiss?: (pos: GridPos, index: number) => void
}

// extraRows render ABOVE the base rows (grid.ts: "extraRows[0] sits directly
// above base row 0, extraRows[1] above extraRows[0]"), so this maps them
// top-to-bottom in reverse before the two base rows.
export function Grid({ grid, cards, dismissEntries, onDismiss }: GridProps) {
  return (
    <div className="grid">
      {[...grid.extraRows].reverse().map((row, reversedIdx) => {
        const rowIdx = grid.extraRows.length - 1 - reversedIdx
        return (
          <div className="grid__row grid__row--extra" key={`extra-${rowIdx}`}>
            {row.map((slot, col) => (
              <Slot key={col} pos={{ section: 'extra', row: rowIdx, col }} slot={slot} cards={cards} dismissEntries={dismissEntries} onDismiss={onDismiss} />
            ))}
          </div>
        )
      })}
      {grid.base.map((row, rowIdx) => (
        <div className="grid__row" key={`base-${rowIdx}`}>
          {row.map((slot, col) => (
            <Slot key={col} pos={{ section: 'base', row: rowIdx, col }} slot={slot} cards={cards} dismissEntries={dismissEntries} onDismiss={onDismiss} />
          ))}
        </div>
      ))}
    </div>
  )
}
