import { useState } from 'react'
import type { ConnectionState } from '../useMatch'

export type MultiplayerStartProps = {
  onHost: (opts: { name: string; playerCount: number; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }) => void
  onJoin: (roomCode: string, name: string) => void
  error: string | null
  connection: ConnectionState
  // Prefilled from ?room=ABCDE so a shared link drops you straight onto the
  // join form with the code already in it.
  initialRoomCode?: string | null
}

export function MultiplayerStart({ onHost, onJoin, error, connection, initialRoomCode }: MultiplayerStartProps) {
  const [name, setName] = useState('')
  const [playerCount, setPlayerCount] = useState(2)
  const [season, setSeason] = useState<1 | 2>(1)
  const [seed, setSeed] = useState('')
  const [threshold, setThreshold] = useState('')
  const [roomCode, setRoomCode] = useState(initialRoomCode ?? '')

  const busy = connection === 'connecting' || connection === 'reconnecting'

  return (
    <div className="mp-start" data-testid="multiplayer-start">
      <h2>Play with other people</h2>

      <label className="mp-start__field">
        Your name
        <input data-testid="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      </label>

      <section className="mp-start__section">
        <h3>Host a table</h3>
        <label className="mp-start__field">
          Players
          <select data-testid="player-count" value={playerCount} onChange={(e) => setPlayerCount(Number(e.target.value))}>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="mp-start__field">
          Season
          <select data-testid="season" value={season} onChange={(e) => setSeason(Number(e.target.value) as 1 | 2)}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label className="mp-start__field">
          Seed (optional)
          <input data-testid="seed" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
        </label>
        <label className="mp-start__field">
          {/* 30 fame is a long game. Exposed because it's the single most
              useful playtesting knob, and it's what makes a short end-to-end
              run possible. */}
          Fame to end the game
          <input data-testid="fame-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="30" />
        </label>
        <button
          type="button"
          data-testid="host-game"
          disabled={busy || name.trim() === ''}
          onClick={() =>
            onHost({
              name: name.trim(),
              playerCount,
              season,
              seed: seed.trim() === '' ? undefined : Number(seed),
              fameToTriggerEndgame: threshold.trim() === '' ? undefined : Number(threshold),
            })
          }
        >
          Host
        </button>
      </section>

      <section className="mp-start__section">
        <h3>Join a table</h3>
        <label className="mp-start__field">
          Room code
          <input data-testid="room-code-input" value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ABCDE" maxLength={5} />
        </label>
        <button type="button" data-testid="join-game" disabled={busy || name.trim() === '' || roomCode.trim().length !== 5} onClick={() => onJoin(roomCode, name.trim())}>
          Join
        </button>
      </section>

      {busy && <p className="mp-start__status" data-testid="connecting">Connecting…</p>}
      {error && (
        <p className="form-warning" data-testid="mp-error">
          {error}
        </p>
      )}
    </div>
  )
}
