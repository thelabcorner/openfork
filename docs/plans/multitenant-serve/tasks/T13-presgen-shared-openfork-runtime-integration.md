# T13 - PresGen shared-openfork runtime integration

**Lane:** integration / runtime cutover  
**After:** T00, T08, T10, T11, T12  
**Unlocks:** T14, T15  
**Primary repos:** PresGen + OpenFork  
**Architecture refs:** sections 20-23, 30 phase 6, D1, D9, D15

## Objective

Add a fully functional but **opt-in** PresGen runtime mode that uses one
long-lived hosted OpenFork server process per sandbox cell for many PresGen
agent sessions/tenants.

The existing per-session process mode remains intact and selectable for
rollback, unsupported providers, and high-isolation use cases.

This is the first task allowed to assemble all prior hosted pieces into a real
PresGen end-to-end path.

## Runtime switch

Add an explicit configuration such as:

```text
PRESGEN_AGENT_RUNTIME_MODE=per-session|shared-openfork
```

Requirements:

- default remains `per-session` during T13;
- test/development can opt into `shared-openfork`;
- provider certification may force a session back to `per-session` even when
  shared mode is preferred;
- mode selection is logged without secrets;
- no automatic silent fallback from a **security failure** in shared mode to a
  less-safe path. Compatibility routing is an explicit decision before session
  activation.

## Current PresGen surfaces to evolve

Primary:

- `backend/src/presgen_backend/opencode/service.py`
- `backend/src/presgen_backend/opencode/container_manager.py`
- `backend/src/presgen_backend/opencode/sandbox_supervisor.py`
- `backend/src/presgen_backend/opencode/supervisor_contract.py`
- `backend/src/presgen_backend/opencode/client.py`
- `backend/src/presgen_backend/routes/opencode.py`
- `backend/src/presgen_backend/opencode/workspace.py`
- `backend/src/presgen_backend/config.py`
- sandbox Dockerfile/entrypoint/healthcheck
- relevant service/container/routes/client tests

OpenFork integration surfaces are the hosted APIs/protocols from T07-T12.

## Do not overload the existing handle shape

Current `SessionServerHandle` represents a per-session server and carries:

- `port`;
- server `password`;
- `container_pid`;
- a client bound to that server.

Do not put fake port/PID/password values into it for shared mode.

Introduce an explicit discriminated runtime handle, conceptually:

```text
LegacySessionHandle
  runtime = per-session
  process/port/password/client

HostedSessionHandle
  runtime = shared-openfork
  cellID/generation
  tenantRef
  bindingVersion
  credentialSet/version
  hosted capability/session client facade
  workspace/session refs
```

Callers must handle the semantic distinction intentionally.

## Shared cell lifecycle

### Supervisor target

Today supervisor `/start` allocates a port and spawns one `opencode serve`.

Shared target:

```text
sandbox container start
  -> supervisor/watchdog starts one OpenFork `serve --hosted`
  -> stable internal port
  -> health reports cellID + generation + build identity
```

Per-session activation no longer starts an OpenFork process.

The supervisor remains useful for:

- process start/restart;
- health/liveness;
- cell generation;
- graceful drain before restart;
- privileged T08 child-spawn broker if that architecture was selected;
- container-level resource enforcement.

### Crash/restart

When hosted OpenFork restarts:

- cell generation changes;
- stale capabilities/links fail;
- PresGen re-establishes cell link;
- active bindings/credentials are re-registered lazily or through controlled
  recovery;
- in-flight turns reconcile as interrupted unless durable evidence says
  otherwise.

## Session activation flow

Recommended order:

1. authenticate PresGen user;
2. allocate/resolve session workspace;
3. resolve opaque tenantRef;
4. choose runtime based on requested/certified provider;
5. for shared mode, ensure hosted cell healthy;
6. register/update hosted credential set from T09;
7. register session binding from T07 with canonical workspace;
8. register per-session PresGen bridge capability/reference;
9. mint short-lived hosted data-plane capability;
10. create/resolve OpenFork session inside tenant realm;
11. attach to T11 cell event link;
12. return normal PresGen session API response.

Failure at any step must unwind only resources created for that session, not
kill the shared cell.

## Per-session PresGen bridge credentials

Current per-session processes receive `PRESGEN_BRIDGE_URL` and
`PRESGEN_BRIDGE_TOKEN` through process env. One shared process cannot use that
model.

Move bridge authority into hosted session/binding context:

- binding stores an opaque BridgeCapabilityRef/version;
- OpenFork tool execution resolves the bridge URL/capability for the current
  verified session/turn;
- no process-global bridge token;
- one session cannot use another session's bridge capability;
- bridge token rotation/revocation follows binding version semantics;
- child shell/LSP processes do not inherit bridge capability unless a specific
  operation requires it.

This is a mandatory integration seam, not a follow-up.

## Hosted HTTP client pooling

Current `OpencodeClient` intentionally creates fresh `httpx.AsyncClient`
instances for ordinary requests/SSE because the old per-session HTTP servers
had transport reliability issues.

For one hardened shared cell:

- create one bounded keep-alive client pool per cell for ordinary hosted API
  requests;
- pass capability per request/facade, never via a mutable global default header;
- keep T11 event link on dedicated connection(s);
- configure connection limits, keep-alive expiry, connect/read timeouts;
- circuit-break unhealthy generation rather than opening unlimited new
  connections.

Benchmark before/after; retain a switch to disable pooling during rollout if a
transport regression appears.

## Session stop/flush semantics

Legacy mode can stop the per-session server process.

Shared mode must instead:

1. abort active OpenFork turn/session;
2. unsubscribe T11 event subscription;
3. close session binding;
4. revoke/advance binding/bridge capability;
5. release credential/session references;
6. archive/reap workspace according to PresGen policy;
7. leave shared OpenFork server alive.

Current SSE/WS disconnect cleanup that terminates the agent process must be
runtime-aware. In shared mode it may terminate/abort the **session**, never the
cell server.

Inactivity flusher must follow the same distinction.

## Unsupported provider routing

Consume T10 certification registry.

Examples:

```text
openai api-key certified -> shared-openfork
anthropic api-key certified -> shared-openfork
opencode-go subscription uncertified -> per-session
```

Expose the selected runtime in internal diagnostics so parity/canary tests can
prove which path actually executed.

## Required integration tests

### Multi-tenant smoke

At least two PresGen users/tenants concurrently:

- create shared-mode sessions;
- use distinct provider canary credentials;
- send turns concurrently;
- invoke bridge tool operations against distinct PresGen documents/workspaces;
- receive correct T11 events;
- stop one session while other continues;
- close one browser stream while other continues;
- archive/reopen one session.

### Shared process proof

Assert:

- one OpenFork server PID for N hosted sessions;
- no per-session listening ports;
- separate tenant DB/workspace/UID child identities;
- connection count follows cell pool/link design rather than N event links.

### Legacy coexistence

In the same test run:

- create one legacy/per-session compatibility session;
- create one shared session;
- both function;
- stopping either does not kill the other.

### Cell restart

- restart hosted OpenFork process;
- generation changes;
- stale requests fail cleanly;
- PresGen re-establishes link/bindings;
- prior in-flight turn becomes interrupted/aborted, not falsely complete;
- new turn succeeds.

### Bridge isolation

- A bridge capability cannot mutate B PresGen state;
- guessed B session binding/capability rejected;
- bridge capability absent from unrelated child env/logs/events.

## Performance guard

Run T01 workload shape in shared mode at 1/5/10/25/50/100 sessions where
hardware permits.

Record:

- total and incremental RSS;
- process count;
- server activation latency;
- PresGen session activation latency;
- first-event latency;
- sockets/FDs;
- pooled request connection reuse;
- cell-link connection count.

Architecture targets to evaluate:

- >=80% reduction in incremental idle RSS/session vs baseline;
- >=50% reduction in p95 server/bootstrap overhead after workspace preparation;
- zero per-session listening ports in hosted mode.

Do not hide a miss; T14 decides readiness using actual data.

## Exit criteria

PASS only when:

- `shared-openfork` works end-to-end in development/test and remains opt-in;
- many PresGen sessions use one OpenFork PID;
- legacy per-session runtime still functions;
- bridge credentials are session-scoped, not process env globals;
- shared stop/disconnect never kills the cell;
- client pooling and event link are bounded;
- certified/uncertified provider routing is explicit;
- multi-tenant security integration tests pass.

## Handoff

`../results/T13.md` must include:

- runtime selection API/config;
- handle type changes;
- cell lifecycle/supervisor protocol;
- hosted session activation/teardown sequence;
- bridge capability migration;
- pooled client settings;
- shared vs baseline resource table;
- provider routing matrix;
- rollback command/config used by T14.

