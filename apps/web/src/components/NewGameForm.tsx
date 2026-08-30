import { useState } from 'react'
import type { Season } from '../../../../packages/engine/cards/types'
import type { SoloDifficulty } from '../../../../packages/engine/setup'
import type { ResetEffect } from '../../../../packages/engine/state'
import { BigButtonOption } from './BigButtonOption'
import { OptionCards } from './OptionCards'

export type NewGameFormProps = {
  onStart: (seed: number, difficulty: SoloDifficulty, season: Season, bigButton: ResetEffect | null) => void
  onBack: () => void
}

function resolveSeed(seed: string): number {
  const parsed = Number(seed)
  return Number.isFinite(parsed) ? parsed : Date.now() >>> 0
}

// Solo config only. The mode picker that used to live here is now
// LaunchScreen; season, which used to be baked into the picker's cards, is a
// choice on this panel.
export function NewGameForm({ onStart, onBack }: NewGameFormProps) {
  const [season, setSeason] = useState<Season>(1)
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [bigButton, setBigButton] = useState<ResetEffect | null>(null)
  const [seed, setSeed] = useState(() => String(Date.now() >>> 0))

  return (
    <div className="config-panel">
      <button type="button" className="config-panel__back" onClick={onBack}>
        ← Back
      </button>
      <h1>Solo</h1>

      <OptionCards
        label="Season"
        value={season}
        onChange={(value) => setSeason(value as Season)}
        options={[
          { value: 1, label: 'Season 1', icon: '🍂', testId: 'season-1' },
          { value: 2, label: 'Season 2', icon: '🌊', testId: 'season-2' },
          { value: 'both', label: 'Season 1+2', icon: '🍂🌊', testId: 'season-both' },
        ]}
      />

      <OptionCards
        label="Difficulty"
        value={difficulty}
        onChange={setDifficulty}
        options={[
          { value: 'easy', label: 'Easy', icon: '🙂', testId: 'difficulty-easy' },
          { value: 'normal', label: 'Normal', icon: '😐', testId: 'difficulty-normal' },
          { value: 'hard', label: 'Hard', icon: '😤', testId: 'difficulty-hard' },
        ]}
      />

      <BigButtonOption value={bigButton} onChange={setBigButton} />

      <button
        type="button"
        className="config-panel__confirm"
        data-testid="start-solo"
        onClick={() => {
          onStart(resolveSeed(seed), difficulty, season, bigButton)
        }}
      >
        Start Game
      </button>

      <label className="config-panel__seed">
        Seed
        <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>
    </div>
  )
}
