import { useState } from 'react'

export type TouchModeToggleProps = {
  touchMode: boolean
  onChange: (touchMode: boolean) => void
}

const EXPLANATION =
  'On: a single tap/click acts immediately — hire or dismiss right away, no confirmation. A shortcut for players who already know what the card does. Off (the default): tap a card first to see its full rules and, if you can act on it, a Hire/Dismiss button — double-tap the card itself to act immediately, skipping that view.'

// Shared by RoundView and MatchView headers. Labeled "Single-Tap Mode" in the
// UI, but the underlying setting is still `touchMode` internally and OFF
// means the safer tap-to-preview flow (settings.ts's storage key and this
// component's props/testid are unchanged) — so the checkbox is inverted:
// checked === !touchMode. Single-Tap Mode is a shortcut for experienced
// players and is not the default; touchMode defaults to true, i.e. this
// checkbox defaults unchecked.
export function TouchModeToggle({ touchMode, onChange }: TouchModeToggleProps) {
  // A `title` attribute never shows on a touch device — there's no hover to
  // trigger it. Tap-to-toggle is the version that actually works there too;
  // it just also happens to work with a mouse.
  const [showHint, setShowHint] = useState(false)

  return (
    <span className="touch-mode-toggle-wrap">
      <label className="touch-mode-toggle" data-testid="touch-mode-toggle">
        <input type="checkbox" checked={!touchMode} onChange={(e) => onChange(!e.target.checked)} />
        Single-Tap Mode
      </label>
      <button
        type="button"
        className="touch-mode-toggle__hint"
        aria-label="What does Single-Tap Mode do?"
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
