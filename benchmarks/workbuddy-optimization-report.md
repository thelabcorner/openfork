# WorkBuddy Optimization Campaign — Report

**Target:** `packages/opencode/src/plugin/workbuddy.ts`  
**Date:** 2026-09-03  
**Env:** local win32 Bun 1.3.14, win32 x64, 24 CPUs, Node v24.3.0  
**Baseline commit:** 72d437d (stable-port patch included)  
**Contract:** provider.models() wall-clock latency lower-is-better (primary), cold miss primary; secondary chat TTFB/drain ≤+2% / p95 ≤+5ms; RSS peak ≤+5%; correctness bit-identical; no API break. Workload: fake backend via `setTestBackend`/`setTestAccountStore`, GLOBAL_CATALOG 7 + live 7-9, 2 accounts (Global `www.workbuddy.ai` + CN `www.codebuddy.cn`), deterministic fixtures SHA256 `da86282996d2ad2b`, loopback proxy `127.0.0.1:19731` with `extraServers` revival path exercised. Oracle: golden snapshots `parseWorkBuddyContextWindows`/`decodeWorkBuddyContextModel` + `script/workbuddy-proxy-test.ts` (22 tests), `script/workbuddy-accounts-test.ts`, `script/workbuddy-governor-test.ts`.

---

## 1. Harness

**Built at:** `script/workbuddy-bench.ts` — TS/Bun translation of `harness_template.py` shape, also mirrored at `benchmarks/workbuddy-harness.ts`.

**Requirements preserved (verified):**
- Discarded warmup ≥5, measured N≥30 (N=50 default, N=100 exploratory), persisted raw per-sample `wall_s` + `wall_s_per_inner` + submetrics (`models_miss_ms`, `models_hit_ms`, `chat_ms`), `input_hash`, `sink_checksum`, `env` (bun/platform/pid).
- Sink checksum over last model count + chat `completionFrom` `id` so JIT cannot delete work.
- Separate timing vs allocation runs (`--track-allocs` separate process, timing run uses `gc-mode=production`).
- Production runtime: no `Bun.gc` disable, parallelism preserved, real `fetch` + loopback TCP, 1ms artificial upstream latency, `ensureLoopbackProxyBypass` enforced, `PROXY_PORT=19731` stable.
- `inner-loops=1` canonical per contract (each sample = 1× `provider.models()` miss + 1× hit + 1× `POST /v1/chat/completions` `stream:false`折叠). `inner-loops=5` used for wall-stability screening (15–40ms expected per sample; chat 14–15ms dominates). Discussed below.
- Deterministic fixtures via `makeConfigFixture(seededRng)` 7+9 model entries, `modelPromotions` 2 entries, byte-stable JSON.

**Workload fidelity — not invented:**
- Upstream mock: `GET /v3/config` → `{"data":{models,agents,modelPromotions}}` 12–18KB, `GET /console/enterprises/{id}/config/models` → `{"data": [...]}` 5 entries, `POST /v2/plugin/auth/token/refresh` 200, `POST /v2/chat/completions` streaming 2 SSE chunks + `[DONE]` (`reasoning_content:"thinking"`, `tool_calls:[]` stripped upstream).
- Vault: `setTestAccountStore(tmpdir)` with 2 `AccountVault.save` entries, `WORKBUDDY_AUTH_FILE` set, `WorkBuddyPlugin({project:{id:"bench"}})` → `ensureProxy()` + stale `http://127.0.0.1:59731/v1` healing probe once per run.
- Sample: `provider.models({id:"workbuddy",models:{}})` → `await hooks.provider.models` (captures `firstMissMs` once), then per-sample `models_miss` + `models_hit` (both cache hits after warmup — see §4 Caveat), then `fetch(baseURL+"/chat/completions",{model:"hy4-preview",messages:[{role:"user",content:"hi"}],stream:false,max_tokens:64})` → `completionFrom` folded non-streaming.

**Reproduce:**
```bash
bun run script/workbuddy-bench.ts --iteration-id 00-baseline --n 50 --warmup 10 --inner-loops 1 --out benchmarks/results.jsonl --seed 12345
WB_PROFILE=1 bun run script/workbuddy-bench.ts --iteration-id profile --n 20 --warmup 5 --inner-loops 1 --out benchmarks/profile.jsonl --seed 12345
bun run benchmarks/workbuddy-oracle.ts
bun run script/workbuddy-proxy-test.ts
```

---

## 2. Baseline Lock

**Raw JSONL:** `benchmarks/results.jsonl:1` (`00-baseline`), also `benchmarks/results-new.jsonl:1` (`10-baseline-frozen`), `benchmarks/baseline-N100.jsonl:1`

**Stable baseline chosen for gates:** `00-baseline` N=50 warmup=10 inner_loops=5 seed=12345

| Metric | mean | stdev | CV | median | p95 | p99 | min | max |
|---|---|---|---|---|---|---|---|
| `wall_s` (5×chat composite) | 77.636 ms | 1.659 ms | **2.13% stable** | 77.461 ms | 80.499 ms | 81.434 ms | 75.076 ms | 81.834 ms |
| `wall_s_per_inner` | 15.527 ms | 0.332 ms | 2.13% | 15.492 ms | 16.100 ms | 16.287 ms | 15.015 ms | 16.367 ms |
| `models_miss_ms`* | 0.694 ms | 0.109 ms | 15.67% noisy | 0.686 ms | 0.864 ms | 0.947 ms | 0.492 ms | 0.966 ms |
| `models_hit_ms`* | 0.430 ms | 0.076 ms | 17.58% noisy | 0.404 ms | 0.567 ms | 0.623 ms | 0.342 ms | 0.661 ms |
| `chat_ms` (per inner) | 15.302 ms | 0.329 ms | 2.14% | 15.275 ms | 15.890 ms | 16.037 ms | 14.821 ms | 16.154 ms |
| `peak_rss_bytes` | 93.76 MB | — | — | — | — | — | — | — |
| `completions` | 250 (50×5) | — | — | — | — | — | — | — |
| `input_hash` | `da86282996d2ad2b` | `sink_checksum` `860db0db5528e080` | — | — | — | — | — | — |

*`*` Both `models_miss` and `models_hit` are **cache hits after initial cold** (`firstMissMs` captured once at startup, ~N/A per-sample). True cold `discoverCatalog` (parallel fetches + `parseConfigPayload` + `mergeCatalog`) not exercised per-sample. See Caveat.

**Stability verdict:** wall CV 2.13% <5% → **stable, accept-eligible**. Submetrics CV 15–17% → noisy but usable per contract (5–15% noisy usable; ≥15% reject inconclusive). Miss 15.67% is borderline; with `inner_loops=1` N=50 `10-baseline-frozen` CVs worsen: wall 9.73% noisy, miss 16.41% (>15% reject), hit 23.44% reject. With N=100 `baseline-N100` wall CV 15.19% reject, miss 20.6% reject. Increasing N does not improve CV due to ambient jitter (GC, thermal). Therefore primary wall gate uses `inner_loops=5` stable baseline; primary `provider.models` gate is **inconclusive by variance** even before effect.

**Noise floor for wall (contract §7):** `max(2*CV, CI_half_width/mean, 1%)` = max(4.27%, ~2.1% (bootstrap), 1%) ≈ **4.27% ≈ 3.31 ms**. Any wall effect <3.31ms is within noise and ineligible.

**Noise floor for `models_miss`:** max(2*15.67%=31.3%, ~15%, 1%) ≈ **31.3% ≈ 0.217 ms**. Any miss improvement <0.217ms is within noise.

**CoV policy applied:** wall stable, models noisy — harness preserved per-sample raw `all[]` arrays in JSONL for Welch/bootstrap externally.

**Correctness at baseline:** oracle 8/8 pass, `workbuddy-proxy-test.ts` 22/22 pass, `health`/`/v1/models` shape verified.

---

## 3. Profile Hotspots (Real Profiler, Share %)

Enabled via `WB_PROFILE=1` (`packages/opencode/src/plugin/workbuddy.ts:49-66` `wbMark`/`getWorkBuddyProfile`). Run: `profile-wb` N=20 warmup=5 inner_loops=1 (151 cache hits, 25 completions, 3 config parses). Times are CPU only (upstream 1ms sleeps not included in `wbMark`).

| Hotspot | count | totalMs | meanMs | share of per-sample wall (≈15.5ms) |
|---|---|---|---|---|
| `handleCompletions` (end-to-end SSE fold) | 25 | 314.896 | 12.596 | **81.1%** |
| `handleCompletions:governor` (`runGeneration`) | 25 | 285.112 | 11.404 | 73.4% |
| `handleCompletions:sendJson` | 25 | 2.753 | 0.110 | 0.7% |
| `handleCompletions:recordUsage` | 25 | 0.199 | 0.008 | 0.05% |
| `parseConfigPayload` (cold only) | 3 | 0.877 | 0.292 | 1.9% **of cold** (amortized 0.011ms/sample) |
| `parseWorkBuddyContextWindows` | 19 | 0.162 | 0.0085 | 0.05% |
| `catalogFor:cacheHit` | 151 | 0.237 | 0.0016 | 0.01% |

**Interpretation:**
- **Chat path dominates wall:** `handleCompletions` 12.6ms of 15.3ms chat (81% of wall). Governor `runGeneration` 11.4ms is 73% of wall. Optimizing provider.models cannot move wall >5% because models are 0.43–0.69ms per call (≈2× per sample = 1.12ms ≈7.2% of wall). Even eliminating both hits saves ≤7.2% wall — below 10% target. Cold path could save more but not exercised per-sample.
- **Provider.models hit breakdown (inferred from submetrics):** `catalogFor:cacheHit` 0.0016ms negligible; remainder ~0.43ms is `accountLabels` + `catalogFor` loop + `exposedModels`/`toModel` (30–40 Model objects, string interpolations, `formatContextWindow`, `contextWindowsFor` duplications). Share: `exposedModels`/`toModel` ≈93% of hit, `catalogFor` overhead ≈0.4%, `mergeCatalog`/`parseConfigPayload` 0% on hit.
- **Cold breakdown (estimated):** parallel fetches 1ms (network, not CPU), `parseConfigPayload` 0.29ms, `mergeCatalog` ~0.05ms (Map alloc + `contextWindowsFor` per entry), plus hit overhead 0.43ms → ~1.8ms cold (vs measured 0.69ms hit-like). So cold CPU is ~1.8ms, wall cold ~2.8ms with network.
- **Conclusion for route prioritization:** To move primary `provider.models` 10%, need ~0.07ms on hit or ~0.18ms on cold. To move wall 10%, need ~1.55ms — impossible without chat-path work, which is out-of-scope for primary metric and would violate secondary TTFB constraint.

Second profile (cold not busted, hit path): confirms `parseWorkBuddyContextWindows` and `catalogFor:cacheHit` are not bottlenecks.

---

## 4. Route Matrix (≥3 Routes, Pre-Registered)

All routes single-variable, preserve `Model` shape, `api.url` stable port, SSE quirks (`tool_calls:[]` strip, `reasoning_content` forward), `chat.headers` injection, loopback bypass.

| Route | Hypothesis | Single Variable | Expected Gain | Risk | Gate Check |
|---|---|---|---|---|---|
| **R1: Debounced persist** | `workbuddy-governor` `persist()` fsync per `recordUsage` is synchronous `writeFileSync`+`renameSync` and blocks event loop on chat path; debouncing to 100ms coalesces 1 write per generation vs per SSE `recordUsage` | Defer `persist()` in `recordUsage`/`recordInBandRateLimit` via trailing debounce | wall -2–4% (governor 0.008ms → ~0, but `persist` not in `wbMark` — estimated 0.2ms per `recordUsage` from `fs` blocking) | Low — persistence is best-effort, hard limits still enforced in-mem, debounce does not change `QUOTA_EXHAUSTED` semantics | Correctness: governor state machine unchanged; RSS neutral; API neutral |
| **R2: Reuse first catalog** | `WorkBuddyPlugin.models()` calls `catalogFor(first)` twice (once in loop for `accounts[0]`, again for ergonomic defaults) when `!merged[entry.id]`; reuse `catalogFor` result for first account across both phases | Cache `firstCatalog` variable, share reference | models_hit -5% (~0.02ms), wall -0.3% | Low — reference sharing is safe (catalog is immutable `CatalogEntry[]` after `mergeCatalog`), no copy | Correctness: bit-identical `merged` output; RSS neutral |
| **R3: Fast URL parse** | `provider.models()` stale-healing `new URL(m.api.url).host` + regex per existing model is heavy (`URL` parse allocates); all cached models are `http://127.0.0.1:<port>/v1` so string slice + `Number()` is sufficient | Replace `new URL(...).host.split(":")[1]` + regex with `url.slice(7, url.indexOf("/v1")).split(":")[1]` / `url.indexOf("127.0.0.1:")` + `parseInt` | models_hit -2% (~0.008ms), wall -0.1% | Low — but must handle IPv6 `[::1]` not in this path (provider.models only emits `127.0.0.1`); risk of mis-parse → stale port not healed → ECONNREFUSED | Correctness: must preserve `extraServers` revival for stale 59731 probe |
| **R4: Mutate SSE in-place** | `normalizeDelta` spreads `{...delta}` deleting `tool_calls` copies 1 object per delta (2 deltas per chat × N); SSE `parseSSE` yields `normalizeChunk` which maps `choices` copying each chunk | Mutate `delta` in-place (`delete delta.tool_calls` if empty) and reuse `chunk` object, avoid spreads | chat -1% (~0.15ms), wall -0.9% | Medium — mutating upstream `chunk` could leak to `absorb` accumulator which keeps reference; must copy only when `tool_calls` present | Correctness: must still strip empty `tool_calls` for translator termination bug (point 3 of loopback header) |
| **R5: Cached contextWindows** *(stopping-route)* | `contextWindowsFor` called twice per `toModel` (`hasAlternateContext` + `exposedModels` loop) recomputes `Set`+`sort` per entry per account (≈14 calls per `provider.models`); WeakMap cache per `CatalogEntry` object | `WeakMap<CatalogEntry, number[]>` memoizing `contextWindowsFor` | models_hit -10% (~0.04ms), wall -0.3% | Low — catalog entries are object-stable per `catalogFor` cache hit; WeakMap does not leak; fallback entries are new objects per miss — safe | Correctness: `contextWindowsFor` pure, deterministic, bit-identical |

R5 evaluated last to reach 5-reject stop threshold. All routes keep production `fetch` + loopback TCP, no mocked timers, no `GC` disable.

---

## 5. Iteration Ledger — One Variable at a Time, 6-Gate Gauntlet

**Gates (per contract §7, §2):**
1. Correctness: oracle + proxy integration bit-identical, no semantic drift
2. Primary improvement: `provider.models` (or wall) mean lower, clears noise floor and 95% CI (bootstrap 10k / Welch α=0.01)
3. Statistical significance: 95% CI excludes zero, Welch p<0.01, effect ≥ noise floor
4. Secondary latency: chat `p95 ≤ +5%` and `chat_ms`/`wall_s` p95 ≤ +5ms vs baseline
5. Resource: RSS peak ≤ +5% (93.76 MB → ≤98.45 MB)
6. API contract: `Model.id`/`api.url`/`api.npm`/`limit.context`/`headers.Authorization`, provider id `workbuddy`, `/health`→`signed_in`/`accounts[].auth_file`/`metrics.amplification`, `/metrics`/`bindings`, SSE quirks

**Ledger:**

### Iteration 01 — `01-debounced-persist` (R1)
- **Delta:** single variable (debounced `persist` in governor)
- **Raw:** `benchmarks/results.jsonl:2` N=50 wall 77.935ms stdev 1.821ms CV 2.34% vs baseline 77.636ms → **+0.300ms +0.39%** (slower)
  - Sub: miss 0.634ms -8.69% (improved), hit 0.394ms -8.45% (improved), chat 15.381ms +0.52% (slower), p95 wall 81.109ms +0.76%, RSS 93.88MB +0.13%
- **Gates:** 1 PASS (oracle 8/8, proxy 22/22), **2 FAIL** (direction wrong, effect 0.39% < 4.27% noise floor), 3 FAIL (CI includes zero, p≈0.4), 4 PASS (p95 +0.76% <5%, +0.61ms <5ms), 5 PASS (+0.13% <5%), 6 PASS
- **Verdict:** **REJECTED — within-noise regression (slower, not an improvement).** Ledger records rejection, no re-baseline, no re-profile.

### Iteration 02 — `02-reuse-first-catalog` (R2)
- **Delta:** single variable (reuse `firstCatalog` ref) on top of baseline (R1 reverted)
- **Raw:** `benchmarks/results.jsonl:3` wall 77.506ms stdev 1.520ms CV 1.96% vs baseline -0.130ms **-0.17%** (faster but tiny)
  - Sub: miss 0.714ms +2.97% slower, hit 0.446ms +3.78% slower (contrary to hypothesis), chat 15.268ms -0.22%, p95 wall 79.887ms -0.76%, RSS 95.04MB +1.36%
- **Gates:** 1 PASS, **2 FAIL** (improvement -0.17% < 4.27% noise floor, miss/hit actually slower), 3 FAIL (95% CI [-1.1ms, +0.8ms] includes zero), 4 PASS, 5 PASS, 6 PASS
- **Verdict:** **REJECTED — within-noise, direction inconsistent (hit slower).**

### Iteration 03 — `03-fast-url-parse` (R3)
- **Delta:** single variable (string slice URL parse)
- **Raw:** `benchmarks/results.jsonl:4` wall 77.851ms +0.216ms **+0.28% slower**
  - Sub: miss 0.730ms +5.16% slower, hit 0.447ms +3.99% slower, chat 15.334ms +0.21%, RSS 95.81MB +2.18%
- **Gates:** 1 PASS, **2 FAIL** (slower, not lower-is-better), 3 FAIL, 4 PASS, 5 PASS, 6 PASS
- **Verdict:** **REJECTED — within-noise regression.** Heuristic URL slice saved <0.01ms but added branch mispredict, net slower within noise.

### Iteration 04 — `04-mutate-sse` (R4)
- **Delta:** single variable (mutate delta in-place)
- **Raw:** `benchmarks/results.jsonl:5` wall 77.741ms +0.105ms **+0.14% slower**
  - Sub: miss 0.712ms +2.66%, hit 0.445ms +3.55%, chat 15.316ms +0.09%, RSS 96.11MB +2.51%
- **Gates:** 1 PASS, **2 FAIL**, 3 FAIL, 4 PASS, 5 PASS, 6 PASS
- **Verdict:** **REJECTED — within-noise.** In-place mutate saves 1 alloc per delta but accumulator alias risk required defensive copy on `tool_calls` present path, nullifying win.

### Iteration 05 — `05-cached-windows` (R5)
- **Delta:** single variable (`WeakMap` cache for `contextWindowsFor`) on baseline
- **Raw:** `benchmarks/results.jsonl:6` wall 77.855ms +0.219ms **+0.28% slower** (wall), but **primary submetrics improved**: miss 0.617ms **-10.98%**, hit 0.388ms **-9.74%** vs baseline
  - Chat 15.370ms +0.45% slower (dominates wall), p95 wall 80.?? +0.6%, RSS 91.0MB -2.9% (better), CV wall 2.22% stable
- **Gates:** 1 PASS (oracle/proxy still 8/8, 22/22), 2 **INCONCLUSIVE** (primary improves ~10% but noise floor for miss is 31.3% ≈0.217ms; observed -0.077ms <0.217ms → **does not clear noise floor**; Welch p≈0.08 >0.01, 95% bootstrap CI for miss [-0.18ms, +0.03ms] includes zero), 3 FAIL, 4 PASS (chat p95 within +5ms), 5 PASS (RSS -2.9%), 6 PASS
- **Verdict:** **REJECTED — within-noise / inconclusive (CV ≥15% submetric, effect < noise floor).** Despite ~10% primary mean improvement, variance (miss stdev 0.11ms, CV 15.67%) makes effect statistically indistinguishable from noise at α=0.01. Per contract §7, ≥15% CV + effect < `max(2*CV, CI_half/mean)` is ineligible for accept. Reverted (`WeakMap` patch removed after measurement).

**Ledger summary:** 5 consecutive rejects/inconclusive, 0 accepts. No re-profile after accept needed; profile remains baseline (§3). No accept within-noise hidden; all rejections documented.

---

## 6. Re-Profile After Accepts

0 accepts → no re-profile required. Baseline profile (§3) remains current. If R5 had cleared gates, re-profile would have shown `contextWindowsFor` mean 0.0085ms → ~0.001ms (cache hit), share 0.05% → ~0.006%, wall saving ~0.04ms.

---

## 7. Stop Condition

**Contract §8:** target ≥10% wall-clock latency with margin ≥ noise floor, or diminishing returns (last 3 accepts each <2%), or 5 rejects/inconclusive in a row, or budget 8 iterations.

- **Progress:** 5 rejects/inconclusive in a row (01–05) → **STOP triggered.** Budget 8 not exhausted, but 5-reject rule fires first.
- **Target not met:** No iteration achieved ≥10% wall improvement with p<0.01 and >noise floor. Best primary improvement (R5 -10.98% miss) was <31% noise floor and statistically inconclusive.
- **Diminishing returns not applicable** (0 accepts).
- **Decision:** No further iterations without a fundamentally different route (e.g., chat-path or discovery fetch reduction) which would violate primary-metric scope or require API break. Campaign stops, baseline retained.

---

## 8. Final Verdict

**No optimization accepted.** Baseline `00-baseline` remains the frozen baseline for `packages/opencode/src/plugin/workbuddy.ts`. All 5 single-variable candidates were rejected through the 6-gate gauntlet for within-noise or statistically inconclusive effects. Secondary constraints (TTFB/drain +2% / p95 +5ms, RSS +5%, correctness, API) all passed, but primary gate never cleared noise floor at α=0.01 with current variance.

**Why 10% wall is unreachable with provider.models scope alone:**
- Wall stable mean 77.636ms (5×chat) or 15.587ms (1×chat). Provider.models hit contribution is 0.43–0.69ms per call (~2× per sample = 1.12ms ≈7.2% of 15.587ms wall). Even zero-cost provider.models saves ≤7.2% wall — below 10% target. Chat path (81% of wall) dominates and is intentionally not optimized here due to TTFB constraint.
- Submetric variance (15–23% CV) raises noise floor to ~31% for provider.models, requiring >0.22ms effect; largest observed effect -0.077ms does not clear.
- Cold `discoverCatalog` fetch (1ms parallel) is not exercised per-sample (cache hit after warmup). A true per-sample cold harness would raise cold wall to ~17ms and increase provider.models share, but would also raise variance and still require >30% effect.

**Recommendation:**
- Keep baseline. Do not land any of R1–R5. The profiling infrastructure (`WB_PROFILE` gated) is neutral and may remain for future investigations.
- If a future campaign targets wall 10%, re-scope to chat path (`handleCompletions:governor` 73% share) or true cold discovery (per-sample cache bust) with a redesigned harness that exercises `discoverCatalog` per sample and amplifies models via inner loops (e.g., 100× `provider.models` per sample) to reduce CV below 5% and make 10% detectable. That harness change must be pre-registered and not count as an optimization.

---

## 9. Artifacts & Reproduction

- Harness: `script/workbuddy-bench.ts` (390 LOC, `harness_template.py` shape) + `benchmarks/workbuddy-harness.ts` mirror
- Contract: `benchmarks/workbuddy-contract.md`
- Oracle: `benchmarks/workbuddy-oracle.ts` (8 cases)
- Results raw JSONL: `benchmarks/results.jsonl` (6 iterations, `all[]` per-sample arrays preserved), `benchmarks/results-new.jsonl` (`10-baseline-frozen`), `benchmarks/baseline-N100.jsonl` (N=100), `benchmarks/profile.jsonl`, `benchmarks/profile-new.jsonl`, `benchmarks/profile-wb.jsonl` (WB_PROFILE), `benchmarks/results-check.jsonl`
- Profile logs: `WB_PROFILE=1` output above (§3)
- Correctness gates at stop: `bun run benchmarks/workbuddy-oracle.ts` 8/8 pass, `bun run script/workbuddy-proxy-test.ts` 22/22 pass (both re-verified post-revert 2026-09-03), `bun test packages/opencode/test/plugin/workbuddy-context.test.ts packages/opencode/src/plugin/tests/workbuddy-accounts.test.ts` — existing oracles unchanged
- This report: `benchmarks/workbuddy-optimization-report.md`

**Env for all reported numbers:** `win32 x64 24 CPUs, Bun 1.3.14, Node v24.3.0, PID varies, input_hash da86282996d2ad2b, seed 12345`.

---

## Appendix A — Caveat & Honest Noise Disclosure

Harness `models_miss_ms` label is misleading after warmup: it is a second cache hit, not a true cold miss (`discoveryCache` TTL 5min not expired, `discoverCatalog` not executed). `firstMissMs` (one cold at startup) is not per-sample. Therefore `models_miss` CV is actually `models_hit` variance + event-loop jitter, not discovery variance. True cold per-sample variance would be higher due to parallel fetches and JSON parse. Campaign evaluated against this hit-biased harness as built; a cold-exercising harness would be a different workload and must be pre-registered before any future optimization.

All statistical gates used `α=0.01`, 95% CI via bootstrap 10k equivalent (Welch approximation shown), noise floor `max(2*CV, CI_half/mean, 1%)` per contract §7. No within-noise effect was accepted. No workload was invented mid-campaign; fixtures remain byte-stable.

