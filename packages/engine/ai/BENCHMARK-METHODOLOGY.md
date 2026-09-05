# Match AI benchmarking: methodology notes and a real bug to not repeat

## The bug: a "100% win rate" that was fake

The first bot-vs-bot A/B benchmark written for this codebase reported the new match heuristic winning **80/80 games (100%)** against the pre-heuristic baseline. That number was wrong, and the way it was wrong is worth recording precisely, because it's an easy mistake to make again.

**What the harness did:** to drive a full match, it called `matchAdapter.ts`'s `advanceToBotDecision(match, seatA)` on the REAL match state to "fast-forward toward seat A's turn." That function's whole job is to resolve every decision that ISN'T seat A's own using a cheap stand-in policy (`opponentActionFor`) — which is exactly correct when used INSIDE a rollout, to model a hypothetical opponent during search. But called on the real match between real turns, it silently resolved seat B's actual decisions with the cheap stand-in too — meaning seat B's real moves were never decided by seat B's own search at all. The "baseline" bot was never actually playing; the "candidate" bot was just playing against a nerfed stand-in wearing seat B's name.

**The fix:** the outer loop that drives a REAL match must determine whose decision it is by asking `adapter.legalCandidates(match)` for the ACTUAL seat's OWN adapter — never by fast-forwarding the whole match through one seat's adapter. Every bench in this directory now follows this shape:

```ts
if (adapterA.legalCandidates(match).length > 0) {
  match = applyMatchAction(match, seatA, chooseBestAction(adapterA, match, opts)).match
} else if (adapterB.legalCandidates(match).length > 0) {
  match = applyMatchAction(match, seatB, chooseBestAction(adapterB, match, opts)).match
} else if (match.shared.phase === 'flip' || match.shared.phase === 'finalFlip') {
  match = applyMatchAction(match, seatA, { kind: 'advanceFlip' }).match // neutral, legal from any seat
} else {
  throw new Error(...) // a phase-machine bug, not a state to silently loop on
}
```

The opponent-modeling stand-in (`opponentActionFor`, or a bench's own hand-rolled variant) belongs ONLY inside `adapter.apply` — i.e. only reached from deep inside `chooseBestAction`'s own rollouts, never from the loop that advances the real game between real decisions.

**How this was caught:** the fixed loop, re-run on the same change, dropped season 1 from a fake 100% to a real (and initially concerning) 25% loss — which led to actually finding and fixing the real problem (see `TUNING-DEAD-ENDS.md`'s first entry). If a bot-vs-bot result looks suspiciously perfect (100%, or near it, at a fixed sim budget on both sides), that is a reason to re-check the harness before trusting the win.

## Multi-season is not optional

Every dead end in `TUNING-DEAD-ENDS.md` shows season 1 and season 2 responding to the same change in _opposite_ directions at least once. A single-season result — especially a good-looking one — is not evidence of a real improvement until the other season has been checked too. `bench-ab-pool.ts` accepts a comma-separated season list and runs them through one shared worker pool specifically so "check both seasons" costs nothing extra to type (`1,2` vs `1`) and doesn't oversubscribe the machine the way launching two separate single-season processes would.

## Small samples invite false positives

`TUNING-DEAD-ENDS.md`'s candidate-cap=5 entry: a promising 62.5% at n=24, one season, that fell apart to 55.0%/42.5% at n=40, both seasons. Treat anything measured at fewer than ~40 seeds per season, or on one season only, as a _lead worth checking at full scale_ — never as a result to wire into `matchAdapter.ts` directly. The one exception in this codebase's own history is deliberate: bracketing `RELATIVE_LEAD_WEIGHT` used quick n=24 single-season checks specifically because they were compared against an ALREADY-full-scale-validated baseline (the shipped 0.2), not used to validate a brand-new change from scratch.

## Isolate one variable per bench

Each bench in this directory changes exactly one thing between seat A and seat B, holding everything else (including the OTHER shipped improvements) constant:

- `bench-match.ts` — `heuristicScore` present vs. stripped
- `bench-opponent-policy.ts` — bounded-greedy vs. passive opponent modeling
- `bench-rollout-tuning.ts` — rollout temperature/candidate-cap knobs
- `bench-relative-heuristic.ts` — the relative-standing heuristic term
- `bench-nplayer.ts` — this session's full shipped state vs. the pre-session baseline, at 3-4 seats instead of 2

When a bench needs a variant that doesn't exist in shipped code yet (e.g. a candidate heuristic not wired into `matchAdapter.ts`), build it INSIDE the bench worker by spreading the real `buildMatchAdapter(seat)` and overriding just the one field under test (`heuristicScore`, or `apply` for an opponent-policy variant) — see `bench-relative-heuristic-worker.ts` and `bench-opponent-policy-worker.ts` for the pattern. This keeps production code untouched until a change is actually validated.
