# Gate P architecture

## 1. Domain boundary

`OxpParentActivity` is a durable global observability domain.

It records activity performed by an **external OXP principal**. The external
principal remains separate from native OpenFork Session identity.

Required invariant:

```text
ChatGPT parent != OpenFork Session
```

The UI may reuse timeline/session presentation primitives, but the domain model,
storage, routing, authority, and lifecycle remain separate.

## 2. Ownership tier

Parent activity summaries, correlation refs, invocation spans, and causal links
are **Tier 0/1 durable state**.

Therefore:

- list/get/history reads use SQLite/global services only;
- no `Location.Service`;
- no `InstanceStore.load`;
- no plugin/provider/tool bootstrap;
- no cwd fallback;
- no root materialization merely to render a row.

An invocation producer may already be crossing Tier 2/3 for the operation itself.
Recording the already-known safe observation must not create an additional
workspace/runtime dependency.

## 3. Producer flow

```text
HTTP OXP call
   |
   +-- correlation pseudonymizer
   |      raw correlation exists only transiently
   |
   +-- OxpParentActivity.observeParent(...)
   |
   +-- OxpParentActivity.beginInvocation(...)
   |      durable span start
   |
   +-- ordinary OXP dispatch
   |      authoritative domain owners unchanged
   |
   +-- OxpParentActivity.finishInvocation(...)
          durable terminal observation
```

The recorder wraps dispatch. Individual read/edit/git/process/session/worker/MCP
owners must not depend on activity-history persistence.

If activity recording fails, OXP operation correctness/authority must remain
truthful. Observability failure may be surfaced diagnostically, but must not
retroactively redefine whether the operation committed.

## 4. Epoch relationship

The process-local parent-tool epoch tracker and durable Parent Activity are
different owners:

```text
OxpParentToolEpochTracker
  process-local
  liveness/advisory
  authorization: none

OxpParentActivity
  durable
  historical observation
  authorization: none
```

The epoch tracker may return the current observed epoch number to the recorder.
The recorder persists that number as history. Historical epoch rows never become
the source of live lease truth.

## 5. Observation segments

An OpenFork/OXP host restart can interrupt observation. The durable model should
distinguish:

- `hostRunID` — one OXP host generation;
- `observedEpoch` — the non-renewing parent-tool epoch observed inside that host
  run.

This prevents restart recovery from asserting that two observations separated by
a host restart were one uninterrupted lease.

## 6. Global route

An OXP Parent Activity can touch many approved roots. It is therefore not owned by
one workspace.

Preferred route:

```text
/oxp/activity/:activityID
```

Not:

```text
/workspace/:directory/oxp/...
```

## 7. Causal links

Invocation links are historical lineage, not ownership. Supported link kinds are
expected to grow, but initial stable categories are:

- `session`
- `worker_session`
- `worker_group`
- `scheduled_task`
- `process`
- `root`
- `external_mcp`
- `file_transfer`

Deleting or archiving the activity never cascades deletion into these resources.

## 8. Live updates

The durable producer should emit compact semantic events after commits:

- parent activity created/updated;
- invocation started;
- invocation settled;
- link added;
- activity renamed/archived.

Consumers subscribe to one shared global event transport. Do not create one
poller, timer, or SSE stream per activity row.

The sidebar should generally consume materialized activity-summary state plus
incremental events. An opened detail route may subscribe to invocation updates.

## 9. Failure semantics

Invocation history must distinguish at least:

- `running`
- `success`
- `committed`
- `cancelled_before_commit`
- `cancelled_after_commit`
- `denied`
- `conflict`
- `failed`
- `ambiguous_external_result`
- `interrupted`

These are historical observations. They are derived from OXP's existing result
and error metadata, especially `mutation.committed` / `metadata.committed`.

An interrupted span means the host could not observe a terminal result. It does
not assert rollback.

## 10. Bottom-up dependency direction

```text
Core durable activity owner
      ^
      |
OXP recorder adapter
      ^
      |
OxpServer common call boundary
      |
      v
existing OXP domain owners

Core inspection projection
      |
      v
V1/global HTTP adapter
      |
      v
App state + timeline presentation
```

The App never reconstructs activity summaries by scanning invocation history.
