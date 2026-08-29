// The Big Button's RESET: GRID decision (bigButton.ts / the 'gridReset'
// phase).
//
// "After the Check Fame phase, starting with the first player, each player in
// clockwise order decides if they want to use their face-up Big Button card."
// So it is a two-answer prompt, both answers legal, and — unlike the Skunk's
// post-fame prompt, which is simultaneous — it is TURN-GATED: you only see the
// buttons when it is actually your turn to decide.
//
// Deliberately plain: this is the mechanics pass, and the mini-expansion's
// visual design comes later.
export type BigButtonPromptProps = {
  // Whose decision it is right now — null while you are waiting on someone
  // else, which is also the only difference between the two states.
  isMyDecision: boolean
  waitingOnName?: string
  onDecide: (use: boolean) => void
}

export function BigButtonPrompt({ isMyDecision, waitingOnName, onDecide }: BigButtonPromptProps) {
  if (!isMyDecision) {
    return (
      <div className="match__prompt" data-testid="big-button-prompt">
        <p>Waiting for {waitingOnName ?? 'the other players'} to decide on the Big Button…</p>
      </div>
    )
  }
  return (
    <div className="match__prompt" data-testid="big-button-prompt">
      <p>
        <strong>Big Button</strong> — use it to collect your grid back into your deck, shuffle, and flip again? Everyone re-scores
        afterwards, so a worse board is a real risk. One use per game.
      </p>
      <button type="button" data-testid="big-button-use" onClick={() => onDecide(true)}>
        Use it — flip again
      </button>
      <button type="button" data-testid="big-button-keep" onClick={() => onDecide(false)}>
        Keep it
      </button>
    </div>
  )
}
