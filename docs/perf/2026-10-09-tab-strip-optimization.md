# Tab strip performance — 2026-10-09

## Ownership and scope

This pass targets the desktop/new-layout titlebar tab strip without changing
the canonical V1 execution owner or any transport. The data paths are:

- Server project state and sync metadata -> server-owned enriched project list
  -> one memoized ID/directory index per server -> each session tab's project
  label and avatar. No history fetch is introduced.
- SessionGroup list/detail projection -> one memoized group-ID index -> group
  tabs and consumers of `byID`. The original first-duplicate-ID precedence is
  retained.
- Persisted tab order plus current per-tab visibility -> one memoized order
  projection -> sortable indices, keyboard order, drag navigation and full
  reorder inputs. Hidden slots retain their original positions.
- SessionGroup projection -> preview relationships/index **only while the
  preview is open**. Closed previews do not maintain reactive membership scans;
  group previews do not build a session-ID index.

The first pass changed no API, streaming, hover-prefetch, drag sensor,
navigation timing, session lifecycle, or layout CSS behavior. The follow-up
below intentionally changes only preview *ownership/lifetime* and offscreen
spinner animation state; no transport or execution policy changes.

## Reproducible microbenchmark method

Run the legacy `projectForSession` against `projectForSessionIndexed` from
`packages/app/src/pages/layout/helpers.ts`. Use 256 projects, with two
sandbox paths per project; alternate execution order, warm up before measuring,
and report median elapsed milliseconds across repeated trials. The indexed
case builds its index once per project-list revision, never per session update.
The preexisting functions remain available for differential tests.

Hot lookup simulation: one fixed project-list revision, 1,000 metadata updates
for each tab. Measurements on the Windows development Bun runtime:

| Tab count | Previous (ms) | Indexed (ms) | Speedup |
| ---: | ---: | ---: | ---: |
| 1 | 10.939 | 0.030 | 365.86x |
| 3 | 36.597 | 0.072 | 506.19x |
| 6 | 90.715 | 0.143 | 635.26x |
| 8 | 118.992 | 0.192 | 620.07x |
| 32 | 620.773 | 0.793 | 783.11x |

The separate 256-group lookup simulation, with 1,500 reads per tab, measured
approximately 10x faster for one group tab and 32x for eight group tabs.
With 256 projects and a **project-list rebuild every iteration**, the shared
index had an amortization trade-off: ~0.33x for one tab, ~2.67x for eight
tabs, and ~12.55x for 32 tabs. Thus project-list revision costs are not
universally faster; the optimization targets frequently changing sessions and
stable project catalogues.

The single-pass tab-order projection measured about 1.2x–1.5x faster across
1–96 tabs in a synthetic benchmark that included all three previous key
generations (visibility, sortable index and shortcut IDs). The measurement is
for the projection work, not entire UI frames.

**These are isolated, warm JavaScript microbenchmarks, not Electron renderer
FPS, p95 tab-switch latency, or sidecar E2E measurements.** No claim of full
1/3/6-concurrent-session performance closure is made until actual Electron
trace and interaction measurements are captured. Do not confuse 10x–700x
lookup wins with comparable end-to-end tab-switch speedups.

## Correctness and negative invariants

- Differential tests retain ID-vs-directory lookup priority, first directory
  and last ID duplicate behavior, sandbox fallback, mixed Windows paths, and
  no-project behavior across colliding/generated fixtures.
- Tab-order tests retain hidden tab positions, first-match navigation,
  last-match sortable indices, and visible shortcut order.
- The initial index/projection pass introduced no observer, per-tab timer,
  network request, shared stream, session history hydration, or implicit
  workspace instance. The follow-up adds **one strip-wide intersection
  observer and one direct-child mutation observer**, with explicit disposal.
- Session progress and attention continue to use the existing compact store;
  preview relationships are computed only from the already-batched group
  projection while active.
- The existing tab gesture tests cover close/state-action exclusion from drag,
  middle/pointer semantics, and ref forwarding.

The focused Bun/Happy DOM tests and app TypeScript build are used as the
reproducible local gates. Existing unrelated tests importing UI dependencies
currently fail **before these edits** with `Export named 'jsxDEV' not found`
in the installed SolidJS runtime, so their failures cannot be claimed as
regressions or passes. The app and sidecar were not restarted (per app
`AGENTS.md`). A later Electron integration run must exercise cold and hot
tab switching, hover previews, drag/reorder, session work/paused state, and
overflow with 1/3/6+ simultaneously working sessions.

## Follow-up pass: hot lifecycle, status, and animation ownership

The second, concurrency-oriented pass retains the same production V1 session
owner and the Solid V2 presentation. Source-level changes:

1. **Group preview runtime is demand-created**. Previously every group tab
   instantiated a full Kobalte hover-card and group-query subtree at idle;
   group and session tabs now bootstrap the lazy preview runtime only after
   the established dwell window. The closed preview subtree is disposed after
   normal Kobalte closure, with a microtask guard against immediate reopen.
   The existing context-menu-open guard and safe-area bridge remain inside
   `TabPreviewPopover`. Shared hover timing lives in
   `titlebar-tab-preview-timing.ts`: 450ms cold, 500ms skip window.
2. **Per-tab rename mutation observers removed**. The rename path only needs
   one mutually exclusive async action; it now tracks the pending flag in the
   tab owner (with `finally` cleanup), avoiding a TanStack mutation observer
   per open session tab. Backend rename/optimistic update/toast behavior is
   unchanged.
3. **Avatar server-state fan-out reduced**. Titlebar avatars receive the
   existing server context from their tab owner instead of scanning every
   connection again. Permission and question tests share one memoized
   directory child index rather than visiting the child-store twice.
4. **Pending-request root fast path**. In `session-request-tree.ts`, check
   the requested session's own permission/question before BFS walking nested
   delegated descendants. Keep the previous two-phase BFS path for sparse
   and absent matches: a fused traversal was experimentally slower in the
   no-request case and was rejected. Preserve first-request BFS precedence,
   request filters, cycle protection, and array/map compatibility.
5. **Offscreen spinner suspension**. Every working session's 5×5 indicator
   animates 25 SVG rectangles. `titlebar-tab-visibility.ts` owns exactly
   one `IntersectionObserver` rooted in the scrolling strip and one
   `MutationObserver` watching direct slot insertion/removal. The CSS
   animation is paused only for fully clipped slots; rendered visual details,
   tab status, DOM ownership, and accessibility remain unchanged. Both
   observers and any cached DOM attributes are removed on teardown; when
   observers are unavailable, the original animation behavior is retained.
6. **Long-window bounded visibility state**. The strip prunes visibility
   flags for removed tabs only when the tab collection changes. There is
   no per-session update scan and no requirement to keep historical flags
   after the tab component is disposed.

### Request-tree isolated measurement

Reproduce with `bun run benchmarks/tab-strip-request-tree.bench.ts`
from the repository root. The benchmark embeds the original BFS algorithm,
alternates implementation order, warms both paths, checks result parity, and
reports medians.

Windows development Bun; 128 immediate descendants; 2,500 lookups per trial;
7 trials, reporting the median of each implementation. Existing and revised
logic evaluated under the same synthetic data. Timings below are totals for
2,500 calls, not a single-call latency and not an Electron renderer trace:

| Workload | Previous | Final revision | Ratio |
| --- | ---: | ---: | ---: |
| Request on own/root session | 11.3456 ms | 0.6045 ms | 18.77x |
| Request on last descendant | 12.054 ms | 12.524 ms | 0.96x |
| No request | 10.8087 ms | 10.7797 ms | 1.00x |

The root fast path is the measurable win; there is **no claim** of an
equivalent UI speedup. The far-descendant delta is within a few percent
of the baseline and needs broader paired sampling if it becomes important.
The newly persisted, alternating-order harness subsequently produced
18.659ms -> 0.072ms (257.72x) for root requests and 16.183ms -> 16.339ms
(0.99x) for no requests. The magnitude of the fast-path speedup is
JIT/harness-sensitive, so neither set is a stable application-level KPI.

### Verification ledger

- Targeted behavior: **25 passing Bun tests, 12,869 assertions**, including
  project collisions, group IDs, tab order, hover timing, request BFS,
  orphaned visibility flags, and mock observer lifecycle.
- App `bun run typecheck` exit 0.
- Scoped `git diff --check` on the modified tracked source files exit 0.
  Global `git diff --check` is not clean because of concurrent changes to
  unrelated `prompt-revision.test.ts`; this pass does not overwrite them.
- Wider test attempt: 41 tests passed; two unrelated component-dependent
  tests and one loading phase failed on the preexisting SolidJS
  `jsxDEV` export issue. These are **not** counted as passing coverage.
- No live application restart, no runtime-config changes, no commit.

### Remaining acceptance gates

Measure with the actual Electron renderer (not a Vite/PWA stand-in) at
1/3/6/25/50/100 simultaneously working sessions: p50/p95 tab-switch latency,
event-loop long tasks, heap retention after 1,000 tab open/close cycles,
animation frame/scripting cost at 100 working tabs, overflow scrolling,
pointer hover->popover close->hover streak, adjacent/numeric key navigation,
drag reordering, group context-menu safe-area traversal, rename completion,
and pause/resume/state-action affordances. Compare with an unmodified control
worktree using identical session fixtures before claiming global performance
dominance or zero UI regressions. Electron CDP was unavailable on the probed
local ports during this pass; it was not started or modified.

## Additional architecture pass — incremental visibility and warm activation

The desktop/new-layout strip now has three further improvements beyond the
earlier index, order, preview and animation work:

1. **Incremental DOM child reconciliation.** The strip-level MutationObserver
   previously rebuilt a set by enumerating every direct child after each
   mutation. Now the initial registration remains O(N), while later valid
   childList deliveries use the added/removed nodes only: O(K) where K is the
   number of distinct touched element nodes. A node moved out and back in the
   same callback stays observed, preserving its offscreen attribute; a detached
   node is unobserved and its attribute cleaned. An empty-record callback falls
   back to a full reconciliation (also used by synthetic test adapters).
   Cleanup disarms callbacks so they cannot re-register after teardown.
2. **Server context projection shared by tabs.** Session/group tabs referencing
   one connection now share a strip-owned memoized map rather than each calling
   `global.ensureServerCtx` on connection-catalog revisions. Draft and app
   tabs never initialize an otherwise-unused sync owner. Per-tab equality-
   checked `createMemo` accessors remain in place, so a tab reorder may rebuild
   the shared map but cannot needlessly invalidate all unchanged downstream
   server/session/avatar owners. Connection replacement and disappearance are
   handled through the existing reactive connection map; the global ServerCtx
   lifecycle still owns disposal and SDK URL identity.
3. **Warm session activation fast path.** An active session tab consults the
   authoritative shared `sync.session.peek` before scheduling
   `createResource` resolution. Cached revisits avoid a Promise/resource
   lifecycle; missing or evicted sessions still resolve at critical priority.
   This introduces no session-history hydration, extra stream or new request.

### Reproducible mutation benchmark

From `packages/app`, run
`bun run benchmarks/tab-strip-visibility.bench.ts`. The Happy DOM harness
compares the retained original O(N) observer-callback algorithm with the new
O(K) callback for a one-node move in a 512-slot strip. It times *callback
bookkeeping only* (not DOM mutation, layout, painting or Electron), uses
2,000 callback deliveries per trial, warms both implementations, alternates
trial order and reports medians over 7 trials.

| Implementation | Median across 2,000 callbacks |
| --- | ---: |
| Previous full-collection scan | 79.206 ms |
| Incremental changed-node projection | 0.324 ms |

The **244.09x isolated** improvement is subject to JIT, microbenchmark and
Happy DOM effects. It is **not** a measured tab-switch speedup or a renderer
FPS claim. Server-context call-count tests independently show that two tabs
on the same server plus one group on another require only two unique context
resolutions, with draft/app/missing servers not bootstrapped.

**Small-strip follow-up:** An initial scaling sweep exposed temporary Set
allocation as a small-N tradeoff. The production callback now has a
single-record fast path for the usual one-node add/remove/move, retaining
the same final-parentage semantics and the batched fallback. With optional
slot count passed as the benchmark argument, the follow-up run measured:

| Slots | Previous callback total (ms) | Final callback total (ms) | Isolated ratio |
| ---: | ---: | ---: | ---: |
| 1 | 1.030 | 0.323 | 3.19x |
| 8 | 2.941 | 0.364 | 8.08x |
| 32 | 5.100 | 0.177 | 28.90x |
| 128 | 21.902 | 0.215 | 101.96x |
| 512 | 128.608 | 0.290 | 443.78x |

These are *separate* warm-run medians, not an Electron trace; absolute numbers
are susceptible to load/JIT noise. The same-record fast path has explicit
add/remove/reorder, cleanup, and no-registration-after-disposal assertions.

### Verification and limits

- Focused extended regression suite: **77 pass / 0 fail, 13,013 assertions
  across 9 files** (tab gestures, preview timing, visibility/order, connection
  deduplication, tab persistence/batch close, project/layout helpers).
- Scoped `git diff --check` passes for modified tracked strip files.
- App `bun run typecheck` currently fails outside this change on
  `src/components/dialog-select-model.tsx`: missing `createPolled` symbol
  (concurrent model-selector work). None of the diagnostics in that run target
  the newly changed tab-strip files. Do not attribute a global clean typecheck
  to this pass.
- No desktop process restart, configuration change, commit, or publication.
- Prior Electron acceptance gates still stand. Before claiming end-to-end
  improvement/regression freedom, run the full 1/3/6/25/50/100 *working*
  session matrix under the real Electron preload bridge, with cold/warm
  switching, overflows, drag/reorder, rename, context-menu crossing, preview
  teardown, heap retention and frame/long-task metrics. An ordinary web
  browser or mobile PWA fixture is not an acceptable substitute.