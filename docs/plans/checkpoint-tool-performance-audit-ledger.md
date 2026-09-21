# Checkpoint Tool Architecture + Performance Audit Ledger

Date: 2026-09-18
Scope: `packages/opencode/src/tool/checkpoint.ts` and the minimum authoritative/shared services, schema, snapshot, Git, and tests required to make that tool architecturally correct and maximally efficient.

## Governing constraints

- Preserve the heavily dirty/concurrent worktree. No reset, stash, restore, clean, rebase, or unrelated rewrite.
- Respect existing in-progress checkpoint edits. At audit start, `packages/opencode/src/tool/checkpoint.ts`, `packages/opencode/src/session/checkpoint.ts`, and `packages/opencode/test/session/checkpoint-tool.test.ts` already contain unrelated Git/EOL-policy work replacing raw `Bun.$ git` subprocesses with the shared `Git.Service`.
- OpenFork V1/fork tooling is the production target. Current/Core semantics are the reference/shared-owner layer where appropriate; do not migrate the tool to a current API merely for upstream parity.
- Architecture before call sites: authoritative producer/storage -> owning domain service -> narrow projection -> V1 tool renderer.
- Performance closure requires measured before/after behavior plus negative invariants, not only a microbenchmark.

## User-facing contract that must remain true

- `list`: current/session timeline, optionally a selected session or worktree breadth.
- `search`: cross-worktree checkpoint discovery by free text and/or touched path.
- `view`: one checkpoint.
- `diff`: turn or session cumulative filesystem diff.
- `restore`: dry-run by default; explicit confirmation + permission before mutation; cross-session restore requires checkpoint ID.
- Restore changes filesystem state only; conversation history and user's source Git repository semantics remain untouched.

## End-to-end ownership trace

Current path:

```text
session turn / restore producer
  -> session_checkpoint durable rows (Core schema)
  -> packages/opencode/src/tool/checkpoint.ts reads Database directly
  -> JS filtering / searching / truncation
  -> Snapshot + Git services for diff/restore
  -> tool XML-ish output
```

Desired review target:

```text
session_checkpoint durable rows
  -> authoritative checkpoint query/projection owner
  -> bounded/index-backed query shaped for list/search/resolve
  -> V1 checkpoint tool formatting only
```

The tool is allowed to orchestrate Tier-3 restore mechanics, but should not own durable checkpoint query semantics or reconstruct small projections by hydrating every retained checkpoint payload.

## Baseline findings

### F1 — unbounded full-row hydration on list/search (OPEN, high priority)

`sessionRows()` and `worktreeRows()` both use `select().all()`. A checkpoint row includes the JSON `diff`, `excluded`, and `error` payloads. The tool then filters and slices in JavaScript.

Consequences:
- list cost scales with total checkpoints in the session/worktree, not requested `limit`;
- every row's JSON diff may be decoded even though list rendering needs at most a tiny path sample;
- status/kind predicates are applied after hydration instead of by SQLite;
- worktree ordering/filtering does not currently have a matching epoch index;
- memory/GC and SQLite->JS transfer scale with retained history.

### F2 — checkpoint ID resolution scans the entire checkpoint table (OPEN, high priority)

`resolveTarget(checkpointID)` executes `select().from(SessionCheckpointTable).all()`, then matches exact-or-prefix in JS. Exact ID is the primary key and should be O(log N)/indexed. Prefix lookup should be a bounded SQL prefix query with ambiguity detection, not a full-table materialization.

### F3 — session prefix resolution scans every session (OPEN, high priority)

`resolveFrom()` executes a full Session table ID read and prefix-filters in JS. Exact IDs should use the primary key; prefixes need only enough rows to prove 0/1/ambiguous (plus a bounded candidate sample for the error).

### F4 — repeated queries duplicate work (OPEN)

Examples:
- search loads session metadata once for filtering and again for the limited result set;
- zero-result list/search can re-run `sessionRows` and/or `worktreeRows`;
- session list loads all rows, then separately reloads all worktree rows only to count foreign sessions/checkpoints;
- restore loads all worktree rows to compute sibling-session IDs.

These should become direct aggregate/projection queries, not repeated payload hydration.

### F5 — Core already owns checkpoint semantics, but V1 tool bypasses it for reads (OPEN, architecture)

`packages/core/src/checkpoint.ts` is the shared durable checkpoint service, including get/list/diff and snapshot epoch semantics. The V1 tool imports the Core DB/table directly and independently implements resolution/search/list semantics.

Need to decide whether:
1. Core checkpoint service should gain bounded query/projection methods usable by V1, or
2. a narrower shared query service should own read/search projections.

Do not merely micro-optimize the current raw-DB call sites if doing so preserves duplicated semantic ownership.

### F6 — existing indexes are insufficient for worktree search/order (OPEN)

Current `session_checkpoint` indexes:
- `session_id`
- `(session_id, ordinal)`
- unique `(session_id, user_message_id)`

The tool's worktree query is `WHERE epoch=? ORDER BY created_at DESC`; there is no `(epoch, created_at)` index. Query-plan and write-amplification measurements are required before adding one.

### F7 — list rendering unnecessarily walks complete diff arrays (OPEN)

`renderRow` maps the entire cached diff to paths only to show the first three and a count. Even after bounded row queries, large per-checkpoint diffs make this O(files changed) per displayed row. The durable row already contains `files`, but not a first-path projection.

Need benchmark evidence before deciding whether to:
- extract only first 3 JSON paths in SQLite (JSON1), or
- persist a compact path/search projection at finalize time, or
- accept decode cost under a proven bound.

### F8 — diff mode bypasses the shared Core checkpoint diff cache (OPEN)

The Core `Checkpoint.Service.diff` has a bounded content-addressed LRU over immutable tree pairs. The V1 tool directly calls V1 `Snapshot.diffFull`, so repeated `checkpoint diff` calls may recompute Git diffs. Need compare V1/Core snapshot compatibility and decide the lowest shared owner before changing this.

### F9 — restore deletion loop is serial (OPEN, lower priority until measured)

Restore deletes `willDelete` files one-by-one with sequential `fs.rm`. For a large rollback this creates N serialized filesystem awaits before checkout-index. Bounded parallel deletion may reduce restore latency, but correctness/race behavior must be proven and restore is not the common read hot path.

### F10 — concurrent unfinished schema work already points at the correct read model (DISCOVERED; do not overwrite)

While auditing the dirty worktree, `packages/core/src/session/sql.ts` was concurrently modified after the initial read. It now contains:

- candidate `session_checkpoint_epoch_created_idx(epoch, created_at)`;
- candidate `session_checkpoint_file(checkpoint_id, ordinal, path)` compact path projection;
- comments explicitly stating that list/search/view must not hydrate patch bodies just to answer path queries.

This is directionally identical to F1/F6/F7 and therefore strong architectural convergence, but it is not yet wired into the tool and no migration/trigger implementation is currently discoverable in the worktree. Treat it as concurrent in-progress work owned by another campaign unless/until coordinated; do not duplicate or overwrite it.

### F11 — interactive checkpoint reads use the writer connection despite a dedicated query-only reader (OPEN, high priority)

`Database.Service` exposes `readDb` specifically for interactive/history reads so WAL readers do not queue behind the foreground connection's single permit. `checkpoint.ts` destructures `db` and performs all list/search/view/resolve reads through it. Read-only checkpoint operations should use `readDb`; restore's durable mutations remain owned by `TurnCheckpoint.Service` / the writer path.

This is both an AGENTS ownership violation and a tail-latency issue under concurrent checkpoint finalization or other writes.

Resolution started: the V1 checkpoint tool now binds its read queries to `Database.Service.readDb`. Focused checkpoint-tool integration tests remain green. Writer/mutation ownership is unchanged.

### F12 — ordinal resolution hydrates an entire session to answer one point lookup (OPEN)

`resolveTarget(... ordinal ...)` currently calls `sessionRows(sessionID)`, materializes all full rows/diffs, then `.find()`. The selected row should be fetched directly by `(session_id, ordinal)`, which is already indexed. The only reason to read additional rows is the human-facing "valid ordinals" error; that should be a compact ordinal-only projection and only on a miss.

### F13 — search semantics need a true bounded path projection before SQL pushdown (BLOCKED ON F10)

Search currently matches free text against:
- checkpoint ID/message IDs;
- session title/agent;
- every diff path;
- optional touched-path suffix.

Pushing only status/kind/limit into SQL is unsafe because the path/title predicates can reject early rows and change result semantics. The correct fix is the compact checkpoint-file projection discovered in F10, joined to session metadata, followed by a bounded query. Do not introduce an arbitrary over-fetch multiplier as a fake bound.

### F14 — session cumulative diff only needs the first checkpoint boundary (OPEN)

`diff scope:"session"` calls `sessionRows(row.session_id)` and hydrates every checkpoint/diff only to read `rows[0].before_snapshot ?? rows[0].after_snapshot`. Replace with a one-row projection ordered by ordinal ascending, selecting snapshots only.

### F15 — footer/sibling discovery is payload-amplified (OPEN)

- list(session) loads every worktree checkpoint to count foreign checkpoints and distinct foreign sessions;
- restore loads every worktree checkpoint to build a distinct sibling-session ID list.

Both are compact SQL aggregate/distinct projections over `epoch/session_id`; neither needs checkpoint diff JSON.

### F16 — output cap counts UTF-16 code units, not bytes (OPEN correctness/performance)

`maxBytes` is documented as bytes, but `renderPatches` uses JS `.length` and `.slice()`. Unicode patches can therefore exceed the requested byte budget. A byte-accurate truncator should avoid repeatedly encoding whole accumulated output; use a bounded UTF-8 helper/encoder and preserve valid code-point boundaries.

### F17 — V1 checkpoint producer caches patch bodies in SQLite, creating read/write/storage amplification (RESEARCH)

`TurnCheckpoint.finalizeInner` computes full per-file patches, truncates each patch to `MAX_CACHED_PATCH_BYTES`, and stores the mapped patch-bearing diff JSON in `session_checkpoint.diff`. Yet the tool recomputes full diffs from immutable trees for `mode:"diff"`, while list/search/view mostly need paths/stats.

This means cached patch text may currently pay:
- background CPU/string construction already required by `diffFull`;
- SQLite writer bytes/WAL growth;
- database/ChunkDB physical storage;
- JSON decode/memory whenever full rows are hydrated;

without serving the expensive full-diff read path. The compact path projection in F10 could permit a larger architectural change: durable checkpoint metadata + path/stat projection, with patch bodies derived on demand from retained immutable trees. Must audit all consumers and retention/GC guarantees before changing persisted compatibility.

**Concurrent convergence discovered:** another in-progress checkpoint change has already introduced V1 `Snapshot.diffSummary(from,to)` and changed `TurnCheckpoint.finalizeInner` to persist the same compatible diff shape with empty `patch` strings. This removes blob reads/unified-patch synthesis from every background finalize while retaining path/status/stat metadata. This exactly addresses the producer half of F17; audit/tests/benchmarks must now verify parity and quantify it rather than reimplementing it.

### F10 — checkpoint reads use the foreground writer connection instead of `readDb` (OPEN, high priority)

`Database.Service` explicitly owns a second persistent query-only SQLite connection for interactive/history reads so they do not queue behind the foreground connection's single permit while another transaction is writing. The checkpoint tool currently captures `database.db` and routes all list/search/view/target-resolution reads through it.

This is exactly the read-latency class `readDb` exists to solve. Mutation continues to belong to the owning writer services; tool inspection queries should use `readDb`.

### F11 — durable V1 checkpoint rows cache patch bodies that the tool does not consume (OPEN, potentially largest storage/write win)

V1 `TurnCheckpoint.finalizeInner` persists one diff entry per file including `patch`, truncating each patch independently at 256 KiB. That is *not* a bounded checkpoint-level metadata budget: a turn touching N files can persist roughly N × 256 KiB of patch text.

The checkpoint tool:
- uses cached `diff` only to recover paths for list/search/view;
- recomputes full turn/session patches from immutable snapshot trees in `mode:"diff"`;
- computes restore preview from snapshot trees as well.

Current direct consumers found by source audit only require cached diff paths/cardinality in V1 checkpoint tests/tool plus Core's generic checkpoint row shape. No tool path was found that requires the persisted patch bodies. Before changing the durable shape, verify all HTTP/UI/current-runtime consumers and compatibility expectations. If no consumer requires cached patches, persist a compact checkpoint file summary and regenerate patches on-demand.

### F12 — JSON scanning is still the wrong search primitive for rare path/text lookup (OPEN, architecture)

Pushing `touchedPath` into SQLite with `json_each(diff)` bounds returned rows but still parses historical diff JSON row-by-row until a match. A synthetic 20k-row benchmark below measured ~395 ms median for a rare path even after the worktree ordering index existed.

FTS5 is already an established repository mechanism for session search. A synthetic FTS5 trigram projection of checkpoint paths measured ~0.12 ms median for the same rare substring lookup (~3,290× faster than JSON scanning in that fixture). If checkpoint search is intended as a durable/high-cardinality feature, producer-owned search text + FTS (or an equivalent normalized path index) is the correct frontier rather than repeated JSON scans.

### F13 — V1 snapshot diff generation is already internally batch-optimized (CLOSED / no local rewrite)

`Snapshot.diffFull` uses:
- one name-status pass,
- one numstat pass,
- `git cat-file --batch` to retrieve before/after blobs,
- chunks of 100 files,
- per-file `git show` only as fallback.

Do not replace it with a naive per-file Git loop. Repeated immutable-tree diff caching remains a separate question.

## Existing concurrent changes to preserve

At ledger creation, another campaign has already changed checkpoint/session restore Git subprocesses to use shared `Git.Service` for deterministic repository EOL/process policy. This audit must build on that diff rather than replacing/reverting it.

## Measurement plan

1. Capture SQLite query plans for current session/worktree/list/ID-resolution query shapes.
2. Build a focused synthetic benchmark with checkpoint counts and diff payload sizes representative of long-lived sessions/worktrees.
3. Measure:
   - wall time,
   - rows and payload bytes materialized into JS where observable,
   - heap/GC deltas where stable enough,
   - query-plan index usage,
   - 1 / 3 / 6 concurrent tool reads if shared DB contention is measurable.
4. Benchmark exact ID, prefix ID, session list, worktree list, touched-path search, free-text search, diff repeat, and restore preview separately.
5. Apply architecture changes only after the owner/query shape is explicit.
6. Re-run focused checkpoint tests, scoped typecheck, and performance benchmark.

## Synthetic query benchmark — 2026-09-18

Harness:
- Bun 1.3.14 / SQLite 3.53.0
- in-memory SQLite
- 20,000 checkpoint rows across 50 sessions
- 10 diff entries/checkpoint
- 512-byte synthetic patch body per diff entry
- current session indexes reproduced
- 90% of rows in one worktree epoch
- median of warm repeated reads

Results:

| Query shape | Median |
| --- | ---: |
| Current session list: hydrate+JSON-decode all rows for session, then slice 50 | 3.923 ms |
| Projected session list: scalar columns + first 3 JSON paths + `LIMIT 51` | 0.115 ms |
| Current worktree list: hydrate+JSON-decode all epoch rows, then slice 50 | 466.466 ms |
| Projected worktree list, **without** epoch/order index | 86.725 ms |
| Projected worktree list with `(epoch, created_at DESC)` index | 0.259 ms |
| Current exact checkpoint ID: hydrate/decode whole table, JS find | 182.536 ms |
| Indexed exact checkpoint ID lookup | 0.010 ms |
| SQL `json_each` rare touched-path scan | 394.878 ms |
| FTS5 trigram rare touched substring | 0.120 ms |

Relative improvements in this fixture:
- bounded projected session list: ~34× faster;
- bounded indexed worktree list: ~1,801× faster;
- indexed exact checkpoint lookup: ~18,254× faster;
- FTS trigram rare path lookup vs JSON scan: ~3,291× faster.

Query-plan proof:
- session list already uses `session_checkpoint_session_ordinal_idx`;
- current worktree shape is `SCAN session_checkpoint` + `USE TEMP B-TREE FOR ORDER BY`;
- adding `(epoch, created_at DESC)` changes it to indexed `SEARCH session_checkpoint ... (epoch=?)`;
- exact ID lookup uses the primary-key index.

These numbers are mechanism proof, not production latency claims. They justify removing O(total-history) hydration and adding the missing worktree ordering index. Production closure still requires the real Effect/Drizzle/readDb path.

## Negative invariants for closure

- `limit: N` list/search must not hydrate O(total checkpoint count) full checkpoint rows.
- Exact checkpoint ID resolution must not scan the checkpoint table.
- Exact session ID resolution must not scan the Session table.
- Worktree footer/sibling counts must not hydrate checkpoint diff payloads.
- Repeated diff of the same immutable tree pair should not pay avoidable recomputation if a shared cache can own it safely.
- No change may weaken restore safety, worktree epoch checks, permission gates, checkpoint provenance, or shared Git/EOL policy.
- No new unbounded in-memory cache or duplicated durable-state reconstruction in the tool.

## Audit log

- 2026-09-18: Read root/package/test AGENTS rules and V1/current architecture map.
- 2026-09-18: Inspected current checkpoint tool, Core checkpoint owner, checkpoint schema/indexes, checkpoint contract docs, tests, and pre-existing Git-service diff.
- 2026-09-18: Recorded F1-F9. Next: prove query costs/plans and inspect snapshot/diff compatibility before selecting the shared owner.
- 2026-09-18: Found Database `readDb` ownership contract; checkpoint tool is incorrectly reading through the foreground writer connection (F10).
- 2026-09-18: Audited V1 snapshot diff implementation; it is already batch-oriented and should not be locally rewritten (F13).
- 2026-09-18: Ran 20k-row synthetic SQLite/Bun query benchmark. Confirmed unbounded hydration, missing epoch/order index, and all-table ID resolution are severe scaling defects. FTS5 trigram prototype decisively beat JSON path scanning for rare lookup. Temporary benchmark file was removed after measurement.
- 2026-09-18: Found persisted patch bodies in V1 checkpoint rows despite on-demand snapshot rediff; opened F11 and began full consumer audit before changing durable semantics.
- 2026-09-18: SQLite 3.53 query-plan probe proved the existing `(session_id, ordinal)` index can satisfy bounded per-session reverse-ordinal reads directly. The current worktree shape `epoch + created_at DESC` performs a full table scan plus temporary B-tree sort; a synthetic `(epoch, created_at DESC)` index changes that to an index search with no temp sort.
- 2026-09-18: Bun/SQLite synthetic cost probe (20k rows, 100 sessions, 20-entry JSON diff payload) measured ~0.415 ms/call for current full-row per-session hydration versus ~0.026 ms/call for a bounded projection (~16x), and ~42.0 ms/call for current full-table checkpoint-ID resolution versus ~0.002 ms/call for primary-key lookup (~21,000x). These are synthetic directional measurements, not production latency claims.
- 2026-09-18: V1 `Snapshot.diffFull` is already substantially optimized internally: two metadata Git diffs plus batched `git cat-file --batch` in chunks of 100, with per-file `git show` only as fallback. Core Snapshot is a separate implementation/shadow repository, so the Core Checkpoint diff LRU cannot simply be imported into the V1 tool without crossing snapshot ownership. Any repeated-diff cache belongs at the V1 Snapshot owner if measurements justify it.
- 2026-09-18: Discovered concurrent checkpoint schema work adding the exact epoch/order index and a compact checkpoint-file projection. No corresponding migration/trigger is currently discoverable. Recorded as F10 and will not overwrite it.
- 2026-09-18: Database architecture audit found the tool uses the foreground writer connection for every read despite `Database.Service.readDb` being explicitly dedicated to latency-sensitive interactive/history reads. Recorded as F11.
- 2026-09-18: Changed checkpoint tool read queries to `Database.Service.readDb`. Focused checkpoint-tool suite: 7 pass / 0 fail. Package typecheck currently fails only in unrelated dirty `script/spad-repo-null.ts` (missing/runStart/runEnd shape mismatch); no checkpoint-related type error was reported.
- 2026-09-18: Re-derived target/search semantics and recorded F12/F13. Search cannot be correctly bounded by naively adding LIMIT before its path/title filters; the compact path projection is the architectural prerequisite.
- 2026-09-18: Implemented indexed point resolution for checkpoint ordinal and checkpoint/session IDs. Ordinal miss/help now reads only ordinal scalars instead of full checkpoint payloads. Focused checkpoint-tool suite remains 7/7 green.
- 2026-09-18: Continued hot-path trace through diff/restore/finalize; recorded F14-F17, including the potentially larger finding that persisted patch bodies may be pure storage/WAL/read amplification because user-facing full diff is recomputed from retained trees.
- 2026-09-18: Scoped diff inspection confirmed concurrent work has already implemented the F17 producer optimization via `Snapshot.diffSummary` and empty persisted patch bodies. Preserve it and shift this audit toward proof, read-model completion, and remaining tool costs.
- 2026-09-19: Provenance campaign found and repaired a producer race in
  `TurnCheckpoint.begin()`: finalization wait, allocation/reopen, and
  process-local `active` registration are now one per-Session locked ownership
  transition. A 16-way same-root begin regression returns one checkpoint handle.
- 2026-09-19: Re-derived retained-tree ownership. Hash-only
  `refs/opencode/retained/<tree>` was unsound because multiple checkpoint rows
  can reference the same tree and one release could unpin another row. Retention
  is now owner-scoped as
  `checkpoint/<checkpoint-id>/<before|after>/<tree>`; Core snapshot proof shows
  identical trees survive independent owner release.
- 2026-09-19: Same-root reopen now preserves the previous committed
  `after_snapshot` while status is `capturing`, and replacement follows
  retain-new → durable CAS → release-old. This preserves recoverability across a
  crash/interruption before replacement finalize.
- 2026-09-19: Added bounded owner-ref reconciliation for crash-created stale/orphan
  pins. It pages Git refs, batch-loads only referenced checkpoint owners, preserves
  all refs for in-flight `capturing` rows, and prunes stale refs after
  settlement. Maintenance is scoped to `InstanceState`; it does not keep a
  global detached `InstanceRef`.
- 2026-09-19: V1 checkpoint producer suite is 11/11 green with a 30s per-test
  ceiling (48.9s total in the Git-heavy fixture). Core snapshot suite is 5/5
  green. The earlier 5s failures were fixture wall-clock ceilings, not semantic
  failures.

## Measured evidence

### Query-plan probe

`session_id + ordinal DESC + LIMIT`:

```text
SEARCH cp USING INDEX (session_id, ordinal) (session_id=?)
```

`epoch + created_at DESC + LIMIT` with current schema:

```text
SCAN cp
USE TEMP B-TREE FOR ORDER BY
```

With candidate `(epoch, created_at DESC)`:

```text
SEARCH cp USING INDEX (epoch, created_at) (epoch=?)
```

### Synthetic Bun/SQLite timing probe

Dataset: 20,000 checkpoints / 100 sessions / 20-entry JSON diff per row.

| operation | current shape | bounded/indexed shape | directional delta |
| --- | ---: | ---: | ---: |
| per-session read | 0.415 ms | 0.026 ms | ~16x faster |
| exact checkpoint ID | 42.039 ms | 0.002 ms | ~21,000x faster |

The exact magnitudes depend on retained history and payload size. The architectural result does not: O(total history) hydration for an exact primary-key lookup is categorically the wrong cost model.


## Measured baseline — synthetic SQLite mechanism benchmark (2026-09-18)

Environment: Bun 1.3.14, bundled SQLite 3.53.0. Synthetic table mirrors the persisted checkpoint columns and existing indexes. Dataset: 24,000 checkpoints across 12 sessions; 19,200 rows in the queried epoch; 16 file-diff entries per checkpoint; representative diff JSON ~2,692 bytes/row.

Median results:

- Current worktree list shape (SELECT * for whole epoch + ORDER BY + JS slice/render): 199.208 ms before epoch index; 46.024 ms even after adding the epoch index.
- Bounded scalar/path projection with LIMIT 50: 89.511 ms before epoch index; 0.197 ms with (epoch, created_at DESC).
- Current checkpoint-ID resolution (SELECT * all rows + JS find): 53.990 ms.
- Exact checkpoint primary-key lookup: 0.004 ms.
- Current worktree-footer hydration: 193.409 ms before epoch index; 47.146 ms after.
- SQL aggregate footer: ~9.7-10.4 ms in this shape; still improvable because COUNT(DISTINCT session_id) is not covered by the epoch/order index.

Query-plan proof before the new epoch index: SCAN session_checkpoint + USE TEMP B-TREE FOR ORDER BY. After (epoch, created_at DESC): SEARCH session_checkpoint USING INDEX session_checkpoint_epoch_created_at_idx (epoch=?), with no temp sort.

At this dataset size the current worktree query transfers about 19,200 * 2,692 = 51,686,400 bytes (~49.3 MiB) of raw diff JSON alone before JS object/decoded-string overhead, even when the caller asks for 50 rows.

Interpretation: F1/F2/F6 are proven mechanism-level bottlenecks. The index alone is not sufficient: SELECT * remains ~46 ms because payload hydration dominates after sorting is fixed. The architecture needs both bounded/projection queries and the matching worktree index.

## Actual Core ReadService closure benchmark — 2026-09-19

The synthetic mechanism proof has now been followed by a file-backed, migrated,
Effect/Drizzle benchmark through the actual process-global `Checkpoint.ReadService`.

Fixture:
- 10,000 durable checkpoints / 50 sessions;
- 8 diff paths/checkpoint;
- 90% of rows in the queried epoch;
- real `Database.layerFromPath` with WAL + dedicated `readDb`;
- real migration triggers maintaining `session_checkpoint_search` + trigram FTS;
- real Drizzle/Effect service calls rather than raw SQLite-only probes.

Final production-path medians:

| operation | p50 | p95 |
| --- | ---: | ---: |
| session list, limit 50 | 1.215 ms | 2.006 ms |
| worktree list, limit 50 | 1.357 ms | 4.963 ms |
| exact checkpoint ID | 0.199 ms | 0.371 ms |
| rare touched-path search | 0.385 ms | 0.650 ms |
| 1 concurrent worktree list | 1.191 ms | 1.548 ms |
| 3 concurrent worktree lists | 3.009 ms | 3.724 ms |
| 6 concurrent worktree lists | 6.109 ms | 7.221 ms |
| 1 concurrent touched-path search | 0.377 ms | 0.660 ms |
| 3 concurrent touched-path searches | 1.011 ms | 1.276 ms |
| 6 concurrent touched-path searches | 2.046 ms | 2.540 ms |

Two real-service bottlenecks were discovered and removed during this benchmark:

1. A correlated FTS `EXISTS` made a rare touched-path query cost roughly **1,017 ms p50** and six concurrent reads roughly **5.7 s p50**. Converting the search owner to an FTS-first candidate projection and forcing the selective candidate order with `CROSS JOIN` reduced the same production query to **0.385 ms p50** (~2,640x) and six concurrent reads to **2.046 ms p50** (~2,790x).
2. Worktree list itself was bounded/indexed, but exact-total calculation retained an unnecessary `LEFT JOIN session` across the epoch. Removing that join when predicates do not depend on session title/agent reduced worktree list from roughly **19.0 ms p50** to **1.36 ms p50** (~14x on the final clean run).

The FTS-first search still verifies exact/suffix path semantics against the authoritative checkpoint diff after candidate narrowing. This preserves the V1 contract while avoiding a JSON scan across retained history.

### Core regression / ownership proof

`packages/core/test/checkpoint-read.test.ts` now directly proves:
- bounded session/worktree summaries and exact totals;
- worktree ordering uses `session_checkpoint_epoch_created_idx` without a temporary sort;
- Windows-style persisted path separators preserve touched-path and free-text search semantics;
- search projection updates atomically with checkpoint diff updates;
- point/detail helpers remain compact while explicit `view` returns full paths;
- `Checkpoint.ReadService` completes through the dedicated reader while the foreground writer connection is deliberately held in an open transaction;
- historical migration backfill normalizes path separators;
- FTS/index supplements exist after migration;
- `reconcile` recreates a deliberately removed FTS trigger even when the migration is already journaled.

Focused result: **5 passed / 0 failed / 33 assertions**.

Scoped Core typechecking reports no P0/P1 diagnostics in the production checkpoint/read-projection sources. Remaining diagnostics are repository/toolchain ambient issues (`bun:sqlite`, `bun:test` declaration resolution and an unrelated `TextDecoder` diagnostic).

### 2026-09-19 continuation log

- Added direct Core `Checkpoint.ReadService` regression coverage and migration/backfill/reconcile coverage.
- Fixed Windows-separator semantic drift in the new path projection.
- Re-derived touched-path search from correlated FTS to an FTS-first candidate projection with exact verification after narrowing.
- Removed the unnecessary Session join from exact-total count paths when no title/agent predicate requires it.


## Output-budget / bounded-diff closure — 2026-09-19

The remaining diff-output path is now producer-bounded rather than merely
post-render truncated.

Ownership:
- V1 Snapshot owns patch materialization and exposes `diffFullBounded(from, to,
  maxPatchBytes)`.
- The bounded Snapshot path always returns the complete cheap metadata summary,
  but materializes only the patch prefix that can contribute to the caller's
  budget.
- Bounded calls load one diff file at a time rather than the full-diff 100-file
  batch, preventing speculative large-blob reads after a small output budget is
  already exhausted.
- The checkpoint tool owns presentation/XML overhead and enforces `maxBytes`
  against the final UTF-8 output rather than JavaScript UTF-16 code units.
- `src/util/utf8.ts` provides one-pass code-point-safe UTF-8 truncation; no
  surrogate pair is split.

Negative-invariant proof:
- `checkpoint-tool.test.ts`: Unicode-heavy `maxBytes=2000` diff output is at
  most 2,000 encoded bytes, round-trips through UTF-8, remains structurally
  closed, reports truncation, and preserves the filename. Full checkpoint tool
  suite: **8 passed / 0 failed / 68 assertions**.
- `snapshot.test.ts`: a 24-file Unicode-heavy diff with a 512-byte patch budget
  returns all 24 metadata summaries while materializing exactly one bounded
  patch entry; patch bytes remain <=512 and UTF-8 round-trip clean.
- Core read-projection suite remains **5 passed / 0 failed / 33 assertions**.
- The broader `diffFull` focused run produced 12 passes plus one 5-second
  harness timeout; rerunning that exact timed-out legacy test in isolation
  passed in 4.47 seconds. No functional assertion failed.

### Real bounded-output benchmark

Fixture:
- 64 modified text files;
- 1,000 Unicode-containing lines per file;
- complete full diff: **3,563,040 UTF-8 patch bytes**;
- requested bounded patch budget: **2,000 bytes**.

Measured medians after final one-file bounded materialization:

| path | median |
| --- | ---: |
| full `diffFull` | 17,613.82 ms |
| bounded `diffFullBounded(..., 2000)` | 610.39 ms |

Directional improvement: **28.86x faster**. The bounded path materialized one
file and exactly 2,000 patch bytes while retaining metadata for all 64 files.

This closes the original output-amplification defect: a small caller budget no
longer causes the entire multi-megabyte textual diff to be loaded, formatted,
escaped, and then discarded.

### Typecheck state

Scoped typechecking over the changed checkpoint/Snapshot/UTF-8 files reports no
diagnostics in those files. The command remains globally non-green because the
heavily concurrent worktree currently contains unrelated diagnostics in
control-plane workspace, sync handlers, SPAD, image/tool dependency declarations,
and server session handling. Those were not modified by this campaign.

## Closeout verdict

The checkpoint performance campaign's measured hot paths are now architecturally
owned and regression-proven:

1. bounded/indexed Core history reads through the dedicated reader;
2. indexed FTS-first touched-path discovery with authoritative exact verification;
3. normalized cross-platform path projection and migration reconciliation;
4. producer-side summary persistence without durable patch-body amplification;
5. producer-bounded V1 patch materialization;
6. strict final-output UTF-8 byte budgeting;
7. restore/provenance/worktree safety semantics preserved by the existing tool
   integration suite.

No unbounded cache, transcript reconstruction, downstream state machine, or
tool-local durable query model was introduced.
