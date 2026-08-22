# OpenFork

OpenFork is a branch-fork of [OpenCode](https://github.com/anomalyco/opencode) Desktop: the desktop app plus its sidecar, kept mergeable against upstream release tags. It is not an independent product and it is not OpenChamber.

- Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode) — remote `upstream`
- This repo: [thelabcorner/openfork](https://github.com/thelabcorner/openfork) — remote `origin`, default branch `main`
- Sync doctrine: merge upstream **release tags** (`v1.18.x`), never a floating `upstream/dev`
- Fork ownership map, KEEP/DROP paths, and conflict rules: [`FORK.md`](FORK.md)
- Agent rules and skill routing: [`AGENTS.md`](AGENTS.md)

## Run the desktop app from source

```bash
bun install
bun run --cwd packages/desktop dev
```

This launches Electron against the current source with renderer hot-reload and a live main-process log stream. A packaged build reflects whatever commit it was built from — verify against source, not the installed `.exe`.

## What is kept vs dropped

This tree is desktop + sidecar only. Console, stats, web, enterprise, slack, infra, and the TUI are pruned from `main` after every upstream tag merge (`bun run fork:prune`). The full KEEP/DROP map, conflict classes, and the per-merge semantic checklist live in [`FORK.md`](FORK.md).

## License

MIT — see [LICENSE](LICENSE). Copyright 2025 opencode. OpenFork keeps upstream's license and attribution; the quota module is a port of OpenChamber (MIT).
