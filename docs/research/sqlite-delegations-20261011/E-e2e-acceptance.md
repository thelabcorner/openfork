# OpenFork SQLite 2026-10-11 — E2E supervisor acceptance ledger

Owner: direct ChatGPT/OXP supervision, independent of delegated A/B/C/D lanes.
Authority: `AGENTS.md`, `docs/map/README.md`, `docs/research/sqlite-historical-reconciliation-2026-10-11.md`, executed production source and regressions.
State: **OPEN**. This ledger does not certify deployment or permit a live DB mutation.

## Safety / coordination

- Four separate concurrent DeepSeek V4.1 Flash, max-reasoning workers pinned to the user's selected OpenCode Go account; nested delegation disabled.
- Existing dirty shared worktree: no reset/clean/stash/checkout, no broad stage/commit, no synthetic overwrites, no generated migration edits without ownership, no live sidecar or ACP lifecycle changes, no user DB integrity experiments.
- A owns `fork/credentials.ts` narrow original diff + independently named tests. B owns distinct OXP activity link tests. C owns isolated packaged ACP certification scripts. D owns new read-path/maintenance research and tests. This ledger (E) is a distinct review lane, not permission to edit sibling work.
- Historical SQL fingerprints are incomplete telemetry: a 32-bit hash/length is NOT authenticated SQL. Disallow benchmark claims that identify the actual 325s statement from only the hash.
- Distinguish `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` / `SQLITE_LOCKED`, constraint/FK, OXP request transport failure, worker native busy, queued worker RPC, semaphore admission, and UI scheduler starvation. Generic `EffectDrizzleQueryError` is NOT a root code.

## E2E exit gates (all mandatory before calling recurring incident CLOSED)

### A — credential history
- List/active must not execute 90-day/unbounded `INSERT ... SELECT` on interactive foreground writer; 0/1/multi credential configurations preserve semantics.
- Durable migration/recheck resumes after host restart, interrupt, throw, crash near checkpoint; cursor and inserted rows advance atomically only on acknowledged transaction completion.
- New messages/late inserts, pre-attributed rows, deleted credentials, concurrent explicit usage, and duplicates never produce erroneous assignments. If history cannot be inferred, leave unassigned instead of guessing.
- Real SQLite WAL test: rows, cost aggregation, cursor position, per-slice maximum work, recovery after error; no rolled-back or uncertain COMMIT replay.
- Adjacent fork usage/cache/credentials regressions and typecheck.

### B — activity recorder / links
- Reproduce distinct valid contention vs malformed/stale FK with actual native extended SQLite result code and sanitized SQL operation class; no SQL literal payloads or user metadata disclosure.
- Verify `begin → linkMany → settle → close/reopen` exactly-once/link-idempotence under 40+ concurrent invocations, competing writable connection and cancellation.
- No success when link was not durably acknowledged, no blind COMMIT or externally visible mutation retry; bounded busy only for proven safe idempotent whole units.
- Windows process and WAL teardown must demonstrably finish before fixture removal; an EBUSY cleanup exception must not obscure cause.

### C — package and ACP
- Use actual OpenFork Windows packaging pipeline and disposable output + database, not installed JetBrains binary; validate worker path under Bun compiled app and Electron.
- Execute protocol NDJSON `initialize → session/new → session/close` and cancellation with 1,3,6 independent hosts; verify exit codes, database row integrity and absence of deadlocks.
- Collect mean/p50/p95/p99 completion, throughput, timer lag, CPU/RSS, native busy counts, primary/interactive/scan/control permit holds.
- Include comparable native vs async configurations under identical seeds and hardware to evaluate *previous ~29.7% throughput regression*. Never conflate independent past runs.
- No rollout of default async driver to installed ACP without explicit release owner approval and real certification.

### D — long readers and maintenance
- Trace actual eligible `scanDb/withScanDb` and OFXP supervision callers, and any remaining primary/interactive SELECT or hidden maintenance callbacks.
- Real bounded SQL-origin and EXPLAIN summary, no private SQL/parameters, no synthetic historical fingerprint spoofing.
- Long legal queries either paginate in bounded segments or return deterministic retryable/safe failure, never pin single scanner indefinitely; safety of 2-reader pool and fair admission.
- ChunkDB/OXP retention/ANALYZE/checkpoint use gated, bounded low-priority maintenance, not foreground timers or destructive online VACUUM.

### Integrated hard gate
- Build reproducible source candidate; run Core database regressions, OpenFork fork/OXP/ACP suites, Core TS typecheck, package TS baseline deltas.
- Run 25/50/100 fully simulated sessions with multiple ACP/desktop handles: 100% correct final outcomes/acknowledged settlement, zero 30s primary/interactive/control waiter timeouts, zero stranded cancellation, 0 unreaped subprocesses, bounded scan p99, stable DB integrity after reopen.
- Record exact compiler/runtime versions, seed, data grain, test commands and full exit statuses. Quantify CPU/RSS/throughput and report regressions.
- Production/live activation is a separate approval; OXP tool reports `runtime.refreshable=false`. **Source tests, even comprehensive, do not independently prove the installed running desktop is fixed.**

## Evidence
Pending subagent journals A/B/C/D and independent reviewer verification. Do not mark any unchecked gate PASS.

## Independent supervisor rerun — 2026-10-11

Environment: Bun 1.4.3, Windows, Core package, isolated OS-temp SQLite WAL fixtures. Command from `packages/core`:

```sh
bun test test/database/sqlite-cross-lane-stress-20261011.test.ts test/database/sqlite-scan-process-exit-barrier-20261011.test.ts test/database/sqlite-scan-ipc-error-recovery-20261011.test.ts test/database/sqlite-bun-readonly-process-integration-20261011.test.ts test/database/default-primary-writer-worker-20261011.test.ts
```

Result: **exit 0, 5/5 passing, 39 expect() calls, 5.49s**. The mixed-lane workload recorded 48 primary writes, 24 control reads, 12 scans, 48 durable rows with sum checksum; a representative measured workload time was 193.9ms. The separate tests covered native Bun process deadline/cancel/recovery, invalid IPC recovery, eight consecutive Windows timeouts/close/reap cycles and asynchronous primary worker. The expected timeout test intentionally logs an error-coded `SQLITE_SCAN_DEADLINE` while its assertion passes.

This baseline predates and is independent of the new A/B/C/D lane changes. It does NOT prove deployed backend 25/50/100 session performance, installed packaged ACP lifecycle, full legacy credential-history completeness, actual historical SQL identity or OXP activity-link native error cause.

Supervision controls: exact `opencode-go/deepseek-v4.1-flash`, account key 2 hard-pin, `max`, no nested delegation, four workers; external-directory request from D rejected, constrained to project-approved root. Additional supervisor guidance queued through the delegated worker continuation boundary. No production data touched.

### Independent SQLite writer/OXP-activity baseline

From `packages/core`:
```sh
bun test test/oxp-activity.test.ts test/database/sqlite-contention-policy.test.ts test/database/sqlite-busy-snapshot.test.ts
```
**Exit 0; 26 tests PASS, 131 assertions, 4.06s (Bun 1.4.3)**. Real WAL `SQLITE_BUSY_SNAPSHOT` test confirms deferred read→write promotion can fail and that reserving a writer with BEGIN IMMEDIATE prevents stale-snapshot upgrades. Another WAL retry regression guarantees exactly-once commit for a bounded, provably safe attempt. The OXP activity fixture tested 1/5/10/25/50/100 invocation admission and settlement, causal-link idempotence, timestamp-tie pagination, 96 concurrent parent calls, and post-commit invalidation with no raw correlation digest leakage; 100-way in-memory admission 75.29ms and settlement 31.18ms in this particular run. **Important:** these are in-memory activity stress numbers, not a reproduced file-backed production activity-link error; Lane B must still validate that independently. No production user SQLite database accessed.

## Supervision checkpoints / release vetoes

- Lane C first actual current-source `openfork.exe` compilation produced a candidate binary, but its embedded smoke failed during Bun SQLite worker initialization (`SqliteBunWorkerClient.ready` via `SqliteBunWorkerClient` primary path). This is a **RED packaged-ACP gate**. Exact underlying error, build-file embedding, and environment resolution remain UNDER INVESTIGATION; the old Oct 7 installed executable is not current-source evidence. A requested outside-root temporary-file access was rejected; approved-root disposable output and deeper cause inspection were required. Do not promote default async primary to installed ACP.
- Lane D's initial source inventory found that `OfxpSessionSearch.execute` has no production dispatcher call site; an unregistered adapter is not the cause of live OXP SQL hold. OXP `session.search` itself is a separate registered path currently routed to pooled scan readers. D remains responsible for executable synthetic attribution/paging/maintenance probes without false historical fingerprints.
- Lane A journal now claims bounded historical credential migration ownership; the original unchecked foreground writer remains RED until actual source/tests pass.
- Lane B reproduces native WAL link contention and distinguishes error-chain classification from Windows fixture cleanup; generic wrapper code remains insufficient evidence.
- Every worker explicitly uses the requested hard-pinned key 2/max selection; OXP external-directory permission requests were denied rather than widening file authority. Owner/legacy changes have not been reset/cleaned/staged.

## 2026-10-11 independent B file-backed link certification (supervisor)

From `packages/core`:
```sh
bun test test/oxp-activity-sqlite-link-recovery-20261011.test.ts
```
Exit **0**; **6/6 PASS**, 39 assertions, 4.29s, disposable WAL fixtures safely removed. Native observed classes:
- Contending held writer: `SQLITE_BUSY`, extended `errno=5`, retries only after known release; no blind uncertain COMMIT replay.
- Stale/nonexistent invocation: `SQLITE_CONSTRAINT_FOREIGNKEY`, extended `errno=787`; NEVER classify as BUSY/retry.
- 44 concurrent admissions/links/settlements across 11 activity roots with exactly-once links; 64-link batches remain idempotent.
- Cancellation under lock, subsequent valid retry, and close/reopen durability all passed.

These are **reproduced synthetic classes**. The retained live OXP `EffectDrizzleQueryError` wrapper still lacks authenticated underlying code; do not claim historical root identification or deployed remediation.

## 2026-10-11 independent A RED pre-fix gate (delegated execution)

Agent A's isolated file-backed 2,000-message historical fixture reported 0/7 RED tests with original unbounded write: `list()` failed under a held writer, one routine `list()` attributed all 2,000 rows in a single foreground operation, no durable backfill cursor existed, and credential population changes left process-local state stale. Current proposed bounded backfill subsequently measured 5/7 GREEN pending two failures and reviewer issues: early `migrationChecked`, late imported IDs <= cursor, uncertain COMMIT retry, startup DDL, foreground bounded wait. Source changes MUST NOT be declared certified until corrected/regressed and adjacent tests pass.
