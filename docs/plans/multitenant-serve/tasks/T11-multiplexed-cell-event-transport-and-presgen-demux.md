# T11 - Multiplexed cell event transport and PresGen demultiplexing

**Lane:** streaming / transport  
**After:** T06, T07  
**Unlocks:** T13  
**Primary repos:** OpenFork + PresGen  
**Architecture refs:** sections 18.5-18.7, 21, phase 5

## Objective

Replace the current shared-mode-incompatible assumption that one PresGen
session can read **all events from one OpenCode process** with a bounded,
authenticated, multiplexed internal event transport from one OpenFork cell to
PresGen.

PresGen continues exposing its existing user-authenticated per-session browser
SSE surface. Browsers do not connect directly to hosted OpenFork.

## Current behavior that must remain only in legacy mode

`presgen_backend/routes/opencode.py` currently opens `client.stream_events()`
with no session filter and intentionally forwards all process events because
today one process belongs to one PresGen session.

That is correct for `per-session` runtime mode and unsafe for one shared
OpenFork process.

Do not delete the legacy path until rollback policy says so.

## Target topology

```text
OpenFork cell
  tenant event realms
        ↓ authorized multiplexer
  bounded cell event link(s)
        ↓ private authenticated WS or equivalent
PresGen cell-link client
        ↓ demux by trusted tenant/session binding
  existing /sessions/<id>/events browser SSE
```

Use a small bounded number of cell links, not one OpenFork upstream connection
per browser/session.

## Owned surfaces

### OpenFork

- new hosted event transport protocol/schema;
- hosted event subscription manager/multiplexer;
- internal authenticated WebSocket or equivalent route;
- replay/gap/snapshot hooks;
- event-link metrics/tests.

### PresGen

- `backend/src/presgen_backend/opencode/client.py` shared-mode event client;
- `backend/src/presgen_backend/routes/opencode.py` shared-mode demux path;
- service/session registry integration;
- new cell-link manager module if appropriate;
- SSE/streaming tests.

Do not change the browser-facing event contract unless necessary for explicit
gap/reconciliation metadata; preserve user-facing semantics.

## Protocol requirements

Define a versioned internal protocol. A WebSocket is preferred unless measured
evidence favors another duplex transport.

### Control messages

At minimum support:

```text
hello / protocol version / cell identity
subscribe
unsubscribe
resume / replay request
ack or flow-control signal if protocol uses it
gap / resync-required
drain / cell-restarting
ping/pong or liveness
```

### Event envelope

Every tenant event frame must carry trusted routing identity produced by
OpenFork, not copied from caller headers:

```text
tenantRef
binding/session reference
openfork session ID
event type/data
realm generation
binding version or equivalent ownership epoch
transport sequence
domain replay cursor/epoch when relevant
```

Do not put provider secrets or capability tokens in events.

## Subscription authorization

PresGen authenticates the internal cell link as a service.

Each subscribe request must still name an existing hosted session binding and
prove it is authorized. OpenFork resolves the binding through T07 rather than
trusting tenant/session envelope text.

Subagent/child sessions are included only through trusted parent lineage, not
because their session IDs happened to appear on a process-global stream.

## Recovery model

Keep two cursors conceptually separate:

1. tenant/domain replay from T06;
2. cell-link transport sequence.

On reconnect:

- resume transport if retained window proves continuity; otherwise
- send `gap/resync-required` for affected subscriptions;
- PresGen rehydrates session snapshot/messages/status through authorized data
  plane;
- browser stream resumes without silently inventing missing events.

Do not build a single fake global replay cursor across tenant realms.

## Backpressure

Mandatory bounds:

- per-subscription pending bytes/frames;
- per-tenant aggregate pending bytes;
- per-cell-link pending bytes;
- total active subscriptions;
- maximum replay burst.

Slow browser SSE consumers must not cause unbounded OpenFork memory. PresGen may
maintain its own bounded downstream queue and force resync/disconnect when a
consumer cannot keep up.

Control/liveness frames must not sit behind megabytes of token deltas.

## Connection scaling

OpenFork currently has a 256-connection server ceiling in the audited Node
server path. The hosted event design should use O(cells/shards) OpenFork event
connections rather than O(sessions).

Record connection count at 1/10/100/1000 synthetic subscriptions even if the
full tenant workload cannot yet reach 1000 turns.

## Required tests

### Isolation

- subscribe A -> no B event ever delivered;
- guessed B binding/session in A subscription rejected;
- child session only arrives under authorized parent lineage;
- missing ownership metadata causes drop/fail-closed, not global broadcast.

### Multiplex

- one link carries many A/B subscriptions correctly;
- unsubscribe one session leaves others alive;
- concurrent high-rate streams preserve per-session event order;
- one slow subscription does not block unrelated tenants.

### Reconnect/gap

- clean reconnect within retained window;
- reconnect after transport gap -> explicit resync;
- OpenFork restart/new cell generation -> stale link rejected/reinitialized;
- tenant realm eviction/reopen -> domain replay semantics respected.

### Browser-facing parity

Existing PresGen SSE consumer receives the same meaningful event sequence as
legacy mode for a representative turn including:

- reasoning/text deltas;
- tool events;
- question/permission;
- subagent event;
- terminal idle/stop.

## Performance guard

Measure:

- event delivery latency p50/p95/p99;
- events/sec and bytes/sec;
- CPU per 10k frames;
- memory per subscription;
- cell-link connection count;
- slow-consumer behavior;
- reconnect time.

Avoid re-serializing the same event once per downstream subscription inside
OpenFork if PresGen can demux an immutable encoded frame safely.

## Exit criteria

PASS only when:

- shared mode has no per-session OpenFork `/event` connection requirement;
- tenant/session authorization precedes subscription;
- A/B event isolation tests pass;
- reconnect/gap behavior is explicit and tested;
- queues are bounded;
- legacy per-session SSE path still works;
- browser-facing semantic parity is demonstrated.

## Handoff

`../results/T11.md` must include:

- protocol version/schema;
- OpenFork route and PresGen client APIs;
- subscription key/lineage rules;
- queue/replay limits;
- reconnect state machine;
- performance table;
- exact hooks T13 uses to attach a PresGen hosted session to the cell link.

