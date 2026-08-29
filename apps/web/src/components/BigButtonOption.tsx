import type { ResetEffect } from '../../../../packages/engine/state'
import { OptionCards } from './OptionCards'

// The Big Button mini-expansion's one setup decision, shared by the solo and
// host config panels. Exactly ONE reset effect card is chosen at setup and
// shared by the whole table (Referance/IMG_4308.HEIC), so this is a
// three-way pick, not two toggles.
//
// 'off' rather than null because OptionCards keys on string | number. Off is
// the default, and it stays a complete no-op all the way down: with
// SharedState.resetEffect null the gridReset phase is unreachable and this
// season's Big Button toon card is not dealt at all.
export type BigButtonOptionProps = {
  value: ResetEffect | null
  onChange: (value: ResetEffect | null) => void
}

export function BigButtonOption({ value, onChange }: BigButtonOptionProps) {
  return (
    <div className="big-button-option">
      <OptionCards
        label="Big Button (mini-expansion)"
        value={value ?? 'off'}
        onChange={(next) => onChange(next === 'off' ? null : (next as ResetEffect))}
        options={[
          { value: 'off', label: 'Off', icon: '⚪', subtitle: 'Base game', testId: 'big-button-off' },
          { value: 'market', label: 'Reset Market', icon: '🔴', subtitle: 'Reshuffle the market', testId: 'big-button-market' },
          { value: 'grid', label: 'Reset Grid', icon: '🔴', subtitle: 'Re-flip your board', testId: 'big-button-grid' },
        ]}
      />
      <p className="config-panel__hint">
        One button per player, once per game — flipping it face down is the whole cost. Turning it on also adds this season's Big
        Button toon card to the deck.
      </p>
    </div>
  )
}
