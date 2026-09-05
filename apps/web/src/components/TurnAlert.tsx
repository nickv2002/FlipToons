import { useEffect, useRef, useState } from 'react'

const SOUND_URL = '/audio/card-shuffle.ogg'
const VISIBLE_MS = 1400

export type TurnAlertProps = {
  active: boolean
}

// Fires only on an observed false -> true transition of `active`, never on
// mount — a page load or reconnect that lands mid-turn isn't a turn arriving.
export function TurnAlert({ active }: TurnAlertProps) {
  const [show, setShow] = useState(false)
  const wasActive = useRef(active)

  useEffect(() => {
    if (active && !wasActive.current) {
      setShow(true)
      new Audio(SOUND_URL).play().catch(() => {})
      const timer = setTimeout(() => setShow(false), VISIBLE_MS)
      wasActive.current = active
      return () => clearTimeout(timer)
    }
    wasActive.current = active
  }, [active])

  return (
    <div className={`turn-alert${show ? ' show' : ''}`} onClick={() => setShow(false)}>
      <div className="turn-alert__card">Your turn</div>
    </div>
  )
}
