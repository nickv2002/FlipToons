import type { SoloDifficulty } from '../../../../packages/engine/setup'
import type { MatchDifficulty } from '../../../../packages/engine/ai'
import type { ResetEffect } from '../../../../packages/engine/state'
import type { Season } from '../../../../packages/engine/cards/types'
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
  onStartSolo: (seed: number, difficulty: SoloDifficulty, season: Season, bigButton: ResetEffect | null) => void
  onHost: (opts: { name: string; season: Season; seed?: number; fameToTriggerEndgame?: number; bigButton?: ResetEffect; bots?: MatchDifficulty[] }) => void
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
          <span className="mode-card__subtitle">Invite others, or add bots</span>
        </button>

        <button type="button" className="mode-card mode-card--join" data-testid="mode-join" onClick={() => onPick('join')}>
          <span className="mode-card__icon">🔑</span>
          <span className="mode-card__label">Join a Game</span>
          <span className="mode-card__subtitle">Enter a room code</span>
        </button>
      </div>

      <div className="game-links">
        <div className="game-links__season">
          <h2>Season 1</h2>
          <a href="https://thunderworksgames.com/products/fliptoons-game" target="_blank" rel="noreferrer">
            Buy the game
          </a>
          <a href="https://www.youtube.com/watch?v=BP-DW0KpinA" target="_blank" rel="noreferrer">
            How to Play video
          </a>
          <a href="https://cdn.shopify.com/s/files/1/0525/7753/4134/files/FT_Rulebook_10_reduced.pdf" target="_blank" rel="noreferrer">
            Rules PDF
          </a>
        </div>

        <div className="game-links__season">
          <h2>Season 2</h2>
          <a href="https://thunderworksgames.com/products/fliptoons-season-2-game" target="_blank" rel="noreferrer">
            Buy the game
          </a>
          <a href="https://www.youtube.com/watch?v=04qv_ghSCAY" target="_blank" rel="noreferrer">
            How to Play video
          </a>
          <a href="https://cdn.shopify.com/s/files/1/0525/7753/4134/files/FlipToons2_Rulebook_18.pdf" target="_blank" rel="noreferrer">
            Rules PDF
          </a>
        </div>
      </div>

      <div className="game-links__footer">
        <a href="https://github.com/nickv2002/FlipToons" target="_blank" rel="noreferrer" className="github-link">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span>View on GitHub</span>
        </a>
      </div>
    </div>
  )
}
