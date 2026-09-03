import type { MatchDifficulty } from '../../../../packages/engine/ai'

export type BotDifficultySelectorProps = {
  playerId: string
  value: MatchDifficulty
  onChange: (playerId: string, difficulty: MatchDifficulty) => void
}

const OPTIONS: { value: MatchDifficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
  { value: 'extreme', label: 'Extreme' },
]

// A compact per-seat pill row, distinct from OptionCards (the big icon-card
// picker used once on the host panel) — this repeats once per bot seat
// inline next to its name, so it has to stay small.
export function BotDifficultySelector({ playerId, value, onChange }: BotDifficultySelectorProps) {
  return (
    <span className="bot-difficulty-selector" role="group" aria-label="Bot difficulty" data-testid={`bot-difficulty-${playerId}`}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={opt.value === value}
          data-testid={`bot-difficulty-${opt.value}-${playerId}`}
          className={'bot-difficulty-selector__btn' + (opt.value === value ? ' bot-difficulty-selector__btn--active' : '')}
          onClick={() => onChange(playerId, opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  )
}
