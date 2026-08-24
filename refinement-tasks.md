# refinement-tasks.md — Design refresh

This document covers the "Design refresh" work. Do this in a fresh agent/session with no memory
of prior conversation — everything needed is here.

Work serially, stage by stage, and check in with the user after each stage before starting the
next.

## Ground rules (from `/Users/nick/Documents/FlipToons/CLAUDE.md` — read that file in full
before starting)

- **Every board on the table is drawn by one component**, `BoardPane.tsx`. Extend it via props; never fork into separate own-board/opponent-board components.
- `matchActions.ts` must not import from `actions.ts`.
- `scoreGrid` (packages/engine/score.ts) must stay grid-only and pure — any addition should be
  a richer readout of information it already computes, not a new dependency.
- Card data changes start in `cards.csv`; none of this work touches card data.
- Toolchain is **bun** for `packages/engine`/`apps/web`, plus **wrangler**/**vitest** for
  `apps/worker`. Verify with `bun test`, `make typecheck`, `make lint`, `make e2e` as noted per stage below.
  

## Stage 1 — Done already

## Stage 2 — Design refresh: emphasis, sizing, dimming, per-card fame (do this stage first)

Preserve the `BoardPane` single-component invariant throughout — extend via props.

### 2a + 2e. Own-board emphasis and not-your-turn dimming

refinement-tasks.md items: "UI needs more flash showing Your Own grid as well as when it's your
turn" and "need a Grey overlay or some other slight deemphasis on your cards when it's not your
turn."

Current state:
- `.round-view__grid-pane` is defined ONCE in `apps/web/src/style.css` (~line 1356) with no
  variant class distinguishing own vs. opponent boards — this is the real gap.
- `TurnBanner` in `apps/web/src/components/MatchView.tsx` (~lines 222-233) only changes text
  color via `.match__turn--mine` (`var(--color-accent)`) — no background/border treatment.
- `.round-view__controls:disabled .card:disabled { opacity: 1 }` (`style.css` ~line 1468) is an
  EXISTING, deliberate rule that prevents per-card greying when a fieldset is disabled — it
  solves an unrelated problem (an opponent's board looking different from your own inactive
  board) and must not be touched or reused for the new dimming.

Plan:
- Add two independent boolean props to `BoardPane` (`apps/web/src/components/BoardPane.tsx`):
  `isOwn?: boolean` and `isActive?: boolean`. Each adds its own modifier class to the existing
  `.round-view__grid-pane` element — e.g. `round-view__grid-pane--own`,
  `round-view__grid-pane--inactive` (when `isActive === false`). Keep them independent so they
  compose (a board can be own-and-inactive, opponent-and-active, etc.) rather than one prop
  trying to encode both axes.
- Proposed default treatment (adjust after a visual check — this is a design decision, not a
  hard requirement): own board gets a left accent border / heading tint; inactive board gets a
  subtle dark overlay + reduced opacity applied to the whole pane wrapper, NOT to individual
  cards (that's the `:disabled .card:disabled` rule's job, and it stays as-is).
- Wire this up symmetrically in `MatchView.tsx`: every `BoardPane` call — your own board's
  market-phase path (via `RoundView`, which itself renders a `BoardPane`), your own board's
  non-market read-only fallback (~line 190), and every entry in `OpponentBoards` (~lines
  333-371) — should dim whichever board(s) are not the currently active seat's, including your
  own when it isn't your turn. `isActive` for a given board is
  `match.shared.phase === 'market' && activeId === <that board's playerId>`. `RoundView`
  doesn't otherwise know about multiplayer turn state, so thread `isActive`/`isOwn` down as new
  optional props on `RoundView` too (default both `true`, since solo has no "not your turn"
  concept — a solo player is always both "own" and "active").
- Also strengthen `TurnBanner` beyond text-color-only: a background/border treatment on the
  banner itself for whoever's turn it is.

Files: `apps/web/src/components/BoardPane.tsx`, `RoundView.tsx`, `MatchView.tsx`,
`apps/web/src/style.css` (`.round-view__grid-pane`, `.match__turn` blocks).

### 2b. Larger numbers for actions-remaining / fame-remaining

refinement-tasks.md item: "Need larger numbers showing key values like actions remaining for
turn & fame remaining for turn."

Current state:
- `apps/web/src/components/ChoicePrompt.tsx` (~lines 17-30) renders one compound sentence,
  "Market actions remaining: X — spendable fame: Y", in `.choice-prompt__summary` with no
  explicit font-size (inherits body default, ~1rem).
- `RoundView.tsx`'s "Score this round" bar (~lines 190-214, `.round-view__score`) is 0.9rem
  (inherited from `.round-view__header`, `style.css` ~328-335).
- `MatchView.tsx`'s `Scoreboard` "Fame this round" column (~lines 245-323) is also 0.9rem.

Plan: split each of these compound/small-text stats into a label + a visually distinct large
number (new CSS class, e.g. `.choice-prompt__stat-value` at roughly 1.5-2rem bold — treat this
as a starting point, confirm the exact size with a live visual check rather than guessing
blind), applied consistently across `ChoicePrompt.tsx`, `RoundView.tsx`'s score bar, and
`MatchView.tsx`'s Scoreboard. This is markup restructuring (splitting one sentence into
label/value spans) plus CSS — no new components.

Files: `ChoicePrompt.tsx`, `RoundView.tsx`, `MatchView.tsx`, `style.css`.

### 2c. Dimmed face-down cards showing the represented card

refinement-tasks.md item: "flipped cards should show a dimmed version of the card they
represent."

No hidden-information concern: `Slot.tsx` already looks up the real card by id regardless of
`faceUp` (the full client-side grid, face-down card ids included, is always present — there is
no server-side hiding of a face-down card's identity), and by the rules a card is only ever
flipped face-down after being revealed once. So rendering its real content at reduced opacity
leaks nothing the client doesn't already have.

Plan: in `apps/web/src/components/Card.tsx`, replace the `!faceUp` early-return branch
(currently a bare `?`-mark placeholder on a `background: #3335` box) with the same front-face
content (name/icon/rank; omit fame and dismiss-cost badges, which don't apply while face-down)
rendered at reduced opacity (e.g. `opacity: 0.45`). Keep `dealDelayMs`/`card--dealt` support on
this variant, since it still needs to respect the existing `animateDeal` gating (see `Slot.tsx`/
`Card.tsx`) — a face-down-dimmed card shouldn't replay its deal-in animation on an unrelated
re-render either.

Files: `Card.tsx`, `style.css` (`.card--facedown`, `.card__facedown-mark` rules, ~592-598).

### 2d. Per-card "fame generated this round" badge

refinement-tasks.md item: "Need larger numbers on cards in grid showing fame generated for the
current round (eg a yellow number in the top right corner)."

Two things must be resolved together:
1. **Disambiguation.** `FameLine` (the `FameBreakdown` line type in `packages/engine/score.ts`)
   has a `pos: GridPos` field but no `stackIndex` — a stacked slot (two cards sharing one `pos`)
   produces two `FameLine`s that `pos` alone can't tell apart, and `cardId` doesn't help either
   since every card has `copies: 2`. Add `stackIndex: number` to `FameLine`, populated from the
   existing per-slot loop in `scoreGrid` (search for where `FameLine`s are pushed, near the
   slot/stack iteration). This is additive and grid-only — it doesn't touch `scoreGrid`'s
   purity, since it's just exposing information already computed from `slot.cards`/
   `slot.faceUp` indices.
2. **Staleness.** `fameGeneratedThisRound` on `GameState`/`SharedState` is snapshotted once at
   the Check Fame phase transition and does NOT track later dismissals during Market. A
   per-card badge computed by re-running `scoreGrid(grid)` live during Market would visibly
   drift from the frozen header number the moment a card is dismissed. Recommended approach:
   snapshot the full `FameBreakdown` at the Flip→CheckFame transition, reusing the "new round"
   signal already present in the code — `RoundView.tsx` has an `isFreshDeal`/`animatedRoundRef`
   pattern keyed on `state.round`; `MatchView.tsx` has the analogous one keyed on
   `match.shared.round` — extend those, don't duplicate the concept. Hold the snapshotted
   breakdown in local component state, refreshed only on a genuine new Flip. A dismissed card's
   badge simply disappears along with the card, which is fine — the badges don't need to reflect
   mid-round dismissals, only stay consistent with the frozen header number.

Plan:
- Add `stackIndex` to `FameLine` as above.
- Add a small `(pos, stackIndex) -> FameLine | undefined` lookup util.
- Thread a `roundFame?: number` prop down `BoardPane` → `Grid` → `Slot` → `Card`, rendered as a
  new badge (proposed: small yellow number, top-right corner) distinct from the existing static
  base-fame line already on every card (`Card.tsx`, look for where `card.fame.base` is
  rendered).
- Wire this for both solo (`RoundView.tsx`) and multiplayer (`MatchView.tsx`, including
  opponent boards — every client already has every grid via the existing wire protocol, so no
  protocol change is needed to show opponents' per-card fame too).

Files: `packages/engine/score.ts` (`FameLine` type + population), `Card.tsx`, `Slot.tsx`,
`Grid.tsx`, `BoardPane.tsx`, `RoundView.tsx`, `MatchView.tsx`.

### Stage 2 verification

- `bun test` (engine changes in 2d) — including `packages/engine/architecture.test.ts`'s
  grep-based purity guard on `score.ts`, which must keep passing since the `stackIndex` addition
  is additive only.
- `make typecheck`, `make lint`.
- Manual browser check via `make web` (solo) and `make play` (multiplayer, 2+ browser tabs) for
  every visual change — cross-check per-card fame badges against the numbers already shown in
  the existing fame-breakdown UI (`FameBreakdown.tsx`) to confirm they agree.
- `make e2e`.

## Stage 3 — Touch UI mode + settings (do this stage second, after Stage 2 ships)

This is the largest new surface: a new default-on touch interaction mode plus the settings
persistence it needs. refinement-tasks.md items: "touch UI mode where tapping on a card brings
up a zoomed in modal sheet showing what it does and offering available contextual action
(hire/dismiss), double tap should trigger the contextual action, touch mode should be toggleable
in the game ui, touch mode should be the default" and "cookies to remember your last used player
name and touch mode toggle state" (use `localStorage`, matching this project's existing
convention — there is no cookie usage anywhere in the codebase, and none should be introduced).

### 3a. Settings module (land this first within the stage — everything else depends on it)

No shared settings/storage utility currently exists. Two ad hoc `localStorage` keys already
exist: `apps/web/src/useGame.ts` (`'fliptoons-solo-save-v1'`, full solo `GameState` snapshot)
and `apps/web/src/useMatch.ts` (`'fliptoons.match.seat'`, stores `{roomCode, reconnectToken,
name}` for multiplayer reconnect — this already incidentally persists a player's name, but
nothing currently reads it to prefill a fresh join/host form).

Create `apps/web/src/settings.ts`, following the existing try/catch-wrapped localStorage
pattern from those two files:

```ts
const SETTINGS_KEY = 'fliptoons.settings.v1'
type Settings = { touchMode: boolean; lastName: string }
const DEFAULT_SETTINGS: Settings = { touchMode: true, lastName: '' }
export function loadSettings(): Settings { /* try/catch, merge with defaults */ }
export function saveSettings(partial: Partial<Settings>): void { /* merge + persist */ }
```

- `touchMode` defaults **true**, per the task.
- The multiplayer host/join name field (`apps/web/src/components/MultiplayerStart.tsx` —
  confirm current default is a blank `useState('')`) should initialize from
  `loadSettings().lastName` and save on submit (not on every keystroke).
- `useMatch.ts`'s `StoredSeat.name` keeps its own separate lifecycle (reconnect-scoped, cleared
  on leaving a room) — it should initialize its own join-form field from `settings.ts`, but
  `settings.ts`'s `lastName` is the durable "remember me across sessions/rooms" value, decoupled
  from any one room's reconnect state.
- Check whether solo mode has any name-entry field at all (it may not need one); if not,
  `lastName` only feeds the multiplayer form.

### 3b. Touch UI mode — tap-to-zoom modal, double-tap to act

**LAN reachability — verify and fix before building anything else in this stage**, since the
whole point is for the user to test it live on their phone: Vite's dev server binds
`localhost` only by default, and `apps/web/vite.config.ts` currently has no `server.host` set;
`scripts/play.sh`'s `wrangler dev` invocation currently has no `--ip` flag either. Fix both:
- `vite.config.ts`: add `server: { host: true }`, preserving any existing `server.fs.allow`
  config already there.
- `scripts/play.sh`: add `--ip 0.0.0.0` to the `wrangler dev` call.
- `useMatch.ts`'s `WORKER_ORIGIN` already derives from `window.location.hostname`, so it should
  need no change once the worker itself binds to `0.0.0.0`.
- Once done: run `make web` (touch mode is fully testable in solo, no server needed) or
  `make play` (for multiplayer), find the machine's LAN IP (`ipconfig getifaddr en0` on macOS),
  and give the user `http://<lan-ip>:5173` to open on their phone on the same LAN/Wi-Fi. **Send
  this URL to the user as soon as it's running so they can try it live and give feedback before
  the visual design is considered final** — that was explicitly requested.

**Component design (a concrete starting proposal — expect to adjust after the user tries it on
their phone):**
- New `apps/web/src/components/CardZoomSheet.tsx`, adapted from the overlay mechanics already
  used by `apps/web/src/components/CardListOverlay.tsx` (backdrop click-to-close div + inner
  panel with `stopPropagation()`; extend its `.card-list-overlay__*` CSS rather than duplicating
  it). Proposed layout: a centered modal (not full-screen, not a bottom sheet) showing the
  tapped card at a larger size, its full rules text, and — when the card had a click handler in
  its normal context (hire from the market, dismiss from the grid) — one prominent action button
  that performs that same action and closes the sheet.
- Interaction wiring in `Slot.tsx` and `Market.tsx` (both already own the `onClick`/`onDismiss`/
  `onHire` wiring into `Card`): when touch mode is on, a single tap on a card opens the zoom
  sheet instead of firing the action directly; double-tapping the card in its normal (non-modal)
  position fires the action immediately, bypassing the sheet. Implement the double-tap detection
  as a small shared hook (e.g. `useDoubleTap`) consumed by both call sites, rather than adding
  touch-mode-specific state to `Card.tsx` itself — keep `Card.tsx` a dumb rendering component.
  Proposed double-tap threshold: 300ms (a standard platform convention) — flag this as adjustable
  after trying it live, not a fixed requirement.
- Touch-mode toggle: reads `loadSettings().touchMode` on mount; render it as a small toggle
  control in the header area of `RoundView.tsx`/`MatchView.tsx` (exact placement is a design
  choice — pick something unobtrusive, e.g. near the "Abandon game"/"Leave game" button). Calls
  `saveSettings({ touchMode })` on change. When off, revert to today's existing direct
  single-click hire/dismiss behavior unchanged — no new code path needed for that state beyond
  the conditional.

**e2e impact — must be handled explicitly:** `e2e/solo.e2e.ts` and `e2e/two-player.e2e.ts`
currently click cards directly to hire/dismiss. Since touch mode will default to on, those
existing single clicks would start opening the zoom sheet instead of acting, breaking every
existing hire/dismiss assertion in those specs. Handle this by:
- In `e2e/helpers.ts`, seeding `localStorage` with `{ touchMode: false }` under the
  `settings.ts` storage key before existing specs navigate, so they keep exercising direct-click
  behavior exactly as today.
- Adding a new `e2e/touch-mode.e2e.ts` spec (or a `helpers.ts` `enableTouchMode()` addition)
  that explicitly seeds `touchMode: true`, taps a card, asserts the zoom sheet appears with card
  text and a contextual action button, clicks it, and confirms the same state change the
  direct-click specs already verify — plus a `locator.dblclick()` assertion for the double-tap
  path.

Files to touch/create: new `apps/web/src/settings.ts`, `CardZoomSheet.tsx`; edits to
`apps/web/vite.config.ts`, `scripts/play.sh`, `Slot.tsx`, `Market.tsx`,
`MultiplayerStart.tsx`, `RoundView.tsx`, `MatchView.tsx`, `style.css`; new
`e2e/touch-mode.e2e.ts`, edited `e2e/helpers.ts`.

### Stage 3 verification

- `make typecheck`, `make lint`.
- `make e2e` — confirm existing specs still pass under the seeded-off default, and the new spec
  passes with touch mode on.
- A live phone-over-LAN check with the user, per the reachability notes above — this is the one
  stage where a manual check with the actual requester matters most, since the exact modal
  layout and double-tap feel were explicitly left open for them to confirm.

## Open design decisions to flag for the user during/after implementation

- Exact colors/treatment for "own board" and "inactive board" states (Stage 2a/2e) — proposed
  defaults given above, adjust after a visual check.
- Exact stat-number size/weight (Stage 2b) — proposed ~1.5-2rem bold, adjust after a visual
  check.
- Zoom sheet exact layout and double-tap threshold (Stage 3b) — proposed centered modal / 300ms;
  the user explicitly asked to try this live on their phone before it's considered final.

## Research notes from prior investigation (exact code already read — skip re-deriving these)

Everything below was confirmed by directly reading the files during planning, to save the
implementing agent a research pass. Line numbers may drift slightly if other edits land first —
treat them as "look near here," not gospel.

### `apps/web/src/components/BoardPane.tsx` (full file as of this writing)

Single shared component for every board on the table. Current props: `title`, `grid`, `cards`,
`deckCount`, `dismissEntries?`, `onDismiss?`, `fame?`, `readOnly?`, `footer?`, and
`animateDeal?` (defaults `true` — gates the deal-in animation to genuinely fresh deals, already
threaded end-to-end through `BoardPane` → `Grid` → `Slot` → `Card`). Renders one
`<div className="round-view__grid-pane">` wrapping a heading (`round-view__grid-heading`) and a
`<Grid>`. This is exactly where `isOwn`/`isActive` modifier-class props get added for 2a/2e, and
where `roundFame` gets threaded through to `<Grid>` for 2d — copy the `animateDeal` prop-chain
shape for these rather than inventing new plumbing.

### `apps/web/src/components/MatchView.tsx` — `TurnBanner` (lines 233-244)

```tsx
function TurnBanner({ phase, isMyTurn, activeName }: { phase: string; isMyTurn: boolean; activeName: string }) {
  if (phase !== 'market') return null
  return isMyTurn ? (
    <strong className="match__turn match__turn--mine" data-testid="turn-indicator">
      Your turn
    </strong>
  ) : (
    <span className="match__turn" data-testid="turn-indicator">
      Waiting on {activeName}
    </span>
  )
}
```
Confirms: text-only, no background/border. `.match__turn--mine` styling lives in `style.css`
around the `.match__turn` block. This is called from the header at line 77:
`<TurnBanner phase={phase} isMyTurn={isMyTurn} activeName={nameOf(activeId)} />`, where
`isMyTurn = match.shared.phase === 'market' && activeId === myPlayerId` (line 61) — reuse this
existing boolean directly for `isActive` rather than recomputing it per-board.

Own-board render sites confirmed in `MatchView.tsx`:
- Market-phase own board (line ~166): via `<RoundView state={viewOf(match, myIndex)} ... />`.
- Non-market own-board fallback (line ~190): `<BoardPane title="Your grid" grid={me.grid} cards={cards} deckCount={me.deck.length} readOnly animateDeal={isFreshDeal} />` — add `isOwn`/
  `isActive` alongside the existing `animateDeal` prop.
- `OpponentBoards` (lines 333-371) already receives `animateDeal` as a required prop — add
  `isActive`/`isOwn={false}` the same way, computed per-opponent as
  `phase === 'market' && p.playerId === activeId`.

### `apps/web/src/components/ChoicePrompt.tsx` (full file, 30 lines)

```tsx
export function ChoicePrompt({ state, onEndMarket, endLabel = 'End Market phase' }: ChoicePromptProps) {
  return (
    <div className="choice-prompt">
      <div className="choice-prompt__summary">
        Market actions remaining: <strong>{state.actionsRemaining}</strong> — spendable fame:{' '}
        <strong className="choice-prompt__currency">{state.fame}</strong> (resets to 0 after this phase — spend it or
        lose it)
      </div>
      <button type="button" className="choice-prompt__end" data-testid="end-turn" onClick={onEndMarket}>
        {endLabel}
      </button>
    </div>
  )
}
```
This is the exact "actions remaining / spendable fame" sentence from the design-refresh ask —
split `state.actionsRemaining` and `state.fame` out of the running sentence into their own
labeled stat elements for the larger-number treatment (2b). `data-testid="end-turn"` is used by
e2e specs — don't change it.

### `apps/web/src/components/Card.tsx` — exact render branches

- Props type (`CardProps`, lines 9-59) documents `dealDelayMs`'s comment as "the caller only
  supplies this when the card is new, via remount-keying" — that comment is slightly stale (it's
  gated by an upstream `animateDeal` prop too), worth a one-line update while in the file for
  2c/2d but not required.
- Face-down branch (lines 117-123, this is the block 2c replaces):
  ```tsx
  if (!faceUp) {
    return (
      <div data-testid={testId} className={`card card--facedown${dealDelayMs !== undefined ? ' card--dealt' : ''}`} style={dealStyle}>
        <span className="card__facedown-mark">?</span>
      </div>
    )
  }
  ```
- Face-up `className` construction (line 132) and the fame line (lines 155-158, inside the
  shared `body` JSX used by both the `readOnly` div path at line 176 and the interactive
  `<button>` path at line 184):
  ```tsx
  <div className="card__fame">
    fame: {card.fame.base === '=' ? 'varies' : card.fame.base}
    {card.fameUnencodable ? ' (needs ruling)' : ''}
  </div>
  ```
  This is the existing STATIC base-fame line — 2d's new "fame generated this round" badge must
  be visually distinct from this (different position/color, e.g. a corner badge rather than
  inline text), not a replacement for it.
- `card__top` (lines 140-150) already holds `card__rank`, an optional `card__price` badge, and a
  `card__selected-mark` — the proposed top-right yellow round-fame badge (2d) likely belongs
  here too, as a new conditionally-rendered span alongside `card__price`.

### `apps/web/src/components/CardListOverlay.tsx` (full file, 39 lines) — the overlay pattern to adapt for `CardZoomSheet` (3b)

```tsx
export function CardListOverlay({ title, cardIds, cards, onClose }: CardListOverlayProps) {
  return (
    <div className="card-list-overlay__backdrop" onClick={onClose}>
      <div className="card-list-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="card-list-overlay__header">
          <h2>{title} <span className="card-list-overlay__count">({cardIds.length})</span></h2>
          <button type="button" className="card-list-overlay__close" onClick={onClose}>Close</button>
        </div>
        {cardIds.length === 0 ? (
          <p className="card-list-overlay__empty">None.</p>
        ) : (
          <div className="card-list-overlay__cards">
            {cardIds.map((id, i) => <Card key={`${id}-${i}`} card={cards[id]} compact />)}
          </div>
        )}
      </div>
    </div>
  )
}
```
This backdrop-click-to-close + `stopPropagation()` inner-panel pattern, and its
`.card-list-overlay__*` CSS, is the base to extend for `CardZoomSheet.tsx` — same mechanics,
different content (one card at non-`compact` size, its full text, plus a contextual action
button instead of a close-only header).

### `apps/web/src/components/MultiplayerStart.tsx` — confirmed, not just "check"

Line 20: `const [name, setName] = useState('')` — confirmed blank, no prefill logic exists
today. Line 36-37 is the actual input:
```tsx
Your name
<input data-testid="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
```
For 3a, initialize with `useState(loadSettings().lastName)` and call `saveSettings({ lastName: name.trim() })`
at the two submit sites (host, line ~61-64 area; join, line ~96-97 area) — both already compute
`name.trim()` before dispatching, so save it there rather than adding a separate effect.

### `packages/engine/score.ts` — `FameLine`/`scoreGrid` exact shape (for 2d)

`FameLine` type starts at line 78: `{ pos: GridPos; cardId; name; base; bonuses; total; ... }`
— no `stackIndex` field exists. `scoreGrid` (function starts line 632) builds `lines: FameLine[]`
in a pass-1 loop at lines 656-717:
```ts
for (const { pos, slot } of occupiedSlots(grid)) {
  for (let i = 0; i < slot.cards.length; i++) {
    if (!slot.faceUp[i]) continue
    const cardId = slot.cards[i]
    const card = cardsById[cardId]
    const key = slotKey(pos, i)   // <-- `i` is exactly the stack index needed
    ...
    lines.push({ pos, cardId, name: card.name, base: computed.base, bonuses: computed.bonusLines, total: computed.total })  // line 716, the common case
    ...
  }
}
```
There are 4 separate `lines.push(...)` call sites in this loop (lines 671-672 the Cow/'='
placeholder, 677 the `fameUnencodable` case, 698 the Dog dual-branch case, 716 the normal case)
— `stackIndex: i` needs adding to all four, since `i` is already in scope at every site (it's
the loop variable). `slotKey(pos, i)` (a separate existing helper, line 139) already combines
`pos` + index into a string key for its own internal bookkeeping — that's precedent for using
`i` as the disambiguator, just not currently exposed on `FameLine` itself.

### Existing round-tracking plumbing worth reusing (not re-deriving)

- `RoundView.tsx` has an `animatedRoundRef`/`isFreshDeal` pair (a `useRef<number|null>` compared
  against `state.round`, updated in a `useEffect`) — 2d's snapshot-at-new-round logic for
  `FameBreakdown` should hook into the same effect rather than adding a second round-tracking
  mechanism.
- `MatchView.tsx` has the analogous `animatedRoundRef`/`isFreshDeal` pair keyed on
  `match.shared.round`, used today to compute `animateDeal` for the own-board fallback and
  `OpponentBoards`. Same reuse applies there for multiplayer's fame-snapshot.
- `BoardPane` → `Grid` → `Slot` → `Card` already has one full prop-threading pass done end-to-end
  for `animateDeal` — copy that exact threading shape for `roundFame`/`isOwn`/`isActive` rather
  than inventing a new plumbing pattern.
