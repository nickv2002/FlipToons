import type { ReactNode } from 'react'
import { FamePill } from './FamePill'

// The fame race: every seat's fame THIS ROUND against the endgame threshold.
//
// There is deliberately no cumulative total. Fame is one number that is at
// once your score, your spending power and expiring (§4.2); the rules keep no
// running tally, so the only comparison worth drawing is this round against
// the trigger — which is why each bar empties again every round instead of
// filling up over the game.
//
// This replaces the five-column scoreboard. Its Deck / On board / Dismissed
// columns duplicated what every board's own heading already prints (for
// opponents too), so they moved to the boards and only the race stayed here.
export type FameRow = {
  playerId: string
  name: string
  value: number
  isMe: boolean
  criticsChoice: boolean
  // Once the endgame has triggered, the threshold has done its job and the
  // settled total (with the Critic's Choice bonus spelled out) is the useful
  // number — a bar nobody needs to fill any more is not.
  settled?: { grid: number; bonus: number; total: number } | null
}

export type FameRaceProps = {
  rows: FameRow[]
  threshold: number
  // Solo has one row and no names to disambiguate, so it drops the labels and
  // spells the comparison out in words instead.
  variant?: 'solo' | 'table'
}

export function FameRace({ rows, threshold, variant = 'table' }: FameRaceProps) {
  return (
    <section className="fame-race" data-testid="scoreboard" aria-label="Fame this round">
      <h2 className="fame-race__title">Race to {threshold}</h2>
      <div className="fame-race__rows">
        {rows.map((row) => (
          <div
            key={row.playerId}
            className={`fame-race__row${row.isMe ? ' fame-race__row--me' : ''}`}
            data-testid={`score-${row.playerId}`}
          >
            <span className="fame-race__name">
              {variant === 'solo' ? 'Fame this round' : row.name}
              {row.criticsChoice && (
                <span className="fame-race__badge" data-testid={`critics-${row.playerId}`} title="Critic's Choice: +3 during the Final Flip">
                  {' '}★
                </span>
              )}
            </span>
            <Meter row={row} threshold={threshold} variant={variant} />
          </div>
        ))}
      </div>
    </section>
  )
}

function Meter({ row, threshold, variant }: { row: FameRow; threshold: number; variant: 'solo' | 'table' }): ReactNode {
  if (row.settled) {
    return (
      <span className="fame-race__value" data-testid={`fame-${row.playerId}`}>
        {row.settled.bonus > 0 ? (
          <>
            {row.settled.grid} <span className="fame-race__modifier">+{row.settled.bonus}</span> ={' '}
            <strong>
              <FamePill value={row.settled.total} />
            </strong>
          </>
        ) : (
          <strong>
            <FamePill value={row.settled.total} />
          </strong>
        )}
      </span>
    )
  }
  return (
    <>
      <span className="fame-race__bar" title={`${row.value} of ${threshold} fame needed to trigger the endgame`}>
        <span className="fame-race__bar-fill" style={{ width: `${Math.min(100, (row.value / threshold) * 100)}%` }} />
      </span>
      <span className="fame-race__value" data-testid={`fame-${row.playerId}`}>
        <strong>
          <FamePill value={row.value} />
        </strong>
        {variant === 'solo' ? ` / ${threshold} to win` : ` / ${threshold}`}
      </span>
    </>
  )
}
