# OXP transport, observability and cold-start continuation — 2026-10-10

**Source-only engineering campaign:** this patch is present in the shared OpenFork checkout, **not deployed** to the ChatGPT-connected OXP host. No live tunnel, endpoint, model session, release artifact or database was restarted or mutated. The user has other active uncommitted work; preserve it and do not stage or commit unrelated files. This continuation builds on [the broker and schema optimization report](./2026-10-10-oxp-performance.md).

## Summary of implemented architecture

### 1. Bounded Fetch → Node MCP response delivery

**Owner:** `packages/opencode/src/oxp/response-stream.ts`; invoked by `src/oxp/server.ts`.

The previous adapter consumed a whole Fetch response through `response.arrayBuffer()`, created an additional full-size Node Buffer, and then called `ServerResponse.end(body)`. That incurred response-size-proportional intermediate storage and prevented genuine progressive delivery.

The new bridge:

- Consumes `response.body.getReader()` incrementally, writes native `Uint8Array` chunks directly to Node `ServerResponse`, and waits for `drain` when the HTTP socket indicates backpressure. It never invokes `response.arrayBuffer()` or buffers the entire response; normal memory is bounded by the stream queues, socket buffers and a fixed 128 KiB JSON writev group.
- For finite JSON responses only (`application/json` and `+json`), emits the first chunk immediately and groups later chunks up to 128 KiB through `res.cork()/uncork()`. Binary, SSE and unknown media types always flush each chunk to preserve progressive semantics. The JSON batching threshold was benchmarked against 512 KiB; the larger threshold regressed local throughput and was rejected.
- Drops upstream Content-Length instead of forwarding a possibly stale framing claim. Node supplies the correct streaming transfer framing; modern and 2025-era MCP client integration tests remain executable.
- Differentiates `finish` from a premature `close`; after-response effects run only on completed responses. A peer disconnect cancels the Fetch reader. A producer failure destroys the partial wire response and propagates to the OXP transport incident boundary rather than masquerading as success.
- Keeps response transforms in a standalone, low-dependency module suitable for independent stress and property fixtures.

This is **not a demonstrated global Pareto improvement**: different sizes/runtimes have different CPU/network costs. The primary architectural win is bounded intermediate response memory and progressive delivery; warm-loopback medians may improve or regress by payload size.

### 2. Low-cardinality, bounded phase measurements

**Owner:** `src/oxp/latency-histogram.ts`; integrated in `src/oxp/server.ts`.

Added fixed-size geometric bucket histograms for five lifetime process-local phases:

| Phase | Scope |
| --- | --- |
| `toolCall` | Entire tool execution envelope, including optional activity records and error handling |
| `dispatch` | Actual leaf/broker dispatch and typed failure, excluding activity settlement |
| `activityBegin` | Awaited activity begin path including its existing bounded recovery |
| `activitySettle` | Awaited activity success/failure path including its existing bounded recovery |
| `mcpTransport` | Handler Fetch response processing and HTTP emission through receipt boundary |

Snapshots report count, mean, measured maximum, and **quantized upper bounds** for p50/p95/p99. Upper bounds may overestimate by approximately 20% because bins grow geometrically. Each event updates a fixed in-memory counter array with a bounded binary search. No request attributes, caller identities, path names, prompts, tool arguments or time-series event records are retained.

`openfork_info(action=diagnostics)` and `openfork_diagnostics` expose the aggregates on demand; regular `openfork_info(status)` and catalog listings are not inflated with the histograms. The standalone diagnostic tool still works if ordinary config-backed authorization is unavailable. AX deployment identity now additionally exposes `transportStreaming` and `timingDiagnostics` revision fields.

### 3. Bench and integration gates

The script `packages/opencode/script/bench-oxp-response-stream.ts` compares HTTP delivery in one local Bun process: old full-body buffering against the new bounded writer, with new Fetch Responses, keep-alive sockets, validation of received byte counts, and local first-byte/total response timing. This **excludes** external provider calls, tunnel latency, authorization and MCP dispatch. Runs are small samples and machine load varies.

Representative run with JSON payloads and 128 KiB grouping:

| Payload | Legacy median | New median | Observation |
| --- | ---: | ---: | --- |
| 512 B | 0.220 ms | 0.197 ms | Both sub-millisecond; improvement in this trial |
| 32 KiB | 0.211 ms | 0.216 ms | Essentially comparable p50; new p95 was worse |
| 1 MiB | 0.963 ms | 1.372 ms | New path slower, while avoiding full-body buffer copies |
| 8 MiB | 15.813 ms | 14.023 ms | New median slightly better in this trial; p95 worse |

Because per-size samples were small (12–180 per mode), **do not infer stable percentage gains** or a distribution-wide win from these isolated values. A 512 KiB writev threshold showed worse medians/p95 than the retained 128 KiB threshold in another run and was reverted.

Validation:
- `bun test test/oxp/response-stream.test.ts test/oxp/latency-histogram.test.ts` passes, including 8 MiB byte-exact response, transparent content-length removal, a deferred second chunk proving first-byte delivery, receiver disconnect/cancellation, empty 204 response, and 100 concurrent independent 64 KiB consumers.
- Real MCP server test includes **100 overlapping requests over one SDK client**, mixing `openfork_diagnostics` and `openfork_info.status`, checking response type isolation, no errors, complete call counters and zero inappropriate activity records.
- `bun packages/opencode/script/verify-oxp-native-parity.ts --quick`: all selected gates pass (102 OXP/domain tests, 1,411 assertions plus 4 context-projection tests), after the new transport and timing instrumentation. This does not prove a whole-application deployment.
- Targeted TypeScript check of `src/oxp/server.ts`, `src/oxp/response-stream.ts`, `src/oxp/latency-histogram.ts`: **0 diagnostics in selected files; 11 transitive/imported diagnostics** in unrelated changing source, so full typecheck **is not green**.
- `git diff --check` over modified tracked transport/diagnostic files returned exit code 0.

## Next high-value architectural campaign: true listener/execution separation

The largest verified remaining import bottleneck is not the HTTP response: the current `src/oxp/active-runtime.ts` eagerly imports `src/oxp/server.ts`, whose top-level imports include `./surface` and `./capability`. `surface.ts` in turn imports capability/schema owner modules, and `capability.ts` imports all executable capability adapters. Consequently the graph is loaded even when the first client wants only protocol initialization or `tools/list`. Previously measured five-process host + active import median was **1.746 seconds** with median post-import heap approximately **54.5 MiB**, before proof of listener readiness.

A reproducible TypeScript source graph probe was added at `packages/opencode/script/audit-oxp-import-graph.ts`. It walks eager local import/export declarations, excludes `import type` and dynamic imports, and separately counts external package specifiers. In the audited shared checkout it finds:

| Entry | Eager local modules | Local source footprint | Distinct external package specifiers |
| --- | ---: | ---: | ---: |
| `oxp/host.ts` | 8 | 82 KiB | 14 |
| `oxp/active-runtime.ts` | 384 | 4,156 KiB | 230 |
| `oxp/server.ts` | 373 | 4,090 KiB | 227 |
| `oxp/surface.ts` | 363 | 3,971 KiB | 221 |
| `oxp/capability.ts` | 360 | 3,944 KiB | 221 |

This is source dependency reachability, **not** the compiled bundle size, bytecode retained heap, evaluated module count or a claim that every import causes meaningful cold execution. It does establish that `surface.ts` is currently an unsuitable cheap discovery boundary because reaching it pulls essentially the entire local execution graph. Fixing that dependency boundary is higher leverage than another small inner-loop optimization.

The safe redesign is a two-stage **transport plane / executable capability plane**, not merely changing a static import to `await import()`:

1. Generate a **canonical frozen transport manifest** from the actual owner definitions at build time, with a CI drift verifier that checks tool names, titles, schemas, annotations, instructions, direct/broker IDs, legacy projection, output schema and fingerprint. Never hand-maintain a second contract.
2. Keep a tiny listener/manifest runtime that answers initialization, paginated `tools/list`, and safe transport diagnostics without loading the privileged execution graph. Build/reuse the actual native Effect execution graph only for an admitted executable request and share a single in-flight initialization promise.
3. Make the graph load lifecycle-aware: a disabled/revoked host, listener stop, restart or aborted waiter must not allow stale runtime resurrection. Leaf authority and final egress revalidation stay in the execution plane. Startup promises must reject/reset cleanly without manufacturing a Session/credential/root.
4. Prove modern + legacy MCP SDK negotiation, immutable fingerprint/cursor parity, 100 simultaneous first executable calls (one graph owner), stop-vs-import races, cancel-before-first-run, per-leaf permissions, revocation-before-commit, and clean disposal/reconnect.
5. Benchmark separate intervals `disabled-state`, `host-import`, `listener-bound`, `first initialize`, `first tools/list`, `first executable call`, `warm executable calls`, and peak/retained heap. Include P50/P95/P99 and run the verified AX task corpus; cold list speed cannot be bought by breaking first authorized call or receipt semantics.

This split is **not yet implemented**. Production activation currently relies on a single Effect runtime whose service dependencies must remain coherent. Replacing it piecemeal without the lifecycle/parity gates risks duplicate Config/Root caches, lost cancellation, stale auth or double workers.

## Activity persistence decision gate

`activity.begin` and `activity.success/failure` remain awaited in the current OXP call envelope, using bounded SQLite busy retries. The new phase histograms can identify how much of actual p95/p99 latency occurs in activity vs leaf dispatch. Do not introduce an unchecked asynchronous writer or a detached logger. Only if real contention measurements establish a bottleneck, compare a bounded single-writer queue and an atomic durable outbox with crash/restart and ordering proof. Never mark unknown persistence as committed.

**Deployment status:** Source work only. Static manifest fingerprint alone does not prove an on-demand transport/telemetry rollout; after supported deployment, compare the `implementation.ax` revisions and perform live diagnostic + negative-grant + progressive/large-response verification.
