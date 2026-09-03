import { useState } from 'react'
import type { SeatInfo } from '../../../worker/protocol'

const EXPLANATION =
  "Bot moves are calculated on the host's device, not the server — harder difficulties (Extreme especially) take noticeably more computation and time. If you're using tougher or multiple bots, hosting from a desktop-class computer rather than a phone or tablet is recommended."

export type BotPerfInfoProps = {
  bots: SeatInfo[]
}

// Mirrors TouchModeToggle's info-button pattern. Turns red when the perf cost
// this warns about is actually likely: an Extreme bot, or more than one bot
// sharing the host's compute.
export function BotPerfInfo({ bots }: BotPerfInfoProps) {
  const [show, setShow] = useState(false)
  const alert = bots.some((b) => b.botDifficulty === 'extreme') || bots.length > 1

  return (
    <span className="bot-perf-info-wrap">
      <button
        type="button"
        className={'bot-perf-info__hint' + (alert ? ' bot-perf-info__hint--alert' : '')}
        aria-label="How are bot moves calculated?"
        aria-expanded={show}
        data-testid="bot-perf-hint-button"
        onClick={() => setShow((v) => !v)}
      >
        ⓘ
      </button>
      {show && (
        <span className="bot-perf-info__popover" data-testid="bot-perf-hint" role="tooltip">
          {EXPLANATION}
        </span>
      )}
    </span>
  )
}
