// The one control every config screen picks with: a row of big tappable cards
// instead of a <select> or a thin segmented button. Season, difficulty and
// player count all use it, so they stay identical and thumb-sized on a phone.

export type Option<T extends string | number> = {
  value: T
  label: string
  icon?: string
  subtitle?: string
  testId?: string
}

export type OptionCardsProps<T extends string | number> = {
  label: string
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}

export function OptionCards<T extends string | number>({ label, options, value, onChange }: OptionCardsProps<T>) {
  return (
    <div className="option-field" role="group" aria-label={label}>
      <span className="option-field__label">{label}</span>
      <div className="option-grid">
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={String(option.value)}
              type="button"
              // Selection is announced, not just colored — the active card is
              // also bordered and bold, so color is never the only signal.
              aria-pressed={active}
              data-testid={option.testId}
              className={'option-card' + (active ? ' option-card--active' : '')}
              onClick={() => onChange(option.value)}
            >
              {option.icon && <span className="option-card__icon">{option.icon}</span>}
              <span className="option-card__label">{option.label}</span>
              {option.subtitle && <span className="option-card__subtitle">{option.subtitle}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
