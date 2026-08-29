import type { ReactNode } from 'react'
import type { Card as CardData, CardId } from '../../../../packages/engine/cards/types'
import type { Grid as GridData, GridPos } from '../../../../packages/engine/types'
import type { DismissEntry } from '../../../../packages/engine/actions'
import { Grid } from './Grid'
import { CounterChip } from './CounterChip'
import type { ZoomRequest } from './CardZoomSheet'

// One definition of "a board on this table", so your grid and everyone else's
// are drawn by the same code rather than by two layouts that drifted apart.
//
// The previous opponent rendering was a bare <Grid> in an unstyled <div> with
// a "deck 4 · dismissed 1" text run underneath, while your own board sat in a
// framed pane with a heading and a styled deck count. Same cards, two
// presentations — which read as two different kinds of thing.
export type BoardPaneProps = {
  title: ReactNode
  grid: GridData
  cards: Record<CardId, CardData>
  // Cards left undrawn in THIS board's own deck (per-player; the toon deck the
  // market refills from is shared and belongs to the market pane, not here).
  deckCount: number
  // Interactive (your board, your turn) only — see Slot.tsx.
  dismissEntries?: DismissEntry[]
  onDismiss?: (pos: GridPos, index: number) => void
  fame?: number
  readOnly?: boolean
  // Dismissed-pile count + opener, rendered in the heading next to the deck
  // count — every player's dismissed pile is public (§3.3a), so this is
  // shown for every board, not just an opponent's. It lives in the heading
  // (never dimmed — see round-view__grid-body--inactive below) rather than
  // under the grid, so it stays clickable and legible even when this board
  // isn't the active seat's.
  dismissedCount?: number
  onShowDismissed?: () => void
  // Makes the deck chip open a list of this deck's remaining cards. Your own
  // board only: an opponent's undrawn deck is not viewable, so theirs stays an
  // inert chip and must not look pressable. This is where the old
  // "Remaining deck (N)" button from the round header moved to — the count and
  // the control that opens what it counts are now one object.
  onShowDeck?: () => void
  // The Big Button mini-expansion's per-player component. Undefined means the
  // expansion is not in play and NOTHING renders — same load-bearing default
  // as SharedState.resetEffect being null.
  //
  // Rendered for EVERY board, opponents included: the state is public and
  // load-bearing. Platypus flips every seat's button face up, and the
  // gridReset walk is asking who still holds one.
  bigButtonFaceUp?: boolean
  // False replays no deal-in animation on this render — for a board that's
  // redrawing because of a same-round face toggle (a dismiss-choice prompt
  // resolving, another player's flip effect) rather than an actual new deal.
  // Defaults true so callers outside the round loop (the ended screen's final
  // grid) don't need to think about it.
  animateDeal?: boolean
  // This is the viewer's own board, as opposed to an opponent's — a left
  // accent border / heading tint, independent of whose turn it is.
  isOwn?: boolean
  // The active seat's board right now (Market phase only) — undimmed.
  // Independent of `isOwn` so the two compose: a board can be own-and-
  // inactive, opponent-and-active, etc. Undefined/true means "don't dim"
  // (solo has no "not your turn" concept).
  isActive?: boolean
  // Per-slot "fame generated this round" lookup — see Grid/Slot/Card.
  roundFame?: (pos: GridPos, stackIndex: number) => number | undefined
  // Touch UI mode (settings.ts): a single tap on an actionable card opens a
  // zoom sheet instead of firing hire/dismiss directly. `onZoom` bubbles the
  // tapped card (plus its available action, if any) up to the caller, which
  // owns rendering the CardZoomSheet itself.
  touchMode?: boolean
  onZoom?: (req: ZoomRequest) => void
  // Disables the Grid's own dismiss clicks (e.g. it isn't this seat's turn).
  // Scoped to a fieldset around the grid body ONLY — never the heading —
  // because a fieldset's `disabled` cascades to every descendant button
  // regardless of nesting, and the heading's dismiss-pile button must stay
  // clickable throughout (viewing a public pile isn't a turn action).
  controlsDisabled?: boolean
}

export function BoardPane({ title, grid, cards, deckCount, dismissEntries, onDismiss, fame, readOnly, dismissedCount, onShowDismissed, onShowDeck, bigButtonFaceUp, animateDeal = true, isOwn, isActive = true, roundFame, touchMode, onZoom, controlsDisabled }: BoardPaneProps) {
  const className = `round-view__grid-pane${isOwn ? ' round-view__grid-pane--own' : ''}`
  // Only the grid itself dims for "not this seat's turn" — the heading (deck
  // count, dismissed-pile button) sits outside round-view__grid-body so it
  // stays fully legible and clickable regardless of whose turn it is.
  const bodyClassName = `round-view__grid-body${isActive ? '' : ' round-view__grid-body--inactive'}`
  return (
    <div className={className}>
      <div className="round-view__grid-heading">
        <h2>{title}</h2>
        <div className="round-view__chips">
          <CounterChip
            label="Deck"
            value={deckCount}
            tone="accent"
            title="Cards left undrawn in this player's deck"
            onClick={onShowDeck}
          />
          {onShowDismissed && (
            <CounterChip label="Dismissed" value={dismissedCount ?? 0} onClick={onShowDismissed} title="Dismissed cards are public — anyone may look" />
          )}
          {bigButtonFaceUp !== undefined && (
            <CounterChip
              label="Big Button"
              value={bigButtonFaceUp ? 'ready' : 'used'}
              tone={bigButtonFaceUp ? 'warning' : 'neutral'}
              title={bigButtonFaceUp ? 'Face up — the reset effect is still available' : 'Face down — already used this game'}
              testId="big-button-chip"
            />
          )}
        </div>
      </div>
      <fieldset className={bodyClassName} disabled={controlsDisabled}>
        <Grid
          grid={grid}
          cards={cards}
          dismissEntries={dismissEntries}
          onDismiss={onDismiss}
          fame={fame}
          readOnly={readOnly}
          animateDeal={animateDeal}
          roundFame={roundFame}
          touchMode={touchMode}
          onZoom={onZoom}
        />
      </fieldset>
    </div>
  )
}
