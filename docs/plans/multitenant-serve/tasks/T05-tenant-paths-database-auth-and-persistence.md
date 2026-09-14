# T05 - Tenant paths, database, auth roots and persistence

**Lane:** persistence / ambient-state removal  
**After:** T04  
**Unlocks:** T06, T07, T09  
**Primary repo:** OpenFork  
**Architecture refs:** sections 5.4-5.7, 9, 12, 16, 24, D4-D7

## Objective

Move hosted tenant persistence away from process-global `Global.Path` and the
process-global database/auth roots. Each hosted TenantRef gets canonical,
server-derived paths and one SQLite database, with no fallback to the normal
standalone `auth.json` or XDG roots.

This task establishes the durable tenant state boundary. Event/replay behavior
is finished in T06; hosted credential delivery is finished in T09.

## Required target shape

Conceptually:

```text
TenantRealm
  TenantPaths
    data
    state
    config (hosted-controlled subset)
    tmp
    workspaces root
  Database (one SQLite DB for this tenant)
  tenant-scoped DB-backed services
```

Standalone mode retains existing XDG/Global.Path behavior.

## Owned surfaces

Primary candidates:

- `packages/core/src/global.ts` only for splitting safe process-global paths
  from tenant paths; avoid breaking standalone exports unnecessarily
- new `packages/core/src/tenant/paths.ts` or equivalent
- `packages/core/src/database/database.ts`
- DB-backed core services that must change tag/ownership to compile safely
- `packages/core/src/credential.ts`
- `packages/core/src/session/**` DB-owned services as required by tag cascade
- `packages/core/src/project/**` DB-owned services as required
- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/fork/credentials.ts`
- config/path resolution modules that currently use `Global.Path` for tenant
  state
- focused migration/persistence tests

Do not do broad provider certification or event transport here.

## Design requirements

### 1. Tenant path service

Create one trusted service/object from TenantRef + operator hosted root.

Properties:

- caller cannot supply arbitrary absolute tenant roots;
- path components are opaque/sanitized;
- canonical root is stable across OpenFork restart;
- permissions are compatible with T08 tenant UID/GID ownership;
- no PII appears in paths if TenantRef is opaque;
- hosted tmp/cache paths cannot collide across tenants;
- standalone `Global.Path` remains unchanged.

### 2. One SQLite DB per tenant

Reuse `Database.layerFromPath()` semantics where safe, but construct filename
from TenantPaths.

Preserve:

- WAL;
- migrations;
- ChunkDB feature behavior;
- read-only secondary connection;
- checkpoint lifecycle;
- scoped finalization.

Database file and runtime locks must live inside tenant-owned storage or a
safe cell lock root keyed by tenant. No hosted tenant DB path comes from ambient
`Flag.OPENCODE_DB` unless hosted operator policy explicitly supports a safe
template.

### 3. Mechanical tag cascade is expected

Once Database becomes tenant-owned, current global nodes that depend on it
cannot remain `global` under T04's type lattice.

For each compile failure:

- determine whether service state is truly tenant-owned -> move to tenant;
- split immutable/global metadata from tenant persistence if justified;
- disable hosted functionality if ownership cannot yet be made safe;
- never bypass the scope type checker with casts.

Record the cascade in the task result.

### 4. Auth semantics

Hosted mode must not read/write:

- process-global `Global.Path.data/auth.json`;
- `OPENCODE_AUTH_CONTENT` as tenant auth;
- provider secret environment fallbacks.

At this stage, hosted auth may be an explicit empty/no-credential implementation
that T09 replaces with the hosted credential resolver. Missing hosted auth must
fail closed, not fall back to standalone.

Standalone Auth continues to use existing behavior.

### 5. Credential DB

Core DB-backed `Credential` naturally follows tenant Database ownership. Its
queries no longer need `tenant_id` because the DB itself is the tenant silo.

Do not confuse this DB credential model with the PresGen-hosted runtime secret
bundle T09 will provide. Define the boundary explicitly.

### 6. Migration and restart behavior

Prove:

- first open creates/migrates only that tenant DB;
- A migration failure cannot corrupt/open B's DB;
- realm close checkpoints/closes handles;
- realm reopen restores tenant state;
- standalone DB migration path still works.

## `Global.Path` audit during this task

Use T02 inventory to classify every `Global.Path` consumer required by tenant
services touched here.

Do not replace all process-global paths blindly. Typical outcomes:

- binary/model artifact cache -> safe global;
- tenant session DB -> tenant;
- model preferences/account state -> tenant or hosted-disabled;
- logs -> global with tenantRef structured field, no secrets;
- snapshots/worktrees -> tenant/location;
- package install target -> global operator-controlled or hosted-disabled.

## Required tests

### A/B persistence

- A and B DB filenames differ.
- Identical session IDs inserted in A/B remain isolated.
- A credential record cannot be queried in B.
- A delete/migration/checkpoint does not affect B.
- closing/reopening A preserves A and leaves B continuously available.

### Path authority

- malicious TenantRef/path-like text cannot escape hosted root;
- `..`, slash/backslash, Unicode separator edge cases are handled;
- symlink escape at the tenant-root layer is rejected or made impossible by
  creation/ownership policy;
- hosted caller cannot select `OPENCODE_DB` arbitrary path.

### Auth no-fallback

- hosted auth lookup with no scoped credential returns explicit missing-auth;
- setting `OPENCODE_AUTH_CONTENT` does not populate hosted tenant auth;
- standalone lookup still honors existing behavior.

### Existing suite

- database migration tests;
- session/project DB tests affected by tag changes;
- credential tests;
- standalone server smoke.

## Performance guard

Measure:

- tenant DB cold open/migration;
- warm reopen;
- 10/50/100 idle tenant DB pair FD count;
- simple read/write latency;
- WAL checkpoint latency.

These measurements feed T12/T15 capacity policy.

## Exit criteria

PASS only when:

- one hosted tenant = one deterministic SQLite silo;
- hosted tenant paths are server-derived and contained;
- no hosted auth fallback reaches global auth/env;
- DB-backed tag cascade is resolved without unsafe casts;
- realm close/reopen persistence tests pass;
- standalone persistence/auth behavior remains green.

## Handoff

`../results/T05.md` must include:

- TenantPaths API/root layout;
- DB filename/layout contract;
- all services reclassified global -> tenant;
- all hosted-disabled persistence features;
- auth placeholder/no-fallback semantics for T09;
- FD/open latency measurements;
- migration/restart evidence.

