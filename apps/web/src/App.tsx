import { useState } from 'react'
import { useGame } from './useGame'
import { useRemoteGame } from './useRemoteGame'
import { NewGameForm } from './components/NewGameForm'
import { RoundView } from './components/RoundView'
import { ResolveLog } from './components/ResolveLog'

// Both hooks are called unconditionally (rules of hooks) — useRemoteGame is
// inert (no socket opened) until startNewGame/rejoinRoom is actually
// invoked, so running it alongside the default local mode costs nothing.
// `mode` just picks which hook's result the rest of the tree sees.
export function App() {
  const local = useGame()
  const remote = useRemoteGame()
  const [mode, setMode] = useState<'local' | 'remote'>('local')

  const active = mode === 'local' ? local : remote

  return (
    <div className="app">
      {active.state === null ? (
        <>
          <NewGameForm
            onStart={local.startNewGame}
            onHostOnline={(seed, difficulty, season) => {
              setMode('remote')
              remote.startNewGame(seed, difficulty, season)
            }}
            onRejoin={(roomCode) => {
              setMode('remote')
              remote.rejoinRoom(roomCode)
            }}
            remoteError={remote.error}
          />
          {mode === 'remote' && remote.roomCode === null && !remote.error && <p className="app__connecting">Connecting…</p>}
        </>
      ) : (
        <div className="app__game">
          {mode === 'remote' && remote.roomCode && <p className="app__room-code">Room code: {remote.roomCode}</p>}
          <RoundView
            state={active.state}
            dispatch={active.dispatch}
            onAbandon={() => {
              active.abandonGame()
              setMode('local')
            }}
          />
          <ResolveLog log={active.log} />
        </div>
      )}
    </div>
  )
}
