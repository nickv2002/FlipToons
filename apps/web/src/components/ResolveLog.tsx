import { useMemo, useState } from 'react'
import type { LogEntry } from '../useGame'

export type ResolveLogProps = {
  log: LogEntry[]
}

// Presentation-only classification of actions.ts's/tui.ts-mirrored log
// strings, used purely to pick a CSS color class — never alters the text.
// Keyed off the exact prefixes actions.ts pushes (see 'Hired ', 'Dismissed ',
// "Can't do that:", 'YOU WIN'/'YOU LOSE', etc.) — those strings are asserted
// on verbatim by packages/engine/tui.test.ts, so this only ever reads them,
// it must never rewrite them.
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
  if (text.startsWith('Ended the Market phase') || text.startsWith('No Market actions remaining')) return 'phase-end'
  if (text.startsWith('  Note:')) return 'note'
  // formatBreakdown() (score.ts) joins its rows with '\n' into a single
  // pushed logLine — a multi-line fame-breakdown table, not any of the
  // single-line shapes above.
  if (text.includes('\n')) return 'breakdown'
  return 'default'
}

// Mirrors what tui.ts's `out` callback prints to the terminal — the same
// running log of flips/scoring/hires/dismisses, now grouped into
// collapsible per-round sections (a flat ever-growing list stopped being
// scannable once a real game's worth of lines piled up) with color coding
// by line kind so wins/losses/hires/errors read at a glance.
export function ResolveLog({ log }: ResolveLogProps) {
  const [collapsed, setCollapsed] = useState(false)
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
  const groups = useMemo(() => {
    const out: { round: number; entries: LogEntry[] }[] = []
    for (const entry of log) {
      const last = out[out.length - 1]
      if (last && last.round === entry.round) last.entries.push(entry)
      else out.push({ round: entry.round, entries: [entry] })
    }
    return out
  }, [log])

  const latestRound = groups.length > 0 ? groups[groups.length - 1].round : null

  return (
    <div className="resolve-log">
      <div className="resolve-log__header">
        <h2 className="resolve-log__title">Log</h2>
        <button type="button" className="resolve-log__toggle" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!collapsed && (
        <div className="resolve-log__body">
          {groups.length === 0 && <p className="resolve-log__empty">No events yet.</p>}
          {groups.map((group, groupIndex) => {
            const expanded = expandOverrides[group.round] ?? group.round === latestRound
            return (
              <div className="resolve-log__group" key={groupIndex}>
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
                  <span className="resolve-log__count">{group.entries.length}</span>
                </button>
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
      )}
    </div>
  )
}
