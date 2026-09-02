import { useState } from 'react'
import type { Season } from '../../../../packages/engine/cards/types'
import type { SoloDifficulty } from '../../../../packages/engine/setup'
import type { ConnectionState } from '../useMatch'
import { loadSettings, saveSettings } from '../settings'
import { OptionCards } from './OptionCards'

export type VsAiStartProps = {
  onStart: (opts: { name: string; season: Season; difficulty: SoloDifficulty; seed?: number; fameToTriggerEndgame?: number }) => void
  onBack: () => void
  connection: ConnectionState
}

// vs AI is a real 2-seat room (a permanent bot seat, see
// apps/worker/room.ts), not solo — but the player never sees a room code or
// a waiting room for it: there's nobody else to wait for. App auto-starts
// the moment this room's lobby comes back, so this panel is the only step
// between picking a season/difficulty and the board.
export function VsAiStart({ onStart, onBack, connection }: VsAiStartProps) {
  const [name, setName] = useState(() => loadSettings().lastName)
  const [season, setSeason] = useState<Season>(1)
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [seed, setSeed] = useState('')
  const [threshold, setThreshold] = useState('')

  const busy = connection === 'connecting' || connection === 'reconnecting'

  return (
    <div className="config-panel" data-testid="vs-ai-start">
      <button type="button" className="config-panel__back" onClick={onBack}>
        ← Back
      </button>
      <h1>vs AI</h1>

      <label className="config-panel__field">
        Your name
        <input data-testid="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      </label>

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

      <button
        type="button"
        className="config-panel__confirm"
        data-testid="start-vs-ai"
        disabled={busy || name.trim() === ''}
        onClick={() => {
          saveSettings({ lastName: name.trim() })
          onStart({
            name: name.trim(),
            season,
            difficulty,
            seed: seed.trim() === '' ? undefined : Number(seed),
            fameToTriggerEndgame: threshold.trim() === '' ? undefined : Number(threshold),
          })
        }}
      >
        Start Game
      </button>

      <label className="config-panel__seed">
        Seed
        <input data-testid="seed" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
      </label>
      <label className="config-panel__seed">
        Fame to end the game
        <input data-testid="fame-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="30" />
      </label>

      {busy && <p className="config-panel__status" data-testid="connecting">Connecting…</p>}
    </div>
  )
}
