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
(`cards.csv` → `packages/engine/cards/`) is done for all 62 cards, and as of
the Big Button mini-expansion pass **nothing is `unencodable` any more** —
Axolotl and Platypus were the last two, and both were blocked on that
component rather than on the effect vocabulary.

**The Big Button mini-expansion is implemented but OFF BY DEFAULT.**
`SharedState.resetEffect` is `null` unless a caller asks for it, and that
null is load-bearing: with it, the new `gridReset` phase is unreachable, both
Big Button toon cards stay excluded from every deck, and the pre-existing
engine/DO/Playwright suites needed no edits at all. See the Big Button
section below.

**Multiplayer was built after an audit found it did not exist.** What the
room-code feature used to be: a hosted *solo* game — one shared `GameState`
that any number of browsers jointly drove, with no player identity, so two
people in a room shared one grid and one fame pool. It is now a real seated
match. Scope is 2-4 players, single season; 5-8 players and combined-season
play are deliberately out of scope but not designed out.

**The multiplayer server moved from a Bun process to Cloudflare Workers +
Durable Objects**, one DO instance per room, to get real hosting
(`fliptoons.win`) without running and babysitting a VPS/container.
This was a genuine rewrite of the transport and state layers, not a
deploy-target swap: `Bun.serve`'s callback-based WebSocket API became the
Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`/`Close`/`Error`,
`serializeAttachment`), the single in-process `Map<string, Room>` became one
DO per room addressed by `env.ROOMS.getByName(roomCode)`, and `setTimeout`
became `ctx.storage.setAlarm` (a DO gets exactly one alarm slot, so the old
turn-timeout timer and the old cross-room staleness sweep are now one
scheduled deadline per room — see the Multiplayer invariants below). Room
state is now persisted to `ctx.storage` on every mutation, which it wasn't
before: the Bun server was explicitly in-memory-only, but a Durable Object's
JS heap **will** be evicted between messages while its hibernating
WebSockets stay open, so anything not in `ctx.storage` is gone on the next
wake. `packages/engine` and `apps/web` needed no changes — the wire protocol
(`apps/worker/protocol.ts`) changed in exactly one place: room creation is
now `POST /api/rooms` rather than a WebSocket message, because a Durable
Object has to be addressed by room code before its socket can even upgrade,
and the old protocol didn't have a room code yet at that point.

## Layout

```
packages/engine/     Pure TS, zero runtime deps. The rules engine.
  types.ts             Card, Grid, Slot schema
  cards/                season1.ts, season2.ts, index.ts — the 62-card table
  grid.ts               3x2 board + extra row, stacks, adjacency, posLabel
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
  bigButton.ts          the Big Button mini-expansion's two reset effects, as pure PlayerView transforms

apps/worker/           Cloudflare Worker + Durable Object. Room-code hosted/resumable games.
  room.ts                 RoomDurableObject — one instance per room, hibernatable WebSockets,
                           state persisted to ctx.storage, alarm() drives turn-timeout + eviction
  worker.ts                fetch entry: serves apps/web's build, POST /api/rooms, /ws routing
  protocol.ts               wire types shared with apps/web (no Workers-only types allowed)
  log.ts                    timestamped console logging; every line names its room
  room.vitest.ts             DO tests via @cloudflare/vitest-plugin (NOT *.test.ts — see below)

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

- `make play` — web client + Worker (`wrangler dev`) together (room-code hosted games)
- `make web` — web client only, local solo, no server
- `make stop` — kill any repo process this Makefile started (web/server)
- `make test` — `bun test` (the engine suite) plus `apps/worker`'s own DO test suite, run separately via `vitest` in that order (see Testing below) — Workers run on `workerd`, not Bun, so `bun test` itself can't collect `apps/worker`'s tests.
- `make typecheck` — all three tsconfigs (root/`packages`, `apps/worker`, `apps/web`). The root one covers `packages/**` ONLY; for a long time the target ran just that, so neither app was ever typechecked.
- `make lint` — oxlint, **default recommended rules only** (`.oxlintrc.json`). The baseline is 0, so a finding here is always new. Stylistic rule sets are deliberately off; type-aware checking is `make typecheck`'s job.
- `make e2e` — Playwright browser tests; starts both servers itself

Toolchain is **bun** — runtime, package manager, test runner — for `packages/engine` and `apps/web`. No node/npm/tsx. `apps/worker` additionally uses **wrangler** (Cloudflare's CLI: `wrangler dev`, `wrangler deploy`) and **vitest** (via `@cloudflare/vitest-plugin`) for its own DO test suite, since Workers run on `workerd`, not Bun — `cd apps/worker && bunx vitest run`.

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
- **The acting player comes from the socket's attachment.** `ws.serializeAttachment({ seat })`/`deserializeAttachment()` — hibernation drops any plain JS field on the socket object, so this can't be a bare `SocketData`-style struct the way the old Bun server had it. The `action` message still carries no `playerId`; a client-asserted one would let anyone act as anyone.
- **Adding a field to `PlayerState`?** Add it to `PLAYER_FIELDS` in `state.ts`
  too. There is a compile-time guard that will name it if you forget —
  `satisfies` alone does not catch omissions, and a missing key is silently
  dropped on every commit.
- **Two halves of the security boundary, now split across two layers.** WHICH
  ROOM a connection may touch is pinned by Durable Object routing itself: the
  Worker resolves `?room=` to exactly one DO instance
  (`env.ROOMS.getByName(roomCode)`) before the socket ever upgrades, so a
  connection to one room's DO has no way to reach another room's state at
  all — there is no per-connection room lookup left to get wrong. WHO a
  connection is remains `join`'s job: it pins the seat onto the socket via
  `serializeAttachment`, and every later message reads that, never a
  client-supplied id.
- **A reclaimed seat closes its previous socket**, rather than leaving it to
  report a disconnection later on behalf of a player who has already come
  back. `ctx.getWebSockets()` plus each socket's own attachment (there is no
  `Seat.socket` field any more — sockets aren't tracked per-seat, they're
  found by matching attachments) stands in for the same check.
- **The turn timeout gates on DISCONNECTION, never idleness.** A player who is
  present and thinking is not on a clock. A skip that moves nothing does not
  re-arm.
- **The SERVER runs the Flip, not a player.** `advanceFlip` was never turn- or
  host-gated — any seat could press it and one press flipped everyone — which
  made the button a shared control with no owner: first click won, everyone
  else got "Nothing to reveal right now". `apps/worker/room.ts`'s
  `advanceSharedPhases` drives it instead, from `handleStart` and from the
  tail of `handleAction`, so the reveal folds into the same broadcast as
  whatever caused it. There is
  no client control for it, and `phase === 'finalFlip'` now exists only inside
  one server tick — the endgame arrives in the same message as the market
  action that triggered it. That is why the trigger round's Market phase
  carries an `endgame-notice`: `runMatchCleanup` hands straight from `cleanup`
  to `finalFlip`, so there is no phase left in which to warn anyone.
- **Every board on the table is drawn by one component.** `BoardPane.tsx` —
  yours and every opponent's, in every phase. The only difference is
  `readOnly`, which renders cards as inert `<div>`s rather than the enabled,
  focusable, click-less `<button>`s opponent grids used to get. Two rules
  protect the parity: `.grid`'s `max-width` (so a grid in a wide pane draws
  the same card size as one in the narrow column beside the market) and
  `.round-view__controls:disabled .card:disabled { opacity: 1 }` (an
  it-isn't-your-turn grey says nothing, and made your own board look unlike
  the opponent boards next to it).
- **Every dismiss prompt is drawn by one component too.** `EffectChoicePrompt`
  renders Butterfly, Panther, Alligator AND the Skunk as one card row; the
  Skunk synthesizes a `dismissChosenGridCard` with `cost: 0`, which is exactly
  its rule (mandatory, free, any face-up card of yours), so it needs no kind of
  its own. What differs between them is never the shape: the OPTIONS are
  filtered by the engine, `choice.mandatory` decides the Skip, `choice.cost`
  decides the badge, and `defaultConstraintNote` names the rule in force —
  derived from the choice, so the UI can't claim a constraint the engine isn't
  applying. Each option carries its grid position: the starting deck holds two
  Caterpillars (Butterfly's own target), and which one you dismiss changes the
  board, so identical names in a flat row are not interchangeable. Butterfly
  used to render a whole `<Grid>` for that reason; the position captions
  replaced it, and `Grid`/`Slot` no longer have a choice-picker mode at all.
- **The phase chip only names phases a player can see.** `MatchView`'s
  `phaseLabel` returns a label for `market` and `ended` and null for the rest —
  it used to print the raw `Phase` union member, which showed players
  `POSTFAMEHOOKS`. `postFameHooks` is the one non-transient phase left unnamed
  on purpose: the Skunk prompt or the "waiting for the other players" line is
  already saying what is happening.
- **The scoreboard shows one fame number, not two.** "Fame this round" is a bar
  against `shared.fameToTriggerEndgame` — the only comparison the rules make —
  next to deck / on-board / dismissed counts. "On board" counts the grid
  (stacks included), NOT cards drawn: nothing in state tracks draws, and a
  dismissal takes a card off the board without returning it to the deck. The
  old "To spend" column equalled the scored fame until someone hired, so it
  read as the same number twice; your own spendable fame lives on your board in
  `RoundView`, the only place you can spend it. `RoundView`'s own
  `showRoundScore` header is off in multiplayer for the same reason — the
  scoreboard is already drawing that bar, eight pixels above it. Solo has no
  scoreboard, so it keeps the header.
- **The table size is not declared when hosting.** A room always opens at
  `MAX_SEATS` and `buildNewMatch` is called with 4; `handleStart` rebuilds the
  match at however many seats actually turned up. That rebuild is the ORDINARY
  path, not an edge case. It is safe only because seat ids are a fixed
  `p0..p{n-1}` (`match.ts`) and seats are never removed from `room.seats`, so
  shrinking leaves every seat holding the id its connection was pinned to at
  join time. Do not recompute `hostPlayerId` there — `webSocketClose` may
  already have handed the role to a connected heir.
- **The end screen reads `shared.winnerId`, never the fame totals.** A tied
  Final Flip is broken by a re-flip among the tied seats only, and that
  re-flip does not move any other seat's `fameGeneratedThisRound` — so
  `matchRoundFame` keeps reporting the tie the engine already settled. Taking
  the argmax of it made `MatchView`'s `EndScreen` announce "a shared win", once
  naming a seat that LOST the re-flip, directly above a log line saying who
  won: 32 of 1200 simulated Final Flips at 2-4 seats. `winnerId` is null in
  exactly one case (the tiebreak exhausting `MAX_TIEBREAK_ROUNDS`), which is
  the only case where the tie set is the real answer. Pinned by
  `final-flip.test.ts` on seeds 98/138/152, all 3-player — 2 seats structurally
  cannot produce the disagreement, which is why the e2e suite never saw it.
- **A socket with no seat cannot "reconnect".** `useMatch`'s close handler
  reconnects by REJOINING with a stored token, so a `create` that never
  reached the server has nothing to replay. It used to claim `'reconnecting'`
  anyway and schedule a retry guarded by `if (seat)` that therefore did
  nothing — and because `MultiplayerStart` derives `busy` from that state, the
  Host button you would use to try again was disabled too. Hosting against a
  down server was an unrecoverable screen. No seat now means `'failed'`.
- **No cumulative score anywhere.** Fame is one per-round number that is at
  once your score, your spending power, and expiring. The rules keep no
  running tally; don't invent one in the UI.

## Big Button mini-expansion invariants

The mini-expansion (`Referance/IMG_4308.HEIC` — the only photographed page)
gives every player one Big Button card, face up. Flipping it face down IS the
whole cost: no fame, no action, once per game. Exactly ONE of two reset effect
cards is chosen at setup and shared by the whole table.

- **`resetEffect: null` is the default and must stay a complete no-op.** It
  is what makes this a safe addition rather than a re-baseline: with it, both
  Big Button toon cards stay excluded, `canUseGridReset`/`canUseMarketReset`
  are false for every seat, `runCheckFame` still goes straight to
  `postFameHooks`, and `runMatchFinalFlip` is still the synchronous
  single-call endgame it always was. `big-button.test.ts` opens with a whole
  describe block pinning exactly that; if you break it, that is the first
  thing that fails.
- **The Big Button card is excluded from the deck BECAUSE the expansion is
  off, not because the effect is unimplementable.** Do not conflate that with
  the Pig's solo exclusion, which is a rulebook rule (§3.7) and holds
  unconditionally. `setup.ts`'s `exclusionsFor` is the one place the
  difference lives. The Season 1 pairing (Axolotl ↔ Season 2's Platypus) is
  **inferred by symmetry** — only the Season 2 setup card is photographed —
  and `BIG_BUTTON_CARDS` is the single line to change if a Season 1 card ever
  turns up saying otherwise.
- **"Before taking any market actions" is NOT an `actionsRemaining` check.**
  RESET: MARKET is legal only before this turn's first hire/dismiss, and
  hiring a Peacock leaves `actionsRemaining` back at 2 (`2 - 1 + 1`) with a
  card already bought. That is why `PlayerState.actedThisMarketPhase` exists.
  It is cleared at the one place actions are dealt out (the
  `postFameHooks -> market` transition), which is enough because each seat
  takes exactly one turn per Market phase.
- **`hasAnyLegalMarketAction` counts the Market Reset.** It costs 0 fame and
  0 actions, so a broke seat holding an unused button still has something to
  do — and that predicate drives three auto-END-the-turn paths
  (`afterMarketAction`, `afterTurnBoundary`'s skip LOOP, solo's
  `closeMarketIfExhausted`). Without it a broke seat silently loses its
  once-per-game button, and the loop can strip several seats in one call.
- **RESET: GRID's decisions are SEQUENCED; its resets are SIMULTANEOUS.**
  "Starting with the first player, each player in clockwise order decides" is
  information, not ceremony — the last decider knows what everyone else chose.
  So it is its own turn-gated phase (`gridReset`), walked from
  `firstPlayerIndex`, skipping seats whose button is already spent. Only then
  do the opted-in seats collect and re-flip.
- **"All players then repeat the Check Fame phase" means ALL, not just the
  resetters.** A resetter's new grid changes what Dog/Camel/Fox are worth to
  every other seat, so `resolveGridReset` re-scores the whole table. This
  OVERWRITES `fameGeneratedThisRound`: a reset that scores worse costs that
  player the endgame trigger and the Critic's Choice they would otherwise
  have had. That is the risk of pressing the button, not a bug.
  `strictlyLowestScorerIndex` reads the post-reset value, correctly, because
  `runMatchPostFameHooks` runs strictly after.
- **The Final Flip can now pause — exactly once, and only there.** RESET:
  GRID is "after the Check Fame phase" with no exception, and the Final Flip
  IS Flip + Check Fame, so `runMatchFinalFlip` split into
  `startMatchFinalFlip` (flip + score + maybe pause) and
  `resumeMatchFinalFlip` (tiebreak + scores + winner). The old single-call
  entry point still exists and now THROWS if it would have skipped a pending
  decision, rather than silently swallowing it. The tiebreak re-flips can't
  pause: any button that was going to be spent already is.
- **Platypus's +3 goes through `scoreGrid`'s `externalState`, NOT
  `roundFame.ts`.** It is PER-CARD (two Platypuses each score their own +3),
  where the Critic's Choice is per-player — so it belongs on the same seam
  Dog/Camel/Fox use, fed by `runCheckFame`. Like theirs, an unsupplied flag
  THROWS rather than silently scoring 0. `architecture.test.ts` is unaffected:
  it greps `score.ts` for `criticsChoice`/`finalFlip` only.
- **Platypus is the second effect that reaches ACROSS seats** (the Pig was the
  first). "Flip ALL big button cards face up" — `applyEffects` does the acting
  player's own, because a `PlayerView` can't see another seat, and
  `match.ts`'s `matchHire` does everyone else's. Axolotl's is own-seat only.
- **`bigButtonFaceUp` is never reset at Cleanup.** One use per game; the
  per-seat reset block in `runMatchCleanup` is exactly where someone would
  reflexively add it. Only Axolotl/Platypus flip it back up.
- **The room-level setting lives on `Room`, not just the dealt match.**
  `handleStart` REBUILDS the match at the size that turned up (the ordinary
  path, not an edge case) and `handleRematch` builds another — all three
  `buildNewMatch` call sites must pass it. `worker.ts`'s `handleCreateRoom`
  rebuilds the params object field by field, so a new `CreateRoomRequest`
  field has to be added there too or it is silently dropped; it is validated
  against the two legal values there rather than passed through, since it
  reaches `setup.ts` and decides the toon deck's composition.
- **`strandingSeat` knows about `gridReset`.** The decision is turn-gated, so
  a disconnected decider stalls the whole table — and the pre-existing check
  returns `undefined` for every phase but `market`, arming no alarm at all.
  `playForAbsentSeat` answers for them by DECLINING: keeping the button costs
  that player nothing, where spending it on a guess burns a once-per-game
  resource.

## Testing

442 tests across 19 files (the pure-engine suite) plus 28 tests in
`apps/worker/room.vitest.ts` — `make test` runs both (the second via `cd
apps/worker && bunx vitest run`, since it needs the real Workers runtime, not
Bun; see Running Things above) — plus the 17 Playwright browser tests `make
e2e` runs (the two long-form specs are skipped there; see `make e2e-long`
below).
Fixture-style tests assert `scoreGrid`/`flip`/`phases` behavior directly —
there's no separate fixture corpus (`flip-toonz-phase0-plan.md`'s
oracle/fixtures design was superseded; tests just assert expected values
inline). `room.vitest.ts` runs against a real Durable Object over real
WebSockets (`SELF.fetch` with an `Upgrade` header, `response.webSocket`) —
seat assignment, reconnect-by-token, and turn enforcement only exist at that
layer, same reasoning the Bun-server predecessor's `rooms.test.ts` had before
this project moved off Bun for the multiplayer server (see the Cloudflare
Workers paragraph near the top of this file). It also covers two things that
layer alone can prove: `runDurableObjectAlarm` (from `cloudflare:test`) force-
fires the turn-timeout/eviction alarm without waiting out `TURN_TIMEOUT_MS`
for real, and `evictDurableObject` tears down the resident instance and
reconnects — proving `ctx.storage` persistence actually survives a
constructor reload, not just that reconnect works within one still-resident
instance (which every other reconnect test in the file does). `e2e/` drives two browsers through a whole 2-player game; run `make e2e`
after any web change. `playToEnd` takes a policy: `'pass'` only presses the
ends turns (proves the flow), `'buy'` actually spends fame —
hire, dismiss, and the effect prompts they open. Use `'buy'` for anything
touching the Market phase; `'pass'` proved nothing about it, which is how two
Pig bugs survived a green suite. Dismiss is rationed to one per seat on
purpose: fame is scored FROM the board, so a seat that dismisses freely
strips its own grid and no one ever reaches the endgame threshold. The play
loop and lobby helpers live in `e2e/helpers.ts` (not `*.e2e.ts`, so Playwright
doesn't collect it as a suite), shared with the long-form harness.

`make e2e-long` is a **debugging harness, not part of `make e2e`** — a
full-length 2-player game at the real threshold of 30, both seasons, taking
minutes. It reports rather than just passing: which cards were hired and
dismissed by name, which effect prompts opened, every error banner seen, and a
transcript written to `.longform/` (gitignored). It asserts only that the game
ends, both seats agree, nothing crashed, and no `Server error` appeared —
never coverage. **Sparse effect coverage is the card table's doing, not a
broken test:** only five cards in sixty-two open a prompt (Butterfly and Horse
in S1; Raccoon, Panther and Crow in S2), so a single-season game can reach at
most three, and a run that hits none is information about the shuffle. It is a
sampler, not a guarantee — two runs of the same seeds reached Horse/Panther/
Raccoon/Crow and then Butterfly/Raccoon/Crow, because the policy's own
dismisses change what the later hires find. Run it twice before concluding a
card is unreachable.

The harness plays the ONE thing the standard suite structurally cannot: a
full-length game. That is where the Pig actually gets hired (it did, twice,
prompt answered, no errors), and where a market refill can come up short and
trigger the depletion endgame.

Solo has its own browser spec because every multiplayer spec clicks straight
past that screen.
