# T02 - Hosted mutable-state boundary inventory and static guard

**Lane:** audit / static enforcement  
**After:** nothing  
**Unlocks:** T03, T04, T08  
**Primary repo:** OpenFork  
**Architecture refs:** sections 5, 7, 24, WP-A, D2-D8, D11-D14

## Objective

Produce a complete, reviewable classification of OpenFork state that can live
longer than one request and therefore might cross tenant boundaries in a shared
process. Add a lightweight guard so newly introduced process-lifetime mutable
state in hosted-sensitive packages cannot appear without an explicit ownership
classification.

This is a security inventory, not a mechanical grep dump.

## Inputs to audit

At minimum scan and classify:

- `makeGlobalNode` services;
- untagged `LayerNode.make` services with app/process lifetime;
- module-scope mutable `Map`, `Set`, arrays, objects, `let` state;
- `Global.Path` consumers;
- `process.env` reads and writes;
- timers/background fibers created at module/service lifetime;
- persistent socket/HTTP/WebSocket pools;
- credential/account pools;
- callback servers and OAuth pending-flow registries;
- filesystem lock registries and path-derived caches;
- replay/event registries;
- browser/device/host registries;
- usage/quota caches;
- provider SDK/client caches;
- background jobs, shell jobs, MCP/LSP registries;
- any raw secret used as a map/cache key.

Known examples that must appear in the inventory:

- core `Database.node`;
- core `EventV2.node`;
- core `Credential.node`;
- `Auth` file/env behavior;
- shared Effect `memoMap`;
- `Global.Path`;
- Zen/Go account pools;
- MCP OAuth callback maps/server;
- OpenRouter free-usage trackers;
- browser host broker;
- provider websocket pools;
- Genspark catalog credential-keyed cache;
- workspace adapter registry.

## Owned surfaces

Prefer new audit artifacts and lint/static-check code:

- `docs/plans/multitenant-serve/audit/state-boundaries.*`
- `packages/opencode/script/` or `packages/core/script/` for the guard
- narrowly scoped tests/fixtures for the guard

Do not tenantize production services in this task. Classification only.

## Classification schema

Every finding must record:

```text
id
path
symbol/line or stable locator
kind
current lifetime: request | location | app | module/process | disk
contains tenant data? yes/no/conditional
contains secret? yes/no/conditional
hosted target scope: global | tenant | location | session | disabled | operator-only
cleanup/eviction today
cache key / identity
risk class
required downstream task
notes/evidence
```

Recommended risk classes:

- `P0-cross-tenant-secret`
- `P0-cross-tenant-data`
- `P1-authority-confusion`
- `P1-unbounded-resource`
- `P1-filesystem-ambient`
- `P2-safe-global-candidate`
- `P2-hosted-disabled`
- `P3-local/ephemeral`

## Static guard design

The guard should not ban every `new Map()`; most are local temporaries.

It should focus on high-risk patterns in hosted-sensitive directories, for
example:

- top-level mutable containers;
- top-level `let` assigned after initialization;
- top-level timers/servers;
- `process.env.X = ...` writes;
- new `makeGlobalNode` definitions;
- known raw-secret cache-key patterns.

Use an allowlist with a required ownership annotation/reason rather than a
blanket regex exemption.

Possible workflow:

```text
bun run script/hosted-state-audit.ts --check
```

where checked-in inventory/allowlist is the baseline. New findings fail CI
until classified.

## Required reasoning

For each process-global candidate, explicitly answer:

1. Can two tenants observe or influence the same instance?
2. Does its cache key include enough trusted identity?
3. Does it retain secrets or user-controlled data?
4. Is cleanup bounded?
5. Does a callback/fiber preserve tenant context?
6. Could a guessed session/project ID cross the boundary?
7. Is it safe global immutable state, or merely convenient global mutable
   state?

## Validation

- guard unit tests for positive and negative fixtures;
- guard runs clean on the current checked-in baseline;
- intentionally add a forbidden top-level map/env write in a fixture and prove
  the guard fails;
- inventory rows resolve to existing symbols/paths;
- no raw provider secrets are stored in the inventory artifact itself.

## Exit criteria

PASS only when:

- every known architecture finding is represented;
- all `makeGlobalNode`, `Global.Path`, `process.env` writes, and module-level
  mutable registries in hosted-sensitive packages have an ownership answer;
- P0/P1 findings point to downstream task IDs;
- a machine-enforced guard detects new unclassified high-risk state;
- T03/T04 have enough information to construct the first safe tenant runtime.

## Handoff

`../results/T02.md` must include:

- inventory artifact path and row count by risk class;
- guard command;
- P0/P1 summary;
- exact findings that block hosted v1;
- candidate safe-global services T04 may deliberately hoist;
- any state whose ownership remains unresolved and therefore must default to
  tenant/location or hosted-disabled.

