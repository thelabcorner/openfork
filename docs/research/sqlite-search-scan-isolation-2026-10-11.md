# OpenFork SQLite FTS permit starvation — 2026-10-11

## Evidence / scope

- Recurring prior incident: SQL fingerprint `c2b111a6`, 1,065-byte SELECT, 5 joins, native worker executing while the primary single-connection permit was retained for >325 seconds. An independently observed 1,001-byte SELECT (`0bbba6a9`) retained the interactive reader for >46 seconds. These are forensic fingerprints, not authenticated full SQL text. See `sqlite-primary-permit-incident-2026-10-10.md`.
- `packages/core/src/session/search.ts` already contains an independently owned FTS-first V1 part-search rewrite. Reproduced synthetic 28,800-part selective search (600 scoped sessions): reconstructed old nested-loop plan median 165.882 ms, current FTS-first plan median 0.903 ms (~183.7x faster, 6 repeats/mode, identical 20 result IDs). Command: `bun test/database/sqlite-fts-recall-benchmark-20261011.ts sentinel` in `packages/core`; existing benchmark fixture/script and search rewrite were NOT edited in this work.
- An extremely broad synthetic search using that existing comparative benchmark (`common`) did not finish quickly because it executes the reconstructed old query; it was stopped via the OXP process handle after ~37 seconds. No user data or production database was touched. **Do not** treat that interrupted run as a benchmark result.

## Additional connection isolation (this change)

Edited only clean `packages/core/src/session/inspection.ts`:

- Acquire `Database.Service.withScanDb`, the existing production leased analytical-reader pool. Route the *entire* `SessionInspection.search` and `SessionInspection.recall` operations through one exclusive scan lease each rather than the latency-sensitive `readDb`. Search statements and recall coverage/tool reads now remain on the same leased reader for the operation.
- The production file-backed scan connection is query-only, uses a distinct native SQLite handle and asynchronous worker, and has its own permit; expensive FTS can no longer monopolize the foreground interactive reader via these two APIs. The primary writer is also not used by either API.
- Preserve old behavior for injected/legacy `Database.Interface` fixtures without `withScanDb`. Plain `:memory:` databases intentionally alias primary/reader/scan (a second handle would see a different database).
- This does **not** terminate a pathological scan already executing inside SQLite; it contains the impact to the scan lane and keeps independently admitted control/read operations usable.

## Falsifiable verification [MEASURED]

Added `packages/core/test/session/sqlite-session-recall-lane-isolation-20261011.test.ts`:

- **RED before source change:** fixture throws `interactive SELECT used` from `SessionRecall.indexCoverage`; test exited 1.
- **GREEN after source change:** search + recall use exactly two scan leases, all SQL uses the scan mock, zero interactive queries. Exit 0.
- Together with pre-existing FTS plan tests: `bun test test/session/sqlite-session-recall-lane-isolation-20261011.test.ts test/database/sqlite-fts-recall-permit-regression-20261011.test.ts` => 3/3 PASS.
- Adjacent `sqlite-permit-tracker`, `sqlite-read-worker-scheduling`, `sqlite-control-lane` and the two preceding files: **13/13 PASS**, 85 assertions, 2.71 s, Bun 1.4.3. Read-only enforcement tests intentionally log `SQLITE_READONLY` while PASSing.
- `bun run typecheck` under `packages/core`: exit 0.

## Remaining release gates

- User-visible runtime requires backend restart/deployment of the changed source. Neither a live sidecar restart nor mutation of user databases was attempted.
- The exact historical SQL and the distinct `0bbba6a9` 1,001-byte interactive statement remain unauthenticated. FTS-first hypothesis is supported by source structure and regression, not fingerprint proof against historical SQL.
- Independent native-worker query cancellation/time budgets remain unimplemented; `worker.terminate()` during a synchronous SQLite statement was previously measured unable to guarantee timely abort. A robust solution requires supported SQLite progress/interruption or killable process isolation with transactional recovery. This fix contains scan starvation but does not certify the absence of other slow statements.
- Further certification: file-backed end-to-end OXP multiagent stress with live inspection/reply/interrupt/cancel while running a deliberately slow search, p95/p99 latency measurements, zero 30-second primary/interactive permit timeouts, and actual query-plan evidence in production. No blanket "all SQLite problems solved" claim.

## OXP supervision source path [MEASURED]

A further source trace found that the production OXP `session.search` action bypasses `SessionInspection.search`: `packages/opencode/src/oxp/session.ts` directly called `ExchangeSessionSearch.execute(readDb, ...)`. Fixing `SessionInspection` alone therefore was insufficient for OXP's user-reported failure class.

Surgically changed only the OXP layer's `Database.Service` destructuring and the native `session.search` argument to use `yield* scanDb()` instead of `readDb`. All existing root grants, pre/post authority checks, ranking, output projection and unrelated dirty changes in this shared source were preserved. The scan connection is dedicated, persistent, query-only, worker-backed and independent of the interactive and primary SQLite semaphores. This does NOT assert all other Exchange/OFXP callers have been migrated.

- `bun test test/oxp/session.test.ts test/exchange/session-search.test.ts` from `packages/opencode`: 18/18 PASS, 117 assertions, 6.78s, Bun 1.4.3.
- Untouched Core native-adapter/control tests with the new regression: 13/13 PASS across five files, 85 assertions.
- Core `bun run typecheck`: PASS (exit 0).
- A full OpenFork package typecheck was started separately and its final result must be inspected before claiming a package-wide pass.

**Next source audit:** `ExchangeMemorySession.search` in `packages/opencode/src/exchange/memory-read-runtime.ts` and `memory.ts` still receives `readDb` (both files are preexisting modified/untracked, concurrently owned), and the registration-free OFXP supervision adapter `packages/opencode/src/ofxp/supervision/session-search.ts` uses its injected `deps.db`. Those are distinct boundaries that still require uncontested ownership and their own regression coverage. Do not claim global SQLite-starvation elimination based on OXP-only routing.

### Typecheck qualification and verification boundaries

- `packages/opencode bun run typecheck` completed exit **2** after approximately 80 seconds with existing diagnostics in CLI support-bundle, HTTP handlers, compatibility tests, session tests, swarm tests, and one script environment type. **No diagnostics referenced** `src/oxp/session.ts`, `src/exchange/session-search.ts`, or the new Core scan isolation source. Do not promote this to an OpenFork-wide green typecheck.
- `git diff --check -- packages/core/src/session/inspection.ts packages/opencode/src/oxp/session.ts`: exit 0.
- Changes were left in the existing dirty worktree; no stage, reset, clean, git commit, data-file edit, sidecar restart or user-session interruption.
