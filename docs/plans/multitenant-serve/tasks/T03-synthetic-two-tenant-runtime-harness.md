# T03 - Synthetic two-tenant runtime isolation harness

**Lane:** isolation harness  
**After:** T02  
**Unlocks:** T04  
**Primary repo:** OpenFork  
**Architecture refs:** sections 5.1-5.4, 7, 8, 9, 28, 30.0

## Objective

Before changing the formal app-node scope hierarchy, build a focused runtime
harness that proves two synthetic tenants can coexist in one process with:

- separate database instances/files;
- separate auth/credential fixtures;
- separate event/replay state;
- separate location/session state;
- fresh realm-local Effect memoization;
- deterministic cleanup.

The harness is both a design spike and a permanent regression fixture for T04
and later tasks.

## Key hypothesis to prove

The current exported process-global `memoMap` can cause supposedly separate
ManagedRuntimes/layers to deduplicate shared service instances. Therefore the
first harness must create realm-local memoization and prove service identity is
different across A and B before any selective safe-global hoisting occurs.

## Owned surfaces

Prefer test/harness paths:

- `packages/core/test/hosted/`
- `packages/opencode/test/hosted/`
- narrowly scoped helper under `packages/core/src/effect/` only if test-only
  construction is impossible without a reusable primitive

Do not change production route semantics or declare hosted mode yet.

## Harness model

Create:

```text
process
  tenant A runtime
    db A
    auth/credential A
    event/replay A
    location A
  tenant B runtime
    db B
    auth/credential B
    event/replay B
    location B
```

Use temporary directories and deterministic canary values.

### Canary data

Tenant A and B need unique values for:

- DB session title/message;
- provider credential fake key;
- emitted event payload;
- workspace file;
- question/permission ID if those services are included in the harness;
- background job/session status if included.

Never use real credentials.

## Required tests

### Service identity

- A Database service object/filename differs from B.
- A Event service/replay state differs from B.
- credential/auth source differs.
- location cache entries do not collide on same relative path names.

### Negative cross-access

- B cannot read A session/message by guessed A ID through realm-local service.
- B cannot observe A event/replay frame.
- B cannot resolve A fake credential.
- disposing A does not invalidate B.
- recreating A yields a new realm generation/service identity.

### Memoization adversary

Construct two realms with the same layer definitions and prove the fresh memo
maps still produce distinct tenant-owned services. Add a control demonstration
showing why the process-global memo map is not acceptable for tenant roots if
useful to lock the failure mode into a regression test.

### Concurrent races

Run A and B concurrently through:

- database writes;
- event publishing;
- location acquisition;
- realm disposal/reacquire race;
- cancellation during one tenant operation while the other continues.

## Do not

- add the formal `tenant` app-node tag yet;
- expose hosted HTTP routes;
- use `process.env` switching between A and B;
- share one SQLite DB with row-level tenant IDs;
- claim OS process isolation from this harness.

## Performance evidence

Measure harness construction cost for:

- cold first realm;
- second realm;
- repeated create/dispose cycles.

The numbers are exploratory and should inform T04's realm registry/TTL design.

## Exit criteria

PASS only when:

- all A/B canary isolation tests pass concurrently;
- realm-local memoization is proven;
- disposal/recreation has deterministic semantics;
- test helpers are reusable by T04/T05/T06;
- no production behavior changes were required.

If the harness shows that a supposedly safe global service retains tenant data,
mark T03 PARTIAL, update the T02 inventory, and do not work around the failure.

## Handoff

`../results/T03.md` must record:

- harness entry point/test files;
- realm construction helper API;
- cold/warm construction measurements;
- service identities proven distinct;
- any service that unexpectedly crossed realms;
- exact invariants T04 must preserve when formalizing the tenant scope.

