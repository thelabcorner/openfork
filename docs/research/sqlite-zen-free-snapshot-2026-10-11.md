# SQLite scan starvation: Usage.ZenFree.snapshot repair — 2026-10-11

## Runtime evidence and scope

The supplied Desktop startup transcript at 2026-10-11 11:59–12:03 UTC logs repeated slow SELECTs on the dedicated `scan` connection: `sqlHash=e3be8ca2`, `sqlLen=692`, `sqlOrigin=Usage.ZenFree.snapshot`, schema shape `part,message,usage_record` with two joins and JSON predicates. One finished in 4,072 ms, another in 3,371 ms; the scan connection had pending work. These are observations from the **previously running sidecar**, not measurements of this patch.

The same log independently confirms an older `c2b111a6` / 1,065-byte read on the **primary** lane occupying its only permit for at least 93 seconds, causing Goal recovery and limit-recovery timeouts. This is a distinct unresolved *deployment/runtime verification* problem; it is NOT fixed by the Zen SQL rewrite. The earlier source FTS-first query rewrite and OXP routing isolation should be trialed with an explicitly refreshed backend before treating that defect as resolved.

## Source-of-truth and identified defects

`packages/opencode/src/usage/zen-free.ts` previously:

1. Created `idx_part_time_created` and `idx_message_time_updated` ad hoc using primary writable `db.run(CREATE INDEX IF NOT EXISTS ...)` during service initialization. Schema maintenance does not belong on the foreground quota-service bootstrap.
2. Scanned the complete 90-day `part` time range, parsed part JSON on arbitrary part types, joined assistant message JSON, and looked up `usage_record` last even though **UsageRecord is the authoritative persisted provider/route/model settlement**.
3. Checked cache TTL only BEFORE its singleton `queryPermit`. Twenty simultaneous misses could each wait for and execute the same expensive 90-day scan sequentially, despite the first query completing and populating the cache.

## Bounded implementation

Updated the previously clean `packages/opencode/src/usage/zen-free.ts`:

- Query public Zen settlement rows starting with `usage_record INDEXED BY usage_record_model_completed_idx` and `provider_id='opencode' AND route_kind='public'`. Index and message/part ID lookups keep JSON decoding off unrelated provider traffic and other part types. Explicit CROSS JOIN pins the intended indexed driver on SQLite. Still enforce assistant message/provider JSON and step-finish type to protect historical type semantics; still count *each generation step*, not one per assistant message. Inconsistent provider attribution fails closed instead of counting foreign settlements as public Zen traffic.
- Limit-hit query uses the same settled provider index, preserving the historical error/time checks and UTC/day aggregation.
- Remove quota-init CREATE INDEX statements. Use the Core migration-owned `usage_record_model_completed_idx`, present in `packages/core/src/usage/sql.ts`; do **not** drop existing indexes from user databases.
- Move cache recheck and publication under the same semaphore. Set cache age at completion, not at query start. No arbitrary retry, unlimited timeout, schema migration, or user database edits.

## Reproduction and tests

New deterministic disposable in-memory benchmark:
`packages/opencode/test/usage/zen-free-scan-plan-20261011.ts`.

Command in `packages/opencode`:
`bun test/usage/zen-free-scan-plan-20261011.ts`.

Fixture: 40,000 assistant messages/settlements, 120,000 parts, indexed real SQLite joins. Two query families, each with old/new query plans; both variants returned identical rows in this fixture. Average over five timed executions each:

| Scenario | Old query avg | New query avg | Speedup |
|---|---:|---:|---:|
| generation requests | 133.751ms | 6.543ms | 20.44x |
| FreeUsageLimitError detection | 8.412ms | 3.160ms | 2.66x |

Old generation plan: time-indexed part scan -> message PK -> usage_record PK; new plan: indexed `usage_record(provider_id,...)` -> message PK -> `part(message_id,id)`, with bounded matched-row time sort.

New `packages/opencode/test/usage/zen-free-scan-permit-20261011.test.ts` exercises real `ZenFreeUsage.node` and Drizzle-emitted SQL:
- Twenty overlapping callers with delayed SQL generate **exactly two queries** (request + error) and one scanDb acquisition, with one shared snapshot value.
- No primary DDL on service initialization.
- EXPLAIN QUERY PLAN shows provider-indexed `usage_record` as the first driver; no unbounded `SCAN p`.
- Actual query excludes account settlements and a foreign provider record with inconsistent assistant-message metadata, while preserving two step-finish generations for the one valid settlement.

Existing `test/usage/zen-free.test.ts` validates persisted production-like records, multiple steps in one message, public/unknown/account distinction, and once-per-day calibration. Existing `test/quota/opencode-zen.test.ts` validates fallback and learned quota model.

Combined targeted test invocation:
`bun test test/usage/zen-free-scan-permit-20261011.test.ts test/usage/zen-free.test.ts test/quota/opencode-zen.test.ts`
**10 PASS / 0 FAIL, 54 assertions** in the final rerun, Bun 1.4.3, 2.95s. A new source SQL-fingerprint negative check confirms the compiled production query no longer matches old `e3be8ca2`.

## Limits / next release gate

- No change to or restart of running Desktop/sidecar, no production DB writes, no git staging/commits/resets; 402 pre-existing dirty/untracked worktree entries were preserved.
- The new 20x ratio is from a **synthetic** workload, not a claim that the live 4s query is now 0.2s. Benchmark distribution, cache, WAL pages and file system will differ.
- It is not a universal SQLite abort: a very slow query on another scan consumer still occupies that scan connection; native worker termination is not a bounded SQLite interrupt.
- Load an approved **candidate backend** safely after validation. Confirm fresh `e3be8ca2` events cease, primary `c2b111a6` stops appearing, and actual p95/p99 OXP search/interrupt/Goal completion survive concurrent large-corpus reads. Investigate any other fresh slow query fingerprint independently, without reconstructing user SQL from hashes or running destructive migrations against the user's live DB.

## Compilation and final disposition

`packages/opencode: bun run typecheck` finished with exit code **2** and the pre-existing package-wide diagnostics (CLI support-bundle, HTTP Session handlers, compatibility/fixture/Swarm test types). No diagnostic named `src/usage/zen-free.ts`, `test/usage/zen-free-scan-permit-20261011.test.ts`, or this new scan fixture. **This is not a passing package-wide typecheck.**

`git diff --check -- packages/opencode/src/usage/zen-free.ts` exited 0 (Git warned only that the prior source's CRLF may be normalized to LF on a future Git touch). This worktree remains dirty intentionally; zero production database mutations, zero commits, zero developer sidecar restarts or interruption to running agent work.

### Mandatory next verification

The supplied startup log shows `c2b111a6` blocking **primary** permit for at least 93.8 seconds, with Goal and limit-recovery queries subsequently timing out. That query is distinct from the `e3be8ca2` Zen-Free scan fix. Confirm the staged backend artifact is explicitly activated/loaded, and validate the pre-existing FTS-first SQL fix + independent OXP search scan routing with a fresh runtime log; otherwise source-level correctness does not guarantee a running repair. The OXP status in this chat reported `runtime.refreshable=false`, so I did not attempt a transactional hot refresh.

### Adjacent cross-package regression gate (rerun after final edit)

- Core SQLite/FTS/permit/read-worker/session-isolation: `bun test test/session/sqlite-session-recall-lane-isolation-20261011.test.ts test/database/sqlite-fts-recall-permit-regression-20261011.test.ts test/database/sqlite-permit-tracker.test.ts test/database/sqlite-read-worker-scheduling.test.ts test/database/sqlite-control-lane.test.ts` in `packages/core`: **13/13 PASS**, 85 assertions, 2.80s. Expected error logs from denied `SQLITE_READONLY` writes are part of the negative-control PASS.
- Native OXP supervision and Exchange search: `bun test test/oxp/session.test.ts test/exchange/session-search.test.ts` in `packages/opencode`: **18/18 PASS**, 117 assertions, 6.14s.
- Together with final Zen quota tests: **41 tests PASS, zero failures across ten targeted files** (54 + 85 + 117 = **256 assertions**); does not certify sidecar deployment, production corpus, or other subsystems.
