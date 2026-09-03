import { useState } from 'react'
import type { LobbyState } from '../../../worker/protocol'
import type { ConnectionState } from '../useMatch'
import type { MatchDifficulty } from '../../../../packages/engine/ai'
import { FamePill } from './FamePill'
import { BotDifficultySelector } from './BotDifficultySelector'
import { BotPerfInfo } from './BotPerfInfo'

export type LobbyProps = {
  lobby: LobbyState
  myPlayerId: string | null
  connection: ConnectionState
  onStart: () => void
  onLeave: () => void
  onAddBot: (difficulty: MatchDifficulty) => void
  onRemoveBot: (playerId: string) => void
  onSetBotDifficulty: (playerId: string, difficulty: MatchDifficulty) => void
}

// New bots start at this difficulty; the host retargets them individually
// afterward via each seat's BotDifficultySelector.
const DEFAULT_BOT_DIFFICULTY: MatchDifficulty = 'normal'

// The waiting room. Its whole job is answering "am I actually in, and who else
// is here" before the game starts — the previous room-code flow dropped you
// straight into a shared board with no way to tell either.
export function Lobby({ lobby, myPlayerId, connection, onStart, onLeave, onAddBot, onRemoveBot, onSetBotDifficulty }: LobbyProps) {
  const me = lobby.seats.find((s) => s.playerId === myPlayerId)
  const isHost = me?.isHost ?? false
  const canStart = isHost && lobby.seats.length >= 2
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${lobby.roomCode}`
  const [copied, setCopied] = useState(false)
  const canAddBot = isHost && lobby.seats.length < lobby.capacity

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
        {lobby.season === 'both' ? 'Season 1+2' : `Season ${lobby.season}`} · <FamePill value={lobby.fameToTriggerEndgame} /> to end
        {lobby.bigButton && <> · Big Button: reset {lobby.bigButton}</>}
      </p>

      <p className="lobby__count" data-testid="seat-count">
        Players ({lobby.seats.length} of {lobby.capacity})
      </p>

      <ul className="lobby__seats" data-testid="seat-list">
        {lobby.seats.map((seat) => (
          <li key={seat.playerId} className="lobby__seat" data-testid={`seat-${seat.playerId}`}>
            {/* No separate "bot" badge — the name itself already says "Bot"
                pre-start, and the difficulty selector right next to it makes
                what kind of seat this is obvious without another label. */}
            <span className="lobby__seat-name">{seat.name}</span>
            {seat.isHost && <span className="lobby__badge">host</span>}
            {seat.playerId === myPlayerId && <span className="lobby__badge lobby__badge--you">you</span>}
            {!seat.connected && !seat.isBot && <span className="lobby__badge lobby__badge--away">away</span>}
            {isHost && seat.isBot && (
              <span className="lobby__bot-controls">
                <BotDifficultySelector playerId={seat.playerId} value={seat.botDifficulty ?? DEFAULT_BOT_DIFFICULTY} onChange={onSetBotDifficulty} />
                <button
                  type="button"
                  className="lobby__remove-bot btn-pill"
                  data-testid={`remove-bot-${seat.playerId}`}
                  onClick={() => onRemoveBot(seat.playerId)}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* Bots are seats too, added here rather than up front on the host
          panel — the point of moving them to the waiting room is seeing who
          actually showed up before deciding how many to fill in, and being
          able to add or remove one right up until Start if a friend doesn't
          make it. Joiners can't touch this; the seat list above already
          tells them what's there. Difficulty is no longer picked before
          adding — a new bot starts at Medium and is retargeted per-seat via
          the selector above. */}
      {isHost && (
        <div className="config-panel__field lobby__add-bot">
          <span className="lobby__add-bot-row">
            <button type="button" className="multiplayer-start__add-bot btn-pill" data-testid="add-bot" disabled={!canAddBot} onClick={() => onAddBot(DEFAULT_BOT_DIFFICULTY)}>
              + Add bot
            </button>
            <BotPerfInfo bots={lobby.seats.filter((s) => s.isBot)} />
          </span>
        </div>
      )}

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
