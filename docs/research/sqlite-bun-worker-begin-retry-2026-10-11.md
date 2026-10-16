# Bun worker SQLite WAL BEGIN retry — verified fix (2026-10-11 CDT / 2026-10-12 UTC)

## Authority and scope

OpenFork's `AGENTS.md` and `packages/core/AGENTS.md` govern this change. V1
is the active production session runtime. This is a fix at the **shared SQLite
connection adapter**, benefiting V1, current/V2 domain writers, and permitted
maintenance paths without migrating Session authority, inventing a new client
API, or changing provider semantics.

This is the same-file WAL writer contention class as the earlier SQLite
reliability campaigns; it is **not** proof that a particular live OXP activity
incident had the same cause. The connected OXP host reports
`runtime.refreshable=false`, so passing repository tests **does not mean
the currently installed host has incorporated these changes**.

## Reproduced failure and root cause

A deterministic regression
`test/database/sqlite-begin-busy-retry.test.ts` placed one WAL connection
inside `BEGIN IMMEDIATE`, kept it open across a 300 ms cooperative yield, and
asked the other connection to begin another write transaction. Before the fix,
the contending connection failed with `SQLITE_BUSY`. The error stack pointed
at `packages/core/src/database/sqlite.bun-worker.ts`, despite an existing
bounded retry in the synchronous Bun driver (`sqlite.bun.ts`) and the Node
worker adapter (`sqlite.node.ts`).

The exact discrepancy was in `sqlite.bun-worker.ts`: its
`execute()` wrapped each worker RPC with a single `Effect.tryPromise`,
immediately converting the first native busy error to `SqlError`. The other
drivers retried failed **BEGIN** requests; this worker path did not.

## Implemented correction

The Bun worker adapter now uses the shared
`sqliteRetryableBegin(query)` admission classifier and
`retrySqliteBusyCause(request, { maxElapsedMs: 15_000, delayMs: 30,
maxDelayMs: 160 })`. A failing `BEGIN` has performed no application work
and can safely be retried, as long as the connection permit remains exclusive.
Retries happen on the Effect scheduler; a worker's synchronous native SQLite
call never blocks the sidecar's main JavaScript thread.

**Negative contract:** user writes, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and
arbitrary multi-statement strings are **never automatically replayed**.
Indeterminate commits must not become duplicate writes. The single permit and
native worker acknowledgment remain authoritative for transactional outcomes.

## Evidence on development Windows / Bun 1.4.3

All tests use temporary, independent SQLite WAL files; production databases
were neither opened nor modified.

| Test | Before | After |
| --- | --- | --- |
| Primary BEGIN while another WAL connection holds writer | Reproducible `SQLITE_BUSY` failure | Pass; both writes present |
| Explicit worker-vs-worker BEGIN contention | New regression | Pass; both writes present |
| Autocommit INSERT under held writer lock | New negative test | Fails promptly, does not replay; final table has only prior committed row |
| Six simultaneous independent worker connections | New pressure test | Pass; exactly six distinct committed rows |
| Node worker BEGIN retry | Existing regression | Pass |
| BEGIN SQL classifier accepts only transaction entry statements | Existing regression | Pass |
| Core TypeScript `tsgo --noEmit` | — | Pass |

One representative combined run: six tests, zero failures, completed in
2.89 seconds. The six-worker pressure case completed in approximately
1.01 seconds, of which at least 650 ms was deliberate held-lock time.
Those numbers are **test-fixture evidence**, not 1/3/6 real LLM Session
throughput or p99 latency. The full desktop/ACP/OXP binary has not been
redeployed and cold-start verified as part of this fix.

## Remaining production gates

- Multi-process/desktop ACP and other external writers under production-sized
  WAL workloads, measured p50/p95/p99 latency and lock-timeout frequency.
- Bounded cancellation behavior while a connection is waiting for native
  transaction acknowledgment; no abandonment of a transaction whose outcome
  is unknown.
- Checkpoint/read pressure and 1/3/6+ **actual V1 Session** end-to-end tests.
- Live OXP error attribution must distinguish lock contention from constraints,
  missing schema, or other native failures. Do not infer OXP deployment from a
  locally passing repository test.

## Follow-up: actual compiled Windows worker path (Bun 1.4.3)

The repository's compiled Windows test initially **failed** even after
`BEGIN` retries were fixed:

`BuildMessage: ModuleNotFound resolving "B:\\~BUN\\root\\sqlite-bun-worker.ts"`

This was a distinct **embedded-worker virtual-fs naming** problem. Bun's
current executable documentation requires each worker to be an explicit
compilation entrypoint, and a previous in-repository certification probe had
verified that Bun 1.4 sometimes stores the worker at a different nested
virtual path. Merely inlining `new URL("./sqlite-bun-worker.ts",
import.meta.url)` did **not** fix the compiler's entrypoint naming.

- `packages/opencode/script/build.ts` now uses
  `naming: { entry: "[name].[ext]" }` so secondary workers are embedded at
  their expected basename under the executable's virtual root.
- The same naming policy means the TUI worker is `./worker.js`; the
  `OPENCODE_WORKER_PATH` compile-time define was updated consistently.
- `sqlite-bun-worker-client.ts` keeps the source-relative Worker URL inline
  (supported by Bun's standalone-executable documentation).
- The **real compiled Windows Bun SQLite worker RPC** regression went
  red→green: `test/database/sqlite-bun-standalone.test.ts` passed.
- A real `packages/opencode/script/build.ts` Windows x64 build, using
  `--single --skip-install --skip-embed-web-ui` and an isolated temporary
  output directory, exited 0. Its own release smoke reported:
  `openfork.exe --version` passed, T3 compatibility alias version `1.15.13`
  passed, and ChunkDB capability reported `user_version 5`.
  The disposable build output was cleaned. This **does not** certify an
  installer, a live ACP/OXP host restart, or every cross-platform target.

Related upstream references:
- https://bun.com/docs/bundler/executables (explicit worker entrypoints)
- https://github.com/oven-sh/bun/issues/32728 (Bun 1.4 parent-path rewrite
  issue and recommended flat worker layout).

## Final expanded regression scope

- **41/41 passed** across 14 selected Core SQLite, OXP activity persistence,
  session durability, migration-shadow, worker cancellation, and control-lane
  suites (225 assertions). This includes the Windows compiled executable test,
  worker-to-worker contention, six independent simultaneous writers, and the
  non-replay-of-busy-writes negative gate.
- Core `bun run typecheck` passed. The wider OpenFork host typecheck remains
  **32 errors**, all in paths outside the corrected Worker adapter and build
  script; this campaign did not attempt to fix unrelated concurrently edited
  subsystems. `git diff --check` passed for touched tracked files.
- **Not validated:** live OXP host refresh, an actual Electron/JetBrains ACP
  process restart, other OS release matrices, real 1/3/6+ LLM Sessions,
  throughput under a large persistent historical DB, or global package
  typecheck/release gates.

## Packaged ACP certification continuation (2026-10-12 UTC)

The earlier `--version` and standalone-worker test did not prove that the
**actual** compiled OpenFork executable could initialize ACP, execute V1
session lifecycle operations, recover from process termination, and coexist
with independent SQLite WAL writers. This continuation ran the existing
in-repository, local-fixture ACP certification harness against the actual
Windows x64 compiled OpenFork executable (Bun 1.4.3).

1. **Compiled ACP smoke:** initialization, `session/new`, `session/list`,
   idle cancellation, a mocked-provider **in-flight prompt cancellation**,
   `session/close`, independent external SQLite writer, stdout-only ACP
   protocol, clean EOF exit, `PRAGMA integrity_check`, foreign-key check,
   and Windows fixture cleanup **all passed** (16/16 checks).
2. **Independent-process concurrency on one WAL file:** `hosts-cert.ts`
   executed real compiled ACP processes (not six fibers sharing a driver):
   1 host × 3 rounds = **3/3 sessions**, 3 hosts × 3 = **9/9**, and
   6 hosts × 3 = **18/18**. Every configuration passed with zero failures,
   matching durable session counts, SQLite integrity and file release.
   Observed completed session create/close throughput was approximately
   **0.286, 0.660, 0.729 rounds/s** respectively. These startup-heavy
   fixtures are *not* provider/tool throughput or steady-state p99 measurements.
3. **Explicit writer reservation contention:** 3 independent compiled ACP
   hosts, 3 rounds each plus one `session/new` while an external WAL writer
   held `BEGIN IMMEDIATE` for ~750 ms, completed **10/10 sessions**,
   with no host failure or damaged database. A larger adversarial variant
   used **6 independent hosts**, 2 rounds each, a **1200 ms held WAL writer**,
   and one extra concurrent `session/new`; **13/13 sessions** committed,
   zero failures, DB integrity and cleanup passed (20.7s wall-clock,
   about 0.628 create/close rounds/s). These are not provider-execution rates.
4. **Crash durability:** `crash-cert.ts` passed both mid-session host kill and
   startup host kill. An independent writer acquired the reservation after
   termination (about 12.5 and 11.6 ms in the two fixtures); a *fresh*
   compiled ACP process then initialized, created and closed a Session,
   exited cleanly, and the DB passed integrity and foreign-key checks.
5. **Repeatable release gate:** `packages/opencode/script/build.ts` accepts
   an explicit `--verify-packaged-acp` option. For the native build target
   it invokes the existing smoke-cert harness with `--binary`, using a
   disposable database and local-only mock. It fails the package build on
   nonzero status, missing required checks or any `pass-with-skips` verdict,
   and fails closed if the option was requested but no native executable was
   eligible for certification,
   rather than accepting a valid `--version` string as adequate. A real
   `--single --skip-install --skip-embed-web-ui --verify-packaged-acp`
   Windows x64 build passed the complete 16-check gate; its isolated output
   was cleaned.

The current OXP host remains `runtime.refreshable=false`: **no live
backend restart or deployment** occurred. No production database was
modified. Real provider-backed parallel V1 agent/tool Sessions, other
release targets, cross-process coordination under a large workload, and
per-Session/per-host memory profiling remain necessary before a general
availability claim.

6. **Second embedded-worker path:** the basename-based TUI worker constant
   `OPENCODE_WORKER_PATH = "./worker.js"` needs to resolve inside Bun's
   embedded virtual filesystem independently of the caller's working
   directory. A Windows compiled-entrypoint regression in
   `packages/opencode/test/cli/compiled-tui-worker-resolution.test.ts`
   passed using the same `naming: { entry: "[name].[ext]" }` policy and an
   unrelated OS-temp cwd. This proves the worker-path *mechanism*, **not**
   that the complete interactive TUI renderer has been exercised.

### Performance flag: unexpectedly high per-host RSS

The Windows `Get-Process.WorkingSet64` sampler recorded ~**2.15–2.25 GB**
working-set maximum for a *single* packaged ACP smoke host in the default
worker mode and **2.32 GB** in a separate synchronous-primary opt-out smoke.
The one-host sampling windows each covered ~16–17 points at 500 ms intervals.
Both smoke configurations completed successfully, so this is an
**observed resource cost**, not evidence of corruption. No causal attribution
is established: these figures alone cannot determine whether the memory
is base Bun module loading, dependency initialization, session data,
JIT/native cache, or a leak. In particular, this small uncontrolled
comparison does **not** establish that the async SQLite worker reduces or
increases RSS. Dedicated phase-level attribution and warm repeated-session
experiments are required before claiming a performance win.
