# AX: OXP activity durability, diagnostics and deployment provenance

**2026-10-09. Source implementation; NOT deployed to the current ChatGPT OXP host.** The connected host reports `runtime.refreshable=false`, the older static MCP fingerprint `216d1a2b...`, and recurring `activity_recording` incidents with `errorName=SqlError` but no native error code. That evidence **does not establish** whether the actual host problem is SQLite busy contention, schema drift, a constraint violation or another failure.

## Pareto objective and decision

OXP activity history is *observability*. Recording must not turn a successful authorized workspace operation into a failed tool invocation; conversely, swallowing all recording errors without classifying them leaves AX11 continuity and AX16 diagnostics untrustworthy.

For one invocation, optimize the vector:

- maximize P(durable attribution receipt | successful tool invocation);
- minimize additional latency due to persistence, with a bounded incident recovery path;
- minimize loss of user-visible tool success;
- keep P(secret leakage or unauthorized tool execution) = 0 under the same root, Session and grant constraints.

Avoid adding a long native `PRAGMA busy_timeout`. Bun SQLite performs synchronous native operations and a contending connection could block the main event loop while the lock holder needs that loop to finish its transaction. The existing database service deliberately uses a short 75ms native timeout and supports cooperative, Effect-based bounded retries.

## Implemented source changes

1. **Targeted retry:** `src/oxp/activity-recorder.ts` now wraps `OxpActivity.begin`, `settle`, `link` and `registerSession` in the existing shared `retrySqliteBusyCause` helper from `@opencode-ai/core/database/sqlite-busy`, with a 450ms elapsed budget *per independent record operation*, 20ms initial delay and 75ms maximum delay. Only recognized `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` failures retry; each underlying atomic operation is retried *from the beginning*, not by repeating the failed query inside a stale SQL transaction. A local invocation's activity links are now persisted **sequentially**, replacing unbounded link-write concurrency that provided no additional SQLite writer parallelism and increased contention opportunities. The underlying Core activity implementation uses atomic transactions and conditional settlement. No retry policy applies to user workspace mutations or non-busy errors. The total worst-case attribution time for an invocation with multiple links scales with the number of links and should be instrumented in future high-fanout workload checks.
2. **Safe incident codes:** `src/oxp/diagnostics.ts` classifies the actual Effect `SqlError.reason.cause` chain, using a strict `SQLITE_...` code allowlist, native integer code categories, or an exactly matched parameter-free driver error summary. Cycles and depth are bounded. Only the code reaches the 64-entry diagnostic ring; raw SQL text, bound parameters, credentials, queries, prompts and user data do not.
3. **Host identity:** `src/oxp/ax-revisions.ts` defines explicit behavior revisions for capability retrieval, schema projection and activity persistence. `openfork_info(action=status)` now reports `implementation.ax`, separate from the permanent MCP `schemaFingerprint`. A change to broker logic may not change the permanent manifest, so the surface fingerprint alone is not proof of deployment. The revision constants are a manual source-maintenance responsibility. Metadata confers no authorization.
4. **Degenerate discovery:** The shared `src/exchange/capability-search.ts` treats a nonblank but entirely punctuation/stopword query as an unsuccessful search, not as a request for the entire catalog; only omitted/blank queries list all tools.

## Actual evidence

- Independently reproduced real `SQLITE_BUSY` from two Bun SQLite connections holding/contending for a WAL writer transaction in a temporary DB. The native exception was wrapped using Effect's actual `classifySqliteError` + `SqlError` and both `sqliteBusyCode` and `sqliteIncidentCode` returned `SQLITE_BUSY`. The test cleaned up temporary files and modified no production DB.
- `test/oxp/diagnostics-ax.test.ts` covers nested driver errors, `SQLITE_BUSY_SNAPSHOT`, constraint/unique, unclassified errors, cycles and secret redaction; non-SQL user text cannot be reinterpreted as a SQL failure.
- `test/oxp/activity-recorder.test.ts` injects two transient begin failures, one link-write failure, one settle failure and one register-session failure. All complete after bounded atomic-operation retries. It verifies **ordered root and worker-session link outcomes** despite contention; a simulated `SQLITE_CONSTRAINT` fails after one attempt and the recorder degrades to no handle. This fixture tests the retry boundary; it does not simulate complete multi-process production write interleavings.
- Recorder hot-path baseline assertions remain in place. During the current iteration observed recorder benchmark best median begin 0.441ms, settle 0.236ms in one run; host load affects these measurements. This is not a guaranteed global performance bound.
- `test/oxp/server.test.ts` executes the actual modern MCP client status handshake and verifies the `implementation.ax` field, while preserving `sessionTitle`/parent attribution behavior.
- Focused AX, Exchange Code and retrieval tests passed. The OXP parity verifier and package typecheck must be rerun whenever this source changes; unrelated dirty checkout files remain out of scope.

## Why the recovery design is conservative

Official SQLite guidance:
- [SQLite result and extended result codes](https://www.sqlite.org/rescode.html): `SQLITE_BUSY` is concurrency, `SQLITE_BUSY_SNAPSHOT` is a stale WAL read snapshot; `SQLITE_CONSTRAINT` is an integrity error, not transient contention.
- [SQLite isolation](https://www.sqlite.org/isolation.html): a failed read-to-write promotion needs a new transaction; `BEGIN IMMEDIATE` prevents that class of promotion error.
- [SQLite WAL behavior](https://www.sqlite.org/wal.html): readers/writers commonly coexist, but `SQLITE_BUSY` still occurs in edge cases.

Do **not** attempt `INSERT OR REPLACE` to handle a correlation-row conflict; it can clobber parent attribution. Do **not** interpret an unknown terminal result as rollback; verify durable state before retrying user mutations. Keep human- and agent-facing status separate from privileged grants.

## Deployment and further experiments

Deployment is **still blocked** for this ChatGPT connector (`runtime.refreshable=false`). Source-only validation does not repair the connected host. After a supported runtime restart/redeploy with no active conflicting sessions, perform:

1. Read `openfork_info.status.implementation.ax` and compare to source constants. A missing field conclusively indicates an older implementation. An unchanged static schema fingerprint alone is inconclusive.
2. Inspect fresh diagnostics. If `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` dominates, profile begin/settle retry and cross-process writer load. If `SQLITE_CONSTRAINT`, investigate duplicate correlation insert, cross-process race and migration state; if `SQLITE_ERROR` or `SQLITE_SCHEMA`, investigate migrations/DDL. Do not preselect a remedy.
3. Check `sessionPersisted` on the explicit handshake and verify the same parent appears in durable inspection. Measure begin+settle completion, p50/p95/p99 recorder latency, missing parent rate, incident frequency and whether any authorized tool result changes.
4. Run independent low-load and contention-heavy trials, including read-only and state-mutating calls and concurrent clients. Record source revision, binary/runtime, SQLite backend, DB path identity (redacted), grants and replay behavior. Avoid retrying a write with an unknown commit result.
5. Only then decide whether a stronger single-writer queue, transaction staging, local correlation index, dedicated SQLite writer lane or migration correction is necessary.

**Key AX constraint:** return an honest missing-attribution signal promptly rather than blocking or misreporting successful user tool execution.
