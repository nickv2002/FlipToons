import type { FameBreakdown as FameBreakdownData } from '../../../../packages/engine/score'

export type FameBreakdownProps = {
  breakdown: FameBreakdownData
}

function posLabel(pos: FameBreakdownData['lines'][number]['pos']): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

// UI counterpart of score.ts's formatBreakdown — same information, itemized
// as markup instead of a padded text table (plan §5: "this is the single
// view that teaches the game").
export function FameBreakdown({ breakdown }: FameBreakdownProps) {
  return (
    <table className="fame-breakdown">
      <tbody>
        {breakdown.lines.map((line, i) => (
          <tr key={i} className={line.needsRuling ? 'fame-breakdown__row--needs-ruling' : undefined}>
            <td className="fame-breakdown__pos">{posLabel(line.pos)}</td>
            <td className="fame-breakdown__name">{line.name}</td>
            <td className="fame-breakdown__value">
              {line.needsRuling ? (
                <span>NEEDS RULING ({line.needsRulingReason})</span>
              ) : line.dualBranch ? (
                <span>{line.dualBranch.map((b) => `${b.total} (${b.label})`).join(' | ')}</span>
              ) : (
                <>
                  <span>{line.base}</span>
                  {line.bonuses.map((b, j) => (
                    <span key={j}> + {b.amount} ({b.reason})</span>
                  ))}
                  {line.bonuses.length > 0 && <strong> = {line.total}</strong>}
                  {line.copiedFrom && <span className="fame-breakdown__note"> (copied from {line.copiedFrom.name})</span>}
                </>
              )}
            </td>
          </tr>
        ))}
        <tr className="fame-breakdown__total">
          <td colSpan={2}>TOTAL</td>
          <td>{breakdown.totalBranches ? breakdown.totalBranches.map((b) => `${b.total} (${b.label})`).join(' | ') : breakdown.total}</td>
        </tr>
      </tbody>
    </table>
  )
}
