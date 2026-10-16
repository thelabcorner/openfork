# LACE v14.7 — OXP engineering continuation (2026-10-10)

Status: partial production integration, observe-only; optimizer and shadow activation remain off. Source inspection and commands used the live canonical OpenFork `opencode` checkout. No commercial inference, server restart, staging, commit, reset, cleanup or credential access was performed.

## Architecture reconciliation

The remembered v14.7 native observer and compaction prototypes were found in the checkout. `docs/map/v1-v2.md` confirms V1 production execution, Core/shared semantic ownership, `packages/llm` protocol lowering and V2/new-layout UI. The working tree has concurrent modifications. Existing native observation remains opt-in with `OPENFORK_LACE_OBSERVE_NATIVE=1`; the default cohort denominator is 16.

## New isolated modules and integration

1. `packages/opencode/src/session/llm/lace-ai-sdk-observer.ts` — read-only process-salted SHA-256 witness of post-transform AI SDK V3 prompt, tool definitions and selected provider options. Strict opt-in `OPENFORK_LACE_OBSERVE_AI_SDK=1`, reusing native's independently sampled session cohort via `OPENFORK_LACE_OBSERVE_EVERY`. Account/worktree/project/session isolation comes from authoritative V1 scope. Detects first, identical, extended, rewritten, tools-changed, options-changed and domain-changed requests. Unsupported or over-budget shapes are not observed. Retains at most 128 scoped entries and 16,384 message-region digests. No original prompt bytes retained. This is NOT provider-native body, signed HTTP wire, the provider's cache key, or evidence of a cache hit.
2. `packages/opencode/src/session/llm.ts` — small guarded addition to the existing AI SDK V3 `transformParams` hook, after `ProviderTransform.message`. Uses exact transformed SDK prompt and tool options, and never changes the returned provider parameters. Uses only authorized committed-route V1 scope. No change to default-disabled request behavior. It neither enables explicit cache optimizations nor changes native/Claude SDK dispatch.
3. `packages/opencode/test/session/lace-ai-sdk-observer.test.ts` — opt-in, mutation classification, route/account isolation, binary/bounded/cyclic handling, global region-cap eviction and a real `wrapLanguageModel` V3 transform-seam fake-transport test.
4. `packages/opencode/src/session/lace-shadow-activation-gate.ts` — a pure pre-transaction admission guard for candidates: owner, epoch/head, context/System/permission/route revisions, pending tool calls, opaque reasoning, historical state, context window, full evidence coverage and independent-verifier result are required. It is not a persistence transaction or an independent summary-verifier implementation; supplied evaluator receipts must be authenticated by the production owner before trusting them.
5. `packages/opencode/test/session/lace-shadow-activation-gate.test.ts` — negative interleaving/revision/permission/route/fidelity checks, including a precommit time-of-check/time-of-use regression model.
6. `packages/opencode/script/lace-ai-sdk-observer-bench.ts` — repeatable synthetic no-network observation benchmark.

## Verified tests and measurements

- `cd packages/opencode && bun test test/session/lace-ai-sdk-observer.test.ts test/session/lace-shadow-activation-gate.test.ts --timeout 30000`: **14 pass, 0 fail, 60 assertions**, after correcting a test helper's undefined-default-parameter mistake.
- `cd packages/opencode && bun run test test/session/compaction.test.ts test/session/context-compiler-concurrency.test.ts test/session/lace-checkpoint-retention.test.ts`: **73 pass, 1 skip, 0 fail, 21,285 assertions in 174.29s**. Includes concurrent context compilation under WAL writer contention, NOT 100 genuine executing V1 Sessions.
- `cd packages/opencode && bun run script/lace-ai-sdk-observer-bench.ts`: median over nine batches of 80 observations: 2 KiB 37.05 microseconds, 16 KiB 60.20 microseconds, 128 KiB 174.11 microseconds, 512 KiB 474.36 microseconds. Do not interpret as end-to-end overhead or real cache benefit.
- Full package `bun x tsgo --noEmit --pretty false` remains **not green: 50 TypeScript diagnostics across 16 files**, no diagnostics in new LACE files or `src/session/llm.ts`. Other shared files are undergoing concurrent work. Examples: `src/session/message-v2.ts`, API handler contract drift, CLI debug bundle and unrelated fixture/test type errors.
- Combined nine-file LACE regression `bun run test` returned **44 pass, 0 fail, 276 assertions**, before the later two shadow property tests were added. The separate shadow gate run including both new property tests passed **8/8, 1041 assertions**. A clean combined rerun is still the definitive final count.
- The broader `test/session/processor-effect.test.ts` run returned **28 pass, 1 timeout after 30 seconds** in the existing `reset reasoning state across retries` case. This is an integration certification blocker; it has not been attributed to LACE. The newly added observer is off by default. Reproduce in isolation with a longer Effect deadline before modifying code.
- New LACE source/test/benchmark files were formatted with the repository's Prettier. Scoped tracked diff whitespace check for `src/session/llm.ts` passed.
- **Latest focused regression** (nine non-overlapping LACE files, including native + AI SDK observers and both shadow guards): `bun run test test/session/lace-ai-sdk-observer.test.ts test/session/lace-shadow-activation-gate.test.ts test/session/lace-native-runtime-integration.test.ts test/session/lace-native-observer.test.ts test/session/lace-observation-policy.test.ts test/session/lace-compaction-plan.test.ts test/session/lace-compaction-shapes.test.ts test/session/lace-shadow-projection.test.ts test/session/lace-shadow-v1.test.ts` — **46 passed, 0 failed, 1,292 assertions in 3.30s**.
- Seven native LLM/cache suites (witness, frontier, dynamic-programming/property proofs, shape lab, economics, policy) ran in `packages/llm`: **53 passed, 0 failed, 4,132 assertions in 453ms**.
- The non-overlapping focused LACE/V1 compaction/provider-cache verification total is therefore **172 passed, 1 skipped, 0 failed, 26,709 assertions**, across the three respective suite runs. The additional processor-effect suite is recorded separately as failing and is excluded from that passing total.
- Together with the independently run V1 compaction/concurrent-context/checkpoint suite, the latest non-overlapping gates total **119 passed, 1 skipped, 0 failed, 22,577 assertions**. This is not the entire package test suite.
- The isolated retry/reasoning regression `session.processor effect tests reset reasoning state across retries` was reproduced **even with a 60-second semantic deadline**, failing after 60.16 seconds (one isolated test, 0 passed). Fixture and processor files are dirty in parallel work lanes, so they were not mutated merely to turn this gate green. In `test/lib/llm-server.ts`, the reset fixture explicitly destroys an SSE HTTP response; the code path and SDK retry response must be traced by that lane before asserting root cause.
- The processor-effect suite overall recorded **28 passed, 1 failed** from the same case with the normal 30-second Effect deadline. Treat it as a genuine isolated reproduction (not fixed by increasing the deadline), and do not attribute it to LACE without a causal comparison.
- New modules passed Prettier check, and the scoped modified `llm.ts` Git diff whitespace check passed. The latest full V1 `tsgo` rerun still reports 50 existing non-LACE diagnostics; no new LACE or `session/llm.ts` diagnostics were emitted.

## Gate accounting

- Native observe-only source/offline tests: previously implemented and retained; no live canary.
- AI SDK post-transform observe-only: **implemented and offline-tested**, not final transport bytes, no live canary.
- First-party Claude: **not observed at final SDK wire level**. Its runtime is independently modified and SDK provider payload internals are not exposed; do not fake parity by hashing higher-level inputs.
- Cache savings/read-write economics: **not measured with actual provider bills**. The existing prototype cost planner is not activated.
- Shadow promotion: **pure pre-commit gate exists**, but durable CAS/transaction, independent semantic verifier, evidence rehydration and production activation do not exist.
- Full closed-loop coding-agent quality, 100 real simultaneous V1 Sessions and visual/latency p95: **not certified** by offline stream/context compiler tests.
- Full V1 TypeScript: **blocked by independently owned active changes**; no broad fixes applied.

Release contract: Treat all optimized provider requests and all shadow promotions as disabled until real end-to-end semantic, authorization, transaction, and provider-economics gates are proved. Opt-in observations may run without altering prompts and tool execution.
