# 01 — Strategy: Branch-Fork, Not OpenChamber

> **STATUS: COMPLETE** — this is the load-bearing document. If a later file conflicts with this one, this one wins.

## 1. Two products people keep conflating

### OpenChamber (`github.com/openchamber/openchamber`)

An **independent product**. Packages: `ui`, `web`, `electron`, `vscode`, `mobile`, `docs`. It talks to official OpenCode through `@opencode-ai/sdk/v2` and a bundled/installed CLI. Their `../../handoff/AGENTS.md` literally says: do not modify `../opencode`; it is a separate repository.

Upgrade path: bump the OpenCode CLI / SDK version. Git never merges `anomalyco/opencode`. Conflict cost is zero because there is no shared tree. Feature cost is total: they rewrote the UI, the shell, and a lot of the control plane.

### This tree (`openfork`)

A **patched OpenCode**. Features live in the same files upstream owns:

- project explorer, tab chrome, models/usage panels → `../../../packages/app`
- pause/resume, session groups, SPAD, quota, extra tools → `../../../packages/opencode` + `../../../packages/core`
- hosted browser → `../../../packages/desktop` + `../../../packages/app` + protocol/server
- search matcher → `../../../packages/core/src/search`

Upgrade path: `git merge v1.18.x`. That only works if the trees stay related.

You said you want to stay "relatively in-line" and "not an independent fork but a branch-fork." That sentence forbids the OpenChamber architecture even though their *slimness* is what you like.

## 2. The real problem you are solving

Not "how do I have a desktop app." You already have one.

The problem is **maintenance surface**:

- SST, Stripe, PlanetScale, Cloudflare, Honeycomb (`sst.config.ts`, `infra/`)
- SaaS console (~48 MB, mostly landing videos)
- stats lake, enterprise app, Slack bot, marketing site, VS Code extension, GitHub Action
- anomalyco CI that will fail on a personal repo
- an updater that points at *their* GitHub releases

You do not want to own that. You do want to keep merging their desktop/server/app changes.

## 3. Strategies that fail the brief

| Strategy | Why it fails |
|---|---|
| `git filter-repo` / orphan branch / copy only `../../../packages/desktop` | Destroys merge-base. Next tag merge is a 100k-line foreign tree. You become OpenChamber without meaning to. |
| Delete `packages/console` etc. from `main` | Next `git merge v1.18.22` re-adds every file. You spend every sync deleting the same tree and resolving delete/modify conflicts. |
| Consume published `opencode` npm + keep only `../../../packages/app` | You cannot patch `../../../packages/opencode` (quota, SPAD, tools, pause API) or `../../../packages/core` (search). Those *are* the fork. |
| GitHub Fork button + keep everything | Solves hosting, solves none of the clutter. Also invites accidental PRs to anomalyco. |
| Rewrite UI like OpenChamber | Throws away the product you already built. |

## 4. Strategy that survives both constraints

**Keep the git history. Delete unused trees from `main`. Re-prune after every merge.**

```
upstream  = anomalyco/opencode   (tags + dev)
origin    = thelabcorner/openfork
main      = desktop + sidecar only (full history still behind it)

On disk / on GitHub
  = KEEP packages only
  + script/fork-prune.ts as the last step of every tag merge
```

What leaves `main` (not history):

- `packages/console`, `stats`, `enterprise`, `function`, `slack`, `web`, `storybook`, `cli`, `sdk-next`
- `infra/`, `sst.config.ts`, `github/`, `sdks/`, Mintlify `packages/docs`, `packages/identity`, `packages/containers`
- anomalyco publish/deploy workflows, 20-locale official READMEs

What stays (not scorched earth):

- History (no `filter-repo`) — this is how the next `git merge v1.18.22` still has a merge-base
- Everything the Electron app + Node sidecar actually import (see `02-keep-drop.md`)
- `../../../packages/tui` until three util re-exports are inlined
- `../../../packages/client` + codegen (regen after protocol merges)
- `../../../patches`, catalog, lockfile

What you keep doing:

- merging `v1.18.x` into `main`
- resolving KEEP-path unions by hand
- resolving DROP-path "deleted by us, modified by them" as **delete**
- running `bun run fork:prune` so re-added SaaS trees do not land
- regenerating client/SDK when HttpApi moves
- running desktop from `../../../packages/desktop` (`bun run dev`)

Clone size barely shrinks (blobs stay in history). GitHub *tree* and `bun install` become desktop-only. That is the intended trade. See `04-slim.md`.

## 5. Mental model for agents

```
┌─────────────────────────────────────────────────────────────┐
│  anomalyco/opencode                                         │
│  source of: providers, session core, protocol, TUI, SaaS    │
└───────────────────────────┬─────────────────────────────────┘
                            │  git merge tag vX.Y.Z
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  thelabcorner/openfork  (this product)                      │
│  owns: desktop UX, extra tools, quota, search, browser,     │
│        session groups, SPAD, fork credentials               │
│  tree: desktop + sidecar only; SaaS/TUI pruned after merge  │
│  ignores: console, stats, enterprise, slack, web, infra,    │
│           TUI (not a product surface)                       │
└─────────────────────────────────────────────────────────────┘
```

You are not "the OpenCode project minus some folders." You are a **downstream desktop line** that regularly fast-forwards the shared trunk and then re-applies a known ownership map.

## 6. What "in-line with upstream" actually means

It does **not** mean:

- same default branch name (`dev`)
- same package set installed
- same updater
- same branding
- taking every upstream test that assumes UI you removed (the `#review-panel` e2e is the example)

It **does** mean:

- shared history, so `git merge vX.Y.Z` is a 3-way merge
- upstream version numbers in `../../../package.json` (already the v1.18.21 practice)
- additive V1 HTTP routes for fork features (`/quota`, `/fork`, session-group) rather than forking the protocol
- taking upstream provider/security/session-loop fixes unless they physically delete a fork feature
- regenerating SDKs instead of hand-merging generated files

## 7. Implication for AGENTS.md

Root `../../handoff/AGENTS.md` today is upstream's file plus two fork paragraphs. After isolation it must say, in this order:

1. This repo is OpenFork, a branch-fork of OpenCode Desktop.
2. Do not maintain SaaS/infra.
3. Load `upstream-sync` before any merge/cherry-pick.
4. Then the existing style, test, typecheck, and V1-API rules.

Skills own workflows. `../../handoff/AGENTS.md` owns always-on constraints. That is the OpenChamber lesson that *does* transfer.
