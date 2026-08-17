// Seeded PRNG + Fisher-Yates shuffle. Deterministic for a given seed, per
// flip-toonz-structure-plan.md §4: "Randomness comes from a seeded PRNG
// carried inside the state. Given the same seed and the same sequence of
// actions, the game replays identically on any machine."
//
// mulberry32 — small, fast, decent statistical quality for a card game (not
// cryptographic, doesn't need to be).

export type Rng = () => number

export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates, using the supplied Rng for every draw so the result is
// deterministic for a given seed.
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = items.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = result[i]
    result[i] = result[j]
    result[j] = tmp
  }
  return result
}

// --- Pure, state-carrying variants, for GameState (§4.2: "rng: RngState") ---
//
// `makeRng`/`shuffle` above return a stateful closure — fine for the Step-0
// CLI, which builds one deck and throws the Rng away, but wrong for a
// GameState that gets spread-copied every phase transition (`{...state,
// phase: 'checkFame'}` etc.): every copy would share the SAME underlying
// mutable closure, so re-running a phase function against an old state
// snapshot would silently consume more of the sequence and diverge instead
// of reproducing the same result. mulberry32's entire state is one uint32,
// so a pure stepper is cheap: it returns the next value AND the next state
// explicitly, rather than mutating anything captured in a closure.
export type RngState = number

export function initRngState(seed: number): RngState {
  return seed >>> 0
}

// One mulberry32 step, as a pure function of the current state. Mirrors
// makeRng's `next()` body exactly (same algorithm, same output sequence for
// the same seed) so state.ts's RngState-based shuffling stays
// bit-for-bit consistent with the closure-based `makeRng`/`shuffle` the
// existing 113 tests already pin down.
export function stepRng(state: RngState): { value: number; next: RngState } {
  const nextState = (state + 0x6d2b79f5) | 0
  let t = nextState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return { value, next: nextState >>> 0 }
}

// Fisher-Yates using stepRng, threading the state explicitly instead of
// closing over a mutable Rng — same algorithm/order as `shuffle` above.
export function shuffleWithState<T>(items: readonly T[], state: RngState): { result: T[]; next: RngState } {
  const result = items.slice()
  let s = state
  for (let i = result.length - 1; i > 0; i--) {
    const stepped = stepRng(s)
    s = stepped.next
    const j = Math.floor(stepped.value * (i + 1))
    const tmp = result[i]
    result[i] = result[j]
    result[j] = tmp
  }
  return { result, next: s }
}
