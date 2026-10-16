# LACE v14.7 — isolated client-side prototype ledger

Date: 2026-10-10
Status: **research/prototype only**; no production provider/request/compaction behavior changed.
Canonical repository: OpenFork (V1 production; Core/V2 semantic donor).
Owner boundary: see docs/map/v1-v2.md and docs/plans/cache-bust-research-ledger.md.

## Non-negotiable architecture

- LACE is a **bolt-on client-side harness optimizer**; no hosted inference, KV-cache engine, or model changes.
- Durable history, source authority, account/provider selection, tool permission and side effects remain with existing OpenFork services.
- Provider cache *eligibility*, local admission *prediction*, remote *residency* and observed *hit* are different facts.
- Cache writes may be uneconomical; append-only provider history may require deliberate truncation/compaction despite cache hits.
- Do not ship any optimization that changes System authority, tool-call causal ordering or opaque provider reasoning compatibility.

## Added prototype files

1. `packages/llm/src/cache-frontier.ts`: exact byte-prefix comparison over fragments, exhaustive reference cache-admission optimizer, external-certification shadow promotion gate.
2. `packages/llm/src/cache-frontier-dp.ts`: exact weighted-chain dynamic-programming optimizer of the **same explicit-write approximation**, not a provider policy.
3. `packages/llm/test/cache-frontier.test.ts`: baseline safety and economics.
4. `packages/llm/test/cache-frontier-property.test.ts`: deterministic randomized byte and forecast tests.
5. `packages/llm/test/cache-frontier-dp.test.ts`: 500 generated differential cases against exhaustive oracle.
6. `packages/llm/script/lace-frontier-bench.ts`: repeatable, no-network performance benchmark.
7. `packages/opencode/src/session/lace-compaction-plan.ts`: V1-owned dual-path compaction feasibility and one-call cost prototype.
8. `packages/opencode/test/session/lace-compaction-plan.test.ts`: six focused tests.
9. `packages/opencode/src/session/lace-shadow-projection.ts`: bounded, non-mutating RAW / ABSTRACT / REFERENCE / OMIT candidate projection with source-revision, authority, required-state, atomic-group, and retrievability guards.
10. `packages/opencode/test/session/lace-shadow-projection.test.ts`: six safety and reversibility tests.

None of these modules is imported by the live V1 request/compaction path. This is deliberate: main working tree had 363 dirty/untracked paths and both V1 request preparation and compaction were under concurrent modification.

## Algorithmic result

Given up to N provider-valid candidate breakpoints and K <= 4 selected markers, estimate expected input cost over F future calls. The reference baseline enumerates all subsets up to K. For a selected sorted chain b1..bk with b0=0, modeled savings are:

    sum_j ((b_j-b_(j-1)) * W(b_j))

where:

    W(b) = (write-read) * sum_future(p_event * p_resident * I(sharedPrefix >= b))
           - (write-ordinary) * (1 + sum_future(p_event * I(futureTotal >= b)))

This admits an exact K-stage dynamic program under those explicit assumptions:
O(N*F + K*N^2), with O(K*N) working state.

**Important:** Cache writes and reads in the model are *forecast charges*. Providers differ in eligible boundaries, lookback, lifetime, minimum tokens, and actual cache availability; a caller must constrain the candidates and calibrate the assumptions first.

## Measurements (Bun 1.4.3 canary, local machine)

Measured median ns per invocation across 11 timing batches:

| Workload | Exhaustive/naive | Incremental / DP | Isolated ratio |
| --- | ---: | ---: | ---: |
| 128 KiB identical fragmented prefix except last byte | flat scan 66,902 ns | segment witness 2,030 ns | 33.0x |
| 3 candidate markers, 8 future forecasts | exhaustive 1,108 ns | DP 1,044 ns | 1.1x |
| 12 markers, 8 forecasts | exhaustive 94,055 ns | DP 2,123 ns | 44.3x |
| 24 requested markers (23 eligible after min-length filter) | exhaustive 1,424,821 ns | DP 5,423 ns | 262.7x |

The byte comparison changes data representation relative to the flat scan and therefore does not establish an equivalent drop-in speedup. The DP and reference algorithm solve the same forecast optimization, and differential tests confirmed cost agreement on 500 seeded scenarios. Neither test measures actual provider cache savings or task quality.

## Verification so far

- `cd packages/llm && bun test test/cache-shape-lab.test.ts test/cache-frontier-dp.test.ts test/cache-frontier-property.test.ts test/cache-frontier.test.ts test/cache-policy.test.ts test/cache-economics.test.ts`: **41 passed, 0 failed, 4094 assertions**.
- `cd packages/llm && bun x tsgo --noEmit`: successful.
- `cd packages/opencode && bun x tsgo --ignoreConfig --noEmit --target esnext --module preserve --moduleResolution bundler --skipLibCheck src/session/lace-compaction-plan.ts src/session/lace-shadow-projection.ts`: successful targeted pure-module check.
- `cd packages/opencode && bun test test/session/lace-compaction-plan.test.ts`: **6 passed, 0 failed**.
- `cd packages/opencode && bun test test/session/lace-shadow-projection.test.ts test/session/lace-compaction-plan.test.ts`: **12 passed, 0 failed, 42 assertions**.
- V1 package-wide typecheck: **not green** (exit 2, 38 TypeScript diagnostics). The diagnostic locations include unrelated existing CLI/server/session-context/compatibility tests; none mention either new `lace-` file. This is not proof that the package is otherwise correct, and no unrelated files were modified to address these errors.
- Existing V1 `bun test test/session/compaction.test.ts` regression suite: **56 pass, 1 skip, 8 timeout/interruption failures**, about 95 s total. Targeted rerun of `falls back to full summary when even one recent turn exceeds preserve token budget` reproduces a 5 s Effect timeout / 10 s Bun timeout in isolation. The LACE prototype is not imported by this legacy test. Treat baseline instability as an active certification blocker, not a LACE-caused defect or a harmless skip.

## Limitations / next certification gates

1. No LACE candidate may be emitted unless the exact provider/model/route supports its selected placement and the known minimum token boundaries are met.
2. A local prefix byte witness is meaningful only after the final cache-sensitive protocol serialization; provider SDK transformations and hidden inference cache state are outside this prototype.
3. Cache state must be attributed to the correct server/account/model/route and never used to authorize or redirect a request.
4. Replace externally asserted shadow validity with explicit V1 tests for message provenance, privileged context, unresolved tools, user objectives, compaction checkpoints, and preserved reasoning metadata.
   The current shadow prototype enforces only structural constraints provided by the trusted V1 classifier; `independentlyVerified` remains a caller-supplied fact, not a summary validator. Budget is **characters**, not provider tokenization.
5. Run paired **current isolated** vs **parent-prefix fork** compaction request-shape experiments with actual compiled native/AI-SDK requests before any live integration.
6. Introduce read-only request observation before live cache optimization; reuse existing cache-shape lab and provider cache-policy lowering.
7. Benchmark 1/3/6/25/50/100 concurrent sessions, p50/p95 request preparation, memory, SQLite effects and verified task completion; never equate isolated speedups with system-level gains.
8. Integrate only after reconciliation with concurrent ownership of V1 request/compaction paths, with a feature flag and a safe existing-behavior fallback.
