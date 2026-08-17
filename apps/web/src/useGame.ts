import { useCallback, useEffect, useState } from 'react'
import type { GameState } from '../../../packages/engine/state'
import type { SoloDifficulty } from '../../../packages/engine/setup'
import type { Action } from './engine-actions'
import { applyAction, buildNewGameState } from './engine-actions'

const STORAGE_KEY = 'fliptoons-solo-save-v1'

// Save/resume substitute for §4.7's action-log replay (never built — see
// flip-toonz-structure-plan.md §12): the whole GameState is JSON.stringify'd
// straight to localStorage on every change. Not a replay log, just a
// snapshot.
function loadSavedState(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as GameState
  } catch {
    return null
  }
}

function saveState(state: GameState | null): void {
  try {
    if (state === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Best-effort persistence — a full/blocked localStorage shouldn't crash the game.
  }
}

export type LogEntry = { round: number; text: string }

export function useGame() {
  const [state, setState] = useState<GameState | null>(() => loadSavedState())
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    saveState(state)
  }, [state])

  // Deliberately NOT the setState-updater form (`setState(prev => ...)`) —
  // React 18 StrictMode double-invokes updater functions to surface
  // impurity, which would fire the setLog side effect below twice per
  // dispatch even though applyAction itself stays correct either way.
  const dispatch = useCallback(
    (action: Action) => {
      if (!state) return
      const { state: next, logLines } = applyAction(state, action)
      setState(next)
      if (logLines.length > 0) {
        setLog((prevLog) => [...prevLog, ...logLines.map((text) => ({ round: next.round, text }))])
      }
    },
    [state],
  )

  const startNewGame = useCallback((seed: number, difficulty: SoloDifficulty, season: 1 | 2) => {
    const initial = buildNewGameState(seed, difficulty, season)
    setLog([{ round: 1, text: `New game — seed ${seed}, ${difficulty}, season ${season}.` }])
    setState(initial)
  }, [])

  const abandonGame = useCallback(() => {
    setState(null)
    setLog([])
  }, [])

  return { state, log, dispatch, startNewGame, abandonGame }
}
