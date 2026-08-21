# FlipToons — digital adaptation

Digital adaptation of the FlipToons board game (Seasons 1 and 2). Rules model
and architecture were planned up front in `flip-toonz-structure-plan.md`
(rules/architecture) and `flip-toonz-phase0-plan.md` (build-order for the
scoring engine). Both are now historical — implementation has passed well
beyond what they describe. See their status notes at the top before trusting
specifics; treat git log / current code as ground truth over plan prose.

**Current state:** playable end-to-end. Web UI (`make play`) and terminal UI
(`make solo`) both work — solo, AI-autoplay, and room-code hosted multiplayer
via the WS server. Card transcription (`cards.csv` → `packages/engine/cards/`)
is done for all 62 cards; a handful are still `unencodable: true` (verbatim
text preserved, not yet expressible in the effect vocabulary — grep for it).
Active work right now is *honing the rules engine against real play*: recent
commits are card-ability corrections and reminder-text fixes found by playing
actual games (e.g. stacking-target wording, adjacency-bonus scope), not new
architecture.

## Layout

```
packages/engine/     Pure TS, zero runtime deps. The rules engine.
  types.ts             Card, Grid, Slot schema
  cards/                season1.ts, season2.ts, index.ts — the 62-card table
  grid.ts               3x2 board + extra row, stacks, adjacency
  score.ts              scoreGrid(grid) -> itemized FameBreakdown (pure, grid-only)
  flip.ts               shuffle/reveal/placement-effects loop
  market.ts             market slots, pricing, refill/decay
  hireChoices.ts        player-resolved effect choices (which card to target, etc.)
  phases.ts             phase state machine: Flip -> Check Fame -> Market -> Cleanup
  actions.ts            the action-dispatch surface used by both TUI and server
  setup.ts              new-game setup, solo starting-deck construction
  state.ts              GameState shape
  ai.ts                 Monte-Carlo evaluator for AI autoplay
  cli.ts / tui.ts        terminal entry points

apps/server/          Bun WS server. Room-code hosted/resumable games.
  rooms.ts               in-memory room state, applies actions from actions.ts
  protocol.ts             wire types shared with apps/web (no Bun-only types allowed)

apps/web/             React + Vite client.
  src/useGame.ts          local solo game state + localStorage save/resume
  src/useRemoteGame.ts    WS client for room-code hosted games
  src/components/         Grid, Slot, Card, Market, effect-choice prompts, etc.

scripts/*.sh           Wrappers behind the Makefile targets (see Makefile comments)
cards.csv              Verbatim transcription source of truth for card text/rank/fame
Referance/*.HEIC        Photos of the physical rulebook/cards (transcription source)
```

## Running things

`make help` lists targets. Common ones:

- `make play` — web client + WS server together (room-code hosted games)
- `make web` — web client only, local solo, no server
- `make solo` / `make solo-season2` — terminal UI, interactive
- `make solo-ai` — full AI autoplay from the CLI, no human input
- `make stop` — kill any repo process this Makefile started (web/server/TUI)
- `make test` — `bun test` from repo root
- `make typecheck` — `bunx tsc --noEmit -p .`

Pass extra flags via `ARGS`, e.g. `make solo ARGS="--seed=1 --difficulty=hard"`.

Toolchain is **bun** — runtime, package manager, test runner. No node/npm/tsx.

## Engine invariants worth knowing before editing

- **Fame is a pure function of the finished grid.** `scoreGrid` takes only a
  grid and returns an itemized breakdown (per-slot base + bonuses), never a
  running total mutated during play. Placement abilities (`onPlace`) only
  mutate the board — they never grant fame directly.
- **Board is fixed 3x2 (six slots)**, filled left-to-right / top-then-bottom,
  plus an optional extra row (Monkey relocation) and stacks (two cards sharing
  a slot). Six *occupied* slots ends the draw — stacks/extra-row cards extend
  it because the six base slots aren't yet full, not because new slots exist.
- **No `discard`.** Zones are deck / grid / dismissed. Cleanup returns the
  grid to the deck and reshuffles; dismissed cards sit face-up outside the
  game.
- **Cost is emergent from market position** (price card above the slot,
  cards sorted into slots by rank), not a field on the card.
- **Critic's Choice breaks grid-purity on purpose**: `scoreGrid` stays
  grid-only; `roundFame = scoreGrid + playerFameModifiers` is a separate seam
  layered on top for the +3 Final Flip bonus.
- Card data changes always start in `cards.csv` (verbatim transcription),
  then get encoded into `packages/engine/cards/season{1,2}.ts`. Run
  `bun test` after any card-data edit.

## Testing

267 tests across 14 files, all engine-side (`packages/engine/*.test.ts`).
Fixture-style tests assert `scoreGrid`/`flip`/`phases` behavior directly —
there's no separate fixture corpus (`flip-toonz-phase0-plan.md`'s
oracle/fixtures design was superseded; tests just assert expected values
inline). No web/server test suite yet — verify web/server changes by running
`make play` and playing a game.
