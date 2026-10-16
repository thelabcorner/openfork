# OpenFork timeline rendering: algorithmic optimization campaign

Date: 2026-10-12
Scope: the shared `opencode` checkout, uncommitted work preserved.

## Targets and invariants

- A streamed content delta must not trigger an O(history) measurement calculation without a real structural or size change.
- A large assistant-turn replacement must not repeatedly splice the same owner-index array.
- Equal-key row reconciliation must preserve old immutable row instances.
- A virtualizer count/scroll-element transition must not crash Solid keyed reconciliation by reading `undefined.index`.
- A visible range must remain ordered, unique, and bounded; initial, append, delete, resize, and reconnect semantics must remain intact.
- User-controlled scroll/viewport anchoring must not regress.

## Implemented

### 1. Bulk index-suffix truncation

`row-index.ts` defines `truncateTimelineRowIndexes(indexes, rows, start)`. `projection.ts` calls it when replacing a tail turn.

Former path: for every removed row, search the owner's ordered index array and splice one entry. Worst-case O(R*S) shifts for R rows owned by one message and S removed rows; O(R²) for a complete turn removal.

New path: drop removed key mappings once, group affected owners once, truncate each owner's ordered positions with binary search, and restore its surviving last assistant group. Cost O(S + sum(log R_owner) + predecessor-group lookback), with an O(1) map-clear operation for a complete index reset. Does not scan unrelated owners.

A full-rebuild equivalence test runs all 161 cut boundaries for 160 interleaved Context/Assistant rows, comparing all six indexes; additional tests cover tail replacement and bounds.

### 2. Aligned row reconciliation

`row-reconciliation.ts` checks stable positional row keys first. It returns the previous array for entirely equal descriptors and retains unchanged row references even if one descriptor changed. A key insertion, removal, reorder, or context split/merge falls back to the original map-based reconciliation.

Time complexity remains O(rows) for the aligned comparison, but it avoids temporary Maps, Sets, and a whole-array reconstruction in the common case.

### 3. Memoized virtualizer getItemKey

`virtual-item-key.ts` exposes `createVirtualTimelineItemKey(projection)`. `message-timeline.tsx` passes its accessor to TanStack.

Previously, a reactive getter built a fresh callback each time it was read. Installed `@tanstack/virtual-core@3.17.3` explicitly tracks `options.getItemKey` identity in `getMeasurementOptions()`, and `getMeasurements()` calculates `count` positions when that dependency changes. The memo now issues a callback only when the row projection notifies, including equal-count structural reorders. Scroll-only updates retain its identity and can reuse the cached geometry. Tests verify both cases.

### 4. Adapter-level virtual item admission

`safe-solid-virtualizer.ts` implements the installed adapter lifecycle, with `sanitizeVirtualItems` before `reconcile({ key: "index" })`. The normal ordered, bounded input passes through unchanged without another array allocation. Only an exceptional sparse/invalid/disordered window uses a Map and sorted normalization. Main timeline now uses this adapter.

This check must occur inside the adapter. Filtering in the timeline renderer itself is too late: the stock Solid adapter already dereferences `item.index` in keyed store reconciliation.

### 5. Linear range union

`mergeVirtualIndexes(visible, pinned, active, count)` replaces temporary extras arrays, conditional sorting, merging, and a second filter. The pinned-state path performs a three-way sorted merge in O(V+P+1) time. The common zero-pin path reuses the caller-owned visible index list or inserts one active item with a binary search, eliminating unnecessary allocation. A seeded test compares 2,000 generated windows to an independent sorted/deduplicated oracle.

`projection.ts` also replaces `projectedTurnRows.slice(0,-1).every(...)` with a no-allocation positional prefix check.

## Reproducible benchmarks

Run from `packages/app`:

```powershell
bun src/pages/session/timeline/row-algorithms.bench.ts
bun src/pages/session/timeline/virtualizer-key-identity.bench.ts
```

Measurements below are isolated Bun microbenchmarks on the same checkout, not end-to-end frame timings. Figures vary with warmup, JIT, and concurrent machine load.

### Recorded algorithm benchmark (second run)

| Workload | Reference | Optimized | Speedup |
| --- | ---: | ---: | ---: |
| Equal-key reconcile, 1k rows | 0.321 ms | 0.188 ms | 1.70x |
| Equal-key reconcile, 5k rows | 2.498 ms | 0.611 ms | 4.09x |
| Equal-key reconcile, 20k rows | 20.193 ms | 8.170 ms | 2.47x |
| Suffix-index case, 20k rows, no surviving prefix | 49.381 ms | 9.770 ms | 5.05x |
| Suffix-index case, 20k rows, 10k surviving prefix | 31.872 ms | 12.546 ms | 2.54x |
| Virtual range union, 12k calls, zero resize pins | 7.847 ms | 2.006 ms | 3.91x |
| Virtual range union, 12k calls, 24 resize pins | 17.811 ms | 10.717 ms | 1.66x |
| Virtual range union, 12k calls, 96 resize pins | 52.260 ms | 40.986 ms | 1.28x |

Suffix-index benchmark includes building the initial indexes for each reference and optimized sample; isolated removal-only timing previously measured 12k rows at 25.115 ms versus 6.048 ms before the additional full-clear optimization.

### Key-callback measurement memo test

| Rows | Stable callback | Fresh callback |
| --- | ---: | ---: |
| 10,000 | 0.0086 ms | 1.4282 ms |
| 50,000 | 0.0021 ms | 8.8955 ms |
| 100,000 | 0.0023 ms | 21.1421 ms |

This **isolates skipped virtual-core measurement recomputation** using null scroll elements; it is not a claim that UI rendering is 9,000x faster. Benefits depend on how often options updates previously supplied new callbacks.

The initial generic three-way merge benchmark was slower with zero pins (0.76x). That regression was corrected with the dedicated zero-pin fast path; the subsequently measured result is 3.91x.

## Verification

```powershell
bun run typecheck
bun run typecheck:e2e
bun test --conditions=solid --preload ./happydom.ts ./src/pages/session/timeline/row-index.test.ts ./src/pages/session/timeline/row-reconciliation.test.ts ./src/pages/session/timeline/projection.test.ts ./src/pages/session/timeline/virtual-items.test.ts
bun test --conditions=browser --preload ./happydom.ts ./test-browser/safe-solid-virtualizer.test.ts ./test-browser/virtual-item-key.test.ts
bunx playwright test e2e/regression/timeline-virtualizer-continuity.spec.ts --grep "Shell command|never paints an empty" --workers=1 --reporter=line
```

Observed: 24/24 targeted projection/index unit tests, 4/4 dedicated browser-adapter tests, 2/2 selected Playwright Chromium checks, and typechecks passed at the last checkpoint before the range-union addition. Re-run the commands above against any subsequent concurrent changes.

## Remaining certification gap

The original 26-second capture's exact full-rate scroll/stream/remount sequence has not been replayed under a frame-by-frame browser gate against this patch set. The SSE-dependent streaming/scroll-continuity Playwright test was attempted on 2026-10-12 and failed before test actions: `setupTimeline()` timed out after 60 seconds at `e2e/utils/sse-transport.ts:250`, waiting for a mocked SSE connection. This is a harness blocker rather than proof of a rendering failure or successful remediation. The two non-SSE Chromium checks (Shell command visibility and Shell-expand/resize empty-window gate) passed. No changes were committed because this is a concurrently edited shared worktree.

## Relevant implementation contract

The installed core version (3.17.3) includes `getItemKey` in `getMeasurementOptions` memo dependencies and indexes directly into `measurements` when building `getVirtualItems`; the installed Solid adapter keyed-reconciles that result. TanStack's published Virtualizer API recommends stable item keys, supports `initialMeasurementsCache`/offset restores, and documents overscan tradeoffs:

- https://tanstack.com/virtual/latest/docs/api/virtualizer
- https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts
