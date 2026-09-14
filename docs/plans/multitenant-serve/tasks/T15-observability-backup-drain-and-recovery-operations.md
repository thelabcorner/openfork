# T15 - Observability, backup, drain and recovery operations

**Lane:** operations / reliability  
**After:** T13  
**Unlocks:** T18, T17  
**Primary repos:** OpenFork + PresGen  
**Architecture refs:** sections 25-27, production operations gates

## Objective

Make one hosted cell operable in production: tenant-aware metrics, health and
capacity reporting, backup/restore, realm/session drain, crash reconciliation,
and runbooks that do not expose secrets.

## Observability principles

Every signal should answer:

1. Is the cell healthy?
2. Which opaque tenant/workload is causing or experiencing the condition?

Allowed dimensions include:

- cellID/generation;
- tenantRef;
- tenant tier;
- sessionRef/OpenFork session ID where safe;
- provider ID;
- credential handle ID/version, never secret;
- operation/tool/priority class.

Never label metrics with provider API keys, capability tokens, bridge tokens,
OAuth access/refresh tokens, full prompts, or user PII.

## Owned surfaces

### OpenFork

- hosted metrics/counters/tracing;
- cell health/capacity endpoint;
- tenant realm stats/drain/evict admin actions;
- DB checkpoint/close hooks needed for backup;
- graceful hosted server drain/restart hooks.

### PresGen

- cell watchdog/health integration;
- backup/archive orchestration;
- runtime recovery/re-registration;
- operational config/alerts/runbooks;
- admin-only diagnostics if needed.

## Required metrics

### Scheduling

- global/per-tenant queued work;
- queue wait p50/p95/p99;
- active turns;
- throttles/rejections;
- cancellations + cancellation latency.

### Inference

- provider request latency;
- time to first token/event;
- streaming duration;
- 429/5xx by tenant/provider/credential handle;
- retry/backoff duration.

### Runtime

- RSS/heap;
- event-loop delay;
- hot realm count;
- realm cold-start/eviction;
- FD/socket count;
- child process count;
- cell link state.

### Persistence

- tenant DB open/migration latency;
- query/write latency;
- WAL bytes/checkpoint latency;
- SQLite busy/locked retries;
- tenant DB/storage bytes.

### Streaming

- active hosted subscriptions;
- link pending bytes;
- replay frames/bytes;
- gaps/resyncs;
- slow-consumer disconnects.

### Tools

- tool wall/CPU time where available;
- process lifetime;
- output bytes;
- denied path/process operations.

## Health and readiness

Distinguish:

- liveness: process responds;
- readiness: can admit safe new work;
- degraded: alive but capacity/provider/storage condition blocks some work;
- draining: no new tenant/session admissions;
- generation identity.

Health should not claim ready merely because HTTP listener is alive while DB
open, scheduler, event link, or spawn broker is broken.

## Tenant realm drain/evict operations

Admin/control flow must support:

```text
active -> draining -> idle/closed -> evicted
```

Drain:

- rejects new admissions;
- allows configured in-flight grace or cancels at deadline;
- waits for child processes/subscriptions/jobs;
- checkpoints DB;
- releases credential references;
- closes realm.

Evict must not kill another tenant or the whole cell.

## Backup

For one tenant:

1. acquire operational lock/drain or consistent SQLite backup primitive;
2. checkpoint WAL;
3. create consistent DB backup;
4. capture required workspace/session archive according to PresGen policy;
5. attach manifest with tenantRef, schema/build version, checksum, timestamp;
6. encrypt/store through PresGen's backup/object-storage policy;
7. verify checksum/readability.

Do not copy a live WAL/database pair naively while writes continue.

## Restore test

Restore into a fresh test cell/root and prove:

- DB migrations/open succeed;
- sessions/messages expected are present;
- no runtime provider credentials are restored from OpenFork backup;
- PresGen can re-register current credentials;
- workspace canaries match;
- stale capabilities from original generation do not work.

## Crash/recovery state machine

### OpenFork process crash

- supervisor detects failure;
- generation changes on restart;
- old capabilities/event links stale;
- PresGen reconnects;
- required bindings/credentials re-register;
- busy turns reconcile interrupted/aborted;
- idle persisted sessions remain usable.

### PresGen restart

- shared cell may stay alive;
- PresGen reconstructs cell client/link;
- authoritative DB session ownership prevents adopting foreign sessions;
- stale bridge capabilities are rotated/rebound as needed.

### Sandbox/container restart

- cell process and generation recreated;
- tenant local persistent storage remounts correctly;
- health remains not-ready until required hosted services initialize.

## Realm TTL tuning

Use T04/T05/T12 metrics to choose an initial idle TTL/hot realm cap.

Record:

- memory saved by eviction;
- cold reacquire latency;
- DB FD count;
- typical tenant revisit interval.

Do not tune purely by intuition.

## Required tests

- metric labels contain no canary secrets/PII;
- health state transitions under dependency failures;
- drain active turn with graceful completion;
- drain deadline cancellation;
- evict idle tenant while another stays active;
- backup during controlled write load yields consistent restore;
- corrupt backup checksum rejected;
- process crash recovery;
- PresGen restart recovery;
- container restart recovery;
- stale generation capability rejection after every restart class.

## Exit criteria

PASS only when:

- required metrics and cell health/capacity exist;
- tenant drain/evict is tested;
- backup + restore is tested end-to-end;
- crash/restart reconciliation is deterministic;
- operational telemetry is secret-safe;
- realm TTL/cap has evidence-backed initial values;
- runbook documents restart, drain, backup, restore, rollback.

## Handoff

`../results/T15.md` must include:

- metrics/health schema;
- default alert thresholds where defined;
- drain/evict commands/APIs;
- backup manifest format and restore command;
- crash recovery traces;
- selected realm TTL/hot cap and evidence;
- operator runbook path;
- prerequisites T17 can rely on for tenant migration.

