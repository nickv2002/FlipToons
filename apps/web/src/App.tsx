import { useEffect, useState } from 'react'
import { useGame } from './useGame'
import { useMatch, roomCodeFromUrl } from './useMatch'
import { NewGameForm } from './components/NewGameForm'
import { RoundView } from './components/RoundView'
import { ResolveLog } from './components/ResolveLog'
import { Lobby } from './components/Lobby'
import { MatchView } from './components/MatchView'
import { MultiplayerStart } from './components/MultiplayerStart'

// Two genuinely different games live here:
//
//   'solo'        one player, run entirely in this browser (useGame) with
//                 localStorage save/resume. No server involved.
//   'multiplayer' 2-4 seated players in a server-hosted room (useMatch).
//
// The previous "host online" mode was neither: it hosted a SOLO game that any
// number of browsers jointly drove, sharing one grid and one fame pool.
export function App() {
  const local = useGame()
  const match = useMatch()
  const urlRoom = roomCodeFromUrl()
  const [mode, setMode] = useState<'solo' | 'multiplayer'>(urlRoom ? 'multiplayer' : 'solo')

  // A room code in the URL or a stored seat means "get me back into that
  // game." The old remote hook persisted nothing, so a refresh lost the room
  // with no way back in.
  const storedSeat = match.storedSeat
  useEffect(() => {
    if (match.connection !== 'idle') return
    if (urlRoom && storedSeat?.roomCode === urlRoom) {
      match.joinRoom(urlRoom, storedSeat.name)
    } else if (!urlRoom && storedSeat) {
      match.joinRoom(storedSeat.roomCode, storedSeat.name)
    }
    // Intentionally runs once on mount: this is a resume attempt, not a
    // subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connectionBanner =
    match.connection === 'reconnecting' ? (
      <p className="app__connection app__connection--warn" data-testid="connection-banner">
        Connection lost — reconnecting…
      </p>
    ) : match.connection === 'failed' ? (
      <p className="app__connection app__connection--error" data-testid="connection-banner">
        Can't reach the game server.
      </p>
    ) : null

  if (mode === 'multiplayer') {
    return (
      <div className="app">
        {connectionBanner}
        {/* Errors used to render only while there was no state, so anything
            that went wrong mid-game was invisible. */}
        {match.error && match.match && (
          <p className="app__error" data-testid="match-error" onClick={match.clearError}>
            {match.error}
          </p>
        )}

        {match.match && match.lobby && match.myPlayerId ? (
          <div className="app__game">
            <MatchView
              match={match.match}
              lobby={match.lobby}
              myPlayerId={match.myPlayerId}
              onAct={match.act}
              onLeave={() => {
                match.leave()
                setMode('solo')
              }}
            />
            <ResolveLog
              log={match.log.map((l) => ({
                round: l.round,
                // Now that the protocol carries an actor, say who did it.
                text: l.playerId ? `${match.lobby!.seats.find((s) => s.playerId === l.playerId)?.name ?? l.playerId}: ${l.text}` : l.text,
              }))}
              debugLog={match.debugLog.map((text) => ({ round: 0, text }))}
            />
          </div>
        ) : match.lobby ? (
          <Lobby
            lobby={match.lobby}
            myPlayerId={match.myPlayerId}
            connection={match.connection}
            onStart={match.startGame}
            onLeave={() => {
              match.leave()
              setMode('solo')
            }}
          />
        ) : (
          <>
            <MultiplayerStart onHost={match.createRoom} onJoin={match.joinRoom} error={match.error} connection={match.connection} initialRoomCode={urlRoom} />
            <button type="button" className="app__back" onClick={() => setMode('solo')}>
              Back to solo
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      {local.state === null ? (
        <>
          <NewGameForm onStart={local.startNewGame} />
          <button type="button" className="app__multiplayer" data-testid="go-multiplayer" onClick={() => setMode('multiplayer')}>
            Play with other people
          </button>
        </>
      ) : (
        <div className="app__game">
          <RoundView state={local.state} dispatch={local.dispatch} onAbandon={local.abandonGame} />
          <ResolveLog log={local.log} debugLog={local.debugLog} />
        </div>
      )}
    </div>
  )
}
