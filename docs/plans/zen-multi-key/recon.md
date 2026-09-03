# Zen multi-key recon — evidence for architecture.md open questions

Status: complete. All findings verified against the tree at recon time. Line
numbers are current as of this pass; where the spec's references drifted, the
current location is given.

---

## 1. CLIENT CONSTRUCTION SEAM (open question #4 — resolved)

### What Zen actually is in this codebase

- Provider id: **`opencode`** (not `opencode-zen` — that is only the *quota*
  adapter id). Proof: `zen-free.ts:186` filters persisted requests by
  `json_extract(m.data, '$.providerID') = 'opencode'`;
  `packages/app/src/components/prompt-input/limit-arc.ts:85` documents
  "`opencode` is Zen (an API key from opencode.ai/zen) and `opencode-go` is
  the [Go provider]".
- npm package: `@ai-sdk/openai-compatible` (models.dev catalog default,
  `provider.ts:1469`).
- Base URL: **`https://opencode.ai/zen/v1`** — pinned by the fixture at
  `packages/core/test/plugin/provider-google-vertex.test.ts:98`
  (`url: "https://opencode.ai/zen/v1"`). The URL itself lives in the remote
  models.dev catalog (`model.api.url`), not in this repo's source.

### The construction path, step by step

1. **Provider key resolution** — `provider.ts` state build:
   - models.dev env list: `provider.ts:1906-1917` (`provider.env.map((item) => envs[item]).find(Boolean)`)
   - auth.json api entries: `provider.ts:1919-1930`
   - **Fork override: `provider.ts:1932-1942`** — `forkCredentials.active()`
     overrides the key for BOTH `opencode` and `opencode-go`:
     `mergeProvider(providerID, { source: "api", key: forkActive.key })`.
   - The `opencode` custom loader: `provider.ts:240-262` — autoloads if env
     key, `dep.auth("opencode")`, or config
     `provider["opencode"].options.apiKey` exists; otherwise sets
     `options: { apiKey: "public" }` (anonymous free tier).
2. **Plugin `auth.loader` merge** — `provider.ts:1945-1963`. IMPORTANT CAVEAT:
   only runs when `auth.get(providerID)` returns a stored credential
   (`provider.ts:1950-1952`).
3. **Plugin `provider.models` hook** — `provider.ts:1756-1794`: replaces
   `provider.models` wholesale; can create a custom provider from scratch.
4. **`resolveSDK`** — `provider.ts:2087-2216`, the actual seam:
   - `baseURL = options.baseURL ?? model.api.url` (`2112-2114`)
   - `options.apiKey ??= provider.key` (`2134`)
   - **SDK instance cache keyed by `Hash.fast(JSON.stringify({providerID, npm, options}))`
     (`2141-2148`)** — a client per distinct key is created lazily and cached.
   - `options.fetch` (customFetch) is captured and wrapped into the final
     fetch (`2151-2158`), combined with chunk/header timeouts and
     `wrapSSE` (`2182-2183`).
   - Bundled factory: `createOpenAICompatible({ name: model.providerID, ...options })`
     (`2186-2195`).
5. **Per-request hooks** — plugin `chat.headers` (signature at
   `packages/plugin/src/index.ts:257-260`) is triggered per LLM request at
   `session/llm/request.ts:157-169`; its output headers ride the actual SDK
   request. Verdent uses it to pass `x-opencode-session`
   (`verdent.ts:2704-2710`); WorkBuddy likewise (`workbuddy.ts:1270-1276`).

### The splice point (recommendation)

The router must select a key **per request**, but provider state (and
`provider.key`) is a snapshot rebuilt only on auth/config changes, and the SDK
client bakes `apiKey` into the `Authorization` header at construction. The
viable seam is therefore **the `options.fetch` wrapper** that `resolveSDK`
already supports (`provider.ts:2151-2158`):

- One `createOpenAICompatible` client instance total (apiKey value irrelevant
  or first key); the wrapper rewrites `Authorization: Bearer <selected key>`
  per request after the SDK builds init.headers.
- Wrapper reads `x-zen-session` (set via the plugin's `chat.headers` hook —
  same pattern as verdent.ts:2706) plus the request body's `model` field,
  consults `ZenRouter.select(session, model)`, records the upstream response
  status/headers into the governor (non-2xx bodies can be inspected via
  `response.clone()`), and deletes its internal headers before dispatch.
- This is exactly Verdent's loopback-proxy behavior minus the loopback —
  matching the spec's §4 intent.

Injection options for the wrapper, ranked:

- **(a) In-tree core change (recommended):** extend the `opencode` custom
  loader at `provider.ts:240-262` to attach `options.fetch` when >1 key is
  configured — precedent is exact: `snowflake-cortex` injects `options.fetch`
  the same way (`provider.ts:1064`). A pure external plugin cannot reach this
  seam today.
- **(b) Plugin `auth.loader`** (`provider.ts:1945-1963`) — works but only
  fires when an auth.json entry exists for `opencode`; fork users who added
  keys via the fork credential store may not have one. Unreliable as the sole
  injection path.

Note the `zenmux` reference at `provider.ts:655-664` is a *different*
provider (ZenMux aggregator), not OpenCode Zen.

### Existing multi-key machinery you must not duplicate

- **`src/fork/credentials.ts` is already a Zen/Go multi-key vault**: SQLite
  `fork_credential` (id, label, key, active, time_created) + per-message
  attribution `fork_message_credential` (`credentials.ts:71-94`), interface
  `list/active/add/select/rename/remove/recordUsage/credentialsForMessages/
  usageByCredential` (`credentials.ts:30-51`), auth.json one-time migration
  (`103-117`), server routes (`server/routes/instance/httpapi/handlers/
  fork-credential.ts`), registered in `effect/app-runtime.ts:68`.
- Today it does **manual** active-key switching, not routing. Usage
  attribution happens at `session/processor.ts:549-556` — attributes each
  assistant message to whichever credential is active **at step-finish**,
  which is approximate under automatic routing. A router must either record
  the actual key inside the fetch wrapper or accept this attribution skew.
- Implication for spec §1 (storage): a new `ZenVault` JSON file would
  duplicate `fork_credential`. Recommend reusing/extending it (or at minimum
  a deliberate decision), with env-only intake as the additive first cut.

---

## 2. ERROR SHAPES (open question #1 — resolved as far as the repo allows)

### What the repo already knows (verified)

- **Zen free-tier exhaustion = HTTP 429 + response body containing
  `FreeUsageLimitError`.** Sources: `docs/handoff/HANDOFF-zen-free-usage-limits.md:57`
  ("a sudden HTTP 429 / `FreeUsageLimitError`"), the persisted-error scanner
  `zen-free.ts:207-211` (`error.name === 'APIError'` AND
  `responseBody` contains `FreeUsageLimitError`), and the retry classifier
  `session/retry.ts:115`.
- The detection convention is **error-body discrimination, not status code**:
  `retry.ts:115` checks `error.data.responseBody?.includes("FreeUsageLimitError")`.
- **Go variant**: `GoUsageLimitError` with `metadata.workspace` +
  `metadata.limitName` in the body and a `retry-after` header
  (`retry.ts:128-148`).
- **Header parsing already exists**:
  - `session/retry.ts:56-76`: `retry-after-ms` then `retry-after` (seconds or
    HTTP-date) from `error.data.responseHeaders`, else capped exponential
    backoff.
  - `quota/providers/http.ts:180-181`: `retry-after` parsed on 429 for quota
    cooldown; `coolDown` caps it 1s..cooldownMaxMs (`http.ts:146-148`).
  - `quota/providers/genspark.ts:152-179`: same pattern from raw headers.
  - `workbuddy-governor.ts:270-302` `parseResetAt`: Retry-After → JSON
    `resetAt|reset_time|resetDate|reset_at` fields → natural-language
    "reset at YYYY-MM-DD HH:MM:SS UTC+8".
- **Upstream behavior documented** in `HANDOFF-zen-free-usage-limits.md`:
  - Reset boundary is **00:00 UTC**, not rolling 24h (§2.3, lines 128-146).
  - The free limiter is **IP-scoped**, not account-scoped (§2.2); new IPs get
    **2x** the daily allowance (§2.4); users **with credit balance can still
    hit `FreeUsageLimitError`** (§2.7) — so billing state must never infer
    quota state; detect the structured error itself.
  - Per-model rate-limit overrides exist server-side (§2.5).
  - Upstream has a `checkHeaders`/`dailyRequestsFallback` policy mechanism
    but it is currently **disabled** in source (§2.6) — do not assume quota
    headers exist.

### What is NOT verifiable from this repo (honesty section)

- The error shape for **paid API keys** (the actual multi-key target) on
  rate-limit or credit exhaustion: 429 vs 402 vs in-band error body, and
  which headers they carry. Nothing in-tree observes it; the only authenticated
  Zen endpoint in-tree is the Go usage endpoint
  `https://opencode.ai/zen/go/v1/usage` (`fork/usage-cache.ts:32`, Bearer
  auth, used by the separate `opencode-go` provider). No header names beyond
  `retry-after`/`retry-after-ms` are observed anywhere.
- Recommendation: the governor should encode the defensive ladder, mirroring
  WorkBuddy's `observe()` (`workbuddy-governor.ts:822-869`):
  1. Trust body discriminators over status codes (search for
     `FreeUsageLimitError` and any paid analog; log unknown exhaustion bodies
     verbatim for calibration).
  2. 429 with parseable reset (`parseResetAt` order: Retry-After → JSON
     fields → body text) → authoritative `resetAt`.
  3. 429 without reset → reuse `estimateZenFreeLimit` statistical learning
     per key (`opencode-zen.ts:54-133`), with a UTC-midnight daily window
     prior (`zenUtcDayEnd`).
  4. 402 (if ever observed) → hard `QUOTA_EXHAUSTED`, persisted, cleared only
     by re-enrollment — WorkBuddy's rule (`workbuddy-governor.ts:857-860`),
     never inferred from billing.
  5. Never block on unverified assumptions: unknown errors cool down
     transiently and stay `READY` after the cooldown, letting the next
     request re-learn.

---

## 3. MODEL ENTITLEMENTS (open question #2 — verdict: skip `canAdmitModel` in v1)

- Evidence **for** model-level gating existing server-side: per-model rate
  limit overrides in the free pool (`HANDOFF §2.5`, community issues
  #42074/#42977 — one free model fails while another works). Evidence for
  paid-key model-tier gating: **none in-tree**.
- WorkBuddy's `canAdmitModel` (`workbuddy-governor.ts:519-522`) is a
  per-`(account, model)` window-limited check driven by observed Tencent code
  6004; Verdent reuses it (`verdent-accounts.ts:730,743`).
- **Recommendation**: v1 governor has no model tiers — just "is this key
  usable". But record every limit hit keyed by `(accountId, modelID)` from
  day one (the data is free: `zen-free.ts` already persists modelID per
  error). If model gating ever appears, `canAdmitModel` becomes a thin read
  over that map with zero schema change.

---

## 4. PLUGIN WIRING (hook surface for zen.ts)

- Plugin shape: `async function(input: PluginInput): Promise<Hooks>`
  (`packages/plugin/src/index.ts:56-74`). Hooks used by both peers:
  - `provider: { id, models(provider, ctx) }` — `ctx.auth` carries the stored
    credential; consumed at `provider.ts:1756-1794` (models replaced
    wholesale; provider created from scratch if unknown).
  - `"chat.headers"(input, output)` — per-request; `input.sessionID`,
    `input.model` (`plugin/src/index.ts:257-260`); triggered at
    `session/llm/request.ts:157-169`.
  - `auth: { provider, methods: [...] }` — CLI/UI credential methods
    (`verdent.ts:2712-2808`); `auth.loader` merges returned options into
    provider Info (`provider.ts:1945-1963`).
  - `dispose()`.
- Registration: internal plugins are imported and listed in
  `plugin/index.ts:24-25,71-88` (`WorkBuddyPlugin`, `VerdentPlugin`); applied
  with `PluginInput { client, project, worktree, directory,
  experimental_workspace, serverUrl, $ }` at `plugin/index.ts:192-218`.
- Verdent's snapshot pattern to mirror: module-level singletons
  `verdentRegistry`/`verdentRouter` (`verdent.ts:82-84`), test isolation via
  `setTestVerdentAccountStore` (`verdent.ts:105-110`),
  `verdentLimitSnapshot()` maps `registry.all()` → per-account
  `{accountId, label, models: governor.modelReports()}` (`verdent.ts:112-125`).
- **Limits-panel data flow**: the panel consumes quota `ProviderResult`
  windows, not snapshots directly. `opencode-zen` is already a quota adapter
  (`quota/quota.ts:65`, `opencode-zen.ts:168-184`) emitting one
  `"daily <source>"` window with `resetAt = zenUtcDayEnd(fetchedAt)`
  (`opencode-zen.ts:157-163`). Per-key surfacing = emit one window per key
  (distinct labels + `valueLabel`); the panel's `WindowRow`
  (`limits-panel.tsx:220-236`) renders any row that carries `resetAt` /
  `resetAfterSeconds` — countdowns tick off the shared `now`, and
  `ResetCell` (`~185-217`) + `formatResetRange` (`130-142`) need no change.
  Queue position ("why key B is next") fits `valueLabel` or a tag column;
  that part is genuinely new UI.
- Env intake pattern to copy: `verdent-accounts.ts:498-533` —
  single + `_2.._10` numbered + comma-separated list vars, trimmed, quote-
  stripped, deduped by stable identity, env accounts ephemeral (not
  persisted).
- Stable identity pattern: `stableVerdentIdentity`
  (`verdent-accounts.ts:152-169`) — sha256 over durable fields, never the
  raw token, human-readable prefix `vd-<label>-<hash>`. Zen equivalent:
  hash the API key only (`zk-...`).
- Router pattern: `VerdentRouter.select()`
  (`verdent-accounts.ts:713-778`) — explicit account rebinds session
  (715-720); affinity broken when blocked: QUOTA_EXHAUSTED /
  canAdmitModel fail / cooldown / no known credits (722-738); eligible
  filter (740-745); least-bad fallback sorted by `resetAt` ascending
  (751-763); then the load tie-break `active + queued + (READY ? 0 : 1000)`
  at **768-774** (the spec cited 660-666 — line drift) which the spec
  replaces with pure resetAt ordering. Zen's router: keep affinity +
  explicit rebind + resetAt-ascending; drop the load tie-break and the
  credits check.
- Governor pattern: `WorkBuddyEntitlementGovernor` is a plain sync class
  (fs-persisted JSON, no Effect) with state machine
  `READY / TRANSIENT_COOLDOWN / WINDOW_LIMITED / QUOTA_EXHAUSTED /
  AUTH_INVALID / UPSTREAM_DEGRADED` (`workbuddy-governor.ts:118-124`),
  `observe()` mapping status→state (`822-869`), `metrics()` (`881-902`)
  exposing `state/resetAt/cooldownUntil/active/queued`. Zen trims: no
  concurrency/launch-rate budget, no queue, no auth recovery.
- Spec line-number drift note: env intake now at `verdent-accounts.ts:498-533`
  (spec said 403-428); `verdentLimitSnapshot` at `verdent.ts:112-125`
  (spec: 98-111); load tie-break at 768-774 (spec: 660-666).

---

## 5. TEST CONVENTIONS

- Harness: **bun test** — `packages/opencode/package.json`:
  `"test": "bun test --timeout 30000 --only-failures"`. Run from
  `packages/opencode`, never repo root (root package.json guard:
  `"test": "echo 'do not run tests from root' && exit 1"`).
- Location: `packages/opencode/test/**` mirroring `src/` layout — e.g.
  `test/usage/zen-free.test.ts`, `test/session/retry.test.ts`,
  `test/plugin/workbuddy-accounts.test.ts`, `test/fork/credentials.test.ts`.
- Effect tests: `testEffect(...)` from `test/lib/effect.ts` (exists);
  `it.live(...)` for filesystem/network/process behavior. Prefer real
  fixtures over mocks (repo style rule): zen-free.test.ts seeds real
  message/part rows in SQLite; router tests construct real registry objects
  (`test/plugin/workbuddy-accounts.test.ts:50-151`).
- Plugin modules get test-only isolation seams (`setTestVerdentAccountStore`,
  `setEntitlementFile` in workbuddy-governor.ts:213) — copy that pattern for
  ZenRegistry/ZenGovernor.

---

## 6. EFFECT STYLE RULES for implementers

From `.opencode/skills/effect/SKILL.md` + `packages/opencode/AGENTS.md`:

- Effect **v4 / effect-smol**; verify APIs against
  `.opencode/references/effect-smol` (or the provided effect reference
  checkout), never from memory.
- `Effect.gen(function* () { ... })` for composition;
  `Effect.fn("Domain.method")` for named/traced effects,
  `Effect.fnUntraced` for internal helpers; accept pipeable operators as
  extra args instead of outer `.pipe()`.
- No `Effect.fork`/`Effect.forkDaemon` (v4 removed them) —
  `Effect.forkIn(scope)`. `Effect.void` not `Effect.succeed(undefined)`.
  Prefer `DateTime.nowAsDate`.
- Schemas: `Schema.Class` for multi-field, `Schema.brand` for single-value,
  `Schema.TaggedErrorClass` for typed errors, `Schema.Defect` for defects;
  `yield* new MyError(...)` for early failure.
- Module shape: **no `export namespace`**; self-reexport
  `export * as Foo from "./foo"` at file bottom; no barrel `index.ts` in
  multi-sibling dirs.
- Services: `Context.Service` + `Layer.effect` + `LayerNode.make` (deps
  explicit); `makeGlobalNode` for process-global; `InstanceState` for
  per-directory state.
- Prefer Effect services (`FileSystem`, `HttpClient`, `Clock`, `DateTime`)
  over raw APIs **in Effect code** — but note the plugin precedent:
  verdent/workbuddy governors/registries/routers are deliberately **plain
  sync classes** with thin Effect wrappers where needed. Mirror that split.
- General TS style (docs/handoff/AGENTS.md): no `any`, no non-null
  assertions, avoid try/catch, avoid else (early returns), prefer const,
  no import aliases or star imports, inline single-use values, comments only
  for non-obvious constraints.
- Quota adapter contract (`quota/registry.ts:11-20`): adapters **never
  fail** — failures become `ok: false` results; `configured()` must not
  touch the network; same-id fetches single-flight.

---

## Bottom line for implementers

1. The splice is `options.fetch` in `resolveSDK`'s wrapper
   (`provider.ts:2151-2158`), injected via the `opencode` loader
   (`provider.ts:240-262`); one client, per-request `Authorization` swap
   keyed by a `chat.headers`-injected session header. There is no per-request
   plugin hook that reaches client construction today — a small in-tree core
   change is required.
2. `fork_credential` already stores multiple Zen keys with per-message
   attribution — extend it; do not invent a parallel vault.
3. Governor trusts body discriminators (`FreeUsageLimitError`) over status
   codes, parses Retry-After where present, and falls back to the existing
   `estimateZenFreeLimit` learner per key; paid-key exhaustion shape is
   unverified and must be observed at runtime, not assumed.
4. No model entitlement tiers in v1; keep per-`(key, model)` hit records so
   tiers can be added later.
