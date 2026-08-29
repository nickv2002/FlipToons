// The Big Button's RESET: GRID decision — now Final-Flip-only. A normal
// round's reset moved onto the Market phase's own turn (see ChoicePrompt /
// RoundView); the 'gridReset' phase this renders for is the sequenced walk
// bigButton.ts still reserves for the Final Flip, which has no Market phase
// of its own to hang the button off.
//
// "After the Check Fame phase, starting with the first player, each player in
// clockwise order decides if they want to use their face-up Big Button card."
// So it is a two-answer prompt, both answers legal, and — unlike the Skunk's
// post-fame prompt, which is simultaneous — it is TURN-GATED: you only see the
// buttons when it is actually your turn to decide.
//
// The sequencing is information, not ceremony: a later decider knows what
// everyone before them chose. That is what `seats` is for — the per-seat
// status line under the prompt is the only place that knowledge is visible.
import type { GridResetRiskProps } from './GridResetRisk'
import { GridResetRisk } from './GridResetRisk'

export type BigButtonSeat = {
  playerId: string
  name: string
  faceUp: boolean
  // A seat that has answered is in gridReset.asked; whether it answered YES is
  // gridReset.optedIn. The two are separate because the button does not
  // actually flip face down until every seat has answered and the resets
  // resolve together — so faceUp alone can't tell you who opted in.
  choice: 'pending' | 'use' | 'keep'
  isDeciding: boolean
  isMe: boolean
}

export type BigButtonPromptProps = {
  // Whose decision it is right now — false while you are waiting on someone
  // else, which is also the only difference between the two states.
  isMyDecision: boolean
  waitingOnName?: string
  onDecide: (use: boolean) => void
  // Solo has one seat and therefore nothing to report; omitted there.
  seats?: BigButtonSeat[]
  // Requirement 1 reaches the Final Flip walk too: the grid being judged
  // here is worth exactly as much as the one an in-round reset gives up, so
  // it gets the same GridResetRisk treatment rather than a second component.
  // Undefined only when there's nothing scored yet to show (shouldn't happen
  // by the time this decision is live, but keeps the prompt renderable).
  risk?: GridResetRiskProps
}

export function BigButtonPrompt({ isMyDecision, waitingOnName, onDecide, seats, risk }: BigButtonPromptProps) {
  return (
    <section className="big-button" data-testid="big-button-prompt">
      <h2 className="big-button__title">
        <span className="big-button__dot" aria-hidden="true" /> Big Button — Reset: Grid
      </h2>
      {isMyDecision ? (
        <>
          <p className="big-button__body">
            Collect your grid back into your deck, shuffle, and flip again. <strong>One use per game.</strong>
          </p>
          {risk && <GridResetRisk {...risk} />}
          <p className="big-button__risk">
            Everyone re-scores afterwards — a worse board is a real risk, and can cost you the endgame trigger and the Critic's Choice.
          </p>
          <div className="big-button__actions">
            <button type="button" className="big-button__use btn-pill" data-testid="big-button-use" onClick={() => onDecide(true)}>
              Use it — flip again
            </button>
            <button type="button" className="big-button__keep btn-pill" data-testid="big-button-keep" onClick={() => onDecide(false)}>
              Keep it
            </button>
          </div>
        </>
      ) : (
        <p className="big-button__body">Waiting for {waitingOnName ?? 'the other players'} to decide…</p>
      )}
      {seats && seats.length > 0 && (
        <ul className="big-button__seats" data-testid="big-button-seats">
          {seats.map((seat) => (
            <li key={seat.playerId} className={`big-button__seat${seat.isDeciding ? ' big-button__seat--deciding' : ''}`}>
              <span className="big-button__seat-name">{seat.isMe ? 'You' : seat.name}</span>
              <span className="big-button__seat-state">{seatState(seat)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// A spent button takes its holder out of the walk entirely (match.ts skips
// them), so "used" and "undecided" are genuinely different states here, not
// two shades of the same one.
function seatState(seat: BigButtonSeat): string {
  if (!seat.faceUp) return 'already used'
  if (seat.choice === 'use') return 'flipping again'
  if (seat.choice === 'keep') return 'keeping it'
  return seat.isDeciding ? 'deciding…' : 'undecided'
}
