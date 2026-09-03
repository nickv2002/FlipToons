// Builds the "N:5, J:6, K:5" per-player fame summary shown in the log's
// round header (ResolveLog), replacing what used to be a bare line count.

const MAX_LABEL_LENGTH = 4

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length
}

// Short, collision-safe display labels — starts at each name's first
// character and only grows a label as far as needed to stay unique among
// the others at the table, capped so two names that share a long prefix
// can't make the summary run away in width; anything still colliding at the
// cap falls back to the full name for just those entries.
export function buildFameLabels(players: { playerId: string; name: string }[]): Map<string, string> {
  let length = 1
  let labels = players.map((p) => p.name.slice(0, length) || p.name)
  while (hasDuplicate(labels) && length < MAX_LABEL_LENGTH) {
    length++
    labels = players.map((p) => p.name.slice(0, length) || p.name)
  }
  if (hasDuplicate(labels)) {
    const counts = new Map<string, number>()
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
    labels = labels.map((label, i) => ((counts.get(label) ?? 0) > 1 ? players[i].name : label))
  }
  return new Map(players.map((p, i) => [p.playerId, labels[i]]))
}

export function formatRoundFame(roundFame: { playerId: string; fame: number }[], labels: Map<string, string>): string {
  return roundFame.map((rf) => `${labels.get(rf.playerId) ?? rf.playerId}:${rf.fame}`).join(', ')
}
