# LACE v14.7 — V1 integration/certification continuation

**Date:** 2026-10-10  
**Status:** experimental, client-side, no live inference or production request/compaction behavior changed.  
**Product ownership:** OpenFork V1 production in `packages/opencode`; Core/V2 semantic reference; provider protocol in `packages/llm`.  
**Baseline:** `docs/plans/lace-v14.7-prototype-ledger.md`.  
**Guidance:** `docs/map/v1-v2.md`, root/package `AGENTS.md`, `docs/plans/cache-bust-research-ledger.md`.  
**Concurrency:** checked shared git status/diff; did not edit active dirty `session/compaction.ts`, `session/llm.ts`, `session/llm/request.ts`, or provider-transform code. No resets, commits, staging, external model calls, or process disruption.

## What actually changed

1. `packages/opencode/test/lib/effect-timeout-preload.ts` and package `test` script: align the Effect-backed semantic test deadline with the package's 30s Bun deadline, unless the caller explicitly supplies a different Effect deadline. No production code change.
2. `packages/llm/src/cache-request-witness.ts`: read-only, process-salted SHA-256 witness of an already-validated native provider body. Tracks ordered prefix-region hashes, a bounded per-owner/session observer, provider/model/runtime/route domain identity, cache controls, and full native-body changes separately. Does not retain raw prompts or claim provider KV-cache hits. Supports direct OpenAI Chat/Responses and Anthropic Messages shapes only.
3. `packages/llm/test/cache-request-witness.test.ts`: eleven real-native-compiler and negative tests, including absent-sentinel non-collision and an 8,192-region bound.
4. `packages/llm/package.json`: narrow internal `./cache-request-witness` subpath export, needed by V1 candidate adapter/tests.
5. `packages/llm/script/lace-witness-bench.ts`: synthetic native-body size scaling microbench.
   `packages/llm/script/lace-compiler-observer-bench.ts`: no-network native compilation with versus without the observer.
6. `packages/llm/script/lace-observer-load-bench.ts`: bounded observer bookkeeping load microbench over 1/3/6/25/50/100 synthetic session IDs.
7. `packages/opencode/test/session/lace-compaction-shapes.test.ts`: three request-shape/cost/negative cases contrasting isolated vs prefix-fork compaction using the **actual native protocol compiler**.
8. `packages/opencode/src/session/lace-shadow-v1.ts`: candidate-only provenance-bound shadow adapter. Protects human and host turns, active and historical STATE, tool-call causality, reasoning, media, checkpoints, unfinished assistant responses and opaque provider metadata; only finished, unmarked assistant text is structurally eligible for externally verified compression.
9. `packages/opencode/test/session/lace-shadow-v1.test.ts`: five authority/revision/fidelity-negative tests.
10. `packages/opencode/src/session/llm/lace-native-observer.ts`: optional single-compilation wrapper for the existing `LLMClient.compile` seam; uses the exact compiled body and returns the exact prepared stream. Trusted scope supplied by V1; unsupported/invalid observations cannot interrupt dispatch. Not wired into production.
11. `packages/opencode/test/session/lace-native-observer.test.ts`: three single-compilation/identity/fallback/bounds tests. The test fake provides a real `LLMClient.prepare` native body and a stubbed stream; an actual provider-transport `LLMClient.compile` stream has not been exercised end-to-end.

The existing LACE v14.7 prototype modules, live V1 agent loop, live provider adapters, and existing V1 compaction routine are unchanged.

## Verified test results

- `cd packages/opencode && bun run test test/session/compaction.test.ts`: **64 pass, 1 skip, 0 fail, 199 assertions; 137.65 seconds**. The prior 5s Effect / 10s Bun raw-invocation timeout is reproducible and the test passes with aligned package deadlines. This is **not** proof that fixture execution time is optimal.
- `cd packages/llm && bun test test/cache-request-witness.test.ts test/cache-frontier.test.ts test/cache-frontier-dp.test.ts test/cache-frontier-property.test.ts test/cache-shape-lab.test.ts test/cache-economics.test.ts test/cache-policy.test.ts`: **52 pass, 0 fail, 4,126 assertions**.
- `cd packages/opencode && bun test test/session/lace-compaction-shapes.test.ts test/session/lace-compaction-plan.test.ts test/session/lace-shadow-projection.test.ts`: **15 pass, 0 fail, 53 assertions**.
- `cd packages/opencode && bun test test/session/lace-shadow-v1.test.ts test/session/lace-compaction-shapes.test.ts test/session/lace-compaction-plan.test.ts test/session/lace-shadow-projection.test.ts test/session/lace-native-observer.test.ts`: **23 pass, 0 fail, 88 assertions** across the complete V1 LACE suite, including five V1 provenance tests and three single-compiler tests.
- LLM package `bun x tsgo --noEmit`: passed.
- V1 targeted source `tsgo` on LACE shadow/projection/compaction: passed. Full V1 `tsgo`: still not green due numerous CLI/server/compatibility diagnostics outside LACE; see live rerun evidence rather than treating targeted pass as package-wide proof.

## No-network microbenchmark results

Single-session full native-body witness+observation medians over 9 batches / 80 observations per batch:

| Compiled body bytes | Median microseconds / observation |
| ---: | ---: |
| 16,597 | 56.20 |
| 131,285 | 272.66 |
| 524,501 | 1,198.33 |

A 512 KiB body costs roughly 1.2ms per observation on this machine, making naive always-on re-serialization unacceptable until amortized/reused.

Paired native compilation experiment (offline, 450 iterations per mode, no provider calls) at 16 KiB: baseline median **408.26 µs**, compile-plus-witness **503.98 µs** (+95.72 µs, +23.4%). At 128 KiB: baseline **322.08 µs**, compile-plus-witness **670.97 µs** (+348.89 µs, +108.3%). Batch order alternated to reduce systematic warmup bias, but this remains a synthetic compiler microbenchmark rather than real-session p95. **Release gate:** never enable full-body witness on every large request without incremental/conditional/sampled strategy proving negligible hot-path overhead.

Synthetic sequential observer load, fixed ~8KiB request, 300 iterations per session count (NOT real agent concurrency):

| Session IDs | Observations | Median us/call | p95 us/call | Observations/sec |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 300 | 42.20 | 66.40 | 20,511 |
| 3 | 900 | 24.50 | 41.07 | 28,972 |
| 6 | 1,800 | 22.78 | 34.23 | 33,972 |
| 25 | 7,500 | 23.24 | 67.24 | 34,966 |
| 50 | 15,000 | 23.88 | 48.78 | 35,139 |
| 100 | 30,000 | 36.14 | 59.00 | 23,356 |

The heap deltas are GC-contaminated and do not establish allocation bounds. This is not a multi-session SQLite/rendering/inference stress test.

## Key architectural conclusions

- The existing `LLMClient.compile` already compiles a request exactly once and exposes a preview and stream tied to the same prepared transport. Build read-only observations around that seam; **never recompile the request for telemetry**.
- Compiled OpenAI parent-prefix forks retain their old native input array entries, unlike isolated textual summarization. This proves native request-shape potential, **not actual cache residency, provider cost savings, context-summary quality or correctness of an activated fork**.
- Route identity includes owner/session/protocol/model/runtime. Different accounts cannot share an observer authority merely because the prompt text matches.
- A V1-authoritative historical event is never silently reclassified as optional just because its provider role is `user`; Goal STATE must be reprojected from Core/V1 owner after compaction.
- A shadow projection is only structurally valid. The `independentlyVerified` field remains a trusted caller assertion, not an implemented semantic-fidelity verifier.
- Preserve original provider requests under all failures of an *optional observation*. Do not promote or dispatch shadow candidates from this prototype.
- Test deadline alignment removes false 5s gates; the 10–11s focused fixture duration and 137s whole-suite time require dedicated fixture/profiling investigation before claiming performance improvements.

## Unfinished, release-blocking work

1. **Actual safe production observe-only wiring:** authoritative owner/session/account/route handoff from V1 orchestrator to the native `LLMClient.compile` path, coordinated against concurrent edits. Feature flag, bounded sampling/overhead, no prompt text logging, no second compile, graceful observer failure. Native, AI SDK and first-party Claude need independently accurate coverage/status.
2. **Final wire identity:** witness hashes a schema-validated native protocol body, not the ultimate signed HTTP/WebSocket/SDK wire bytes. Add route/SDK-specific verified final-byte witnesses where possible without collecting secrets.
3. **Economic feature proof:** provider-explicit admission/breakpoint optimizer is still isolated. Calibrate actual cache writes/reads and price models before activating it.
4. **Real provider compaction A/B:** measured cost and semantic task-fidelity under identical snapshots with both alternatives; simulate model/account incompatibilities, reasoning continuity and deferred tool workflows.
5. **Candidate-to-authority promotion:** independent summary verifier, source-revision and causal-history recheck at atomic safe boundary, crash-stop/restart and permissions/tenant isolation tests.
6. **Real multi-agent pressure:** 1/3/6/25/50/100 executing V1 sessions, SQLite contention, cancellation, first-token latency, memory, provider-call throughput and verified task success. Sequential observer benchmark is deliberately narrower.
7. **Broader TS/release:** existing full V1 package TypeScript diagnostics remain unresolved outside the LACE-owned scope; no claim that the entire package is certified.
8. **Tool schema stability and alternate backends:** validate OpenRouter, Bedrock, proxy inference, SDK-generated tool order and provider restrictions before advertising parity.

**Release disposition:** isolated prototypes and deterministic test evidence advanced substantially; live prompt optimization is **off**, all commercial cache savings remain **unmeasured**. Do not remove certification gates because synthetic tests look favorable.
