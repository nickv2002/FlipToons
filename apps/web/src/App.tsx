import { useEffect, useState } from 'react'
import { useGame } from './useGame'
import { useMatch, roomCodeFromUrl, hasStoredSeat } from './useMatch'
import { RoundView } from './components/RoundView'
import { FameRace } from './components/FameRace'
import { LogDrawer } from './components/LogDrawer'
import { TopBar } from './components/TopBar'
import { Lobby } from './components/Lobby'
import { MatchView, MatchStatus } from './components/MatchView'
import { LaunchScreen } from './components/LaunchScreen'
import type { LaunchStep } from './components/LaunchScreen'
import { loadSettings, saveSettings } from './settings'

// Two genuinely different games live here:
//
//   'solo'        one player, run entirely in this browser (useGame) with
//                 localStorage save/resume. No server involved.
//   'multiplayer' 2-4 seated players in a server-hosted room (useMatch).
//
// The previous "host online" mode was neither: it hosted a SOLO game that any
// number of browsers jointly drove, sharing one grid and one fame pool.
//
// Both start from the same launch screen: three big cards (Solo / Host a
// table / Join a Game), each leading into its own config panel.
//
// Both also share ONE TopBar and ONE LogDrawer, rendered here. They used to be
// per-mode: MatchView printed a header and the RoundView nested inside it
// printed another one about eight pixels lower, and the log was a permanent
// sidebar competing with the boards for width at every screen size.
export function App() {
  const local = useGame()
  const match = useMatch()
  const urlRoom = roomCodeFromUrl()
  // A room link OR a remembered seat means the player was in a multiplayer
  // game; open there rather than on the solo screen, or a reload silently
  // abandons a game that is still running.
  const [mode, setMode] = useState<'solo' | 'multiplayer'>(urlRoom || hasStoredSeat() ? 'multiplayer' : 'solo')
  // A shared ?room= link should land on the join panel with the code in it.
  const [launchStep, setLaunchStep] = useState<LaunchStep>(urlRoom ? 'join' : 'pick')
  const [logOpen, setLogOpen] = useState(false)
  // Lifted out of RoundView: the toggle that sets it lives in the shared
  // TopBar, which renders above and outside RoundView.
  const [touchMode, setTouchMode] = useState(() => loadSettings().touchMode)

  const changeTouchMode = (next: boolean) => {
    setTouchMode(next)
    saveSettings({ touchMode: next })
  }

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

  // ONE render site, shared by both branches below. Two would remount the
  // panel the moment a failed join flipped the mode back — losing the typed
  // name along with the error explaining what went wrong.
  const launchScreen = (
    <LaunchScreen
      step={launchStep}
      onPick={(step) => {
        setLaunchStep(step)
        setMode(step === 'host' || step === 'join' ? 'multiplayer' : 'solo')
      }}
      onBack={() => {
        match.clearError()
        setLaunchStep('pick')
        setMode('solo')
      }}
      onStartSolo={local.startNewGame}
      onHost={match.createRoom}
      onJoin={match.joinRoom}
      connection={match.connection}
      initialRoomCode={urlRoom}
    />
  )

  const leaveMatch = () => {
    match.leave()
    setLogOpen(false)
    setLaunchStep('pick')
    setMode('solo')
  }

  if (mode === 'multiplayer') {
    return (
      <div className="app">
        {connectionBanner}
        {/* Errors used to render only while there was no state, so anything
            that went wrong mid-game was invisible. Then they rendered only
            while there WAS state, which hid every lobby-phase error instead —
            a dead room code, "only the host can start", "need at least 2
            players" — behind a lobby that simply never advanced. Neither
            gate: an error is worth showing wherever it happens. */}
        {match.error && (
          <p className="app__error" data-testid="match-error" onClick={match.clearError}>
            {match.error}
          </p>
        )}

        {match.match && match.lobby && match.myPlayerId ? (
          <div className="app__game">
            <TopBar
              round={match.match.shared.round}
              status={<MatchStatus match={match.match} lobby={match.lobby} myPlayerId={match.myPlayerId} />}
              onOpenLog={() => setLogOpen(true)}
              logCount={match.log.length}
              touchMode={touchMode}
              onTouchModeChange={changeTouchMode}
              leaveLabel="Leave game"
              onLeave={leaveMatch}
            />
            <MatchView
              match={match.match}
              lobby={match.lobby}
              myPlayerId={match.myPlayerId}
              onAct={match.act}
              onLeave={leaveMatch}
              onRematch={match.rematch}
              touchMode={touchMode}
            />
            {logOpen && (
              <LogDrawer
                log={match.log.map((l) => ({
                  round: l.round,
                  // Now that the protocol carries an actor, say who did it.
                  text: l.playerId ? `${match.lobby!.seats.find((s) => s.playerId === l.playerId)?.name ?? l.playerId}: ${l.text}` : l.text,
                }))}
                debugLog={match.debugLog.map((text) => ({ round: 0, text }))}
                onClose={() => setLogOpen(false)}
              />
            )}
          </div>
        ) : match.lobby ? (
          <Lobby
            lobby={match.lobby}
            myPlayerId={match.myPlayerId}
            connection={match.connection}
            onStart={match.startGame}
            onLeave={leaveMatch}
          />
        ) : (
          launchScreen
        )}
      </div>
    )
  }

  const abandonSolo = () => {
    setLogOpen(false)
    local.abandonGame()
  }

  return (
    <div className="app">
      {local.state === null ? (
        launchScreen
      ) : (
        <div className="app__game">
          <TopBar
            round={local.state.round}
            onOpenLog={() => setLogOpen(true)}
            logCount={local.log.length}
            touchMode={touchMode}
            onTouchModeChange={changeTouchMode}
            leaveLabel="Abandon game"
            onLeave={abandonSolo}
          />
          {/* Solo has one row and no opponents to compare against, so the
              strip spells the comparison out in words instead of naming a
              seat. Not rendered on the end screen: the result is already the
              headline there. */}
          {local.state.phase !== 'ended' && (
            <FameRace
              variant="solo"
              threshold={local.state.fameToTriggerEndgame}
              rows={[
                {
                  playerId: local.state.playerId,
                  name: 'You',
                  value: local.state.fameGeneratedThisRound,
                  isMe: true,
                  criticsChoice: false,
                  settled: null,
                },
              ]}
            />
          )}
          <RoundView state={local.state} dispatch={local.dispatch} onAbandon={abandonSolo} touchMode={touchMode} />
          {logOpen && <LogDrawer log={local.log} debugLog={local.debugLog} onClose={() => setLogOpen(false)} />}
        </div>
      )}
    </div>
  )
}
