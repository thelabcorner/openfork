# T17 - Multi-cell placement, migration and failover

**Lane:** horizontal scale / deployment stamps  
**After:** T14, T15  
**Unlocks:** multi-cell production scale and dedicated-cell tiers  
**Primary repos:** PresGen + OpenFork  
**Critical path:** no for one-cell hosted v1  
**Architecture refs:** sections 25-26, phase 8, D16-D17

## Objective

Scale the proven one-cell hosted architecture to multiple bounded OpenFork
cells without turning tenant SQLite into an active-active distributed database
or weakening the authority model.

PresGen becomes the durable placement/control plane:

```text
tenantRef -> cellID + placementEpoch
```

Each tenant has exactly one writable owning cell at a time.

## Preconditions

Do not begin implementation against an unstable one-cell runtime.

T14 must have proven lifecycle/security parity and T15 must provide:

- tenant drain/evict;
- consistent backup/restore;
- cell identity/generation;
- capacity metrics;
- crash reconciliation.

## Owned surfaces

### PresGen

- durable placement registry/model;
- cell registry/health/capacity client;
- routing layer for hosted session activation/requests;
- migration orchestrator;
- capability issuer cell audience/placement epoch;
- deployment/canary config.

### OpenFork

- capacity advertisement refinements;
- cell drain/migration hooks;
- restore/activation readiness;
- placement epoch/generation validation where needed.

## Placement authority

The authoritative placement store must be available to the PresGen control
plane across hosts. Do not store it only in one OpenFork cell's local SQLite.

Use PresGen's production durable relational/control-plane store after auditing
the existing deployment architecture. If Postgres is the shared production
database, it is a natural candidate; do not introduce another distributed
database merely for placement without evidence.

Placement row conceptually includes:

```text
tenantRef
cellID
placementEpoch
state = active | draining | migrating | failed
targetCellID?
updatedAt
version / optimistic concurrency token
```

## Cell registry

Each cell reports:

- cellID;
- generation;
- OpenFork build/version;
- readiness/draining state;
- CPU/memory pressure;
- active turns/queue depth;
- hot tenant count;
- child-process/FD/socket pressure;
- storage/free capacity;
- DB/WAL latency summary.

PresGen stops placing new tenants on cells beyond admission thresholds.

## New tenant placement

Use capacity-aware placement among healthy cells.

Once assigned, persist the result. Do not recompute the destination from a
simple hash on every request because the tenant's writable SQLite/workspace is
physically local to its owner cell.

Consistent hashing may be used as an input/preference, not as sole authority.

## Request routing

Before minting a hosted capability:

1. read authoritative placement;
2. choose owning cell;
3. bind capability audience to `cellID` and placement epoch/generation policy;
4. route request/link to that cell;
5. cell rejects stale wrong-audience/wrong-epoch capability.

Never trust a browser/client-selected cell ID.

## Tenant migration state machine

Required sequence:

```text
active on A
  -> placement draining(A -> B)
  -> reject new admissions on A
  -> finish/cancel active work by deadline
  -> close event subscriptions / tell PresGen reconnect
  -> checkpoint WAL + close realm
  -> copy/restore DB + required workspace/archive to B
  -> verify checksums/schema/build compatibility on B
  -> increment placementEpoch
  -> activate B
  -> issue capabilities only for B/new epoch
  -> retire A copy or keep read-only rollback snapshot by policy
```

At no point may both A and B accept writes for the same placement epoch.

## Migration transport

Use T15's consistent backup/restore primitive rather than copying open SQLite
files over a network filesystem.

Required artifact manifest:

- tenantRef;
- source cell/generation;
- source placement epoch;
- DB/schema version;
- OpenFork build compatibility info;
- checksums;
- workspace/archive metadata;
- timestamp.

## Failure handling

Test failures at every migration step:

- target unavailable before drain -> remain active on source;
- failure after source drain but before copy -> recover/resume source if safe;
- corrupted copy -> target never activates;
- target activation failure -> controlled rollback/retry;
- PresGen crash mid-migration -> placement state resumes idempotently;
- stale old-cell capability -> rejected;
- source cell dies unexpectedly -> restore latest backup to replacement cell,
  increment epoch, reconcile in-flight turns as interrupted.

Document RPO/RTO for unexpected cell loss; do not imply zero data loss unless
backup replication actually provides it.

## Dedicated-cell / isolation tier

The same placement model should allow a tenant to target:

- pooled shared cell;
- low-density cell;
- dedicated cell.

Do not create a separate API/auth model for dedicated tenants. Isolation tier is
a placement policy over the same TenantRef/capability contract.

## Deployment stamps and canaries

Cells are independent deployment/canary units.

Support:

- build/version visible per cell;
- no new placement onto draining old version;
- migrate/canary selected tenant cohort;
- rollback placement to prior healthy stamp using tested migration path;
- mixed versions only when schema/protocol compatibility rules permit it.

## Required tests

### Placement

- new tenant placed on healthy cell;
- capacity threshold excludes saturated cell;
- subsequent requests stick to authoritative placement;
- forged cell choice ignored.

### Migration

- A -> B successful with session/workspace canaries;
- no simultaneous writable ownership;
- event stream reconnects to B;
- stale A capability rejected;
- PresGen restart mid-migration resumes safely.

### Failure

- source crash;
- target crash;
- corrupt backup;
- network partition/control API timeout;
- cell generation changes during migration;
- placement optimistic concurrency conflict.

### Scale

Run synthetic placement across enough tenants/cells to verify registry and
capacity logic does not become O(all tenants) per request.

## Exit criteria

PASS only when:

- durable placement authority exists outside local cells;
- capability audience/epoch follows placement;
- one writable cell invariant is enforced;
- migration is drain/checkpoint/restore, not live shared WAL;
- crash/mid-migration recovery is idempotent;
- dedicated-cell policy uses the same protocol;
- multi-cell canary/rollback is documented and tested.

## Handoff

`../results/T17.md` must include:

- placement schema/store;
- cell selection algorithm;
- capacity thresholds;
- migration state machine and artifact format;
- RPO/RTO evidence;
- stale capability tests;
- deployment stamp/canary runbook.

