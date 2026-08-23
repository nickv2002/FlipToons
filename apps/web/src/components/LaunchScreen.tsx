import type { SoloDifficulty } from '../../../../packages/engine/setup'
import type { ConnectionState } from '../useMatch'
import { NewGameForm } from './NewGameForm'
import { MultiplayerStart } from './MultiplayerStart'

export type LaunchStep = 'pick' | 'solo' | 'host' | 'join'

export type LaunchScreenProps = {
  // Step lives in App, not here: this component is rendered from ONE place
  // that both the solo and the multiplayer branch use. Owning the step here
  // would mean two render sites, and React would remount the panel on a
  // failed join — wiping the typed name and the error that explains it.
  step: LaunchStep
  onPick: (step: LaunchStep) => void
  onBack: () => void
  onStartSolo: (seed: number, difficulty: SoloDifficulty, season: 1 | 2) => void
  onHost: (opts: { name: string; season: 1 | 2; seed?: number; fameToTriggerEndgame?: number }) => void
  onJoin: (roomCode: string, name: string) => void
  connection: ConnectionState
  initialRoomCode?: string | null
}

export function LaunchScreen({ step, onPick, onBack, onStartSolo, onHost, onJoin, connection, initialRoomCode }: LaunchScreenProps) {
  if (step === 'solo') {
    return <NewGameForm onStart={onStartSolo} onBack={onBack} />
  }

  if (step === 'host' || step === 'join') {
    return (
      <MultiplayerStart
        variant={step}
        onHost={onHost}
        onJoin={onJoin}
        onBack={onBack}
        connection={connection}
        initialRoomCode={initialRoomCode}
      />
    )
  }

  return (
    <div className="mode-picker">
      <h1>FlipToons</h1>
      <div className="mode-picker__grid">
        <button type="button" className="mode-card mode-card--solo" data-testid="mode-solo" onClick={() => onPick('solo')}>
          <span className="mode-card__icon">🎲</span>
          <span className="mode-card__label">Solo</span>
          <span className="mode-card__subtitle">Play against the clock</span>
        </button>

        <button type="button" className="mode-card mode-card--host" data-testid="mode-host" onClick={() => onPick('host')}>
          <span className="mode-card__icon">🌐</span>
          <span className="mode-card__label">Host a table</span>
          <span className="mode-card__subtitle">Invite others to a room</span>
        </button>

        <button type="button" className="mode-card mode-card--join" data-testid="mode-join" onClick={() => onPick('join')}>
          <span className="mode-card__icon">🔑</span>
          <span className="mode-card__label">Join a Game</span>
          <span className="mode-card__subtitle">Enter a room code</span>
        </button>
      </div>
    </div>
  )
}
