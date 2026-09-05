import { useEffect, useRef, useState } from 'react'

const SOUND_URL = '/audio/card-shuffle.ogg'
const VISIBLE_MS = 1400

export type TurnAlertProps = {
  active: boolean
  // Identifies this particular turn (e.g. `${round}:${activePlayerIndex}`).
  // A server broadcast can collapse several phase transitions into one
  // message — auto-ending a turn for lack of legal actions and dealing the
  // next turn in the same tick — so `active` can go true -> true across two
  // genuinely different turns with no observable false in between. Keying
  // on this instead of diffing the boolean is what catches that case.
  turnKey: string
}

// Fires whenever `active` is true and `turnKey` differs from the last turn
// this alerted for — never on mount, and never twice for the same turn — a
// page load or reconnect that lands mid-turn isn't a turn arriving.
export function TurnAlert({ active, turnKey }: TurnAlertProps) {
  const [show, setShow] = useState(false)
  const lastFiredKey = useRef(turnKey)

  useEffect(() => {
    if (active && turnKey !== lastFiredKey.current) {
      setShow(true)
      new Audio(SOUND_URL).play().catch(() => {})
      const timer = setTimeout(() => setShow(false), VISIBLE_MS)
      lastFiredKey.current = turnKey
      return () => clearTimeout(timer)
    }
  }, [active, turnKey])

  return (
    <div className={`turn-alert${show ? ' show' : ''}`} onClick={() => setShow(false)}>
      <div className="turn-alert__card">Your turn</div>
    </div>
  )
}
