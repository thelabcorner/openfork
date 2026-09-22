# OXP Transactional Runtime Refresh

## Status

Implementation plan. This document defines the runtime-refresh safety contract before code is changed.

## Problem

OXP currently exposes several identities that are useful but insufficient for determining whether the code an agent just changed is actually the code serving the current OXP connection:

- `connector.id` is durable connector/principal identity. It must survive runtime replacement.
- `configRevision` is durable OXP configuration revision. It says nothing about executable code.
- the OXP host endpoint `generation` identifies one secret local endpoint lifetime. It is process-local.
- the Desktop `OxpEndpointGenerationTracker` lifts endpoint replacement into a monotonic Desktop generation and correctly fences stale tunnel work.
- `schemaFingerprint` fingerprints the MCP surface. An implementation-only code change may leave it unchanged.

The Node backend bundle is currently module-resident for the utility-process lifetime. Rebuilding
`packages/opencode/dist/node/node.js` therefore does not make the already-imported OXP runtime execute
that code until the sidecar/Electron process is restarted.

For an external agent this is a bad control loop: the agent can edit and validate the implementation but
cannot safely make that implementation authoritative without risking its own control plane.

## Goal

Make an OXP backend refresh a transactional runtime handoff:

1. the agent can identify the exact compiled backend artifact serving OXP;
2. it can stage the exact replacement artifact already built on disk;
3. the replacement becomes a bounded trial, not an irrevocable restart;
4. the previous runtime remains the rollback target;
5. the new runtime must be explicitly accepted from the new runtime itself;
6. if acceptance never arrives, the sidecar automatically reactivates the previous runtime;
7. a failed candidate never becomes authoritative;
8. source files and Git state are never automatically reverted.

The last point is intentional. "Rollback" means **runtime activation rollback**, not `git restore`.
OXP must never destroy concurrent or uncommitted source work in order to recover its control plane.

## Ownership

The implementation follows the existing architecture instead of adding a second lifecycle system.

### OXP backend module

Owns:

- the OXP MCP surface;
- the first-class runtime-refresh capability contract;
- the read-only runtime status projected by `openfork_info status`;
- a tiny host-injected refresh bridge.

It does **not** restart Electron, spawn an arbitrary executable, select an arbitrary module path, or mutate
source files.

### Desktop sidecar utility process

Owns:

- the currently loaded OXP backend module instance;
- content-addressing the complete executable `dist/node` runtime set;
- the durable accepted-runtime checkpoint and artifact lock;
- cache-busted import of the exact same host-owned backend artifact path;
- candidate validation;
- serial activation, acceptance, and rollback;
- startup crash recovery back to the last accepted runtime;
- the rollback timer;
- publishing the newly active OXP state to Electron main.

This is the only layer that can swap backend module instances because it already owns the module import and
the OXP host lifetime.

### Electron main OXP controller

Continues to own:

- sidecar epochs;
- Desktop-monotonic endpoint generation;
- Secure MCP Tunnel process ownership;
- proven retirement of the old tunnel;
- reconnecting the tunnel when the sidecar publishes a different secret endpoint.

No secret endpoint is exposed to the renderer or model.

## Runtime identity

Add a first-class **runtime ID** distinct from every existing identity.

`runtimeID` is the SHA-256 content identity of the **complete executable runtime set** in `dist/node`, encoded as `sha256:<64 lowercase hex chars>`. The fingerprint is deterministic over byte-exact relative paths, sizes, and file bytes. It includes `node.js`, executable worker siblings, and runtime WASM assets; source maps and `.build-stamp` metadata are intentionally excluded because they do not change executable semantics.

Hashing only `node.js` is insufficient: `build-node.ts` emits worker siblings and other runtime assets that can change independently while the primary module remains byte-identical.

The sidecar also owns a monotonic in-process `activationGeneration` so the same content identity can still be distinguished across activate/rollback cycles. Internal stale-caller authorization does not use the hash as object identity: each loaded module is bound to its exact runtime record, so two separately loaded instances with identical bytes cannot impersonate one another.

Runtime status should contain only non-secret data, conceptually:

```ts
{
  refreshable: boolean,
  runtimeID?: "sha256:...",
  activationGeneration?: number,
  activatedAt?: number,
  state: "stable" | "scheduled" | "trial",
  trial?: {
    id: string,
    previousRuntimeID: string,
    candidateRuntimeID: string,
    phase: "scheduled" | "active",
    activationAt?: number,
    acceptBy?: number
  },
  lastTransition?: {
    trialID: string,
    outcome: "accepted" | "reverted" | "failed" | "unchanged",
    at: number
  }
}
```

The runtime ID is content identity; the endpoint generation remains connection identity.

## Durable accepted-runtime checkpoint

A runtime trial must remain safe across utility-process or Electron crashes. In-memory rollback alone is insufficient: an unaccepted candidate already exists on disk and would otherwise be imported on the next process start.

The Desktop sidecar maintains a checkpoint store under Desktop user data, outside the mutable build directory. Immutable snapshots are keyed by `runtimeID`, while `accepted.json` points only to the last explicitly accepted snapshot. Snapshot creation verifies the runtime fingerprint before copy, after copy, and on reuse. Copies preserve file mode and timestamps so restoring an accepted artifact does not make stale output appear newer than current source to `build-node.ts`. Rollback restores the accepted runtime set exactly and removes candidate-only runtime files. Source files, repository metadata, and Git state are never checkpointed or restored.

Before the backend module is imported on refresh-capable Desktop dev startup, the sidecar acquires the artifact lock and restores the durable accepted checkpoint. On the first refresh-capable startup, the currently installed runtime becomes the bootstrap accepted checkpoint. If a later unaccepted trial crashes the process, restart restores the prior accepted bytes **before** backend import.

Checkpoint recovery is fail-closed. A refresh-capable dev sidecar must not continue by importing whatever candidate bytes happen to be present if accepted-checkpoint recovery fails.

The build watcher and refresh coordinator share one exclusive lock in `dist/node`. Lock ownership includes the owning process ID. Startup waits for a live builder, removes only stale owners, and then performs recovery. The watcher cannot mutate the runtime set during snapshot, activation, acceptance, or rollback.

## Capability contract

Expose one brokered OpenFork capability named `runtime.refresh`.

The backend bridge also exports `OxpRuntimeRefresh.PROTOCOL_VERSION = 1` as an explicit ABI version for future host/candidate compatibility checks.

It is rootless because it mutates the process-global OXP runtime, but it requires the existing **process**
grant. It is not a new authority class.

Actions:

### `refresh`

Required:

- `expectedRuntimeID`

Optional:

- `acceptWithinMs`, bounded to a conservative range.

Semantics:

1. compare-and-swap guard: reject if `expectedRuntimeID` is not the currently active runtime;
2. reject if another trial already exists;
3. hash the canonical backend artifact path;
4. if the artifact hash equals the active runtime ID, return an explicit unchanged result;
5. dynamically import that same canonical artifact with a cache-busting module URL;
6. validate the module's required OXP refresh ABI;
7. verify the artifact did not change between hashing and import;
8. install the host bridge into the candidate;
9. create a trial and return its ID **before activation can retire the caller's endpoint**;
10. schedule activation after a small bounded response-drain delay.

The caller cannot provide a file/module path. This prevents `runtime.refresh` from becoming arbitrary code
loading.

### `accept`

Required:

- `trialID`

The sidecar accepts only when:

- the trial is active;
- the call originates from the currently active candidate runtime;
- the trial ID matches exactly.

Acceptance clears the rollback deadline and forgets the previous runtime as a recovery target.

This makes acceptance a reachability proof: an agent cannot accept the candidate before it has actually
reconnected through the candidate.

### `rollback`

Required:

- `trialID`

For a scheduled trial it cancels activation.

For an active trial it:

1. disposes the candidate OXP host;
2. restores the previous backend module's OXP host;
3. validates that its endpoint is ready;
4. publishes the restored endpoint;
5. lets the existing Electron-main endpoint-generation/tunnel logic reconnect.

A stale/mismatched trial ID fails closed.

## Trial activation

Activation is serialized in one sidecar-owned mutation lane.

To preserve the existing `OxpConfig` invariant, the old and new **active OXP runtimes must not coexist**.
A candidate module may be imported and structurally validated while the old runtime is live, but its
`OxpHost.restore()` is not called until the old host has been disposed.

Activation sequence:

1. snapshot the current trusted host state;
2. dispose the previous OXP host;
3. switch the sidecar's active module pointer to the candidate;
4. restore the candidate host;
5. require `enabled === true` and a ready endpoint;
6. probe the new local endpoint before publishing it;
7. verify connector identity did not change;
8. publish the candidate OXP state;
9. arm the acceptance deadline;
10. Electron main observes the endpoint identity change and safely reconnects its tunnel.

If candidate restore/probe fails before publication:

1. dispose the candidate best-effort;
2. restore the previous host;
3. verify/probe the previous endpoint;
4. publish only the restored previous endpoint;
5. record the failed transition.

Thus an unvalidated endpoint is never advertised to the remote tunnel.

## Automatic rollback

Default acceptance window: 120 seconds.

Bounds: 15 seconds minimum, 5 minutes maximum.

The timer is sidecar-owned and `unref()`'d. When it fires, it runs through the same serialized rollback path as an explicit rollback. Runtime rollback first restores the durable accepted executable artifact set, then restores/probes the previous OXP host, and only then republishes the previous endpoint.

Cancelling a trial while it is still merely `scheduled` also restores accepted bytes on disk; cancelling activation must not leave an unaccepted candidate waiting to become authoritative on the next restart.

If rollback itself fails, the system must not claim success. It records a failed transition and attempts to restore the already-probed candidate runtime to preserve OXP availability. Recovery never edits source or Git state.

## Refresh availability

Transactional refresh is available only when the initial backend module can prove it came from the mutable
standalone Node sidecar artifact (`packages/opencode/dist/node/node.js` or the equivalent canonical
`dist/node/node.js` path).

Immutable/packaged layouts report `refreshable: false` and fail refresh requests explicitly. Packaged
application updates remain owned by the normal application updater/restart path.

## Build versus activation

Building is intentionally separate from activating.

The agent should:

1. edit source;
2. run relevant tests/typechecks;
3. run `bun script/build-node.ts` in `packages/opencode`;
4. read OXP status and retain the current `runtimeID`;
5. call `runtime.refresh refresh` with that expected ID;
6. reconnect to the candidate;
7. run a smoke/status check through the candidate;
8. call `runtime.refresh accept`.

The refresh capability never invokes a shell compiler and never guesses which source tree should be built.

## Dev watcher cutover

The dev workflow is cut over to a dedicated `watch-node-sidecar.ts` process. Backend source changes rebuild `dist/node` as a **candidate** but never activate it. Electron/main-source changes may still restart Electron normally.

The watcher and runtime transaction share the same exclusive artifact lock, preventing a build from interleaving with snapshot/activation/rollback. After startup recovery the watcher performs one freshness pass: if newer source exists, it stages that source again as a candidate while leaving the restored accepted runtime authoritative.

Backend-only changes therefore no longer force a full Electron restart merely to refresh OXP.

## Failure semantics

- stale `expectedRuntimeID` -> conflict/stale error; no mutation;
- refresh already pending -> busy; no mutation;
- unchanged artifact -> explicit no-op;
- unreadable artifact -> dependency-unavailable; current runtime unchanged;
- import/ABI validation failure -> dependency-unavailable; current runtime unchanged;
- artifact changes while being staged -> conflict; current runtime unchanged;
- candidate startup/probe failure -> automatic immediate restoration of accepted artifact bytes plus previous runtime;
- missing acceptance -> automatic artifact + runtime rollback;
- process crash/restart during an unaccepted trial -> accepted checkpoint restored before backend import;
- scheduled trial cancellation -> accepted artifact bytes restored even though candidate host never activated;
- live builder holds artifact lock -> startup waits boundedly instead of deleting a live lock;
- stale artifact lock owner -> startup removes it and continues recovery;
- stale trial token -> stale/conflict; no mutation;
- caller is not active candidate on `accept` -> auth/conflict; no mutation;
- rollback restoration failure -> explicit failure, never reported as successful rollback.

## Security invariants

- no caller-controlled runtime path;
- no arbitrary import URL;
- runtime mutation requires the existing process grant;
- read-only status remains available through `openfork_info status`;
- endpoint URLs/tokens never enter runtime status;
- runtime IDs are hashes, not paths;
- runtime identity covers executable sibling workers/WASM, not only `node.js`;
- the durable accepted pointer changes only on explicit candidate acceptance;
- an unaccepted artifact cannot become authoritative merely because the process restarts;
- the builder cannot mutate the artifact set during a runtime transaction;
- connector identity/config/roots/grants remain durable configuration and survive refresh;
- refresh does not alter provider credentials or the OpenAI credential;
- refresh never stages, restores, resets, cleans, or commits Git;
- old endpoint/tunnel callbacks remain fenced by existing sidecar epoch and endpoint generation rules.

## Performance

Normal OXP calls pay effectively zero refresh cost.

- Runtime hashing is confined to startup recovery, explicit refresh staging, acceptance validation, and rollback integrity checks.
- The source tree is never scanned on OXP request paths.
- No request-path polling is introduced.
- The dev watcher is event-driven; lock contention uses only bounded startup/build retry waits.
- Existing endpoint generation and push-driven state propagation remain unchanged.

## Test matrix

### OXP/runtime bridge

- status without a Desktop bridge is safely non-refreshable;
- malformed bridge failures become bounded typed OXP errors;
- refresh schema requires CAS identity;
- accept/rollback require trial identity;
- catalog advertises `runtime.refresh` as process-authorized, rootless Tier 0 mutation;
- `openfork_info status` reports runtime state without paths or endpoint secrets.

### Sidecar coordinator

- complete executable runtime set gets a deterministic SHA-256 runtime ID;
- worker-only executable changes alter runtime ID while maps/build metadata do not;
- unchanged artifact is a no-op;
- stale expected ID fails before import;
- only the canonical artifact path can be loaded;
- import failure leaves old runtime live;
- post-hash artifact mutation fails staging;
- activation disposes old before restoring candidate;
- candidate readiness/probe failure restores old without publishing candidate;
- successful candidate publication occurs only after probe;
- accept from candidate commits trial and suppresses timeout rollback;
- accept from previous/stale runtime fails;
- scheduled cancellation restores accepted disk bytes without activating the candidate;
- explicit rollback restores previous artifact bytes and host;
- deadline rollback restores previous artifact bytes and host;
- crash/startup recovery restores the last accepted checkpoint before module import;
- accepted snapshot restoration preserves output mtimes used by build freshness checks;
- only one trial exists at a time;
- mutation queue prevents interleaved activation/rollback.

### Desktop boundary

- secret endpoint remains absent from renderer state;
- endpoint change still invalidates/reconnects tunnel;
- runtime refresh does not add arbitrary sidecar commands or arbitrary paths;
- backend-only dev edits no longer bypass transactional activation with an automatic Electron restart.

## Acceptance criteria

The work is complete when:

- an OXP agent can tell which compiled runtime is currently serving it;
- after building a changed Node backend artifact it can request a refresh without choosing an arbitrary file;
- a bad candidate cannot replace a healthy runtime;
- a good candidate becomes a time-bounded trial;
- the agent can prove it reached that trial and explicitly accept it;
- failure to accept automatically restores the previous loaded runtime;
- source/Git changes are untouched by rollback;
- endpoint/tunnel generation remains monotonic and stale-safe;
- status contains no secret endpoint data;
- relevant runtime, sidecar, boundary, capability, and generation tests are green;
- scoped TypeScript diagnostics are zero or explicitly attributable to unrelated concurrent work;
- scoped `git diff --check` is clean.

