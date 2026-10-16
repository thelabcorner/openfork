# OpenFork Project Explorer — Performance/Architecture Closeout (2026-10-10)

**Scope:** the Project Explorer pane, file-tree presentation, cooperative full-workspace search and the app-owned file-tree store/operation admission. All edits are uncommitted in the existing shared checkout. Do not overwrite other active worktree lanes.

## Source of truth and transport ownership

- The backend filesystem index/search service remains the authoritative producer of workspace-wide candidate paths and metadata. The client does **not** recursively request file listings to reconstruct a whole-workspace search result.
- The client `createFileTreeStore` owns explicitly loaded directory children, metadata snapshots, watcher invalidation, bounded listing jobs, and per-workspace caches.
- The Project Explorer's search-only directory map is **presentation state**, not a second authoritative filesystem index. It synthesizes displayable ancestor nodes from indexed relative paths, without changing persistent filesystem expansion state.
- The mutation queue is an admission controller around an existing `FileOpsPort`, not a second filesystem executor. It never owns the actual mutation semantics.

## Implemented hot-path changes

1. **No-op list refresh**: unchanged child ordering and metadata skip node-index churn and Solid store mutations, while still validating `loadedEpoch`. An initial empty listing remains distinguishable from an unlisted/cancelled directory.
2. **Revision-owned search snapshot**: `allNodes()` returns an immutable-by-array cached snapshot per node revision. Async local search doesn't see a backing array modified mid-iteration; unchanged watchers avoid cloning 50k nodes.
3. **Search-only projection**: the search view shows server-discovered paths before loading their ancestor directories, maintains independent expand/collapse state, and supports paginated remote results with a `Load more` control.
4. **Cooperative projected hierarchy**: path expansion, per-row metadata reads and directory ordering are cancellable, scheduled slices (default 3ms). Wide buckets sort via 256-element runs and interruptible merges, not one unbounded native sort of 50k entries. The preceding synchronous builder is retained as a reference for parity tests.
5. **Incremental search-page accumulator**: a page only contributes newly fetched paths, not all previously fetched remote paths. Local-first and remote-first completions converge while old snapshots remain unchanged.
6. **Stable virtualizer key resolver**: a new `getItemKey` function appears only after the visible flattened rows change. Scrolling/option reads no longer spuriously invalidate 50k TanStack measurement entries. Rendering uses stable path-keyed DOM identity rather than ephemeral VirtualItem object identities.
7. **Stable row wrappers and viewport-only metadata reactivity**: cached row objects preserve referential identity across unchanged reflattening; search snapshots subscribe to live file-node metadata only for mounted viewport rows, not every candidate.
8. **Directory scheduling**: distinct FIFO interactive/background lanes and a reserved interactive slot avoid scanning a 1024-entry queue for each job. Existing queued background listings are promoted for an interactive request rather than duplicated; the upstream transport priority is also promoted.
9. **Prune scalability**: iterative subtree invalidation avoids recursive stack overflow. A wide deletion now invalidates cached descendant keys via ancestor-prefix membership, rather than the Cartesian product of deleted directories and cached directories.
10. **Bulk mutation backpressure**: large multi-select move/delete streams await settlement of at most 32 admitted operations per chunk, preventing the former silent overrun of the panel's bounded 512-job queue. Panel teardown resolves queued promises. The default not-implemented backend rejects admission early, avoiding massive rejected-operation/toast floods.
11. **Search safety and UX**: workspace-relative path validation blocks absolute/traversal entries, synthesized absolute paths use the selected workspace root, root list errors don't mask independent indexed search, root list errors require explicit retry, and selecting unloaded server search results survives query changes.
12. **Store-owned directory change journal**: the domain tree publishes bounded, revisioned path invalidations for watcher listing changes, expand/collapse, reset, scope switches and trimming. Consumers replay affected directories; missed history and ambiguous states force an authoritative full rebuild rather than inventing tree state.
13. **Incremental live row projection**: a single directory update regenerates only that visible branch. Unaffected row identities survive; hidden branches are deferred until expansion. A duplicated or malformed cross-parent path forces a full traversal. Array splicing and locating the changed directory remain O(visible rows) worst case; this is a *localized traversal* optimization, not an order-statistic rope.
14. **Constant-time directory child-cache hits**: invalidate materialized children explicitly on structural or metadata mutations, rather than comparing every child node whenever the tree reads a cached directory array. First/empty/same-order metadata semantics have regression tests.
15. **Focused-row lookup instead of full index map**: scrolling uses a memoized scan to find one focused path per visible-list revision, rather than allocating a 50k-entry path/index map. Shift-range and navigation use two direct lookups. Existing bulk node lookup stays lazy.
16. **Lazy cooperative search traversal**: even a 50k-wide root no longer executes a synchronous `toReversed().map()` of row wrappers before yielding. A bounded stack of array cursors materializes only visited nodes in each slice; duplicate cycles terminate.
17. **Stack-safe live-tree trimming**: the subtree-eviction walk is iterative and cycle-guarded instead of recursive, preventing pathological depth from exhausting the JS stack.
18. **Root-only list reconciliation**: a root metadata refresh can reuse entire unchanged expanded-directory row spans instead of re-reading descendants. When the journal also contains nested edits, the consumer deliberately falls back to a full rebuild. This is a modest isolated CPU gain but avoids reactive reads across unrelated directories.
19. **Batched directory-change coalescing**: duplicated directory invalidations and descendants subsumed by an invalidated ancestor are consolidated before local row replay, while preserving a correctness fallback for mixed root/nested changes.
20. **Lazy legacy search row materialization**: a frame-cursor traversal replaces the eagerly allocated `toReversed().map()` 50k-row root stack, eliminating an observed 20ms+ uninterrupted preparation phase; an instrumented 50k-node test verifies no eager root traversal before the first yield.
21. **Authoritative own-directory metadata refresh**: a changed directory journal entry now re-reads the directory's own node by O(1) store key, even if collapsed or its children are identical. Type transitions remove stale descendants. A seeded differential fixture exercised 1,000 watcher/root/reorder/collapse/metadata actions against a full preorder after every mutation.
22. **Append-only versioned search sets**: snapshots of page N retain immutable membership, iteration and size while page N+1 appends paths. One path-to-first-insertion-ordinal index replaces O(total prior matches) Set cloning per page; the projection accepts read-only iterables rather than assuming a native Set. Directory-only hits maintain complete ancestor closure. The existing pure full-set merge remains a reference/test utility.
23. **Demand-only context-row indexing**: removing an eagerly evaluated 50k-entry Solid memo avoids rebuilding the full lookup Map on ordinary watcher refreshes. Single-path gestures scan the existing array; an index is built and cached only for selections/batches of at least 16. On an isolated 50k-row lookup fixture, median full-map build was 6.018 ms against 0.428 ms for a direct scan (not an Electron event measurement).
24. **Pre-normalization search-path validation**: absolute Unix, Windows drive and UNC paths, parent traversal, dot segments and NUL are rejected at the accumulator boundary *before* the generic key normalizer can strip root slashes. Both synchronous and cooperative projectors use the same defensive validation; regression tests cover malformed server results and in-flight immutable page snapshots.
25. **Structural-sharing search-page hierarchy projector**: a new cooperative delta builder overlays changed nodes on the previous model's indexed hierarchy; it copies the lightweight parent-directory map and merges only affected sorted sibling buckets, leaving all untouched arrays and published models intact. Directory/file type promotions, wide buckets, stale-generation cancellation and exact preorder parity are regression tested. When the delta exceeds 2,048 input paths or the persistent node-index chain reaches depth 12, the existing cooperative full projector rebases safely. Initial full builds now provide a private node index.
26. **Watcher-reconciled active search**: the file store exposes its node revision; the explorer independently tracks that revision while keeping the remote query generation and pagination cursor. A 140 ms debounce coalesces watcher bursts, scans the refreshed local index cooperatively and reconciles local matches without discarding remote hits. Additions extend versioned snapshots; removals cause an immutable snapshot rebase with a full hierarchy rebuild. In-flight pages are replayed before a rebase commits. Initial local result ingestion and removals both use time-sliced processing; superseded work can be cancelled.
27. **Incremental search-folder visibility**: collapsing/expanding one directory splices only its visible subtree while retaining unaffected row identity. Collapse All and multi-folder changes retain the canonical full flatten fallback. Tests compare 500 seeded folder toggles and a 50k-row collapse/expand against the unoptimized reference.

## Measured scope and reproducible benchmark

From `packages/app`, run `bun scripts/bench-project-explorer.ts`.

| Isolated 50k-row case | Recorded result |
|---|---:|
| Synchronous reference search projection (median, 5 runs) | 40.903 ms continuously |
| Cooperative projected search | 113.907 ms total, 34 slices, **2.071 ms max slice** |
| Live flat-tree reflatten (median, 8 runs) | 7.526 ms |
| TanStack 30 option updates with unstable key-function identity (median) | 22.774 ms |
| Same 30 updates with stable key-function identity (median) | 0.065 ms |
| One-directory watcher refresh, 50k visible rows, full flatten (median) | 17.865 ms |
| Same change, incremental live view (median) | **0.877 ms** (about **20.4×** faster) |
| Later repeated local watcher fixture, full vs incremental | 10.453 vs **0.506 ms** (about **20.7×**) |
| Root-only metadata refresh, full vs incremental (50k rows) | 7.177 vs 5.904 ms (about 1.22×) |
| One context-row lookup, 50k entries, eager Map vs direct scan | 6.018 vs **0.428 ms** (about **14.1×**, isolated) |
| 50 indexed search pages × 1,000 paths, cumulative Set copying vs append-only snapshots | 35.696 vs **19.065 ms** (about **1.87×**, isolated) |
| Search hierarchy, add 1,000 paths to 50k, full vs incremental cooperative median (first comparison) | 178.649 vs **14.472 ms** (about **12.3×**) |
| Search-folder collapse + expand on a 50k-row corpus | 8.005 vs **1.841 ms** (about **4.3×**) |
| Watcher-removal rebase, 50k cumulative paths: synchronous blocking vs cooperative processing (later run) | 33.6 ms blocking vs 77.3 ms elapsed; max observed uninterrupted callback 17.9 ms |

These are isolated Bun microbenchmarks on the checkout workstation. They are **not** measured Electron frame times or end-to-end workflow gains. The cooperative projector trades increased elapsed time for shorter uninterrupted main-thread work. A later isolated run on the same benchmark reported ~17.9 ms full vs ~0.88 ms incremental while concurrent machine load varied. Historical earlier-lane isolated measures (different runs/conditions): ~12.5× faster incremental result projection and ~19% less time for repeated unchanged 3000-item force-list refresh.

**Run-to-run variation matters**: the repeated search-hierarchy benchmark has shown 158–187 ms full and 13.6–23.2 ms incremental medians; occasional slices exceed their requested 2–3 ms budgets, likely due to execution/GC/scheduling pauses. The watcher rebase is cooperative, *not* a hard real-time guarantee. Its end-to-end elapsed time can increase because it yields. The 50-page accumulation comparison also varies significantly under different memory loads; do not treat any individual ratio as a production guarantee.

## Correctness gates

- **139 passing tests, 2,401 assertions** across eleven package-local test files (latest checked run): tree/model/search hierarchy/row visibility/bulk dispatch, tree store, watcher, buffer cache and markdown height. Includes 1,000-step live-tree differential checks, 500 seeded search-folder toggles, 12 incremental search pages, 50k-wide sibling merges, cancellation, immutable prior snapshots and a 50k loaded/remote watcher-rebase race.
- `bun run typecheck` from `packages/app`: **exit 0 on the latest checked run**, including all Explorer changes.
- `git diff --check` for modified tracked explorer files: exit 0.
- A three-file additional Bun test run (`file-tree.test.ts`, `project-explorer-media-zoom.test.ts`, `project-explorer-svg-element.test.ts`) fails before test execution because the current standalone Bun TSX test transform imports `jsxDEV` from `solid-js/dist/solid.js`, where it is not exported. This is a **test harness blocker**, not proof of an explorer regression or pass.
- No Electron/desktop/sidecar restart was performed.
- Passive probe for the existing CDP debugger at `127.0.0.1:9222/json/list` timed out; the browser end-to-end gate remains unavailable through that route in this run.

## Negative architectural invariants

- Searching unloaded ancestor paths: **zero directory list requests caused by search-only expansion**.
- Obsolete async generations: **zero committed results** after cancellation.
- Sibling key resolution: **no measurement-key function identity churn** without a visible-row revision.
- Plain multi-selection bulk stream: **no unbounded outstanding batch count**, and no silently dropped remainder on queue overflow.
- Canceled/dropped directory request: never applied as an authoritative empty listing.
- Remote indexed path: never becomes an actionable absolute, root-escaping, or parent-traversal path.
- Project change: old scope's selection and search projection must not leak into the next scope.

## Remaining architectural work — not yet verified or claimed complete

1. **True sublinear row splicing/lookup**: localized traversal is now incremental and source-owned, but flattened row-array `slice/concat` and changed-directory `findIndex` still cost O(visible rows) in the worst case. To eliminate them requires a correctness-tested order-statistic rope/chunked tree with virtualizer-compatible indexed lookup, focus and range selection, watcher reorder/move/remove, drag/drop and concurrent scope changes. Current isolated localized watcher updates are already well under a frame budget (~0.88ms median at 50k rows).
2. **End-to-end Electron performance and fidelity gate**: profile real project sizes (1k/10k/50k+ nodes), incremental watcher bursts, 25/50/100 simultaneous working sessions, resize/scroll/focus, high-DPI and screen readers. Measure P50/P95/P99 input-to-paint, JS long tasks, memory retained and request counts. Do not restart or disrupt a running desktop/sidecar.
3. **Dedicated browser automation fixture** exercising pointer drag/drop, inline rename/create/delete, search paging, folder toggles, keyboard range selection, retained focus and project switches. Current pure-unit tests cannot sign off the DOM behaviors.
4. **Bun TSX test harness repair** for standalone tests failing on `solid-js` `jsxDEV` module export. Must use the app's established Solid compilation mode rather than changing production JSX semantics ad hoc.
5. **Batched durable mutation contract** for 10k+ files: beyond renderer admission, a real backend should expose transactional/batched operations, progress, individual failures and cancellation. The present FileOpsPort may still execute one operation per selected file, though admitted safely.
6. **Server-index freshness after deletion**: watcher reconciliation removes stale *local-only* matches, but a deleted path still present in the previously fetched server-index pages is retained until a query/reindex refresh. The backend should expose targeted index revisions or invalidation semantics so the remote set can be corrected without resetting the entire search.
7. **Large-result search pagination cadence**: after twelve cumulative deltas, the bounded persistent node-index depth intentionally triggers a full cooperative rebuild. A future stable bucket-index/compaction scheme could rebase only metadata without revisiting unchanged rows. Full visible-row arrays and occasional wide-bucket merges are still O(N).
8. **Time-slice tail latency**: even with cooperative checkpoints, occasional isolated callbacks have exceeded the requested budget under allocator/runtime pressure. Run controlled Electron traces with JS long-task attribution and heap allocation sampling before describing the projector or local rebase as frame-budget certified.

No overall percentage completion or production throughput improvement is claimed without those gates.

## October 10 continuation — weighted row index, invalidation and queue safety

The live explorer now uses a weighted indexed preorder sequence rather than eagerly rebuilding a complete visible-row array on every watcher change. The search explorer uses the same indexed representation for collapsed-folder updates. Its 128-row chunks carry subtree weights and packed path positions, supporting expected O(log chunks) positional access and preserving existing row identities. Normal viewport rendering does not materialize a full array; large range/bulk gestures explicitly request one. A separate key-version distinguishes changed metadata from changed ordered path keys, so TanStack measurement keys remain stable for same-path watcher changes.

An adversarial 50k-row / 5,000-edit workload exposed severe historical chunk fragmentation: **7,862 retained chunks** versus 391 initially. Local coalescence at the edited boundaries now retains **666 chunks** on the same generator, without a global compact pass. A bounded 3x fallback remains for adversarial cases not covered by local merges. Same-path metadata replacement now writes an existing chunk in place, without split/merge allocations.

Completed directory-listing journal events report authoritative removed roots and directory-to-file conversions. Search invalidates their stale remote-index descendants, without treating directory collapse or missing local cache entries as deletion. Conservatively retained tombstones mean that a re-created path may remain excluded from remote pages until query restart; its locally discovered match remains visible. A producer-owned file-index revision is needed before safely lifting tombstones for re-created paths.

The mutation queue is now a standalone tested unit. Backend failures settle false and stop following bulk chunks, and teardown settles queued plus in-flight receipts even when an underlying backend Promise never resolves. It does not claim to cancel an in-flight filesystem request.

### Latest isolated benchmarking

| Benchmark | Old dense projection | New indexed projection |
| --- | ---: | ---: |
| 50k-row localized metadata refresh, median | 0.386 ms | **0.050 ms** |
| 50k-row root-only metadata refresh, median | 7.689 ms | **0.679 ms** |
| 200 search-folder toggles, P95 | 1.974 ms | **0.587 ms** |
| 200 search-folder toggles, median | 0.267 ms | 0.258 ms |
| 5k random edit fragmentation at ~50k rows | 7,862 chunks | **666 chunks** |

The 50k-row indexed view retains additional map/chunk memory relative to a dense array. Full virtualizer rekeying can still require O(N) key reads after an actual structural change; a sequential chunk cursor amortizes adjacent indexed reads. These are **isolated Bun microbenchmarks, not Electron input-to-paint measurements**; absolute values and outliers vary by run.

**Latest validation:** 161 tests passed, 0 failed, 32,009 assertions across 16 files, including 5k randomized indexed splices, 500 search toggles, 1k watcher mutations, auth-originated deleted-path propagation, virtualizer key identity and queue teardown/failure races. Package TypeScript passed; the tracked-diff whitespace check passed. Standalone TSX Bun test imports still have the independently reproduced jsxDEV transform issue. Existing desktop CDP endpoint at 127.0.0.1:9222 was unavailable; no desktop or sidecar restart was attempted.

**Remaining gates:** actual renderer frame-time/scroll/focus/keyboard/drag tests, memory and initial projection cost at 1k/10k/50k across simultaneously mounted sessions, backend-owned revisions for remote reappearance, batched durable filesystem mutation operations, and a corrected Solid TSX browser test harness. The previous numbered worklist contains historical gaps now closed by this continuation; this section supersedes those items.

### Additional indexed-consumer and cold-start findings

The explorer's bulk context-menu path lookup no longer materializes an additional 50k-row Map: both search and live views already maintain an indexed path→row projection. Keyboard arrow navigation now accesses the single target row by index, and Shift-range selection traverses only the selected interval; neither needs a full-array materialization. Select All intentionally continues to scan all visible rows because its output is itself O(N).

Isolated cold-construction microbenchmarks from an **already-loaded authoritative directory graph** (seven repetitions each, medians) found:

| Visible rows | Previous array projection | New indexed projection |
| ---: | ---: | ---: |
| 1,000 | 0.112 ms | 0.145 ms |
| 10,000 | 2.162 ms | 1.572 ms |
| 50,000 | 12.068 ms | 11.654 ms |

This does not measure filesystem indexing, network, sidecar warmup or Electron renderer presentation. The small 1k case favors the dense representation slightly; measured 10k/50k cold projection costs do not justify adding a hybrid at this time. Startup, memory retention, many mounted panels and input-to-paint still require in-app proof before claiming a production improvement.
