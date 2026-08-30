import { useState } from 'react'
import type { LobbyState } from '../../../worker/protocol'
import type { ConnectionState } from '../useMatch'

export type LobbyProps = {
  lobby: LobbyState
  myPlayerId: string | null
  connection: ConnectionState
  onStart: () => void
  onLeave: () => void
}

// The waiting room. Its whole job is answering "am I actually in, and who else
// is here" before the game starts — the previous room-code flow dropped you
// straight into a shared board with no way to tell either.
export function Lobby({ lobby, myPlayerId, connection, onStart, onLeave }: LobbyProps) {
  const me = lobby.seats.find((s) => s.playerId === myPlayerId)
  const isHost = me?.isHost ?? false
  const canStart = isHost && lobby.seats.length >= 2
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${lobby.roomCode}`
  const [copied, setCopied] = useState(false)

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied (permissions, insecure context); the
      // link is still selectable text right next to the button.
    }
  }

  return (
    <div className="lobby" data-testid="lobby">
      <h2 className="lobby__title">Waiting room</h2>

      <p className="lobby__code">
        Room code: <strong data-testid="room-code">{lobby.roomCode}</strong>
      </p>
      <p className="lobby__share">
        Share this link: <code data-testid="room-link">{shareUrl}</code>
        <button type="button" className="lobby__copy btn-pill" data-testid="copy-link" onClick={copyLink}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </p>

      {/* Joiners had no say in any of this and can't see the host's panel —
          the reset effect in particular changes the deck they are about to
          play with. */}
      <p className="lobby__setup" data-testid="lobby-setup">
        {lobby.season === 'both' ? 'Season 1+2' : `Season ${lobby.season}`} · {lobby.fameToTriggerEndgame} fame to end
        {lobby.bigButton && <> · Big Button: reset {lobby.bigButton}</>}
      </p>

      <p className="lobby__count" data-testid="seat-count">
        Players ({lobby.seats.length} of {lobby.capacity})
      </p>

      <ul className="lobby__seats" data-testid="seat-list">
        {lobby.seats.map((seat) => (
          <li key={seat.playerId} className="lobby__seat" data-testid={`seat-${seat.playerId}`}>
            <span className="lobby__seat-name">{seat.name}</span>
            {seat.isHost && <span className="lobby__badge">host</span>}
            {seat.playerId === myPlayerId && <span className="lobby__badge lobby__badge--you">you</span>}
            {!seat.connected && <span className="lobby__badge lobby__badge--away">away</span>}
          </li>
        ))}
      </ul>

      {isHost ? (
        <button type="button" className="lobby__start" data-testid="start-game" disabled={!canStart || connection !== 'open'} onClick={onStart}>
          {canStart ? `Start game (${lobby.seats.length} players)` : 'Waiting for another player…'}
        </button>
      ) : (
        <p className="lobby__waiting" data-testid="waiting-for-host">Waiting for the host to start…</p>
      )}

      <button type="button" className="lobby__leave btn-pill" onClick={onLeave}>
        Leave room
      </button>
    </div>
  )
}
