# Contributing

Thanks for taking an interest in this project! It's a side project maintained by one person, so a few ground rules keep things manageable.

## Pull requests

Pull requests are welcome. Before opening one:

- Check [`CLAUDE.md`](CLAUDE.md) for the architecture, source layout, build commands, and test instructions.
- Keep the build clean: `make typecheck` and `make lint` should both pass.
- Run `make test` (engine + Durable Object suites) and `make e2e` (Playwright) before submitting.
- For any change to `apps/web`, exercise it in a browser (`make web` or `make play`) — type checking and the test suite verify correctness, not that the feature actually works end-to-end in the UI.
- For any change to `cards.csv` or `packages/engine/cards/`, run `bun test` afterward — the engine suite pins a lot of card-specific behavior.

## AI-assisted code is welcome — with a human attached

Using Claude, Copilot, or any other LLM-based coding tool to help write a PR is completely fine. What's required is that **a human has actually read, understood, and tested the change** before submitting it. Don't paste in unreviewed AI output and open a PR — review it like you'd review your own code, because you're vouching for it.

## Feature requests

Feature requests are welcome via Issues. Since this is a one-person side project, prioritization is at the maintainer's discretion — there's no SLA and no guarantee a given request gets picked up, but they're genuinely read and appreciated.

## Bug reports

Please include repro steps. For anything involving multiplayer (room codes, disconnect/reconnect, turn timeouts), include how many players were seated and roughly when in the round it happened — that layer is timing-sensitive and hard to reproduce from a vague description.

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). Be civil.
