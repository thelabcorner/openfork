# OpenFork SQLite primary-permit starvation — exact-query repair (2026-10-11)

**Disposition:** Source-level fix and host-free tests verified in shared `/webstormprojects/opencode`; **not deployed to the currently running Desktop/sidecar**. No resets, cleanup, staging, commits or user DB modifications.

## Incident evidence and cause

Observed from real OXP delegated worker failures: `SQLite connection permit unavailable after 30000ms`, `lane=primary`, `sqlHash=c2b111a6`, `sqlLen=1065`, `tables=session,part,other,message`, `joins=5`, `json=1`, `workerStage=executing` and a held SELECT exceeding six minutes. That is **one active native SQL statement monopolizing the primary connection permit**, not a SQLite WAL writer-lock wait. Raising `busy_timeout` cannot repair it.

The exact query was reconstructed from the running current-source SQL generator, `packages/core/src/session/search.ts` V1 `part_fts` relevance search with one directory-prefix scope and `includeArchived:false`: exact **1,065 characters / `c2b111a6`**, matching the incident fingerprint and shape. Prior query joined a scoped `session -> part` subquery to `part_fts` using `CROSS JOIN`, forcing SQLite to scan every scoped part and probe FTS5 separately for each row. Its query plan was `SCAN p USING COVERING INDEX part_session_idx`, `SEARCH s`, `SCAN part_fts VIRTUAL TABLE INDEX 32:=M1`, `USE TEMP B-TREE FOR ORDER BY`.

Historical memory evidence callers independently made that query against `Database.Service.db` (the primary writer) in `exchange/memory.ts`, `exchange/memory-read-runtime.ts`, and `tool/memory.ts`. This allowed one slow search to block unrelated transactions, Goal/worker persistence, and supervision.

## Source changes

- `packages/core/src/session/search.ts`: switch selective-scoped relevance to FTS5-first `FROM part_fts CROSS JOIN part p ON p.rowid=part_fts.rowid JOIN session s ... WHERE part_fts MATCH ? AND (scope)`. The scope is applied **before LIMIT/ranking** and authorization still revalidates at the caller boundary. No schema migration or new index.
- `packages/opencode/src/exchange/memory-read-runtime.ts`: memory Session recall now lazily acquires the isolated `scanDb()` read-only worker instead of touching primary.
- `packages/opencode/src/exchange/memory.ts`: legacy read path also uses `scanDb()`, while evidence-verification/mutation paths retain their existing primary owner.
- `packages/opencode/src/tool/memory.ts`: native memory tool Session search likewise uses `scanDb()`.
- New `packages/core/test/database/sqlite-fts-recall-permit-regression-20261011.test.ts`: production Drizzle query shape, SQLite FTS plan and authorized-scope tests. Initially **RED 1/2** for the precise old CROSS JOIN plan, then **GREEN 2/2** after the patch.
- New `packages/core/test/database/sqlite-fts-recall-benchmark-20261011.ts`: disposable synthetic old/new SQL and EXPLAIN comparison. No user DB.
- New `packages/opencode/test/exchange/memory-scan-primary-isolation-20261011.test.ts`: real file-backed ESDB-independent WAL and production `Database.layerFromPath`; six concurrent memory Session recalls complete while another writer owns the primary permit and a primary reader remains queued (**1 test / 8 assertions PASS**).

## Measurements (Windows, Bun 1.4.3, synthetic SQLite/FTS5 fixture)

28,800 parts across 2,400 sessions; 600 sessions in authorized directory group. Six warm measurements each.

| Query | Old scoped-parts-first median | New FTS-first median | Interpretation |
| --- | ---: | ---: | --- |
| rare `sentinel` | 161.282 ms | 0.562 ms | 286.98x in this synthetic corpus, identical ordered top-20 where scores distinguish |
| common `common` | **unbounded / stopped after 100 s** | 30.455 ms | Only the new median is measured. Old plan was terminated; no comparative speedup claimed |

`EXPLAIN QUERY PLAN` new: `SCAN part_fts VIRTUAL TABLE INDEX 32:M1`, `SEARCH p USING INTEGER PRIMARY KEY (rowid=?)`, then `SEARCH s`. No source-side wildcard query-length amplification and no scope relaxation. Ordinary `ORDER BY rank` has no tie-breaker: when scores tie, SQLite may choose different valid top-N identities. Exact ordered parity was checked on non-tied rare-term fixtures, **not** claimed for all possible tied results.

## Verification

- `bun test test/database/sqlite-fts-recall-permit-regression-20261011.test.ts test/session-search.test.ts test/session-recall.test.ts` **PASS**.
- `bun test test/exchange/memory-session.test.ts test/exchange/memory-fidelity.test.ts` **PASS, 8 tests / 43 assertions**.
- `bun test test/exchange/memory-runtime.test.ts test/exchange/memory-recall.test.ts test/exchange/memory-session.test.ts test/exchange/memory-evidence.test.ts` **PASS, 24 tests / 109 assertions**.
- `bun test test/database/sqlite-runaway-plan.test.ts test/database/sqlite-read-worker-scheduling.test.ts test/database-reader.test.ts test/database/sqlite-fts-recall-permit-regression-20261011.test.ts` **PASS, 10 tests / 79 assertions**. Expected negative `SQLITE_READONLY` exercise prints errors during this passing suite.
- `bun run typecheck` under `packages/core`: **PASS**, including new test/bench.
- `bun run typecheck` under `packages/opencode`: **FAILS on pre-existing unrelated errors** in debug support bundle, global/session-read handlers, compatibility tests, etc.; no clean whole-package assertion.
- `bun test test/exchange/memory-scan-primary-isolation-20261011.test.ts`: **PASS, 1 test / 8 assertions**; six recalls finished during a held writer transaction.

## Not yet established

Not yet rebuilt and switched into the active sidecar. No live Electron/OXP replay under 1/3/6 concurrent workers, no WAL size/profile or real 30+ minute soak. The broader SQLite lane can still be slowed by other unrelated SQL and remaining SQL-query-plan pathology. Production acceptance requires a controlled restart/rebuild, rerun of the original c2b111a6 scenario, confirmed **zero primary permit SQL occupancy** for memory recall, and no worker/Goal timeouts at 1/3/6+ sessions. Keep the new source and tests as specific regression gates; do not substitute raising 30 s acquisition timeout or forcibly releasing active native query permits.
