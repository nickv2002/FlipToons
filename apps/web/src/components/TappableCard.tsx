import { Card, type CardProps } from './Card'
import { useDoubleTap } from '../useDoubleTap'
import type { ZoomRequest } from './CardZoomSheet'

// Shared by Slot.tsx and Market.tsx: in touch mode, a single tap on an
// actionable card opens the zoom sheet instead of firing hire/dismiss
// directly, and a double-tap fires the action immediately, bypassing the
// sheet. Wraps Card rather than adding touch-mode state to it, so Card stays
// a dumb rendering component. useDoubleTap must be called unconditionally
// (a slot's card count can change between renders when a stack forms), so
// this exists as its own component rather than being inlined into a .map().
export type TappableCardProps = CardProps & {
  touchMode?: boolean
  onZoom?: (req: ZoomRequest) => void
  // Only set when this card has an action to offer the zoom sheet — omit to
  // fall back to firing `onClick` directly even in touch mode (e.g. a card
  // with no click handler at all).
  zoomRequest?: ZoomRequest
}

export function TappableCard({ touchMode, onZoom, zoomRequest, ...cardProps }: TappableCardProps) {
  const action = cardProps.onClick
  const doubleTapHandler = useDoubleTap(
    () => zoomRequest && onZoom?.(zoomRequest),
    () => action?.(),
  )
  // zoomRequest can exist with no action at all (a card you can't afford —
  // the sheet just won't offer a button for it), so routing through the
  // double-tap gate only requires touchMode + zoomRequest, not `action` too:
  // that's what keeps an unaffordable card tappable-for-viewing instead of
  // falling through to a plain `undefined` onClick.
  const effectiveOnClick = touchMode && zoomRequest ? doubleTapHandler : action
  return <Card {...cardProps} onClick={effectiveOnClick} />
}
