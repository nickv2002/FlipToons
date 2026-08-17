import { season1Cards } from './season1'
import { season2Cards } from './season2'
import type { Card } from './types'

export * from './types'
export { season1Cards, season2Cards }

export const allCards: Card[] = [...season1Cards, ...season2Cards]

// `unencodable` now means "the onPlace/onHire/onDismiss/postFameHook EFFECT
// is incomplete" — a card here may still have a fully correct `fame` and
// score normally on the grid. See cards/types.ts's Card comment.
export const unencodableCards: Card[] = allCards.filter((c) => c.unencodable)

// Cards whose FAME VALUE ITSELF can't be computed as a fixed number (today:
// none in Season 1 — Cow's fame.base === '=' is deterministic via
// score.ts's max-of-adjacent resolution and doesn't need this flag).
export const fameUnencodableCards: Card[] = allCards.filter((c) => c.fameUnencodable)
