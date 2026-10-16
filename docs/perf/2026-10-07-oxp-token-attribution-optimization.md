# OXP token-attribution hot-path audit — 2026-10-07

## Scope and authority

OpenFork's production V1 sidecar records boundary request/result character counts into `oxp_invocation`. The core attribution service reads sorted invocations from SQLite, resolves exact versus calibrated-donor provenance, then applies the fixed eight-feature empirical model. The UI consumes its Tier-0 global endpoint. The current model is **empirical-tool-usage**, not geometric context residency; the distinction between observed boundary payload and estimated surrounding usage is unchanged.

The worktree contains unrelated uncommitted work; this pass intentionally changes only six estimator/test source files and this note.

## Findings and changes

1. **Repeated projection on unchanged history.** The watermark had cached SQL rows but not the filtered, provenance-resolved and regressed snapshot. Added a bounded per-watermark, per-time-window projection cache (eight recent scope keys), using weak keys so invalidated generations do not accumulate. Repeated polls now skip the O(N) filter + resolution + regression if the SQLite/producer revision is unchanged. Timestamp metadata is still generated per request. Beginning/settling/deleting history invalidates the cached generation; integration tests verify it.
2. **Redundant row and turn arrays.** The regression first copied every activity's invocation slice, materialized its inferred turns, and traversed them again. Now it streams interval-union turn accumulation while aggregating by-tool/by-source payload statistics. It retains the original ordering checks, inclusive gap threshold, cumulative turn features, and activity reset semantics, but avoids the intermediate arrays.
3. **Per-turn feature allocation.** The original eight-feature regression allocated an array and looped over it on every inferred turn. Its fixed features are evaluated directly in the same accumulation order. The normalization and coefficients were not changed or refitted; a test independently reconstructs the original formula.
4. **MCP boundary Unicode scan.** A JS UTF-16 scan was performed for all text even when there were no surrogate pairs. A native regexp high-surrogate guard now takes the common ASCII/BMP fast path; strings containing high surrogates retain the exact prior pairing loop. Unpaired surrogate cases are tested. Character-count units remain SQLite-compatible Unicode code points; binary/image content remains excluded.

## Reproducible observations

Local Bun 1.4.3, synthetic microbenchmarks, not end-to-end UI results:
- At 2 MiB ASCII payload size, Unicode count was ~2.554 ms per invocation before and ~1.791 ms after (about 30% less time); at 700k BMP code units, ~0.989 ms versus ~0.358 ms. On sparse/dense supplementary-plane Unicode, the guard can be ~14% slower; this tradeoff benefits source-text/JSON-heavy OXP payloads rather than every possible input.
- Before the streaming pass, projection of 30,000 synthetic rows grouped into 300 activities averaged ~4.065 ms in a short warm run. A post-change sample had ~3.880 ms median (different timing design; **do not** read this as a defensible percentage speedup). For 30,000 isolated turns, the warmed post-change median was ~4.272 ms. No production latency claim is inferred from these synthetic numbers.
- Unchanged snapshots reuse the identical `totals` and `coverage` objects. This establishes the skipped recomputation behavior; a live cold/warm SQL-plus-HTTP distribution has not yet been measured.

## Verification and limitations

- Core attribution-model tests: 11 passed; core attribution integration: 4 passed; V1 context-footprint: 3 passed; Tier-0 global OXP attribution route: 1 passed.
- Core scoped typecheck: zero diagnostics in changed targets, but **two transitive errors** in untouched `database/sqlite.bun.ts` (missing bun:sqlite types) and `llm/route/transport/websocket.ts` (TextDecoder used as a type). V1 context-footprint scoped typecheck: passed.
- Wider `httpapi-global.test.ts`: 9 passed, 1 failed on an unrelated working-session retry-status expectation; the OXP attribution route passed.
- The sidecar/runtime is not hot-swappable in this host. Source/test success does not establish that an existing user process has loaded these changes.

## Continuation: producer-sourced incremental attribution

The remaining global O(N)-per-write history reconstruction has now been replaced by a **Core-owned, process-local, per-activity incremental rollup**, without a schema migration or extra SQL writes on the invocation hot path. The attribution model's empirical cumulative-turn features **reset at each parent activity**, making activity contributions algebraically independent. Global direct request/result character mass, calls, activity/turn counts, coverage and tool/source breakdowns are additive; the empirical total is the sum of independently estimated activity totals, with the same nonnegative/direct-token floor. Floating-point addition/subtraction is numerically equivalent within a few ULPs, not guaranteed bit-identical across arbitrarily reordered updates; the single-activity case reuses its original model projection exactly.

1. `OxpActivity.begin`, `settle`, host-interruption, history deletion, session registration and the historical-detail backfill now publish *identified parent activity IDs* into a bounded process-local commit-revision journal (`revision.ts`). Missing/unknown producer IDs, journal eviction, or external changes do not guess a delta: the reader rebuilds fully.
2. The Core attribution service bootstraps by scanning sorted `oxp_invocation` rows **once**. It resolves and regresses each activity independently and stores only compact per-activity contributions. Subsequent same-process commits reload and reproject the **affected activities** through indexed `(activity_id,time_started,id)` reads; `Rollup` replaces those contributions additively. It retains no second copy of raw invocation history.
3. `PRAGMA data_version` on the primary connection distinguishes foreign SQLite commits. Any differing, non-finite, or otherwise uncertain external watermark forces a full-history bootstrap, preserving correctness when another sidecar or maintenance connection changes rows without an in-process event. Distinct concurrent watermark generations are serialized by a single permit local to the projection (not the SQLite writer), and same-generation readers share an Effect cache.
4. A separate real hot path surfaced during consumer call-site inspection: the 24-hour sidebar requests **moving time bounds** (`packages/app/src/pages/session/v2/chat-sidebar-oxp-section.tsx`). Those requests previously performed a full-history SQL read before JS filtering, and their ever-changing timestamps defeated exact-scope memoization. SQL now pushes `since`/`until` into inclusive `time_started` predicates using the existing `oxp_invocation_started_idx`; activity-bounded windows additionally use the activity index. The bounded LRU caches **only compact resolved projections** for exact window keys (8 maximum), not eight raw 24-hour invocation arrays; correctness does not depend on clock rounding or stale bucket reuse.

### Complexity and measured evidence

Let N be all historical invocation rows, A their activity count, K invocations in affected activities, W invocations in the requested time window, and T distinct tools/sources (small and bounded in practice).

| Request path | Prior work | Current work, following first bootstrap |
|---|---|---|
| Repeated unchanged unscoped global snapshot | O(1) after prior memo optimization | O(1) |
| One normal local invocation begin/settle, then unscoped global snapshot | O(N) SQL read + resolution/regression | O(log N + K) indexed row read and reprojection, plus O(T) rollup materialization |
| Foreign/unidentified/evicted revision | O(N) | O(N) **intentionally**, fail-safe rebootstrap |
| Moving 24h / bounded usage-page window | O(N) row fetch + JS filter | Indexed range read of W rows + projection; usual O(log N + W) read plus SQL ordering cost |

Reproducible **synthetic projector-only** benchmark: `cd packages/core && bun script/oxp-attribution-incremental-bench.ts`. With 72,000 rows, 600 activities, 120 rows in the changed activity, and 35 rounds, one observed run reported **4.199 ms median** for full `Model.project` versus **0.0633 ms** for per-activity reprojection and rollup (about **66.3×**). The script compares computed empirical totals each round. This is **not** an HTTP/SQLite/UI speedup claim; it excludes native DB I/O, row decoding, HTTP and rendering, and should not be extrapolated linearly to other distributions. First cold scan is still O(N).

Reproducible **synthetic SQLite-only window** benchmark: `bun script/oxp-attribution-window-sql-bench.ts`. With 80,000 persisted rows representing about 55 days at one call/minute and a selected 1,440-row recent window, one 17-round sample yielded **60.4704 ms median** for full ordered SELECT plus JS filtering versus **1.1337 ms median** for SQL-bounded SELECT (about **53.3×**). `EXPLAIN QUERY PLAN` confirmed `SEARCH oxp_invocation USING INDEX oxp_invocation_started_idx` and a temp B-tree for the requested activity/start/id ordering. These figures measure **only** local SQLite query/read/row-materialization costs on synthetic rows and are not production end-to-end UI results.

### Verification and honest remaining work

- Targeted test group (`oxp-attribution.test.ts`, `oxp-attribution-model.test.ts`, `oxp-attribution-rollup.test.ts`, `oxp-attribution-cross-connection.test.ts`): **19 passed**, including differential full-model equivalence across 50 mutating activities, unchanged-cache object identity, deleted-history correction, inclusive SQL-window semantics, and **real file-backed cross-connection** updates/deletes with no local revision.
- `packages/core` full `tsgo --noEmit --pretty false`: five current unrelated diagnostics in `script/everything-bench/*`, `test/search-everything.test.ts`, and `test/session-attachment.test.ts`; none in the touched attribution implementation or new benchmarks/tests. Do not misreport the package-wide typecheck as green.
- No secondary OXP workers or delegated agents were started. Unrelated dirty-tree work was preserved.
- **Still not proved:** live production cold/warm HTTP p50/p95, very large activity count memory residency, long-duration concurrent write/read fuzz, and true multi-sidecar sustained traffic. Sliding date-window queries still reproject qualifying rows rather than maintaining a durable rolling-window index. A persistent transactionally materialized revision/projection remains an optional next architecture only if measured production workloads justify its ongoing write amplification and migration cost.

## Continuation: bounded multi-activity deltas and single-pass model validation

This follow-up preserves the same producer-owned architecture, input semantics, measured-vs-modeled separation, and unchanged global/scoped HTTP contracts. It does not introduce timers, additional writes, new migrations, per-session observers, model refitting, or workspace Instance dependencies.

### New mechanisms

1. **Batched changed-activity reads.** When the Core commit journal reports several affected parent activities, attribution now reads them using indexed `activity_id IN (...)` requests, in batches of at most 256 bind parameters. A normal single-activity begin/settle retains its equality-index lookup. SQL ordering `(activity_id,time_started,id)` still guarantees the interval-union regression contract; missing/deleted IDs are explicitly supplied as empty contributions to retract their previous aggregates. Reads and model projections complete before modifying the rollup, preserving failure atomicity of the in-memory aggregate.
2. **Constant-time journal maintenance.** The process-local 2,048-commit revision history is now a circular array rather than `push()` followed by `shift()`. Writers use O(1) slot replacement regardless of history length; `changedSince` iterates only the revision interval requested and verifies each occupied slot's revision. Older-than-capacity and unknown entries still force a safe full rebuild rather than a guessed delta.
3. **Rollup tombstone removal.** Tool/source map entries are deleted when their call counts return to zero, bounding retired dynamic tool identifiers by currently represented activities rather than lifetime distinct identifiers.
4. **Fused validation and estimation.** The canonical eight-feature model now performs row identity, ordering, interval geometry, finite mass, and activity-contiguity checks inside the aggregation pass, eliminating one O(N) traversal without dropping input assertions or changing calibration. Exact numeric estimates and separate request/result accounting remain governed by the original equations.

### Performance observations — reproducible, synthetic

Run from `packages/core`:

- `bun script/oxp-attribution-batch-sql-bench.ts`: 61,440 rows (512 activities × 120 invocations). Every old/new query pair was compared for row count **and exact ordered invocation IDs**. Following two warmup rounds, 17 retained rounds produced these medians on one local Bun/SQLite run:

| Changed activities | Rows returned | Separate indexed SQL queries | Bounded IN query | Speedup |
|---:|---:|---:|---:|---:|
| 1 | 120 | 0.1079 ms | 0.1011 ms | 1.07× |
| 8 | 960 | 0.4718 ms | 0.4492 ms | 1.05× |
| 64 | 7,680 | 4.0492 ms | 3.4500 ms | 1.17× |
| 256 | 30,720 | 15.6005 ms | 13.8530 ms | 1.13× |

The 256-ID query plan reported `SEARCH oxp_invocation USING INDEX oxp_invocation_activity_started_idx (activity_id=?)`. These savings are **modest** in isolated SQLite because row decoding dominates; practical savings in the Effect database scan lane may differ. Batching was selected for asymptotically fewer queued DB operations and bounded variable count, not an unsupported large speedup claim.

- `bun script/oxp-attribution-incremental-bench.ts`: with 72,000 rows, 600 activities, and 35 rounds, the earlier local run before fused row validation measured full/incremental median 5.2433/0.0813 ms; a later local run measured 3.4009/0.0422 ms. Both runs checked canonical and incremental empirical totals each round. These are **non-interleaved, environment-sensitive samples**, not a statistically controlled causal comparison or production p50/p95.

### Verification and remaining gates

- Core attribution regression after the batched-query and circular-journal changes: 21/21 across model, rollup, Core attribution, and real cross-connection tests, including 40-activity settlements, deleted contribution retraction, ring wraparound, and golden estimator features. The subsequently added malformed-input cases additionally exercise the fused validator.
- Tier-0 HTTP route `httpapi-global.test.ts -t 'Tier-0 OXP attribution'`: 1/1 passed; service remains global and does not initialize a workspace Instance.
- Core-wide `tsgo --noEmit --pretty false` still reported five pre-existing diagnostics in Everything-search scripts/tests and session-attachment tests; no attribution-related diagnostics after the branded-ID test correction.
- **Negative invariants:** No metric-only raw session-message hydration; no implicit workspace Instance on attribution; no per-activity SQL request when one commit changes many activities; no journal array shifting; no unbounded dead tool lanes; no silent assumption that foreign SQLite commits are producer-identified.
- **Still open:** independently measured cold/warm sidecar HTTP distributions and renderer timing under 1/3/6 concurrent active sessions; long-duration multi-process churn, SQLite busy contention, crash/reload recovery, startup-memory peaks with millions of invocations, and deciding whether an incremental sliding-window materialization pays for its extra writes. The already-running OpenFork binary is not automatically rebuilt or reloaded by source edits.

Follow-up verification: **23/23 attribution tests passed** across four Core suites after adding invalid-input parity tests and a six-settlement/twelve-effect overlapping read/write convergence test. The latter validates stable final totals and cache identity after racing local producer updates, but is not a substitute for multi-process contention, a live sidecar HTTP load test, or sustained renderer profiling.
