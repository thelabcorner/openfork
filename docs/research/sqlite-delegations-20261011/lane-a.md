# Lane A — credential attribution backlog (`ForkCredentials` single-credential backfill)

Claimed: 2026-10-11 (exclusive edit ownership for this lane; no sibling-lane files touched)

## Exclusive write set

- `packages/opencode/src/fork/credentials.ts` (already modified by a concurrent
  contributor before this claim; every pre-existing hunk is preserved read-only)
- `packages/opencode/test/fork/sqlite-credential-backfill-20261011*.test.ts` (new files only)
- This journal (`docs/research/sqlite-delegations-20261011/lane-a.md`)

Explicitly out of scope: `packages/core/src/database/migration.gen.ts`,
`packages/core/src/database/schema.gen.ts`, other generated code, other
contributors' files, other lanes.

## Source-backed problem statement

Direct inspection of `packages/opencode/src/fork/credentials.ts:119-158` (pre-fix):

- `backfillSingleCredentialUsage` runs one unbounded
  `INSERT OR IGNORE ... SELECT ... FROM message` on the primary writer whenever
  `ForkCredentials.list() / active() / credentialsForMessages()` is first called
  with exactly one credential. The scan walks the whole `message` table and
  `json_extract`s every row; on the observed production DB it is the same
  write-path hazard recorded at
  `docs/research/sqlite-historical-reconciliation-2026-10-11.md:36`.
- `singleCredentialUsageBackfillChecked = true` is set before the credential
  read and before the SQL succeeds, process-locally. One interrupted/busy/error
  execution permanently disables retry for the process; nothing durable records
  what (if anything) completed.
- The statement is on the primary writer, so a credential/quota UI read queues
  behind or collides with the writer lane.

## Design (durable incremental migration)

- New fork-owned table `fork_credential_backfill(credential_id PRIMARY KEY,
  cursor_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`, self-bootstrapped
  in this file (no generated migration/schema edits).
- Keyset cursor on `message.id` (TEXT primary key, ULID-style ascending ids):
  each bounded slice scans `WHERE id > cursor ORDER BY id LIMIT N` and advances
  the cursor to the last id *scanned* (matching or not), so no row is skipped
  and no fake forward progress is possible.
- Each slice is one `db.transaction(..., { behavior: "immediate" })`:
  re-check eligibility (exactly one credential) inside the transaction, insert
  `INSERT OR IGNORE` attributions, read `changes()`, then advance the cursor in
  the same transaction. The cursor checkpoints only with an acknowledged
  commit; failures roll back and are retried later (idempotent, monotone).
- Bounded busy retry via `retrySqliteBusyCause` (250 ms budget); a failed slice
  never fails the UI read and never fabricates progress.
- Foreground triggers run at most one bounded slice and only when a read-side
  fast check proves work exists; a coalesced drain (`CoalescedDrain`, layer
  scope) completes the backlog in the background with a fairness pause.
- Single-flight `Deferred` coalesces concurrent triggers; caller cancellation
  never cancels a committed slice and the chunk fiber is owned by the layer scope.
- Multi-credential and zero-credential stores: no writes, no cursor rows.
  Removal deletes that credential's dead cursor row (retention); a surviving/new
  single credential without state restarts from `''` and re-attributes only rows
  still lacking attribution (`OR IGNORE` never overwrites `recordUsage`).
- Cache: `bumpUsageCache()` only when a slice actually inserted rows.

## Milestones

- [x] Ownership journal recorded before any edit
- [x] RED regression (real file-backed WAL, external writer lock, bounded-slice,
      restart, multi-credential, late/out-of-order message, aggregation/cache)
- [x] Source fix in `credentials.ts` with all pre-existing hunks preserved
- [x] GREEN + adjacent fork tests + scoped typecheck
- [x] Results appended below

## Semantics contract implemented

- Coverage law: slices are keyset pages of `message.rowid` (insertion order),
  with `cursor_id` stored as a renumber witness. Every row inserted later has a
  higher rowid, so late imports with ids below the persisted cursor are still
  covered (explicitly tested with `msg_bf_0000` inserted after catch-up).
- Witness handling: missing witness row (history deletion) resumes at the last
  surviving row below it; witness id mismatch (offline VACUUM/rebuild) restarts
  the bounded scan. Both are idempotent under `INSERT OR IGNORE`.
- Each slice is one `BEGIN IMMEDIATE` transaction: eligibility re-check, the
  attribution `INSERT OR IGNORE`, `changes()` accounting, and the cursor update
  commit atomically; failures roll back and re-run from the committed cursor.
- Zero/multi credential stores: no writes, no cursor rows (tested). Removal
  deletes the dead cursor row; the surviving single credential without state
  restarts at rowid 0 and re-attributes only rows still lacking attribution.
- `recordUsage` precedence: direct attribution rows are never overwritten
  (tested with a distinctive `time_created`).
- Cache: `bumpUsageCache()` only when a slice actually inserted rows.
- Foreground cost: indexed read-side checks plus at MOST one committed slice
  (400 rows) under a 250 ms `retrySqliteBusyCause` budget; the coalesced drain
  (`CoalescedDrain`, layer scope) finishes the backlog with a 12 ms pause
  between slices. A caught-up store performs no writer work.

## Executed evidence

Command shape (from `packages/opencode`):
`bun test --preload ./test/lib/effect-timeout-preload.ts --timeout 30000 <file>`

- RED (pre-fix source, 2026-10-11): `sqlite-credential-backfill-20261011.test.ts`
  -> **0 pass / 7 fail**. Evidence: `list()` died under a competing writer with
  the unbounded `INSERT OR IGNORE ... SELECT FROM message`; stdout
  `[lane-a] first list(): 2000/2000 attributed in 10ms`; no
  `fork_credential_backfill` table existed.
- GREEN (post-fix): same file -> **8 pass / 0 fail, 52 expect() calls**.
  Metrics: `list()` under external writer lock resolved in **305 ms** (bounded by
  the 250 ms busy-retry budget); first trigger on a 2000-message history
  `800/2000 in 9 ms`; steady-state `list()` after catch-up **2 ms**; concurrent
  triggers all resolved with `cursor=msg_bf_000599`; restart resumed from
  durable `cursor=msg_bf_000799` and completed 1500/1500.
- Adjacent fork tests: `credentials.test.ts` **9/9**, `usage-aggregation.test.ts`
  **4/4**, `usage-cache.test.ts` **14/14**, `usage-official-percent.test.ts`
  **5/5** (combined run 36 pass / 0 fail / 1328 assertions, plus aggregation 4/4).
- Scoped typecheck (`tsgo`, packages/opencode): `fork/credentials.ts` and the new
  test file report **no diagnostics**. Remaining program diagnostics are
  pre-existing errors in other contributors' dirty files (`src/image/image.ts`,
  `handlers/global.ts`, `handlers/session-read.ts`, `tool/shell.ts`,
  `tool/archive/*`); none were touched.

## Supervisor review A dispositions

1. `ensureMigrated` early flag: fixed. `migrationChecked = true` now happens only
   after a successful decision (existing credential, no legacy key, or imported
   key) and never on a failed/locked attempt; single-flight `Deferred` prevents
   duplicate imports. Regression test "a failed legacy auth migration is retried"
   is green. Documented behavior: a successful no-op stays final per process
   (matching prior semantics); auth.json keys added later are not re-imported
   because the fork store is the live key path.
2. Out-of-order cursor skip: replaced the id keyset with insertion-ordered rowid
   pages plus an id renumber witness; explicit test inserts `msg_bf_0000` (id
   below the cursor) after completion and requires attribution; cursor/witness
   deletion and VACUUM-renumber recovery are implemented and commented. No claim
   is made that arbitrary external rewrites are covered; restart-on-mismatch is
   the documented boundary.
3. Uncertain COMMIT replay: documented as convergent, not ambiguous. Writes are
   keyed-idempotent (`INSERT OR IGNORE`, conditional cursor advance), a failed
   COMMIT leaves the transaction uncommitted and Drizzle rolls it back, and a
   replay re-reads the durable cursor before writing; only SQLITE_BUSY-class
   causes reach the retry boundary (non-busy failures fail immediately).
4. Boot DDL / migration ownership: the third `CREATE TABLE IF NOT EXISTS`
   follows the file's pre-existing fork-owned self-bootstrap policy (module doc);
   no `migration.gen.ts`/`schema.gen.ts` or other generated code was edited.
   It is one idempotent statement per layer build, not per UI call; no claim of
   zero writer overhead is made. Residual gate: a future consolidated fork-owned
   migration owner may replace the three self-bootstrapped tables.
5. Foreground comment corrected to the real bounded cost (indexed checks + at
   most one 400-row slice under a 250 ms busy budget; background drain handles
   the rest), with measured 2 ms steady-state and 9-11 ms first-slice figures.

## Remaining gates (not closed here)

- No live sidecar activation/deployment; source + disposable-file verification
  only. Packaged Electron/ACP runs and 25-100 real concurrent sessions remain.
- Rowid-cursor boundary: offline full-file VACUUM/rebuild is recovered by rebuild
  detection, but the live DB itself was never compacted or inspected offline.
- The `usage-aggregation` blocked-writer regression was caused by the first
  `ensureMigrated` draft (primary `count(*)` re-read on every call) and is now
  green; no other-owned test file was modified.
