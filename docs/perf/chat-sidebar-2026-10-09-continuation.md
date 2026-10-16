# Chat sidebar performance continuation — October 9, 2026

## Ownership and negative invariants

- **Session rows** come from the bootstrap-free project-scoped root indexes. Only explicitly opened/selected sessions may warm message history. Row badges never call `session.prefetch` on their own.
- **Execution status, pause state, permissions and questions** belong to the shared `server-session` data owner. Footer counters consume these already-materialized maps, rather than reading every session's status separately or making requests.
- **Group topology** belongs to SessionGroups' compact roster. `sessionGroupMemberSession` produces an immutable, revision-checked snapshot from the roster; it does not insert an incomplete projection into the canonical session cache.
- **Search, virtualization, tooltip and row animation** remain presentation concerns; no additional network transport, per-row timer or backend instance is created.

## Changes in this continuation

1. Added sparse footer-count projections (`chat-sidebar-counts.ts`); scoped visible root/structural-member membership is memoized separately from live status changes.
2. Added a revision-checked WeakMap for compact SessionGroup-member-to-Session projections. It preserves object identity across unchanged group snapshots while recognizing in-place reconciled field updates.
3. Added the one-project sorted-root-index fast path. Multi-project assembly retains the proven native sort and **last-source-wins** duplicate behavior. An explicit heap merge was measured and discarded because it was slower.
4. Hoisted immutable present-session scope out of live status-driven rebuilds and reduced temporary array/Set allocations in group-member filtering and project attribution.
5. Added an O(1) active-key index for sidebar search, coalesced selection-induced virtual scrolls, and stabilized TanStack Virtual's `getItemKey` and `rangeExtractor` identities.
6. Preserved previous sidebar improvements: sticky-header sparse index, stable virtual focus keys, row visibility/telemetry gating, archive fetch invalidation and pooled tooltips.

## Isolated benchmark evidence

All numbers below are **synthetic Bun measurements**, not production render-frame or transport measurements. They are narrow comparisons and must not be multiplied together to predict UX speedup.

| Case | Before | After | Iterations |
|---|---:|---:|---:|
| Working count, 12k visible roots / 80 active | 201.37 ms | 6.33 ms | 400 |
| Waiting count, 12k visible roots / 44 pending keys | 489.35 ms | 16.34 ms | 400 |
| Active-hit lookup, 10k results / 2k selections | 76.033 ms | 4.666 ms including index build | 1 batch |
| One-project global index, 5k sessions | 31.78 ms | 17.54 ms | median of five 70-iteration runs |

The multi-project path was explicitly reverted to native sorting after a binary heap produced slower results. Treat it as parity-preserving, not an established performance gain.

## Verification

From `packages/app`:

```sh
bun test src/pages/session/v2/chat-sidebar-tree.test.ts src/pages/session/v2/chat-sidebar-session-merge.test.ts src/pages/session/v2/chat-sidebar-counts.test.ts src/pages/session/v2/chat-sidebar-search-index.test.ts src/pages/session/v2/chat-sidebar-sticky-index.test.ts src/context/session-group-member-projection.test.ts
bun test --conditions=browser src/pages/session/v2/chat-sidebar-counts-reactivity.test.ts
bun run typecheck
```

- 79 focused pure tests and 2 browser-mode Solid reactive tests passed in the final verification run.
- The package TypeScript build succeeded in the final verification run; concurrent lanes may change this result later.
- Never interpret SSR Solid as proof of client reactivity; the browser-condition test checks additions, changes, pause-state transitions and settled requests.
- Randomized differential tests assert exact session-index duplicate priority and footer-count equivalence with legacy row scans.

## Outstanding full-renderer gates

No real CDP target was available on `127.0.0.1:9222` during this pass. Do not start or restart Electron/the sidecar just to capture measurements. The user requested no runtime disruption and `packages/app/AGENTS.md` prohibits restarting the application.

When an authorized already-running renderer exposes CDP, compare **before/after under 25, 50, 100 genuinely active sessions**:

- startup and sidebar-open latency (first interactive frame, first session rows, JS long tasks);
- 60-second active-session update profile: Reactivity computations, Solid disposal/remount churn, status/permission change latency, CPU utilization;
- scroll FPS and layout thrashing while status buckets reorder, 200+ member clusters expand/collapse and sticky headers change;
- CDP heap snapshots after 100 sidebar open/close cycles and 1k group/member churn events; no retained tooltip anchors, IntersectionObserver targets, row-runtime leases or stale SessionGroup projections;
- request counting: **zero new implicit workspace Instance creation, zero metric-only history hydration, no N-per-row transport**, bounded viewport telemetry batches;
- navigation/focus correctness across reorders, empty group removal and rapid search ArrowDown/ArrowUp key repeats.

If any end-to-end regression appears, prefer reverting an isolated optimization over adding scheduling complexity around a wrong producer. In particular, retain the native multi-project merge unless a measured alternative wins across realistic source counts and duplicate distributions.

## Additional architectural continuation

### Scope ownership / group projection

The old pane computed `visibleMemberGroups` but `sidebarClusterGroups` consumed
the complete server-wide `sessionGroups.list()` anyway, causing unrelated
projects' group workers to be projected, folded and made eligible for telemetry
warming. The cluster projection now consumes only `visibleMemberGroups()`.
The selector was extracted into `chat-sidebar-group-scope.ts` and checked
against the original selector under 250 randomized group/anchor/member rosters.
Plugin and anchored-subagent compatibility semantics are preserved.

The visible root-id set now has structural equality: a title/timestamp update
does not rebuild unrelated group membership trees when the set of visible roots
has not changed. Footer scope equality likewise compares the exact per-session
directory set (the permission auto-response policy depends on directory).
These equality checks cost a bounded linear scan but prevent a larger group
roster rebuild and reactive downstream invalidation.

### Keep existing mounted Session rows alive

Previously the per-section item-slot reconciler allowed in-place updates only
for clusters. Every immutable Session row change replaced the row slot, causing
the virtual row, DOM, IntersectionObserver and shared runtime lease to remount
even if its ID remained identical.

- `canReuseChatSidebarItemSlot` now preserves the slot for the same Session ID,
  while rejecting type or ID changes.
- `renderRow` consumes the slot's live Session getter; title, timestamp,
  directory, group metadata, current selection and contextual actions update
  without a row remount.
- The existing runtime lease gains an `update` callback to keep its cached
  fallback Session current when the server supplies a new immutable row.
- Browser-condition Solid tests verify stable slot identity and reactive row
  metadata while rejecting identity/type changes.

### Virtualizer structural identity

`reuseChatSidebarVirtualBlocks` now performs a positional reconciliation
before falling back to the prior map-by-key path. For unchanged key order and
slot references it returns the previous entire block array, preventing
unnecessary virtualizer invalidation. Reorders/insertions/removals still
recover old block identity by key. 300 randomized edit cases and targeted
identity tests pass.

`reconcileChatSidebarSlots` also returns its exact prior slot state with no
new `Map` or `Array` allocation when all input keys/object references match.

Isolated Bun measurements:

| Synthetic operation | Before | After | Iterations |
|---|---:|---:|---:|
| Reconcile unchanged 10,000 item slots | 128.10 ms | 7.88 ms | 200 |
| Reconcile unchanged 10,000 virtual blocks | 150.31 ms | 34.67 ms | 150 |

The first is ~16.3x faster and the second ~4.3x faster on the measured hot path.
Neither establishes a corresponding Electron end-to-end speedup. Both retain
the existing O(N) projection construction and therefore **do not eliminate**
all scaling pressure from the Status view under hundreds of simultaneous
updates. An event-indexed authoritative state projection would be required
to remove those repeated scans without creating per-row subscriptions.

### Focus and lifecycle correctness

Virtual keyboard focus now allows two bounded extra animation frames for an
intended scroll target to mount after a range change. This prevents skipping
legitimate rows during delayed virtualization/reordering while still moving
past intrinsically non-focusable blocks. Pane disposal invalidates outstanding
focus requests.

### Final regression verification

- 88 pure tests pass across 9 files (42,747 assertions).
- 4 browser-condition Solid reactive tests pass across 2 files.
- `bun run typecheck` succeeds after the last row-lifetime/virtualizer changes.
- These are code-level checks. Actual Electron/CDP, request-count and
  25/50/100-concurrent-session performance gates remain **unverified** because
  the running application's CDP endpoint was not available. Do not declare
  overall completion or end-to-end throughput improvements on this evidence.

### October 10, 2026 — additional projection workload characterization

For a fixed 5,000-root synthetic Status view without SessionGroups, 80
sequential status changes were modeled with 25/50/100 sessions initially
working. Each iteration rebuilt `buildChatSidebarSections` and reconciled
it against the previous projection. These are CPU-only state mutations,
**not genuine concurrent Session execution or Electron render-frame samples**.
Measured cumulative times were ~102.66 ms (25 initially working),
~59.69 ms (50) and ~61.29 ms (100). The 25-session case being slower
demonstrates why this noisy, single-run microbenchmark must not be used as
an end-to-end throughput comparison or absolute performance gate.

The decisive remaining opportunity is to avoid O(all loaded roots) Status-view
projection work for each semantic status change by consuming an incremental
server-owned state index. Do not implement a second speculative frontend
authority or N per-session listeners: such a transition must be grounded in
existing server event ordering, notification/permission precedence, cancellation
and cross-project scope. The existing Status projection is pure and tested,
and should remain the fallback until that architecture is validated.

## October 10, 2026 — sparse-owner Status breakthrough

The previous Status projection subscribed to individual status, pending
question, permission and notification fields for every loaded root. With
10,000 mostly idle sessions, this multiplied reactive dependencies and
rebuilt arrays of thousands of hidden rows on every live transition.

**Source ownership remains unchanged:** `server-session` holds execution,
pause, permissions and questions; `notification` holds unseen counts/errors.
The Notification context now exposes read-only accessors to its existing
sparse indexes. The sidebar derives a disposable priority index with the same
semantics as its original rowState getter:
`attention > error > working > unread > idle`. Paused busy/retry sessions
are excluded from working. Auto-response decisions use the owning session's
directory. No new history hydration, timer, polling loop, transport or
backend synchronization primitive was added.

`indexChatSidebarWorkingIDs` also reuses sparse canonical statuses for
working-first pinning and the footer, avoiding 10,000 individual status
property subscriptions when 25–100 identities are actually working.

### Conservative O(K log K) fast path

`indexChatSidebarSparseSource` verifies the canonical root index once
per metadata/index revision. Only when all its preconditions hold—
**updated-time sort, no group/member clustering, sorted roots with unique
IDs**—`buildChatSidebarSparseStatusSections` handles Status updates without
scanning idle history:

1. Enumerate the sparse non-idle semantic state map; resolve root objects by
   preindexed ID and bucket the 25–100 (or other K) active/urgent/unread rows.
2. Sort the small buckets and preserve working-first arrival ordering.
3. Compute the exact idle count by subtracting visible-root non-idle keys.
4. Scan only the earliest root rows needed to fill the visible idle page.
5. Preserve full grouping, legacy unsorted inputs, alternative sorts and
   duplicate-ID behavior by using the existing general full-tree projection
   as the fallback.

`chat-sidebar-tree-window.test.ts` verifies the earlier change that
additionally avoids materializing/labeling hidden clusters in Recent and Status idle
pagination, including on the general fallback path.

### Reproducible benchmark

Run `bun scripts/bench-chat-sidebar-state.ts` from `packages/app`.
The script asserts exact section/key/count parity *before* timing and
models 25/50/100 working status identities over 5,000 or 10,000 sorted
roots. No real session execution or Electron renderer is exercised.

| Roots | Modeled working | Original Status / 50 passes | Sparse fast path / 50 passes | Ratio |
|---:|---:|---:|---:|---:|
| 5,000 | 25 | 72.40 ms | 1.71 ms | 42.3× |
| 5,000 | 50 | 83.29 ms | 2.42 ms | 34.5× |
| 5,000 | 100 | 82.63 ms | 2.55 ms | 32.4× |
| 10,000 | 25 | 143.33 ms | 1.38 ms | 103.7× |
| 10,000 | 50 | 146.15 ms | 1.17 ms | 124.9× |
| 10,000 | 100 | 140.79 ms | 2.03 ms | 69.4× |

These reflect **only** the CPU-side pure Status section projection and
sparse index construction on the benchmark data. They do not establish
end-to-end speedup, renderer FPS, Reactivity scheduling fairness, or true
concurrent-session throughput.

### Regression gates

- `chat-sidebar-tree-window.test.ts`: 270 randomized windowed cluster
  parity cases, plus a negative test proving hidden rosters are not resolved.
- `chat-sidebar-working-index.test.ts`: 500 randomized state contract cases,
  plus real Solid-browser store transition tests.
- `chat-sidebar-state-index.test.ts`: 250 randomized priority and directory
  cases and live Solid-browser transition/semantic-no-op tests.
- `chat-sidebar-status-sparse.test.ts`: 500 randomized full-vs-sparse Status
  equivalence cases including attention/error/working precedence, working-first
  ordering, idle pagination and unscoped sparse keys.
- Existing ungrouped and grouped tree, virtualizer, search, footer, notification
  and renderer TypeScript checks remain required. The actual 25/50/100
  simultaneous-session CDP validation gate remains outstanding.

## October 10, 2026 — grouped Status, Recent and Projects architectural continuation

The earlier sparse Status path applied only to the ungrouped updated-time view.
All grouped Status projections, working-first Recent projections and multi-project
sections still rebuilt thousands of historical rows whenever *one* worker changed.
This campaign addressed each separately without inventing a frontend lifecycle
authority, per-row transport or background polling.

### Grouped Status projection

The disposable `indexChatSidebarGroupedStatusSource` maps sorted unique rows
to their group membership, preserving source row identity and group roster.
The indexer rejects unsorted roots, duplicate IDs or inconsistent group metadata
so the original full projection remains the compatibility fallback. Each
subsequent status event inspects only the sparse non-idle IDs:

- Resolve active/attention/error/unread sessions by ID and bucket them.
- Calculate the **exact** number of idle top-level items from cached group sizes,
  correcting only groups whose members became non-idle.
- Scan the root index only far enough to select the first visible idle groups.
- Expand and label only those selected groups, preserving roster order and
  working-first placement through the original cluster projector.
- Keep unbounded active buckets complete regardless of recent-limit settings.

500 randomized group/status/priority/working-first equivalence cases, plus
a 12,000-member extreme cluster, passed. The projector uses no individual
session-status subscriptions and never reads message history.

### Sparse Recent with working-first pinning

`buildChatSidebarSparseRecentSection` uses the same immutable group-source
index. A working-state update enumerates only known working IDs, obtains their
stable arrival order from the existing pane-owned pin policy, selects the first
visible top-level items in pinned-then-updated order, and materializes only
those items' full groups. The hidden count is `rootCount - groupFoldSavings
 - visibleItems`, not a full clustering pass. Invalid or inconsistent source
 indexes use the old full builder. A mismatched pin result also fails closed.

600 randomized full-section parity cases passed, including cross-group pinning
and ungrouped sets. A separate 12,000-session test verified a very large
visible cluster and exact Show More accounting.

### Project section-level cache

`indexChatSidebarProjectMembership` is computed only when Project view's
root/membership index changes. For ordinary execution status changes, the
sidebar maps the sparse working IDs to affected project keys. Each project
section cache retains its prior section unless the project's source rows,
supplemental roster, project ID/total, sort mode, group revision or local working
ID set actually changed. Therefore a worker in project A cannot force repeated
sorting/cluster construction across projects B–Y.

The cache is explicitly cleared with the pane's lifecycle, on server switches,
and when leaving Projects. The Project
view still honors unbounded loaded-page rows, server-known totals and group
membership semantics. No pagination cap was introduced for Projects.

Randomized multi-project parity, stable reference tests, supplemental worker
attribution and group-revision invalidation tests cover this implementation.

### Stable no-change semantics and cold-view gating

- `reuseChatSidebarSections` now returns the previous **array** as well as
  unchanged section/item objects when all sections are semantically identical;
  this prevents unnecessary virtual-block flattening and measuring.
- Sparse Status, grouped Status, sparse Recent, project attribution, and
  permission-directory indexes are view-scoped. They do not instantiate or
  subscribe to thousands of roots while the user views another mode.
- A structural equality guard on session-to-directory mappings suppresses
  needless sparse permission-state reindexing on title/timestamp-only changes.

### CPU-only benchmark evidence

Each script checks projection/key/count parity against the complete reference
builder **before** measurement. Source indexes are constructed outside the
update timing because they are memoized by roster revision in the application.
This excludes cold-start index-build time and does not measure Electron rendering,
real concurrent sessions, backend contention, telemetry/network load or FPS.

Run these from `packages/app`:

```sh
bun scripts/bench-chat-sidebar-grouped-status.ts
bun scripts/bench-chat-sidebar-recent.ts
bun scripts/bench-chat-sidebar-projects.ts
```

| View | Synthetic workload | Baseline | Optimized | Isolated speedup |
|---|---|---:|---:|---:|
| Grouped Status | 10k rows / 1k group members / 25 working / 50 iterations | 98.66 ms | 3.99 ms | 24.7× |
| Grouped Status | 10k rows / 1k group members / 50 working / 50 iterations | 85.45 ms | 4.03 ms | 21.2× |
| Grouped Status | 10k rows / 1k group members / 100 working / 50 iterations | 81.76 ms | 4.44 ms | 18.4× |
| Recent | 10k rows / 1k group members / 25 working / 70 iterations | 99.05 ms | 5.52 ms | 18.0× |
| Recent | 10k rows / 1k group members / 50 working / 70 iterations | 95.35 ms | 5.89 ms | 16.2× |
| Recent | 10k rows / 1k group members / 100 working / 70 iterations | 93.37 ms | 4.95 ms | 18.9× |
| Projects | 10k rows / 25 projects / 25 working / 100 transitions | 131.38 ms | 6.64 ms | 19.8× |
| Projects | 10k rows / 25 projects / 50 working / 100 transitions | 157.95 ms | 5.99 ms | 26.4× |
| Projects | 10k rows / 25 projects / 100 working / 100 transitions | 107.14 ms | 5.56 ms | 19.3× |

The Project benchmark changes a single session in one project between samples.
It is **not** evidence of the same improvement when all 25 projects change
simultaneously or when substantial group rosters churn every event.

### Remaining gates

An already-running authorized Electron renderer exposing CDP is still needed
to establish actual frame rate, reactive recomputation count, input latency,
mount/unmount churn, tooltip memory retention, 25/50/100 simultaneously
executing Session throughput and the absence of unexpected transport calls.
Do not start/restart the user's Electron/sidecar runtime to collect these.
Also profile cold view switches and index construction, since the update-time
figures above deliberately exclude one-time source indexing costs.

## October 10, 2026 — further correctness, locality and all-sort work

The next review found remaining lifecycle and invalidation gaps that would
matter with rapid worker churn, 25+ project views, and multiple connected
servers. The improvements below preserve each authoritative data owner.

### Session-directory alias correctness

The old module-level `WeakMap<Session, Session>` for backfilling missing
`Session.directory` values silently cached only the first worktree. If two
directory indexes shared the same original Session object, the second could
be projected with the **wrong directory**, disrupting path comparisons and
project membership. `chat-sidebar-directory.ts` now keys by the source
Session identity **and** directory, with a single-entry fast path that allocates
no additional Map in the typical case. Four tests verify cross-worktree
isolation, same-directory identity and explicit-directory precedence.

### Pane and server lifecycle

- `createChatSidebarWorkingOrder()` now owns arrival ordering, pruning and
  reset. When the server reports zero working IDs it returns the original
  session array without an O(N) walk or allocating pinned/rest arrays.
  A 700-step randomized differential test checks prior arrival ordering,
  idle-reset behavior and source reordering.
- Session arrival order is cleared **synchronously before projection** when
  the selected server key changes. Deferring the reset to a post-render effect
  risks showing the previous server's pinned ordering on the first new frame.
- The Projects section cache releases all retained historical Session/group
  objects when the pane moves to Recent/Status, switches server or unmounts.
- The pane's shared 1-Hz clock runs only while open and at least one Session
  is working. The relative-timestamp clock also suspends while the pane is
  closed. Existing row-level visibility checks still gate live calculations.

### Project-local group invalidation

Before this change, a single SessionGroup rename/roster edit created new
member-list arrays for every project and a single global `groupRevision`
invalidated **all** sections. The pane now retains identical member arrays
between roster updates and creates an exact per-project group signature
from the IDs and metadata of scoped group members. Metadata/roster changes
can affect only their owning sections; worker-status changes retain the
earlier sparse per-project working-ID invalidation.

`bun scripts/bench-chat-sidebar-group-churn.ts` models 150 single-project
group metadata revisions over 10,000 sessions / 25 projects. The initial
section-only benchmark reported **18.9–28.3×**, but that **excluded the
cost of constructing project revision signatures**, so it is NOT a valid
whole-projection comparison. The next benchmark revision explicitly included
that producer and observed only **1.08–2.59×**. This uncovered the additional
O(all roots) group-revision scan, which was subsequently replaced with an
index of root-to-project membership that is rebuilt only on root changes.
With the actual sparse group-revision producer included, three CPU-only
trials yielded **3.14×, 4.02×, and 3.49×** over the global invalidation
baseline. The benchmark changes a single group at a time, excluding the
initial root index-build cost, and is not an Electron frame/heap comparison.
Additional tests verify stable unaffected member-list references and
that per-project group metadata changes invalidate only their own section.

### Created-time and title ordering also use sparse projection

`compareChatSidebarSessions` is now the shared comparator authority for
the general tree and sparse projections. The Recent and Status indexers
support pre-sorted created-time and locale-aware **numeric title** ordering,
not only updated-time ordering. Working-first pinning applies *only* to
updated-time sort, as before; with title/created ordering the section no
longer subscribes to working-status changes purely for pin-order pruning.
Mounted row indicators remain independently reactive.

Recent and Status now reuse one sorted group-source index. Switching between
the two modes with unchanged row/roster/sort references avoids an additional
10k-row title sort and index build. Switching to Projects drops that cached
index rather than retaining unused history. Trusted locally sorted arrays
can skip redundant per-pair comparator validation, but duplicate Session IDs
are still rejected. Other callers retain the conservative sortedness check.

`chat-sidebar-sparse-integration.test.ts` compares the complete and sparse
Recent/Status builders over 250 randomized roster scenarios, *including*
parented worker Sessions, mixed attention/error/working/idle buckets,
different scope-member orders, and all three sort modes.

Run `bun scripts/bench-chat-sidebar-sort-modes.ts` from `packages/app` for
a 10k-row / 1k-member CPU-only comparison. One measurement gave:

| Sort/View | Full builder / 30 iterations | Sparse / 30 iterations | Ratio |
|---|---:|---:|---:|
| Created / Recent | 83.28 ms | 2.69 ms | 30.9× |
| Created / Status | 104.05 ms | 7.55 ms | 13.8× |
| Title / Recent | 504.76 ms | 3.78 ms | 133.4× |
| Title / Status | 591.43 ms | 10.39 ms | 56.9× |

**Cold-index caveat:** These ratios exclude the initial sort/index build.
The benchmark now separately measures that build, and a later run showed
about 435 ms per 30 full title-sort/index constructions, or ~14.5 ms
per reconstruction on its synthetic input. This one-time CPU cost can
slightly exceed the initial full-tree title Recent construction on some
runs; repeated event updates are substantially cheaper. The timings are
noisy and should not be treated as a measured first-paint regression or
an end-to-end renderer improvement. Repeated-paint gains must be balanced
against actual Electron cold-view-switch measurements once CDP is available.

### Verification / remaining blockers

Focused pure and Solid-browser reactive suites have passed for the updated
working-order policy, directory backfills, source-sortedness checks, grouped
and ungrouped sparse Status, Recent, Project caches, virtual slot identity,
group scopes, notification/status indexes and working counters.

Concurrent unrelated changes may temporarily prevent a package-wide
`bun run typecheck` from passing. The last observed diagnostics after the
all-sort change were in `schema/src/model-select/usage-profile.ts`, not
these sidebar files. Do not overwrite that unrelated agent's edits.

The critical remaining end-to-end gate is **real Electron CDP profiling**
under 25/50/100 genuinely concurrent Sessions, including initial paint,
scroll-frame latency, working-status flip storms, session/view switching,
mount churn, heap retention, and transport/request counts. The running app
has no available localhost:9222 debugging endpoint; do not restart it.

### Source-index reuse and cold-view improvements

The newest pass consolidates Recent and Status into a single indexed group
source, backed by `createChatSidebarSourceCache`. With unchanged root/member
arrays and title policy, switching Recent ↔ Status no longer constructs a
second sorted 10k-session index. Selecting Projects releases both the merged
roster and sorted source cache. Returning to a non-Projects view rebuilds only
the currently needed projection. Three focused tests verify exact reference
reuse, root/roster/sort invalidation and cache disposal.

When using title/created sort, the entire structural section memo now avoids
subscribing to worker-status flips just to prune the *working-first* ordering
map: working-first semantics apply only to updated-time sort. Status view
still subscribes to the authoritative sparse status index, and individual
row badges/live timers remain reactive in every view.

A cold-path follow-up compared repeated explicit source-index builds rather
than omitting the cost entirely. On 10k sessions/1k grouped, median per-30-run
source-index builds ranged approximately 62–69 ms for created-time and
435–620 ms for title sort across noisy benchmark runs. Because this is a
one-time cost per root/roster/sort revision, reuse matters more than headline
steady-state ratios. On some title/Recent cold runs the indexed path can
have a slightly higher first-build CPU cost than the reference full builder;
do not advertise the steady-state 100× ratio as an initial-paint speedup.

An explicit exploratory benchmark of cached-title extraction showed that an
extra per-run `Map` of normalized titles was slower than native collator sort
in Bun. This was **not** adopted. Preserve the existing locale-aware numeric
collation contract and avoid theoretical optimizations without a measured win.

`bun run typecheck` initially saw unrelated concurrently edited
`packages/schema/src/model-select/usage-profile.ts` errors. A subsequent
full package TypeScript check passed with exit code 0 after that worktree
settled. Do not overwrite unrelated agents' code to repair transitory
diagnostics.

### In-place reconciliation and group roster safety closeout

The backfilled-directory `WeakMap` now detects revisions to *existing*
Solid Store proxy objects as well as distinct path aliases. Metadata
comparisons cover title, version, project identity, primary timestamps,
archive state, model, usage counters and group summary metrics. Snapshots
copy small nested time/model/tokens structs so the old projected Session
stays immutable after an in-place update. Added two specific nested-update
tests and a browser-mode Solid store reactivity test.

Project-local group signatures now include the **ordered** full group roster
and row-title/timestamp values. This closes a hole where reordering group
members without changing their IDs/name could leave expanded clusters
displaying stale ordering. Instead of rescanning every historical root on
each roster mutation, `projectRootMembership` indexes root-to-project
locations once per structural root revision, and
`chatSidebarIndexedProjectGroupRevisions` visits only the sparse
groupBySession map and scoped supplemental members. No reverse index is
constructed during the common ungrouped Projects cold paint.

150 randomized mutations compared the fast project's invalidation decisions
against the prior complete signature builder; all passed. Genuine
25/50/100-active-session Electron profiling, production first paint,
retained heap and frame timings remain open and must not be inferred from
the CPU-only benchmarks.

### Final October 10 regression gates and evidence corrections

The full sidebar-focused pure suite was rerun after the in-place Session
reconciliation and indexed roster changes: **121 passing tests across 18
files, 53,443 assertions, zero failures**. The browser-condition Solid
reactivity suite also passed **12 tests across 5 files, 57,947 assertions**.
The package's `bun run typecheck` completed successfully (exit 0) after
the unrelated concurrent schema edits settled, and `git diff --check`
passed for tracked sidebar/notification files. No Electron restart, sidecar
restart, Git clean/reset, or unrelated-file overwrite was performed.

The group-churn benchmark requires care: section-only timings gave
18.9–28.3×, but a *complete* group projection must pay for identifying
the changed project. After adding that cost, the naive dense revision
scan gave 1.08–2.59× in sample runs. The optimized indexed revision
producer (`chatSidebarIndexedProjectGroupRevisions`) avoids dense rescans;
the reproducible benchmark including this producer reported **3.14× /
4.02× / 3.49×** across three consecutive runs. It excludes the
structural root-index creation performed on project-list revisions.
Do not substitute earlier section-only figures for the complete path.

The revised directory cache now checks top-level title/project/model fields
and primary nested time/model/usage metrics of reconciled source objects,
cloning compact nested structs when backfilling a new immutable projection.
Additional tests ensure in-place nested changes invalidate both aliases,
and a genuine Solid browser-store test verifies immediate reactive
reprojection. The per-project group revision now includes actual ordered
group roster membership and mutation-sensitive titles/timestamps,
tested against the prior full-signature invalidation under 150 randomized
roster mutations.

Remaining blockers: verify actual 25/50/100 *simultaneously working*
sessions with an already-running Electron renderer; capture frame time,
input-to-render latency, first paint, memory/observer retention, and
request/stream counts. CPU-only equivalence and microbenchmarks
cannot certify these runtime properties.