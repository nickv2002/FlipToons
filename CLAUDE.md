# FlipToons — digital adaptation

Digital adaptation of the FlipToons board game (Seasons 1 and 2). Rules model
and architecture were planned up front in `flip-toonz-structure-plan.md`
(rules/architecture) and `flip-toonz-phase0-plan.md` (build-order for the
scoring engine). Both are now historical — implementation has passed well
beyond what they describe. See their status notes at the top before trusting
specifics; treat git log / current code as ground truth over plan prose.

**Current state:** playable end-to-end. Web UI (`make play`) works for both
solo (local, in-browser) and real 2-4 player multiplayer (room codes, seats,
turn order, Final Flip). (A terminal UI existed earlier in development and was
retired in favor of the web UI as the sole interface.) Card transcription
(`cards.csv` → `packages/engine/cards/`) is done for all 62 cards; only
Axolotl and Platypus remain `unencodable: true`, both blocked on the Big
Button mini-expansion rather than on the effect vocabulary.

**Multiplayer was built after an audit found it did not exist.** What the
room-code feature used to be: a hosted *solo* game — one shared `GameState`
that any number of browsers jointly drove, with no player identity, so two
people in a room shared one grid and one fame pool. It is now a real seated
match. Scope is 2-4 players, single season; 5-8 players and combined-season
play are deliberately out of scope but not designed out.

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
  actions.ts            the action-dispatch surface used by both the web client and server
  setup.ts              new-game setup, solo starting-deck construction
  state.ts              GameState shape
  ai.ts                 Monte-Carlo evaluator; self-contained, not yet wired into the web UI
  match.ts              the TABLE: turn order, seat-subset flip/scoring, Cleanup, Final Flip + tiebreak
  matchActions.ts       multiplayer action surface — SEPARATE from actions.ts on purpose (see below)
  roundFame.ts          scoreGrid + player-level modifiers (the Critic's Choice +3)

apps/server/          Bun WS server. Room-code hosted/resumable games.
  rooms.ts               in-memory room state, applies actions from actions.ts
  protocol.ts             wire types shared with apps/web (no Bun-only types allowed)

apps/web/             React + Vite client.
  src/useGame.ts          local solo game state + localStorage save/resume
  src/useMatch.ts         WS client for seated multiplayer rooms (+ reconnect token)
  src/components/         Grid, Slot, Card, Market, effect-choice prompts, Lobby, MatchView

e2e/*.e2e.ts           Playwright browser tests (NOT *.spec.ts — `bun test` claims that suffix)

scripts/*.sh           Wrappers behind the Makefile targets (see Makefile comments)
cards.csv              Verbatim transcription source of truth for card text/rank/fame
Referance/*.HEIC        Photos of the physical rulebook/cards (transcription source)
```

## Running things

`make help` lists targets. Common ones:

- `make play` — web client + WS server together (room-code hosted games)
- `make web` — web client only, local solo, no server
- `make stop` — kill any repo process this Makefile started (web/server)
- `make test` — `bun test` from repo root
- `make typecheck` — `bunx tsc --noEmit -p .`
- `make e2e` — Playwright browser tests; starts both servers itself

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

## Multiplayer invariants

- **`PlayerState` + `SharedState`, joined into a transient `PlayerView`.**
  There is exactly ONE copy of the shared state (`match.shared`); a
  `PlayerView` is a projection that lives for the duration of one action. The
  discipline is project (`viewOf`) → mutate → commit (`commitView`) →
  re-project, enforced at runtime by `viewEpoch`. Never hold two views at
  once. Because the field partition is clean, a `PlayerView` is structurally
  identical to the old flat `GameState` — which is why `phases.ts` and
  `flip.ts` are unchanged and why the web UI renders a seat's board through
  the same `RoundView` solo uses.
- **`matchActions.ts` must not import from `actions.ts`.** Three things
  `actions.ts` does are solo house rules that are wrong at a table:
  `checkInstantWin` (ends the game the moment fame hits the threshold,
  overriding the rulebook's "the trigger round still plays its full Market
  phase"), the `isGuaranteedLoss` family, and the atomic flip cascade.
- **The Critic's Choice +3 never enters `scoreGrid`.** It composes on top via
  `roundFame.ts`. `architecture.test.ts` greps `score.ts` to keep it that way.
  The bonus gates on `shared.endgameTriggered`, NOT `phase === 'finalFlip'` —
  the flip hands off by setting `phase: 'checkFame'`, so the phase no longer
  reads `finalFlip` by the time anyone is scored.
- **The acting player comes from `SocketData.seat`.** The `action` message
  carries no `playerId`; a client-asserted one would let anyone act as anyone.
- **Adding a field to `PlayerState`?** Add it to `PLAYER_FIELDS` in `state.ts`
  too. There is a compile-time guard that will name it if you forget —
  `satisfies` alone does not catch omissions, and a missing key is silently
  dropped on every commit.
- **No cumulative score anywhere.** Fame is one per-round number that is at
  once your score, your spending power, and expiring. The rules keep no
  running tally; don't invent one in the UI.

## Testing

388 tests across 19 files (engine + `apps/server/rooms.test.ts`), plus 11
Playwright browser tests in `e2e/`.
Fixture-style tests assert `scoreGrid`/`flip`/`phases` behavior directly —
there's no separate fixture corpus (`flip-toonz-phase0-plan.md`'s
oracle/fixtures design was superseded; tests just assert expected values
inline). `apps/server/rooms.test.ts` runs a real `Bun.serve` over real WebSockets —
seat assignment, reconnect-by-token, and turn enforcement only exist at that
layer. `e2e/` drives two browsers through a whole 2-player game; run `make e2e`
after any web change. Solo has its own browser spec because every multiplayer
spec clicks straight past that screen.
