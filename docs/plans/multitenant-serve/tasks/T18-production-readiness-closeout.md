# T18 - Production-readiness closeout

**Lane:** closing audit / release gate  
**After:** T14, T15  
**Unlocks:** human decision on making shared mode default  
**Primary repos:** OpenFork + PresGen  
**Critical path:** final mandatory gate  
**Architecture refs:** section 34 in full, plus all decision-register entries

## Objective

Perform the final adversarial audit of the hosted multi-tenant campaign using
the committed task result artifacts as evidence. Produce a binary readiness
recommendation and a precise blocker list.

This task is not allowed to infer PASS from "the code seems complete." Every
mandatory production gate requires evidence.

Shared mode remains non-default unless:

1. T18 reaches PASS; and
2. a human explicitly approves changing rollout/default policy.

## Inputs

Read completely:

- `../README.md`;
- `00-INDEX.md`;
- every mandatory `../results/T00.md` through `T15.md` that exists;
- `T16` result only for provider families intended to be enabled;
- `T17` result only if multi-cell is in current release scope;
- current OpenFork and PresGen git history/diffs for campaign commits.

Missing mandatory result file is a blocker, not implied success.

## First action: evidence ledger

Create a gate ledger mapping every architecture production-readiness checkbox to:

```text
gate ID
requirement
status
task/result source
test/benchmark command
artifact/commit
last run timestamp
notes
```

Use explicit `PASS | BLOCKED | FAIL | STALE`.

Evidence becomes `STALE` if later commits touched the protected mechanism after
the cited test without rerunning it.

## Mandatory security re-run

Even if prior tasks passed, rerun the highest-risk integrated cases on the
final merged tree.

### Cross-tenant data/IDOR matrix

Two tenants with unique canaries attempt cross-access to:

- sessions;
- messages/parts;
- questions;
- permissions;
- todos/diffs;
- background jobs;
- event/replay;
- credential references;
- workspace/files;
- bridge operations;
- child process resources;
- enabled browser/MCP/PTTY resources.

Foreign and absent resources should not leak useful existence information.

### Credential canaries

Assert A/B secrets never cross:

- provider requests;
- logs;
- errors;
- events;
- metrics;
- cache keys;
- child env/argv;
- `/proc` reads.

### Filesystem/process hostile suite

Rerun:

- sibling absolute path;
- traversal;
- symlink;
- hard link where relevant;
- `/proc`;
- inherited FD;
- process tree cancellation;
- child UID/GID identity.

Any cross-tenant leak is immediate FAIL.

## Mandatory correctness re-run

On final integrated build:

- normal multi-turn session;
- stop/idle event convergence;
- explicit abort;
- question flow;
- permission flow;
- subagent flow;
- tool flow;
- event reconnect/gap resync;
- credential rotation;
- realm eviction/reopen;
- OpenFork process restart;
- PresGen restart;
- session archive/reopen;
- legacy per-session compatibility session.

Compare normalized lifecycle against T14 differential expectations.

## Mandatory availability/load re-run

Confirm final configured limits:

- global queue bound;
- per-tenant queue bound;
- active turn caps;
- provider credential backoff isolation;
- subagent/process caps;
- slow event consumer memory bound;
- cancellation permit release;
- hot realm cap/TTL.

Run the accepted T12 noisy-neighbor scenario and ensure result is still within
the approved SLO.

## Mandatory performance re-run

Run representative T01/T14 comparisons on final tree.

At minimum:

```text
1, 10, 25 shared sessions
```

and the largest stable scenario available from prior campaign.

Check architecture targets/revised accepted targets for:

- incremental idle RSS/session;
- session/bootstrap p95;
- process count;
- per-session listening ports;
- sockets/FDs;
- event latency;
- noisy-neighbor latency.

Do not fail a security-correct implementation merely because an aspirational
performance target missed; instead mark the performance gate BLOCKED until a
human accepts a revised measured target. Do not silently revise it yourself.

## Operations proof

Verify:

- pinned OpenFork artifact/build identity;
- per-session rollback runtime;
- backup + restore on current schema;
- tenant drain/evict;
- health/capacity/generation;
- telemetry contains no secret canary;
- exact rollback procedure still works after all merges.

If multi-cell is in release scope, also require T17 migration/stale-epoch proof.

## Hosted provider matrix

Produce the final release allowlist:

| Provider | Auth mode | Shared hosted | Compatibility | Evidence |
| --- | --- | --- | --- | --- |

Anything lacking current certification remains compatibility/disabled. Do not
expand the allowlist for product completeness.

## Worktree/code audit

Before closeout:

- inspect campaign commits for accidental unrelated changes;
- ensure generated API output matches sources;
- ensure no debug endpoints/tokens/canary secrets are committed;
- inspect new module-global mutable state against T02 guard;
- inspect TODO/FIXME markers added by campaign;
- confirm shared mode default is still conservative;
- confirm no provider secret environment fallback reappeared.

## Closeout artifact

Write `../results/T18.md` with:

### 1. Verdict

Exactly one:

- `PASS - READY FOR HUMAN ROLLOUT DECISION`
- `BLOCKED - NOT READY`
- `FAIL - UNSAFE/REGRESSED`

### 2. Gate matrix

Every security/correctness/availability/performance/operations gate with
evidence.

### 3. Final architecture inventory

- default runtime mode;
- hosted providers;
- disabled hosted features;
- one-cell/multi-cell status;
- rollback mode;
- known limitations.

### 4. Final measurements

- baseline vs shared table;
- noisy-neighbor result;
- soak/leak summary;
- backup/restore and rollback durations.

### 5. Remaining risks

Rank by severity and state whether each is accepted, blocks rollout, or belongs
to T16/T17/future work.

### 6. Human rollout decision requested

If PASS, state exactly what default/canary change is being proposed. Do not make
the default change in T18 without explicit human approval.

## Fix policy during closeout

Small proven defects may be fixed in focused commits and their affected tests
rerun.

If a defect requires architectural work or materially changes an upstream task
contract:

1. mark the corresponding gate BLOCKED/FAIL;
2. write a successor task/handoff;
3. do not bury a large redesign inside the closeout commit.

## Exit criteria

T18 PASS requires every mandatory one-cell production gate from architecture
section 34 to have current evidence.

T16 is mandatory only for provider families being enabled in shared mode.
T17 is mandatory only if multi-cell is part of the release being approved.

No cross-tenant security failure can be waived by a performance or product
benefit.

## Handoff

If the verdict is PASS, `../results/T18.md` is the handoff to the human rollout
owner. It must state:

- the exact runtime default/canary change proposed;
- the exact provider/auth-mode allowlist proposed;
- any hosted-disabled features that remain on compatibility mode;
- the rollback command/config and tested rollback duration;
- the monitoring/abort thresholds to watch during rollout;
- whether T16 and/or T17 are in current release scope;
- the commits/build artifacts approved for rollout.

If the verdict is BLOCKED or FAIL, the handoff must instead name the smallest
successor task(s), their prerequisites, the failing evidence, and the runtime
mode that must remain in effect until those tasks close.
