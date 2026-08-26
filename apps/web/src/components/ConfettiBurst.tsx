import { useState, type CSSProperties } from 'react'

const PIECE_COUNT = 70

export function ConfettiBurst() {
  const [pieces] = useState(() =>
    Array.from({ length: PIECE_COUNT }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.6 + Math.random() * 0.8,
      rotate: Math.random() * 360,
      drift: (Math.random() - 0.5) * 60,
      variant: i % 5,
    })),
  )

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className={`confetti__piece confetti__piece--${p.variant}`}
          style={
            {
              left: `${p.left}%`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              '--confetti-rotate': `${p.rotate}deg`,
              '--confetti-drift': `${p.drift}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
