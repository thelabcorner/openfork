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

## V1/current lifecycle is an intentional fork divergence

Upstream's architectural direction is replacement-oriented: current/V2 is the
successor architecture and V1 is progressively migrated away from. OpenFork does
**not** treat that lifecycle policy as part of the compatibility contract.

For OpenFork:

- V1 remains an active, mature production runtime that should be repaired rather
  than allowed to decay;
- current/V2 is a high-value source of corrected semantics, cleaner ownership,
  and new capabilities;
- suitable current/V2 improvements should be moved to the lowest shared owner and
  backported into V1 rather than forcing a caller migration merely for version
  convergence;
- upstream changes that delete or bypass V1 require deliberate fork review when
  OpenFork still depends on that path;
- deleting V1 in OpenFork requires an explicit architecture decision backed by
  proven parity and a product reason. It is not implied by upstream deprecation.

This distinction is compatible with the fidelity goal. OpenFork aims for fidelity
to upstream **local behavior, protocols, providers, and infrastructure contracts**,
not necessarily to upstream's internal runtime-generation retirement schedule.

The same principle applies to upstream's **current local client API**. OpenFork
does not need to finish the upstream migration from V1 local APIs onto
`packages/protocol` / `packages/client` / current `/api/*` merely to stay
architecturally “current.” Those surfaces may remain where the existing hybrid tree
uses them, but they are not a fork compatibility target. The fork's target is V1
local behavior plus selectively backported current/V2 improvements.

Do not confuse that with the OpenCode-hosted Zen/Go provider gateway. Hosted model
API compatibility is independent of the local V1/current client split and remains
required for whichever hosted provider interface OpenCode actually operates.

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
2. keep shared schemas/provider behavior compatible where OpenFork consumes it;
   current local Protocol/client parity is not independently required;
3. make fork extensions compositional rather than rebuilding upstream infrastructure
   in parallel;
4. treat current/V2 improvements as candidates for shared implementation and V1
   backport instead of forcing V1 retirement or letting generations drift;
5. do not import upstream hosted/SaaS architecture merely because it exists upstream;
6. where OpenFork improves correctness, durability, performance, or architecture,
   preserve the stronger behavior through future tag merges.
