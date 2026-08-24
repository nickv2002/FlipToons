import { useState } from 'react'

export type TouchModeToggleProps = {
  touchMode: boolean
  onChange: (touchMode: boolean) => void
}

const EXPLANATION =
  'On: tap a card to see its full rules and, if you can act on it, a Hire/Dismiss button — double-tap the card itself to act immediately, skipping that view. Off: a single tap/click acts immediately, like before.'

// Shared by RoundView and MatchView headers. Off reverts to today's direct
// single-click hire/dismiss with no other code path change — see Slot.tsx/
// Market.tsx's `touchMode` gate. Labeled "Double-Tap mode" in the UI (the
// setting itself is still `touchMode` internally — settings.ts's storage key
// and this component's props/testid are unchanged, only the visible label
// and its explanation are new).
export function TouchModeToggle({ touchMode, onChange }: TouchModeToggleProps) {
  // A `title` attribute never shows on a touch device — there's no hover to
  // trigger it. Tap-to-toggle is the version that actually works there too;
  // it just also happens to work with a mouse.
  const [showHint, setShowHint] = useState(false)

  return (
    <span className="touch-mode-toggle-wrap">
      <label className="touch-mode-toggle" data-testid="touch-mode-toggle">
        <input type="checkbox" checked={touchMode} onChange={(e) => onChange(e.target.checked)} />
        Double-Tap mode
      </label>
      <button
        type="button"
        className="touch-mode-toggle__hint"
        aria-label="What does Double-Tap mode do?"
        aria-expanded={showHint}
        data-testid="touch-mode-hint-button"
        onClick={() => setShowHint((v) => !v)}
      >
        ⓘ
      </button>
      {showHint && (
        <span className="touch-mode-toggle__popover" data-testid="touch-mode-hint" role="tooltip">
          {EXPLANATION}
        </span>
      )}
    </span>
  )
}
