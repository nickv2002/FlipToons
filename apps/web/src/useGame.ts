import { useCallback, useEffect, useState } from 'react'
import type { GameState } from '../../../packages/engine/state'
import type { SoloDifficulty } from '../../../packages/engine/setup'
import type { Action } from '../../../packages/engine/actions'
import { advanceThroughPassthroughPhases, applyAction, buildNewGameState, hasAnyLegalMarketAction } from '../../../packages/engine/actions'

const STORAGE_KEY = 'fliptoons-solo-save-v1'

// Save/resume substitute for §4.7's action-log replay (never built — see
// flip-toonz-structure-plan.md §12): the whole GameState is JSON.stringify'd
// straight to localStorage on every change. Not a replay log, just a
// snapshot.
function loadSavedState(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GameState
    // A save persisted mid-phase from before the auto-advance change (see
    // actions.ts's advanceThroughPassthroughPhases) may rest in a phase the
    // UI no longer ever shows. Fast-forward it to 'market' or 'ended' before
    // handing it to the UI. The cascade's log lines are discarded here —
    // same as the rest of a resumed session's history, which isn't
    // reconstructed either (see this file's header comment on save/resume).
    if (parsed.phase === 'checkFame' || parsed.phase === 'postFameHooks' || parsed.phase === 'cleanup') {
      return advanceThroughPassthroughPhases(parsed, [])
    }
    return parsed
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
  const [debugLog, setDebugLog] = useState<LogEntry[]>([])

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
      const { state: next, logLines, debugLines } = applyAction(state, action)
      setState(next)
      if (logLines.length > 0) {
        // A single dispatch can now cascade across a round boundary (e.g.
        // endMarket -> cleanup -> next round's flip), so its logLines can
        // belong to two different rounds — tagging everything with next.round
        // would mislabel "Ended the Market phase." / "Round N complete…" as
        // the round they're advancing INTO. The next round's own flip-order
        // line is the actual boundary: everything before it is state.round,
        // everything from it onward is next.round.
        const boundary = logLines.findIndex((line) => /^Round \d+: flip order —/.test(line))
        setLog((prevLog) => [
          ...prevLog,
          ...logLines.map((text, i) => ({ round: boundary !== -1 && i >= boundary ? next.round : state.round, text })),
        ])
      }
      if (debugLines.length > 0) {
        // debugLines only ever come from a single runFlip call within this
        // dispatch (at most one flip per cascade) — no boundary-splitting
        // needed, everything belongs to the round that flip just filled.
        setDebugLog((prevLog) => [...prevLog, ...debugLines.map((text) => ({ round: next.round, text }))])
      }
    },
    [state],
  )

  // Auto-end the Market phase once nothing is left to decide — no
  // affordable market slot, no affordable (non-immune) grid card to
  // dismiss. Routed through the same `dispatch` the "End Market phase"
  // button uses, so it fully cascades to the next round's Market phase (or
  // 'ended') exactly like a manual click — this effect only fires again once
  // that lands, it doesn't loop on itself.
  useEffect(() => {
    // A truthy pendingPostMarketChoice means endMarketPhase already paused
    // mid-sequence waiting on Alligator's stack-target pick (RoundView
    // renders a prompt for it) — dispatching 'endMarket' again here would
    // just re-hit the same pause every render, an infinite loop, since phase
    // stays 'market' and hasAnyLegalMarketAction is already false while paused.
    if (state?.phase === 'market' && !state.pendingPostMarketChoice && !hasAnyLegalMarketAction(state)) {
      dispatch({ kind: 'endMarket' })
    }
  }, [state, dispatch])

  const startNewGame = useCallback((seed: number, difficulty: SoloDifficulty, season: 1 | 2) => {
    const initial = buildNewGameState(seed, difficulty, season)
    // A brand-new game starts at phase 'flip' (buildNewGameState) — run the
    // first flip immediately so the very first screen shown is Market, with
    // zero clicks, same as every subsequent round (actions.ts's applyAction
    // 'flip' branch cascades all the way through checkFame/postFameHooks).
    const { state: next, logLines, debugLines } = applyAction(initial, { kind: 'flip' })
    setLog([{ round: 1, text: `New game — seed ${seed}, ${difficulty}, season ${season}.` }, ...logLines.map((text) => ({ round: next.round, text }))])
    setDebugLog(debugLines.map((text) => ({ round: next.round, text })))
    setState(next)
  }, [])

  const abandonGame = useCallback(() => {
    setState(null)
    setLog([])
    setDebugLog([])
  }, [])

  return { state, log, debugLog, dispatch, startNewGame, abandonGame }
}
