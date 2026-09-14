# T09 - Hosted credential resolver and secret lifecycle

**Lane:** credentials / secret authority  
**After:** T05, T07  
**Unlocks:** T10, T12  
**Primary repos:** OpenFork + PresGen contract fixtures  
**Architecture refs:** sections 5.5, 5.7-5.9, 13, 14, D6-D8

## Objective

Implement a hosted credential path in which PresGen remains the durable secret
authority and OpenFork receives only versioned, tenant-scoped runtime
credentials needed for active hosted work.

Hosted provider resolution must never fall back to process-global `auth.json`,
`OPENCODE_AUTH_CONTENT`, or provider secret environment variables.

## Security invariants

1. Tenant A's credential is impossible to resolve from Tenant B realm.
2. Missing hosted credential fails closed.
3. Credential rotation invalidates credential-bearing client/cache state.
4. Raw secret values never appear in logs, metric labels, cache keys, events,
   errors, session metadata, or capability claims.
5. OpenFork restart begins with no hosted runtime secrets until PresGen
   re-registers them.
6. Standalone auth behavior remains unchanged outside hosted mode.

## Owned surfaces

### OpenFork

- new hosted credential resolver/service modules;
- `packages/opencode/src/auth/` hosted adapter boundary;
- `packages/opencode/src/fork/credentials.ts` as required;
- provider auth/resolution seams;
- credential-bearing provider client cache invalidation;
- hosted control API credential registration/rotation endpoints from T07;
- redaction helpers/tests.

### PresGen

Only contract/test-fixture changes needed to prove credential bundle shape.
Actual shared-runtime integration belongs to T13.

## Credential model

Use opaque identifiers:

```text
CredentialSetRef
CredentialVersion
CredentialHandle
providerID
auth type
secret material (write-only runtime payload)
optional expiry/refresh metadata
```

Capability carries references/version, not secret material.

### Recommended v1 delivery

Use an explicit PresGen control-plane **push** of a versioned runtime credential
set during tenant/session activation/rotation. This avoids an OpenFork ->
PresGen secret-fetch round trip on every provider request and keeps PresGen in
control of durable storage.

If implementation evidence strongly favors just-in-time pull, record the
decision and prove equivalent fail-closed auth, service authentication,
caching, and rotation semantics. Do not mix ad hoc push and pull paths.

## Resolver interface

Conceptually:

```text
resolve(providerID, credentialSetRef, credentialVersion)
  -> scoped auth material | MissingHostedCredential
```

The resolver executes inside TenantRealm and cannot name another TenantRef.

It should expose only the auth shape needed by provider construction, not a
generic `allSecrets()` method.

## In-memory secret handling

JavaScript/Bun strings cannot be reliably zeroized. The implementation must be
honest about that limitation.

Mitigations:

- keep lifetime bounded to active realm/credential version;
- do not persist hosted runtime secrets to OpenFork disk;
- do not clone/serialize them unnecessarily;
- store by non-secret handle/version;
- evict old versions promptly after in-flight work drains/cancels;
- cell boundaries limit compromise blast radius;
- never expose secrets in introspection/stats.

Do not claim cryptographic erasure from a live JS heap.

## Rotation state machine

Define explicit behavior:

```text
v7 active
  -> install v8
  -> new work requires v8
  -> v7 in-flight work may drain for bounded grace or be cancelled
  -> destroy references/caches to v7
```

Stale capability referencing v7 after binding version/credential version moves
to v8 is rejected.

Rotation of Tenant A must not invalidate Tenant B provider caches.

## Provider-client cache interaction

Initially provider SDK/model clients remain location-scoped.

Every credential-bearing cache identity must include a non-secret equivalent of:

```text
tenant realm generation
providerID
credentialSetRef
credentialVersion
provider endpoint/config identity
```

Never use raw API key as a `Map` key. T02-known offenders such as Genspark-style
secret-keyed caches must be changed or provider-disabled in hosted mode.

## Hosted Auth compatibility

Provide a hosted adapter for existing code paths that yield `Auth.Service` if
necessary, but make the source explicit:

- standalone Auth -> file/env behavior;
- hosted Auth adapter -> TenantRealm credential resolver only.

No hidden fallback chain.

## Required tests

### A/B canary

Use fake keys `TENANT_A_CANARY` and `TENANT_B_CANARY` with a mock provider.

- concurrent A/B requests send only their own key;
- guessed credentialSetRef from other tenant fails;
- identical provider/model IDs do not merge auth state;
- rotate A while B streams -> B unaffected;
- evict A realm -> A secret no longer reachable through resolver;
- restart realm without re-registration -> explicit missing credential.

### No fallback

Set all common provider env vars and standalone `auth.json` fixtures to obvious
canaries. Hosted resolver must never use them.

### Redaction

Trigger:

- provider error;
- timeout;
- malformed credential;
- log statement;
- metrics snapshot;
- event/replay;
- debugging/introspection endpoint.

Assert raw secret never appears.

### Rotation races

Randomize concurrent resolve/install/revoke/request operations. Verify version
monotonicity and no cross-tenant invalidation.

## Performance guard

Measure:

- warm credential resolve overhead;
- install/rotate latency;
- provider client rebuild cost after rotation;
- resident credential-set count per hot realm.

Resolver lookup should be local and cheap on the hot request path.

## Exit criteria

PASS only when:

- hosted credentials are tenant-scoped and non-durable in OpenFork;
- no ambient fallback exists;
- rotation/version invalidation is race-tested;
- raw secrets are absent from logs/events/cache keys/metrics;
- mock A/B provider canary passes under concurrency;
- standalone auth remains green.

## Handoff

`../results/T09.md` must include:

- resolver API;
- credential registration payload/schema;
- rotation/revocation semantics;
- cache identity rules;
- redaction test coverage;
- warm lookup/rotation metrics;
- hosted provider code paths still blocked pending T10 certification.

