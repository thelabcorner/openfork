# T12 - Fair scheduler, admission control and backpressure

**Lane:** shared-resource correctness  
**After:** T01, T07, T08, T09  
**Unlocks:** T13  
**Primary repo:** OpenFork  
**Architecture refs:** sections 17, 27, 29.3, phase 5, D14

## Objective

Add bounded, tenant-aware admission control so one tenant, credential, session,
or background workload cannot monopolize a shared OpenFork cell or grow memory
without bound.

Fair scheduling is a correctness requirement for hosted mode, not a later
optimization.

## Resources that need separate budgets

Do not model everything with one global semaphore.

At minimum distinguish:

- active interactive turns;
- outbound model streams;
- per-provider/per-credential concurrency and backoff;
- tenant active-turn budget;
- queued turns;
- subagents/background jobs;
- child processes/tools;
- session-mutating operations;
- event output/backlog signals from T11 when available.

## Owned surfaces

Prefer a new hosted scheduler/admission module plus narrow integrations into:

- session prompt/runner entry points;
- background/subagent launch;
- provider request boundary;
- tool/child-process launch accounting;
- hosted cell capacity/health endpoint;
- metrics/tests/bench harness.

Avoid rewriting provider internals merely to schedule them.

## Admission hierarchy

Every work item should conceptually pass:

```text
cell budget
  -> tenant budget/tier
     -> provider + credential budget
        -> session / operation budget
```

The work item has immutable scheduling metadata derived from verified T07/T09
context, never caller-controlled tenant headers.

## Queue design

### Required properties

- bounded per-tenant queue;
- bounded global queued-work count/bytes;
- fair dispatch across tenants;
- priority class inside a tenant;
- cancellation removes queued work immediately;
- draining tenant stops new admissions;
- metrics expose queue wait and rejection;
- no unbounded Promise/fiber creation before admission.

### Phase-1 fairness

Round-robin across non-empty tenant queues is acceptable and easier to audit.
If tier weights are required, use weighted/deficit round-robin with explicit
tests; do not implement an opaque heuristic.

### Priority ordering

Recommended:

1. control/liveness/cancellation;
2. interactive user turn;
3. question/permission reply needed to unblock an interactive turn;
4. explicit user background work;
5. subagent;
6. maintenance/indexing/compaction.

Cancellation and liveness must never wait behind provider generation backlog.

## Session mutation policy

Define whether one OpenFork session may execute more than one mutating turn at
once. Default to one unless existing semantics explicitly support concurrency.

Read-only status/message retrieval should not consume a scarce mutating-turn
slot.

## Provider/credential budget

Key rate-limit/backoff state by non-secret identity equivalent to:

```text
tenantRef + providerID + credentialHandle/version
```

T10 may provide provider-specific broader-limit metadata. A 429 for A must not
globally sleep B's unrelated credential.

## Subagent accounting

Subagents inherit a budget from their tenant and parent workload.

Prevent exponential fan-out by enforcing:

- max active subagents per tenant;
- max active descendants per parent/session;
- max queued background descendants;
- scheduler tokens inherited/released on completion/cancel.

Do not let subagents bypass the interactive tenant cap by entering a separate
unbounded registry.

## Child-process accounting

Integrate T08 hooks:

- max child process count per tenant/cell;
- max concurrent CPU-heavy tools where measurable;
- PID/cgroup rejection feeds scheduler admission result;
- killed/cancelled process releases capacity promptly.

## Realm activation budget

Add a hot-tenant realm cap or equivalent memory admission signal:

- evict least-recently-used **idle** realms first;
- never evict a busy realm just to admit another;
- if no idle victim exists, queue/reject activation explicitly;
- T15 will tune TTL/operations from metrics.

## Required tests

### Bounds

- global queue cannot exceed configured cap;
- tenant queue cannot exceed cap;
- rejected request receives stable typed overload error;
- cancellation of queued work removes it immediately;
- no leaked permits after error/abort.

### Fairness

- Tenant A submits huge backlog, Tenant B submits one interactive request -> B
  is admitted within bounded rounds;
- weighted tiers receive expected long-run share within tolerance;
- background work cannot starve interactive work;
- control cancellation remains responsive under saturation.

### Provider backoff

- A credential 429 does not pause B;
- rotating A credential version does not inherit stale backoff unless intended;
- global provider outage can still be represented without N independent retry
  storms if provider semantics justify it.

### Subagents

- recursive fan-out stops at limits;
- parent cancellation releases descendants and scheduler capacity;
- one tenant's subagent storm does not starve another tenant.

### Realm cap

- burst activate > hot cap -> idle eviction/backpressure works;
- busy realms are never evicted;
- realm close finalizers complete before capacity is reclaimed.

## Benchmark campaign

Use T01 baseline workload shape plus hosted synthetic workload.

Mandatory noisy-neighbor profiles:

- flat load;
- burst/spike;
- one abusive tenant + many normal tenants;
- provider 429 storm for one credential;
- subagent storm;
- tool process storm.

Initial architecture SLO:

> Under configured noisy-neighbor stress, unaffected tenants' interactive p95
> time-to-first-token/event degradation should remain below 20% versus
> equivalent uncongested shared-mode load.

If measurement shows this target is unrealistic, document evidence and get an
explicit target revision; do not silently drop it.

## Exit criteria

PASS only when:

- global and per-tenant queues are bounded;
- fairness tests pass;
- provider backoff is credential-scoped;
- subagent/process fan-out is bounded;
- cancellation releases permits promptly;
- hot-realm activation is bounded;
- noisy-neighbor benchmark meets accepted SLO or has explicit revised target.

## Handoff

`../results/T12.md` must include:

- scheduler API/work-item schema;
- default capacities/queue sizes and why;
- fairness algorithm;
- overload error contract;
- provider backoff identity;
- subagent/process budget rules;
- noisy-neighbor results;
- capacity metrics T13/T15 consume.
