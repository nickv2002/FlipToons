# Season 2 solo win-rate gap — investigation findings

Season 2's solo AI win rate has consistently trailed season 1's. This
document records what was ruled out, what was confirmed, and what remains an
accepted (not fixed) characteristic. Written after a session of controlled
benchmarking via `ai/bench.ts` and throwaway scratch scripts (not committed —
see `.claude/scratch/` locally if repeating this work).

## Ruled out

- **Return-to-deck effects** (Coyote/Zebra/Crab) are near-neutral or positive
  slot-preserving swaps, not a depletion mechanic. Not the cause.
- **Season 2 needing a bigger Monte Carlo search budget.** A season-aware
  budget bump (300 sims for season 2, 150 for season 1) was tried and
  explicitly rejected as papering over a heuristic gap rather than fixing it.
  It was removed; both seasons now share a flat 150/150 budget
  unconditionally.
- **Under-powered search generally.** A 10x budget probe (1500/1500 sims,
  paired seeds, forced starting deck, n=40/100) made the season-2-start
  condition *worse* (47.5% win rate, with 21/40 games failing to terminate
  at all within the step cap) rather than better. More search does not fix
  this gap — ruling out "the AI just needs to think harder."

## Confirmed

- **Toon/market deck depletion is the sole loss condition in solo play.**
  With an unbounded deck there is no way to lose. Every AI loss observed
  across hundreds of benchmark games was a depletion loss — zero "other"
  causes. This makes starting deck size the dominant difficulty lever,
  independent of season or card composition.
- **A real, working heuristic fix**: `deckConservationSignal` in
  `heuristic.ts` (weight `DECK_CONSERVATION_WEIGHT = 0.2`) — biases WHICH
  card gets dismissed once the toon deck is running low, crediting
  dismissing already-worthless cards over valuable ones. Verified: no
  regression to season 1 or `'both'` (bit-for-bit at the tested seed count),
  season 2 alone improved 57.5% -> 65.0% on the 40-seed bench.
- **The season-2-start vs season-1-start gap is a genuine deck-composition
  characteristic**, not an AI weakness. Both starting decks carry the same
  total base fame (3), but their dead-weight cards differ in how cheap they
  are to clear:
  - Season 1: three Caterpillars, `dismissCost: 3` flat, unconditional, on
    every copy.
  - Season 2: three Mosquitoes, no discount field — full sticker dismiss
    cost unless positioned adjacent to the single Ladybug on the board
    (discounts to 3). With 3 Mosquitoes and 1 Ladybug in a 6-slot grid, at
    most a fraction of them can ever get that discount, and only if the AI
    (or a human player) actively sets up the adjacency.

  This was validated with a paired, forced-starting-deck experiment against
  the identical combined card pool (season identity and pool composition
  held constant, only the starting deck shape varied) — see the table below.
  The gap survived a 10x search-budget probe (see "Ruled out" above),
  confirming it's not a search-depth problem.

- **A "reward positioning a discount card next to dead weight before
  dismissing it" heuristic signal was tried and did not generalize.**
  `heuristic.ts`'s `deadWeightDismissCostPenalty` (weight
  `DEAD_WEIGHT_DISCOUNT_WEIGHT`) already does exactly this — it's
  adjacency-discount-aware via `phases.ts`'s `dismissCostFor`. At weight
  0.05 it looked like a real win on the narrow paired test (season-2-start
  67.5% -> 72.5%, season-1-start unchanged at 87.5%, n=40), but the full
  `ai/bench.ts` suite at n=100 against each season's own real card pool told
  a different story: season 1 alone *dropped* 82.5% -> 77.0% (a real loss,
  not noise) while season 2 alone stayed flat (57.0%, no real gain). The
  narrow paired test's combined pool isn't a valid proxy for either season's
  real pool — season 1 has its own dead-weight card (Caterpillar) that the
  same signal also penalizes, to its detriment. Weight was reverted to 0;
  the finding and both measurement passes are documented directly in
  `heuristic.ts`'s comment above the constant.

## Starting deck size vs. win rate

The core relationship: win rate as a function of the actual starting
toon/market deck size (post solo-exclusion — Pig, and Big-Button cards when
the mini-expansion is off — post difficulty trim). This is the real
mechanical "game clock," not an abstract trim target.

| condition ↓ / starting deck size → | 36 (n=40) | 35 (n=100) | 33 (n=40) | 32 (n=40) | 30 (n=40) | 25 (n=40) |
|---|---|---|---|---|---|---|
| season 1 alone | 90.0 | 92.5 | 82.5 | 82.5 | 65.0 | 22.5 |
| season 2 alone | 82.5 | 77.5 | 65.0 | 45.0 | 32.5 | 12.5 |
| both, S1-start | 95.0 | 90.0 | 75.0 | 77.5 | 70.0 | 20.0 |
| both, S2-start | 87.5 | 72.0 | 67.5 | 52.5 | 40.0 | 7.5 |

Notes:
- The 35 column is backed by n=100 (a paired, forced-starting-deck
  validation run); every other column is n=40 and carries wider error bars.
- Every row falls off a similar cliff as deck size shrinks — pool size
  dominates win rate far more than season identity or starting-deck shape.
- At matched deck size, season 2's natural disadvantage is that its
  untouched pool (33 cards at normal difficulty) sits further down this
  shared curve than season 1's (32 cards) — a one-card difference in pool
  composition, not a search or heuristic deficiency.
- Within `'both'` mode specifically, the S1-start/S2-start gap (see
  "Confirmed" above) persists at every deck size and is driven by starting
  *deck* composition, independent of which season's market pool is mixed in.

## Open, not pursued further this session

- Whether a more carefully-scoped positioning signal (e.g. one that doesn't
  also fire on season 1's Caterpillar, or that only credits Mosquito-shaped
  cards structurally rather than any `isDeadWeight` card) could isolate the
  season-2-specific benefit without season 1's collateral cost. Not
  attempted — the generic, name-free signal was the one built and it did not
  generalize; a more targeted version would need its own validation pass at
  n=100 against real per-season pools before trusting any narrow-test win.
- The season-2 solo starting deck itself (`buildSeason2SoloStartingDeck` in
  `setup.ts`) is flagged in that file as an *inferred*, not confirmed,
  composition — no photographed rulebook page states it directly. If a
  Season 2 solo setup card ever turns up, the deck composition (and
  therefore this whole gap) may need to be revisited from scratch.
