# OXP performance and AX continuation — October 10, 2026

**Status:** Source changes in the shared OpenFork checkout. They are **not deployed** to the ChatGPT-connected OXP sidecar. No tunnel refresh, live endpoint restart, broad staging, or commit was performed. Existing concurrent edits are preserved. Do not represent isolated CPU microbenchmarks as end-to-end MCP or agent task improvements.

**Continuation:** [bounded MCP response transport, 100-overlap integration gate, phase histograms and remaining cold-start split](./2026-10-10-oxp-transport-continuation.md).

**Further startup architecture:** [build-generated MCP manifest, independent modern/legacy protocol and pagination, drift/reachability release gates, and cold-listener measurements](./2026-10-10-oxp-transport-plane.md).

## Goal and immutable boundaries

Minimize cold readiness, warm request CPU and heap, SQLite contention, and repeated agent discovery work while maximizing authorized, independently verifiable task completion. Follow `.agents/skills/agent-experience/SKILL.md`, the repository's AGENTS/parity contracts, and `docs/architecture/ax-oxp-cos-codex-2026-10-09.md`. Native V1 owners retain execution semantics; OXP is an independently authorized external principal. Discovery and cached schema data do not grant root, integration, or Session authority.

## Reproducible source-level measurements

| Phase/workload | Observation | What it does **not** show |
| --- | --- | --- |
| Idle host import + state | One run: 683.636 ms module import; 25.265 ms first projection; 1.917 ms warm median; 7 roots (5 available). 64 sequential state reads 76.432 ms versus 64 concurrent coalesced reads 1.178 ms. | Complete endpoint readiness or individual root verification speedups |
| Host + active module imports | 5 fresh-process samples: host import median 807.065 ms; active incremental import 943.861 ms; combined 1,745.937 ms; median heap after imports 54.491 MiB. Combined range 1,595.809–3,609.694 ms. | Cold disk-cache distribution, listener startup, desktop or ChatGPT transport |
| Foreign MCP selector, 500 tools | 7-run median of repeated CPU measurements: bare 58.656→1.991 µs, canonical 71.788→2.966 µs, missing 57.012→1.494 µs. | Native MCP server enumeration, authorization, process/network transport |
| Foreign MCP selector, 3,000 tools | Bare 382.025→11.542 µs, canonical 436.926→16.878 µs, missing 352.063→9.729 µs (median, same probe). | End-to-end MCP request time |
| Broker contract, synthetic 35 KB descriptor | Re-parsing and re-hashing on each valid replay: 358.705 µs median per check. Cached primitive token avoids these operations. | Direct inference of total tool latency |
| Broker contract, synthetic 139 KB descriptor | Prior parse + canonical hash: 1,931.168 µs median per check. Cached primitive token avoids these operations. | Actual distribution of production schemas or exact speedup across engines |

Source probes, run from repository root:
```bash
bun packages/opencode/script/bench-oxp-idle-startup.ts
bun packages/opencode/script/bench-oxp-import-phases.ts
bun packages/opencode/script/bench-oxp-mcp-selector.ts
bun packages/opencode/script/bench-oxp-contract-replay.ts
```

The very large numerical *ratio* between a hash of a synthetic descriptor and a simple string comparison is not a valid whole-tool speedup. It is presented here as eliminated work, not a throughput claim. Measurements used Bun 1.4.3-canary.1 on Windows with concurrent machine activity and possibly warm filesystem caches.

## Changes actually implemented

1. **Immutable OpenFork broker catalog:** `src/oxp/capability.ts` materializes canonical unfiltered all/default/lazy rows once per active Effect service and reuses them. It also materializes the immutable definition subsets for filtered ranking. Fresh `authority.authorize` and `authority.discover` checks are still performed on every list. No cross-runtime catalog persists.
2. **Foreign MCP selector:** `src/oxp/mcp-selector.ts` decodes an external canonical selector once, confirms exact canonical spelling, and scans fresh native-MCP enumeration by server/tool identity without encoding every candidate. Unique bare-name fallback, collision resolution and up-to-eight repair IDs retain their original behavior. `src/oxp/mcp.ts` still re-admits and revalidates the root and refreshes the MCP inventory before each call. Pure regression fixtures and 2,000 deterministic reference comparisons established selector equivalence.
3. **Trusted descriptor replay:** `src/tool/broker-contract.ts` gained `violationExpected` for comparison to an owner-held contract minted by the canonical `make` function. `src/oxp/capability.ts` caches serialized descriptor snapshots, trusted digest, and derived rootID acceptance under the immutable per-runtime Definition identity. Subsequent calls check primitive digests and avoid full schema parse/canonical SHA-256; external MCP calls use the digest just minted from the freshly enumerated schema, avoiding a second hash. The descriptor itself still returns a newly parsed JSON object on cache hits to prevent mutable output poisoning. A contract is never supplied by the caller as the expected value, and a focused action remains bound to its own schema.
4. **HTTP ingress allocations:** `src/oxp/server.ts` reuses each endpoint's three allowed Host values rather than creating a Set per incoming request. One-chunk bounded request bodies decode directly without a redundant Buffer copy; multi-chunk, oversized and invalid JSON behavior remains owned by the same bounded handler.
5. **Deployment provenance:** `AX_IMPLEMENTATION.contractReplay = "owner-held-schema-digest-v1"` exposes this on-demand change independently of the static MCP tool-surface fingerprint.

No native capability was added or remapped; this is a hot-path change to existing dispatch, not a new parity cell.

## Verification and remaining gates

- `bun test test/oxp/broker-contract-fast.test.ts test/oxp/mcp-selector.test.ts test/oxp/host-operation-queue.test.ts` (from `packages/opencode`): **9 passed, 32 assertions, zero failures**.
- The selector matched the prior implementation for **2,000 reproducible deterministic random selectors**, including Unicode, percent signs, slash-containing names and ambiguity.
- Isolated TypeScript transpilation reported no syntax diagnostics for the modified OXP and shared broker source files or probe scripts.
- Early in the session `src/session/message-v2.ts:1851` had a parser error from a concurrent lane, blocking the broader tests. **The concurrent lane subsequently resolved it without changes from this OXP campaign.**
- `bun packages/opencode/script/verify-oxp-native-parity.ts --quick`: **all selected gates passed**, including **102 OXP/domain tests and 1,411 assertions** plus 4 Core context projection tests. The 102-test block took 31.85 seconds; no failures.
- `bun test test/oxp/mcp.test.ts test/oxp/server.test.ts`: **31 passed, 190 assertions**, including canonical external selection, root/integration authorization and revocation, unknown mutation outcomes, Host/Origin validation, MCP protocol eras and actual loopback transport.
- OXP scoped `typecheck(files)` initially identified two fingerprint-union typing errors in `src/oxp/server.ts:152,167`. They were corrected by requiring a string-valued legacy cached fingerprint; the fixed manifest continues to use its constant owner fingerprint. Repeated compiler check of five modified OXP/broker files: **0 target diagnostics, 10 transitive diagnostics** (unrelated import-resolution, usage and HTTP handler types). The scoped command still exits nonzero because of those imported files. Transport suites passed again after the fix: **31/31**.
- Full-package TypeScript semantic checking, whole-application startup/reconnect testing, and production concurrency benchmarks have **not** passed or been established; they cannot be inferred from scoped transpilation or selected parity gates.

## Highest-impact remaining architecture — implement behind validation gates

### Phase A: enabled-endpoint cold-start separation

The new import-phase benchmark locates roughly 1.7 seconds median in host + active runtime module evaluation before any listener-ready verification. Separate the **static transport manifest** from the eager `OxpSurface` execution/schema imports and the `OxpCapability` graph. Generate a canonical, reproducible MCP manifest at build time from the native executable definitions, embedding a source/manifest fingerprint. Cold listener initialization should import only a small transport/manifest package; initialize Tier-2/Tier-3 authorized execution ports once, coalesced, on the first executable call. The source build must fail if the generated manifest disagrees with the native decoder, tool annotations, constraints, action matrix, or version. In-flight initialization must be cancellation-safe and lifecycle-aware; a listener shutdown cannot leak a graph or execute a queued request under revoked authority. **Do not land the module-graph split without a dedicated cold-start and transport-lifecycle suite in addition to the now-passing selected parity gates.** Prove initial tools/list, initialize, concurrent first calls, stop-vs-load races, negative root authorization, stale schema and no duplicate service owner.

### Phase B: activity writer lane

`server.ts` still awaits optional `activity.begin` before dispatch and optional settlement before responding. In contention, bounded SQLite retries can therefore add significant user-visible latency. Instrument phase-level p50/p95/p99 for begin, links, settle, native dispatch and writer-lock episodes. Then compare (1) existing serialized writes/retries, (2) bounded, ordered single-writer activity queue, and (3) a durable transactional outbox. No unbounded fire-and-forget writes, fabricated persisted receipts, dropped commit identities, or changes to application mutation authority. Prove crash recovery, ordering, bounded memory, stop/drain behavior, and explicit missing-attribution reporting before choosing a redesign.

### Phase C: transport and task economics

Measure `tools/list`, `tools/call`, body parsing, output-schema validation, large structured result projection, request cancellations and after-response receipts at 1/10/100 concurrent clients. Compare model-level AX-16 task outcomes (discovery precision, first-call validity, total retries, elapsed time, tokens, permission safety, unknown commits, and independently verified completion). Eager prewarming or caching root/Session authority is not an acceptable shortcut.

### Phase D: deploy and prove identity

After resolving any remaining package-wide type diagnostics and choosing a supported non-disruptive deployment window, compare `openfork_info(status).implementation.ax.contractReplay` and the exact static `schemaFingerprint` against source. Verify live status, negative permissions, live describe/call across direct and broker routes, schema freshness, reconnect, and concurrent calls. The current connector has `runtime.refreshable=false`; checkout changes cannot be represented as already live.

**Stop conditions:** The selected parity gates pass, but do not claim a whole-package/typecheck pass or a deployed runtime without separate evidence. No cold-start breakthrough claim until enabled-endpoint listener-ready timings improve with reproducible real protocol traffic, not merely isolated imports.
