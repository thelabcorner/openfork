# LACE v14.7 — Observe-only V1 integration, verification, and remaining certification

**Date:** 2026-10-10
**Integration disposition:** implemented in source, disabled by default. No live service restarted or provider request sent; no provider billing evidence, compaction policy change, shadow promotion, or live traffic rollout.
**Repository:** canonical OpenFork V1 production checkout. Obey `docs/map/v1-v2.md`: V1 executes, Core owns semantics, `packages/llm` owns provider lowering, new-layout UI owns presentation.
**Concurrent work:** broad shared tree modified by other agents. No resets, cleans, broad staging, or commits. Existing unrelated edits in `session/llm.ts` and `session/llm/native-runtime.ts` preserved.

## Implemented in this continuation

1. `packages/opencode/src/session/llm/lace-observation-policy.ts`: explicit opt-in (`OPENFORK_LACE_OBSERVE_NATIVE=1`), deterministic per-session cohort sampling (`OPENFORK_LACE_OBSERVE_EVERY=16` default; valid 1–1024), reject invalid settings, trusted source/project/worktree/account/session identity. Isolated maintenance projections use a request-specific observation key. Sampling cannot influence provider routing or dispatch.
2. `packages/opencode/src/session/llm.ts`: under the existing opt-in native runtime, carry trusted project/worktree/account route to LACE only if a committed route and valid instance context are available. Legacy/unknown routes are not observed. No changes to AI-SDK or Claude provider calls.
3. `packages/opencode/src/session/llm/native-runtime.ts`: feature-flagged observer wraps one `LLMClient.compile()` call and streams the **same** prepared transport, never recompiles for telemetry. Unobserved requests retain `client.stream(request)`. Observation status and enum-only classification use debug logging, without prompt/account content.
4. `packages/llm/src/cache-request-witness.ts`: retain existing SHA-256/process salt/body-protocol mechanism; add a second global retained-region budget (16,384 regions) in addition to the 128-session LRU limit. Eviction updates accounting and clear resets it.
5. Tests: new `lace-observation-policy.test.ts`, `lace-native-runtime-integration.test.ts`, and a bounded-region test in the existing LLM witness suite. Two pre-existing LACE test TypeScript issues were repaired (explicit generic native-body type; canonical `Source.Prompt` rather than nonexistent `Source.User`).

## Executed verification (not inferred)

- LLM cache/witness/frontier/shape/policy suite: **53 pass, 0 fail, 4,132 assertions**.
- V1 LACE combined suite after adding the 100-stream test: **30 pass, 0 fail, 216 assertions** across seven files. The 100-stream runtime integration test separately passed as **4 pass, 0 fail, 10 assertions**.
- Existing V1 native LLM suite: **18 pass, 0 fail, 60 assertions**.
- V1 compaction canonical command `bun run test test/session/compaction.test.ts`: **64 pass, 1 skip, 0 fail, 199 assertions; 117.85s**. Uses package's aligned 30-second Effect/Bun deadlines.
- Recorded native LLM fixtures: **3 pass, 1 skip, 0 fail, 24 assertions; 4.77s**. Cassette replay, not live commercial inference.
- `packages/llm: bun x tsgo --noEmit --pretty false`: **passed**.
- Scoped tracked-file whitespace check with `git -c core.whitespace=cr-at-eol diff --check`: passed. The shared native runtime uses CRLF; plain Git's default whitespace checker misidentifies its CRLF endings as trailing whitespace, including unrelated concurrent hunks.
- V1 `bun x tsgo --noEmit --pretty false`: **51 diagnostics across 17 non-LACE files**, including concurrently modified `src/session/compaction.ts` and `src/session/message-v2.ts`; **none located in LACE files, session/llm.ts or native-runtime.ts**. This is not a green whole-package check. The diagnostic set changed between successive runs as the shared checkout evolved.
- 100 independently scoped simultaneous offline native streams: **passed**, with exactly 100 compile calls and zero legacy stream calls; no HTTP requests. This is NOT 100 executing V1 Sessions or a SQLite/provider-pressure benchmark.

## Architecture and operational limits

- The witness is a read-only schema-validated native request-body observation. It is **not** a hash of final signed HTTP/SDK/WebSocket bytes or the provider's private cache key, and does not prove remote residency.
- Only native OpenAI Chat/Responses and Anthropic Messages have compatible witness semantics. Unsupported protocols are classified without interrupting provider streaming.
- The LACE flag must be independently enabled from `experimentalNativeLlm`. Non-native AI SDK and first-party Claude sessions currently do not receive this observation.
- No prompt mutation, explicit-cache planner activation, changes to production compaction, semantic-memory promotion, or global routing adjustment was enabled.
- Previously measured body-size costs show material unsampled overhead (about 96 µs at 16 KiB and 349 µs at 128 KiB in no-network compilation experiments). Session-cohort sampling reduces total exposure, but **not** per-observed-session overhead; no live p95 performance proof has been made.
- Concurrent dirty changes in non-LACE code are left intact. Fixing 51 whole-package errors or changing owned production compaction/permission paths without conflict reconciliation would risk other ongoing agents' work.

## Remaining certification gates that cannot truthfully be claimed complete

1. **Live observe-only rollout:** opt-in instrumentation is wired and offline-tested, but no running service has been restarted or verified with real sessions and actual billed provider usage.
2. **Coverage outside native:** AI-SDK, Claude first-party, proxies, Bedrock/OpenRouter and route-specific final transport bytes need separate authoritative adapters or an explicit unsupported classification.
3. **Economic feature proof:** breakpoint/compaction candidate planners remain non-dispatching prototypes; no live read/write token calibration or billed-cost A/B.
4. **Closed-loop quality:** compaction summary and evidence fidelity have structural/adversarial unit tests but not paired long-horizon agent outcomes.
5. **Shadow promotion:** independent summary verification, atomic epoch/revision recheck, crash-stop promotion tests and persisted rehydration are not production integrated.
6. **Actual concurrent V1 Sessions:** the 100-stream test cannot substitute for 1/3/6/25/50/100 real Sessions with SQLite contention, cancellation, first-token latency and tool-success measurements.
7. **Whole-package TypeScript/release:** 51 diagnostics in other active lanes; package-wide clean build cannot be certified.

## Safe follow-up ordering

First reconcile full-package diagnostics and production file ownership. Then run an explicit, authorized and budgeted opt-in canary to capture actual native route cache-hit usage and p95 overhead. Next verify all remaining adapters with route-specific request-body/transport evidence. Only after quality-aware A/B testing may candidate compaction, cache admission, or shadow promotion be enabled.

**Honesty gate:** passing offline tests proves the named structural and integration behavior only. It does not establish reduced provider bills, equal agent reasoning quality, cross-provider cache parity, or production readiness.
