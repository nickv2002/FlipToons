import type { FameBreakdown as FameBreakdownData } from '../../../../packages/engine/score'
import { FameBreakdown } from './FameBreakdown'
import { FamePill } from './FamePill'

export type GridResetRiskOther = { name: string; total: number }

export type GridResetRiskProps = {
  // This seat's own itemized score for the CURRENT grid — the thing a
  // RESET: GRID press throws away. Reusing FameBreakdown.tsx (previously
  // unimported anywhere) rather than re-deriving the itemization: the engine
  // already computed it once, at Check Fame, and it is sitting on
  // state.lastCheckFame / me.lastCheckFame at both call sites.
  breakdown: FameBreakdownData
  total: number
  // Opponents get totals only — their itemized breakdown is not this seat's
  // business to show inline, and it's already public via FameRace and the
  // resolve log's formatBreakdown, so there is nothing being hidden here.
  others?: GridResetRiskOther[]
}

// The whole point of this change (plan requirement 1): the RESET: GRID
// decision used to ask "give up your grid?" without saying what the grid was
// worth. This puts the number in front of the button that gives it up,
// headline-first — the itemization is real information but secondary, so it
// sits inside a collapsed <details> rather than competing with the headline.
export function GridResetRisk({ breakdown, total, others }: GridResetRiskProps) {
  return (
    <div className="grid-reset-risk" data-testid="grid-reset-risk">
      <p className="grid-reset-risk__headline">
        Your grid generated <strong><FamePill value={total} /></strong> this round — resetting gives that up.
      </p>
      <details className="grid-reset-risk__details">
        <summary>Show the breakdown</summary>
        <FameBreakdown breakdown={breakdown} />
      </details>
      {others && others.length > 0 && (
        <ul className="grid-reset-risk__others">
          {others.map((o) => (
            <li key={o.name}>
              {o.name}: <strong><FamePill value={o.total} /></strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
