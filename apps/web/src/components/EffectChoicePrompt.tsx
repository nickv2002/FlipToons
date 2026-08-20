import { useState } from 'react'
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { DismissTarget, PendingChoice } from '../../../../packages/engine/hireChoices'
import { Card } from './Card'

export type EffectChoiceSelection = DismissTarget | CardId | number | number[] | 'skip'

export type EffectChoicePromptProps = {
  cardName: string
  choice: PendingChoice
  cards: Record<CardId, CardData>
  fame: number
  market: (CardId | null)[]
  onResolve: (selection: EffectChoiceSelection) => void
}

// Same visual language as the Market panel (Card.tsx's front face — name,
// icon, fame, price/dismiss-cost badge) rather than a plain checkbox/button
// list, so a choice prompt reads as "another market-like picker" instead of
// a form. Every kind but Horse's discardMarketAndRefill resolves on a
// single click (matches applyEffects: each of those is "pick exactly one
// target, or skip"); Horse toggles any number of cards, then confirms once.
export function EffectChoicePrompt({ cardName, choice, cards, fame, market, onResolve }: EffectChoicePromptProps) {
  const [selectedSlots, setSelectedSlots] = useState<number[]>([])

  const affordable = choice.kind === 'discardMarketAndRefill' ? true : fame >= choice.cost

  if (choice.kind === 'discardMarketAndRefill') {
    const toggle = (i: number) => setSelectedSlots((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))
    return (
      <div className="effect-choice">
        <p className="effect-choice__prompt">{cardName}: discard any number of market cards and refill.</p>
        <div className="effect-choice__cards">
          {choice.options.map((i) => (
            <Card
              key={i}
              card={cards[market[i]!]}
              compact
              selected={selectedSlots.includes(i)}
              onClick={() => toggle(i)}
            />
          ))}
        </div>
        <button type="button" onClick={() => onResolve(selectedSlots)}>
          Discard {selectedSlots.length} card{selectedSlots.length === 1 ? '' : 's'} &amp; refill
        </button>
      </div>
    )
  }

  return (
    <div className="effect-choice">
      <p className="effect-choice__prompt">
        {cardName}: {choice.mandatory ? 'choose a card to dismiss' : 'you may resolve this ability'}
        {choice.kind === 'dismissAlligatorTarget' ? '.' : ` for ${choice.cost} fame.`}
      </p>
      <div className="effect-choice__cards">
        {choice.kind === 'dismissByName' &&
          choice.options.map((t) => (
            <Card
              key={`${t.pos.section}-${t.pos.row}-${t.pos.col}-${t.index}`}
              card={cards[t.cardId]}
              compact
              dismissCost={choice.cost}
              disabled={!affordable}
              onClick={() => onResolve(t)}
            />
          ))}
        {(choice.kind === 'dismissChosenGridCard' || choice.kind === 'dismissAlligatorTarget') &&
          choice.options.map((t) => (
            <Card
              key={`${t.pos.section}-${t.pos.row}-${t.pos.col}-${t.index}`}
              card={cards[t.cardId]}
              compact
              dismissCost={choice.kind === 'dismissAlligatorTarget' ? undefined : choice.cost}
              disabled={!affordable}
              onClick={() => onResolve(t)}
            />
          ))}
        {choice.kind === 'hireFromDismissed' &&
          choice.options.map((id, i) => (
            <Card key={`${id}-${i}`} card={cards[id]} compact price={choice.cost} unaffordable={!affordable} disabled={!affordable} onClick={() => onResolve(id)} />
          ))}
        {choice.kind === 'hireFromMarketAndRefill' &&
          choice.options.map((i) => (
            <Card
              key={i}
              card={cards[market[i]!]}
              compact
              price={choice.cost}
              unaffordable={!affordable}
              disabled={!affordable}
              onClick={() => onResolve(i)}
            />
          ))}
      </div>
      {!choice.mandatory && (
        <button type="button" className="effect-choice__skip" onClick={() => onResolve('skip')}>
          Skip
        </button>
      )}
    </div>
  )
}
