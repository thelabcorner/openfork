# Usage route — performance campaign (2026-10-09)

## Verified implementation surface

The Usage UI has one persistent tab shell so a summary error or an OXP switch
does not destroy its navigation rail. Non-default sections load on demand.
The pricing catalog and model grouping are gated to the Overview / Models
sections; OXP attribution fetches are abortable. The client summary cache is
server-scoped and bounded, and explicit refresh bypasses the 30-second cache.

For tables that only show K of N rows, `sortedUsagePrefix` retains a stable
top-K heap with O(N log K + K log K) ranking and O(K) memory; it falls back to
native sorting on small / mostly visible lists. The default sorting path
avoids all ranking when the backend already supplies the requested order:

| UI surface | Source-order guarantee | Fast path |
| --- | --- | --- |
| Models | `groupModelsByName`: aggregate cost DESC | direct prefix |
| Sessions | `Usage.summary`: tokens DESC; max 50 | direct prefix |
| Projects | `Usage.summary`: recorded cost DESC | direct prefix |
| Hero providers | `Usage.summary`: cost + estimated cost DESC | direct prefix for cost |
| Maintenance models | `Usage.summary`: cost + estimated cost DESC; tokens tiebreak | direct prefix for cost; stable token selection otherwise |
| Overview cache | No cache-volume ordering | linear top eight selection |

String normalization for Models search is lazily memoized after first user
search, not repeated on every keystroke. Inactive Usage summary requests are
aborted and cannot repopulate the client cache after cancellation.
Activity streaks also reuse chronological server day buckets without a
redundant renderer sort.

### Verification discipline

- Unit/property tests cover stable ties, randomized ascending/descending
  rankings, locale/string comparisons, NaNs, extremes, almost-sorted input,
  input immutability, and Maintenance secondary-rank parity.
- Synthetic 10,000-row/top-50 numeric ranking benchmark, 500 iterations:
  575.66 ms full sorting vs. 37.24 ms heap ranking (15.46x in **this isolated
  data distribution**, not an Electron end-to-end measurement).
- Microbenchmarks demonstrated native `Array.sort` can outperform heap
  ranking for small inputs and near-sorted arrays. Hence the native
  fallback at <=512 items (using direct numeric comparators at call sites)
  and direct slices for upstream-ranked arrays.
- Reproducible multi-size/shape harness: run `bun scripts/bench-usage-sort.ts`
  from `packages/app`. It checks parity before timing and reports median
  time per operation (isolated numerical sort only).
  One recorded run gave 20.80x for 10,000 random rows, 10.31x with ties,
  34.45x for 100,000 random rows, and 12.61x with ties. Small 50/500-item
  datasets favored direct native comparators instead; UI uses those paths.
- Build and typecheck gates must be repeated after the final source mutation,
  and real renderer/SQLite instrumentation is required before advertising
  page-load or total application performance gains.

## Backend frontier: cold summary scans

`packages/opencode/src/usage/usage.ts` still materializes all matching
`usage_record` and `maintenance_usage` rows, joins session/project dimension
records, orders the result, and aggregates in JavaScript. This can dominate
cold 90-day/all-time windows regardless of UI memoization. The single-query
permit and dedicated query-only SQLite connection protect live writes from
concurrent full-scan storms but do not reduce per-query scan work or wire
payload size. The concurrently developed `Usage.inspect` projection is an
architectural direction worth keeping separate from the renderer optimization.

The recommended staged approach, after reconciling the concurrent backend
lane, is:

1. Record cold/warm wall-clock time, scanned rows, process heap peaks,
   allocations, response JSON bytes, render commits, and SQLite lock/wait time
   for 1h/1d/30d/90d/all and project-scoped queries.
2. Push additive counts/cost/tokens/throughput numerator-denominator sums,
   model and provider breakdowns, and bounded `ORDER BY ... LIMIT` queries
   into grouped SQL projections on the dedicated read lane. Retain the
   existing JS aggregate as a parity oracle during migration.
3. For large-window workloads, investigate incrementally maintained UTC
   buckets or selectively persisted additive projections. Query the partial
   boundary buckets from base records. Do not naively sum `DISTINCT
   session_id` across buckets: it overcounts spanning sessions. Date grouping
   must respect local calendar boundaries and DST rather than fixed 86,400,000
   millisecond offsets.
4. Make cache invalidation account for settlement writes, out-of-band history
   rewrites, changed project/session attribution, and pricing-catalog revision.
   Historical estimated cost must not silently diverge from existing rules
   when donor prices change.
5. Add differential tests against the old aggregator covering project
   deletion/reassignment, maintenance classification, forks, missing rates,
   cost-estimation provenance, null dates, cancelled generations, interval
   boundaries, and DST transitions.
6. Only after parity is established, evaluate stream-level cancellation,
   abortable SQLite queries, partial JSON shape per active tab, and workload
   benchmarks under 25/50/100 real concurrent sessions.

Do not overwrite the in-progress backend Usage/Inspection files from the UI
lane. Preserve other worktrees and do not restart live application services.

## 2026-10-10 continuation: backend wins and correctness gates

The follow-on pass touched only localized paths in the live checkout, retaining
the concurrent Inspection/Session Context work. Production integration is:

- `packages/opencode/src/usage/series.ts`: binary-search bucket-floor lookup
  (O(log P) rather than a backward O(P) scan for every series sample) and a
  shared bounded stable top-K selector for **model series and top sessions**.
  Model-ranking weights are accumulated **once** per model rather than
  rescanned inside an O(M log M) comparator; top-session selection no longer
  sorts all distinct sessions when only MAX_SESSIONS are returned.
- `packages/opencode/src/usage/usage.ts`: use those helpers; compute each
  turn's token sum once instead of nine times; use one Date for local
  weekday/hour/day-start rather than two allocations per ordinary turn.
- `packages/opencode/src/usage/summary-cache-key.ts`: exact identity for
  historical ranges while preserving a short-lived rolling-window key for
  near-current `until` values. Previously disjoint equal-duration historical
  queries could reuse an incorrect snapshot. The cache is still intentionally
  TTL-bounded for rolling windows.
- The summary scan queue now **rechecks the cache after acquiring its permit**.
  Identical concurrent misses use the first result rather than serially
  repeating the same full scan. The cached revision is captured before scanning
  and only stored if no usage-record settlement occurred during the scan.
- Project-filtered `maintenance_usage` reads in both the full Usage summary
  and the grouped Inspection route now expose direct project equality to the
  existing `(project_id, time_completed)` SQLite index. Grouped maintenance
  and session-distinct queries use the same predicate. Global reads stay
  unrestricted; no new database migration or index was required.
- Long timeline windows previously dropped original period metrics during
  downsampling, corrupting the hero chart's summed cost/token/turn figures.
  `rollupUsagePeriods` now retains exactly the display budget and **conserves
  all additive totals** while using the same bucket boundaries as the
  provider/model series. This also removes the old 400-to-401 sample cliff.
- The calendar heatmap now receives recent active days rather than evenly
  sampled historical dates. Its client-side `usageCalendarWindow` fills
  inactive local calendar dates (including DST transitions), bounds the
  display to 120 chronological days, and respects the selected time window.
  Sparse records are no longer rendered as misleading adjacent calendar cells.
- The main and sidebar area charts now derive X-coordinates from actual
  elapsed timestamps instead of sorted-array indices, preventing sparse
  records from appearing uniformly spaced. Hover lookup uses a binary
  nearest-timestamp search rather than index-based interpolation, and the hero
  middle date label uses the actual temporal midpoint.

### Reproducible measurements and verification

- `bun script/bench-usage-series.ts` from `packages/opencode` validates
  parity, then exercises 900 models × 180 periods × top 80, 25 repetitions.
  One run: previous ranking **17.052ms/op** vs bounded ranking **0.662ms/op**
  (25.74x); previous alignment **2.033ms/op** vs indexed alignment
  **1.329ms/op** (1.53x including input-ranking overhead in both runs).
  A subsequent run with the shared selector gave 20.66x model ranking,
  1.42x alignment, and **6.92x** top-50 session selection over 100,000
  synthetic session entries (7.965ms vs 1.150ms/op); these are independent
  microbenchmarks and should not be treated as end-to-end UI speedups.
- `bun script/bench-usage-project-scope.ts` creates a **temporary in-memory**
  SQLite table with 120,000 records and 60 projects. Planner changed from
  `maintenance_usage_completed_idx` (time-only) to
  `maintenance_usage_project_completed_idx` (equality + time).
  All-time sample: 8.807ms vs 0.197ms (44.71x); recent subset: 5.706ms vs
  0.065ms (87.26x). These are synthetic SQL microbenchmarks, not the actual
  combined HTTP Usage-page latency, and query plans may vary by SQLite version
  and data distribution.
- `bun test test/usage/usage.test.ts test/usage/series.test.ts
  test/usage/summary-cache-key.test.ts test/usage/session-context.test.ts`:
  32 passing backend tests, 22,071 assertions in the latest combined run.
  New integration cases cover 12 concurrent same-key summary requests, two
  disjoint historical windows of the same length, and project-scoped Inspection
  maintenance cardinality parity. Property cases also check stable
  top-session selection and that scoring executes only once per candidate.
  Additional tests prove rollup conservation and alignment for up to 10,000
  input periods.
- `bun test --conditions=solid --preload ./happydom.ts
  ./src/components/usage/usage-calendar-window.test.ts` from `packages/app`:
  4 passing calendar tests, 14 assertions. Backend + calendar: 36 tests.
- Full focused Usage UI suite: `bun test --conditions=solid --preload
  ./happydom.ts ./src/components/usage ./src/pages/usage`:
  35 passing tests, 1,143 assertions. Time-scale parity includes 1,000
  deterministic full-scan comparisons and sparse chronological lookup cases.
  Combined with the backend suite, **67 focused tests pass**.
- `packages/app` `tsgo -b`: passing after the heatmap change.
- `packages/app` `vite build`: succeeded twice, including the final
  timestamp-based chart pass (5,131 modules transformed).
  Existing Vite warnings for mixed static/dynamic editor imports and an
  overwritten WASM sourcemap remain non-fatal and unrelated to the Usage work.
- `git diff --check` for the tracked Usage changes: clean. Other lanes'
  untracked/modified files were left in place; nothing was staged or committed.
- Full `packages/opencode` `tsgo --noEmit` remains **red for unrelated
  existing diagnostics** in CLI/debug, OXP, server-handler and other test
  files; no reported diagnostic referred to the Usage files modified here.
  Recheck it after concurrent lanes settle. No live server was restarted.

### Outstanding owner-level migration (not yet implemented)

The dominant cold-start cost remains eager materialization of the complete
range of `usage_record` rows and JS aggregation. The compact
`Usage.inspect` SQL projections demonstrate the replacement strategy but
do not yet provide every Usage tab's shape (local-time calendar heatmap,
  exact session/model distincts, project attribution fallbacks, variants,
  top sessions, provider/model aligned series, and current pricing semantics).
Before replacing the rich aggregator, implement an explicit per-field parity
matrix, differential stress fixtures including DST and deleted sessions,
pricing-revision invalidation, and synthetic/live-copy SQL plans at
25/50/100 concurrent sessions. Avoid introducing an always-on incremental
bucket writer until write amplification, crash recovery, and historical
recalculation costs beat the indexed read-only SQL path.
The `days` API still bounds its activity list to the latest 500 active days;
rhythm statistics computed from that list should not be presented as complete
all-time activity metrics on histories that exceed the cap. A separate scalar
server activity summary is the appropriate next ownership change.
The timestamp-based line charts still connect sparse active periods without
explicit intervening zero-activity buckets and currently position their
endpoints at the first/last emitted activity, not the complete requested
window. Correct full-window axis bounds and zero-filled inactivity require a
follow-on time-grid contract (including DST-safe day increments and synthetic
series/aggregate parity) rather than interpolating imaginary usage data.

## 2026-10-10 continuation: SQL projection and adversarial verification

The new targeted work was performed against the existing dirty checkout,
without clearing, staging, committing, restarting servers, or overwriting
other lanes.

### Measured architecture choices

1. **Materialized session-attribution CTE — rejected for production.**
   `packages/opencode/script/bench-usage-attribution-cte.ts` constructs
   240,000 synthetic settlements across 800 sessions / 35 projects, compares
   full attribution results exactly, then times old joined SQL versus a
   two-stage DISTINCT-session MATERIALIZED CTE. Median results:
   400 rows 0.58 vs 1.34ms (regression); 4,000 rows 6.58 vs 5.81ms;
   24,000 rows 37.13 vs 29.29ms; 120,000 rows 170.75 vs 147.40ms;
   240,000 rows 341.05 vs 292.95ms. At low volumes the extra scan and
   temporary materialization lose badly; the large-query gain is insufficient
   to justify unconditional materialization. SQLite explicitly warns that
   MATERIALIZED is an optimization fence that disables flatten/pushdown.
2. **Dedicated compact Inspection timeline projection — implemented.**
   `packages/opencode/src/usage/inspection-timeline.ts` now computes only
   the grouped fields the timeline consumes: messages, recorded cost,
   total tokens, and missing-token sums for provider/model catalog
   revaluation. The older generic compact projection unnecessarily
   calculated distinct sessions, TTFT, duration, generation time, and
   other irrelevant fields for every timeline group.
   `inspection-query.ts` delegates only its timeline branch to the new
   projection and retains its downstream bounded conservation rollup.
3. **Remove redundant SQL ordering — implemented.** The inspection timeline
   already folds source groups into a timestamp-keyed map and sorts its
   final chronology. Ordering every provider/model SQL row was unnecessary.
   The no-ORDER-BY version was measured and parity-checked independently.

`bun script/bench-usage-timeline-projection.ts` uses an in-memory SQLite
dataset of 180,000 records. With 44,263 timeline group rows, the generic
projection measured 476.38ms/op (median), the narrowed projection 309.60ms,
and the order-free narrowed projection 289.58ms (**1.65x** versus generic).
The benchmark checks the 12 retained values of every returned group and
verifies unordered row multisets. A different run measured 1.53x narrowed
query improvement; all figures are isolated synthetic SQL measurements,
not proved end-to-end latency reductions or claims about production DB
distributions.

### Correctness and verification

- An extended `test/usage/usage.test.ts` compares per-period compact
  Inspection output with the rich summary for global, p1, and p2 scopes:
  timestamps, turn totals, recorded cost, estimated cost, and token totals.
  The complete Usage/fork/quota focused run passed 44 tests and 22,136
  assertions before the subsequent maintenance-rollup fix.
- The broader TypeScript check caught a **real preexisting issue in the
  previous pass**: `rollupUsagePeriods` required `messages`, while the
  maintenance timeline exposes `requests`. The helper now takes a typed
  count key (`messages` / `requests`), and both call sites supply their
  own. New tests prove conservation of maintenance requests, tokens, and
  cost for 1,200 source buckets condensed to 400 and 1.
  After that correction, the 24-test core Usage/series subset passed.
- Final focused verification: `bun test test/usage
  test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts`
  finished **45 pass / 0 fail / 22,142 assertions** across seven files.
  The package-wide `tsgo --noEmit` remains red with 22 diagnostics outside
  the modified Usage sources/tests (CLI, global/session HTTP handlers,
  compatibility suites, swarm tests); **zero Usage diagnostics remain**.
  `git diff --check` for tracked touched paths passes. These are current
  worktree gates, not claims of repository-wide clean TypeScript or runtime
  performance dominance.

### Remaining gates

The `Usage.summary` cold-query path still hydrates full usage histories.
Promoting compact Inspection to a full-response materialization replacement
requires complete per-field parity, including exact distinct-session
cardinality across time buckets, local-time/DST heatmaps, session/project
attribution, model variants, unknown-rate estimation, maintenance
classification, and all-time activity. Prefer a shared additive SQL
projection per requested dimension over a blanket CTE, and validate
latency/memory/lock behavior on 1h/1d/30d/90d/all scopes.

### Adaptive project-scoped read plan — implemented and exercised

Additional measurement exposed a stronger architectural improvement than
deduplicating already-hydrated rows: **avoid the global time scan entirely
for a selective project**. `summary-row-query.ts` derives target session
identities from the existing `session.project_id` and
`usage_session.project_id` indices and then seeks
`usage_record(session_id, completed_at)`. It resolves live project
attribution before deleted-session tombstones, excludes stale tombstone
matches while a corresponding live Session exists, and retains the old
time-scanning path for global / `__historical__` queries. No migration
or additional index is needed.

`script/bench-usage-project-history.ts` includes exact JSON-row parity
checks for 180,000 generation rows, 1,300 sessions, and 75 projects, with
deleted and reassigned sessions. In a synthetic 75-project run, full-range
time-first queries took ~110–183ms and equivalent session-first queries took
~3–6ms (roughly **20–29x** in that run). Results vary with cache/process
load and selectivity; this is an isolated SQLite measurement, not
end-to-end Usage page latency.

**Important negative result:** repeating the experiment with one
dominant project (>99% of settled history) reversed the result:
full-range time-first ~188.09ms; session-first ~256.95ms
(~0.73x; a regression). Query shape must therefore depend on
selectivity. `project-read-plan.ts` obtains indexed project and global
session-dimension counts (without scanning historical usage records),
uses the session-first plan only for projects representing under
one-quarter of counted dimensions, and conservatively falls back to the
original time-first plan for broad projects. This is a cheap
session-cardinality heuristic, not an exact fraction of message volume;
measure the threshold with real workload distributions before treating
it as optimal. The same adaptive decision is shared with scoped compact
`Usage.inspect` queries. The user-facing summary and inspection have
integration regressions for both branches; a test inserts disposable
other-project tombstones into its temporary DB, asserts the planner
switches, compares ordinary vs Inspection totals, and removes the rows
in `finally`. Tests also cover live Session reassignment over stale
tombstone attribution and summary/inspection parity through Session
deletion.

The selectivity decision applies to Usage history queries only; maintenance
usage already has a direct `(project_id, time_completed)` index. It
is not necessary or correct to apply the same session-attribution
workaround there.

### Global/broad history — dimension-once projection and bounded emergency paging

`usageSummaryDimensionsQuery` resolves the historical live-Session /
usage_session / Project fallbacks **once per distinct session** within the
requested time range, rather than four SQL joins per settlement. Its paired
`usageSummaryRawRowsQuery` retrieves only generation scalar columns by
completed-at index. Both queries and the maintenance projection execute under
**one deferred SQLite snapshot**, guaranteeing that a concurrent Session
rename/delete or usage settlement cannot produce incoherent dimensions.
`createSummaryAccumulator` maintains the existing rich accounting semantics
incrementally; enrichment is applied in place during the row fold rather than
building another allocation-heavy array of joined objects. When a non-null
project is broad enough to select the time-first plan, the fold applies its
project filter using the exact resolved dimension. Selective project queries
retain their faster compound-index Session-first joined query.

This is a measured improvement on the hot read path, but **not yet** a complete
SQL-side rich summary: JS still processes the generation scalar rows.
`bun script/bench-usage-attribution-cte.ts` now benchmarks both the
dimension-once projection and cursor variants against joined SQL with exact
row-identity/attribution parity. On the 240,000-row/800-session fixture:

- Joined 326.92ms versus dimensions + raw 142.39ms (**2.30x**) in one
  run; joined 468.96ms versus 157.41ms (**2.98x**) in another.
- A naive 4,096-row *joined* keyset scan took 797.87ms vs 356.52ms for a
  single joined scan (0.45x); it is **not** the default reader.
- Raw row paging with larger 65,536-row pages bounded transient hydrated
  records to 65,536, but took 201.96ms vs 96.38ms for a single raw query
  (0.48x in one run). Consequently the fast single-query projection remains
  the default up to 200,000 matching rows; only extreme wide windows enter
  the bounded-memory raw paging lane. The row-count check is index-only on
  completed_at. The memory safeguard is an intentional throughput tradeoff.

The integration regression in `test/usage/usage.test.ts` creates 4,105
identically timestamped historical settlements and validates exact cursor
ordering using `(completed_at, rowid)`, in addition to full rich-summary
parity across all-time/fixed interval and global/project scopes. This
specifically covers the case where timestamp-only cursors silently skip
many records. Both paging and dimension lookups stay within one committed
read snapshot. Previous adversarial tests still cover deleted Sessions,
live-project reassignment over tombstone attribution, pricing estimates,
model variants, and compaction classification.
Another integration regression opens a deferred read transaction on the
analytics connection, renames a live Session through a separate writer while
that read snapshot is pinned, proves both attribution SELECTs see the old
name, and proves a new read after transaction close sees the update. This
is a real WAL snapshot-isolation gate, not just a no-concurrency parity
test; it restores all test metadata in `finally`.

Remaining work: a true complete SQL-native rich-summary backend would need
SQL-owned distinct Session cardinalities, exact start/end and provider/model
diversity, variant pricing, local-time DST heatmap, and maintenance
projections, plus complete field-level differential parity and actual
memory/latency testing. Do not claim O(1) global work or end-to-end
2.30–2.98x UI improvements from these query-only benchmarks.

#### Exact rich-summary replacement matrix

| Response slice | Source fields / invariant | Safe SQL next step | Gate |
| --- | --- | --- | --- |
| `totals`, `pricing`, `rates` | Recorded/estimated/unpriced counts, five token counters, duration, TTFT, generation fallback, catalog savings | Provider/model-grouped additive projection preserving NULL-cost token sums | Compare every scalar against rich collector, including unknown pricing and recorded zero-cost |
| `providers`, `models`, `variants` | Variant-precise identities, distinct provider Session count, grouped duration and generation rates | Group by provider, model, exact nullable variant; independent distinct Session cardinality | Deleted Session, mixed variants, ties and per-variant cost estimates |
| `projects` | Live project first, durable tombstone second, historical fallback; distinct Sessions | Reuse dimension-once attribution and distinct grouped counts | Reassignment/deletion and renamed-project parity |
| `periods` / provider/model series | Hour/UTC-day buckets and exact same rollup boundaries | Time-bucket x provider x model projection with shared valuation | Additive conservation over 400-point budget, including more than 400 source buckets |
| `days`, `dow`, `hours`, `punchcard` | Local calendar, DST, exact daily distinct Sessions | Project UTC timestamps into local calendar after grouped capture, or register a proved timezone-aware SQLite function | 23/25-hour days, midnight boundaries, sparse idle dates |
| `sessions`, `mostUsedModel` | Exact Session start/end, distinct provider/model pairs, top-K tokens, model tie rules | SQL grouped Session/model + ranked top-K with deterministic chronology | Unpriced/free models, equal-token ties, deleted Session titles |
| `maintenance` | Mirrored maintenance suppression, durable support-agent calls, request counts (not messages), estimated-cost provenance | Separate compact maintenance grouped SQL, preserve nullable Session cardinalities | No double-counted compaction, many-requests rows, exact cost provenance |

**Adoption rule:** do not switch the rich endpoint on a dimension until its
complete differential field suite and performance threshold pass. Avoid
N independent full-table scans: share a filtered base query/snapshot and
assess query plans under representative 1h/1d/30d/all cardinalities.
The dimension-once reader provides a validated fast fallback during migration.

**Final current verification:** Following the new global projection, WAL
snapshot, and tie-boundary integration regressions, the focused
`bun test test/usage test/fork/usage-aggregation.test.ts
test/tool/quota-usage.test.ts` run reported **49 passing tests, 0 failures,
22,168 assertions** across seven files. Package-wide `tsgo --noEmit`
remains red for diagnostics in other concurrently modified CLI/server/compatibility
and test files and none under `src/usage/` or `test/usage/`; this is **not**
a clean package-wide typecheck. The tracked-file `git diff --check` is clean.
The final retry of the package-wide checker stopped on an unrelated
`test/session/conversation-control.test.ts(50,3) TS1005` syntax error in
the heavily shared working tree; no Usage diagnostic was emitted. This
does not constitute a passing full-package typecheck.
All new files remain untracked in the shared checkout; no stage/commit/reset
or running-runtime disruption was performed.

**Unfinished top-level architecture:** Global and broadly distributed
project histories still process matching usage records in JS (materializing
the slim scalar rows as one array for ordinary histories, or bounded
65,536-row pages for very large histories), so this work is not a general
O(1) or all-time fully SQL-native projection.
Avoid lifting a partial Inspection result into the rich response until
every field has exact differential parity under missing catalog rates,
variant identity, DST, maintenance, project reassignment, and deleted
Session history. The adaptive selectivity threshold is a heuristic and
should be calibrated on anonymized representative datasets; 25/50/100
live-session concurrent measurement remains an unmet performance gate.

## 2026-10-10 SQL-native rich portfolio: differential proof and rejection gate

The remaining complete SQL-native migration was investigated as an
**experimental** read-side portfolio path, not activated in the production
`Usage.summary` route. This is deliberate: a smaller SQL result is not
automatically a faster end-to-end computation.

- `packages/opencode/src/usage/portfolio-query.ts` contains a grouped SQL
  projection for provider/model/exact nullable-variant cohorts with
  recorded/estimated pricing inputs, five token classes, cache savings,
  duration, generation time and separate DISTINCT provider-session counts.
  `valuePortfolio` constructs the complete provider/model/variant response
  slices from the small SQL result set; no generation objects are hydrated
  in JS. The candidate uses the same historical attribution and exclusion
  predicates as the existing rich service and supports both indexed and
  unindexed project scopes.
- The SQL variant projection passed differential field-level comparison
  with the authoritative rich summary for global, p1, p2, and historical
  scopes, and a 4,105-row same-timestamp workload with recorded and
  catalog-estimated cost / two variants. Indexed/unindexed project SQL
  results matched. Pure tests separately check that provider-level DISTINCT
  Session counts are **not** summed across per-variant groups.
- The original rich model-key builder conflated the null variant with the
  empty string (while its variant chart distinguished them). The production
  rich accumulator now uses typed variant identity sentinels and emits two
  distinct model buckets. The SQL candidate's temporary fail-closed guard
  was removed after differential integration tests confirmed both can be
  handled correctly. Session/provider/model series still intentionally
  merge variants for the trend view.
- `packages/opencode/script/bench-usage-portfolio.ts` builds an isolated
  160,000-row SQLite ledger and times full scalar-row hydration + JS grouping
  against two SQL group queries + value materialization. In one measured
  run (all median milliseconds, valid rows exclude maintenance):

  | Input | Valid | Group rows | JS baseline | SQL portfolio | Outcome |
  | ---: | ---: | ---: | ---: | ---: | --- |
  | 2,000 | 1,962 | 60 | 2.41 | 3.81 | SQL 1.58x slower |
  | 16,000 | 15,695 | 60 | 17.89 | 32.04 | SQL 1.79x slower |
  | 160,000 | 156,949 | 60 | 148.15 | 349.80 | SQL 2.36x slower |

  The benchmark does **not** claim to approximate the entire rich-summary
  response (its baseline folds portfolio fields only); it isolates the
  relevant SQL-versus-JS portfolio tradeoff. SQL limits returned
  cardinality from 156,949 generation rows to 60 model/variant groups plus
  five provider-session counts, but SQLite's repeated aggregate expressions,
  a second DISTINCT scan and a temporary GROUP BY B-tree dominate CPU.
  Replacing CASE expressions with the supported FILTER aggregate form
  preserved parity but did not create a repeatable performance win.

- To test a structural hypothesis rather than tweak syntax endlessly,
  the synthetic benchmark also created a throwaway
  `(provider_id, model_id, variant, completed_at)` index, then an
  **expression** index matching the three COALESCE group keys. The
  `EXPLAIN QUERY PLAN` evidence shows why: the native time-range index
  path uses `USE TEMP B-TREE FOR GROUP BY`; the ordinary group-key index
  still needs that temporary sort because the query groups normalized
  provider/model expressions. A forced expression-index scan removes the
  B-tree and reduced the *group-query-only* median to ~155.65 ms on the
  160k-row benchmark, versus ~263.34 ms for the forced ordinary group
  index. This is not the complete two-query portfolio latency, still
  requires a second DISTINCT provider-session scan, and requires
  additional write/index storage. **Neither index was migrated into
  production.**

### Decision: preserve the measured fast hybrid; do not ship premature SQL-only mode

SQLite documents that covering/group-friendly indexes can avoid sorting
work, but that indexes are costed against range selectivity and output:
`https://www.sqlite.org/queryplanner.html`. The SQL FILTER aggregate form
is specified at `https://www.sqlite.org/lang_aggfunc.html`.
These are implementation options, not blanket evidence of gains.
The current dimension-once read and fused JavaScript rich accumulator
remain the production architecture because the experimental grouped
portfolio has **not** established a CPU Pareto win. The lower-row-count
projection may still be useful in future for memory-constrained remote
clients or after indexing/materialization design is proven against writes.

Next performance gates: benchmark *full end-to-end rich response* across
1h/1d/30d/90d/all, p50/p95/p99 and peak heap on realistic model/session
distributions; quantify on-write incremental projection cost and crash
  recovery instead of assuming persistent buckets are free; retain the
  distinct-null/empty variant regression as a release gate; integrate only dimensions
that are faster and parity-clean. Keep 25/50/100 concurrent-Session lock
contention and renderer responsiveness as independent integration gates.

**Additional production-safe hot-path repair:** the existing dimension-once
rich accumulator previously attached four stable Session metadata fields
to *every* generation object using `Object.assign`, changing each row's
object shape. It now resolves those fields directly from the once-per-Session
lookup when needed; project filtering happens before any object mutation.
The model identity string is reused for rates, model bucket, time series
and distinct Session-model membership instead of reconstructed at three
separate hot-path sites. Focused regression tests rechecked model variants,
rate/cost provenance, deleted Sessions and 4,105 equal-time rows.
These are structural reductions in allocations/writes, **not claimed
measured end-to-end speedups**.

SQL-native portfolio investigation closeout: `bun test
src/usage/portfolio-query.test.ts test/usage
test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts` now
passes **52 tests / 22,475 assertions / 0 failures** across eight files.
The synthetic index trials exist only inside the disposable benchmark
database and do not alter production schema or write amplification.
The final package-wide `bun run typecheck` remained non-green with
30 diagnostics in concurrently edited unrelated files (CLI/server/tests);
it reported **zero** errors under the changed Usage sources, Usage tests,
or portfolio benchmark. Tracked `git diff --check` succeeded; no changes
were staged or committed and no live processes were restarted.

## 2026-10-10 complete activity statistics and cold-service performance

**Correctness repair in the authoritative backend:** the client had been
counting active days, calculating the longest streak, and finding the
busiest day from `summary.days` even though the response deliberately
caps this heatmap data to the latest **500 active dates**. Histories longer
than 500 active dates yielded incorrect full-window rhythm statistics.
`src/usage/activity-summary.ts` now derives `activity.activeDays`,
`activity.longestStreak`, and `activity.busiestDay` from every local day
already held in the rich accumulator, before the client heatmap is
truncated. Consecutive days use `Date.setDate()` followed by local
midnight normalization rather than assuming every civil day is
86,400,000 milliseconds. The complete days array is sorted **once**
and shared by the activity calculation and the bounded 500-day heatmap.

`packages/app/src/pages/usage/usage-page-activity.tsx` consumes those
server-owned scalar facts rather than inferring full-history behavior
from the truncated heatmap; a legacy-sidecar fallback remains until
the generated SDK types are refreshed. A real temporary-SQLite
integration regression inserts 620 consecutive historical active days
plus two additional messages on a day that lies outside the newest
500, proving exact **620 active days, longest streak 620, busiest-day
messages 3, heatmap length 500, ordinary turns 622**.

**Identity and working-set optimization:** the rich model bucket key
now distinguishes `variant: null` from `variant: ""`, removing the
previous silent merge. An independent integration regression inserts
both model variants and proves that rich and SQL portfolio outputs
contain two buckets with equal count while their trend series remains
merged. The rich accumulator also replaced its redundant per-project
Session-ID sets with counts derived from first encounters in the
existing global Session set. Project attribution is constant within
the pinned SQLite snapshot, making this exact without maintaining
the same Session IDs twice.

**Real end-to-end service benchmark:** the reproducible script
`packages/opencode/script/bench-usage-cold-summary.ts` creates an
ephemeral SQLite database, seeds 25 projects, 1,000 sessions and
60,000 generations, runs the real Usage.service / rich response /
serialization code path, resets the response cache for each of five
cold samples, and records payload sizes. In an isolated run:

| Visible history | Global median | p0 project median |
| ---: | ---: | ---: |
| 2,000 records | 10.95 ms | 1.23 ms (80 project records) |
| 20,000 records | 72.90 ms | 4.58 ms (800 project records) |
| 60,000 records | 256.18 ms | 13.76 ms (2,400 project records) |

An earlier isolated run measured global 10.12/77.80/230.57 ms;
variance of these single-machine synthetic medians and concurrent
CPU load prevents confidently claiming a specific speedup for the
latest small object/Set optimizations. The rich payload reached
107.1 KiB for the 60k-global workload; its large-query cost is
primarily computation, not transport bytes.

**Concurrency and queueing gate:** the benchmark also launches 25, 50
and 100 service calls through one shared service/layer, each covering
2,000 synthetic generation records. All calls with an identical cache
key share a cold result and complete together in roughly 10–12 ms
per batch. With disjoint uncached keys, the single query permit
serializes reads: in one run 25 requests took 350.81 ms as a batch
(p95 completion 337.10 ms), 50 took 554.74 ms (p95 535.15 ms),
and 100 took 1,136.98 ms (p95 1,094.68 ms). All p95 completion
latencies are measured relative to the common batch submission,
**including queue wait**, not just the CPU time inside the Effect
callback. These are synthetic in-process service calls, not 25/50/100
distinct live interactive Sessions or renderer benchmarks.

The query permit is an explicit guard protecting the shared SQLite
environment from uncontrolled expensive scans; do **not** simply
increase concurrency without benchmarking multiple scan connections,
WAL retention, memory high-water mark and writer starvation. A
future multi-lane read pool should be separately bounded and prioritize
interactive requests; coalesce identical semantic queries before
queueing and make superseded/cancelled work cheap to discard.

**Current gates:** `bun test src/usage/activity-summary.test.ts
src/usage/portfolio-query.test.ts test/usage
test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts`
passes **58 tests, 22,498 assertions, 0 failures** across nine files.
The app TypeScript check and Vite production build passed. The
package-wide backend check remains blocked by unrelated concurrent
diagnostics. No process restarts, commits, resets, or migrations were
performed.

**Latest end-of-pass verification (same shared dirty checkout):**
`packages/app` production Vite build and TypeScript build both exited 0.
The expanded focused Usage/fork/quota suite (including both new
activity/portfolio test files) passed 58 tests / 22,498 assertions.
`git diff --check` on tracked touched sources exited 0.
The latest backend-wide `tsgo --noEmit` exited 2 on parse diagnostics
inside other concurrent work in `packages/core/src/session/projector.ts`
(TS1005/TS1128); it did not report a Usage diagnostic, but syntax errors
can stop later semantic typechecking, so **this cannot certify full
backend type soundness**. Independent Usage integration tests passed.
No user database was read or written: every benchmark and integration
fixture used its own disposable temporary SQLite DB.

## 2026-10-10 adversarial certification continuation — deterministic history and snapshots

This pass prioritized **correctness under different query plans** over
microbenchmark wins. It re-read the root/package AGENTS contracts, checked
the live dirty worktree, and preserved every unrelated concurrent edit.

### Deterministic SQL order: real defect found and repaired

The former global time-first and selective session-first SQL queries
both ordered only by `r.completed_at ASC`. That is not a total order:
many provider settlements share millisecond timestamps, and SQLite can
return tied records in different orders depending on the selected index.
This was exposed by a new randomized 5,777-record fixture and five time
windows across five project scopes. It matters for chronological output,
stable model tie winners, deterministic floating-point accumulation, and
consistency between one-shot and paginated history.

`src/usage/summary-row-query.ts` now uses
`ORDER BY r.completed_at ASC, r.rowid ASC` for **both** rich SQL plans,
the global unpaginated scalar query, and the keyset reader; the keyset
predicate already advances on `(completed_at,rowid)`.
The adversarial test constructs 165 live/deleted/reassigned Sessions,
stale tombstones, true orphan IDs, NULL provider/model/variant, explicit
empty-string variant, and more than 5,000 message rows, then verifies:

1. The indexed and time-first project SQL return exactly the same full
   objects in exactly the same order over 25 project×window combinations.
2. The indexed Inspection membership predicate yields the same selected
   message IDs as the authoritative join for all the same combinations.
3. The dimension-once global scalar query preserves all Session metadata
   against the full joined query, including true orphans and reassignment.
4. Keyset pages over 1/2/3/7/17/127/4096/20000 row limits reproduce the
   exact full-ordered result, with no missing or duplicate records.

The new SQL test has **3 passes, 46,556 assertions**, and was first observed
failing under the old timestamp-only ordering, then passed after the
deterministic tie-breaker fix. No database schema change was required.

### All multi-statement reads now share one WAL snapshot

An earlier optimization pinned the global/dimension-once summary path to
one read transaction, but left the indexed project summary path unpinned
while it read both ordinary and maintenance records. Compact Inspection
also performs two or more SELECTs per action (e.g. grouped totals then
COUNT DISTINCT Session IDs) and had no overarching transaction.

`src/usage/usage.ts` now calls `conn.transaction(..., { behavior:
"deferred" })` for **both** rich-summary plans and for each Inspection
action, preserving a coherent committed SQLite view across all reads.
This is especially important during Session deletion, project reassignment,
new usage settlement, or concurrent maintenance accounting. It does not
add an exclusive writer transaction. Existing WAL isolation and
Session-deletion integration regressions remain green after the change.

### Schema, accounting and time-zone certification

A new rich service response test uses the actual `Usage.UsageSummary`
Effect Schema validator and asserts that totals agree across provider,
model, variant, project, period, day-of-week, hour and punchcard counts;
tokens reconcile across provider/model portfolios; all-inclusive spend
matches grouped costs; and project distinct Sessions sum to the global
cardinality for each project/global historical fixture.

`src/usage/activity-summary.test.ts` now includes:
* An isolated child-process test with `TZ=America/Chicago` that proves
  the **23-hour spring** and **25-hour fall** local midnight gaps, while
  counting each as one successive civil date.
* A deterministic 120-sample × 365-calendar-day sparse activity oracle,
  independent of the implementation's time-based streak check.

These tests are independent of the developer machine's local time zone.
No mutable process-global timezone setting is leaked into the rest of
the Bun test runner.

### Remaining certification gates / boundaries

The current server implementation is still a hybrid JS accumulator with
selective indexed history and a bounded keyset fallback for unusually
large global scans. Fully SQL-native rich summaries remain experimental
because the measured grouped query regressed CPU throughput. In addition:

- The SDK-generated types for the new optional-use `activity` response
  shape must be regenerated once the **currently dirty** generated files
  in `packages/sdk/js/src/v2/gen` are coordinated with their owners.
  The UI currently uses a type-narrowed fallback while remaining backward
  compatible with older sidecars. Do **not** overwrite shared SDK
  generated output unilaterally.
- The package-wide TypeScript project includes unrelated ongoing changes;
  full certification is blocked when these fail parse/type checking.
  A separate `tsgo --ignoreConfig` check directly covering the SQL and
  activity implementation/test files was added as an independent local gate.
- Rendering behavior should ultimately be checked in a real Electron
  renderer and an HTTP API transport test; focused Solid/happydom and
  service-schema tests are not a substitute for that.
- Test response cancellation, 25/50/100 genuinely live Session requests,
  and a multi-connection reader with writer-starvation / WAL retention
  measurements before changing the single read permit.

### Final validation results for this continuation

**Focused backend regression suite**:

```sh
cd packages/opencode
bun test src/usage test/usage test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts
```

**64 passed, 0 failed, 69,272 assertions across 10 test files.**
This includes the independent SQL parity fixture, runtime UsageSummary
Schema validation and conservation proof, true DST tests, 120 random
ordinal-day activity oracles, existing maintenance and Session-context
regressions, and explicit deleted-session / equal-timestamp checks.
The randomized query fixture's earlier failure before the order fix
is preserved in the rationale above; the final run is green.

**Focused frontend tests**:

```sh
cd packages/app
bun test --conditions=solid --preload ./happydom.ts ./src/components/usage ./src/pages/usage
bun run typecheck
bun run build
```

**35 tests passed, 0 failed, 1,143 assertions across 7 files;**
app TypeScript build and Vite production build both exited 0.
The combined scoped coverage is **99 passing tests, 70,415 assertions.**

**Isolated type check for new backend helpers/tests**:

```sh
cd packages/opencode
bunx tsgo --ignoreConfig --noEmit --skipLibCheck \
  --target es2022 --module esnext --moduleResolution bundler --types bun \
  src/usage/summary-row-query.ts src/usage/summary-row-query.test.ts \
  src/usage/activity-summary.ts src/usage/activity-summary.test.ts
```

Exited 0 after fixing a caught test-source typing problem.
The full `packages/opencode` TypeScript project remains **red on
concurrent work outside this scope**; this scoped check does not prove
whole-package type safety. The generated SDK files in
`packages/sdk/js` were dirty before this continuation, and therefore
were **not overwritten** by a generator.

These results prove the stated scoped regression gates, **not**
whole-repository certification, HTTP transport/release-package
verification, or real concurrent-session renderer behavior.

**Post-fix end-to-end smoke benchmark:** after the deterministic SQL
ordering and transaction changes, the complete disposable-DB
`bun script/bench-usage-cold-summary.ts` run exited 0. The 60,000-row
global cold median was 224.83 ms (previous isolated runs: 230.57
and 256.18 ms), while the p0 selective project median was 16.98 ms
(earlier 12.22–13.76 ms). These runs are not paired or noise-isolated
enough to establish a speedup/regression; critically, there was no
catastrophic throughput collapse or accounting mismatch. Under 100
simultaneous disjoint service queries, batch time was 1,127.54 ms with
p95 completion at 1,090.85 ms, comparable to the earlier serialized
single-read-permit baseline. This does not replace real worker/renderer
concurrency certification.

## 2026-10-10 read-queue campaign — implemented safety, worker-pool frontier

**Original baseline:** 100 disjoint, uncached 2,000-record rich requests had
roughly 1.09s p95 completion under one dedicated SQLite read lane. Same-key
requests already coalesce at the cache. Query serialization is the binding
limitation for independent requests, not merely duplicated UI responses.

**Negative result: existing asyncWorker toggle.** The complete rich-service
`script/bench-usage-cold-summary.ts` was rerun with
`OPENFORK_SQLITE_ASYNC_READ_WORKER=1`. The 60k global cold median increased
from 224.83ms to 388.57ms, and 100 disjoint queries increased from 1,090.85ms
to 1,672.01ms p95. Separate-machine-load runs are not strictly paired A/B,
but offloading one connection did not solve serialization; the default was
not changed. Potential event-loop responsiveness was not evaluated.

**Positive isolated OS-worker experiment:** New
`script/bench-usage-read-worker.ts` and
`script/bench-usage-read-lanes.ts` create a disposable WAL ledger, use
separate read-only SQLite connections in native Bun workers, and dispatch
1,000 2,000-row scans across 1/2/4/8 readers. All two-million per-round
source rows are accounted for and each query's provider, Session, token and
cost results are checked against the one-lane oracle:

| Reader workers | 1,000-query batch | p95 from submission | Throughput |
| ---: | ---: | ---: | ---: |
| 1 | 1,454.33ms | 1,382.20ms | 687.60 queries/s |
| 2 | 716.26ms | 680.56ms | 1,396.14 queries/s |
| 4 | 422.07ms | 403.35ms | 2,369.30 queries/s |
| 8 | 255.00ms | 242.93ms | 3,921.55 queries/s |

This is **5.69x lower p95** with eight independent readers *for a simplified
scalar SQL query*, not the full Usage.summary contract. Periodic main-thread
SQLite writes completed with no reported SQL errors; observed p95 write-call
times were under 0.1ms, but the 8-worker batch provided only 24 write
samples and is insufficient to certify p99 writer tail latency.

**Windows lifecycle blocker discovered:** even after worker `close`
acknowledgments, explicit SQLite handle close and `Worker.terminate()`,
the native handle could keep the WAL fixture locked until the containing
process exited (`EBUSY` on temp cleanup). The two specifically created
fixture directories were successfully removed in a separate cleanup
process. Resource finalization, cancellation, shutdown/restart, WAL
checkpoint behavior, storage overhead, and complete rich-response parity
must be proven before shipping any worker pool. **No reader pool was
introduced into production.**

**Production-safe improvements shipped in shared checkout:**

- Catalog **I/O remains outside** the scan permit. An initial experiment
  moved `modelsDev.get()` inside that permit and proved lower duplicate
  catalog work, but a source-level audit showed that a cold get may perform
  a network fetch with a 10-second timeout. Holding the SQLite permit
  through that fetch could stall unrelated `modelProfile` and Inspection
  reads. This candidate was **rejected/reverted** after the audit.
  Instead, the accepted production path checks the summary cache first,
  resolves the current ModelsDev snapshot outside the scan permit, then
  lazily values that snapshot *after* admission and the second cache check.
  `model-rates-cache.ts` memoizes by the immutable ModelsDev catalog
  identity and rebuilds upon a replacement snapshot. Tests prove
  same-snapshot reuse, refresh replacement and owner isolation. The
  integration test now verifies 12 concurrent logical catalog accesses,
  one identical full Usage response and no further catalog work on a
  warm hit. Remote ModelsDev itself owns population singleflight.
- The catalog-pausing cancellation test was intentionally **removed**
  when the source-of-truth audit required moving catalog retrieval back
  out of the SQLite permit. It would no longer exercise the intended
  queue bottleneck. A true queued-HTTP-disconnect integration test is
  still an **unmet gate**; do not claim cancellation was certified by
  the removed test.
- The 100-entry summary cache previously cleared *all* entries once the
  limit was exceeded, creating a cold-scan stampede during range revisits.
  It now evicts only least-recently-used keys, promotes hits without
  extending their factual 3-second TTL, and preserves revision/reset
  invalidation. A >100-unique-window integration regression confirms
  the hot response remains object-identical and skips new SQL/catalog
  work after overflow.

**Follow-up gates:** real rich-aggregation worker ownership (not a separate
parallel feature fork), pool cap/backpressure, deadline/priority scheduling,
cache/singleflight parity, Windows finalizers and no leaked handles, writer
p95/p99 with thousands of samples, background checkpoints, resident memory,
and 25/50/100 genuinely concurrent interactive Sessions. User databases
and running services were not modified by the synthetic experiments.

### Final read-queue experiment validation, revised after source audit

The initial candidate that moved `modelsDev.get()` under the Usage
SQLite permit was **not** retained after auditing
`packages/core/src/models-dev.ts`: a genuinely cold catalog load can
perform network I/O up to its 10s timeout. Its test for holding the
permit across slow catalog resolution was deleted because it encoded an
architecturally undesirable behavior. The retained `makeUsageRatesCache`
memoizes the stable catalog *snapshot* to avoid repeated `buildRates`
work, while the catalog fetch remains outside SQLite admission. Its
model-snapshot, replacement-refresh, and separate-owner unit tests pass.
The existing same-key summary integration test still proves shared
response identity and no extra catalog access on a warm cache hit.

The original Inspection transaction refactor exposed strict TypeScript
errors: `runInspection` and `queryTimelineRows` both accepted the
entire SQLite client interface even though they require only the
`all/get` methods available on a pinned read transaction. The
contracts have been narrowed to `Pick<Database.DatabaseShape,
"all" | "get">` and `Pick<Database.DatabaseShape, "all">`
respectively, preserving the WAL snapshot safety boundary. A strict
inference regression in the randomized SQL paging test was also fixed.

**Final backend validation:** `bun test src/usage test/usage
test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts`
exited 0 with **68 passing tests, 69,286 assertions, 0 failures
across 11 files**. The package-wide TypeScript checker still exited
2 with **25 unrelated diagnostics and no Usage source/test errors**.
`git diff --check` on modified tracked Usage files exited 0.
No concurrent repository edits were discarded, reset or committed.

The full production-service smoke benchmark completed again after the
revisions. Without the overlapping full typecheck process, the
disposable 60,000-row global cold-summary median was **224.87ms**,
comparable to the earlier 224.83ms, and 100 disjoint queries produced
 **864.88ms p95**, with a 900.46ms batch. These independent run
medians do not support claiming an exact proportional production
speedup. The LRU-overflow extension generated **105 distinct summary
windows** and then confirmed the promoted hot window remained
reference-identical and was returned in **0.075ms**. This validates
the removal of the former full-cache-clear cliff under the fixture.

**Final frontend Usage regression confirmation:** `bun test
--conditions=solid --preload ./happydom.ts ./src/components/usage
./src/pages/usage` exited 0, with **35 passing tests, 1,143 assertions**.
Together with this pass's backend results, the scoped verification totals
**103 passing tests, 70,429 assertions, zero failures**. These test counts
do not supersede the unresolved package-wide backend typecheck, Windows
worker-handle lifecycle, or real Electron/HTTP/cancellation testing.

## 2026-10-10 closeout: Database-owned exclusive reader leases

**Implemented.** The canonical `packages/core/src/database/database.ts`
Database service now exposes `withScanDb(callback)`. This lease owns one
read connection from admission through the end of the callback, including
any DEFERRED WAL transaction. `packages/core/src/database/scan-read-pool.ts`
implements a bounded pool: one Effect semaphore for global admission,
one exclusive reservation per slot, stable memoized per-slot connections,
and `acquireUseRelease` to return a slot on success, failure or
interruption. The Database layer, not an HTTP request or short-lived
caller, owns every native worker's finalizer using the existing
`acquireScopedResource` resource-transfer contract.

**Compatibility:** The pre-existing `scanDb()` identity/API remains
unchanged for other callers. `Usage.summary`, `Usage.inspect`, and
`Usage.modelProfile` now use Database's exclusive lease instead of a
separate Usage-local semaphore, so multi-statement query snapshots cannot
be split between connections. With the default **one lane**, the new
lease reuses the legacy lazy `scanDb()` connection. No new worker or
startup cost is created in default mode; `:memory:` databases stay on
their shared handle regardless of configured lane count.

**Opt-in parallel readers:** `OPENFORK_EXPERIMENTAL_USAGE_READERS=2`
or `=4` selects 2/4 independently owned, lazily created query-only
SQLite Bun workers after normal database migration/bootstrap.
`layerFromPath(filename, { scanReaders: 2 })` offers explicit fixture
injection without modifying process environment. Values are clamped
to 1–4; nonintegers and invalid input fall back to one lane. All pooled
connections enforce both `readonly: true` at the native SQLite open
and `PRAGMA query_only=ON`, with short busy timeout, per-worker 16 MiB
page cache, and no worker-owned WAL TRUNCATE checkpoint.

**New correctness gates and concrete results:**

- `packages/core/test/database-scan-pool.test.ts`: leases are exclusive
  even under 30 concurrent callbacks, peak active count equals the
  3-reader bound, queued cancellation releases admission, callback errors
  release the slot, and failed/interrupted reader initialization permits
  a clean retry.
- `packages/core/test/database-scan-pool-integration.test.ts`: two
  independent worker read transactions observe the same pinned WAL
  snapshot while the primary writer commits. A queued third lease can be
  cancelled; the workers reject writes, and subsequent reads see the
  committed update. Closing the Database layer releases native connections.
- The same Windows lifecycle test ran **10 times in separate Bun
  processes**, every run exited 0, including deletion of the temporary
  SQLite file/directory. Each run made **1,000 primary-connection writes
  while two reader snapshots were open**; per-run writer-call p95 ranged
  from **0.107–0.292ms**. This is 10,000 successful sampled writes, but
  not a full CPU-saturated p99/high-WAL-growth certification.
- `packages/opencode/test/usage/usage.test.ts` now compares the
  complete rich `Usage.summary` result between default one native reader
  and the experimental two-worker mode for six disjoint global,
  per-project, historical, hourly, daily and zero-start windows.
  Parallel requests produce exactly identical structured outputs and
  each validates against the public runtime schema. Existing rich
  accounting and attribution regressions continue to pass.

**Production throughput decision: keep the one-native-reader default.**
An identical full-service disposable-DB benchmark
(`packages/opencode/script/bench-usage-cold-summary.ts`) now accepts
`OPENFORK_BENCH_USAGE_READERS` for controlled comparisons. Different
single-machine runs measured:

| Leased readers | 60k-record global cold median | 100 disjoint rich requests p95 |
| --- | ---: | ---: |
| 1 native (reference) | 224.87ms | 864.88ms |
| 2 Bun worker connections | 448.09ms | 1,516.17ms |
| 4 Bun worker connections | 413.49ms | 1,190.32ms |

These are synthetic, **unpaired** runs and do not prove exact speedup
ratios. They do demonstrate that the producer-owned worker topology
has **not established a Pareto improvement** for the complete rich
Usage endpoint, despite the earlier simplified scalar-query prototype
showing major parallelism gains. Repeated row marshaling plus the
main-thread rich accumulator are likely contributors, but this is
a hypothesis until independently profiled. The 2/4-reader feature
therefore remains opt-in and **must not be promoted to default**.
The measured advantage of a separate lightweight scalar worker
prototype does not substitute for full endpoint parity/throughput.

**Closeout boundary:** correctness, read-only WAL snapshots, queued
fiber cancellation, scoped connection lifetime, and 10-round Windows
cleanup now have runnable evidence. Still outstanding before enabling
parallelism by default: per-query worker-side rich aggregation with
wire/schema parity, paired warm/cold CPU + memory + checkpoint
measurements, real HTTP-disconnect cancellation, long-running
WAL/checkpoint churn, p99 writes under sustained CPU pressure, Electron
renderer responsiveness, and live 25/50/100 interactive Sessions.
Do not equate the independent service-call benchmark with full agent
session concurrency or claim 100% repo/release certification.

### Final integration acceptance and compatibility

The first implementation made `Database.Interface.withScanDb` mandatory,
which surfaced existing Core unit-test fixtures that intentionally inject
the older, hand-built Database interface. The production Database owner
always provides the new lease, but its interface is now **optional for
legacy/injected fixtures**, and Usage has a serialized, single-reader
fallback for those implementations. This preserves direct hand-written
fixtures without compromising the real Database-owned pool. That
compatibility repair eliminated all new Core-package compiler errors.

End-of-campaign scoped verification commands:

```sh
cd packages/core
bun test test/database-scan-pool.test.ts test/database-scan-pool-integration.test.ts test/database-reader.test.ts
bun run typecheck

cd ../opencode
bun test src/usage test/usage test/fork/usage-aggregation.test.ts test/tool/quota-usage.test.ts

cd ../app
bun test --conditions=solid --preload ./happydom.ts ./src/components/usage ./src/pages/usage
bun run typecheck
bun run build
```

**Final scoped outcome:** Core Database tests **8 pass / 107 assertions**,
Usage/fork/quota backend tests **69 pass / 69,293 assertions**,
frontend Usage tests **35 pass / 1,143 assertions**. Combined:
**112 tests, 70,543 assertions, 0 failures**.
`packages/core` TypeScript validation **exited 0** after the compatibility
fix. `packages/app` TypeScript and production Vite build **exited 0**.
The package-wide `packages/opencode` TypeScript check **exited 2
with 31 diagnostics** in independently edited runtime/CLI/test modules,
including debug-support-bundle and HTTP handler type incompatibilities.
There were **zero diagnostics attributed to the modified Database
owner, scan-read-pool, Usage source, or their affected Usage tests**.
This is not full monorepo TypeScript certification.

The ten-process Windows lifecycle stress test also exited 0 for every
round, with 1,000 writer INSERTs per process and measured p95 writer
durations ranging from 0.107ms to 0.292ms. Files were removed by the
normal test cleanup. No live user database was opened or modified,
no running application service was restarted, and no commits were made.

**Engineering closeout decision: the bounded pool is integrated and
correctness-gated but parallel operation is experimental and default-off.**
The current full rich aggregation path does not yet demonstrate a
throughput win from worker-backed reads. Future optimization should
eliminate the scalar-row transfer and main-thread fold bottleneck before
considering a different default. No production performance dominance
claim is warranted from these measurements.

## 2026-10-10 follow-on: rich-aggregation projection and boundary validation

**Three narrowly scoped production repairs:**

1. **Maintenance model-key correctness.** Rich maintenance bucketing still
   used `variant ?? ""` as a composite model-key suffix, silently merging
   SQL `NULL` and the real empty-string variant while normal model bucketing
   had already fixed this collision. The maintenance key now uses the same
   explicit typed variant marker as the ordinary model key. A real SQLite
   integration regression inserts two maintenance settlements with otherwise
   equal agent/provider/model and `NULL` vs `''` variants, then asserts two
   distinct model buckets, one request each and unchanged total request count.
   The test does not rely on cost-dependent display ordering.

2. **Model-series byte-budget correctness.** `MAX_SERIES_VALUES=60,000`
   previously divided by the period count only, although each model emits
   THREE numeric series arrays (`messages`, `cost`, `tokens`). The actual
   output could consume about 180,000 numeric slots. New
   `usageModelSeriesBudget(maxValues,periods)` counts all three arrays;
   400 periods now permit at most 50 model series, each complete with
   zero-filled gaps. Unit tests prove the budget is never exceeded at
   1/4/30/365/400/1000 periods, including empty/invalid budgets.
   No partial trend lines are emitted.

3. **Unused global-message identity hydration.** Ordinary per-record
   summary accumulation does not dereference `message_id`, only the
   separate keyset cursor `rowid` for paged scans. The global raw SQL
   selector now offers an `includeMessageID` option (default true for
   diagnostic/legacy callers). The rich accumulator requests false for
   both whole-window and paged reads; all scalar, attribution and cursor
   fields remain intact. A deterministic SQLite differential test
   verifies every other field matches exactly for a multi-thousand-row
   scan and for bounded pages, with no `id` property in optimized rows.
   A type-level Row contract accommodates the omitted unused ID.

**Measured SQL hydration A/B:** using the same real persistent read
connection on a synthetic 60,000-row fixture, and alternating full
and compact query order for 12 warm median samples:

| Projection | Median scalar SQL + JS hydration |
| --- | ---: |
| Full, including `message_id` | 54.53ms |
| Reduced, omitting `message_id` | 51.86ms |

This is a **2.67ms / 4.9% reduction for the hydration stage only**,
not a 4.9% proven improvement to the complete endpoint. The full
60k rich summary was 223.07ms in that isolated same-process
benchmark. Removing one unused string per record reduces object
transfer/heap pressure but confirms most remaining end-to-end time
is elsewhere (remaining SQL joins/scalar work and the rich JS fold).

**Accumulator object churn:** the rich usage fold now reuses one
Date instance, calling `setTime(completed)` per record before
reading local weekday/hour and applying local midnight normalization.
This removes one Date allocation per ordinary turn, retains civil
day and DST semantics, and stays inside the synchronous accumulator.
This change is covered by the complete window-accounting and time-zone
regressions; an isolated before/after full-service speedup has **not**
yet been established, so do not attribute the 223.07ms measurement
to Date reuse (that sample predates this optimization).

**WAL checkpoint regression:** the Core two-worker integration fixture
now performs `PRAGMA wal_checkpoint(PASSIVE)` while two independent
reader transactions hold old WAL snapshots, verifies the reported
frame counts remain valid, then releases both snapshots and performs
`PRAGMA wal_checkpoint(TRUNCATE)`, asserting no busy reader and
zero remaining WAL frames. It also retains the 1,000 foreground writes,
write-readonly denial, cancellation and file-close cleanup.

**Latest scoped verification following these repairs:** backend
`bun test src/usage test/usage test/fork/usage-aggregation.test.ts
test/tool/quota-usage.test.ts` **72 passed, 75,132 assertions**;
Core SQLite reader/pool suite **8 passed, 111 assertions**; both
zero failures. Earlier frontend Usage suite **35 passed, 1,143
assertions**, unchanged by these backend-only fixes. A new isolated
70k+ SQL differential run and schema tests passed. This is not
equivalent to end-to-end HTTP-disconnect propagation, worker-side
rich aggregation, or live concurrent-session renderer validation.

## 2026-10-10 full rich-aggregation worker prototype and streaming cursor

**Research result: worker execution materially improves event-loop
responsiveness; default production integration remains gated.**

An entirely **benchmark/test-only** experiment now exists at
`packages/opencode/script/bench-usage-rich-worker.ts`. It opens a
query-only Bun SQLite connection in a native worker, pins one DEFERRED
snapshot, executes the same dimension/usage/maintenance projections
as the authoritative service, and imports the **same exported
`createSummaryAccumulator`** from `src/usage/usage.ts`. No second
accounting algorithm was invented or forked, avoiding a divergent
source of truth. The full schema-shaped response crosses back as one
bounded aggregated message rather than transferring all generation
rows to the main thread. Worker startup and close are explicitly
handled inside the disposable `script/bench-usage-cold-summary.ts`
harness. **No HTTP handler, runtime service, or default environment
flag routes production requests through this prototype.**

The maintenance SELECT has also been extracted into the pure shared
`usageSummaryMaintenanceRowsQuery` helper and consumed by both
host and worker. This preserves project scope, timestamp ordering,
estimated-cost provenance, variant identity and request totals.
The canonical fold's `addRows` accepts any `Iterable` in addition
to arrays, enabling an alternative native SQLite
`PreparedQuery.iterate()` direct feed. Streaming avoids a resident
`RawUsageRow[]` for every generation (intermediate retention is
O(1) records rather than O(turns); aggregation dimensions/sets still
consume memory proportional to distinct sessions/models/periods).
Both native-worker modes return the same complete rich response.

**Differential correctness evidence:**

- Complete JSON-equivalent output across **2,000, 20,000 and 60,000
  ordinary generations**, globally and for the selected project, for
  both the original worker `.all()` hydration and new streaming cursor.
- The dedicated worker integration in `test/usage/usage.test.ts`
  compares every rich response field to the production service,
  validates against the public `Usage.UsageSummary` runtime schema,
  and runs both hydration modes over global, p1, p2, historical
  ranges plus **24 deterministic unaligned and project-scoped
  random window requests**. Any divergence is a hard test failure.
- It uses the same cancellation-independent worker cleanup contract
  established by the Database-owner Windows lifecycle tests. Any
  failure is still experimental and must not affect production reads.

**Cold complete-service prototype, unpaired repeated five-sample
medians on the disposable 60k fixture:**

| Mode | 60k global full rich response |
| --- | ---: |
| Existing host/native reader | 215.55–217.53ms |
| Worker-side rich fold, `.all()` | 212.96–214.81ms |
| Worker-side rich fold, streaming `.iterate()` | 224.96–240.66ms |

These synthetic small-sample timings are not statistically
conclusive, and the streamed cursor was modestly slower while
eliminating the intermediate all-rows array. **Do not claim a
throughput Pareto win.** The stage split for streamed mode combines
SQLite read and JS fold, so `workerReadOrCombinedMs` is **not** a
pure SQL cost. A Bun worker probe revealed unstable/mostly zero
`process.memoryUsage().heapUsed` values; those misleading metrics
were removed rather than presented as memory-reduction measurements.
Quantitative peak RSS/GC comparisons remain an explicit gate.

**Critical result: host event-loop responsiveness.** A 2ms heartbeat
sampled timer-delivery gaps during three completed 60k-rich requests
per mode:

| Run | Host main-thread summary max gap | Worker-rich summary max gap |
| ---: | ---: | ---: |
| 1 | 194.82ms | 3.08ms |
| 2 | 200.03ms | 5.06ms |
| 3 | 211.83ms | 8.78ms |

An earlier independent run measured main-thread gaps
142.4/340.71/196.62ms vs worker 3.34/18.49/9.13ms. This is
persuasive **synthetic event-loop responsiveness evidence**, not
an Electron FPS measurement; actual UI throughput, startup,
cancellation propagation, and memory must still be certified.

**Remaining blockers for production routing:** worker-side task
deadline/cancellation semantics (a synchronous long iterator cannot
read a new cancellation message until it finishes), packed
Bun/Node/Electron worker entrypoint verification, durable DB
revisions/catalog updates, cross-host DB ownership, pool scheduling
with writer p99/WAL checkpoints, cold worker startup amortization
and measured peak memory. Keep the current single native reader
default. A future production adaptation should share the canonical
 fold/queries but must not expose this benchmark script directly as a
 public or supported worker API.

### Follow-on: streaming, mid-fold cancellation and actual bundled worker

The experimental rich worker now has two **test-only** execution modes.
`streamRows:false` materializes a native SQLite `.all()` array;
`streamRows:true` consumes a Bun SQLite `.iterate()` cursor directly
via the shared accumulator's `Iterable` input. No independent fold
was introduced. Both modes preserve exact rich response parity across
2K, 20K and 60K global/project workloads.

The worker integration test now covers **28 fixed and deterministic
random windows**, each in both materialized and streaming modes
(**56 complete worker response comparisons**) across global, p1,
p2, historical, unaligned clocks and hour/day resolution. All
responses pass the public UsageSummary runtime schema. For 60K global
records, three independent 5-sample worker medians measured
**214.81 / 212.14 / 200.06ms** with `.all()`, versus
**224.96 / 240.66 / 214.43ms** with `.iterate()`. Streaming offers
no measured speed advantage here, although it eliminates the
intermediate array of 60K generation objects. Bun's worker
`process.memoryUsage().heapUsed` returned unstable/zero values:
misleading memory measurements were removed and quantitative peak
RSS/GC evidence is still missing.

**Cancellation without the worker event-loop:** a task can carry an
optional `SharedArrayBuffer(4)` atomic cancel flag. The worker
checks `Atomics.load` every 128 records while iterating the
synchronous native SQLite cursor. A requested cancellation throws,
rolls back the pinned read transaction and emits `cancelled:true`.
A fresh request on the same worker then succeeds. A 10ms timer-based
trial initially cancelled before row processing, so the benchmark
was strengthened to send progress after 5,000 actual streamed
records, at which point the host sets the cancel flag. The observed
worker stopped after **5,120 of 60,000 records**, returning in
**32.24ms after dispatch**. An independent automated regression
seeds 25,000 ledger rows, cancels after native cursor progress,
asserts `1000 <= processed < 25000`, and verifies a subsequent
complete 25K response and clean worker recovery. This is a
validated *experimental worker cancellation*, **not** evidence
that HTTP disconnects already propagate to the shared flag.

**Actual bundling test:** `Bun.build({target:"bun"})` successfully
compiled the worker to a temporary JS entrypoint of approximately
2.17 MB. A complete benchmark then ran against the bundled
entrypoint through `OPENFORK_BENCH_USAGE_WORKER_FILE` instead of
the source-tree TS worker. It exited 0 after full scalar and rich
parity, streamed worker execution, cancellation and host event-loop
checks. The temporary bundle was removed. This validates a Bun JS
worker bundle, **not** a Windows compiled one-file binary, legacy
Node runtime or installed Electron/ACP sidecar.

**Production decision unchanged:** preserve the one-native-reader
default. Before routing real HTTP traffic through this optional
worker, extract a bounded, resource-owned protocol, wire
AbortSignal to the shared cancel flag, validate packed binaries,
pricing refreshes and DB revision semantics, and measure true
peak memory, startup, sustained p95/p99 writes and real renderer
responsiveness under concurrent sessions.

### Additional paired read and checkpoint evidence

- Repeated the paired hydration comparison after the one-Date reuse:
  60,000 full-ID rows **60.33ms median** versus ID-omitting compact
  rows **51.88ms median**, a second measured benefit of 8.45ms at the
  SQL hydration stage. The difference varies by machine load and is
  not a guaranteed complete Usage.summary speedup.
- The same complete-service benchmark after Date reuse measured
  **232.20ms cold median** for 60,000 global settlements and
  **950.14ms p95 completion** for 100 disjoint uncached requests.
  The earlier runs include a 223.07ms cold median and 1,042.91ms p95;
  run-to-run variability remains too high to attribute a precise
  full-endpoint speedup to either optimization.
- Repeated the **updated** Core WAL integration 10 times in separate
  Windows Bun processes, each with **1,000 foreground INSERTs**, two
  pinned read transactions, a nonblocking PASSIVE checkpoint, a
  successful post-read TRUNCATE checkpoint, explicit write rejection,
  and scoped worker/file cleanup. **10/10 processes passed**; per-run
  writer-call p95 ranged **0.112–0.138ms**. This increases evidence for
  native shutdown/checkpoint correctness but does not simulate
  long-duration busy production Session workloads.
- The final targeted compile using `tsgo --ignoreConfig --noEmit
  --skipLibCheck ...` for the new series and SQL projection modules
  and their tests exited 0. Frontend Usage tests remain **35 green
  with 1,143 assertions**. The backend-wide TypeScript checker exited
  2 with **31 diagnostics in unrelated concurrently edited modules**
  and none attributed to Usage files.

**Updated focused regression total:** 72 backend + 8 Core + 35 frontend
= **115 passing tests, 76,386 assertions, 0 failures**. This is the
final focused gate for these follow-on changes; broader release/HTTP
and renderer certification remains explicitly pending. The default
one-native-reader configuration and existing service endpoints were
unchanged; work was kept in the shared dirty tree without resets,
unrelated commits, or application restarts.