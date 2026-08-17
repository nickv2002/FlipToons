import { describe, expect, test } from 'bun:test'
import { makeRng, shuffle } from './rng'

describe('rng', () => {
  test('same seed produces the same sequence', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  test('different seeds produce different sequences', () => {
    const a = makeRng(1)
    const b = makeRng(2)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  test('values are in [0, 1)', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('shuffle', () => {
  test('same seed shuffles a deck identically', () => {
    const deck = ['a', 'b', 'c', 'd', 'e', 'f']
    const shuffled1 = shuffle(deck, makeRng(1234))
    const shuffled2 = shuffle(deck, makeRng(1234))
    expect(shuffled1).toEqual(shuffled2)
  })

  test('shuffle does not mutate the input array', () => {
    const deck = ['a', 'b', 'c']
    const copy = deck.slice()
    shuffle(deck, makeRng(1))
    expect(deck).toEqual(copy)
  })

  test('shuffle is a permutation (same multiset of elements)', () => {
    const deck = ['a', 'b', 'c', 'd', 'e', 'f']
    const shuffled = shuffle(deck, makeRng(99))
    expect(shuffled.slice().sort()).toEqual(deck.slice().sort())
  })
})
