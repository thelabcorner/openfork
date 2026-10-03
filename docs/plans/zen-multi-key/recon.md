# Zen multi-key recon — evidence for architecture.md

Status: superseded as a line-numbered survey, current as a semantic record. The
multi-key path is implemented, so this document no longer cites line numbers —
they drift on every provider change and were repeatedly wrong about removed
code. Findings are now anchored to symbols, which are stable, and each one
records what the tree actually does today.

---

## 1. TRANSPORT SEAM (resolved, and now built)

### What Zen actually is in this codebase

- Two provider ids, sharing one physical key pool: `opencode` (Zen, hosted
  OpenAI-compatible gateway, includes the free tier) and `opencode-go` (Go).
  Both loaders are in `packages/opencode/src/provider/provider.ts`. Note
  `opencode-zen` is only the *quota adapter* id, not a provider id.
- SDK: `@ai-sdk/openai-compatible`, from the models.dev catalog.
- Base URL: `https://opencode.ai/zen/v1`, pinned in a test fixture
  (`packages/core/test/plugin/provider-google-vertex.test.ts`) and in
  `discoverZenSystemOneModel`. The URL itself lives in the remote models.dev
  catalog (`model.api.url`), not in this repo's source.

### The seam, and why it is the right one

Provider state (and `provider.key`) is a snapshot rebuilt only on auth/config
changes, and the SDK client bakes `apiKey` into the `Authorization` header at
construction. So a per-request key swap cannot come from a `chat.headers` hook
and cannot come from rebuilding clients. The seam that works is the
`options.fetch` wrapper `resolveSDK` already supports.

As built, `provider.ts` injects that wrapper at two loader sites:

- `opencode` custom loader → `options: { ...(ok ? {} : { apiKey: ZEN_PUBLIC_API_KEY }), fetch: zenProviderFetch }`
- `opencode-go` loader → `options: { fetch: zenGoProviderFetch }`

`snowflake-cortex` is the in-tree precedent for a provider loader supplying
`options.fetch`. The committed-route path in `provider.ts` additionally swaps in
`committedZenProviderFetch(accountID)` and `committedPublicZenProviderFetch`,
which is how a route that has already chosen an account is kept from being
replaced by the pool default at the physical boundary.

The wrapper (`routedZenProviderFetch` in `packages/opencode/src/plugin/zen.ts`):

- parses the request body's `model` field and splits the account suffix;
- resolves the key via `resolveZenRequest`;
- sets `Authorization: Bearer <selected key>`;
- rewrites the body to the base model id so upstream never sees the suffix;
- observes non-ok responses into the pool (via `response.clone()`-safe reading
  of the status and `retry-after`);
- reports the account back with `withRoutedAccount`
  (`packages/opencode/src/provider/routing-metadata.ts`), which sets the
  routed-account header and supports verifying that the observed account
  matches the expected one.

**Correction to the old plan:** the original recon proposed reading a session id
from a `chat.headers`-injected header and splitting the model from the body.
The shipped design does not use `chat.headers` at all. WorkBuddy does inject
`x-opencode-session` through that hook, but Zen routes on the model suffix
instead, so there is no session header to read.

---

## 2. KEY STORAGE (resolved — the fork vault was reused)

- `packages/opencode/src/fork/credentials.ts` is already a multi-key Zen/Go
  store: SQLite `fork_credential` (id, label, key, active, time_created), a
  `ForkCredentials` Effect service with `list` / `active` / `add` / `select` /
  `rename` / `remove` / `recordUsage` / `credentialsForMessages` /
  `usageByCredential`, an auth.json one-time migration, server route handlers,
  and a `LayerNode.make` wired to `Database.node` and `Auth.node`.
- The old plan floated a new `ZenVault` JSON file under the cache/share root.
  That was rejected and not built: it would have duplicated an existing owner.
  `zen.ts` reads the fork service through a small Effect runtime over
  `ForkCredentials.node` using the shared memo map, so the global Database layer
  is reused rather than opening a second connection.
- Reads are single-flight and TTL-cached. A read failure returns the current
  state unchanged and falls back to environment keys only, so an unavailable
  store never drops accounts already in the pool. `bumpZenVaultPool()` forces a
  re-read after add / remove / rename / set-default.
- Env intake (`zenEnvCredentials` in `packages/opencode/src/plugin/zen-accounts.ts`)
  is `OPENCODE_API_KEY`, `OPENCODE_API_KEYS` (comma-separated), and numbered
  `OPENCODE_API_KEY_2` … `OPENCODE_API_KEY_10`, trimmed and quote-stripped.

**Correction to the old plan:** the original spec proposed `ZEN_API_KEY` /
`ZEN_API_KEYS` / `ZEN_API_KEY_2`… and a `ZenAccount` carrying its own
`mtime`/`everUsed` bookkeeping. The shipped code uses the fork's `OPENCODE_*`
env names, and ordering has no `everUsed` or load signal at all.

---

## 3. ERROR SHAPES (free tier verified; paid keys still unverified)

### What the repo knows (verified)

- **Zen free-tier exhaustion = HTTP 429 with a response body containing
  `FreeUsageLimitError`.** Sources: `docs/handoff/HANDOFF-zen-free-usage-limits.md`,
  the persisted-error scanner `packages/opencode/src/usage/zen-free.ts` (matches
  `error.name === 'APIError'` AND a response body containing
  `FreeUsageLimitError`, scoped to `providerID = 'opencode'`), and the retry
  classifier in `packages/opencode/src/session/retry.ts`.
- The detection convention is **error-body discrimination, not status code**:
  `retry.ts` checks `error.data.responseBody?.includes("FreeUsageLimitError")`.
  The handoff is explicit that a credit balance does not exempt a user from the
  free limiter, so billing state must never be used to infer free-quota state.
- **Go variant**: `GoUsageLimitError` with `metadata.workspace` and
  `metadata.limitName` in the body plus a `retry-after` header, also handled in
  `retry.ts`.
- **Reset handling that already exists**: `retry.ts` reads `retry-after-ms` then
  `retry-after` (seconds or HTTP-date) from `error.data.responseHeaders`, else
  capped exponential backoff. `quota/providers/http.ts` parses `retry-after` on
  429 for quota cooldown. `quota/providers/genspark.ts` does the same from raw
  headers. WorkBuddy's `parseResetAt` in
  `packages/opencode/src/plugin/workbuddy-governor.ts` is the richest variant in
  the tree (Retry-After → JSON `resetAt`/`reset_time`/`resetDate`/`reset_at` →
  natural-language text).
- **Upstream free-tier policy**, per the handoff: the limiter is IP-scoped; the
  reset boundary is 00:00 UTC, not a rolling 24h; "new" IPs can receive 2x the
  default daily allowance; per-model rate-limit overrides exist server-side; and
  the upstream `checkHeaders` / `dailyRequestsFallback` header policy exists in
  source but is **disabled** — so quota headers must not be assumed present.

### What the shipped governor does

`ZenAccountPool.observe` is deliberately thin: `402` → `QUOTA_EXHAUSTED`,
`429` → `COOLING_DOWN` with `reset-after` parsed by `retryAfterMs` (seconds or
HTTP-date, fixed 30s fallback), `2xx` → clear. `state()` returns to `READY` once
`now` passes `resetAt`. No learned window, no persistence, no model entitlement.

### What is NOT verifiable from this repo (honesty section)

- The error shape for **paid API keys** on rate-limit or credit exhaustion:
  429 vs 402 vs an in-band body, and which headers accompany them. Nothing
  in-tree observes it. The only authenticated Zen endpoint used in-tree is the
  Go usage endpoint (`packages/opencode/src/fork/usage-cache.ts`, Bearer auth,
  driving the separate `opencode-go` provider). No header name beyond
  `retry-after` / `retry-after-ms` is observed anywhere.
- So paid-key exhaustion must be observed at runtime and logged verbatim before
  being encoded. Do not infer it from billing, and do not assume 402 means
  anything upstream.
- The free limiter being IP-scoped means the free-tier estimate is genuinely
  shared across keys. Per-key differentiation can only ever come from observed
  402/429 responses on that key.

---

## 4. MODEL ENTITLEMENTS (verdict: none, in either plugin's case for Zen)

- Evidence **for** free-pool model-level gating: per-model server-side overrides
  (handoff §2.5). Evidence for paid-key model-tier gating: **none in-tree**.
- WorkBuddy's `canAdmitModel` (on `WorkBuddyEntitlementGovernor`) is a
  per-`(account, model)` window check driven by observed vendor error codes, and
  its `hasKnownCredits` / `modelReports` are the richer version of the same
  idea. **Zen has no equivalent** — there is no per-`(key, model)` entitlement
  anywhere in `zen-accounts.ts` or `zen.ts`. Do not describe Zen as having one.
- Recommendation stands and is now the shipped state: no model tiers. If gating
  ever appears, `canAdmitModel` is the shape to copy, and it would be new code.

---

## 5. ROUTING (diverges from the original proposal on purpose)

- The original plan was a session-bound router: one key per session, affinity
  preserved, failover on exhaustion, ordered by `resetAt` ascending with
  never-yet-used keys last. **That was not built**, and the reason matters: the
  model id already carries an account suffix, so the model picker *is* the
  explicit intent channel. Adding session affinity on top would have made an
  account-qualified model a silent no-op whenever a session was already bound —
  the exact bug WorkBuddy's `AccountRouter.select()` had to be fixed for.
- What ships instead:
  - `resolveZenModelParts` treats the **last** `@zen-` marker as authoritative,
    tolerating a context suffix and stripping junk after the account so a
    malformed id cannot leak routing metadata onto the wire.
  - `resolveZenRequest` precedence: explicit suffix (fails closed on a removed
    account) > `public` sentinel for `opencode` > direct provider credential for
    `opencode-go` > pool default for `opencode` > provider auth as a
    compatibility fallback when the pool is empty.
  - Per-account model variants are emitted from the `provider.models` hook as
    `${baseModelID}@${account.id}` named `${baseName} (${label})`. Already-
    qualified ids yield no aliases, so they cannot nest.
- WorkBuddy's router remains the in-tree precedent if per-session stickiness is
  ever wanted for Zen. That would be a behavior change, not a wiring fix.

---

## 6. PLUGIN WIRING

- Plugin shape is `async function(input: PluginInput): Promise<Hooks>`.
- `packages/opencode/src/plugin/zen.ts` exports `ZenPlugin` (provider id
  `opencode`) and `ZenGoPlugin` (provider id `opencode-go`, models-only so the
  event hook runs once). Both are registered in
  `packages/opencode/src/plugin/index.ts` alongside `WorkBuddyPlugin`.
- Hooks used: `provider: { id, accounts, models }` and `event`. Zen does **not**
  use `chat.headers`, `provider.models`-as-provider-factory, or
  `auth: { provider, methods }`.
- Zen's hosted model discovery is in the same module: `zenHostedCatalog()`
  returns `fresh` / `stale` / `expired` / `unavailable` and
  `discoverZenSystemOneModel` synthesizes the zero-cost System One entry for the
  exact free id `jev-1.13-free` only while the live `/models` surface advertises
  it. The cache file is versioned, written `0o600`, and rejected when
  implausible; discovery is off in tests unless a test fetch or cache file is
  set.
- **Limits-panel data flow**: the panel consumes quota `ProviderResult` windows.
  `opencodeZen` still emits one `daily <source>` window with
  `resetAt = zenUtcDayEnd(fetchedAt)`, and attaches per-key rows under
  `usage.zenAccounts` via `zenKeyLimitsRows`, built from `zenLimitSnapshot()`
  (the pool snapshot: `accountId`, `label`, `source`, `isDefault`, `state`,
  `resetAt`). Each row carries `resetAt` / `resetAfterSeconds`, so the panel's
  `WindowRow` renders it with no special casing and countdowns tick off the
  shared clock.
  **Correction to the old plan:** the original proposal was to emit one quota
  window per key. The shipped shape is one shared daily window plus a per-key
  row list, which is the honest projection while the free limiter is IP-scoped.

---

## 7. TEST CONVENTIONS

- Harness: **bun test**, from `packages/opencode` only. The root `package.json`
  guards against running tests from the root.
- Location: `packages/opencode/test/**` mirroring `src/`. Zen tests:
  `test/plugin/zen-verify.test.ts`, `test/plugin/zen-smoke.test.ts`,
  `test/plugin/zen-selector.test.ts`, `test/quota/opencode-zen.test.ts`,
  `test/usage/zen-free.test.ts`.
- Prefer real fixtures over mocks (repo style): `zen-free.test.ts` seeds real
  message/part rows in SQLite; router-style tests construct real registry
  objects.
- Test-only isolation seams are explicit module-level setters. Zen provides
  `setTestZenFetch`, `setTestZenCatalogCacheFile`, `setTestZenVaultCredentials`,
  and `resetZenPoolForTest`. WorkBuddy's governor provides `setEntitlementFile`
  and `clearEntitlementForTest`. Copy this pattern for any new Zen state holder.

---

## 8. EFFECT STYLE RULES for implementers

From `.opencode/skills/effect/SKILL.md` and `packages/opencode/AGENTS.md`:

- Effect **v4 / effect-smol**; verify APIs against the repo's effect reference,
  never from memory.
- `Effect.gen(function* () { ... })` for composition; `Effect.fn("Domain.method")`
  for named/traced effects; `Effect.fnUntraced` for internal helpers; accept
  pipeable operators as extra args instead of an outer `.pipe()`.
- No `Effect.fork` / `Effect.forkDaemon` (v4 removed them) — use
  `Effect.forkIn(scope)`. `Effect.void`, not `Effect.succeed(undefined)`. Prefer
  `DateTime.nowAsDate`.
- Schemas: `Schema.Class` for multi-field, `Schema.brand` for single-value,
  `Schema.TaggedErrorClass` for typed errors, `Schema.Defect` for defects;
  `yield* new MyError(...)` for early failure.
- Module shape: **no `export namespace`**; self-reexport `export * as Foo from
  "./foo"` at the file bottom; no barrel `index.ts` in multi-sibling dirs.
- Services: `Context.Service` + layer + `LayerNode.make` with explicit deps.
  `makeRuntime` from `src/effect/run-service.ts` for running a service; the
  shared `memoMap` is what keeps a second runtime over `ForkCredentials.node`
  from opening a second Database connection.
- Prefer Effect services (`FileSystem`, `HttpClient`, `Clock`, `DateTime`) over
  raw APIs **in Effect code** — but note the plugin precedent: the WorkBuddy
  governor/registry/router are deliberately plain sync classes, and Zen is
  plain async JS. Mirror that split rather than effectifying for its own sake.
- General TS style: no `any`, no non-null assertions, avoid try/catch, prefer
  early returns over `else`, prefer const, no import aliases or star imports.
- Quota adapter contract: adapters **never fail** — failures become
  `ok: false`; `configured()` must not touch the network; same-id fetches are
  single-flight.

---

## Bottom line for implementers

1. Routing happens in `options.fetch` wrappers injected by the `opencode` and
   `opencode-go` provider loaders in `provider/provider.ts`; committed routes use
   `committedZenProviderFetch` / `committedPublicZenProviderFetch` so a decided
   route cannot be re-decided. One client per provider, `Authorization` swapped
   per request, body model de-qualified to the base id.
2. The model id's `@zen-` account suffix is the explicit intent channel. There is
   no session router and no `resetAt`-ordered failover queue. WorkBuddy's
   `AccountRouter` is the precedent if that is ever wanted.
3. Key storage is the fork's SQLite `ForkCredentials` service. Do not add a
   parallel vault. Env intake is `OPENCODE_API_KEY` / `OPENCODE_API_KEYS` /
   `OPENCODE_API_KEY_2…10`.
4. Failure state is in-memory and display-only: `READY` / `COOLING_DOWN` /
   `QUOTA_EXHAUSTED` from observed 429/402 with a `retry-after` parse. It is not
   persisted and does not steer selection.
5. Free-tier detection discriminates on the `FreeUsageLimitError` body, not on
   status code or billing state. Paid-key exhaustion is unverified and must be
   observed at runtime, not assumed.
6. Per-key surfacing is one shared daily window plus per-key `zenAccounts` rows
   — correct while the free limiter is IP-scoped.
7. The parts WorkBuddy has that Zen does not: session binding, the entitlement
   governor, `canAdmitModel` / `hasKnownCredits` / `modelReports`, a loopback
   proxy, the `parseResetAt` ladder, and persistence. Treat each as new Zen
   work, never as existing behavior.
