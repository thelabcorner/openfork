# OXP startup and MCP hot-path optimization (October 9, 2026)

## Authority, deployment, and measurement scope

This is a **source-checkout** AX performance campaign. The connected ChatGPT OXP connector still reports `runtime.refreshable=false` and its old AX schema revision; it has **not** loaded these changes. Existing concurrent worktree changes and production SQLite files were left untouched. No endpoint was restarted. OXP remains an independently authorized external principal; discovery is not a grant, and root checks are not cached across calls.

## Measurements and source changes

| Path | Before | After | Qualification |
| --- | ---: | ---: | --- |
| Fixed `tools/list` pagination, warm median, 2,000 iterations | 0.2765 ms | 0.0005 ms | ~553x less pagination CPU in one fixture, **not** MCP round-trip time |
| Fixed `tools/list` pagination, warm p95 | 0.4492 ms | 0.0014–0.0020 ms | Separate test processes and load; indicative only |
| Permanent MCP manifest JSON | 46,131 bytes | 46,131 bytes | This patch does **not** reduce provider-visible tool metadata/context |
| OXP host module import, single process | 1,846 ms / 61.16 MiB heap | 2,600 ms / 60.24 MiB heap | Non-comparable concurrent host load; **no startup speedup claim** |

### Active-module isolation follow-up

After the preliminary deferred-graph-only change, a structural audit found that `host.ts` still statically imported the entire MCP/worker/provider execution graph. The implementation now moves that **unchanged active graph and service tag identities** to `src/oxp/active-runtime.ts`, imported on demand **only after enablement and idle-runtime retirement**. Only one module-import promise and active ManagedRuntime may be instantiated; the session/request/worker/MCP/SystemOne controls and V1 overrides are unchanged. Disabled-state/Settings now loads only the small Config/Root graph.

**Production artifact constraint:** Electron OXP runtime refresh treats `dist/node/node.js` as a single transactional artifact. An isolated Bun bundler experiment confirmed `splitting:false` produces one JS artifact and defers module evaluation, whereas `splitting:true` produces a second chunk. `script/build-node.ts` therefore now explicitly fixes `splitting:false` and rejects extra JS outputs for the sidecar entrypoint; `test/oxp/sidecar-bundle-boundary.test.ts` checks this without modifying the live `dist/node` or triggering a runtime refresh. A real packaged-sidecar activation/refresh test is still required before rollout.

The same `bun script/bench-oxp-idle-startup.ts` phase probe gave **1,813.635 ms import / 94.718 MiB heap** before this isolation and **847.889 ms import / 41.807 MiB heap** afterward, with 7 roots and no connection activation: approximately **2.14x lower idle import elapsed time and 55.9% less sampled heap**. These are two uncontrolled samples and are not a statistically controlled cold-start distribution. First-state latency remained near 25 ms. A separate post-change fresh process measured 951.21 ms host import, 1,027.14 ms additional active-module import, 1.99 ms active-runtime factory, or 1,980.35 ms to reach the factory (without initializing a listener). Consequently **enabled-connector cold startup is not proven faster**; deferring heavy work can instead move its latency to first activation. Full endpoint readiness/cold first-call must be benchmarked and validated after supported rollout.

An additional isolated child-process `OxpHost.getState()` probe measured import **2,162.37 ms**, first idle state **25.83 ms**, and second warm state **3.77 ms** with 7 approved roots (5 available). This indicates module loading dominates that sample's idle path. Reproduce the read-only phase probe with `bun script/bench-oxp-idle-startup.ts` from `packages/opencode`; the script neither opens an endpoint nor changes configuration.

### Canonical pagination

`src/oxp/server.ts` now lazily memoizes sorted canonical `OxpSurface.TOOLS` and each tool's serialized-byte cost. A `tools/list` request reuses these immutable projections; it retains the existing byte-budget pagination and fingerprint checks. The server also lazily registers its **own frozen 2025-era compatibility projection** in a weak-keyed fixed-list cache, with its own one-time fingerprint and byte costs; this is the current ChatGPT client era. Noncanonical/unregistered projections are sorted, costed, and fingerprinted afresh, including when a caller mutates a custom array in place. Caching is restricted to known server-owned immutable manifests and never caches privilege/grant decisions. The microbenchmark table above measures the modern canonical list; the equivalent legacy-path optimization still needs its own isolated speed measurement.

### Stateless MCP request setup

The per-request MCP `Server` retains its request-specific lifecycle and transport isolation. The 2025-era compatibility tool projection and per-era `fromJsonSchema` output validators are now constructed lazily **once per endpoint** rather than on every request. Both 2025 and 2026 transport regression tests passed. Future profiling should measure actual process allocations and end-to-end validation cost under simultaneous requests.

### Disabled-host and root startup

`src/oxp/host.ts` defers compiling the large active `AppNodeBuilder` graph until the first admitted active runtime; the idle Config/Root graph remains separate. `baseStateEffect` checks independent root availability with bounded four-way `Effect.forEach` concurrency instead of serial realpath/stat operations. **Every** root still performs its own canonical realpath/identity checks; the change is scheduling, not authorization caching. Preserve original root order and unavailable-root projection. No optimistic assertion of cold-start improvement is supported by the import samples.

### Follow-up: state-read epochs, code discovery, and historical recovery

- `src/oxp/host-operation-queue.ts` now coalesces only **overlapping adjacent** `getState()` observations. Each mutation/lifecycle enqueue invalidates reuse; settled state and failed reads cannot be cached. This preserves queue linearization and forces fresh Config/Root authorization *checks*, not a time-based shortcut. A read-only, single-process 64-request burst with seven approved roots measured 87.394 ms for 64 sequential reads versus 1.630 ms for 64 concurrent/coalesced reads (53.6x burst ratio). This is **not** a per-verification speedup or an uncontrolled cross-process throughput comparison.
- A follow-up five-process read-only candidate sample measured medians of **910.767 ms idle import** (range 745.751–946.599 ms), **24.056 ms first state**, **1.903 ms warm state**, and **41.883 MiB heap**. The same runs measured **81.564 ms serial 64-read** and **1.231 ms concurrent burst**, with a median within-run burst ratio of **64.554x**. Import/heap are *candidate only* and do not establish paired pre-change gains; the burst metric measures duplicate-work elimination, not faster filesystem calls.
- The direct `openfork_info(status)` handler now uses the same bounded-four parallel root availability checks as the trusted host projection. Root identities are still verified independently; an unavailable result is still reported, and the original root order is retained.
- `src/oxp/capability.ts` memoizes Code Mode's fixed native-definition ranking generation and local inventory within one graph. Dynamic external MCP inventory, leaf dispatch and authorization are **not** cached or inferred from that inventory. The OXP definitions Map is constructed once and populated with its final `code` entry before either memoized value is first read.
- `src/oxp/activity-recorder.ts` now proves historical host death in batches of **at most four read-only checks**, then serializes the resulting interruption writes in original candidate order. A failed individual proof is not permission to interrupt a host. The 12-candidate mock regression checks maximum parallel proofs, completed proof bookkeeping, rejection of unproven hosts and ordered writes. This targets startup when stale host generations accumulate; no production elapsed-time gain is asserted without an actual stale-host fixture.
- The SQLite activity recorder remains on the critical request path for correlated work; do not claim the above changes resolve the connected host's observed `SQLITE_BUSY` contention. Its existing retry and failure-isolation invariants are unchanged.

### Validated post-continuation release gates

- The focused host-queue, MCP server, Gate-C contracts, pagination, and single-artifact bundler set passed **42 tests / 0 failures**, before the additional historical-recovery change.
- The expanded activity-recorder set passed **21 tests / 0 failures**, including the 12-historical-host parallel-proof and serialized-interruption test. Its warm recorder best medians were **0.363 ms begin** and **0.191 ms settle** in one loaded fixture; this does not measure busy-tail latency.
- The OXP native-parity quick verifier passed **4 Core context tests + 102 OXP tests (1,411 assertions)** with **zero failures** and successful selected release gates. This validates checkout source, not currently connected MCP host deployment or other transport parity.
- Run the union of the above focused tests after any later changes to queue type parameters, recovery or Code catalog caching; package-wide TypeScript has not been certified because earlier independent runs encountered compiler memory/exception failures.
- **Final post-edit union rerun:** `bun test test/oxp/host-operation-queue.test.ts test/oxp/activity-recorder.test.ts test/oxp/gate-c-boundary.test.ts test/oxp/gate-c-performance.test.ts test/oxp/server.test.ts test/oxp/sidecar-bundle-boundary.test.ts` from `packages/opencode` passed **63 tests, 2,806 assertions, zero failures**. Pagination median **0.0006 ms**, p95 **0.0014 ms** in 2,000 iterations; recorder best medians **0.359 ms begin** and **0.196 ms settle** in the last fixture run. `git diff --check` on edited tracked OXP/perf paths passed. No live MCP host was modified.

### Actual single-artifact compilation caveat

An isolated Bun `target:node, splitting:false` build of the sidecar entrypoint produced one 36,344,279-byte JS artifact plus expected WASM assets. This validates the one-JS-output shape, **not** complete Desktop loading: a direct fresh-process import of that scratch build failed on the intentionally external optional `@lydell/node-pty` dependency. The scratch build is not the normal generated/packaged sidecar and cannot certify first-connection readiness. Fresh imports of `host.ts`, `active-runtime.ts`, `capability.ts`, and `server.ts` in isolated Bun processes ranged from roughly 1.17–2.86 seconds; unequal filesystem/runtime cache state means these are allocation/import diagnostics, not comparable speedup ratios.

## Regression gates

From `packages/opencode`, run `bun test test/oxp/server.test.ts test/oxp/gate-c-performance.test.ts test/oxp/gate-c-boundary.test.ts`. The tests assert canonical paging/opaque cursor invalidation, MCP modern/legacy transport, revocation, request cancellation, disabled activation ownership, and schema correctness. Existing Gate-C size/prose expectations were reconciled with the real current manifest: hard cap 47,000 bytes (869 bytes headroom at measurement), reviewed per-tool description limits and the existing `focusAction`/`guidanceMode` fields. The warm list median guard is now 0.05 ms rather than 1 ms; this guards against accidentally restoring repeated whole-manifest JSON serialization. A passing fixture is not a client-facing throughput claim.

Also run `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` from the repository root. This remains OXP-only source dispatcher evidence, **not** OFXP/ACP/MCP transport certification. Package-wide TypeScript was not certified by this campaign; prior heap exhaustion/TypeScript compiler exceptions must not be reported as clean checking.

## Next highest-leverage experiments

1. **Cold startup:** profile OS-level process start, OXP host import, config/idle runtime, deferred active-module import and graph materialization, listener bind, MCP initialize/list, and first authorized tool call as *separate* phases on an otherwise idle machine. Attribute CPU, heap and filesystem waits. Prove the new lazy boundary reduces idle import without regressing enabled activation; add an isolated active-endpoint startup fixture with an injected disposable Global/config state before claiming ready-time improvements.
2. **Per-request transport:** benchmark modern/legacy no-op MCP calls with 1/10/50 concurrent clients, comparing baseline/current/candidate p50/p95/p99 and allocations. Prove request cancellation, content-length limits, response schemas, and request identity remain isolated. Record client transport and runtime revision.
3. **Root availability:** use temporary directories and controlled artificial path-latency to compare serial versus bounded four-way verification across 1/10/100 roots; include unavailability, symlink/reparse replacements and revocation while calls are in flight.
4. **SQLite attribution:** distinguish fresh `SQLITE_BUSY` from constraints/schema failures, and separately measure activity begin/settle and file/session links. Do not make successful tool results wait for unbounded observability retries or blindly replay uncertain mutations.
5. **Context economics:** examine the 46,131-byte permanent manifest per-tool (Session 6,030; worker 5,554; edit 4,978; Git 4,691 bytes in this checkout). Any reductions need decoder-backed executable action parity, unchanged model call correctness, and measured end-to-end AX task completion; do not simply strip useful fields to satisfy a byte budget.

## Rollout gate

Source changes are **not live deployment**. Only after an authorized, non-disruptive supported rollout: compare `openfork_info.status.schemaFingerprint` and `implementation.ax` with newly built source identity, re-fetch the actual client tool manifest, exercise modern and 2025 MCP clients, verify nested-project AX features, and measure first-call and concurrent round-trip latency. `runtime.refreshable=false` prohibits claiming a hot refresh of the current connector.