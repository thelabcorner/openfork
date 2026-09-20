# Upstream OpenCode vs OpenFork

## Product-scope rule

OpenFork is an **independent product surface** implemented as a source-level branch
fork of OpenCode. It does not promise local client/runtime/plugin compatibility with
OpenCode, and it does not carry upstream's hosted backend implementation on this
branch.

This is the central fork rule:

```text
upstream local runtime/client substrate
  -> source donor/reference; take, adapt, backport, or reject

OpenFork local runtime/client/plugin/API surface
  -> fork-owned independent product; no implicit OpenCode compatibility

upstream-operated remote OpenCode services consumed by OpenFork
  -> strict external compatibility; OpenFork must adapt to their contracts

upstream hosted backend implementation source
  -> prune from OpenFork main
```

The fork therefore owns a substantial **local server/runtime** while depending on
selected remote services that OpenCode operates. Not carrying their backend source
does not remove the need to remain wire-compatible with the deployed endpoints
OpenFork uses.

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

## Local source ancestry intentionally retained

OpenFork retains substantial upstream-derived packages because they are useful source
and remain part of the fork's implementation:

- app/UI contracts and generated clients;
- Schema/Protocol;
- Core;
- local server helpers;
- OpenCode sidecar/runtime;
- LLM/provider protocol support;
- desktop;
- plugin infrastructure;
- persistence/runtime support packages.

Retention does **not** imply drop-in OpenCode compatibility. These packages are
OpenFork code once they are in this branch and may diverge.

`packages/tui` is a special case. It remains because embedded CLI code under
`packages/opencode` still depends on it; the manifest explicitly marks it as a
deferred coupled leaf. It is not an OpenFork product commitment or compatibility
promise.

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

This distinction is independent of remote compatibility. OpenFork does not target
fidelity with upstream local behavior. It targets the best OpenFork V1 architecture
while borrowing useful current/V2 semantics.

The same principle applies to upstream's **current local client API**. OpenFork
does not need to finish the upstream migration from V1 local APIs onto
`packages/protocol` / `packages/client` / current `/api/*` merely to stay
architecturally “current.” Those surfaces may remain where the existing hybrid tree
uses them, but they are not a fork compatibility target. The fork's target is V1
local behavior plus selectively backported current/V2 improvements.

Do not confuse that with the OpenCode-hosted Zen/Go provider gateway or other
upstream-operated remote services OpenFork actually calls. Those external contracts
are the compatibility-critical boundary because OpenFork cannot change the server
implementation.

## OpenFork is not an OpenCode-compatible distribution

OpenFork and OpenCode are separate product surfaces.

- OpenCode plugins may not work in OpenFork.
- OpenCode local API clients may not work in OpenFork.
- OpenCode extensions, scripts, configuration assumptions, and UI integrations may
  not work in OpenFork.
- OpenFork-specific integrations may not work in OpenCode.

Shared package names, source ancestry, or successful operation today do not create a
support promise. A local compatibility guarantee exists only when OpenFork explicitly
names, tests, and documents that exact integration.

This differs from an OpenChamber-style wrapper/distribution, where preserving the
underlying OpenCode runtime surface is part of the architecture. OpenFork changes
the underlying runtime and contracts themselves.

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
- first-party OXP / ChatGPT external-agent integration, including the dedicated
  Secure-MCP endpoint, supervision/delegation surfaces, and parent-tool-epoch
  durable-continuation contract;
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

This union model is a **source-sync strategy**, not a compatibility strategy. It
lets OpenFork harvest useful upstream work without surrendering ownership of its
local architecture.

## Sync model

OpenFork's documented sync policy is **merge upstream release tags**, not continuously
merge `upstream/dev`.

`script/fork-sync.ts` owns mechanical conflict handling and verification.
`script/fork-prune.ts` enforces the hosted-infrastructure prune manifest.

At the time this map was created, the local `upstream/dev` reference was also checked
to validate the package-level comparison, but it is not the fork's merge policy.

## Fidelity principle

“Fidelity with upstream” is reserved for **remote upstream-operated contracts that
OpenFork consumes**:

1. preserve the request/response/auth/streaming/error semantics required by those
   deployed services;
2. track upstream changes to those remote contracts and adapt OpenFork promptly;
3. isolate remote-service compatibility in provider/backend adapters rather than
   forcing upstream local architecture into the fork;
4. do not treat upstream local APIs, plugin APIs, CLI behavior, UI behavior, or
   current/V2 migration as compatibility requirements;
5. treat upstream source as a donor for fixes/features and current/V2 as a donor for
   semantics to backport into V1;
6. preserve stronger OpenFork local behavior through future tag merges.
