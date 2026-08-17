# FlipToons Phase 0 — Rules Engine + Human-Oracle Test Loop

> **Status:** approved, not started. Planning artifact only — no implementation yet.
>
> **Companion document:** `flip-toonz-structure-plan.md` holds the full rules model and overall architecture. Section references below (§3.5, §4.4, §4.5, §7, …) point there.

## Context

`flip-toonz-structure-plan.md` is a settled architecture plan for a digital FlipToons adaptation, reconciled against the official rulebook. No code exists yet.

The hard part of this game is not the phase machine — it's the cards. Fame is a pure function of the finished grid, every card scores differently, and the rulebook prints no per-card ability text, so the card table has to be transcribed by hand from the physical cards. Transcription errors are silent: a mis-encoded card produces a plausible-looking number, and nothing catches it.

Phase 0 solves that by making Nick the oracle. The engine generates a grid, a CLI asks him what each card scores, and his answers become permanent regression fixtures. Once enough ground truth exists, the loop inverts: the engine proposes a score and he confirms or denies. That gives us a verified card table and a verified scorer before any UI, phase machine, or market logic exists — and the same harness verifies every new card as it's transcribed.

**Scope:** a scoring engine and the oracle CLI. No market, no rounds, no fame reset, no endgame, no web UI.

## Decisions

- **Pass A is scoring only; Pass B adds the flip loop.** Nail `scoreGrid` against Nick's numbers first, with grids constructed directly. Then build shuffle/placement-effects/stacking/Monkey as a second pass. Keeps one variable moving: a wrong number in Pass B can only be a placement bug, because scoring is already trusted.
- **The oracle is a CLI Nick runs himself** (`bun oracle`), not a chat loop — so he can add cases in bulk without a session open.
- **Grids are reachable by default**, with `--arbitrary` to force rare configurations. Every fixture records which kind it is.

## Pass A — scoring engine + oracle CLI

### Layout

**Toolchain: bun** — runtime, package manager, and test runner. No `tsx`, no `ts-node`, no separate test framework: bun runs TypeScript directly and `bun test` is built in. That removes three dependencies and the usual TS-in-Node startup friction from phase 0 entirely.

Two notes on the fit. The engine stays **plain TypeScript with zero dependencies**, so nothing here binds the eventual React client to bun — Vite can compile the same source unchanged, and `bun test`'s API is Jest-shaped and close enough to Vitest that moving either direction later is mechanical. And `@clack/prompts` runs fine under bun, so the oracle's select UI is unaffected.

```
package.json                  # bun workspace, TS 5.x
bunfig.toml
packages/engine/              # ZERO runtime dependencies
  types.ts                    # Card, Grid, Slot, FameRule, FameBreakdown
  rng.ts                      # seeded PRNG (mulberry32 or xorshift128)
  grid.ts                     # 3x2 base + extra row, stacks, adjacency, isFull
  score.ts                    # scoreGrid(grid) -> itemized FameBreakdown
  cards/
    season1.ts  season2.ts  index.ts
tools/oracle/                 # CLI — deps allowed here, never in engine
  render.ts  generate.ts  prompt.ts  fixtures.ts  cli.ts
fixtures/*.json               # the growing regression corpus
```

The zero-dependency rule applies to `packages/engine` only. The CLI uses `@clack/prompts` for the select UI.

### Card data

Encode Season 1's six starting cards from `flip-toonz-structure-plan.md` §4.5 — they're already known, so Pass A can begin before the card list arrives. Schema per §4.4: `{ id, name, season, rank, fame, onPlace?, onHire?, onDismiss?, dismissCost?, postFameHook? }`.

`FameRule` is a base value plus bonus terms over grid queries (`uniqueAdjacentName`, `inCenterColumn`, …). Grow the query vocabulary only when a card can't be expressed; every addition needs a fixture proving it.

### `scoreGrid`

Pure, grid-only, returns itemization — not just a total:

```ts
scoreGrid(grid): { total: number, lines: { slot, cardId, base, bonuses: {reason, n}[] }[] }
```

Per-card itemization is the whole point of asking Nick for per-card numbers. A total-only mismatch tells you the game is wrong; a per-card mismatch tells you *which card* is wrong, which separates "the card data is mis-transcribed" from "the scorer has a bug."

Do **not** put the Critic's Choice +3 here (§3.2.1) — that's `roundFame`, and it doesn't exist until the phase machine does.

### Grid generation

**Reachable (default).** In Pass A this is just shuffle-and-deal: none of the six starting cards has a placement ability, so a reachable grid is six cards from one legal deck in flip order. Cheap and honest. When effect-bearing market cards enter the corpus before Pass B exists, generate them hand-built and tag `reachable: false` — reachability for those needs the flip engine.

**`--arbitrary`.** Any grid the model permits, plus `--force <cards>` to guarantee specific cards appear. Reaches a three-Dragonfly adjacency chain immediately instead of waiting on the shuffle.

**Coverage-guided.** Track which `(card, adjacency-signature)` pairs the corpus already covers and bias generation toward uncovered ones. Uniform random repeats trivial cases; after ten grids of Bees and Snails, the marginal case is worth nothing.

### Terminal rendering

One renderer, reused by `oracle`, `verify`, and `predict`:

```
Case 003  ·  seed 8814  ·  reachable
┌─────────┬─────────┬─────────┐
│ Bee     │Dragonfly│ Snail   │  row 0
│ Snail   │Caterpil.│ Skunk   │  row 1
└─────────┴─────────┴─────────┘
```

Must show: slot coordinates, stacks (all face-up members, face-down marked), the extra row when occupied, and empty slots as distinct from absent ones. A partial grid is a legal state (short deck, §3.5) and has to render unambiguously.

### The oracle loop

```
$ bun oracle --count 10
```

Per case: render the grid → one multiple-choice prompt per card (`0 1 2 3 … other` for a free-text number) → one free-form comment at the end for anything the number doesn't capture (special effects, "this card also does X", "this board is impossible") → write the fixture. Prompt in a fixed slot order so it's mechanical.

The trailing comment is load-bearing: it's where a mis-transcribed *ability* surfaces, as opposed to a mis-transcribed number. Store it in the fixture and surface it in `verify` output.

### Fixture schema

```json
{
  "id": "case-003",
  "seed": 8814,
  "reachable": true,
  "grid": { "base": [["bee","dragonfly","snail"],["snail","caterpillar","skunk"]],
            "extraRow": [null, null, null] },
  "expected": { "perCard": { "r0c0": 1, "r0c1": 2, "r0c2": 2,
                             "r1c0": 2, "r1c1": 0, "r1c2": 0 }, "total": 7 },
  "source": "human",
  "comment": "dragonfly counts bee + snail as distinct, caterpillar doesn't add"
}
```

`source: "human"` = Nick computed it blind. `source: "confirmed"` = engine proposed, Nick approved. Keep them distinguishable — blind cases are stronger evidence, and if the corpus ever drifts you want to know which cases were independent.

### Commands

| Command | Purpose |
|---|---|
| `bun oracle` | Generate cases, prompt Nick, write fixtures |
| `bun verify` | Score every fixture, diff against expected, print the itemized breakdown for mismatches |
| `bun predict` | Engine scores a fresh grid, shows its reasoning, Nick confirms or denies |
| `bun test` | Run the fixture corpus |

`predict` is the second-stage loop. One caution designed in: confirming is cheaper than computing, so it's also easier to rubber-stamp. `predict` therefore asks **blind** for any card whose `(card, adjacency-signature)` is untested, and only shows-then-confirms for combinations already covered. Novel interactions — the ones most likely to be wrong — never get a suggested answer to anchor on.

### Test harness

One `bun test` file that loads every fixture and asserts `scoreGrid` matches per-card and total. Adding a case is adding a JSON file — no test code to write. Plus unit tests for adjacency (orthogonal only, no diagonals, stack members adjacent to neighbors) and for partial grids.

## Pass B — the flip loop

Once scoring is trusted: seeded shuffle, flip into the next unoccupied slot in reading order, placement effects fire before the next reveal, fill until six slots are **occupied** (stacks and Monkey relocation extend the draw), partial grid on a short deck.

The oracle inverts here — scoring is settled, so what Nick checks is the **arrangement**: given this deck and seed, did the cards land where they should? Same renderer, different question. Fixtures become `{ seed, deck } → expected grid`.

This is also where §7's assumptions get tested against reality: which card the Monkey moves, whether Ostrich/Eagle stop reveals, whether the Snake stacks the next reveal.

## Open dependency

**The card list.** Nick is preparing it as a separate file. Pass A can start now on the six starting cards; market cards get transcribed and verified through the same loop as they arrive. Expect transcription to answer most of §7 — the Monkey, Skunk, Dragonfly, and Caterpillar readings — as a side effect.

Worth noting: the two duplicate Caterpillars in the starting deck make Pass A a direct discriminator for §7 question 4c. A grid with a Dragonfly adjacent to both scores differently under the two readings of "unique," so Nick's number settles it.

## Verification

- `bun test` — green over the whole fixture corpus; every card in the table has at least one fixture exercising it.
- `bun verify` after any card-data edit — catches a transcription regression immediately, with the itemized diff naming the card.
- **Hand-check three grids** covering: a Dragonfly with mixed adjacent names, a partial grid from a short deck, and a grid with an occupied extra row. These are the cases where the model is most likely to be subtly wrong.
- Adjacency unit tests: diagonals excluded, stack members adjacent to neighboring slots, extra-row card adjacent to the base card below it.
- Determinism: the same seed reproduces the same grid across runs and machines.
- After Pass B: a fuzz run of many random decks asserting no crash, no infinite flip loop, and that every completed grid has six occupied base slots or a documented reason it doesn't.
