import { useCallback, useEffect, useState } from 'react'
import type { GameState, PlayerId, ResetEffect } from '../../../packages/engine/state'
import type { SoloDifficulty } from '../../../packages/engine/setup'
import type { Season } from '../../../packages/engine/cards/types'
import type { Action } from '../../../packages/engine/actions'
import { advanceThroughPassthroughPhases, applyAction, buildNewGameState, hasAnyLegalMarketAction } from '../../../packages/engine/actions'

const STORAGE_KEY = 'fliptoons-solo-save-v1'

// Cap kept in line with multiplayer's MAX_LOG_LINES (apps/worker/room.ts) —
// bounds how much a single save round-trips through localStorage.
const MAX_LOG_LINES = 2000

// playerId carries through from EngineLogLine for type parity with
// multiplayer's LogLine — solo has one seat, so ResolveLog never prefixes it.
export type LogEntry = { round: number; text: string; playerId?: PlayerId | null; roundFame?: { playerId: PlayerId; fame: number }[]; roundSummary?: string }

type SavedGame = { state: GameState; log: LogEntry[]; debugLog: LogEntry[] }

// Applied at append time (not just at save) so the in-memory arrays — and
// therefore every render and every localStorage write — stay bounded, not
// just the write.
function capLog(entries: LogEntry[]): LogEntry[] {
  return entries.length > MAX_LOG_LINES ? entries.slice(entries.length - MAX_LOG_LINES) : entries
}

// Whole GameState (plus log/debugLog) is JSON.stringify'd straight to
// localStorage on every change — a full snapshot, not an event-sourced
// replay log.
function loadSaved(): SavedGame | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GameState | SavedGame
    // Pre-log-persistence saves (fliptoons-solo-save-v1 used to store a bare
    // GameState) have no `state` key — treat the parsed value itself as the
    // state and start with an empty log rather than failing to load.
    const saved: SavedGame = 'state' in parsed && 'log' in parsed ? (parsed as SavedGame) : { state: parsed as GameState, log: [], debugLog: [] }
    // A save persisted mid-phase from before the auto-advance change (see
    // actions.ts's advanceThroughPassthroughPhases) may rest in a phase the
    // UI no longer ever shows. Fast-forward it to 'market' or 'ended' before
    // handing it to the UI. The cascade's own log lines are discarded here —
    // they're a one-time internal fast-forward, not part of play history.
    if (saved.state.phase === 'checkFame' || saved.state.phase === 'postFameHooks' || saved.state.phase === 'cleanup') {
      return { ...saved, state: advanceThroughPassthroughPhases(saved.state, []) }
    }
    return saved
  } catch {
    return null
  }
}

function saveGame(saved: SavedGame | null): void {
  try {
    if (saved === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // Best-effort persistence — a full/blocked localStorage shouldn't crash the game.
  }
}

export function useGame() {
  const [initialSaved] = useState(() => loadSaved())
  const [state, setState] = useState<GameState | null>(() => initialSaved?.state ?? null)
  const [log, setLog] = useState<LogEntry[]>(() => initialSaved?.log ?? [])
  const [debugLog, setDebugLog] = useState<LogEntry[]>(() => initialSaved?.debugLog ?? [])

  useEffect(() => {
    saveGame(state === null ? null : { state, log, debugLog })
  }, [state, log, debugLog])

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
        const boundary = logLines.findIndex((line) => /^Round \d+: flip order —/.test(line.text))
        setLog((prevLog) =>
          capLog([
            ...prevLog,
            ...logLines.map((line, i) => ({
              round: boundary !== -1 && i >= boundary ? next.round : state.round,
              text: line.text,
              playerId: line.playerId,
              roundFame: line.roundFame,
            })),
          ]),
        )
      }
      if (debugLines.length > 0) {
        // debugLines only ever come from a single runFlip call within this
        // dispatch (at most one flip per cascade) — no boundary-splitting
        // needed, everything belongs to the round that flip just filled.
        setDebugLog((prevLog) => capLog([...prevLog, ...debugLines.map((text) => ({ round: next.round, text }))]))
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

  const startNewGame = useCallback((seed: number, difficulty: SoloDifficulty, season: Season, bigButton: ResetEffect | null = null) => {
    const initial = buildNewGameState(seed, difficulty, season, bigButton)
    // A brand-new game starts at phase 'flip' (buildNewGameState) — run the
    // first flip immediately so the very first screen shown is Market, with
    // zero clicks, same as every subsequent round (actions.ts's applyAction
    // 'flip' branch cascades all the way through checkFame/postFameHooks).
    const { state: next, logLines, debugLines } = applyAction(initial, { kind: 'flip' })
    setLog(
      capLog([
        {
          round: 1,
          text: `New game — seed ${seed}, ${difficulty}, season ${season}${bigButton ? `, Big Button: reset ${bigButton}` : ''}.`,
        },
        ...logLines.map((line) => ({ round: next.round, text: line.text, playerId: line.playerId, roundFame: line.roundFame })),
      ]),
    )
    setDebugLog(capLog(debugLines.map((text) => ({ round: next.round, text }))))
    setState(next)
  }, [])

  const abandonGame = useCallback(() => {
    setState(null)
    setLog([])
    setDebugLog([])
  }, [])

  return { state, log, debugLog, dispatch, startNewGame, abandonGame }
}
