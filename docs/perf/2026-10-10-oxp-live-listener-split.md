# OXP production lazy listener and executable-runtime separation — October 10, 2026

**Scope:** Source engineering on the existing shared OpenFork checkout. OXP connected from this ChatGPT conversation is still an **older live host**; no deployment, restart, tunnel mutation, broad staging, commit, or rewrite of unrelated dirty files occurred. This document updates [the static manifest/protocol plane research](./2026-10-10-oxp-transport-plane.md) and [transport reliability work](./2026-10-10-oxp-transport-continuation.md).

## What changed

The enabled desktop OXP host previously awaited construction of `active-runtime.ts` and the complete privileged Effect execution graph before binding its unguessable MCP listener. Earlier verified source eager reachability was ~390 local modules and a large transitive dependency graph.

The host now starts a **real lightweight, independently bound loopback MCP listener** through `src/oxp/transport-listener.ts`, using the generated canonical manifest and the already-validated modern+legacy protocol and pagination owners. This does not instantiate `active-runtime.ts` merely to answer initialization or tool discovery. It still requires the existing idle Config/Root services to confirm OXP is enabled. The listener preserves the original secret 32-byte base64url token path, strict Host/Origin/method/path checks, bounded request intake, propagated cancellation, stream backpressure, opaque incident IDs, and after-response continuation semantics.

For the first executable `tools/call`, `host.ts` routes admission through the **same serialized host-operation queue** used by enable/stop/grant operations. A listener-generation guard rejects stale calls, with checks before runtime setup and before dispatch. It retires idle Config/Root before importing/provisioning the heavyweight runtime: there must not be two competing Config authorities. The native `OxpServer.Service.execute` method is exactly the old complete activity/authorization/projection envelope relocated to service scope; no alternate executor was invented. Subsequent calls share its service identity but **never cache a permission, root, grant, Session, or execution result**. Every leaf is still authorized and revalidated.

The previous `OxpServer.start` embedded a second, divergent HTTP listener. It now binds the **same** `startLeanOxpListener` with the full native execution callback. Tests still use this existing owner path. The service's endpoint wrapper preserves idempotent stop Promise identity and clears its active reference when retirement finishes. Obsolete duplicate HTTP parsing/cancellation/Host checks were removed; the externally used cancellation utility is re-exported from its transport owner. The server preserves its existing deployment fingerprint and static-schema **fail-closed** comparison against native source.

**Critical executable admission guard:** Because the listener intentionally cannot import source-owner schemas at startup, `OxpServer.Service.validateManifest` compares the generated manifest against the dynamically loaded authoritative source **on first executable admission**, before caching or calling the executable service. A mismatch produces a typed `OXP_DEPENDENCY_UNAVAILABLE` rather than invoking a capability with a misleading schema. The direct `OxpServer.start` API uses the same guard before opening a socket. The release verifier also checks manifest drift before any tests. These barriers serve different purposes; the checkout/build check is still mandatory for discoverability correctness.

The host's `listWorkerAgents` and `setWorkerDefaultAgent` are **legitimate Tier-2 workspace operations**, not cheap static reads. They explicitly activate the same privileged runtime on demand even if no MCP tool has yet been called. Disabled OXP remains denied. The new host no longer incorrectly treats enabled-but-not-yet-executed as disabled.

## Verification completed in disposable subprocesses

New `test/oxp/host-lazy.test.ts` invokes only disposable XDG config/data/state/cache roots and temp workspaces. Its child `fixture-host-lazy.ts` explicitly checks that XDG points at the temporary test config before opening OXP. It tests a disabled initial state, approved root/grant configuration, enabled-listener binding, protocol initialization, catalog listing of 14 authoritative tools **before active runtime initialization**, and **100 overlapping first executable requests**, alternating root-scoped file reads and `openfork_info.status`. The host metrics report at least 100 calls. It then disables the real config, verifies a fresh read is denied, and stops/disposes the endpoint.

Additional fixture modes cover:

- **Workspace catalog first:** Disabled catalog request denied; after enable, catalog resolves 5 agents through the genuine V1 owner even before any MCP executable call; subsequent MCP discovery and requests succeed. This legitimately reaches the native workspace InstanceStore and greatly increases runtime memory. In this fully isolated fixture, native V1 application-wide watchers outlive the OXP service; after OXP disposal and `InstanceStore.disposeAll`, the child exits explicitly **only on assertion success**. Production OXP must never dispose application-global instances merely to pass this test.
- **Stop versus first-call race:** The first in-flight request may complete or be rejected depending on admission order, but stop must retire the listener without resurrection and a new request to the old secret URL must be rejected.
- **Receipts:** 8 complete modern MCP calls arm exactly 8 `afterResponse` continuations through the lightweight listener after HTTP completion.
- **Standalone transports:** Modern and 2025-era MCP SDK clients list the same complete static transport manifest; unknown/hostile hosts, origins and paths are rejected before executor; stop callers coalesce and sockets close within their bound.

`script/audit-oxp-import-graph.ts --assert-transport-purity` now protects **host.ts itself**, `transport-listener.ts` and pure pagination/protocol/manifest/incident modules against eager imports of the actual privileged runtime or workspace. Example audit from the shared checkout: `host.ts` ~18 eager local source modules, `active-runtime.ts` ~394; `transport-listener.ts` 8. The guard does **not** count external package transitives, bytecode evaluation or whole-app heap.

## Startup measurements (three Windows/Bun child-process samples)

Reproduce with `bun packages/opencode/script/bench-oxp-host-lazy.ts`, which runs the disposable host fixture in three distinct child processes, validating every run.

| Phase | Samples (ms) | Median (ms) | Sampled heap |
| --- | --- | ---: | ---: |
| Enabled listener ready | 1,787 / 1,533 / 1,667 | **1,667** | **52 MiB** |
| Modern MCP initialize + first tools/list | 1,867 / 1,597 / 1,742 | **1,742** | **52 MiB** |
| 100 overlapping first executable calls complete | 7,491 / 5,694 / 5,452 | **5,694** | **129 MiB** median |

These numbers include initial disabled host state read, disposable root approval/grant update, enabling and listener creation, and client SDK import. They are **not comparable** to the previously reported 1,746 ms median for *importing* host+active runtime alone, or to the standalone protocol/listener probe. They do not establish a whole-product cold-start percentage speedup. They do prove a real, authorized enabled host can finish initialization/listing **before loading its executable runtime**. Subsequent first calls pay that runtime's initialization cost. In a separate catalog-first run native V1 Instance bootstrap raised sampled heap to ~573 MiB, illustrating why workspace operations cannot be treated as Tier-0 reads.

There is no evidence yet on p95/p99 across many machines, encrypted public tunnel latency, or production SQLite writer contention. Three local samples are insufficient for broad statistical claims.

## Authority, lifecycle, and remaining gates

- No automatic delegation or new Session is created to start OXP. All external tool execution still enters the canonical runtime and independently enforces root/grant/action checks. Host queue and listener generation avoid resurrecting a retired endpoint. `stop()` is idempotent and completes within a bounded socket-force timeout.
- After-response callbacks run only when the HTTP writable has finished. A peer disconnect does not turn an unknown mutation outcome into a confirmed result, and invalid/dropped requests must not trigger a refresh trial arm.
- OXP direct workspace agent preferences activate Tier-2 on demand, preserving the existing native catalog semantics instead of fabricating a lightweight replacement.
- The single `transport-listener.ts` is the source of truth for HTTP/transport security. Changes to it must run modern+legacy SDK, hostile header, cancellation, streaming, receipts, 100-overlap and stop/revocation gates.
- The isolated host first-call and catalog-before-call suites **pass**; the catalog fixture explicitly disposes its disposable native InstanceStore and exits its own child process only after all validations finish. This is not permission for OXP to terminate app-global watchers, and a test-child's post-fixture process lifetime is not a measure of OXP's leak-free isolation.
- The live connected host is **not** proven to contain these source-only changes. Check `openfork_info(status).implementation.ax.lazyHost = "single-owner-lean-listener-first-executable-activation-v1"` after a supported non-disruptive deployment.
- Full-package TypeScript remains blocked by unrelated transitive diagnostics in the concurrently edited workspace. Scoped `tsgo` reports **zero target diagnostics** for the changed host/server/transport module.
- SQLite activity begins/settles remain awaited and reliability-driven. Phase histograms exist, but no evidence yet supports switching to async writes, an outbox, or an entirely different persistence authority. Avoid unbounded or post-success speculative writes; measure actual contention and durable crash recovery before selecting a queue.

**High priority next:** after the selected quick parity verifier and scoped tests pass on the latest checkout, run the complete non-quick parity gates, dedicated cancellation/disconnect stress, package semantic typecheck reconciliation with other lanes, larger cold/warm histograms and an isolated SQLite-contention benchmark. Preserve the shared dirty work and existing live sessions.
