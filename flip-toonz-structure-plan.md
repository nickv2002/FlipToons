# FlipToons — Digital Adaptation: Rules Model, Stack & Architecture Plan

> **Status:** planning only. No implementation yet. This revision reconciles the plan against the official rulebook (Season 1's FAQ/Keywords sections transcribed at <https://www.rulespal.com/fliptoons/rulebook#faq>, an OCR of the actual printed rulebook — same authority as a photograph, not a separate source), against the Season 2 rulebook/FAQ pages photographed in `Referance/*.HEIC`, and against the full transcribed card table (`cards.csv`, `packages/engine/cards/`) — not just the six starting cards.
>
> **Naming:** the game is *FlipToons* (this file's name predates that; kept to avoid churn).

---

## 0. What changed in this revision

The previous draft was written from a verbal description and got several load-bearing mechanics wrong. Every correction below is sourced from the rulebook. **Read this section first if you read the old draft** — three of these invalidate architecture decisions, not just details.

| # | Previous draft said | Rulebook says | Impact |
|---|---|---|---|
| 1 | Effects come in two fame-granting flavors: on-deal and on-board-complete | **No placement ability grants fame.** Placement abilities only mutate the board (stack, flip, move, stop reveals). All fame is computed during Check Fame from the finished grid | **Architectural.** `score()` becomes a pure function of the final grid. The dual fame-timing model is deleted |
| 2 | Cards have a `cost` | Cost comes from the **price card above the market slot**; cards are sorted into slots by **rank** (lowest left). Cost is emergent from market position | **Architectural.** `rank` is load-bearing and was absent; affordability is a market query, not a card field |
| 3 | A "catch-up bonus" phase where the lowest scorer checks their deck | **No such phase.** Phases are Flip → Check Fame → Market → Cleanup. What exists is the Skunk's card ability, resolved after Check Fame | Phase machine loses a phase; `catchUpBonus` card field is deleted |
| 4 | Cards create extra slots above/below themselves, so a round runs past six cards | The grid is **3×2 = six slots, filled left-to-right, top row then bottom row, until all six are occupied**. Monkey *relocates* a card into an extra row that "does not fill one of the six slots"; stacking puts two cards in one slot. Both extend the draw *because the six slots aren't yet occupied*, not because new slots were added | The fill-until-full invariant survives; the justification and the board model change |
| 5 | Board is three vertically-growing columns with slots spliced anywhere | Fixed 3×2, plus at most an extra row above (Monkey), plus stacks | Board model simplifies substantially |
| 6 | Players have a `discard[]` | **No discard pile.** Cleanup returns grid → deck; deck reshuffles at the start of each Flip. Hired cards go straight to the deck. Dismissed cards go face-up beside the deck, out of the game | Zones are deck / grid / dismissed |
| 7 | "Deck runs out mid-round" was an open question | "If a player does not have enough cards in their deck to complete their grid, they reveal and place as many as possible" | Answered — and see §3.5, this is a real design tension |
| 8 | Endgame = one more full round, most fame wins | Market **does** happen on the trigger round; trigger is evaluated at Cleanup; **Final Flip = Flip + Check Fame only** (no Market, no Cleanup). Ties re-run: tied players collect grid+deck, reshuffle, Flip, Check Fame, repeat | New state-machine branch (the tiebreak loop) |
| 9 | Effect `when` vocabulary was onDeal / onComplete | Rulebook documents a **"hired or gained"** trigger icon and a **"dismissed"** trigger icon | `onHire` / `onDismiss` added |
| 10 | Slice 1 = "solo mode, engine tracks and scores it" | There is an **official solo variant** with different setup and win condition (§3.7) | Decide which one slice 1 builds — see §7 |

**Added after the rulebook pass, from Nick:**

| # | New information | Impact |
|---|---|---|
| 11 | **The game has multiple seasons** — each a distinct set of starting *and* market cards, combinable into one game of up to eight players | **Architectural.** Cards carry a `season` tag; starting deck, toon deck, and market become setup config rather than constants (§3.0, §4.6) |
| 12 | **Least-fame abilities are a category, not one card** — Season 2's **Ladybug** shares the Skunk's condition | The post-Check-Fame hook must be generic and ordered, not a Skunk special case (§3.4) |
| 13 | **Price cards are 3, 4, 7, 10, 15** (5 slots, 1–4 players) and **3, 3, 4, 7, 10, 15, 15** (7 slots, 5–8 players) — keyed off **player count alone**, not season count; **rank ties send the newly drawn card to the right-hand, higher-priced slot** | Market width is `prices.length`, never a literal 5; a combined-season 3-player game still gets 5 slots; prices are non-distinct so only slot→price is a function; the tie rule pins the sort to a stable `(rank, insertionIndex)` (§3.6) |
| 14 | **First build target is a single-flip scorer**, before even the official solo mode | Becomes build step 0 — and it turns out to be the card-transcription harness and the AI's inner loop too (§8) |
| 15 | **Starting decks are per-player, not per-game** — combined games randomly assign each player a Season 1 or Season 2 deck, capped at 4 copies each (a paper-supply limit, relaxable later) | `Setup` has no game-wide `startingDeck`; assignment is a seeded function returning one deck per player (§3.0, §4.6) |
| 16 | **Toon deck depletion is a second endgame trigger at every player count**, not just a solo loss condition; the fame threshold stays **config, not a constant** | Cleanup OR's two independent triggers; `winCondition` decides whether depletion is a loss (solo) or a normal ending (§3.2.2) |
| 17 | **The 2-player/solo market decay fires at the END of the Market phase** (after the last player's refill), **once per round** — earlier drafts of this plan placed it in Cleanup | It shares the `refillMarket()` path, so a failed refill there is also an endgame trigger; and it burns 2 extra toon cards a round, making depletion the *expected* ending at low player counts (§3.6, §3.2.2) |
| 18 | **The Critic's Choice card** — awarded at the fame trigger to the single highest scorer, worth **+3 during the Final Flip**; removed from the game if the leaders tie. Despite the name it is a **player status, not a grid card** | **Breaks the "fame is purely grid-derived" invariant.** `scoreGrid` stays grid-only; a new `roundFame = scoreGrid + playerFameModifiers` seam carries it. Stays out of the `Card` type entirely (§3.2.1, §4.1) |
| 19 | **The card list has been transcribed**, from photos of every physical card plus the printed rulebook/FAQ pages (`Referance/*.HEIC`), into `cards.csv` (verbatim, all 62 unique cards) and `packages/engine/cards/{types,season1,season2,index}.ts` (structured, best-effort against the §4.4 schema) | Resolves most of §7's open questions as a side effect — see the updates to §3.2.2, §3.3, §3.4, §4.5, and §7 below. **Correction, not just an answer:** the Season 2 least-fame card is **Firefly**, not the Ladybug the earlier draft assumed (§3.4). 30 of the 62 cards don't fit the current effect vocabulary yet (`unencodable: true` in the data, verbatim text preserved) — see §4.4 |

**Unaffected and still correct:** fame is per-round and forfeited if unspent ("unspent fame is not carried over to the next round"); pure zero-dependency engine; seeded PRNG in state; action log as save format; cards as data; TypeScript / React / Vite / Node / Caddy. Those sections below are carried over largely unchanged.

---

## 1. Context

You want a digital version of FlipToons. You're a back-end programmer (APIs, some Python and Go) who intends to direct rather than hand-write most of the code. You don't have rights to the art, so presentation is text and numbers. It needs to feel snappy on touch and mouse/keyboard, run on a modest Linux box you already own, and stay lightweight.

Three slices, in order:

0. **A flip scorer** — shuffle a seeded deck, run one Flip, report the itemized fame. No market, no rounds, no UI. This is the first thing built; see §8 for why it's the right starting point.
1. **Single-player** — play through, engine tracks and scores it. Fully client-side. (Sandbox first, then the official solo variant: see §7.)
2. **Online play** — 2–8 players (up to 4 on one season, up to 8 with two combined), join by room code, no hidden information.
3. **AI opponent** — out of scope now, but the architecture keeps the door open.

---

## 2. Recommendation up front

**TypeScript everywhere. React + Vite in the browser. One Node process on your server. No game engine.**

The shape of this game makes that an easy call. There is no dragging and no free-form placement — the player taps *Next* to flip and resolve the next card, occasionally picks from two or three options, then spends two actions in a market list. That is a **forms-and-lists app with a scoreboard**, and the browser is already extremely good at those.

### Why not Godot

- Its web export is a WASM canvas blob — multiple megabytes before your game logic exists. On a low-horsepower box serving over your own bandwidth, that's the biggest cost on the page, and it can't be cached the way a small JS bundle can.
- A text-and-numbers UI is the worst case for canvas rendering. Inside a canvas you reimplement text layout, wrapping, selection, scrolling, and focus. Your market list of card descriptions is exactly this.
- DOM handles touch and mouse/keyboard through the same event model, plus screen readers and browser zoom. In Godot you build both input paths yourself and get no accessibility.
- With no art rights, you need no sprite pipeline, animation system, physics, or scene tree.

Godot earns its keep when you have art, animation, and real-time input. You have cards with numbers on them and a Next button.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | One language for engine, UI, server, and later the AI. |
| Build | Vite | Fast dev server, tiny production bundles, near-zero config. |
| UI | React | Not the leanest option, but it's what AI codegen is most reliable at — which directly serves your stated way of working. On a UI this small, the bundle difference versus Svelte isn't worth the reliability difference. |
| Styling | Plain CSS, Grid/Flex | The board is a 3×2 grid that occasionally grows one row. No framework needed. |
| Server | Node + `ws` (WebSocket) | Shares the rules engine with the client. |
| Reverse proxy | Caddy | Automatic TLS, serves static files directly, one-line WebSocket proxy. |
| Tests | Vitest | Same toolchain as Vite. |

**A note on Go**: your Go experience is real, and a Go relay server would be smaller. But it would leave you writing the rules twice — once in TS for the client, once in Go for the server and the eventual AI — or writing a dumb relay that can't help a player reconnect. Since you're directing rather than hand-writing, "the language I already know" buys much less here than "one rules engine, one test suite" does.

---

## 3. The rules, as the engine must model them

This section is the canonical rules reference for implementation. Anything marked ⚠️ is an open question (collected in §7).

### 3.0 Seasons — the game ships as combinable content sets

**The game has multiple seasons.** Each season is a distinct set of starting cards *and* market cards. Seasons are self-contained games, and **two seasons can be combined into one game supporting up to eight players**.

This is a content-model decision, not a rules decision, and it needs to be designed in from the start rather than retrofitted:

- Every card carries a **`season` tag**. The card table is one file per season, merged at setup.
- Setup takes a **set of enabled seasons**, and derives from them: the starting deck composition, the shared toon deck, the player-count cap, and the market configuration.
- **Nothing in the engine may reference a season.** Season is data for setup and for UI filtering; the phase machine, scoring, and adjacency must never branch on it. If a season introduces a genuinely new mechanic, that becomes a new effect primitive available to all seasons, not a season-conditional code path.
- Starting decks differ per season, so **the six cards in §4.5 are Season 1's starting deck**, not a universal constant. `startingDeck` is season config.

The immediate consequence is that "the six starting cards" and "the market" are both parameters, not constants — which is the same shape the official solo variant already needed (§3.7). One config mechanism serves both.

**Combined play.** Seasons 1 and 2 are **shuffled together into one toon deck** — `toonDeck` is a single pile built from every enabled season. Combining is what makes 5–8 players possible, but note that combined seasons and a big market are *independent*: a combined-season game with 3 players still uses the 5-slot market, because market width keys off player count alone (§3.6).

**Starting decks in a combined game.** Each season has its own distinct starting deck, and **each player is assigned one at random**. The constraint is physical: the box holds **at most 4 copies of each season's starting deck**, which is exactly what an 8-player game consumes.

So `startingDeck` becomes a per-player assignment, not a game-wide constant:

```ts
assignStartingDecks(players, seasons, rng) -> CardId[][]   // one deck per player
```

Three notes on shape:

- **Random, but from the seeded RNG in state** — never `Math.random()`. Deck assignment happens at setup and must replay identically from `{seed, actions}`, same as the shuffle.
- **The 4-copy cap is a supply constraint, not a rules constraint.** Model it as `maxCopiesPerStartingDeck: number` in `Setup`, defaulting to 4 so the digital version matches the paper game out of the box. Nick has explicitly said this can be relaxed later once the rest is settled — having it as config rather than a hardcoded `4` is what makes that a one-line change.
- **Player-choice mode is a plausible future**, not now. Because assignment is already its own function returning per-player decks, swapping random for chosen later means changing how that array is produced, not changing anything downstream.

**The endgame threshold does not scale with player count** — it is 30 fame whether you're playing 2 or 8, single-season or combined. But keep it as **`fameToTriggerEndgame` in `Setup`, not a hardcoded constant**: the solo variant already reuses the same number as its win condition, and a tunable threshold is the single most useful knob for playtesting pacing once games are simulatable. Collect these with the card list (§7).

### 3.1 Setup

- Each player starts with a **six-card starting deck**. In a single-season game everyone gets that season's deck; in a combined game each player is randomly assigned one, max 4 copies of each (§3.0). Season 1's is six rank-0 cards: 2× Caterpillar, 1× Skunk, 1× Dragonfly, 1× Bee, 1× Snail.
- **Market**: five price cards face up in ascending order left→right — **3, 4, 7, 10, 15 fame** in a 1–4 player game. Reveal the top five cards of the shared toon deck and place one under each price card, **sorted by rank, lowest left**.
- First player: "the player who most recently watched a cartoon" — digitally, random or seat order.

### 3.2 Round structure

```
Flip        -> all players simultaneously:
                 shuffle deck face-down
                 reveal one card at a time into the 3x2 grid,
                   left to right, top row then bottom row,
                   into the next unoccupied slot
                 placement abilities resolve BEFORE the next card is revealed
                 repeat until all six slots are occupied,
                   or the deck is exhausted (place as many as possible)

CheckFame   -> all players simultaneously compute fame from the FINISHED grid
                 pure function of the final layout; nothing was accumulated earlier

postFameHooks -> least-fame abilities (Skunk, Ladybug, …) resolve here,
                 after Check Fame and before Market: see 3.4

Market      -> first player then clockwise; each player takes up to 2 actions:
                 Hire   — pay the price card above a market slot, card goes to your DECK
                 Dismiss — pay 5 fame (or a modified cost) to remove a card
                           from your grid, permanently, face-up beside your deck
               refill the market and re-sort by rank after changes
               THEN, 2-player and solo only, ONCE after the LAST player's refill:
                 discard the leftmost and rightmost market cards,
                 refill again, re-sort by rank

Cleanup     -> all players collect their grid back into their deck
               refill the market; TWO independent endgame triggers, checked here:
                 (a) any player generated >= fameToTriggerEndgame in the
                     previous Check Fame
                     -> award the CRITIC'S CHOICE card to the single player with
                        the most fame; on a tie for most, remove it from the game
                 (b) the toon deck can no longer refill the market
               either one -> endgame triggered, go to Final Flip
               otherwise pass the first player card clockwise, fame resets to 0,
                   -> Flip

FinalFlip   -> Flip + Check Fame only. No Market. No Cleanup.
               fame = scoreGrid(grid) + 3 if holding the critic's choice card
               Most fame wins.
               Tie for most: tied players collect grid+deck, reshuffle,
                   Flip and Check Fame again — repeat until resolved.
```

**Four things that are easy to get subtly wrong — encode them as tests immediately:**

1. **Fame is not accumulated during the Flip.** It is computed once, at Check Fame, from the finished grid. There is no "gain fame now" primitive.
2. **The endgame is triggered at Cleanup**, and the trigger round still includes its full Market phase. The Final Flip that follows is a *truncated* round.
3. **There are two endgame triggers, not one** — see §3.2.2. The fame threshold is the one everybody notices; **toon deck depletion** is the other, and it's the one an implementation quietly forgets.
4. **Fame resets to zero at Cleanup.** Unspent fame is forfeited, not banked. There is no cumulative score anywhere in this game.

### 3.2.1 The Critic's Choice card

Exact text: *"If any player generated at least 30 fame, the player who generated the most fame takes the critic's choice card that will generate an additional 3 fame during the Final Flip. If multiple players generated at least 30 fame and are tied for the most fame, return the critic's choice card to the game box instead. This triggers the end of the game (see Final Flip)."*

This is a **leader's bonus awarded at the moment the endgame triggers**, and it's the mirror image of the Skunk: the game hands the trailing player a free dismissal every round, and hands the runaway leader a 3-fame head start on the one round that decides the winner.

**It breaks the "fame is a pure function of the grid" invariant — in a contained way.** §4.1 says `scoreGrid(grid)` is everything. That stays true for every normal round, but the Final Flip is `scoreGrid(grid) + 3` for whoever holds the card. The right fix is *not* to thread a bonus into `scoreGrid` — keep that pure and grid-only — but to make the player's round fame an explicit sum:

```ts
roundFame(player, grid) = scoreGrid(grid).total + playerFameModifiers(player)
```

with the Critic's Choice being the only modifier today. That keeps the grid scorer testable in isolation (and reusable by the step-0 flip scorer, which has no notion of a Critic's Choice) while giving later seasons somewhere to put a persistent per-player bonus without a refactor.

Details to encode:

- **It's awarded only on the fame trigger.** The text conditions the whole award on "if any player generated at least 30 fame." ⚠️ So a game ending *purely* by toon deck depletion (§3.2.2) presumably awards no Critic's Choice — but the rulebook is describing the fame path and doesn't say. Assumed: no card on a depletion-only ending. Confirm.
- **Threshold is `>=`, not `>`.** "At least 30" — exactly 30 triggers it. Worth a test, since off-by-one here changes who wins.
- **The tie rule removes the card from the game entirely**; it is not held over or given to second place. Note that "multiple players ≥30 tied for the most" is logically just "tied for the most" — if anyone reached the threshold, the maximum is necessarily ≥30 — so implement it as a plain tie check on the leaders and don't over-condition it.
- **It is not a card in any sense the engine cares about.** Despite the name, it never enters a deck, a grid, or the market; it is never hired, dismissed, flipped, stacked, or scored positionally. It is a **status applied to a player** — one game-wide token, held by at most one player, worth a flat bonus in one phase. So it lives in `GameState` as `criticsChoiceHolder: PlayerId | null` and never appears in the card table or the `Card` type.

  Keeping it out of the card model is what makes it cheap: no `FameRule`, no adjacency, no interaction with grid effects, and nothing for a card ability to accidentally target. The one place it touches the rest of the engine is `playerFameModifiers` (§4.1).

  If later seasons add more player-level statuses, generalize at that point by widening `playerFameModifiers` — not by making this a card. A single named field is the honest representation of a single token, and the seam is already where the generality belongs.

⚠️ **Open**: if the Final Flip ends in a tie and the tied players re-flip (§3.2), does the holder keep the +3 on every re-flip? Assumed yes — nothing says it's discarded after use, and it's simplest. But note this makes the tiebreak loop asymmetric in a way that could resolve a tie purely by the bonus, which is worth confirming.

### 3.2.2 The second endgame trigger: toon deck depletion

The game also ends when the **shared toon deck can no longer refill the market**. This is not solo-only — it applies at every player count, and it's a real outcome rather than an edge case: eight players hiring two cards a round each drain the toon deck fast, and the 7-slot market needs more cards standing in it to begin with.

Structurally, this means:

- The two triggers are **independent and OR'd**. Either one at Cleanup sets `endgameTriggered` and sends the game to the Final Flip. Both can fire in the same round; that's fine, the outcome is identical.
- **Depletion is a state you detect when a refill fails**, not a separate check — you try to refill and can't. Return that as a fact from the market refill rather than re-deriving it by inspecting `toonDeck.length`. Note there are now **two places a refill happens** — after each player's Market actions, and again after the 2-player/solo decay — so make the failure a return value of one shared `refillMarket()` rather than a check bolted onto the Cleanup step.
- **The 2-player/solo decay burns two extra toon cards every round**, which means those game modes race toward the depletion trigger substantially faster than a 4-player game does. That's almost certainly the *point* of the rule — it's what gives a 2-player game a clock — and it means depletion is the expected ending at low player counts, not a rare one. Worth simulating early to see how many rounds a 2-player game actually lasts.
- The **solo variant differs only in outcome, not in mechanism**: there, failing to refill is a *loss*, whereas in a multiplayer game it just ends the game normally and most fame on the Final Flip wins. Same detection, different consequence — so `winCondition` in `Setup` decides how the trigger is interpreted, and the trigger itself stays shared.

**Both details are now confirmed from the printed rulebook** (Season 2 booklet, "Refill the Market" / Cleanup pages): "If the toon deck is ever depleted, do not add additional cards to the market. Any remaining cards in the market are arranged under the highest price cards, in order by rank. If the market is also depleted, complete the round and proceed to the Final Flip." So:

- **"Can't refill" means the toon deck itself is fully empty**, not merely short of filling every market slot — the earlier "assumed: short" guess was wrong. A short refill is a normal, unremarkable outcome (the market just runs under-width); the trigger only fires once the toon deck has nothing left to reveal.
- **Depletion does not end the game immediately.** The round completes as normal — through the rest of that Market phase and Cleanup — and only then does the game proceed to the Final Flip, same as the fame trigger. The earlier "assumed: yes, same path" guess was right.

This closes what §7 previously listed as "toon deck depletion in multiplayer is undefined" — the fuzz test would have found it, but as a crash rather than as a rule.

### 3.3 The grid

- **3 columns × 2 rows = six slots.** Filled in reading order into the next *unoccupied* slot.
- **Adjacent** = shares a side (left, right, top, bottom). **Diagonals are not adjacent.**
- **Stacking**: a card may be placed on top of another, sharing one slot. "The names, fame, ranks, special effects, and abilities of all **face-up** cards in a stack are active." Face-down cards contribute nothing. **All cards in a stack are considered adjacent to cards in neighboring spaces.**
- **Flipping**: a face-down card flipped face up again "does not activate any of its abilities" — placement abilities fire exactly once, at placement.
- **Monkey (rank 17) — confirmed.** The physical card's own text reads: *"IF placed in the upper row, move **this card** to a row above."* That settles §7 question 4a: the Monkey itself moves, vacating its base slot, which is then re-filled — the plan's earlier inference was right.
- **Season 2 adds a second geometry-changing card: Gorilla (rank 19).** Text: *"IF placed in the upper row, place the next revealed card in a row above."* Unlike the Monkey, the Gorilla stays in the upper row and it's the *next-revealed* card that goes into the extra row. Per the Season 2 rulebook FAQ: an extra row is not itself considered "the upper row" (so a card placed there doesn't retrigger a Monkey/Gorilla check), and if a card is already above the Gorilla, the new row forms *above that card instead* — extra rows stack. Both cards need the extra-row mechanic; neither is encoded yet (`unencodable: true` in `season1.ts` / `season2.ts`).

**Why the draw can exceed six cards.** The loop condition is *six occupied slots*, not *six cards flipped*. A stack puts two cards in one slot; the Monkey vacates its slot by moving above the row. Both leave a slot unoccupied, so the flip continues. Ostrich (1) and Eagle (2) do **not** stop reveals under their base ability — see the correction at §7 question 3 — but the FAQ describes a "final card" edge case for exactly this scenario, which still needs the "next-revealed-card" targeting primitive before it can be encoded (§7 question 3).

### 3.3a Keywords — official glossary (Season 1 rulebook, verbatim)

Quoted in full from the Season 1 rulebook's "Keywords" section (rulespal.com/fliptoons/rulebook, an OCR transcription of the physical rulebook) since several of these are load-bearing for the effect vocabulary in §4.4 and easy to get subtly wrong from memory:

> **Adjacent:** Cards next to each other in a player's grid that share a side (left, right, top, or bottom) are considered adjacent. Cards that are diagonal from one another are not adjacent.
>
> **Dismiss:** Remove a card from a player's grid and place it face up in their area. A player may examine any player's dismissed cards at any time.
>
> **Flip:** Turn over a card in a player's grid. A face-down card has no name, rank, special effects, or abilities and does not generate fame. A face-down card may be flipped face up again by another card's ability. A face-down card flipped face up again does not activate any of its abilities.
>
> **Stack:** Place a card on top of another card in the player's grid so that the special effects and abilities of all cards in the stack are visible. If an ability stacks a card on another card, and there is already a card stacked on the first card, the new card is added to the top of the stack. Stacked cards share a slot in a player's grid, and the names, fame, ranks, special effects, and abilities of all face-up cards in a stack are active.
>
> **Stack Adjacency:** Cards within a stack are not adjacent to one another. All cards in a stack are considered adjacent to cards in neighboring spaces in a player's grid.

Two implementation-relevant details buried in this text: (1) **dismissed cards stay visible** — "a player may examine any player's dismissed cards at any time" — so the dismissed-pile UI needs to be a public, browsable zone per player, not a black box (relevant to Tiger/Cat's `dismissedCard`/`dismissedStartingCard` queries in §4.4). (2) **Stacking has an explicit insertion rule** — new stacked cards always go on *top* of the existing stack. But activity is keyed on each card's own face-up/face-down state independently, not stack position — "the names, fame, ranks, special effects, and abilities of **all face-up cards** in a stack are active," with no mention of stopping at the first face-down member. A stack model needs per-card face state, not a single face-up/face-down flag for the whole stack.

### 3.4 Least-fame abilities — a category, not one card

**Correction: the Season 2 least-fame card is the Firefly, not the Ladybug.** The earlier draft guessed the Ladybug shared the Skunk's condition because it's the most Skunk-shaped name in the Season 2 lineup — but the physical card's text is *"ADJACENT CARDS COST 3 INSTEAD OF 5 TO DISMISS"*, which is a discount card in the Caterpillar/Rat family (§4.5, §7 4d), not a least-fame card at all. The **Firefly** is the actual least-fame card: *"IF you have the least fame after the Check Fame phase, gain 2."* This is a recurring ability type, not a Skunk special case — the Season 1 Skunk and the Season 2 Firefly both key off having the lowest fame after Check Fame. Design the hook for the category from the start; assume more will follow in later seasons.

**The two cards' effects differ, though, which matters for the hook's design.** The Skunk grants a free dismissal; the Firefly grants +2 fame directly. Both share the trigger condition and the tie-handling — confirmed for the Firefly by the Season 2 rulebook FAQ, in the same words as the Skunk's: *"Only one player can benefit from the firefly's ability each round, even if that player no longer has the lowest fame after benefitting from the ability. In case of a tie, the firefly has no effect."* That "no longer has the lowest fame after benefitting" clause is new information: it confirms the hook resolves once, off the frozen Check-Fame snapshot, and never re-evaluates lowest-fame after a hook has already changed a player's effective standing (relevant once a hook grants fame directly, since a dismissal doesn't move the fame number but a gain does).

The Skunk: *if you have the least fame after Check Fame, dismiss a card in your grid at zero cost.* Rulebook FAQ: "Only one player can benefit from the skunk's ability each round. In case of a tie, the skunk has no effect." And: "The skunk's ability is mandatory and does not cost an action."

So the engine needs a resolution hook between Check Fame and Market for abilities conditioned on the fame comparison. Model it as a **card-driven hook, not a phase** — otherwise you've hardcoded one card into the phase machine, and the Firefly would need a second one. Concretely:

- Condition: **strictly** lowest fame among all players (ties → no effect).
- Mandatory, free, does not consume a Market action.
- Skunk's target is a player choice → the first real use of `pendingChoice`. Firefly's effect has no choice to make (flat +2), so it's a good contrast case for the same hook shape without the choice machinery.

⚠️ **Where the hook is read from is an assumption — still open.** The plan assumes `postFameHooks` scans each player's **grid** for a **face-up** Skunk/Firefly — i.e. you only get the ability on rounds you actually flip it. The alternative (it applies whenever the card is anywhere in your deck) makes it an always-on effect and changes the card's strategic weight completely. The grid reading is strongly favoured: every ability in this game is grid-based, face-down cards have no effects, and no rule anywhere reads deck contents. But it is still not quoted anywhere, so worth a direct confirming read of a physical rulebook (§7, question 4b).

**The self-dismiss half of question 4b is answered.** The Season 1 rulebook's FAQ section (transcribed at rulespal.com/fliptoons/rulebook#faq, pasted in verbatim from the actual rulebook text) states: *"The skunk's ability can be used to dismiss itself. This ability is mandatory and does not cost an action."* Encoded as a `faqNote` on the Skunk in `season1.ts` alongside the structured data. The grid-vs-deck question above is still open — nothing in the FAQ addresses it either way.

**Resolve the hooks as an ordered list over a fame snapshot taken at Check Fame.** This part is settled by the rules, not an assumption: "Once calculated, this amount does not change until spent during the Market phase." Fame is locked after Check Fame, so a free dismissal cannot move the standings, and no hook can change who counts as lowest for the hook after it.

⚠️ What is still open: whether a Skunk **and** a Firefly can both fire for the same player in the same round — plausible in a combined-season game where a player's grid holds cards from both seasons. "Only one player can benefit from the skunk's [or firefly's] ability each round" is a per-card rule and says nothing about two different cards stacking on the same player. Not answered by either rulebook's FAQ; confirm before combined-season play is built (§7, question 7).

### 3.5 Deck size is a real tension worth surfacing in the UI

There is no discard pile. Your deck is your whole card pool, reshuffled every Flip. Dismissing removes a card permanently, so **dismissing shrinks your deck**, and "if a player does not have enough cards in their deck to complete their grid, they reveal and place as many as possible" means a sub-six deck flips a partial grid every round thereafter.

That is a genuine strategic cost, not an edge case, and the engine must handle a partial grid as a normal state (adjacency and scoring over empty slots). It also fully answers the old draft's "what happens when the deck runs out" question.

### 3.6 The market

- **The market width and price row are a function of player count alone — not of how many seasons are in play.**

  | Players | Slots | Price cards |
  |---|---|---|
  | 1–4 | 5 | `3, 4, 7, 10, 15` |
  | 5–8 | 7 | `3, 3, 4, 7, 10, 15, 15` |

  Be precise about this: a **combined-season game with 3 players still uses the 5-slot market**. Combining seasons is what *enables* 5–8 players, but the market row is keyed off the actual player count. `prices` derives from `playerCount`, never from `seasons.length` — an easy thing to wire up wrong given that the wide market and combined play usually appear together.
- `prices: number[]` is setup config, market width is `prices.length`, and every rule phrased as "until there are five available" means **until the market is full**. Hardcoding `5` anywhere is a bug waiting for the first eight-player game.
- **Prices are not distinct.** The big market has two slots at 3 and two at 15. Cost is still positional — slot 0 and slot 1 simply happen to cost the same — so nothing about the pricing model changes, but any code that maps price → slot (rather than slot → price) is wrong. Only the slot→price direction is a function.
- Note the shape of the curve: the cheap end is flat and the top end jumps hard, and the big market widens both plateaus. The cheapest slots are near-interchangeable in cost, so the *rank sort* — not the price — is what decides which cheap card you can actually reach. Worth remembering when the AI's evaluation function gets written.
- Cards occupy slots **sorted by rank, lowest left**. A card's cost is therefore *positional*: hire cost = the price card above the slot it currently sits in.
- After any change: "refill the market by revealing cards from the toon deck until there are five available and rearrange the cards in the market so that they are ordered by rank." Note the order — **refill, then re-sort** — which means buying a cheap low-rank card can make a card you left behind more expensive.
- **Rank ties have a defined tiebreak, and it is a rule, not an implementation choice: on a tie, the newly drawn card goes to the more right-hand (higher-priced) slot.** Incumbents keep their position; arrivals settle to the right of equal-ranked cards already there.

  That is exactly a **stable sort by `(rank, insertionIndex)` ascending**, with insertion index being the order cards were revealed from the toon deck — which is already deterministic from the seed. Implement it as an explicit comparator rather than relying on `Array.prototype.sort` being stable, so the guarantee is in your code and not in a spec footnote.

  This matters more than it sounds. Ranks collide constantly — all six Season 1 starting cards are rank 0, and two seasons shuffled into one toon deck reuse ranks freely — and tied cards can straddle a price boundary (3 vs 4, or 10 vs 15). Get it wrong and the "same seed + same actions ⇒ same state" guarantee breaks intermittently, which is a miserable class of bug to chase. Note the tiebreak is also *strategically* real: it means a card you've been eyeing gets **cheaper** as same-ranked cards arrive after it, never more expensive.
- **The 2-player / solo market decay.** Exact text: *"If playing with two players, after refilling the market during the last player's market phase, discard the leftmost and rightmost cards in the market. Refill the market again and rearrange the cards by rank, as needed."*

  Three things to get right, all of which an earlier draft of this plan had wrong:

  - **It fires at the end of the Market phase, not during Cleanup** — specifically after the *last* player's refill.
  - **It fires once per round, not once per player.** Two cards leave, not two per turn.
  - It's **discard → refill → re-sort**, so the two replacement cards are subject to the normal rank sort and tiebreak, and can land anywhere in the row.

  This applies to **2-player and solo** games. `marketDecayPerRound` in `Setup` covers both.

Known ranks so far: Skunk 0, Ostrich 1, Eagle 2, Donkey 3, Butterfly 4, Dog 5, Goat 6, Camel 8, Horse 10, Snake 11, Elephant 12, Alligator 15, Monkey 17, Pig 18, Turkey 20, Bear 24, Cow 25. (Starting cards are all rank 0.)

### 3.7 The official solo variant

Distinct from a single-player sandbox:

- Setup: starting deck is **"1 dragonfly, 1 bee, 1 snail, and 3 caterpillars (instead of 2 as in the multiplayer game)"** — the 3rd caterpillar replaces the Skunk. The **Pig is removed from the shared toon deck**. Note the two exclusions have different scopes. Then discard 20 toon cards from the toon deck at setup (17 easy / 20 normal / 23 hard).
- The **same leftmost/rightmost market decay as the 2-player game** (§3.6), at the same point — after the Market phase refill.
- **Win**: generate 30 fame before the toon deck depletes. **Lose**: not enough cards remain to refill the market.

This needs toon-deck-depletion tracking that the multiplayer rules never exercise.

---

## 4. The spine: a pure rules engine

This is the most important decision in the document. Everything else follows from it.

Build the game rules as a **standalone TypeScript module with zero dependencies** — no React, no DOM, no network, no filesystem, no `Date.now()`, no `Math.random()`.

```ts
reduce(state: GameState, action: Action): GameState   // pure, deterministic
legalActions(state, playerId): Action[]               // what can I do right now
scoreGrid(grid: Grid): FameBreakdown                  // pure fn of a FINISHED grid
roundFame(state, playerId): FameBreakdown             // scoreGrid + per-player modifiers
```

Randomness comes from a **seeded PRNG carried inside the state**. Given the same seed and the same sequence of actions, the game replays identically on any machine.

Why this constraint pays off three times:

- **Single-player** is the engine plus a UI, running entirely in the browser. No server at all.
- **Multiplayer** is the same engine on the server. Clients send actions, the server validates against `legalActions` and broadcasts. Zero rules duplication.
- **The AI** is the same engine cloned and run thousands of times. This matters more here than in most games: the only real decision is what to hire or dismiss, and its payoff is entirely in *future* rounds' fame — this round's fame is spent or lost either way. The honest way to evaluate a purchase is to simulate forward rounds with and without it. A pure, I/O-free engine makes that a tight loop instead of a rewrite.

Test the engine directly, with no browser involved.

### 4.1 `scoreGrid` is a pure function — the biggest simplification in this revision

Because no placement ability grants fame, scoring is not a running total that effects mutate. It is:

```ts
scoreGrid(grid) -> {
  total: number,
  lines: { slot: SlotRef, cardId: CardId, base: number, bonuses: {reason, n}[] }[]
}
```

Take the itemization seriously. It is your Check Fame UI, your debugging tool, and the thing that makes an unfamiliar card interaction understandable rather than mysterious. It's also trivially testable: hand-build a grid, assert a number.

**One thing is not grid-derived: the Critic's Choice card's +3 on the Final Flip (§3.2.1).** Don't smuggle it into `scoreGrid` — keep that pure and grid-only so it stays isolated-testable and reusable by the step-0 flip scorer. Instead, a player's fame for a round is a sum:

```ts
roundFame(state, playerId) = scoreGrid(player.grid) + playerFameModifiers(state, playerId)
```

Today `playerFameModifiers` returns `+3` for the Critic's Choice holder during the Final Flip and `0` otherwise. Having the seam there now means a later season introducing any persistent per-player bonus drops in without touching the grid scorer. The itemized breakdown should show it as its own line, since "why am I 3 ahead" is exactly the question the final screen needs to answer.

**Consequence for the effect vocabulary:** placement abilities and scoring rules are *two different kinds of thing* and should not share a representation. Placement abilities are `Grid -> Grid` mutations. Scoring rules are `(card, grid) -> number` queries. The old draft's single `effects[]` array with a `when` field conflated them.

### 4.2 State

```ts
GameState = {
  phase: 'flip' | 'checkFame' | 'postFameHooks' | 'market' | 'cleanup'
       | 'finalFlip' | 'finalScore' | 'tiebreak' | 'ended',
  round: number,
  rng: RngState,
  endgameTriggered: boolean,
  criticsChoiceHolder: PlayerId | null,   // single game-wide token; null = unawarded
                                          // or removed from the game on a tie
  toonDeck: CardId[],              // shared draw pile — depletion matters in solo
  market: {
    prices: number[],              // 5 price cards, ascending
    slots: (CardId | null)[]       // index i costs prices[i]; kept rank-sorted
  },
  players: {
    id, name,
    deck: CardId[],                // shuffled at each Flip; no discard pile
    grid: Grid,
    dismissed: CardId[],           // out of the game, face-up beside the deck
    fame: number,                  // THIS round's score AND spending power
    actionsRemaining: number       // during market
  }[],
  firstPlayer: number,
  activePlayer: number,
  pendingChoice?: { playerId, prompt, options: Choice[] },
  log: LogEntry[]
}
```

**Fame is one field, and it's per-round.** Resist any urge to track "score" and "money" separately, or to keep a cumulative total — the whole design pressure comes from one number that is simultaneously your score, your spending power, and expiring at the end of the round. There's deliberately no fame history in `GameState`: the rules never read past rounds, so keeping the array there would just be an invitation to sum it and quietly invent a cumulative score the game doesn't have. If you want per-round history in the UI, derive it from the action log.

### 4.3 The grid model

The old draft's "three columns that grow vertically, slots spliced anywhere" was built for a mechanic that doesn't exist. The real shape, **updated in the multi-row pass (2026-08-16)** that encoded Gorilla — see `packages/engine/{types.ts,grid.ts}`:

```ts
Slot = { cards: CardId[]; faceUp: boolean[] }   // bottom -> top; usually 0 or 1 deep
Grid = {
  base: (Slot | null)[][],     // 2 rows x 3 cols — the six slots that must be occupied
  extraRows: (Slot | null)[][] // 3-col-wide rows stacked above base, bottom-to-top:
                                //   extraRows[0] sits directly above base row 0,
                                //   extraRows[1] above that, etc. Created by
                                //   Monkey/Gorilla; none of these are among the six.
                                // GROWN LAZILY — starts as [] and a new row is
                                // pushed only when a relocating/diverted card needs
                                // to land above the current topmost occupied row in
                                // its column (grid.ts's extraRowSlotAbove).
}
```

This replaces the earlier single-row `extraRow: (Slot | null)[]`, which could not represent the documented unbounded-stacking case (Season 2 FAQ, §3.3): "if a card is already above the gorilla/monkey, the new row forms above that card instead — extra rows stack."

- `isFull(grid)` = every `base` slot is occupied. That's the Flip loop condition — **`extraRows` is deliberately not part of it**, which is why the Monkey's (or Gorilla's diverted-card's) row doesn't end the round early.
- **Row-ordering reading, implemented but not yet directly confirmed by the user** (flagged the same way the Return destination question was flagged before its confirmation): "the new row forms above THAT CARD instead" is read as *same column, stacking vertically* — a relocating/diverted card targeting column `col` walks straight up column `col` only, to the first empty row in that column, growing a new row if every existing row already has an occupant there. It does **not** look sideways for free space in an existing row. `grid.ts`'s `extraRowSlotAbove(grid, col)` implements this and is the single choke point both Monkey (relocating itself) and Gorilla (diverting the next-revealed card) go through.
- `adjacent(pos)` = orthogonal neighbours only, across `extraRows` and `base` as one 3-wide column stack. A card in `extraRows[0]` is adjacent to the base top-row card in the same column; a card in `extraRows[r]` for `r > 0` is adjacent to `extraRows[r-1]` in the same column (and `extraRows[r+1]` if it exists) — a **vertical chain**, not mutual adjacency across every extra row. Confirmed for Gorilla by the same FAQ passage cited above (a second row forms above the existing occupant, not beside it). Lateral adjacency *within* a single extra row (`extraRows[r][c]` to `extraRows[r][c±1]`) still holds, same as before.
- Stack expansion: adjacency and any "count cards" query must expand each slot into its face-up cards. "All cards in a stack are considered adjacent to cards in neighboring spaces."
- Keep the base dimensions as config rather than hardcoded constants — cheap now.

### 4.4 Cards as data

The complexity of this game lives in the cards. Represent them as a **card table plus a small vocabulary of primitives** — not a `switch` on card id scattered through the reducer. Note there is **no `cost` field**: cost is positional in the market.

```ts
type Card = {
  id: CardId
  name: string
  season: SeasonId             // content set — setup/UI only, never branched on in the engine
  rank: number                 // market sort key -> determines price
  fame: FameRule               // evaluated at Check Fame, pure
  onPlace?: PlaceEffect[]      // Grid -> Grid, fires once at placement
  onHire?: Effect[]            // "hired or gained" trigger icon
  onDismiss?: Effect[]         // "dismissed" trigger icon
  dismissCost?: number         // overrides the default 5
  postFameHook?: PostFameHook  // e.g. Skunk
}
```

- **`FameRule`** is a small expression: a base value plus bonus terms, each a count over a grid query (`uniqueAdjacentNames`, `adjacentWithTrait`, `inCenterColumn`, …).
- **`PlaceEffect`** is a board mutation: `stack`, `flip`, `moveToExtraRow`, `stopReveals`, `choose`.
- Start the vocabulary small and grow it only when a card genuinely can't be expressed. A card needing a player decision is just an effect whose resolution parks a `pendingChoice`.

Data-driven wins here for a reason specific to how you're working: as the director, you can read and correct a table of cards far more reliably than you can review effect logic spread across files. It also keeps all card text in one swappable place, which matters since you don't own the original wording either — and it makes the market, the deck list, and the resolve log all render from one source.

### 4.5 The six starting cards, encoded

These are the first real test of the vocabulary. Encode them **before** writing the reducer: three of the six don't fit a naive "gain fame" primitive, which is exactly the signal you want.

```ts
{ id: 'bee',        name: 'Bee',        rank: 0, fame: { base: 1 } }

{ id: 'snail',      name: 'Snail',      rank: 0, fame: { base: 2 } }

{ id: 'dragonfly',  name: 'Dragonfly',  rank: 0,
  fame: { base: 0, bonuses: [{ n: 1, per: 'uniqueAdjacentName' }] } }

{ id: 'caterpillar', name: 'Caterpillar', rank: 0,
  fame: { base: 0 },
  dismissCost: 3 }                      // 3 instead of the standard 5

{ id: 'skunk',      name: 'Skunk',      rank: 0,
  fame: { base: 0 },
  postFameHook: {
    condition: 'strictlyLowestFame',
    mandatory: true,
    consumesAction: false,
    effect: { kind: 'dismiss', target: 'chooseOwnGridCard', cost: 0 }
  } }
```

Season 1 starting deck = 2× caterpillar, skunk, dragonfly, bee, snail. (`season: 1` omitted above for readability; it's a required field.) Other seasons supply their own — see §3.0.

What each one proves out:

- **Bee / Snail** — the trivial base case.
- **Dragonfly** — needs "count **distinct names** among orthogonally-adjacent cards, including every face-up card in an adjacent stack." Forces the adjacency + stack-expansion API on day one. ⚠️ Does "unique" mean distinct names among the adjacent set, or names not appearing elsewhere in the grid? Assumed the former.
- **Caterpillar** — a cost modifier read during a *different phase* (Market), proving that card data is consulted outside scoring. **Confirmed self-referential** by the full transcription: the Caterpillar's own banner reads *"COSTS 3 TO DISMISS INSTEAD OF 5"* — phrased as a property of the card itself — whereas Season 2's Ladybug and Rat, which *do* discount other cards, are phrased as *"ADJACENT CARDS COST 3..."* and *"CARDS IN RAT'S STACK COST 1 FEWER..."* respectively. The game consistently distinguishes self-discount from other-discount phrasing, so §7 question 4d is resolved: `dismissCost` on the `Card` type stays self-only, and the Ladybug/Rat variants need a separate field once encoded (currently `unencodable: true` in `season2.ts`).
- **Skunk** — conditional, mandatory, action-free, cross-player comparison, and a player choice. The hardest of the six, and the reason `postFameHook` exists as its own field rather than being crammed into `onPlace`.

### 4.6 One setup config serves seasons, player count, and variants

Three separate things — seasons (§3.0), the 1–4 vs 5–8 player market, and the official solo variant (§3.7) — all vary the *same* handful of setup parameters. Build one config object rather than three special cases:

```ts
type Setup = {
  seasons: SeasonId[]          // one, or two for a combined up-to-8-player game
  playerCount: number
  deckAssignment: 'random' | 'chosen'      // 'chosen' is a future mode; random for now
  maxCopiesPerStartingDeck: number         // 4 — paper supply limit, relaxable later
  excludeFromToonDeck: CardId[]// solo removes the Pig
  toonDeckTrim: number         // solo discards 17 / 20 / 23 at setup
  startingDeckOverride?: CardId[]          // solo: swap skunk -> 3rd caterpillar
  prices: number[]             // derived from playerCount ALONE, not seasons.length:
                               //   1-4 players -> [3,4,7,10,15]
                               //   5-8 players -> [3,3,4,7,10,15,15]
                               // market width IS prices.length — never a literal 5
  marketDecayPerRound: 'none' | 'leftAndRight'   // 2-player and solo
  fameToTriggerEndgame: number             // 30 at every player count; tunable for playtesting
  winCondition: 'mostFameOnFinalFlip'      // multiplayer: depletion just ends the game
              | 'reachFameBeforeDeckOut'   // solo: depletion is a LOSS
  seed: number
}
```

Everything downstream reads this. Two things it deliberately gets right:

- **The solo variant's two exclusions have different scopes** — the Skunk is swapped out of the *starting deck*, the Pig is removed from the *shared toon deck* — which is why they're separate fields rather than one list.
- **There is no game-wide `startingDeck` field.** In a combined game players get *different* starting decks (§3.0), so the deck is per-player and produced by `assignStartingDecks`. Making that the general case from the start avoids a refactor the moment two seasons are enabled; single-season games are just the degenerate case where every player draws the same one.

### 4.7 The action log is the save format

Store games as `{ seed, actions[] }` and replay to reconstruct state. Don't serialize `GameState` as the primary format.

Because resolution is nearly automatic, the action list is short and mostly `advance` — which makes replay fast and logs tiny. This gives you, for free: single-player save/resume via `localStorage`; reconnect and mid-game spectator join; undo (replay to N−1), valuable while tuning; and "paste your game log" bug reports that reproduce exactly on your machine.

Nearly free now, genuinely painful to retrofit.

---

## 5. Interaction and layout

The player never places a card, so there is no drag-and-drop and no select-then-place. Four things to interact with:

**1. The Flip view.** A 3×2 CSS Grid filling slot by slot, with the running log beneath and every player's fame across the top. One large primary button flips and resolves the next card. Because cards land one at a time and the grid can sprout a row above it, reserve vertical space or animate the growth gently so a new row doesn't jerk the layout out from under a tapping finger. The moments worth animating clearly are the three that break the "one card, one slot" expectation: a stack landing, the Monkey moving up, and a reveal-stopping card ending the round early.

**2. The choice prompt.** When the engine parks a `pendingChoice`, the primary button is replaced by the options as large tap targets, with the card's text above them.

**3. Check Fame.** This is where all the fame lands at once, so render `scoreGrid`'s itemized breakdown — which card scored what and why — rather than just showing a total. This is the single view that teaches the game.

**4. The Market.** The five slots as a list showing the price card above each and the card's effect text, **alongside your still-visible grid**, since dismiss targets the cards in front of you. Your two remaining actions as a prominent counter. Tap a market slot to hire, tap a grid card to dismiss. Anything unaffordable renders disabled — drive that from `legalActions` rather than duplicating cost logic in the UI. Show the caterpillar's reduced dismiss cost on the card itself.

Because unspent fame is forfeited at Cleanup, the market must say so plainly — show remaining fame with a "resets after this phase" cue rather than leaving a new player to discover it by losing 11 points. This is the most important thing for the UI to teach. Second most important: that dismissing shrinks your deck permanently (§3.5).

Every interaction is a button press, so touch and keyboard support are the same code path. Layout is a two-pane desktop view (grid left, log and market right) collapsing to a single scrolling column in portrait. The one place worth spending real design effort is **legibility of card text at phone size** — that's your entire art direction. Generous type size, clear rank/price/effect hierarchy, and one `Card` component reused across grid, market, and deck list.

---

## 6. Multiplayer

No hidden information and a single active player during the Market make this about as simple as networked multiplayer gets.

- Server holds authoritative `GameState` per room, in an in-memory `Map<roomCode, Room>`.
- Client sends an `Action`. Server checks the sender is allowed to act right now and that the action appears in `legalActions`. If valid, it applies it and broadcasts `{ action, version }`; each client applies it locally.
- On reconnect, the client sends its last known version and the server replies with the actions it missed — or a full state snapshot if it's too far behind.
- Room codes: 4–6 characters from an unambiguous alphabet (no `0`/`O`, `1`/`I`/`l`).

**The turn model is not uniform across phases**, which is the one thing to get right:

- **Flip**: simultaneous by the rules — each player has their own deck and grid. Simplest correct MVP is to advance all players' reveals together off one shared *Next*, so everyone stays in sync and watches each other's cards land. A `pendingChoice` belongs to one player; others wait.
- **Check Fame**: simultaneous, automatic.
- **Skunk hook**: needs *all* players' fame, so it must run after every player has scored — a natural synchronisation barrier.
- **Market**: strictly turn-based, two actions each, starting with the first player and going clockwise.
- **Final Flip tiebreak**: only the tied players participate; everyone else spectates.

### Deck secrecy: deliberately not a concern

Broadcasting full state means the seed and undrawn deck order reach every client, so a player with devtools open could read future flips. **This is a non-competitive game among friends, so that's an accepted non-issue** — and skipping it is a genuine simplification: the server stays a plain validate-and-broadcast loop; `reduce` can shuffle and flip from the seeded RNG inside the state, so client and server run identical code paths; reconnect just ships the whole state with no filtering pass.

If this ever needs to change, the fix is contained: resolve flips on the server and carry the revealed card in the broadcast action. Worth knowing the escape hatch exists; not worth building now.

**Stated MVP tradeoff**: rooms live in memory only. A server restart drops every in-progress game. Acceptable for a first version among friends, but a choice rather than an oversight — the fix later is persisting the action log to SQLite, which the log-as-save-format decision already sets up.

---

## 7. Open questions

These block *card transcription*, not the architecture. Resolve them with the physical cards in hand; none require a decision before starting the engine.

**Blocking the card table (build step 4):**

1. ~~**The full card list, per season, with exact ability text and ranks.**~~ **Done.** All 62 unique cards (12 starters + 52 market cards) transcribed from photos of the physical cards, cross-checked against the printed rulebook/FAQ pages (`Referance/*.HEIC`, Thunderworks Games). Verbatim text lives in `cards.csv` at the repo root; the structured encoding against the §4.4 schema lives in `packages/engine/cards/{types,season1,season2,index}.ts`. As expected, translating the text surfaced cards that don't fit the existing effect vocabulary. This pass also answered questions 3, 4, 4a, 4c, 4d, and 7 below, and corrected one of the plan's own assumptions (§3.4's Ladybug/Firefly mixup).

   **Update (2026-08-16), second encoding pass — see §11 below.** Once the solo game loop (Market/hire/dismiss/toonDeck/dismissed-pile) existed as real state, a second pass wired that state into the cards that only needed it, not new mechanics. 25 more cards went from `unencodable`/`fameUnencodable` to fully scored: `cat`, `tiger`, `opossum`, `butterfly`, `horse`, `peacock`, `raccoon`, `panther`, `crow`, `donkey`, `alligator`, `groundhog`, `vulture`, `ladybug`, `rat`, `mongoose`, plus the earlier pass's `mole`, `starfish`, `swordfish`, `salamander`, `coyote`, `crab`, `zebra`, `gorilla`. **7 cards remain flagged**, each for a genuine, documented reason rather than a stale "no Market phase" excuse: `camel`, `fox` (need cross-player grid state — no multiplayer in this solo engine), `axolotl`, `platypus` (the "Big Button" expansion component — confirmed by Nick to be a separate optional insert, off by default, out of scope), `pig` (genuinely multiplayer-targeting text; solo setup already excludes it from the toon deck per its own `faqNote`), `snake` (main line fully encoded; only the FAQ's nested "resolve the stacked card's own When-Hired ability after the Flip phase" chain is unencoded — no deferred-post-Flip onHire mechanism exists yet).
2. ~~The price card values, and the 5–8 player market.~~ **Answered: `3,4,7,10,15` over 5 slots at 1–4 players; `3,3,4,7,10,15,15` over 7 slots at 5–8 with Seasons 1+2 shuffled together. Rank ties resolve to the right-hand slot.**
3. ~~**Ostrich (1) and Eagle (2)**~~ **Fully answered — base ability confirmed by the physical cards, edge case confirmed as fact by the physical Season 2 rulebook's own "Key Concepts" page (not just the FAQ).** The *base* ability is not a stop-reveals effect: from the photographed cards, Ostrich (rank 1, fame 1) reads *"Stack the next revealed card on this card"* and Eagle (rank 2, fame 4, cannot be flipped) reads *"Flip the next revealed card unless it cannot be flipped (its ability does not activate)."* Both mutate the *next* card that gets revealed rather than halting the reveal loop — the earlier draft's "stops further reveals" guess doesn't match either card's own text.

   The rulebook FAQ had already surfaced the edge case that explains where the "stops reveals" impression came from — but as of 2026-08-15 this is now confirmed directly from the physical rulebook's "Key Concepts" page (`Referance/IMG_4309.HEIC`, read directly, not OCR), under the named concept **"Next Revealed Card"**, quoted here in full since it's load-bearing for every card that references the next revealed card (Ostrich, Eagle, Salamander, Swordfish, Gorilla):

   > **Next Revealed Card:** If a card placed in the last slot of a player's grid refers to the next revealed card, ignore that part of its ability. A card's ability applies only once, even if the next revealed card moves or is returned after being placed. Fully resolve the ability affecting the next revealed card before any abilities on that card. If the next revealed card is flipped or returned, do not resolve any of its abilities.

   This settles the edge case as an explicit, general rule (not a special case invented to explain Ostrich/Eagle specifically): if Ostrich/Eagle/Salamander/Swordfish/Gorilla fills the grid's last slot, its next-revealed-card clause is simply ignored — no next card gets revealed at all, so there's nothing to stack/flip/return. It is *still not* a general "stops all further reveals" effect for any other reason. The engine (`packages/engine/flip.ts`) implements Ostrich, Eagle, Salamander, and Swordfish's next-revealed-card effects atop a shared deferred-effect ("`pending`") primitive; Gorilla's is deliberately left unencoded (see item 3a below) since it additionally requires the extra-row-stacking mechanic, not just this targeting rule.

   The same rulebook page also defines **"Previous Placed Card"** (relevant to Elephant, Turkey, Starfish, Swordfish, Coyote's stack-fallback, and any future card referencing it):

   > **Previous Placed Card:** If a card placed in the first slot of a player's grid refers to a previous placed card, ignore that part of its ability. When a card refers to a previous placed card, it affects the card last added to the grid, even if that card has moved to a new position. If the previous placed card was returned, the ability affects the card last added to the grid instead.

   This confirms the engine's "track the last-placed card by identity, not grid position" approach (`flip.ts`'s `lastPlaced` pointer) is correct, including through relocation. The "if returned, affects the card last added to the grid instead" clause is a case worth a regression test once Return is fully wired up (see item 3b).

3a. ~~**Gorilla (Season 2, rank 19)**~~ **Resolved (2026-08-16).** Base ability confirmed by the physical card (*"IF placed in the upper row, place the next revealed card in a row above"*), same next-revealed-card primitive as Ostrich/Eagle/Salamander (§7 item 3). `grid.ts`'s `Grid.extraRow` (single row) was replaced with `Grid.extraRows` (an array of rows, grown lazily) specifically to support the Season 2 FAQ's unbounded stacking case ("a second such row stacks *above* an existing one"). Gorilla's `onPlace` is now `{ kind: 'moveNextRevealedToExtraRowIfUpperRow' }` (`flip.ts`), `unencodable: true` has been removed from its `season2.ts` entry, and its fame (base 5, already correct) is unaffected. The row-ordering reading this implements — a relocating/diverted card stacks in the *same column* as any existing occupant, not a different column of the same row — is documented at `grid.ts`'s `extraRowSlotAbove` and is still not directly confirmed by the user (flagged there and in `season2.ts`'s Gorilla `faqNote`, same as the Return destination question was before its confirmation). See §4.3 for the updated grid model and `packages/engine/season2-effects.test.ts`'s Gorilla tests.

3b. **Return (Season 2 keyword)** — confirmed directly from the same rulebook page: *"Return: Place a card face down on the bottom of a player's deck. If a player's deck has no cards when a card is returned, the returned card becomes their deck and they continue their Flip phase if any empty slots remain in their grid."* This settles the destination question the engine had flagged as an unconfirmed guess (bottom-of-deck was already the implemented reading — now confirmed rather than assumed) for Salamander, Coyote, Crab, and Zebra. **Both remaining details are now reflected in `flip.ts` (2026-08-15 pass).** (1) Face-down: `Deck` is a plain `CardId[]` with no per-card face state — only `Slot.faceUp` (a grid concept) exists, and per the Flip keyword a face-down card's name/rank/abilities only matter while it "takes a slot in a player's grid," so a card leaving the grid for the deck has nothing left for "face down" to persist; it redraws face-up like any other card, same as §6's "deck secrecy: deliberately not a concern." See `returnCardToDeckBottom`'s comment in `flip.ts` for the one case (a card returned while already face-down in the grid) where this reading is load-bearing rather than moot. (2) The empty-deck special case needed no new code at all: because Return only ever fires while resolving a card just pulled via `remainingDeck.shift()`, and the push back onto the deck happens synchronously before the flip loop's `while (remainingDeck.length > 0)` re-checks, a Return that empties-then-refills the deck to one card is indistinguishable from the loop's ordinary continuation — see `season2-effects.test.ts`'s "Return while the deck is empty" test for a traced example. **Return's optional-vs-mandatory question is now answered — ruled directly by the user (2026-08-16):** "Return is mandatory unless a card says 'may return' or similar." None of Salamander/Coyote/Crab/Zebra's transcribed text uses "may" — all four are mandatory, which matches how `flip.ts` already applies them unconditionally (no engine change needed; this ruling confirms the existing behavior rather than changing it). Keep this phrasing in mind for any future card (Season 2 remainder, later seasons) that does say "may return."
4. ~~**Snake (11)**~~ **Confirmed, more specific than assumed.** Text: *"Dismiss the top card of your deck and stack the top card from the toon deck on this card."* It doesn't stack the next-revealed card onto itself — it dismisses from the player's own deck and pulls a fresh card from the shared toon deck onto the Snake. Still extends the flip past six the same way (occupies no new slot).

**Assumptions encoded in the plan that must be confirmed before they're baked into `grid.ts` and `cards.ts`:**

4a. ~~**Monkey**~~ **Confirmed.** Card text: *"IF placed in the upper row, move **this card** to a row above."* The Monkey itself moves, vacating and re-filling its base slot — the plan's inference was right. Season 2's Gorilla (rank 19) is a second, related geometry-changing card; see §3.3.
4b. ~~**Skunk**~~ **Fully answered — ruled directly by the user (2026-08-16).** "All cards only resolve if they are face up in your grid, including Skunk." Settles the grid-vs-deck half definitively: the ability is read from a face-up Skunk in the grid, never from anywhere in the deck. This is also just the general rule for every card's abilities (per the "Flip" keyword: a face-down card "has no name, rank, special effects, or abilities"), so it needed no engine change — `postFameHook`/`onPlace`/etc. were already only ever evaluated against face-up grid cards; this ruling makes that assumption explicit and confirmed rather than merely consistent-by-construction. Combined with the self-dismiss answer from §3.4, question 4b is fully closed.
4c. ~~**Dragonfly**~~ **Answered — ruled directly by the user (2026-08-15).** "Unique means cards with different names that are orthogonally adjacent." Matches the plan's original assumption, not the "unique within the whole grid" alternative. (An earlier pass had claimed the FAQ settled this with the phrase "1 per each unique adjacent toon" — that quote does not appear anywhere in the actual Season 1 FAQ text, transcribed verbatim from the rulebook at rulespal.com/fliptoons/rulebook#faq, which has no Dragonfly entry at all. It was a fabrication from an earlier fetch-and-summarize pass and has been removed from `season1.ts`/`cards.csv`; the question is settled by the user's ruling above instead, not by that quote.)
4d. ~~**Caterpillar**~~ **Confirmed** — see §4.5. Self-referential, not a global discount.

**Blocking nothing, but decide before writing `adjacent()`:**

5. Two Monkeys (or a Monkey and a Gorilla) in one round — one extra row or two? Are two extra-row cards adjacent to each other laterally? **Implemented (2026-08-16), still not directly confirmed.** `Grid.extraRows` now supports unbounded stacking (§4.3), and a second geometry-trigger targeting the same column stacks a new row directly above the existing occupant — implemented per the Season 2 FAQ's "the new row forms above that card instead," read as same-column stacking. Lateral adjacency *within* one extra row is unchanged (still holds, same as base rows); adjacency *between* extra rows is a vertical chain (row *r* only touches row *r-1* and *r+1* in the same column), not mutual adjacency across every extra row. See `grid.ts`'s `extraRowSlotAbove`/`adjacentPositions` and §7 item 3a.
6. ~~**Combined-season play (§3.0).**~~ **Fully answered:** one merged toon deck, market keyed to player count, random per-player starting decks capped at 4 copies, and the endgame threshold stays at 30 fame regardless of player count.
7. ~~**Ladybug (Season 2)**~~ **Answered, and it changes the plan.** The Ladybug is not a least-fame card — see the §3.4 correction. The actual Season 2 least-fame card is the **Firefly**, and the Skunk/Firefly-stacking question from this item now applies to the Firefly, not the Ladybug (§3.4).
9. **Player-count-dependent rules: believed complete, worth one confirming pass.** A targeted sweep of the rulebook found exactly **one** 2-player-exclusive rule (the market decay, §3.6) and no player-count variation in fame threshold, actions per turn, first-player handling, or endgame procedure. Solo has its own setup and win condition — now fully confirmed from the printed rulebook, including the combined-season solo variant (67/70/73-card discard tiers, either starting-deck choice, Pig and first-player/Critic's-Choice cards excluded). That said, give the 2-player-specific sidebar one direct read too — it's the kind of rule that's easy to miss in a summarizing pass.
8. ~~**Toon deck depletion in multiplayer is undefined.**~~ **Fully answered**, including the two remaining sub-questions — see §3.2.2: depletion grants a Final Flip exactly like the fame trigger (confirmed), and "can't refill" means the toon deck itself is empty, not merely a short market (the earlier "assumed: short" guess was wrong).

**Product decision, needed before slice 1:**

8. **Does slice 1 build the official solo variant (§3.7) or a single-player sandbox?** Recommendation: **build the sandbox first** — it's the multiplayer rules with one player, so it's free once the engine exists and it's the fastest path to validating card transcription. Add the official solo variant afterwards as a config flag (`{ startingDeck, excludedCards, toonDeckTrim, marketDecayPerRound, winCondition }`), since its differences are all setup and end-condition, not new mechanics.

---

## 8. Build order

**Step 0 is the new first milestone: a single-flip scorer.** Shuffle a deck from a seed, run one Flip, print the itemized fame breakdown. No market, no rounds, no endgame, no UI beyond a CLI or a test.

This is a well-chosen starting point and worth stating why, because it's smaller than it looks and buys more than it looks:

- It exercises **exactly the parts of the engine that are hardest to get right and cheapest to test**: the flip loop's six-occupied-slots condition, placement effects that stack or relocate, adjacency with stack expansion, and `scoreGrid`. Those are where the rules bugs live.
- It needs **none of the parts that are still blocked on open questions** — no pricing, no turn order, no endgame, no phases beyond Flip and Check Fame.
- It's the natural **card-transcription test harness**. As each new card's text arrives, "flip a deck containing it and read the breakdown" is how you check you encoded it right — which matters given that step 4 is the bulk of the work.
- It's the **AI's inner loop**, unchanged. Evaluating a hire means simulating flips and scoring them. Building it first means the simulation core is battle-tested long before there's an AI.

Then:

1. **Step 0 — the flip scorer.** Types, `Setup`, seeded RNG and shuffle, the grid model, `adjacent()` with stack expansion, placement effects, `scoreGrid`, and **Season 1's six starting cards as data**. Output the itemized breakdown. Test by asserting known grids score known totals. No pixels, no phases beyond Flip → Check Fame.
2. **The rest of the round.** Market and hire/dismiss (rank-sorted slots, `[3,4,7,10,15]` positional pricing, refill-then-re-sort, 2-player decay), Cleanup, the least-fame hooks, the endgame trigger and the Final Flip tiebreak loop. Needs a few placeholder market cards; real ones can wait. A game of nothing but starting cards is already complete, playable, and testable — that's the milestone here.
3. **Single-player UI.** React over the engine: flip view, log, choice prompt, Check Fame breakdown, market. Save/resume via the action log. Ship this — it's genuinely useful alone, and it's where you'll discover whether the rules are transcribed correctly.
4. **Card table buildout.** Transcribe each season into data, growing the vocabulary as needed. Likely the largest chunk of actual work, and it's data entry plus tests, not architecture. Gated on §7. The step-0 scorer is how you verify each card as it lands.
5. **Server.** Node + `ws`, room codes, authoritative state, reconnect, per-phase turn rules. Same engine module imported on both sides.
6. **Official solo variant**, and **combined-season / 5–8 player setup** — both just `Setup` values by this point, assuming §4.6 held.
7. **AI.** Later. Because the only real decision is hire-or-dismiss, a simulation-based evaluator (play N rounds with each candidate action, keep the best) gets you a competent opponent without a full game-tree search — and step 0 already built its inner loop.

### Key files (once implementation starts)

```
packages/engine/     # pure rules — zero dependencies, most of the tests
  types.ts  state.ts  actions.ts  reduce.ts  legal.ts  rng.ts
  phases.ts          # flip / checkFame / postFameHooks / market / cleanup / finalFlip / tiebreak
  grid.ts            # 3x2 + extra row, stacks, adjacency, isFull
  score.ts           # scoreGrid — pure fn of a finished grid, itemized
  market.ts          # rank sort, positional pricing, refill-then-re-sort
  setup.ts           # Setup config -> initial GameState; the only season-aware module
  cards/             # the card table — data, not logic; one file per season
    season1.ts  season2.ts  index.ts
  effects.ts         # PlaceEffect / FameRule / PostFameHook vocabularies
apps/web/            # React + Vite client
  RoundView.tsx  Grid.tsx  Slot.tsx  Card.tsx  ResolveLog.tsx
  ChoicePrompt.tsx  FameBreakdown.tsx  Market.tsx  useGame.ts
apps/server/         # Node + ws, imports packages/engine unchanged
  rooms.ts  protocol.ts  index.ts
```

`Card.tsx` is used on the grid, in the market, and in the deck list — build it once and parameterize it.

Sharing one TS package between a Vite build and a Node process is a classic half-hour stall. Settle it up front: **the engine stays plain TypeScript source**, Vite compiles it into the client bundle, and the server runs it through `tsx` in dev and a `tsc` build in production. No separate package build step, no dual ESM/CJS output.

---

## 9. Deployment

```
Caddy  ──  serves ./dist static files, terminates TLS
       └─  proxies /ws  ->  Node process on 127.0.0.1:8080
Node   ──  one process, systemd unit, auto-restart
```

Load is negligible. The static bundle should land well under 200 KB gzipped, and a turn is a few hundred bytes of JSON over an already-open WebSocket. A weak box will be bored. Add a web app manifest so single-player installs to a phone home screen and works offline — it needs no server at all, so that's close to free.

---

## 10. Verification

**Step 0 — the flip scorer.** Before any of the below exists: seed → shuffle → flip → itemized breakdown. Assert that a fixed seed produces a fixed grid and a fixed total, and that hand-constructed grids score hand-computed totals.

Be honest about what step 0 can and can't verify: it covers **Bee, Snail, and Dragonfly** completely. The **Skunk needs a cross-player fame comparison** that doesn't exist with one deck, and the **Caterpillar's `dismissCost: 3` needs a Market phase** — both are step-2 tests, so don't declare the starting deck verified at step 0.

Useful regression check: because the starting deck holds **two identical Caterpillars**, a grid with a Dragonfly adjacent to both is a good test case for question 4c (now settled — see §7 4c) — the two Caterpillars should count once, not twice, toward the Dragonfly's bonus.

This is also the harness every later card is verified through.

**Engine** (`vitest run`) — scripted full games with asserted outcomes, plus a test per card. Specifically assert:

- The flip continues **until all six base slots are occupied**, not for a fixed count of cards.
- A stacking card causes **more than six cards** to be flipped, and both face-up cards in the stack are active for scoring and adjacency.
- The Monkey **vacates its base slot**, does not count toward the six, and triggers one additional flip. *(Assert once question 4a is confirmed — this is currently an inference, not a quoted rule.)*
- A card that stops reveals leaves the grid **partially empty**, and scoring handles empty slots.
- A deck of fewer than six cards flips a **partial grid** without error.
- `scoreGrid` is a **pure function**: the same grid scores identically regardless of the order cards were placed in. This is the direct test of correction #1 and the one most worth having.
- Dragonfly scores from **distinct adjacent names**, counts face-up stack members, and does **not** count diagonals.
- Caterpillar dismisses for 3; every other card for 5.
- The Skunk fires only for the **strictly** lowest scorer, does **not** fire on a tie, costs no Market action, and its dismiss costs 0 fame. The same tests, parameterized, must pass for the Ladybug — if they need a second code path, the hook is wrong.
- Least-fame hooks read a **fame snapshot taken at Check Fame**, so one player's free dismissal cannot change who counts as lowest for the next hook in the same round.
- Market: hire cost comes from the **slot position** (`[3,4,7,10,15]` at 1–4 players), and refill happens **before** re-sort.
- The **2-player/solo decay runs once, at the end of the Market phase after the last player's refill** — not per player, and not at Cleanup. Assert exactly two cards leave the market per round, and that the two replacements are rank-sorted into place rather than appended at the ends.
- **A refill that fails during the decay step triggers the endgame** just as a Cleanup-time failure does — same `refillMarket()` path.
- **A newly drawn card ties with an incumbent on rank and lands in the right-hand slot**, leaving the incumbent's price unchanged or lower — never higher. Test with a tied pair straddling a price boundary (3/4 or 10/15); this is the case that would otherwise make the replay property test flake intermittently.
- **Market width follows `prices.length`, keyed off player count only.** Run a full game at 7 slots with 6 players, *and* a combined-season game at 3 players asserting it still gets 5 slots — that second one is the case a plausible-looking implementation gets wrong. Grep for a hardcoded `5` in `market.ts` as part of review.
- **Starting-deck assignment**: in a combined game players receive different decks; assignment is drawn from the seeded RNG and replays identically; no season's starting deck is handed out more than `maxCopiesPerStartingDeck` times; an 8-player game exhausts the supply exactly (4 + 4) and does not error.
- **No engine module branches on `season`.** Worth a grep in CI — but scope it to *identifier* usage (`\.season\b`, `season ===`, `SeasonId`), not the string, or it will false-positive on `cards/season1.ts` import paths in `index.ts` and `setup.ts`. `phases.ts`, `score.ts`, `grid.ts`, and `market.ts` should have zero hits.
- Hired cards land in the **deck**; dismissed cards leave the game and never reappear.
- Reaching the fame threshold still allows that round's **full Market phase**, then the Final Flip runs **without** a Market phase. The threshold is **30 at every player count** — assert it is unchanged in an 8-player combined game, and that lowering `fameToTriggerEndgame` in `Setup` actually shortens the game.
- **The Critic's Choice card** goes to the single highest scorer when the fame trigger fires; is **removed from the game** when the leaders tie; adds exactly **+3 during the Final Flip and never during a normal round**; and shows as its own line in the breakdown. Test the threshold at exactly 30 (`>=`, not `>`), and test that a leader on 34 beats a player on 30 to the card.
- **Toon deck depletion triggers the endgame on its own**, with no player anywhere near the fame threshold, and (assumed) awards no Critic's Choice. Test it directly by starting with a deliberately tiny toon deck rather than waiting for a long game to drain one.
- **`scoreGrid` never returns the Critic's Choice bonus** — only `roundFame` does. Assert the same grid scores identically for the holder and a non-holder.
- **Both triggers firing in the same round** produces exactly one Final Flip, not two.
- **Depletion is a loss in solo and a normal ending in multiplayer** — same detection path, different `winCondition` interpretation.
- A Final Flip tie **re-runs** Flip + Check Fame for the tied players only, until resolved.
- Unspent fame is **zeroed at Cleanup**, never carried.
- Property test: replaying `{seed, actions}` reproduces identical state.
- Fuzz run: many random full games, none crash, no round exceeds a sane flip ceiling.

**Single-player** — `npm run dev`, play to the endgame in a desktop browser and in device-emulation touch mode; reload mid-game and confirm resume; confirm unaffordable market slots are disabled rather than erroring; confirm fame visibly drops when you hire and visibly resets at Cleanup.

**Multiplayer** — run the server locally, open 3 browser windows into one room code, play a full game through the Final Flip; kill and restart one client mid-game to confirm reconnect; confirm a player cannot act during another player's Market turn, and cannot take a third action.

**Deploy** — `curl -I` the static bundle for gzip and cache headers; confirm the WebSocket upgrade succeeds through Caddy over TLS; play one real game from a phone on cellular and check card text legibility at that size.

---

## 11. Second card-encoding pass (2026-08-16) — using the now-real Market/hire/dismiss state

By this point the engine had grown well past step 0: a full solo game loop exists (`flip -> checkFame -> postFameHooks -> market -> cleanup`, `packages/engine/phases.ts`), with a shared `Market` (`market.ts`), a `GameState.dismissed: CardId[]` pile, a `GameState.toonDeck: CardId[]`, and a working interactive TUI (`tui.ts`, `bun run solo`). A batch of cards had been left `unencodable`/`fameUnencodable` back when none of that existed — several `unencodableReason` strings still said "no Market phase exists," which was by then false. This pass audited every remaining flagged card, wired the missing plumbing, and closed as many as are genuinely encodable in a **solo** (single-player) engine.

### What's done

- **Dismissed-pile fame queries** (`cat`, `tiger`, `opossum`) — `scoreGrid`'s `externalState` widened to carry `dismissed: CardId[]`, same pattern already used for Dog's `externalState.dogElsewhere`. Cat counts rank-0 (starting) cards in the pile, Tiger counts any, Opossum counts identical pairs.
- **onHire/onDismiss firing** (`butterfly`, `horse`, `peacock`, `raccoon`, `panther`, `crow`) — `Card.onHire`/`Card.onDismiss` previously existed as type fields with no runtime behind them. `phases.ts` gained a generic `applyEffects` firing point, called from `hire()`/`dismiss()` after their existing cost/action bookkeeping. A new `EffectChoices` type carries player choices (which card to dismiss/hire) into `hire()`/`dismiss()` as an optional parameter; effects framed as "you may" no-op when the choice is omitted, mandatory ones (Panther) throw. **Peacock's bonus Market action is applied after `hire()`'s own action-count decrement**, not before — load-bearing so a future non-`+1` bonus amount doesn't accidentally net to zero; covered by a regression test asserting `fameGeneratedThisRound` (the frozen win-condition snapshot) is untouched by the fame gain.
- **postMarket self-triggered hooks** (`donkey`, `alligator`, `groundhog`, `vulture`) — new `Card.postMarketHook` field and a `runPostMarketHooks` loop in `endMarketPhase()`, run before the existing `soloMarketDecay`. Candidates are snapshotted once in reading order, but each is **re-checked as still present/face-up at application time** — an earlier hook's dismissal can remove a later hook's own owner or target (e.g. Vulture removing the Groundhog that would otherwise have self-dismissed), covered by an explicit ordering-interaction test.
- **Adjacency/stack-aware dismiss cost** (`ladybug`, `rat`) — `dismiss()`'s cost computation now goes through `dismissCostFor(grid, pos, index, cardsById)`: an adjacent face-up Ladybug replaces (not deltas) the default cost with 3; a face-up Rat in the same stack subtracts 1; composed, cost floors at 0. Both key off the literal card id, same convention as Dog's market lookup — no new state.
- **toonDeck threading through the Flip loop** (`snake` main line, `mongoose`) — `flipDeck` gained a required `ctx: FlipContext` (`{toonDeck, dismissed}`, mutated the same way `remainingDeck` already is). A Flip-phase toon-deck draw now ORs into `state.toonDeckDepleted` exactly like a Market-phase refill failure does — confirmed this counts toward the depletion endgame trigger.

Net result: test suite grew from 138 to **189 passing tests** (`bun test`), typecheck clean (`bunx tsc --noEmit -p .`), independently re-verified rather than taken on trust.

### What's still open, and why

- **`camel`, `fox`** (`fameUnencodable`) — both need a count/scan across *every other player's* grid (Camel: "no one has more Camels than you"; Fox: hen/rooster in the market or *any* grid). This solo engine has exactly one `Grid`, no player-collection type. Deliberately **not** faking a stand-in multiplayer state just to clear two flags — a fabricated "always true/false" answer would look like a real ruling rather than an architectural gap. Revisit once/if real multiplayer state exists.
- **`axolotl`, `platypus`** (Big Button expansion) — confirmed directly by Nick: the Big Button is a separate physical component from an optional mini-expansion, starts "on," can be flipped off to reset the whole Market, and **is not part of the base game by default**. Left flagged, no new state added — this is DLC, correctly out of scope for the base solo engine, not a gap to close.
- **`pig`** — "place this card in any deck" is multiplayer-targeting text. Solo setup already excludes Pig from the toon deck entirely (its own `faqNote` says so), so it's not reachable in real solo play at all. Considered and declined a "degenerate to your own deck" solo encoding (Nick's call) — that would manufacture a solo reading of "any deck" the rulebook never states, purely to satisfy a card that can't actually appear in a real game.
- **`snake`** — the main dismiss/stack line and its grid-placement fallbacks are fully encoded. The one remaining piece is the FAQ's nested case: if the card Snake stacks from the toon deck happens to be a Peacock/Rabbit/Turkey, that card's own When-Hired ability is supposed to resolve "after the Flip phase is complete" — a deferred-post-Flip onHire trigger this engine has no mechanism for (onHire currently only fires from inside `hire()`, i.e. a real Market purchase). Same underlying gap affects the dismissed card's own onDismiss in Mongoose's FAQ note, though Mongoose's flag was dropped since that's a general limitation, not Mongoose-specific — documented once in a shared code comment rather than repeated per card.

Full implementation plan for this pass (superseded now that it's done, kept for the reasoning trail) is at `/Users/nick/.claude-profiles/personal/plans/lucky-wishing-tiger.md`.

## 12. Solo-scope pass on build-order step 6 (2026-08-16)

By this point §8's build-order steps 1–2 and step 4 were done for a **solo** engine only (§11): `state.ts`'s `GameState` has no per-player fame, turn order, Critic's Choice, or Final Flip — §8's claim that combined-season/5–8 player setup is "just `Setup` values by this point" was true of the config shape but not of the engine underneath it, since `assignStartingDecks(players, seasons, rng)` (§3.0) has nowhere to plug into a single-player state. Building that for real means building multiplayer state first, which is a new subsystem, not a config tweak — deliberately **out of scope for this pass**.

What this pass did instead, staying inside the existing solo engine:

- **Committed the project to git.** `boardgame-testing/` had been sitting untracked inside the `nick-scripts` repo — no commit history behind the 189 passing tests or either plan doc. Baseline commit `eb16988` fixes that; this pass's changes are a separate commit on top of it.
- **`packages/engine/setup.test.ts`** — new file, the first dedicated coverage of §3.7/§4.6's setup arithmetic (previously only card *effects* were tested, never `buildSoloSetup`/`createSoloGameState` themselves): starting-deck composition, toon-deck exclusion, difficulty trim counts (17/20/23), determinism from seed, and the pre-filled-market/`toonDeckDepleted` wiring in `createSoloGameState`.
- **Season 2's solo variant is now reachable**, via `tui.ts`'s new `--season=1|2` flag (default 1, so existing invocations are unaffected). Selecting `--season=2` prints an explicit banner — `buildSeason2SoloStartingDeck` is a pattern-matched inference, not a confirmed rule (§11's own framing) — before the first phase, so playing it is how that inference eventually gets confirmed or corrected, rather than silently presenting a guess as settled.

Net result so far: test suite grew from 189 to **204 passing tests** (`bun test`), typecheck clean (`bunx tsc --noEmit -p .`).

### §10 solo-scope coverage audit (same pass, same day)

Audited §10's ~30 named verification assertions against the actual test suite. Most of §10's list is explicitly multiplayer-only (Critic's Choice, Final Flip, cross-player starting-deck assignment, "both endgame triggers in one round") and correctly N/A given the engine is solo-only right now — not a gap, per the same reasoning as this section's opening paragraph. Of the solo-applicable subset, most was already covered; five real gaps got new tests, all added to existing files rather than new ones except where noted:

- **`scoreGrid` order-independence** (§10: "the one most worth having") — `score.test.ts`: the same six cards placed in reverse order score an identical `FameBreakdown`.
- **`scoreGrid` on a partial grid** (null base slots) — `score.test.ts`: doesn't throw, empty slots contribute nothing to the total.
- **Fame zeroed at Cleanup on a non-terminal round** — `phases.test.ts`: every existing win/loss test ends the game at Cleanup, so the "game continues" branch of that reset had never actually been exercised.
- **Dismissed cards never reappear** — `phases.test.ts`: strengthened from a sum-only conservation check to a per-id monotonic-multiset check across a 30-round game (a swap bug that dismissed one card and un-dismissed another with the same id would have passed the old sum-only test).
- **Fuzz run** — `phases.test.ts`, 25 seeds played to completion with greedy hiring, asserting no throw, a win/loss result, and a 60-round ceiling never hit.
- **No engine module branches on season** — new `packages/engine/architecture.test.ts`, automating the grep §10 said was "worth a grep in CI" (the hardcoded-market-width-`5` grep stayed a manual review step, per §10's own weaker wording for that one). Had to strip `//` comments before matching — `phases.ts`/`score.ts`/`grid.ts`/`market.ts`'s own header comments *describing* the season-agnostic invariant (`"never branches on Card.season"`) otherwise false-positive against the exact pattern that documents compliance.
- **Replay property test — NOT closed, a substitute only.** §10 asks for "replaying `{seed, actions}` reproduces identical state," but §4.7's action log was never built (state.ts says so explicitly) — there is no `{seed, actions}` to replay. `tui.test.ts` instead asserts same seed + same scripted token list, run twice, produces a byte-identical final `GameState`. That's a weaker claim (it depends on the script matching what the game actually offers each round; an arbitrary action log would not) and is labeled as a substitute in its own test name and comment. Recorded here explicitly so this doesn't get read later as §10's item having been verified.
- **Left as genuinely N/A, not gaps:** the least-fame/Skunk fame-snapshot invariant (`score.ts`'s own comment and §10 itself both say it needs cross-player fame that doesn't exist in a one-player game) and market width at non-default player counts (needs multiplayer `Setup`/player-count plumbing that doesn't exist either).

Net result: 204 → **214 passing tests**, typecheck still clean.

Combined-season and 5–8 player setup remain **not done** — they need multiplayer `GameState` (per-player fame, turn order, Critic's Choice, Final Flip) to exist first, per the correction above. Full implementation plan for this pass is at `/Users/nick/.claude-profiles/personal/plans/work-your-way-through-radiant-hellman.md`.
