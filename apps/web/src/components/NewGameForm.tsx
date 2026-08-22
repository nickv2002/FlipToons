import { useState } from 'react'
import type { SoloDifficulty } from '../../../../packages/engine/setup'

export type NewGameFormProps = {
  onStart: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
}

type Step =
  | { kind: 'pick' }
  | { kind: 'configure'; season: 1 | 2 }

const DIFFICULTIES: SoloDifficulty[] = ['easy', 'normal', 'hard']

function resolveSeed(seed: string): number {
  const parsed = Number(seed)
  return Number.isFinite(parsed) ? parsed : Date.now() >>> 0
}

export function NewGameForm({ onStart }: NewGameFormProps) {
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [seed, setSeed] = useState(() => String(Date.now() >>> 0))

  if (step.kind === 'pick') {
    return (
      <div className="mode-picker">
        <h1>FlipToons</h1>
        <div className="mode-picker__grid">
          <button
            type="button"
            className="mode-card mode-card--solo"
            onClick={() => setStep({ kind: 'configure', season: 1 })}
          >
            <span className="mode-card__icon">🎲</span>
            <span className="mode-card__label">Solo · Season 1</span>
            <span className="mode-card__subtitle">Play against the clock</span>
          </button>

          <button
            type="button"
            className="mode-card mode-card--solo"
            onClick={() => setStep({ kind: 'configure', season: 2 })}
          >
            <span className="mode-card__icon">🎲</span>
            <span className="mode-card__label">Solo · Season 2</span>
            <span className="mode-card__subtitle">Play against the clock</span>
          </button>



        </div>
      </div>
    )
  }

  const { season } = step

  return (
    <div className="config-panel">
      <button type="button" className="config-panel__back" onClick={() => setStep({ kind: 'pick' })}>
        ← Back
      </button>
      <h1>
        Solo · Season {season}
      </h1>

      <div className="config-panel__difficulty" role="group" aria-label="Difficulty">
        {DIFFICULTIES.map((level) => (
          <button
            key={level}
            type="button"
            className={
              'config-panel__difficulty-option' +
              (difficulty === level ? ' config-panel__difficulty-option--active' : '')
            }
            onClick={() => setDifficulty(level)}
          >
            {level[0].toUpperCase() + level.slice(1)}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="config-panel__confirm"
        onClick={() => {
          onStart(resolveSeed(seed), difficulty, season)
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
