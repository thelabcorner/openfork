# T14 - Differential parity, canary and rollback proof

**Lane:** end-to-end validation  
**After:** T01, T13  
**Unlocks:** T18  
**Primary repos:** PresGen + OpenFork  
**Architecture refs:** sections 28-30, production correctness/performance gates

## Objective

Prove that shared hosted mode preserves PresGen/OpenFork user-facing semantics
while delivering the intended density gains and retaining a fast, tested
rollback to per-session mode.

This task does not invent new architecture. It adversarially tests the one that
now exists.

## Differential harness

Run the same normalized workflow through:

```text
A = PRESGEN_AGENT_RUNTIME_MODE=per-session
B = PRESGEN_AGENT_RUNTIME_MODE=shared-openfork
```

Capture both raw and normalized outputs.

Normalize only nondeterministic metadata such as IDs/timestamps when semantics
do not require equality. Do not normalize away status ordering, tool results,
question/permission behavior, terminal events, or errors.

## Required parity scenarios

### Conversation lifecycle

- first message/session creation;
- multi-turn conversation;
- reasoning/text streaming;
- tool invocation;
- terminal `session.status idle` / stop detection;
- explicit user abort;
- retry/provider transient error;
- reconnect after browser SSE drop;
- reload/reopen existing session.

### Interactive blockers

- question tool ask/reply/reject;
- permission ask/once/always/reject;
- multiple pending blockers if supported;
- abort while waiting for blocker.

### Subagents/background

- spawn subagent;
- receive child events;
- parent cancellation;
- background job completion/failure;
- limits/fairness behavior.

### Tools and workspace

- read/write/edit/apply patch;
- shell command;
- representative LSP/MCP if hosted profile enables them;
- PresGen bridge mutation/query;
- diff/checkpoint/snapshot behavior where exposed.

### Session management

- list/status/messages/todos/diff;
- archive/flush/reopen;
- delete;
- concurrent sessions from same tenant;
- concurrent tenants;
- same IDs/canaries attempted across tenants.

## Required failure scenarios

- OpenFork cell crash mid-stream;
- PresGen restart with cell alive;
- cell restart with PresGen alive;
- provider 429;
- provider 500/disconnect;
- credential rotation mid-stream;
- credential revocation;
- tenant realm eviction/recreate;
- queue overload;
- child process timeout/kill;
- slow event consumer;
- malformed/stale capability;
- stale session binding.

Shared mode must fail honestly. It need not make process death invisible.

## Stop/abort correctness

This is a named release gate because event/lifecycle bugs are especially
visible to the Agents UI.

Assert:

- authoritative idle/aborted state observed;
- no endless `thinking/running` after backend terminal state;
- no false idle while provider/tool still running;
- explicit abort releases scheduler/provider/process capacity;
- reconnect snapshot converges to the same terminal state;
- legacy and hosted normalized lifecycle sequences match where semantics are
  intended to match.

## Performance comparison

Reuse T01 schema/workloads.

Produce side-by-side:

| Metric | Per-session | Shared | Delta |
| --- | ---: | ---: | ---: |
| idle RSS/session | | | |
| total RSS @ 25 | | | |
| process count @ 25 | | | |
| FDs @ 25 | | | |
| sockets @ 25 | | | |
| p95 session activation | | | |
| p95 first event | | | |
| p95 stop cleanup | | | |

Also include T12 noisy-neighbor results.

## Long soak

Run a multi-hour synthetic soak if the environment permits:

- tenant/session churn;
- mixed interactive/background load;
- periodic key rotation;
- event reconnects;
- realm eviction;
- tool process churn.

Track:

- RSS slope;
- FD/socket slope;
- hot realm count;
- queue depth;
- stale subscriptions;
- child processes;
- DB/WAL growth;
- error rate.

Any monotonic unexplained growth blocks canary expansion.

## Canary plan

Shared mode rollout stages:

1. automated synthetic only;
2. local/development internal accounts;
3. explicit internal account allowlist;
4. low-percent canary among provider-certified traffic;
5. broader canary.

Do not make shared mode default in this task.

Every stage needs abort criteria, for example:

- any cross-tenant security signal;
- lifecycle parity regression;
- error rate materially worse than legacy;
- memory/FD leak;
- p95 latency regression outside accepted budget;
- event gap/resync storm.

## Rollback proof

Demonstrate, not merely document:

- flip new sessions to `per-session` without redeploy if supported, or via the
  exact minimal deployment/config change;
- existing shared sessions can drain safely;
- compatibility providers remain unaffected;
- rollback does not require DB migration reversal;
- rollback artifact from T00 is accessible if binary rollback is needed.

Record measured rollback time.

## Exit criteria

PASS only when:

- required differential scenarios have semantic parity or documented accepted
  differences;
- stop/abort/status parity is green;
- cross-tenant matrix remains green end-to-end;
- performance comparison is recorded;
- no unexplained soak leak exists;
- internal canary criteria are defined/tested;
- rollback is executed successfully.

Any security isolation failure is an immediate FAIL, not PARTIAL.

## Handoff

`../results/T14.md` must contain:

- differential scenario matrix;
- accepted semantic differences;
- lifecycle/stop event traces;
- performance table;
- soak summary;
- canary stages and abort thresholds;
- exact rollback procedure + measured duration;
- recommendation for/against proceeding to T18.

