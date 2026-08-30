# FlipToons (digital adaptation)

An unofficial, fan-made digital implementation of the FlipToons board game
by Thunderworks Games. Not affiliated with or endorsed by Thunderworks
Games — see [LICENSE](./LICENSE).

Playable end-to-end: solo (local, in-browser) and real 2-4 player
multiplayer with room codes, seats, turn order, and a Final Flip. Live at
[fliptoons.win](https://fliptoons.win).

## Quick start

Requires [bun](https://bun.sh) (runtime, package manager, test runner) and
[wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare's
CLI, for the multiplayer server).

```sh
make play   # web client + Worker together (room-code hosted games)
make web    # web client only, local solo play, no server
```

Run `make help` for the full list of targets (tests, typecheck, lint, e2e).

## Layout

- `packages/engine/` — pure TypeScript rules engine, zero runtime deps
- `apps/worker/` — Cloudflare Worker + Durable Object, hosts multiplayer rooms
- `apps/web/` — React + Vite client
- `e2e/` — Playwright browser tests

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture writeup, engine
invariants, and testing notes.

## License

The code in this repository is MIT licensed — see [LICENSE](./LICENSE).
The FlipToons name, rules, and card content belong to Thunderworks Games;
this project does not claim any rights to them.
