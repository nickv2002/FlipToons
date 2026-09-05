import { useEffect } from 'react'
import type { LogEntry } from '../useGame'
import type { FameSummaryEntry } from '../logSummary'
import type { BotDecisionRecord } from '../useBotSeats'
import { ResolveLog } from './ResolveLog'

// The log, on demand. It used to be a permanent sidebar taking a third of the
// page above 1100px — which is what forced .app__game's max-width arithmetic
// to be retuned twice, and what squeezed the market pane to a few card widths
// at medium sizes. As a drawer it costs nothing until it's opened, and the
// board it describes stays visible beside it.
//
// Same backdrop-plus-panel idiom CardListOverlay uses, rather than a third
// overlay style; it just docks right and runs full height instead of centering.
export type LogDrawerProps = {
  log: LogEntry[]
  debugLog: LogEntry[]
  currentRoundSummary?: FameSummaryEntry[]
  botDecisions?: BotDecisionRecord[]
  onClose: () => void
}

export function LogDrawer({ log, debugLog, currentRoundSummary, botDecisions, onClose }: LogDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="log-drawer__backdrop" onClick={onClose}>
      <div className="log-drawer" data-testid="log-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="log-drawer__header">
          <h2 className="log-drawer__title">Log</h2>
          <button type="button" className="log-drawer__close btn-pill" data-testid="close-log" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="log-drawer__body">
          <ResolveLog log={log} debugLog={debugLog} currentRoundSummary={currentRoundSummary} botDecisions={botDecisions} />
        </div>
      </div>
    </div>
  )
}
