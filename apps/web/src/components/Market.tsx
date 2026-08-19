import { useState } from 'react'
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Market as MarketData } from '../../../../packages/engine/market'
import { hireCost } from '../../../../packages/engine/market'
import { getSlot } from '../../../../packages/engine/grid'
import type { GameState } from '../../../../packages/engine/state'
import type { Action } from '../../../../packages/engine/actions'
import { evaluateMarketCandidates } from '../../../../packages/engine/ai'
import { Card } from './Card'

export type MarketProps = {
  market: MarketData
  cards: Record<CardId, CardData>
  fame: number
  onHire?: (slotIndex: number) => void
  // Full GameState, needed only for the "Suggest" advisor button — the
  // Monte-Carlo evaluator (packages/engine/ai.ts) works off the whole state,
  // not just the market slice already rendered above. Advisory only: this
  // never dispatches an Action itself, it just tells the player what the
  // simulator ranked best.
  state?: GameState
}

// A low simulation count (12, vs ai.ts's own default of 24) — the button
// must respond instantly on click, not after a noticeable UI-thread stall;
// see the task brief for that budget.
const SUGGEST_SIMULATIONS = 12

function posLabel(pos: { section: 'base' | 'extra'; row: number; col: number }): string {
  return pos.section === 'base' ? `row ${pos.row}, col ${pos.col}` : `extra row ${pos.row}, col ${pos.col}`
}

// Plain-language rendering of the AI's top-ranked candidate Action — mirrors
// tui.ts's own player-facing phrasing (e.g. "Hired <name> for <price> fame")
// closely enough to read as the same voice, without dispatching anything.
function describeAction(state: GameState, cards: Record<CardId, CardData>, action: Action): string {
  if (action.kind === 'endMarket') return 'Suggested: End Market phase'
  if (action.kind === 'hire') {
    const cardId = state.market.slots[action.slotIndex]
    const name = cardId ? cards[cardId]?.name ?? cardId : `slot ${action.slotIndex}`
    return `Suggested: Hire ${name} (slot ${action.slotIndex})`
  }
  if (action.kind === 'dismiss') {
    const cardId = getSlot(state.grid, action.pos)?.cards[action.index]
    const name = cardId ? cards[cardId]?.name ?? cardId : 'card'
    return `Suggested: Dismiss ${name} at ${posLabel(action.pos)}`
  }
  return 'Suggested: (no recommendation)'
}

export function Market({ market, cards, fame, onHire, state }: MarketProps) {
  const [suggestion, setSuggestion] = useState<string | null>(null)

  return (
    <div className="market">
      <div className="market__slots">
        {market.slots.map((cardId, i) => {
          const price = hireCost(market, i)
          const card = cardId ? cards[cardId] : undefined
          const affordable = fame >= price
          return (
            <Card
              key={i}
              card={card}
              price={price}
              emptyLabel={`${price} fame`}
              onClick={card && onHire ? () => onHire(i) : undefined}
              disabled={!card || !affordable}
              unaffordable={!!card && !affordable}
              compact
            />
          )
        })}
      </div>
      {state && (
        <div className="market__suggest">
          <button
            type="button"
            className="market__suggest-button"
            onClick={() => {
              const [best] = evaluateMarketCandidates(state, { simulations: SUGGEST_SIMULATIONS })
              setSuggestion(best ? describeAction(state, cards, best.action) : null)
            }}
          >
            Suggest
          </button>
          {suggestion && <p className="market__suggestion">{suggestion}</p>}
        </div>
      )}
    </div>
  )
}
