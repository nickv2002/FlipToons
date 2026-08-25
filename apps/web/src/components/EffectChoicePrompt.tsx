import { useState } from 'react'
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { GridPos } from '../../../../packages/engine/types'
import type { DismissTarget, HireFromDismissedTarget, PendingChoice } from '../../../../packages/engine/hireChoices'
import { Card } from './Card'

export type EffectChoiceSelection = DismissTarget | HireFromDismissedTarget | number | number[] | 'skip'

export type EffectChoicePromptProps = {
  cardName: string
  choice: PendingChoice
  cards: Record<CardId, CardData>
  fame: number
  market: (CardId | null)[]
  onResolve: (selection: EffectChoiceSelection) => void
  // Overrides the generated first line. Used by the Skunk dismissal, whose
  // reason ("you generated the least fame") is not derivable from the choice.
  promptText?: string
  // Names the targeting rule in force. Every dismiss below looks the same on
  // screen but constrains a different axis — Butterfly is Caterpillars only,
  // Alligator is one specific stack, Panther/Skunk are the whole board — and
  // the option list alone doesn't say which rule produced it.
  constraintNote?: string
  // Raccoon at a table: hireFromDismissed's options can come from more than
  // one seat's pile (see hireChoices.ts's HireFromDismissedTarget). When
  // both of these are supplied, options are grouped by owner and labeled by
  // name; when either is absent (solo — there's only ever one pile) they
  // render as one flat list, same as every other choice kind.
  nameOf?: (playerId: string) => string
  myPlayerId?: string
}

// Same visual language as the Market panel (Card.tsx's front face — name,
// icon, fame, price/dismiss-cost badge) rather than a plain checkbox/button
// list, so a choice prompt reads as "another market-like picker" instead of
// a form. Every kind but Horse's discardMarketAndRefill resolves on a
// single click (matches applyEffects: each of those is "pick exactly one
// target, or skip"); Horse toggles any number of cards, then confirms once.
//
// EVERY dismiss renders through the one card row below — Butterfly
// (dismissByName), Panther (dismissChosenGridCard), Alligator
// (dismissAlligatorTarget) and, from MatchView, the Skunk. What differs
// between them is the rule, not the shape: which cards are offered (already
// filtered by the engine — hireChoices.ts / phases.ts), whether there is a
// Skip (`choice.mandatory`), and what it costs (`choice.cost`, 0 for the free
// ones, which suppresses the badge). Butterfly used to get a whole <Grid>
// instead; the row keeps position legible through posLabel rather than by
// redrawing the board.
export function EffectChoicePrompt({ cardName, choice, cards, fame, market, onResolve, promptText, constraintNote, nameOf, myPlayerId }: EffectChoicePromptProps) {
  const [selectedSlots, setSelectedSlots] = useState<number[]>([])

  const affordable = choice.kind === 'discardMarketAndRefill' ? true : fame >= choice.cost

  const ruleText = constraintNote ?? defaultConstraintNote(choice, cards)
  const note = ruleText ? <p className="effect-choice__note">{ruleText}</p> : null

  if (choice.kind === 'discardMarketAndRefill') {
    const toggle = (i: number) => setSelectedSlots((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))
    return (
      <div className="effect-choice" data-testid="effect-choice">
        <p className="effect-choice__prompt">{promptText ?? `${cardName}: discard any number of market cards and refill.`}</p>
        {note}
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
        <button type="button" data-testid="effect-choice-confirm" onClick={() => onResolve(selectedSlots)}>
          Discard {selectedSlots.length} card{selectedSlots.length === 1 ? '' : 's'} &amp; refill
        </button>
      </div>
    )
  }

  const isDismiss =
    choice.kind === 'dismissByName' || choice.kind === 'dismissChosenGridCard' || choice.kind === 'dismissAlligatorTarget'

  return (
    <div className="effect-choice" data-testid="effect-choice">
      <p className="effect-choice__prompt">
        {promptText ?? (
          <>
            {cardName}: {choice.mandatory ? 'choose a card to dismiss' : 'you may resolve this ability'}
            {choice.cost === 0 ? '.' : ` for ${choice.cost} fame.`}
          </>
        )}
      </p>
      {note}
      {choice.kind === 'hireFromDismissed' && nameOf && myPlayerId ? (
        groupByOwner(choice.options, myPlayerId).map(([ownerId, group]) => (
          <div className="effect-choice__group" key={ownerId} data-testid={`effect-choice-group-${ownerId}`}>
            <h4 className="effect-choice__group-title">
              {ownerId === myPlayerId ? 'Your dismissed cards' : `${nameOf(ownerId)}'s dismissed cards`}
            </h4>
            <div className="effect-choice__cards">
              {group.map((opt, i) => (
                <Card
                  key={`${opt.cardId}-${i}`}
                  testId={`effect-choice-option-${ownerId}-${i}`}
                  card={cards[opt.cardId]}
                  compact
                  price={choice.cost}
                  unaffordable={!affordable}
                  disabled={!affordable}
                  onClick={() => onResolve(opt)}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="effect-choice__cards">
          {isDismiss &&
            choice.options.map((t, n) => (
              <div className="effect-choice__option" key={`${t.pos.section}-${t.pos.row}-${t.pos.col}-${t.index}`}>
                <Card
                  testId={`effect-choice-option-${n}`}
                  card={cards[t.cardId]}
                  compact
                  dismissCost={choice.cost === 0 ? undefined : choice.cost}
                  disabled={!affordable}
                  onClick={() => onResolve(t)}
                />
                {/* Which one. Two cards of the same name sit on the board all the
                    time — the Season 1 starting deck holds two Caterpillars, and
                    Caterpillar is exactly what Butterfly targets — and the choice
                    between them is not arbitrary, since adjacency drives scoring. */}
                <span className="effect-choice__pos">{posLabel(t.pos, t.index)}</span>
              </div>
            ))}
          {choice.kind === 'hireFromDismissed' &&
            choice.options.map((opt, i) => (
              <Card
                key={`${opt.cardId}-${i}`}
                testId={`effect-choice-option-${i}`}
                card={cards[opt.cardId]}
                compact
                price={choice.cost}
                unaffordable={!affordable}
                disabled={!affordable}
                onClick={() => onResolve(opt)}
              />
            ))}
          {choice.kind === 'hireFromMarketAndRefill' &&
            choice.options.map((i, n) => (
              <Card
                key={i}
                testId={`effect-choice-option-${n}`}
                card={cards[market[i]!]}
                compact
                price={choice.cost}
                unaffordable={!affordable}
                disabled={!affordable}
                onClick={() => onResolve(i)}
              />
            ))}
        </div>
      )}
      {!choice.mandatory && (
        <button type="button" className="effect-choice__skip" data-testid="effect-choice-skip" onClick={() => onResolve('skip')}>
          Skip
        </button>
      )}
    </div>
  )
}

// The rule that produced this option list. Derived from the choice rather than
// passed in, so a caller can't describe a constraint the engine isn't applying;
// Butterfly's target name comes off its own options, which are all one card.
function defaultConstraintNote(choice: PendingChoice, cards: Record<CardId, CardData>): string | null {
  switch (choice.kind) {
    case 'dismissByName': {
      const target = choice.options[0]
      return target ? `${cards[target.cardId].name}s only.` : null
    }
    case 'dismissChosenGridCard':
      return 'Any card on your board.'
    case 'dismissAlligatorTarget':
      return "The stack to the Alligator's right."
    default:
      return null
  }
}

// Groups Raccoon's options by owner, own pile first, then every other seat
// in the order their first offered card appears — stable and independent of
// player-list order, which matters nowhere else but reads oddly if it jumps
// around between renders.
function groupByOwner(options: HireFromDismissedTarget[], myPlayerId: string): [string, HireFromDismissedTarget[]][] {
  const groups = new Map<string, HireFromDismissedTarget[]>()
  for (const opt of options) {
    const ownerId = opt.ownerPlayerId ?? myPlayerId
    const group = groups.get(ownerId)
    if (group) group.push(opt)
    else groups.set(ownerId, [opt])
  }
  const entries = [...groups.entries()]
  entries.sort((a, b) => (a[0] === myPlayerId ? -1 : b[0] === myPlayerId ? 1 : 0))
  return entries
}

function posLabel(pos: GridPos, index: number): string {
  const where = pos.section === 'base' ? `Row ${pos.row + 1} · Col ${pos.col + 1}` : `Above row ${pos.row + 1} · Col ${pos.col + 1}`
  return index > 0 ? `${where} · stacked` : where
}
