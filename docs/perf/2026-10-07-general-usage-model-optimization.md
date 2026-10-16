# General Usage Modeling — Producer-path Performance Optimization

Date: 2026-10-07  
Scope: OpenFork general-capacity workload model, personalized usage-yield statistics, and Core snapshot reuse.  
Owner: `packages/opencode/src/capacity/general-usage.ts` and `packages/core/src/usage/yield-statistics.ts`.

## Ownership and invariant

Authoritative chain:

1. Settled user-facing usage is persisted by Core's usage record / yield materialization.
2. `UsageYield.list()` reads compact `usage_yield_stat` rows and **already finalizes active session blocks**.
3. `Capacity.general` consumes the process-global, revision/watermark-cached yield list.
4. `GeneralUsage.build` derives the bounded general workload profile (latest 128 physical requests), its ESS, request/owner bands, and up to 128 direct-model estimates.
5. Bootstrap-free Tier-0 capacity HTTP consumers and the model-picker UI read the small snapshot; the UI does not rescan message history.

Do not replace this path with renderer-side historical message reconstruction, per-model fetches, or a cache that ignores cross-process SQLite watermarks.

## Changes

- **No duplicate session finalization:** `GeneralUsage.build` no longer calls `snapshotYieldStatistic` on each entry. For a raw entry it derives the half-life-8 session ESS directly from the two decayed weight scalars:
  `w' = rho*w + 1`, `q' = rho^2*q + 1`, `ESS = (w')^2 / q'`. For a previously finalized entry it reads the unchanged scalars. This is exactly the weight projection of the existing full finalize operation without updating five unneeded cross-product matrices.
- **Already-finalized Core snapshot reuse:** `snapshotYieldStatistic` returns its input reference when `activeCount <= 0`, avoiding pointless wrapper allocation on repeat snapshots.
- **Bounded model selection:** retain only the 128 best direct estimates in a worst-first heap, using the same descending update time and ascending provider/model tie ordering as the previous full sort. Population count and scope quantiles still account for *every* mature model.
- **Exact recent-request pruning:** first collect each account-neutral scope's maximum timestamp from its *actual retained vectors*, then process scopes newest-first. Once 128 positive-token requests have been retained, any remaining scope with `maxTimestamp < oldestRetainedTimestamp` cannot displace the heap root. This avoids conversion, temporary objects and heap comparisons for stale observations. Strict inequality retains all timestamp-tied candidates and deterministic identity tie-breaking. It does not trust `updatedAt`, which may differ from observation timestamps.
- **Streaming quantiles and corpus:** determine the 10th and 90th weighted-percentile tails in one ordered pass per token dimension rather than independently sorting each; select 16 representative workloads with a forward-moving cumulative-weight cursor instead of repeatedly restarting the scan.
- **Fewer hot-path allocations:** no callback closure for every model's recent loop, no intermediate five-element mean vector, short-circuit immature scope statistics.

### Correctness argument for chronological pruning

Let `H` be the max-heap's least-preferred retained candidate among the 128 globally newest valid requests, and let `t_H` be its timestamp. For any unprocessed scope `S`, every retained request timestamp is bounded by its measured `max(S)`. After ordering scopes by descending `max(S)`, if `max(S) < t_H`, every remaining request is strictly older than `H`; none can improve the top-128 set under a comparator that prioritizes recency. Thus stopping is lossless. A zero-token or invalid-tokens vector can only make `max(S)` more conservative, never unsafe.

## Synthetic measurement

Command: `bun run script/general-usage-benchmark.ts` in `packages/opencode`. Runtime observed: Bun `1.4.3-canary.1` (Windows). 3 warmups / 20 timed builds, synthetic independent-session data, full 100 / 500 / 8,000 scopes. The benchmark now reports both **raw** inputs and **finalized** inputs (the latter matches `UsageYield.list()` production semantics), wire payload size, scope/corpus count, median and p95.

| State kind | Scopes | Original median | Original p95 | Optimized median | Optimized p95 |
|---|---:|---:|---:|---:|---:|
| Raw | 100 | 0.989 ms | 1.615 ms | 0.639 ms | 1.859 ms |
| Finalized | 100 | 0.762 ms | 1.098 ms | 0.420 ms | 0.754 ms |
| Raw | 500 | 4.572 ms | 6.732 ms | 0.838 ms | 0.961 ms |
| Finalized | 500 | 2.343 ms | 3.265 ms | 0.909 ms | 1.494 ms |
| Raw | 8,000 | 65.229 ms | 77.811 ms | 21.824 ms | 30.625 ms |
| **Finalized** | **8,000** | **40.505 ms** | **46.789 ms** | **17.791 ms** | **22.994 ms** |

The original implementation was recovered from repository HEAD for the separate baseline run and then removed from the working tree. The production-representative 8,000-scope comparison is ~2.28x faster at the median (56.1% lower). The benchmark is synthetic, sequential rather than perfectly interleaved; process scheduling, CPU thermal state, and GC produce run-to-run variation. Do not extrapolate these figures to complete HTTP, SQLite deserialization, or renderer latency.

Earlier raw-only passes measured ~90.95 ms baseline vs ~32.56 ms optimized at 8,000 scopes; those compare raw inputs and **are not production-path proof**. The finalized comparison above supersedes that as the primary metric.

## Verification

- GeneralUsage tests include standardized fallback, account overlay exclusion, session-cluster maturity fail-closed behavior, deterministic order and fingerprints, 128-scope capacity bounds, 128-request cap, same-timestamp model ordering, exact session-ESS parity against full Core snapshot, and out-of-order/zero-token pruning invariance.
- Core statistics tests verify idempotent reference reuse for an already-finalized snapshot and existing weighted-statistics identities; Core rebuild parity test passes.
- Executed suites: **12/12** GeneralUsage tests; **8/8** Core statistics + rebuild tests; **31/31** Tier-0 ownership tests (including generalized usage with zero workspace-instance creation). Total: **51 passed, zero failed**.
- Core and server package-wide TypeScript checks have existing unrelated errors elsewhere in the concurrently modified repository; no diagnostics in the changed usage files were observed in the executed checks.
- Full-repository `git diff --check` is blocked by unrelated whitespace in concurrent changes. The scoped diff check for these usage changes passed.

## Remaining release-level evidence

1. Profile the actual Tier-0 response (p50/p95/p99 and allocation) with settled usage records and a live sidecar; measure DB deserialization and query/cache hit ratio separately from `GeneralUsage.build`.
2. Stress multiple writers and verify UsageHistoryWatermark invalidation after external commits and rebuilds.
3. Assess very large persisted model populations and low-maturity distributions to determine whether a durable incremental snapshot is justified; do not create a second state store before profiling the current global watermark cache.
4. Validate CPU, memory and responsiveness under real session traffic. No claim of an installed binary reload or release readiness is made by these synthetic tests.
