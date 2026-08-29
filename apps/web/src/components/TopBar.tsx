import type { ReactNode } from 'react'
import { TouchModeToggle } from './TouchModeToggle'

// The one header on the play screen, rendered by App for BOTH modes.
//
// It used to be two: MatchView printed "Round N" and a phase chip, and the
// RoundView nested inside it printed "Round N" again about eight pixels
// lower, along with its own deck button, touch toggle and Leave button. The
// duplication is why RoundView carried a `showRoundScore` prop whose only job
// was suppressing the second copy of the fame bar; with the header lifted out
// there is nothing left to suppress.
//
// `status` is the "what am I being asked to do" slot — the turn banner in
// multiplayer, nothing in solo. It is first in the rank order the play screen
// is organized around, so it sits here rather than further down the page.
export type TopBarProps = {
  round: number
  status?: ReactNode
  // The Log button. Kept next to the other utilities rather than in the page
  // body: the log is reference material, not a play control.
  onOpenLog: () => void
  logCount: number
  touchMode: boolean
  onTouchModeChange: (next: boolean) => void
  // "Abandon game" reads wrong when three other people are still playing.
  leaveLabel: string
  onLeave: () => void
}

export function TopBar({ round, status, onOpenLog, logCount, touchMode, onTouchModeChange, leaveLabel, onLeave }: TopBarProps) {
  return (
    <header className="top-bar" data-testid="top-bar">
      <span className="top-bar__round" data-testid="round">
        Round {round}
      </span>
      {status && <span className="top-bar__status">{status}</span>}
      <div className="top-bar__utilities">
        <button type="button" className="top-bar__log" data-testid="open-log" onClick={onOpenLog}>
          Log{logCount > 0 && <span className="top-bar__log-count">{logCount}</span>}
        </button>
        <TouchModeToggle touchMode={touchMode} onChange={onTouchModeChange} />
        {/* Never behind a menu and never inside the log drawer: a table whose
            active player has dropped leaves everyone else waiting with
            nothing to click, and this is their way out. */}
        <button type="button" className="top-bar__leave" onClick={onLeave}>
          {leaveLabel}
        </button>
      </div>
    </header>
  )
}
