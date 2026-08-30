# Contributing

This is a hobby project, but PRs and issues are welcome.

## Getting set up

Requires [bun](https://bun.sh) and
[wrangler](https://developers.cloudflare.com/workers/wrangler/). See the
[README](./README.md) for quick-start commands, and [CLAUDE.md](./CLAUDE.md)
for a full architecture writeup, engine invariants, and testing notes — read
that before touching `packages/engine` or the multiplayer layer, it covers a
lot of non-obvious rules-fidelity and Durable Object behavior.

## Before opening a PR

Run the full local check suite:

```sh
make typecheck
make lint
make test
make e2e
```

For any change to `apps/web`, exercise it in a browser (`make web` or
`make play`) — type checking and the test suite verify correctness, not that
the feature actually works end-to-end in the UI.

For any change to `cards.csv` or `packages/engine/cards/`, run `bun test`
afterward — the engine suite pins a lot of card-specific behavior.

## Style

- Keep changes scoped to what the PR is about — no unrelated refactors or
  drive-by cleanup bundled in.
- Match existing patterns in the file you're editing before introducing a
  new one.
- Write commit messages and PR descriptions that explain *why*, not just
  *what* — especially for anything that deviates from the printed rulebook
  (see the "Accepted deviations" called out throughout `CLAUDE.md`).

## Reporting bugs

Open an issue with steps to reproduce. For anything involving multiplayer
(room codes, disconnect/reconnect, turn timeouts), include how many players
were seated and roughly when in the round it happened — that layer is
timing-sensitive and hard to reproduce from a vague description.
