import { useState } from 'react'
import type { SoloDifficulty } from '../../../../packages/engine/setup'

export type NewGameFormProps = {
  onStart: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
}

// Same framing tui.ts prints before play starts when --season=2 is passed —
// copied verbatim rather than rewritten, per setup.ts's
// buildSeason2SoloStartingDeck comment: this is a best-available inference,
// not a confirmed rule.
const SEASON_2_UNCONFIRMED_BANNER =
  "Season 2 solo variant is an UNCONFIRMED best-available inference (see setup.ts) — playing this is how we find out if it's right."

export function NewGameForm({ onStart }: NewGameFormProps) {
  const [seed, setSeed] = useState(() => String(Date.now() >>> 0))
  const [difficulty, setDifficulty] = useState<SoloDifficulty>('normal')
  const [season, setSeason] = useState<1 | 2>(1)

  return (
    <form
      className="new-game-form"
      onSubmit={(e) => {
        e.preventDefault()
        const parsedSeed = Number(seed)
        onStart(Number.isFinite(parsedSeed) ? parsedSeed : Date.now() >>> 0, difficulty, season)
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

      {season === 2 && <p className="new-game-form__warning">{SEASON_2_UNCONFIRMED_BANNER}</p>}

      <button type="submit">Start game</button>
    </form>
  )
}
