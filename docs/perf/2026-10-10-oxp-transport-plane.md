# OXP generated MCP transport plane — October 10, 2026

**Scope and deployment:** Concrete source-only implementation in the shared OpenFork checkout, without restarting the active ChatGPT OXP host, tunnel, browser, desktop, any live user Session, or another agent's processes. No commit/staging/reset/clean. The static schema fingerprint may remain unchanged, while `AX_IMPLEMENTATION.transportBoundary = "generated-manifest-protocol-pagination-owner-v1"` identifies this source implementation after an independently verified deployment.

**Source integration now achieved:** [the production lightweight enabled listener, first-call executable runtime admission, lifecycle tests and measured cold host phases](./2026-10-10-oxp-live-listener-split.md).

## Architectural finding

The initial importer audit found the existing disabled host imported 8 local modules, while `active-runtime.ts`, `server.ts`, and `surface.ts` imported approximately 384, 373, and 363 respectively, before any listener operation. The full source defines authoritative OXP tool schemas by eagerly importing all executable capability adapters. That couples MCP initialization/listing to the privileged execution graph.

A reliable cold-list split requires a frozen schema contract generated **from** the authoritative owners. Hand-maintaining an alternate catalog would violate the AX and tool-parity rules, risk stale schemas or misleading model descriptions, and widen execution claims beyond actual authority.

## Implemented

1. **Generated canonical manifest:** `script/generate-oxp-transport-manifest.ts` loads the actual `OxpSurface` source owner **only during generation/verification**, serializes 14 direct tools with complete input/output schemas, annotations, invocation metadata, instructions, legacy projection and fingerprint to `src/oxp/transport-manifest.generated.json` (109,927 UTF-8 bytes). `--check` compares byte-for-byte and fails on drift rather than repairing it silently. Do not hand-edit the generated asset.
2. **Independent static reader:** `src/oxp/transport-manifest.ts` imports generated JSON without any executable root, worker, capability or Session services; validates basic shape and deeply freezes its nested JSON. That prevents one in-process catalog consumer from poisoning another.
3. **Protocol/execution separation in production:** `src/oxp/transport-protocol.ts` now owns modern/legacy MCP negotiation, tools/list, schema validation, tool-result projection and after-response callback storage. It imports only the static schema reader and MCP SDK. `src/oxp/server.ts` delegates its real protocol handling to this module, injecting the existing authorized `executeToolCall` callback and internal incident projection. **No leaf authority, session ownership, post-response durable continuation, or mutating callback was duplicated.** The outer server still controls secret loopback binding, Origin/Host checks, request-body caps, cancellation, activity attribution, delivery receipts and lifecycle.
4. **Independent list pagination:** `src/oxp/transport-pagination.ts` now owns canonical generated-manifest warm-list caching, bounded byte-budget pages, strict/stale cursor rejection, and immutable 2025-era projection caching; arbitrary caller-provided arrays recompute their fingerprint to prevent stale mutable-schema cursors. `server.ts` retains a compatibility re-export for current tests/callers. `transport-canonical.ts` is the shared JSON canonicalization owner also used by `surface.ts`, keeping fingerprint semantics identical.
5. **Fail-closed parity and release gates:** `server.start()` checks the generated manifest fingerprint, schema content, instructions, output contracts and version against the real source owner **once before opening a socket**; it refuses a stale build rather than executing with misleading MCP schemas. `script/verify-oxp-native-parity.ts` now runs generated-artifact drift, transport eager-dependency graph audit, and transport schema/protocol tests before certifying selected OXP parity.
6. **Source graph guard:** `script/audit-oxp-import-graph.ts --assert-transport-purity` rejects new eager paths from the static/protocol/pagination modules into `server`, `surface`, `capability`, `Session`, `worker`, `root`, `config`, `tool`, and other privileged owners. This gate measures *source import reachability*, not runtime module evaluation or binary size.

## Benchmarks (Bun on Windows; isolated samples)

| Probe | Result | Limitation |
| --- | ---: | --- |
| Static manifest import (one fresh process) | 3.34 ms; 0.85 MiB sampled heap | Not full listener readiness |
| Source-owned `surface.ts` import (separate fresh process) | 1,728 ms; 59.58 MiB sampled heap | Different work; not a 500× whole-host speedup |
| `transport-protocol.ts` import (one fresh process) | 69.42 ms; 9.22 MiB sampled heap | Excludes Client, listener bind, Session and execution |
| Standalone protocol+listener+real modern MCP initialize/list (five fresh processes) | Median **320.20 ms** total; 17.07 MiB sampled heap | An intentionally mock execution callback; not production host readiness |
| Five-process standalone import phase | median 106.04 ms | Independent system load; range 79.51–767.27 ms |
| Five-process listener bind | median 6.76 ms | Local ephemeral port, no tunnel |
| Five-process MCP initialize/connect | median 129.84 ms | Modern test client only |
| Five-process tools/list | median 17.78 ms | 14-tool canonical static manifest |

The five-process probe is reproducible with:
`bun packages/opencode/script/bench-oxp-transport-cold.ts`.
Baseline active host+runtime import was previously measured at median 1,745.94 ms/54.49 MiB from five fresh processes. It is **not directly comparable** to this standalone end-to-end protocol probe because it does not bind the original server or perform the same client operations.

## Verification

- `bun packages/opencode/script/generate-oxp-transport-manifest.ts --check`: PASS, canonical `9838e0ecddf4df6f49e435f2c3a2cc0fc49b9cf2ee2546f01b76ce9933b636e0`, 14 tools, 109,927 bytes.
- `bun packages/opencode/script/audit-oxp-import-graph.ts --assert-transport-purity`: PASS. Static manifest: **2** eager local modules including JSON; pagination: **4**; protocol: **3**. The original full server still has ~380 eager local modules, reflecting unfinished active-runtime separation.
- `bun test test/oxp/transport-manifest.test.ts test/oxp/server.test.ts`: PASS **21 tests, 363 assertions** after moving pagination into the transport plane.
- `bun test test/oxp/transport-protocol.test.ts`: PASS **2 tests, 77 assertions**, with real modern and legacy MCP SDK clients over ephemeral HTTP. Modern checks input/output schemas, annotations, private metadata, version and denial when no execution owner exists; legacy verifies compatible output schemas. The modern SDK removes top-level `securitySchemes` from its returned client projection but preserves `_meta.securitySchemes`, as the older production transport tests expect.
- `bun test test/oxp/transport-pagination.test.ts`: PASS **4 tests, 54 assertions**, including canonical cursor iteration, mutable nested-schema rejection even if an array is shallow frozen, malformed/forged/stale cursor rejection, and exact shared-owner fingerprint equivalence.
- **Final consolidated selected verifier after the transport migration:** `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` PASS, including generated-manifest drift (2.018 s), transport dependency-purity check (1.185 s), Core context projection, and **110 OXP/domain tests, 1,552 assertions** (25.77 s). The verifier originally failed because the import-graph audit used the invoking cwd; source resolution was corrected to use `import.meta.dir` and the full selected gate subsequently passed.
- Scoped semantic `tsgo` typechecking of the three new/modified transport source files: **0 target diagnostics**, but the command exits nonzero due to unrelated transitive errors in other changing shared modules. Do not claim full-package typecheck passed.

## Remaining engineering gates

**The full production listener is still constructed by `OxpServer` inside the active Effect runtime.** Extracting protocol/listing from that module is genuine prerequisite work, but does *not* yet defer native execution-graph initialization for the enabled endpoint. A safe production split must preserve one Config/Root/Session authority owner, host operation serialization, cancellation and revocation during concurrent first calls, endpoint stop versus initialization races, and the invariant that runtime-refresh effects occur only after the actual client response finishes. Do **not** fake a win by proxying a request to a second OXP HTTP endpoint; that could acknowledge a delivery-dependent mutation too early.

Next: design a single-owner lazy execution port attached to the now-independent transport listener; test disabled/enabled transitions, 100 concurrent first calls, cancel/stop races, modern+legacy `initialize` and `tools/list`, and authenticated executable post-response receipts under revocation before measuring full process-start-to-listener-ready p50/p95/heap. See [the earlier activity-writer and phase telemetry work](./2026-10-10-oxp-transport-continuation.md).

**Release integration note:** The native/OXP parity verifier now enforces manifest drift. The general multi-target `script/build.ts` was concurrently dirty and was not touched; any release flow that skips the verifier must independently add/check the same generated-artifact gate before this work is considered fully integrated.
