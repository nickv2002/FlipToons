import { useMemo, useState } from 'react'
import type { LogEntry } from '../useGame'
import type { FameSummaryEntry } from '../logSummary'
import { FamePill } from './FamePill'

export type ResolveLogProps = {
  log: LogEntry[]
  debugLog: LogEntry[]
  // The round in progress has no captured roundSummary yet — that only gets
  // written once Cleanup fires (see useGame.ts / matchActions.ts). This is
  // the live equivalent, computed from current state, shown only for the
  // latest round and only until that round's own captured summary lands.
  currentRoundSummary?: FameSummaryEntry[]
}

// Presentation-only classification of actions.ts's log strings, used purely
// to pick a CSS color class — never alters the text. Keyed off the exact
// prefixes actions.ts pushes (see 'Hired ', 'Dismissed ', "Can't do that:",
// 'YOU WIN'/'YOU LOSE', etc.) — those strings are asserted on verbatim by
// packages/engine/actions.test.ts, so this only ever reads them, it must
// never rewrite them.
type LineKind = 'win' | 'lose' | 'hire' | 'dismiss' | 'error' | 'round-complete' | 'flip-order' | 'phase-end' | 'new-game' | 'breakdown' | 'note' | 'default'

function classify(text: string): LineKind {
  if (text.startsWith('YOU WIN')) return 'win'
  if (text.startsWith('YOU LOSE')) return 'lose'
  if (text.startsWith('Hired ')) return 'hire'
  if (text.startsWith('Dismissed ')) return 'dismiss'
  if (text.startsWith("Can't do that:")) return 'error'
  if (text.startsWith('New game')) return 'new-game'
  if (/^Round \d+ complete\./.test(text)) return 'round-complete'
  if (/^Round \d+: flip order/.test(text)) return 'flip-order'
  if (/^\d+ card\(s\) left in your deck\.$/.test(text)) return 'note'
  if (text.startsWith('Ended the Market phase') || text.startsWith('No Market actions remaining')) return 'phase-end'
  if (text.startsWith('  Note:')) return 'note'
  // formatBreakdown() (score.ts) joins its rows with '\n' into a single
  // pushed logLine — a multi-line fame-breakdown table, not any of the
  // single-line shapes above.
  if (text.includes('\n')) return 'breakdown'
  return 'default'
}

function groupByRound(entries: LogEntry[]): { round: number; entries: LogEntry[] }[] {
  const out: { round: number; entries: LogEntry[] }[] = []
  for (const entry of entries) {
    const last = out[out.length - 1]
    if (last && last.round === entry.round) last.entries.push(entry)
    else out.push({ round: entry.round, entries: [entry] })
  }
  return out
}

// Copies text to the clipboard for pasting into a bug report/chat — the
// debug log's whole point is being shareable, not just readable on screen.
// navigator.clipboard.writeText needs a secure context (https, or localhost
// during dev); silently no-ops (button just won't flash "Copied") rather
// than throwing if it's unavailable, since a failed copy shouldn't crash the log view.
function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="resolve-log__copy btn-pill"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(getText())
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard API unavailable/denied — nothing sensible to do here.
        }
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  )
}

// The running log of flips/scoring/hires/dismisses, exactly as actions.ts
// emits it — grouped into collapsible per-round sections (a flat
// ever-growing list stopped being scannable once a real game's worth of
// lines piled up) with color coding by line kind so wins/losses/hires/errors
// read at a glance.
//
// No title and no Hide/Show toggle of its own any more: it renders inside
// LogDrawer, which supplies both. A collapse control inside a thing you
// already opened on purpose is one click that does nothing.
export function ResolveLog({ log, debugLog, currentRoundSummary }: ResolveLogProps) {
  // Per-round expand/collapse overrides. Default (no override) is: the
  // latest round is expanded, every earlier round is collapsed — a fresh
  // round pushes the previous one closed automatically. An explicit click
  // overrides that default for just that round.
  const [expandOverrides, setExpandOverrides] = useState<Record<number, boolean>>({})

  // Grouped by round in arrival order. Keyed by array index, not round
  // number, when rendered below — a dispatch can cascade across a round
  // boundary (see useGame.ts's dispatch comment) but never re-visits an
  // earlier round once it's moved on, so this only ever appends a new
  // group when the round number changes from the previous entry.
  const groups = useMemo(() => groupByRound(log), [log])
  // debugLog is keyed the same way (one group per round) so a round's
  // header can offer "copy this round's detail log" alongside the human log
  // it's actually displaying — see useGame.ts's dispatch, which tags every
  // debugLines entry with the round its flip just filled.
  const debugByRound = useMemo(() => {
    const map = new Map<number, LogEntry[]>()
    for (const group of groupByRound(debugLog)) map.set(group.round, group.entries)
    return map
  }, [debugLog])

  const latestRound = groups.length > 0 ? groups[groups.length - 1].round : null

  return (
    <div className="resolve-log">
      {debugLog.length > 0 && (
        <div className="resolve-log__header-actions">
          <CopyButton label="Copy full detail log" getText={() => debugLog.map((e) => e.text).join('\n')} />
        </div>
      )}
      <div className="resolve-log__body">
        {groups.length === 0 && <p className="resolve-log__empty">No events yet.</p>}
        {groups.map((group, groupIndex) => {
          const expanded = expandOverrides[group.round] ?? group.round === latestRound
          const roundDebugLines = debugByRound.get(group.round)
          const summary = group.entries.find((e) => e.roundSummary)?.roundSummary ?? (group.round === latestRound ? currentRoundSummary : undefined)
          return (
            <div className="resolve-log__group" key={groupIndex}>
              <div className="resolve-log__round-header-row">
                <button
                  type="button"
                  className="resolve-log__round-header"
                  onClick={() => setExpandOverrides((prev) => ({ ...prev, [group.round]: !expanded }))}
                  aria-expanded={expanded}
                >
                  <span className={`resolve-log__caret${expanded ? ' resolve-log__caret--open' : ''}`} aria-hidden="true">
                    ▶
                  </span>
                  <span>Round {group.round}</span>
                  {summary && summary.length > 0 && (
                    <span className="resolve-log__count">
                      {summary.map((s, i) => (
                        <span key={i} className="resolve-log__count-entry">
                          {s.initial}:<FamePill value={s.fame} />
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                {roundDebugLines && roundDebugLines.length > 0 && (
                  <CopyButton label="Copy detail" getText={() => roundDebugLines.map((e) => e.text).join('\n')} />
                )}
              </div>
              {expanded && (
                <div className="resolve-log__entries">
                  {group.entries.map((entry, i) => (
                    <pre className={`resolve-log__entry resolve-log__entry--${classify(entry.text)}`} key={i}>
                      {entry.text}
                    </pre>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
