# Hover inspectors — performance and lifecycle engineering, 2026-10-10

## Scope and authoritative ownership

This pass optimizes the titlebar session/group tab hover popovers and the Chat
Sidebar session hover inspector. It preserves the V1/fork session/runtime
authority and V2/new-layout UI; no server endpoint, session execution,
transport, credential, or persistence contract changes.

Producer → consumer topology:

- `SessionGroupsProvider.list()` is the one reactive, batched group-detail
  projection. `context/session-group-preview-index.ts` now owns its structural
  hover lookup cache, containing full direct memberships and anchored groups.
  Both `titlebar-tab-popover.tsx` and `chat-sidebar-pane.tsx` read
  `sessionGroups.previewIndex()` on demand.
- The cache is **identity-keyed, weakly held, and nonreactive**. A
  permanently subscribed `createMemo` would rebuild after group changes
  even with no inspectors open. Instead, the reader tracks `list()` inside
  its own active Solid computation; when the last inspector closes, there is
  no extra index computation subscribed to group updates. Next hover builds
  the index at most once for its list reference; when stale group snapshots
  are released, their indexes are eligible for garbage collection too.
- `SessionPreviewCard` reuses the existing server-project index
  (`ctx.projects.index()`). It no longer reconstructs a project-ID map and
  scans directories for each visible foreign-project member. ID priority,
  first directory / last duplicate ID resolution, sandbox lookup and fallback
  labels remain owned by `projectForSessionIndexed`.
- The shared `SessionPreviewCard` continues to use compact SessionGroup
  member snapshots and server-owned telemetry/status/attention reads. No new
  Session message hydration, row-level Session fetches, polling, or external
  subscriptions were added.

## Hover lifecycle

`createTabPreviewController` owns the small shared tab/group preview
state machine: cold dwell 450ms, warm skip window 500ms (via the existing
timing module), blocked gestures/rename, pointer departure, Kobalte
safe-area handoff, asynchronous heavy-runtime teardown, and disposal.
The retained group/session preview code now uses that single implementation.

The controller invalidates close microtasks when the preview immediately
reopens or is disposed, and clears pending dwell timers on departure/unmount.
`TabPreviewPopover` cancels a queued context-menu post-close animation
frame on cleanup or replacement, preventing callbacks from closed inspector
owners from acting after unmount. The portalled row-context-menu guard
and safe-area bridge remain unchanged.

## Algorithmic safety

`sessionPreviewTree` now uses iterative preorder DFS instead of recursion,
avoiding native JS stack exhaustion for unusually deep delegated worker
ancestry. The output still includes every reachable local root, preserves
sibling order, caps *presentation* depth without pruning descendants,
applies the original `last` marker rule, and retains cycle/duplicate
protection. The test suite includes a 16,384-deep chain and 500
seeded differential comparisons with the original recursive implementation.

## Measurement (isolated and reproducible)

From `packages/app` run
`bun run benchmarks/session-preview-index.bench.ts`.
The benchmark uses 128 groups / 2,688 group-member memberships and 128
hover relationship projections per trial. It compares rebuilding the
membership index each hover with sharing one revision's index. Warm both,
alternate run order and report the median of seven trials.

| Runtime | Per-hover index | Shared index | Ratio |
| --- | ---: | ---: | ---: |
| Windows Bun 1.4.3-canary.1 (first paired run) | 51.819 ms | 26.080 ms | 1.99x |
| Windows Bun 1.4.3-canary.1 (second paired run) | 53.640 ms | 25.728 ms | 2.08x |

These are totals for 128 hover computations, **not** measured Electron p95
popover latency, frame times, cold chunk-load latency, or GUI speedups.
The synthetic fixture has no native browser layout/paint work.

### Bounded relationship-row presentation

The canonical `SessionPreviewCard` previously flattened all sections and
special-agent entries into presentation-wrapper objects, then sliced that
collection to the first displayed page (initially 80). Large workgroups
therefore incurred O(N) wrapper construction even while the visible
virtualizer would only mount a small fraction of them.

`session-preview-rows.ts` splits the work into an O(number of sections)
plus O(visible limit) bounded presentation projection,
`previewRelationshipCount` for complete totals, and an allocation-free
iterator over all relationship member IDs for status summaries and
Open All operations. This preserves complete results for bulk actions
and current-session relationships without allocating a full list of
presentation wrappers that will never be rendered.

The new `benchmarks/session-preview-rows.bench.ts` fixture contains 16,384
members, a visible limit of 80, 500 repeated projections per trial, and
7 alternating/warmed trials. Median elapsed:

| Baseline full flatten + slice | Bounded first-page projection | Isolated ratio |
| ---: | ---: | ---: |
| 200.317 ms | 0.443 ms | 451.77x |

These numbers measure **only array/wrapper construction**, not group
relationship derivation, virtualized rendering, layout, keyboard navigation,
network, or actual popover wall-clock latency. Small lists have less
amortization benefit; the zero-extra-work path matters for large group
popovers. Differential tests verify original section boundaries, ordering,
special-agent labels, page limits, complete counts, and full-ID bulk
traversal for a 16,384-member fixture.

## Regression contract and outstanding evidence

- Shared-membership tests verify duplicate membership ordering, structural
  anchors only, cache identity and revision freshness.
- State-machine tests verify delayed opening, blocked/dropped hovers,
  safe-area preservation, immediate reopen, and disposal.
- Tree-model tests verify cycles, duplicates, huge nesting, and randomized
  legacy-equivalence. Existing titlebar gesture, order, group, tab-persistence,
  project-index and hover-timing tests remain in the focused matrix.
- Latest combined focused run: **111 pass / 0 fail, 13,652 expect assertions
  across 13 files**. The app TypeScript build completed successfully after
  the bounded-row extraction; scoped whitespace check also exits 0.
- Source edits pass app TypeScript checking in the latest completed run;
  this may change while other lanes edit the same working tree.
- The isolated `src/context/session-groups.test.ts` test cannot load
  because Bun's current SolidJS UI dependency resolves a missing
  `jsxDEV` export before assertions. This preexisting test-loader failure
  is **not** counted as successful UI component coverage.
- **Not yet proven:** actual Electron input→popover latency; viewport-safe
  cross-tab and row-card pointer traversal; context-menu focus/portal retention;
  keyboard navigation across virtualized rows; long-lived heap retention;
  multi-window/multi-server coherence; CPU under 1/3/6/25/50/100 genuinely
  working sessions; and cold-chunk import/placement traces. Full regression
  freedom cannot be asserted until these measurements are performed.

The live Electron/sidecar was not restarted; no unrelated worktree changes,
runtime configuration, commits, or deployments were made.

## Next engineering pass — summary and bulk interaction scalability

The hover card had three more data-path costs after the bounded presenter and
shared index improvements:

1. The **Open All** button invoked `tabs.addSessionTab` once per member. Each
   invocation searched the expanding tab list for duplicates and scheduled a
   separate Solid transition/store update. The authoritative `TabsProvider`
   now exposes `addSessionTabs({ server, sessionIds })`, which resolves existing
   IDs and duplicate incoming memberships in linear time, then executes a
   single `produce`/transition. The planner checks the live store inside that
   transition so other tabs added in the meantime cannot be duplicated. One
   2,048-entry bounded push chunk prevents JavaScript argument-limit crashes on
   giant groups. Opening tabs in the background does not change navigation or
   active-tab selection. The preexisting single-tab API is unchanged.
2. The **openable count** used to scan every relationship entry again when
   *any* tab changed. `previewSessionWeights()` is now built only on a
   relationship revision and maps each session ID to its presentation
   multiplicity. For a tab-store revision, `previewUnopenedCount` checks
   already-open session IDs in O(open tabs) and subtracts the matched weights
   from the complete row count. Sessions appearing in several groups retain
   their old displayed multiplicity; nonexistent/unrelated tabs are ignored.
3. The **large-group status summary** iterated every session ID and subscribed
   to 4 separate reactive status/request entries per member. This is replaced,
   only for groups of at least 1,024 distinct IDs, with a pure read-only
   `previewSparseSummary` over the server-session owner's sparse status,
   pause, permission, and question maps. Idle sessions have no need for
   individual subscriptions. Waiting retains priority over working and
   paused working sessions do not count as running. Small groups keep their
   precisely scoped per-ID reads. A semantic equality comparator suppresses
   timer/label invalidations if the aggregate is unchanged.

### Paired synthetic benchmark results

Each benchmark is reproducible from `packages/app`, warms both algorithms,
alternates trial order, verifies parity, and reports a median. Figures here
exclude Solid notification/persistence costs and Electron frame/layout work.

| Benchmark script | Fixture | Legacy (ms) | Revised (ms) | Ratio |
| --- | --- | ---: | ---: | ---: |
| `benchmarks/session-preview-open-all.bench.ts` | 500 existing, 2,000 requested tabs | 9.156 | 0.196 | 46.62x |
| `benchmarks/session-preview-openable.bench.ts` | 16,384 members, 100 open tabs, 500 revisions | 70.375 | 2.534 | 27.77x |
| `benchmarks/session-preview-summary.bench.ts` | 16,384 members, 32 status entries, 1,000 summaries | 2,096.678 | 3.159 | 663.67x |

The very large summary ratio arises from a sparse fixture and a 16,384-entry
legacy traversal. It is **not** evidence that a real tooltip opens/renderers
hundreds of times faster. The concurrent high-activity matrix remains a hard
acceptance requirement.

Coverage now includes 100,000-session argument-limit append, 201 randomized
bulk-insertion equivalence fixtures, 100 random open-count revisions,
350 random status-map equivalence fixtures, status/permission/paused precedence,
and Solid-store reactive additions and count-equality suppression.

### Crossover guard for working-session concurrency

`benchmarks/session-preview-summary-scaling.bench.ts` checks the sparse
projection against member-scoped reads across 8–16,384 relationship members
and 8/32/128/512 server-global live status records. The sparse approach
is considerably faster for large groups but **can regress** for small
groups with many statuses belonging to unrelated sessions. Representative
150-iteration median totals:

| Members | Global statuses | Member-scoped ms | Sparse ms | Ratio |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 32 | 0.731 | 0.361 | 2.02x |
| 128 | 128 | 0.489 | 0.914 | 0.54x |
| 512 | 512 | 3.713 | 4.779 | 0.78x |
| 2,048 | 512 | 24.273 | 5.588 | 4.34x |
| 16,384 | 512 | 205.037 | 7.422 | 27.63x |

The runtime uses a conservative **1,024-distinct-member** threshold. This
protects the common 1/3/6/25/50/100 active-session inspector workload from
paying for unrelated server-global status enumeration. It is a measured,
conservative heuristic rather than a proof of optimality for every workload.

### Elapsed-clock stability and retired asynchronous DOM work

- The rich card's single elapsed-time timer now depends on the resolved
  **1-second vs 30-second cadence**. Worker count transitions that leave
  cadence unchanged no longer clear/rearm a timer; a change from zero to
  live workers (or the reverse) still switches promptly.
- Delayed selected-session scrolling is guarded by a generation token,
  current visibility, and a connected scroll element. Rapid group updates,
  hover-to-hover switches and unmounts cannot replay an obsolete microtask.
- Keyboard focus traversal keeps at most one pending animation-frame
  callback, cancels superseded frames, and refuses to focus after disposal
  or when the previous card is no longer connected.

These protections do not replace the Electron pointer/focus/portal
integration acceptance tests: they establish only the source-level lifetime
contract plus the focused model/controller tests.

### Follow-up validation

The combined focused regression run after summary/bulk changes passes
**119 tests / 14,328 expect assertions across 15 files**. In the same
working tree, a later global app typecheck failed in a concurrently edited,
unrelated `src/pages/session/v2/chat-sidebar-status-grouped.test.ts` because
`ChatSidebarItem` was read as though all variants had a `members` property.
This is **not** evidence of a clean global typecheck, nor is it a diagnostic
in the hover-inspector files. A scoped Git whitespace check passed.

Potential later architecture work requiring a dedicated integration lane:
server selection and SessionGroup membership must be validated for inactive
server tabs, since `useSessionGroups` is currently bound to the selected
server; replacing it with per-tab network fetches would violate the
single-producer rule. Consolidate server-scoped group ownership in the
authoritative provider before enabling cross-server relationship previews.

The tab popover now enforces the current ownership boundary: if a tab's
server differs from the selected `SessionGroupsProvider` server, it renders
its session/group header **without borrowing unrelated group memberships**.
This avoids falsely showing a remote tab's session as part of a local
group with a coincidentally matching ID and avoids activating the wrong
provider's group query. Fully featured *inactive-server* relationship
previews remain dependent on a producer-owned server-scoped group projection,
not an ad hoc component fetch.

During continued concurrent edits, the app-wide `bun run typecheck` was
retried and **exited 0** on the most recent completed verification after
the earlier unrelated test diagnostic. The original diagnostic remains in
the historical ledger above so the verification timeline is explicit.

Final focused gate after the server-scope guard and asynchronous focus/scroll
cleanup: **120 tests passed, zero failures, 14,332 assertions over 15 files**.
The final app-wide `bun run typecheck` exited **0**, and the scoped
`git diff --check` passed. No Electron interaction trace was run, and the
preexisting SolidJS `jsxDEV` failure still prevents counting the full
component suite as passing.

## Subsequent provider-level scope and invalidation campaign

Further inspection established an owner-level correctness risk behind the
inactive-server header-only guard: the selected-server SessionGroupsProvider
used a single `details[groupID]` map, shared across connections. Group IDs
are not globally unique, and detail requests can settle after the selected
server changes. The old TanStack `placeholderData(prev)` also displayed
group names from the previous server while the new query was unresolved.

That provider now:

- Materializes `details[serverScope][groupID]` rather than globally indexed
  group details; `list()` and `fetchDetail()` read their current scope.
- Captures both server scope and SDK at request admission. A late success
  writes exclusively to the initiating server's detail store. A late batch
  failure falls back using the *same* server SDK/scope.
- Keeps per-group inflight deduplication keyed by scope, generation and group
  ID, so a request from one server never blocks another connection with the
  same group ID.
- Advances a per-server generation on every membership batch refresh and
  discards stale batch/fallback completions. A later refresh cannot be
  overwritten by an earlier server response racing through the network.
- Uses empty cross-key query placeholder data. The cached same-server query
  remains available through TanStack's normal query-key cache; only the
  previous-server fallback was removed.

The added `session-group-request-generation.test.ts` checks independent
server snapshots with identical IDs, out-of-order responses, request
deduplication identity, and Solid store nesting. The current Bun/Solid loader
still fails to import `session-groups.test.ts` (missing `jsxDEV`), so the
component-level provider integration tests remain an explicit gap.

### Virtualizer metadata noise suppression

`SessionPreviewCard` now derives the visible session IDs (including the
header once) behind a memo with value equality, using
`session-preview-telemetry.ts`. A virtualizer measurement update that merely
recreates wrapper objects without changing which IDs are on screen no longer
re-enters `sync.telemetry.ensure`. Scrolling to genuinely new members,
switching current session, or changing server context still triggers a
single batched `ensure` call; the authoritative telemetry producer continues
to deduplicate and schedule transport requests.

The helper is tested for duplicate group memberships, header inclusion,
stable ID ordering and reactive equality suppression. No extra timer,
per-row listener, session-history fetch, or owner was introduced.

### Completed inactive-server relationship preview ownership

The previous header-only limitation has now been superseded by a shared
provider-owned, on-demand remote snapshot architecture:

- The *selected* server still uses the live TanStack group list and batched
  detail owner described above. The inactive-server path uses a **single
  server-keyed cache owned by SessionGroupsProvider**, requested only after a
  tab's committed hover and never during hidden tab layout.
- The remote loader resolves a connected server from the existing connection
  catalogue and uses `global.ensureServerSdk` (SDK only, not Session Sync
  bootstrap). It retrieves metadata and batched membership concurrently;
  older servers receive a **bounded four-request** per-group fallback.
  `projectSessionGroupEntries` is shared with the selected-server owner so
  group kind, order, labels, anchor and compact member-projection semantics
  stay identical.
- A **single flight per server** coalesces simultaneous hovering tabs.
  Successful snapshots have a five-minute freshness window; failures back
  off for 15 seconds. A retired/disconnected server invalidates its
  generation and removes its cached members so a late success cannot
  resurrect them. Pending work and caches are cleaned on provider disposal.
- While a remote inspector is *open*, it holds one of the provider's
  **reference-counted event-listener leases**. Multiple open inspectors
  for the same server share exactly one listener; same-tick structural
  Swarm events coalesce into one refresh. The last close releases that
  subscription. No remote event listener or polling survives at rest.
- The titlebar adapter consumes this central projection for both session
  and raw group-tab previews. The existing weak membership index is reused
  by server snapshot identity. Missing/disconnected remote servers fall
  back to the safe header-only view without borrowing another server's
  similarly named IDs.

Remote network/cache/event tests cover flight coalescing, TTL/backoff,
same-ID cross-server isolation, late-response invalidation, observer lease
reference counting, burst deduplication, and teardown before queued work.
These pure tests and TypeScript compilation **do not substitute** for
Electron pointer, portal, reactive subscription or true network-failure
integration tests.

### Cold work and rejected optimizations

- The activation timer is now canceled on provider cleanup; a tab that has
  already passed its pointer dwell calls `activateUrgent`, eliminating
  the additional 300ms provider delay from the *admission path* for
  selected-server group queries. No claim about measured first paint is
  implied by removing this configured delay.
- Group-only tree projection fuses the archive filter and row mapper,
  avoiding one large intermediate array. The 16,384-member isolated
  tree benchmark improved only **1.04x** (127.427 → 122.074 ms over
  20 iterations) and must not be described as a major performance win.
- A proposed lazy per-member `Session` getter was actually benchmarked
  with valid producer metadata and an 80-row virtual page. It **regressed**
  (6.482ms eager versus 7.860ms lazy for 8,192 members). The lazy variant
  was **reverted**; the existing server-owned revision cache remains the
  faster documented production mechanism on that fixture.

### Remote hover cancellation and final validation checkpoint

The remote SDK-only snapshot now accepts a generation-validity callback.
When the **last** remote hover inspector closes, the observer manager
releases its server-event subscription and invalidates any **unfinished**
snapshot request. Cached *completed* rosters remain available for later
hovers within the freshness window. On legacy servers, the bounded
four-request detail fallback checks validity before admitting each queued
request and rejects a partially populated roster if the hover has been
retired; already-dispatched HTTP requests can finish but cannot publish
stale results. Reopening starts a new independent generation.

Regression tests cover a 100-hover single-flight burst, two simultaneous
inspectors sharing one event listener, unsubscribe only on last close,
last-hover cancellation of an in-flight cache generation, stale/late
responses after disconnect or reopen, and suppression of queued requests.

**Final focused suite:** 140 pass, 0 fail, 14,402 assertions, 22 files using
`bun test --conditions=browser --only-failures`. The latest app-wide
`bun run typecheck` (`tsgo -b`) exits **0**, and scoped `git diff --check`
is clean. No application process/sidecar restart, commit, deployment or
unrelated concurrent-worktree modification was performed.

**Open acceptance gates:** There is still no real Electron input-to-first
paint trace or automated real-DOM keyboard/focus/portal test for the newly
connected inactive-server hover UI. Test the 1/3/6/25/50/100 concurrently
working-session matrix and multi-server switching, SDK authorization
failures, old-server fallback under high group count, hover teardown,
memory retention and Reactivity/TanStack transitions in the live renderer.
The existing Bun/Solid `jsxDEV` test-loader error prevents counting the
full SessionGroups component test file as passing. End-to-end regression
freedom and whole-renderer speedups remain **unverified**.

## Next architecture sweep — transport identity and storm admission

Further bottom-up inspection found that the canonical server **key** is
not sufficient to identify the transport/principal. In particular, sidecar
keys are stable across HTTP port rotation; SSH keys are stable across their
local proxy port rotation; a same-URL HTTP connection can change credentials
or authToken. The shared `GlobalProvider` previously compared only SDK
URLs to decide whether to retain the existing SDK/ServerCtx. That risked
reusing old authentication and subscriber state across a connection rotation,
even after the SessionGroup cache itself was invalidated.

- `server-transport-identity.ts` now provides one pure transport comparator
  and *scalar snapshot* of the connection (never a retained Solid proxy).
  It ignores presentation names but compares type, transport URL, username,
  password, auth-token setting, SSH host, and WSL identity. Credentials are
  compared **in memory only**; they are never logged, serialized into cache
  keys, or written into the engineering report.
- `GlobalProvider` SDK and ServerCtx cache entries capture that snapshot
  and dispose/recreate the owner when the *actual transport* changes,
  preserving the original independent lightweight SDK/full ServerCtx split.
  This edit was isolated from the other lane's dirty shared-project-index
  changes in that file. Selected SessionGroup detail snapshots also discard
  old principal state and reset their TanStack query key on same-key
  transport/auth rotation.
- For inactive-server inspector snapshots, connection revisions are detected
  even if Solid mutates a proxy in place. The old roster is discarded, any
  old network completion invalidated, and a live hover's reference-counted
  observer is reconnected to the new SDK without dropping its leases.
  Old event callbacks and already queued microtasks cannot mutate a new
  principal's projection.
- Remote structural event bursts now have a **150ms leading coalescing
  window** per watched server, including cross-task bursts, rather than
  just a single microtask. Closing the last inspector cancels the timer.
  If the current HTTP snapshot remains in flight when further events arrive,
  it is marked stale *without* launching overlapping HTTP requests. Exactly
  **one** successor request is admitted after it settles. The last close
  suppresses that successor as well. Ten thousand invalidations in the
  synthetic test create one original flight and one eventual replacement,
  not ten thousand new transports.
- Numeric per-server generation tombstones were replaced with deletable
  object-identity epochs for remote snapshots and a monotonic global sequence
  for selected-server detail refreshes. This allows disconnected scopes to be
  evicted without accepting an old response after a same-key reconnection.
  Randomized/reconnect tests cover 10,000 temporary server scopes and
  same-key reattachment.

**Event-stream ownership qualification:** `global.ensureServerSdk` is a
bootstrap-light SDK owner; its event emitter only receives SSE when another
runtime consumer has called `sdk.event.start()`. A remote hover listener
does **not** itself start a persistent SSE connection (by design, to avoid
keeping one open after a 450ms hover). Consequently remote event-driven
refresh is *best effort* when an existing server sync stream is active;
otherwise the data is an on-demand, TTL-bound snapshot. Do not treat the
remote observer's simulated-event tests as evidence that an inactive-server
SDK spontaneously receives SSE frames. A future solution must establish
shared reference-counted start/stop semantics with ServerSync before claiming
fully live inactive-server group inspectors.

### Legacy detail fallback: progressive and bounded store mutations

A second-order bottleneck remained after bounding legacy HTTP concurrency:
each completed `sessionGroup.get` called `setDetails(scope,...)`, forcing
one root-level group-detail mutation and potentially one full-navigation
reprojection per group. At 1,000 legacy groups this is effectively quadratic
UI state invalidation; simply buffering all responses until the last
HTTP request finishes would remove the quadratic work but regress
time-to-first-result badly on a slow server.

The final compromise uses `createSessionGroupDetailCommitter`:

- Four simultaneous HTTP detail fetches maximum (existing producer queue).
- A progressive **maximum 32-response store batch**, with first incomplete
  batch flushed within **75ms**; all pending batches flush at completion.
- Exactly one `setDetails(...reconcile(...))` per batch, not per response,
  while individually failed requests keep previous successful data.
- No idle timer, no per-tab listener, and pending flushes refuse to publish
  after the selected-server request generation changes.
- Deleted group IDs are pruned **once at fallback admission**, not scanned
  against the entire whitelist on every commit; this also avoids
  indefinitely retaining deleted groups when all current requests fail.

From `packages/app`,
`bun run benchmarks/session-group-legacy-details.bench.ts` compares
1,000 groups × 20 complete merges in seven warm, alternated trials.
Observed medians varied with allocator/GC/JIT state:

| Fixture | Per-group snapshot clone | 32-response batches | Isolated gain |
| --- | ---: | ---: | ---: |
| First progressive run | 428.714ms | 13.682ms | 31.33x |
| Retest after prune-once architecture | 477.380ms | 32.913ms | 14.50x |

The separate theoretical **one-shot** merge was around 0.94–0.96ms over
20 repeats and is *not* the shipped progressive strategy. These are
pure JS object-merging totals; actual Solid reconciliation, network
latency, time-to-first-render, memory and Electron frames are not
quantified by this benchmark. Exact speedup varies, and no renderer
improvement of 14x/31x is claimed.

### Retained-data cleanup and final verification boundary

The selected-server legacy fallback removes obsolete group IDs from the
cached detail map once per membership refresh, not once per progressive
batch; a missing/failed group response retains the still-valid previous
detail. When the authoritative group list becomes empty, the provider
invalidates the prior generation and drops its old detail snapshot. This
prevents memory retention after deleting a server's last group, even
without a successful future `listDetails` response.

Final combined focused app test run on this campaign: **152 pass, zero
failures, 24,463 assertions across 25 files**. The latest completed
app-wide `tsgo -b` exited **0**, and scoped Git whitespace check exited
**0** (a preexisting CRLF normalization warning for `context/global.tsx`
is not a whitespace failure). Other concurrently edited project explorer
and schema code was not modified to satisfy transient typecheck errors.

No real Electron CDP/GUI profiler was attached; do not claim complete
popover interaction/focus fidelity or measured input-to-paint latency.
The JSX test-loader `jsxDEV` issue prevents the full SessionGroups
component suite from running under the current Bun test conditions.
All work is local and uncommitted; no running sidecar/desktop process was
restarted or reconfigured.

## Final hard gates: actual stream lifetime and Electron acceptance

The last SSE gap was real: `global.ensureServerSdk(...).event.listen()`
attaches to an emitter, but the emitter has **no frames** unless the SDK's
event reader is running. The earlier remote hover implementation did not
admit that reader for otherwise inactive servers.

This is now addressed at the shared authoritative event-stream owner, not
by a separate hover-only SSE implementation:

- `createServerEventLifetime` manages idempotent, reference-counted
  stream leases. Two inspectors on the same server share **one** reader.
  Releasing the last lease stops it; a SessionSync lease keeps it alive
  independently, including when the final inspector closes. Disposed
  owners cannot revive a stream via delayed events.
- Both selected-server SessionSync and the inactive-server inspector
  acquire/release the **same SDK event lease**. The selected server's
  delayed activation remains scheduled through its previous animation-frame
  admission gate and releases its lease on context teardown. Hover acquires
  its lease only after the interactive inspector is open and releases it
  when its last observer detaches. Subscriptions attach before stream
  admission to avoid losing the first structural events.
- The preexisting `event.start()` contract remains compatible and pins
  if an independent legacy caller explicitly starts it; current SessionSync
  does **not** use that permanent pin, so tearing down that provider no
  longer leaves an otherwise unused SDK stream running. A BFCache
  `pagehide` stops the reader and `pageshow` resumes it **only** while
  an owner/lease still requires it. All transport/socket/reconnect/interest
  semantics remain in the existing ServerSDK owner.
- An open inactive-server inspector can now receive SSE structural updates
  even when no SessionSync tree has previously started the server SDK
  reader. The existing 150ms structural-event coalescer and one-successor
  latest-only snapshot admission remain in force.

The separate `session-groups.test.ts` file previously loaded
`session-groups.ts` (including its imported TSX components) for one pure
event-type classifier; Bun's TSX transform then attempted to import the
nonexistent `solid-js.jsxDEV` export. The classifier has been moved to
`session-group-event-filter.ts`, retaining a compatibility re-export from
the provider. Its test now runs with Bun directly. An independent
**in-memory Vite + vite-plugin-solid transform** compiled the titlebar
popover, SessionPreviewCard, and SessionGroups provider without any
`jsxDEV` import. This checks compilation only: the entire Solid component
tree has **not** been mounted in a real browser test.

For the remaining physical GUI acceptance gate,
`benchmarks/tab-hover-electron-cdp.ts` now provides an **explicit-opt-in**
Playwright CDP probe against an *already running* Electron renderer.
It never launches/restarts the desktop, PWA, Vite, or sidecar. It checks
hover-card appearance/disappearance, portal pointer crossing and member
keyboard arrows/Home where those controls exist, and reports p50/p95
hover-to-visible **upper bounds**, session-concurrency counts, and Chromium
heap/DOM/task metrics. Real CDP input/command overhead remains included
in those upper-bound figures. Only local CDP endpoints are permitted;
it requires both `OPENFORK_HOVER_LIVE_OK=1` and a concrete
`OPENFORK_HOVER_CDP_URL`. The diagnostic's source independently
typechecks with `tsgo --ignoreConfig --noEmit`.

Example, **only when the user has explicitly allowed UI interaction**:

```sh
OPENFORK_HOVER_LIVE_OK=1 OPENFORK_HOVER_CDP_URL=http://127.0.0.1:9222 \
  OPENFORK_HOVER_MIN_WORKING=25 bun run benchmarks/tab-hover-electron-cdp.ts
```

During this run, existing local CDP endpoints 9222, 9223, 9333, and
9229 were all unreachable. Following the repository's strict no-restart
rule, **no live renderer measurement was taken**, and no CDP port,
backend, or second desktop instance was started to fabricate one.
Real Electron input-to-paint fidelity and the 25/50/100 actually working
session matrix remain an **explicit outstanding acceptance gate**.

### Final integration refinement and verification

The selected SessionSync now uses `sdk.event.acquire()` rather than the
legacy permanent `start()` pin. Its lease is released on context disposal,
so a disposed SessionSync cannot inadvertently leave an idle SDK stream
running. Conversely, if a remote inspector is still open when SessionSync
tears down, that hover's lease keeps the shared socket alive until it
closes. The original `event.start()` return type/contract is retained for
external callers; this change does not affect SDK event routing, cursor
repair, stream interest or QoS.

An additional combined test drives a real observer-lease manager against
the stream-lifetime owner with 100 simultaneous inspector consumers,
verifying **one** underlying stream, **one** live event subscription,
structural refresh delivery, and exact final-close cleanup.

Final same-checkout validation after all changes:

- **158 passing focused tests, 0 failures, 24,500 assertions, 27 files.**
- App-wide `bun run typecheck` / `tsgo -b` exited **0**.
- Scoped `git diff --check` exited **0**.
- A targeted `bun test --conditions=solid --preload ./happydom.ts
  src/context/session-groups.test.ts` now passes, instead of the earlier
  `jsxDEV` import failure.
- The Electron CDP acceptance harness separately passes strict standalone
  TypeScript validation and deliberately refuses to interact with the GUI
  without both required explicit opt-in environment variables.

**Certification statement:** shared-stream ownership and the pure
session-hover model/controller/producer contracts are verified. Actual
renderer integration, accessibility, pointer-to-portal and memory behavior
remain **not certified**, because no existing approved Electron CDP port
was reachable and the repository forbids restarting the app merely to
instrument it. The pure classifier's Bun import was fixed; do **not**
confuse it with proving the entire Solid JSX provider can mount in Bun's
generic TSX test runner. Vite's production Solid transform did compile
the relevant components in an isolated in-memory check.