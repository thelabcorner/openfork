# T07 - Hosted identity, capabilities and session bindings

**Lane:** hosted authorization / control plane  
**After:** T04, T05  
**Unlocks:** T09, T11, T12  
**Primary repo:** OpenFork  
**Architecture refs:** sections 10, 11, 19, 20, 23, D9-D10, D16

## Objective

Add an opt-in hosted server profile with a universal, verified tenant/session
authority boundary. Hosted callers must not be able to select arbitrary
TenantRef, directory, workspace, session, question, permission, or job
ownership merely by supplying IDs or headers.

PresGen will become the real issuer/integrator in T13. This task builds and
tests the OpenFork hosted identity contract with a test issuer.

## Required authority model

```text
public user auth happens in PresGen
        ↓
PresGen resolves authoritative tenant + session binding
        ↓
PresGen signs short-lived hosted capability
        ↓
OpenFork verifies capability before acquiring TenantRealm
        ↓
binding registry resolves canonical tenant/location/session authority
        ↓
route executes inside verified realm/context
```

Directory/session IDs in HTTP input are selectors that must match the verified
binding, never sources of tenant authority.

## Owned surfaces

Primary candidates:

- new hosted identity/capability modules under `packages/opencode/src/hosted/`
- `packages/opencode/src/server/routes/instance/httpapi/middleware/`
- unified HTTP API groups/handlers for hosted control/data-plane primitives
- server mode/config flags
- cell identity/build/health metadata surfaces
- typed schemas under protocol/schema when needed
- generated SDK output only through required generators
- hosted authorization tests

Avoid provider credential implementation beyond opaque credentialSet/version
claims; T09 owns actual secret resolution.

## Hosted mode profile

Hosted mode is explicitly opt-in, e.g. `--hosted` or operator config.

It should:

- require capability verifier configuration;
- require a hosted tenant root;
- expose hosted control API only on trusted/internal interface or with strong
  service authentication;
- disable or restrict unsafe standalone mutation surfaces;
- retain standalone Basic/device/pair behavior only outside hosted mode unless
  individually proven safe.

Never silently enter hosted mode because multiple credentials exist.

## Capability design

Prefer Ed25519 asymmetric signatures:

- issuer/private key outside OpenFork;
- OpenFork has verification public key only;
- cell compromise cannot mint new PresGen-authorized capabilities.

Illustrative claims:

```text
issuer
audience = openfork-cell:<cellID>
tenantRef
actorRef (audit only)
presgenSessionRef
bindingVersion
credentialSetRef
credentialVersion
scopes
cellGeneration / placement epoch as required
issuedAt
expiresAt
jti or nonce if replay controls require it
```

Keep tokens short-lived. No provider secrets inside claims.

## Cell identity

Hosted health/identity must expose non-secret:

- cellID;
- cell generation/boot identity;
- OpenFork build identity from T00 when available;
- hosted mode enabled;
- readiness/capacity summary hook for T12/T15.

Capabilities are audience-bound to cell identity/generation semantics defined
here. Restart invalidation behavior must be explicit.

## Session binding registry

PresGen-facing session registration binds:

```text
presgenSessionRef
tenantRef
bindingVersion
canonical tenant workspace/location
openforkSessionID (when created/resolved)
credentialSetRef + credentialVersion
allowed features/scopes
state = active | draining | closed
```

OpenFork must derive canonical paths from T05 TenantPaths; control plane cannot
register an arbitrary host path outside the tenant root.

### Versioning

Every mutation increments or supplies a monotonic binding version. Data-plane
capability with stale binding version fails.

This is required for revocation, credential rotation, migration, and stale
browser/request protection.

## Universal middleware/fence

Do not implement tenant checks independently in dozens of handlers.

Create one hosted authorization boundary that:

1. recognizes hosted route/profile;
2. parses/verifies token;
3. validates audience/expiry/signature;
4. resolves binding;
5. proves tenant/binding version/scopes;
6. acquires TenantRealm lease;
7. attaches trusted TenantRef/binding/location context;
8. executes route;
9. releases lease.

Raw `X-Tenant-ID` or `x-opencode-directory` never bypasses this.

## Resource require helpers

Implement reusable ownership assertions such as:

```text
requireTenantSession
requireLocationSession
requireQuestion
requirePermission
requireJob
```

Foreign and nonexistent resources should be indistinguishable where practical
to avoid existence oracles.

## Unsafe hosted surfaces

Until separately certified, disable/restrict:

- provider auth mutation routes that write standalone auth;
- arbitrary plugin install/config mutation;
- pairing/device/embedded UI flows;
- MCP OAuth callback initiation;
- browser host operations not tenantized;
- any endpoint whose authority is an arbitrary directory header.

Record each disabled surface and compatibility path.

## Required tests

### Capability verification

- valid signature/audience/version succeeds;
- wrong cell audience fails;
- expired/not-yet-valid fails;
- tampered tenant/session/scope fails;
- wrong signing key fails;
- stale cell generation/placement epoch behavior is tested;
- malformed/oversized token fails cheaply.

### IDOR matrix

For tenant A/B:

- A capability + B session ID -> no data;
- B capability + A message/part/question/permission/job ID -> no data;
- A capability + caller-supplied B directory -> rejected/ignored;
- stale binding version -> rejected;
- closed/draining binding -> correct failure semantics.

### Context propagation

Verify TenantRef survives:

- normal Effect call;
- async callback bridged through supported mechanism;
- route -> location acquisition;
- cancellation and error paths.

### Standalone

Hosted verifier absence does not break normal standalone server mode.

## Generated API validation

If unified routes are added/changed:

- regenerate `packages/sdk/js` via package instructions;
- protocol client only if protocol API changed;
- add schema/error-body tests for hosted authorization failures.

## Performance guard

Measure middleware overhead for:

- capability verification warm path;
- binding lookup;
- realm lease acquire.

Avoid network round trips to PresGen on every data-plane request if a short-lived
signed capability + local binding version can prove authority safely.

## Exit criteria

PASS only when:

- hosted mode is opt-in and fail-closed;
- one universal verified tenant context boundary exists;
- session bindings resolve canonical tenant locations;
- cross-tenant IDOR matrix passes;
- unsafe standalone mutation surfaces are disabled/restricted in hosted mode;
- standalone mode remains green;
- generated SDKs are synchronized if API changed.

## Handoff

`../results/T07.md` must include:

- capability schema/version;
- public-key configuration mechanism;
- cell identity/generation semantics;
- session binding API/schema;
- hosted route middleware API/context types;
- disabled route/feature list;
- SDK generation commit/artifacts;
- token verification latency.

