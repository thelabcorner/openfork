# T06 - Tenant-owned event and replay core

**Lane:** event ownership  
**After:** T05  
**Unlocks:** T11  
**Primary repo:** OpenFork  
**Architecture refs:** sections 5.10, 18, 24, 28.4, D11

## Objective

Make tenant/domain events and replay state structurally owned by the tenant
realm rather than sharing one process-wide tenant-data event service.

This task is about **event ownership and replay semantics inside OpenFork**.
The connection-scalable OpenFork-to-PresGen multiplex transport is T11.

## Required invariants

1. Tenant B cannot subscribe to, replay, enumerate, or infer Tenant A events.
2. A tenant replay cursor/epoch never authorizes another tenant's ring.
3. Location/session filters remain required inside a tenant.
4. Infrastructure/cell-global events use an explicit separate channel.
5. Missing location metadata does not implicitly mean "broadcast to all
   tenants".
6. Realm eviction closes tenant listeners and replay memory.
7. Durable event DB rows live in the tenant DB from T05.

## Owned surfaces

Primary candidates:

- `packages/core/src/event.ts`
- `packages/core/src/event-replay.ts`
- `packages/core/src/session/projector.ts`
- DB-backed event/projector helpers
- `packages/opencode/src/event-v2-bridge.ts`
- `packages/opencode/src/bus/global.ts`
- event-related HTTP handlers only as needed for internal ownership tests
- event/replay tests

Do not implement the PresGen cell multiplex link yet.

## Design requirements

### 1. Tenantize EventV2 and projectors

EventV2 currently depends on global Database and owns process-lifetime listener
registries. Under hosted mode, tenant domain EventV2 must be instantiated inside
TenantRealm.

Projectors that persist tenant session/domain data belong to the same tenant
realm.

If immutable projector definitions can be global while state/listeners are
tenant-owned, split them carefully; otherwise prefer correctness over reducing
small duplicated objects.

### 2. Tenant replay

Each tenant realm owns:

- replay buffer;
- replay epoch;
- sequence mapping;
- connected tenant-domain subscribers;
- any durable aggregate wake/listener structures tied to tenant DB.

Realm recreation creates a new volatile replay epoch. Durable replay can still
rehydrate from the tenant DB where supported.

### 3. Global infrastructure event channel

Cell health/capacity/deploy lifecycle is not tenant data. Create or retain an
explicit infrastructure/global channel that cannot carry arbitrary tenant
payloads by accident.

Do not use `location === undefined` as the definition of infrastructure.

### 4. Legacy GlobalBus

Audit current compatibility bridge behavior.

Hosted mode may:

- restrict GlobalBus to infrastructure/standalone compatibility; or
- envelope tenant events with a trusted realm identity and only expose them to
  tenant-authorized adapters.

The easiest safe hosted v1 path may be to avoid tenant-domain GlobalBus entirely
for the new transport.

### 5. Backpressure

Preserve existing replay byte/frame caps. Tenantization must not multiply
unbounded buffers by tenant.

Add registry-level metrics/counters useful for T12/T15:

- replay frames/bytes per tenant realm;
- subscriber count;
- dropped/coalesced/replay-gap indicators where applicable.

## Required tests

### Cross-tenant

- publish A canary -> B `all()`/listen/replay sees nothing;
- publish B canary -> A sees nothing;
- identical aggregate/session IDs in A/B remain separate;
- B cannot use A replay cursor/epoch to obtain A frames;
- evict A closes A subscriptions without affecting B.

### Within tenant

- location filter still distinguishes two locations;
- session event ordering stays equivalent;
- durable projector/replay behavior survives realm reopen where intended;
- replay capacity/byte limits remain enforced.

### Async context

Exercise:

- timer-delayed publish;
- background job publish;
- subagent/session callback publish;
- retry callback after realm generation change.

Stale-generation work must fail/stop rather than publishing into a recreated
realm.

### Standalone regression

Existing `/event`, desktop/TUI compatibility behavior remains green outside
hosted mode.

## Performance guard

Measure:

- publish throughput A-only before/after;
- 10/100 tenant idle replay buffer overhead;
- subscriber attach/detach cost;
- token-stream publish path allocation/latency if existing event benchmarks
  cover it.

Avoid adding per-event JSON cloning solely to attach tenant metadata when the
tenant realm itself already proves ownership.

## Exit criteria

PASS only when:

- tenant event/replay services are realm-owned;
- A/B negative replay tests pass;
- infrastructure events are explicitly separated;
- stale async work cannot publish into a new realm generation;
- replay/backpressure remains bounded;
- standalone event behavior is green.

## Handoff

`../results/T06.md` must document:

- tenant EventV2/EventV2Bridge ownership graph;
- replay epoch/cursor semantics;
- global infrastructure event mechanism;
- legacy GlobalBus hosted posture;
- subscription API T11 should consume;
- throughput/memory measurements.

