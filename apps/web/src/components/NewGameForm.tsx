import { useState } from 'react'
import type { SoloDifficulty } from '../../../../packages/engine/setup'

export type NewGameFormProps = {
  onStart: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
  onHostOnline: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
  onRejoin: (roomCode: string) => void
  remoteError: string | null
}

type Step =
  | { kind: 'pick' }
  | { kind: 'configure'; season: 1 | 2; hostOnline: boolean }
  | { kind: 'join' }

const DIFFICULTIES: SoloDifficulty[] = ['easy', 'normal', 'hard']

function resolveSeed(seed: string): number {
  const parsed = Number(seed)
  return Number.isFinite(parsed) ? parsed : Date.now() >>> 0
}

export function NewGameForm({ onStart, onHostOnline, onRejoin, remoteError }: NewGameFormProps) {
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [seed, setSeed] = useState(() => String(Date.now() >>> 0))
  const [rejoinCode, setRejoinCode] = useState('')

  if (step.kind === 'pick') {
    return (
      <div className="mode-picker">
        <h1>FlipToons</h1>
        <div className="mode-picker__grid">
          <button
            type="button"
            className="mode-card mode-card--solo"
            onClick={() => setStep({ kind: 'configure', season: 1, hostOnline: false })}
          >
            <span className="mode-card__icon">🎲</span>
            <span className="mode-card__label">Solo · Season 1</span>
            <span className="mode-card__subtitle">Play against the clock</span>
          </button>

          <button
            type="button"
            className="mode-card mode-card--solo"
            onClick={() => setStep({ kind: 'configure', season: 2, hostOnline: false })}
          >
            <span className="mode-card__icon">🎲</span>
            <span className="mode-card__label">Solo · Season 2</span>
            <span className="mode-card__subtitle">Play against the clock</span>
          </button>

          <button
            type="button"
            className="mode-card mode-card--host"
            onClick={() => setStep({ kind: 'configure', season: 1, hostOnline: true })}
          >
            <span className="mode-card__icon">🌐</span>
            <span className="mode-card__label">Host · Season 1</span>
            <span className="mode-card__subtitle">Invite others to a room</span>
          </button>

          <button
            type="button"
            className="mode-card mode-card--host"
            onClick={() => setStep({ kind: 'configure', season: 2, hostOnline: true })}
          >
            <span className="mode-card__icon">🌐</span>
            <span className="mode-card__label">Host · Season 2</span>
            <span className="mode-card__subtitle">Invite others to a room</span>
          </button>

          <button
            type="button"
            className="mode-card mode-card--join"
            onClick={() => setStep({ kind: 'join' })}
          >
            <span className="mode-card__icon">🔑</span>
            <span className="mode-card__label">Join a Game</span>
            <span className="mode-card__subtitle">Enter a room code</span>
          </button>
        </div>
      </div>
    )
  }

  if (step.kind === 'join') {
    return (
      <div className="config-panel">
        <button type="button" className="config-panel__back" onClick={() => setStep({ kind: 'pick' })}>
          ← Back
        </button>
        <h1>Join a Game</h1>

        <label className="config-panel__room-code">
          Room code
          <input
            type="text"
            value={rejoinCode}
            onChange={(e) => setRejoinCode(e.target.value.toUpperCase())}
            placeholder="ABCDE"
            maxLength={5}
          />
        </label>

        <button
          type="button"
          className="config-panel__confirm"
          disabled={!rejoinCode}
          onClick={() => onRejoin(rejoinCode)}
        >
          Join
        </button>

        {remoteError && <p className="form-warning">{remoteError}</p>}
      </div>
    )
  }

  const { season, hostOnline } = step

  return (
    <div className="config-panel">
      <button type="button" className="config-panel__back" onClick={() => setStep({ kind: 'pick' })}>
        ← Back
      </button>
      <h1>
        {hostOnline ? 'Host' : 'Solo'} · Season {season}
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
          const resolvedSeed = resolveSeed(seed)
          if (hostOnline) onHostOnline(resolvedSeed, difficulty, season)
          else onStart(resolvedSeed, difficulty, season)
        }}
      >
        {hostOnline ? 'Host Game' : 'Start Game'}
      </button>

      {remoteError && <p className="form-warning">{remoteError}</p>}

      <label className="config-panel__seed">
        Seed
        <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>
    </div>
  )
}
