import { useState } from 'react'
import type { SoloDifficulty } from '../../../../packages/engine/setup'

export type NewGameFormProps = {
  onStart: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
  onHostOnline: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
  onRejoin: (roomCode: string) => void
  remoteError: string | null
}

export function NewGameForm({ onStart, onHostOnline, onRejoin, remoteError }: NewGameFormProps) {
  const [seed, setSeed] = useState(() => String(Date.now() >>> 0))
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [season, setSeason] = useState<1 | 2>(1)
  const [hostOnline, setHostOnline] = useState(false)
  const [rejoinCode, setRejoinCode] = useState('')

  return (
    <form
      className="new-game-form"
      onSubmit={(e) => {
        e.preventDefault()
        const parsedSeed = Number(seed)
        const resolvedSeed = Number.isFinite(parsedSeed) ? parsedSeed : Date.now() >>> 0
        if (hostOnline) onHostOnline(resolvedSeed, difficulty, season)
        else onStart(resolvedSeed, difficulty, season)
      }}
    >
      <h1>FlipToons — Solo</h1>

      <label>
        Seed
        <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>

      <label>
        Difficulty
        <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as SoloDifficulty)}>
          <option value="easy">Easy</option>
          <option value="normal">Normal</option>
          <option value="hard">Hard</option>
        </select>
      </label>

      <label>
        Season
        <select value={season} onChange={(e) => setSeason(Number(e.target.value) as 1 | 2)}>
          <option value={1}>Season 1</option>
          <option value={2}>Season 2</option>
        </select>
      </label>

<label className="new-game-form__host-online">
        <input type="checkbox" checked={hostOnline} onChange={(e) => setHostOnline(e.target.checked)} />
        Host online (server-hosted, survives a reload — connects to ws://localhost:8787)
      </label>

      <button type="submit">{hostOnline ? 'Host game' : 'Start game'}</button>

      <div className="new-game-form__rejoin">
        <label>
          Rejoin room code
          <input type="text" value={rejoinCode} onChange={(e) => setRejoinCode(e.target.value.toUpperCase())} placeholder="ABCDE" />
        </label>
        <button type="button" disabled={!rejoinCode} onClick={() => onRejoin(rejoinCode)}>
          Rejoin
        </button>
      </div>

      {remoteError && <p className="new-game-form__warning">{remoteError}</p>}
    </form>
  )
}
