import { useGame } from './useGame'
import { NewGameForm } from './components/NewGameForm'
import { RoundView } from './components/RoundView'
import { ResolveLog } from './components/ResolveLog'

export function App() {
  const { state, log, dispatch, startNewGame, abandonGame } = useGame()

  return (
    <div className="app">
      {state === null ? (
        <NewGameForm onStart={startNewGame} />
      ) : (
        <div className="app__game">
          <RoundView state={state} dispatch={dispatch} onAbandon={abandonGame} />
          <ResolveLog log={log} />
        </div>
      )}
    </div>
  )
}
