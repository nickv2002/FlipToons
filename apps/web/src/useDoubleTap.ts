import { useCallback, useRef } from 'react'

// Shared by Slot.tsx and Market.tsx for touch mode: a single tap opens the
// zoom sheet, a double-tap performs the action directly, bypassing it. Plain
// click-timing detection works for both mouse and touch, since both fire
// `click` — no separate touch-event handling needed.
export function useDoubleTap(onSingleTap: () => void, onDoubleTap: () => void, delayMs = 300) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  return useCallback(() => {
    // A pending timer IS the "was there a first tap" signal. An earlier
    // version compared Date.now() timestamps instead, which broke whenever
    // two clicks landed in the same millisecond (routine for a scripted/fast
    // double-click): the diff came out to exactly 0, failing a `> 0` guard,
    // so the second click registered as its own fresh "first tap" and both
    // taps' timers went on to fire the single-tap action instead of one
    // double-tap firing the action directly.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      onDoubleTap()
    } else {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onSingleTap()
      }, delayMs)
    }
  }, [onSingleTap, onDoubleTap, delayMs])
}
