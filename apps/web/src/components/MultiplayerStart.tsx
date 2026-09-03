import { useState } from 'react'
import type { ConnectionState } from '../useMatch'
import type { Season } from '../../../../packages/engine/cards/types'
import type { ResetEffect } from '../../../../packages/engine/state'
import { loadSettings, saveSettings } from '../settings'
import { sanitizePlayerName } from '../../../worker/protocol'
import { BigButtonOption } from './BigButtonOption'
import { OptionCards } from './OptionCards'

export type MultiplayerStartProps = {
  // Host and join are two panels behind two cards on the launch screen, not
  // two sections of one page. Same component so the name field, the busy
  // state and the error line stay in one place.
  variant: 'host' | 'join'
  onHost: (opts: { name: string; season: Season; seed?: number; fameToTriggerEndgame?: number; bigButton?: ResetEffect }) => void
  onJoin: (roomCode: string, name: string) => void
  onBack: () => void
  connection: ConnectionState
  // Prefilled from ?room=ABCDE so a shared link drops you straight onto the
  // join panel with the code already in it.
  initialRoomCode?: string | null
}

export function MultiplayerStart({ variant, onHost, onJoin, onBack, connection, initialRoomCode }: MultiplayerStartProps) {
  const [name, setName] = useState(() => loadSettings().lastName)
  const [season, setSeason] = useState<Season>(1)
  const [seed, setSeed] = useState('')
  const [threshold, setThreshold] = useState('')
  const [bigButton, setBigButton] = useState<ResetEffect | null>(null)
  const [roomCode, setRoomCode] = useState(initialRoomCode ?? '')

  const busy = connection === 'connecting' || connection === 'reconnecting'

  return (
    <div className="config-panel" data-testid="multiplayer-start">
      <button type="button" className="config-panel__back" onClick={onBack}>
        ← Back
      </button>
      <h1>{variant === 'host' ? 'Host a table' : 'Join a Game'}</h1>

      <label className="config-panel__field">
        Your name
        <input data-testid="name-input" value={name} onChange={(e) => setName(sanitizePlayerName(e.target.value))} placeholder="Name" />
      </label>

      {variant === 'host' ? (
        <>
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

          <BigButtonOption value={bigButton} onChange={setBigButton} />

          {/* No table size to pick: you cannot know who will click your link.
              The room opens with every seat free and is dealt for whoever is
              in the waiting room when you press start. */}
          <p className="config-panel__hint">You'll get a room code to share. Start once everyone's in — up to four players.</p>

          <button
            type="button"
            className="config-panel__confirm"
            data-testid="host-game"
            disabled={busy || name.trim() === ''}
            onClick={() => {
              saveSettings({ lastName: name.trim() })
              onHost({
                name: name.trim(),
                season,
                seed: seed.trim() === '' ? undefined : Number(seed),
                fameToTriggerEndgame: threshold.trim() === '' ? undefined : Number(threshold),
                // Undefined, not null: CreateRoomRequest's field is optional,
                // and worker.ts validates it against the legal values (1, 2,
                // 'both') before it reaches setup.ts (where it decides the
                // toon deck's composition).
                bigButton: bigButton ?? undefined,
              })
            }}
          >
            Host
          </button>

          <label className="config-panel__seed">
            Seed
            <input data-testid="seed" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
          </label>
          <label className="config-panel__seed">
            {/* 30 fame is a long game. Exposed because it's the single most
                useful playtesting knob, and it's what makes a short end-to-end
                run possible. */}
            Fame to end the game
            <input data-testid="fame-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="30" />
          </label>
        </>
      ) : (
        <>
          <label className="config-panel__room-code">
            Room code
            <input data-testid="room-code-input" value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ABCDE" maxLength={5} />
          </label>
          <button
            type="button"
            className="config-panel__confirm"
            data-testid="join-game"
            disabled={busy || name.trim() === '' || roomCode.trim().length !== 5}
            onClick={() => {
              saveSettings({ lastName: name.trim() })
              onJoin(roomCode, name.trim())
            }}
          >
            Join
          </button>
        </>
      )}

      {/* Errors are rendered once, by App, above this panel — a second copy
          here would show the same failure twice. */}
      {busy && <p className="config-panel__status" data-testid="connecting">Connecting…</p>}
    </div>
  )
}
