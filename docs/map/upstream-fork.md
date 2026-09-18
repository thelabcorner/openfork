# Upstream OpenCode vs OpenFork

## Product-scope rule

OpenFork follows upstream OpenCode's **local client/runtime infrastructure**, but it
does not carry upstream's hosted product/backend infrastructure on this branch.

This is the central fork rule:

```text
upstream local runtime/client substrate
  -> keep in sync, preserve semantics, improve carefully

upstream hosted SaaS / cloud / console infrastructure
  -> prune from OpenFork main

OpenFork client/runtime features
  -> preserve across upstream tag merges
```

The fork is therefore “client-side-only” in product scope while still containing a
substantial **local server/runtime**. That local server is required to run the client
and is not equivalent to hosted backend infrastructure.

## Upstream concerns deliberately absent

`keep-manifest.json` prunes upstream packages/concerns including:

- `packages/console`;
- `packages/enterprise`;
- `packages/function`;
- `packages/slack`;
- `packages/stats`;
- `packages/storybook`;
- `packages/web`;
- standalone `packages/cli`;
- `packages/sdk-next`;
- `packages/docs`, `packages/identity`, `packages/containers`;
- `infra/`, SST root deployment config, upstream deployment `github/` and
  `sdks/` concerns, and Nix/install artifacts listed by the prune manifest.

These paths are not “missing implementations” to restore during an upstream merge.
Their reappearance on `main` is a sync/prune failure unless the fork architecture is
deliberately changed.

## Local infrastructure intentionally retained

OpenFork retains the packages required for upstream-compatible local behavior:

- app/UI contracts and generated clients;
- Schema/Protocol;
- Core;
- local server helpers;
- OpenCode sidecar/runtime;
- LLM/provider protocol support;
- desktop;
- plugin support;
- persistence/runtime support packages.

`packages/tui` is a special case. It remains because embedded CLI code under
`packages/opencode` still depends on it; the manifest explicitly marks it as a
deferred compatibility leaf. It is not an OpenFork product commitment.

## Fork-only product packages

The current OpenFork workspace also contains client-side packages not present in the
upstream package tree:

- `packages/mobile` — separate mobile PWA;
- `packages/browser-visual` — browser visual/runtime support.

These are OpenFork product additions, not upstream hosted infrastructure.

## Major fork-owned areas

`FORK.md` is the canonical ownership list. Major fork-owned or fork-expanded areas
include:

- desktop tab chrome and project explorer;
- model/usage/quota UX and provider-account behavior;
- built-in hosted-browser/client browser subsystem;
- session groups and subagent grouping;
- pause/resume/regenerate-title behavior;
- SPAD degeneration detection/recovery;
- fork credentials and quota integrations;
- expanded agent toolset;
- checkpointing;
- JetBrains ACP integration;
- conversation control/context overlays;
- throughput instrumentation/projection;
- Goal Mode and Goal Auditor behavior;
- related server routes, schemas, migrations, tests, and GUI surfaces.

Newer active campaigns such as provenance, scheduled tasks, shell reliability, and
first-party swarm/session control may be present in the worktree before they are fully
folded into `FORK.md`; the canonical ownership file should be updated when those
features converge.

## Union seams

Some files are neither “take ours” nor “take upstream”. They are deliberate unions.
Examples called out in `FORK.md` include:

- tool registry: fork tools **plus** new upstream tools;
- agent behavior: upstream fixes plus fork-native policies;
- shell: upstream parser/runtime fixes plus fork safety/hardening;
- plugin/provider hooks: union both sides;
- session prompt loop: upstream fixes plus fork Goal/SPAD/quota/control hooks;
- server API composition: re-register fork groups after upstream changes;
- package manifests: upstream versions plus curated fork workspace/dependency union;
- generated clients: regenerate rather than hand-merge.

This union model is how OpenFork can preserve 1:1 upstream local-infrastructure
fidelity while still being a materially richer client.

## Sync model

OpenFork's documented sync policy is **merge upstream release tags**, not continuously
merge `upstream/dev`.

`script/fork-sync.ts` owns mechanical conflict handling and verification.
`script/fork-prune.ts` enforces the hosted-infrastructure prune manifest.

At the time this map was created, the local `upstream/dev` reference was also checked
to validate the package-level comparison, but it is not the fork's merge policy.

## Fidelity principle

“Fidelity with upstream” means:

1. retain upstream local contracts and bug fixes unless a fork feature intentionally
   changes the behavior;
2. keep shared schemas/protocol/provider behavior compatible;
3. make fork extensions compositional rather than rebuilding upstream infrastructure
   in parallel;
4. backport/converge improvements across V1/current seams instead of letting two
   implementations drift;
5. do not import upstream hosted/SaaS architecture merely because it exists upstream;
6. where OpenFork improves correctness, durability, performance, or architecture,
   preserve the stronger behavior through future tag merges.
