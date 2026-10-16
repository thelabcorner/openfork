# Lane D — read-side attribution + maintenance reconciliation

Owner: DeepSeek V4.1 Flash lane D (explicit user delegation, 2026-10-11).
Status: **evidence complete for delegated scope; no source edit made** (see blockers).

Exclusive file ownership claimed by this journal:

- `packages/core/test/database/sqlite-long-read-attribution-20261011.test.ts` (new)
- `packages/opencode/test/ofxp/sqlite-supervision-read-20261011.test.ts` (new)
- `docs/research/sqlite-delegations-20261011/D-read-maintenance.md` (this file)

Other lanes' journals are READ ONLY. No other lane may patch the three paths above.
This lane did not stage/commit, reset/clean/stash, or touch generated migration
files, user databases, or live sidecar/ACP lifecycle.

## Per-test results (host-free, disposable fixtures)

Command: `bun test test/database/sqlite-long-read-attribution-20261011.test.ts` (packages/core, Bun 1.4.3)

| Test | Result |
| --- | --- |
| real scan worker records fiber origin, shape and hash for a slow statement, never SQL text | PASS |
| safe plan summary uses its own synthetic tag and drops identifiers and literals | PASS |
| every rendered SessionSearch/SessionRecall read statement is distinct from both fingerprint templates | PASS |
| paged read outlives per-statement deadline, two readers independent, admission bounded, runaway recovers | PASS |
| planner/checkpoint maintenance bounded behind held foreground writer | PASS |
| Node source adapter (`sqlite.node.ts`): runaway killed at deadline, next read recovers | PASS |

**6/6 PASS, 58 expect() calls, ~5.3s.** Combined adjacent interlock run (this file +
`sqlite-runaway-plan`, `scan-reader-admission-timeout-20261011`, `default-scan-concurrency-20261011`,
`sqlite-maintenance`, `checkpoint-maintenance`, `sqlite-planner-maintenance`): **16/16 PASS, 102 assertions, 6.4s.**

Command: `bun test test/ofxp/sqlite-supervision-read-20261011.test.ts` (packages/opencode)

| Test | Result |
| --- | --- |
| pooled scan lease serves rooted supervision search; primary/interactive untouched | PASS |
| pinned pooled long read does not delay supervision search or interactive history lane | PASS |

**2/2 PASS, 12 expect() calls, ~6.7s.** Existing `test/ofxp/session-search.test.ts` re-run: **3/3 PASS**
(no regression from shared-worktree state).

Host: Windows, Bun 1.4.3 (c6da4a4d3), effect 4.0.0-beta.83, drizzle effect 0.44.x. All fixtures are
uniquely named temp DBs (`openfork-lane-d-*`, `opencode-test-*`); none is a user database. Expected
`ERROR` log lines during the runs are the intentional `SqliteScanDeadlineExceeded`/`SQLITE_SCAN_DEADLINE`
kill paths, not failures.

## Typecheck evidence

- Scoped `tsgo` on both new files: **0 errors**.
- Exact Core package typecheck (`bun run typecheck` = `tsgo --noEmit`): **11 errors, 0 in lane D files.**
  All 11 are in sibling lane B's untracked `test/oxp-activity-sqlite-link-recovery-20261011.*` files
  (activity links are B's ownership). Lane D adds no typecheck error.
- OpenCode package typecheck includes pre-existing ambient errors in other dirty files
  (`src/image/image.ts` wasm module, `tool/shell.ts` wasm modules, `tool/archive/*` seek-bzip,
  `server/.../session-read.ts` brand variance); none is in the lane D file.

## Findings

1. **OFXP supervision call path is distinct from OXP and currently unregistered.**
   `OfxpSessionSearch.execute` (`packages/opencode/src/ofxp/supervision/session-search.ts:51`) has
   **zero production dispatcher callers** (bounded `rg` over `packages/opencode/src`). `ofxp/runtime.ts`
   advertises planes `["augmentation","supervision","delegation","messaging"]` but sets
   `supervision: false`; no wire method/feature is registered. The adapter cannot be the origin of the
   live incident SQL. Its read lane is entirely caller-supplied `deps.db`.
   The wired OXP sibling (`packages/opencode/src/oxp/session.ts:559`) leases
   `withScanDb(runSearch)`; native `tool/session.ts` uses `readDb`.

2. **Real read-lane trace (bounded traversal).** `scanDb/withScanDb` consumers: `exchange/memory.ts`,
   `exchange/memory-read-runtime.ts`, `usage/zen-free.ts`, `usage/usage.ts`, `session/context/inspection.ts`
   (interactive budget 3 pages, then scan), `session/context/totals.ts`, `fork/credentials.ts`
   (analytics only), `oxp/session.ts`. Remaining primary `db` SELECTs found in the audit are bounded:
   PK lookups or pre-write verification (`session.ts` group-anchor walk capped at depth 64,
   `exchange/memory-evidence.ts` verification before a write, account/project metadata). No unbounded
   primary/interactive SELECT call path was found in the audited surface.

3. **Attribution is real and privacy-safe, with one allowlist gap.** A real subprocess statement under
   an application span records `sqlOrigin=Search.sessions`, `sqlHash/sqlLen/sqlShape`, oldest in-flight
   RPC, owner fiber, held ms, `pending`, and worker stage, with no SQL text/table/literal. The
   `sqlite-query-origin.ts` allowlist has no `Ofxp*`/`Exchange*` prefix, so OFXP supervision reads
   would resolve to `origin=unknown` once a dispatcher exists.

4. **Killable deadline vs legitimate large reads is reconciled by row paging.** Per-statement budget
   applies per statement, never per lease: five paged statements with deterministic 250ms gaps
   (cumulative > one 800ms budget) all succeed inside the same pooled reader; with two readers pinned,
   a third admission fails bounded (~120ms) without releasing either lease; a genuine runaway is
   killed with an explicit `SQLITE_SCAN_DEADLINE` and the same pooled reader recovers on the next read.
   Identical deadline/recovery holds for the `sqlite.node.ts` source adapter.

5. **Production read SQL is authenticated distinct from the incident templates.** 18 rendered
   `SessionSearch`/`SessionRecall` statements (recent+relevance; multi-root `directoryPrefixes`,
   query+tool, tool-only scoped, tool-only global) all return `undefined` from
   `sqlitePlanProbeFingerprint`. This is candidate matching against the fixed length+hash pair only:
   no fingerprint reversal and no synthetic query is ever labeled as `c2b111a6`/`0bbba6a9`.

6. **Low-priority maintenance stays bounded.** `optimizePlannerStats` and `checkpointWal` complete
   (<3s each) while the primary connection holds `BEGIN IMMEDIATE` + INSERT, on separate
   connections with zero busy timeout and cross-process flocks; the same calls succeed after commit.
   Read-only audit of `oxp-activity/retention.ts`: cap 16,384 rows / 14 days, 256-row batches,
   2,048 rows max per pass, `projectHistoricalContext` before delete, quiet-gated (`PRAGMA
   data_version`), flock-gated, separate backfill connection. No defect proven.

## Owner-ready contracts / exact blockers

1. **Exact blocker for a source fix in read provenance:** all instrumentation files that would need a
   change (`sqlite-query-origin.ts`, `sqlite-permit-tracker.ts`, `sqlite-query-forensics.ts`,
   `sqlite-scan-process.ts`, `scan-read-pool.ts`, `sqlite.bun-worker.ts`, `database.ts`) are dirty or
   untracked concurrent work owned by the overhaul lane; `oxp-activity/activity.ts` is sibling lane B's
   (explicit supervisor correction). Lane D is limited to its two new test files and this journal.
   Proposed patch (NOT applied): add `Ofxp[A-Za-z0-9]*` (and review `Exchange[A-Za-z0-9]*`) to the
   `safeOperation` allowlist in `sqlite-query-origin.ts`, with a positive `OfxpSessionSearch.execute`
   span test and the existing negative privacy tests retained.
2. **Future OFXP dispatcher contract:** any registered OFXP supervision `session.search` execution must
   lease `withScanDb` (or an equivalent independent read lane), never the primary or interactive
   connection, and must keep root authority revalidation after the read before egress. The adapter does
   not and cannot enforce this itself; it is caller-owned.
3. **Retention starvation proposal only:** the quiet gate legitimately blocks while another connection
   commits; a continuously-writing host can defer retention indefinitely by design. If bounded eventual
   progress is required, the owning lane should decide an explicit per-pass gate attempt budget. Not
   patched here (ownership).
4. **Live proof remains outstanding:** this is host-free evidence. The installed desktop/sidecar was not
   restarted or observed (`runtime.refreshable=false`); no live-database claims are made.

## Nonlive proof

All SQL executed against disposable temp-file SQLite fixtures created and deleted by the tests
(`openfork-lane-d-*`, `opencode-test-*`). No user DB path, no account token, no secret was read or
written. Subprocesses were real (`SqliteScanProcessClient`, `sqlite.node.ts` scan process) and all
were closed by test scopes before fixture removal; no orphan was observed by the exit-barrier/close
paths.
