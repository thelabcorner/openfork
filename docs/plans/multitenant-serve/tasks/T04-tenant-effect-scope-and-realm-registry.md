# T04 - Tenant Effect scope and realm registry substrate

**Lane:** Effect/runtime scope  
**After:** T02, T03  
**Unlocks:** T05, T07  
**Primary repo:** OpenFork  
**Architecture refs:** sections 5.1-5.4, 8, 9, 24, D3

## Objective

Introduce a first-class **tenant** scope into OpenFork's Effect dependency
graph so tenant-owned services cannot accidentally become process-global merely
because a caller forgot to include a tenant key in a `Map`.

Target dependency lattice:

```text
global
  └── tenant
       └── location
```

The task also introduces the tenant-realm registry/lifecycle substrate and a
standalone adapter that preserves existing OpenFork behavior when hosted mode
is not enabled.

## Required invariants

1. A `global` node cannot depend on a `tenant` or `location` node.
2. A `tenant` node can depend only on `tenant` + `global` nodes.
3. A `location` node can depend on `location` + `tenant` + `global` nodes.
4. Two tenant realms use distinct tenant-owned service instances even when the
   layer definitions are identical.
5. Global services are shared only through deliberate hoisting/classification.
6. Realm disposal closes tenant/location resources and invalidates stale work.
7. Standalone OpenFork gets one default/single realm without hosted credentials
   or capability plumbing.

## Owned surfaces

Primary candidates:

- `packages/core/src/effect/app-node.ts`
- `packages/core/src/effect/layer-node.ts`
- `packages/core/src/effect/app-node-builder.ts`
- `packages/core/src/location-services.ts`
- `packages/core/src/location-service-map.ts`
- new `packages/core/src/tenant-*` modules
- relevant `packages/core/test/effect/**`
- `packages/opencode/src/effect/app-node-builder-v1.ts`
- `packages/opencode/src/effect/app-runtime.ts`
- new OpenFork tenant runtime/realm registry modules
- focused hosted runtime tests

Do not yet implement provider credentials, hosted HTTP auth, or PresGen
integration.

## Design requirements

### 1. Extend app-node tags

Conceptually:

```ts
export const tags = LayerNode.tags({
  location: ["tenant", "global"],
  tenant: ["global"],
  global: [],
})
```

Expose corresponding types/helpers such as `TenantNode` and
`makeTenantNode` using the existing flat-module conventions.

The TypeScript type system should reject invalid dependency direction at the
node definition site.

### 2. Add TenantRef

Use an opaque/branded identifier. It must not contain PresGen email/user PII.

TenantRef is trusted runtime context after verification; raw HTTP headers are
not TenantRef.

### 3. Build tenant service map / realm registry

Use the existing Location `LayerMap`/hoisting pattern as inspiration, but do not
force an identical implementation if lifecycle requirements differ.

Conceptual service:

```ts
interface TenantRealmRegistry {
  acquire(ref: TenantRef): Effect<TenantRealmLease>
  drain(ref: TenantRef, reason: DrainReason): Effect<void>
  evict(ref: TenantRef): Effect<void>
  stats(): Effect<RealmStats[]>
}
```

Each lease must carry a realm generation/epoch.

### 4. Fresh realm-local memoization

Do not reuse the process-global `memoMap` for tenant-owned layers.

Choose one of:

- a fresh `Layer.makeMemoMapUnsafe()` per tenant realm; or
- another Effect-supported construction whose non-sharing behavior is proven
  by the T03 regression harness.

Safe global layers may be provided into the realm explicitly. Never rely on
accidental memo-map deduplication to perform global sharing.

### 5. Tenant-aware location map

The location-service cache must be owned by a tenant realm or keyed
structurally by tenant + location. Two tenants using equivalent directory text
must not receive one location service instance.

### 6. Realm lifecycle

Support states at least equivalent to:

```text
absent -> creating -> ready -> draining -> closing -> absent
```

Requirements:

- single-flight creation per TenantRef;
- no request enters a draining realm unless explicitly allowed for completion;
- close interrupts scoped fibers and closes location resources;
- stale generation lease cannot mutate a recreated realm;
- failed creation removes poisoned cache entries so retry is possible;
- registry exposes bounded stats needed by T12/T15.

Do not implement production idle TTL policy yet unless trivial; T12/T15 will
set capacity/operational policy. The lifecycle must support eviction cleanly.

### 7. Standalone adapter

Normal `openfork serve` without hosted mode must map existing behavior through
one stable standalone realm. Existing CLI/desktop callers must not need to know
TenantRef.

Do not synthesize tenant IDs from directories in hosted mode. Standalone
compatibility is a separate adapter path.

## Implementation sequence

1. Add failing type/tests for the desired tag dependency lattice.
2. Add `tenant` tag/helper types.
3. Introduce TenantRef schema/context.
4. Add minimal tenant service-map/realm registry with fresh memo map.
5. Make location service construction tenant-aware.
6. Add realm generation/lease semantics.
7. Add standalone default-realm adapter.
8. Port T03 harness to the production substrate.
9. Add create/dispose/race/failure tests.
10. Benchmark realm acquire after cold and warm activation.

## Required tests

### Compile/type tests

- global -> tenant dependency is rejected;
- tenant -> location dependency is rejected;
- tenant -> global is allowed;
- location -> tenant/global is allowed.

### Runtime tests

- concurrent acquire(A) single-flights;
- acquire(A) and acquire(B) create different tenant-owned instances;
- location cache is distinct across A/B;
- evict(A) leaves B alive;
- recreate(A) increments generation;
- stale A lease after recreate cannot perform a mutating operation;
- failed creation can retry;
- draining blocks new admissions;
- standalone path behaves as one stable realm.

### Regression

Run existing Effect layer-node/location tests and relevant OpenFork package
tests. Any changed node-tag compile error must be classified rather than
silenced with `any`.

## Performance guard

Measure:

- cold tenant realm activation;
- warm `acquire` fast path;
- location acquire before/after tenant scope;
- memory overhead for 1, 10, 100 minimal synthetic tenant realms.

The goal is not to optimize TTL yet, but warm acquire should remain effectively
constant-time and allocation-light.

## Exit criteria

PASS only when:

- the type-level scope lattice is enforced;
- T03's A/B isolation tests pass on the real substrate;
- tenant-owned layers do not use the global memo map;
- location services are tenant-owned/tenant-keyed;
- realm generation/disposal races are covered;
- standalone OpenFork remains green.

## Handoff

`../results/T04.md` must document:

- new public runtime types/APIs;
- exact safe-global layers currently hoisted;
- exact tenant-owned stub/services currently in the realm;
- realm lifecycle state machine;
- location-key semantics;
- cold/warm timings;
- node-tag migration errors deferred to T05/T06.

