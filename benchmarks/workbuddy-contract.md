# WorkBuddy Optimization Contract — Frozen Baseline

## 1. Primary Metric
- **Metric**: Wall-clock latency (lower is better) for the critical loopback provider path.
  Composite sample = `T_models_miss + T_models_hit + T_chat_nonstreaming` measured end-to-end via `WorkBuddyPlugin` against a mocked Tencent upstream.
  - `T_models_miss`: first `provider.models()` after TTL expiry / cold discoveryCache (forces `discoverCatalog` → parallel `/v3/config` + `/console/enterprises/{id}/config/models` with `CATALOG_USER_AGENT`).
  - `T_models_hit`: second `provider.models()` within TTL (cache hit).
  - `T_chat_nonstreaming`: single `POST http://127.0.0.1:{proxy.port}/v1/chat/completions` with `stream:false` (proxy folds streaming SSE to single `chat.completion`), payload `{model:"hy4-preview", messages:[{role:"user",content:"hi"}], max_tokens:64}`.
  Sub-metrics reported separately (models_miss, models_hit, chat) but **primary gate is the sum per sample (ms)**.
  Also reported for context: `T_chat_streaming_first_chunk` and `p95`, but not gated as primary.
- **Direction**: Lower is better.

## 2. Constraint Budgets (hard gates)
- **Correctness**: No regression vs oracle. Oracle = `bun test packages/opencode/test/plugin/workbuddy-context.test.ts packages/opencode/src/plugin/tests/workbuddy-accounts.test.ts` + golden snapshot of `exposedModels`/`parseConfigPayload`/`parseWorkBuddyContextWindows` (exact equality, no epsilon). Any semantic drift → reject.
- **Peak RSS**: ≤ +5% vs baseline fresh-process peak (`process.memoryUsage().rss` max across samples, also `ru_maxrss` proxy via `process.memoryUsage`). Measured in separate isolated runs, not mixed with timing.
- **API contract**: No break to `Model` shape (`id`, `api.url` `http://127.0.0.1:<port>/v1`, `api.npm`, `limit.context`, `headers.Authorization`), provider id `workbuddy`, `/health` and `/metrics` schemas, SSE quirk normalization (`tool_calls:[]` stripped, `reasoning_content` forwarded), `chat.headers` injection.
- **Secondary latency**: p95 of primary metric ≤ +5% vs baseline p95 (no tail regression).
- **Throughput**: Concurrent generations throughput (10 concurrent `POST` via same proxy) not regressing >5% when measured separately; used as informational secondary, hard-fail only if >10% drop with p<0.01.

## 3. Representative Workload
- **Tencent payload fixtures** (SHA-256 hashed per sample for input_hash):
  - Global `/v3/config` fixture: `data.models` 9 entries (hy4-preview 1M context + 8 others), `data.agents[cli].models` intersects 7, `data.modelPromotions` 2 entries, `contextWindow` variants with `supportedLengths` mix of numbers and `{tokens}` objects, `credits` strings `"x0.79 credits"` / `"x0.00"` (free), sizes 12–18 KB JSON.
  - Enterprise `/console/enterprises/{enterpriseId}/config/models` fixture: same schema but `data` is array directly, 5 entries, overlapping ids.
  - Generated deterministically via `makeInput(seed)` with seeded RNG for model ids/credits; payload JSON byte-stable for hash.
- **Accounts**: isolated vault with 2 accounts: Global (`www.workbuddy.ai`, uid u1, enterprise e1) and CN (`www.codebuddy.cn`, uid u2). Discovered via `setTestAccountStore(tmpdir)`.
- **Upstream mock**: `http.createServer` on 127.0.0.1 ephemeral, handler for `GET /v3/config`, `GET /console/.../config/models`, `POST /v2/plugin/auth/token/refresh` (200), `POST /v2/chat/completions` streaming 2 SSE chunks + `[DONE]` (`content:"HY4_OK"`, `reasoning_content:"thinking"`), 1ms artificial latency to avoid timer quantize but preserve loopback hop.
- **Environment**: `ensureLoopbackProxyBypass()` enforced, `PROXY_PORT=19731` stable with `extraServers` revival path exercised by feeding one stale `api.url` (`http://127.0.0.1:59731/v1`) into `provider.models` input.
- **Sample shape**: `inner_loops=1` per harness sample (each sample is one full composite as above); `n` measured samples, `warmup` discarded. Each sample creates isolated provider.models call pair + chat POST; governor lease released per completion; upstream completion counters asserted =1 per POST (no duplicate generation).
- **Regeneration**: `bun run benchmarks/workbuddy-harness.ts --iteration-id <id> --n <N> --warmup 5 --out results.jsonl --seed 12345` (see harness).

## 4. Correctness Oracle
- **Existing tests**: `bun test` for `workbuddy-context.test.ts` (3 tests: explicit selectable lengths, ignores range bounds, decodes context aliases) and `workbuddy-accounts.test.ts` (stableAccountIdentity, accountLabels, AccountRouter select/affinity) + project scripts `workbuddy-proxy-test.ts` / `workbuddy-governor-test.ts` / `workbuddy-loopback-test.ts` logic spot-checked via harness.
- **Golden snapshots**: Or `benchmarks/workbuddy-oracle.ts` generates deterministic `parseConfigPayload` output for the two fixtures + `parseWorkBuddyContextWindows` cases + `exposedModels` for hy4-preview with 3 windows and account suffix; compared exact JSON.stringify equality.
- **Numerical tolerance**: None — exact string/JSON equality (no epsilon) because all transformed values are IDs, credits strings, and integer contexts. Approximation route pre-declared **ineligible**; any numeric drift is semantic/epsilon violation.
- **Property checks**: `exposedModels` count = `contextWindows.length` (deduped sorted), `catalogFor` last-known-good fallback when discovery returns null, `extraServers` size never exceeds stale set size, `proxyToken` stable across calls.

## 5. Baseline Strategy
- **Frozen baseline**: All candidates compare against the original baseline locked before any edit. Rolling re-baseline only for final cumulative report overlay, not for gate decisions. Baseline commit: HEAD of `packages/opencode/src/plugin/workbuddy.ts` at 72d437d with stable-port patch.

## 6. Harness Requirements
- Discard warmup (≥5), run N≥30 measured samples per iteration (N=50 for noisy CoV 5–15% branch), persist raw per-sample `wall_s` + `wall_s_per_inner` + sub-metrics, input_hash, sink_checksum, env (bun, platform, cpu_count, pid).
- Consume outputs (checksum over last model list + chat JSON) so JIT cannot delete work.
- Separate timing runs from allocation/RSS runs (`--track-allocs` separate process).
- Preserve production runtime: GC mode `production` (no disable), parallelism preserved, real `fetch` + loopback TCP, no mocked timers.
- Support inner loops only if per-sample <1 ms (not needed; baseline expected 15–40 ms).

## 7. Statistical Gates (per skill)
- α=0.01, 95% CI via bootstrap (10k resamples) + Welch where applicable, CoV policy <5% stable / 5–15% noisy usable / ≥15% reject inconclusive, noise floor = max(2*relative_stdev, CI_half_width/mean, 1%).
- Effect must clear zero and noise floor in desired direction.

## 8. Stop Condition
- Target improvement ≥10% wall-clock latency with margin ≥ noise floor, or diminishing returns (last 3 accepts each <2%), or 5 rejects/inconclusive in a row, or budget 8 iterations.

---
Locked: 2026-09-03. Any edit before this contract is a process violation.
