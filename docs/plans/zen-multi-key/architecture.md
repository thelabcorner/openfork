# OpenCode Zen: multi-API-key parallel routing

Status: implemented. `packages/opencode/src/plugin/zen.ts` and
`packages/opencode/src/plugin/zen-accounts.ts` ship the account pool, routing,
transport, and per-key limits surfacing described below. This is the as-built
contract, not a proposal.

## Goal

Zen and Go requests used to be pinned to a single credential. A user can now
supply N Zen API keys — through environment variables or the fork credential
vault — and each request is authorized with the key that its model selected.

Two provider ids share one physical key pool:

- `opencode` — Zen, the hosted OpenAI-compatible gateway (includes the free tier)
- `opencode-go` — Go

Both are assembled in `packages/opencode/src/provider/provider.ts` against
`@ai-sdk/openai-compatible`. The quota adapter
(`quota/providers/opencode-zen.ts`) only reports usage; it does not own routing.

## Relationship to the WorkBuddy plugin

Many-accounts-one-quota is a precedent, not a template. WorkBuddy
(`packages/opencode/src/plugin/workbuddy*.ts`) is the in-tree plugin that solves
the same problem, and Zen's module names follow its parts. The semantics are
deliberately different, so this section records both what carries over and what
does not.

### Carried over (semantics match)

- **One vault, owned by the fork.** WorkBuddy keeps credentials in its own
  `AccountVault` (a filesystem store in `workbuddy-accounts.ts`). Zen adds no
  vault of its own: it reads the fork-owned SQLite `ForkCredentials` service
  (`src/fork/credentials.ts`), which already holds multiple Zen keys with a
  label, a default flag, and per-message usage attribution. A second secret store
  would have duplicated an existing owner.
- **Stable, secret-free account identity.** WorkBuddy's `stableAccountIdentity`
  hashes durable fields so an account can be named in logs and UI without the
  credential. Zen's `stableZenIdentity` is the same contract over a single
  input: sha256 of the API key, first 12 hex chars, rendered `zen-<hash>`. Env
  and vault keys hash identically, so one physical key never produces two
  routing ids. Unlabeled keys fall back to `key-<hash8>`.
- **Registry shape.** `AccountRegistry` collects accounts for a router to choose
  from; `ZenAccountPool` is the same collection keyed by identity, with one
  account designated default.

### Not carried over (Zen has none of these)

Do not read Zen as behaving like WorkBuddy in these areas — they are where the
two plugins deliberately diverge.

- **Session binding.** WorkBuddy's `AccountRouter` binds a session to one
  account, breaks that affinity when the account is blocked, and breaks ties on
  in-flight load (`metrics.active + metrics.queued + ...`). Zen has no router in
  that sense; its equivalent of a session is the account suffix in the model id.
- **Entitlement governor.** `WorkBuddyEntitlementGovernor` is a persisted state
  machine with admission leases, per-model windows, learned limits, auth
  recovery, and forbidden-cooldown handling. Zen's state is a three-value
  in-memory subset: `READY`, `COOLING_DOWN`, `QUOTA_EXHAUSTED`.
- **Model entitlements.** `canAdmitModel`, `hasKnownCredits`, and `modelReports`
  are WorkBuddy-only. Zen has no per-`(key, model)` entitlement or admission
  check.
- **Loopback proxy.** WorkBuddy terminates on `127.0.0.1` because it has to
  impersonate a private protocol. Zen is already OpenAI-compatible, so there is
  no proxy hop.
- **Reset-header ladder.** WorkBuddy's `parseResetAt` tries Retry-After, then
  JSON `resetAt` / `reset_time` / `resetDate` / `reset_at` fields, then
  natural-language text. Zen parses `retry-after` only — seconds or HTTP-date —
  and otherwise applies a fixed 30s cooldown.
- **Persistence.** Zen's failure state is process-local and cleared by a restart.

## Module layout

```
packages/opencode/src/plugin/
  zen.ts           # ZenPlugin / ZenGoPlugin: routing, transport, model aliases,
                   # hosted catalog discovery, observation hooks, test seams
  zen-accounts.ts  # ZenAccountPool, stableZenIdentity, env intake, failure state
```

## 1. Account intake

Sources, in precedence order.

- **Environment** (`zenEnvCredentials`): `OPENCODE_API_KEY`, `OPENCODE_API_KEYS`
  (comma-separated), and numbered `OPENCODE_API_KEY_2` through
  `OPENCODE_API_KEY_10`. Values are trimmed and quote-stripped; the numbered
  range is capped at ten.
- **Fork vault** (`ForkCredentials.list()`): labeled keys, the default flag, and
  any key that exists only there.

Precedence in `ZenAccountPool.sync()`:

- Deduplication is by `stableZenIdentity`, so a key present in both places is one
  account, sourced from the environment.
- With any env key present, the first-declared env key is the default. The vault
  default flag is honored only when there are no env keys at all.
- If nothing ends up marked default, the first account in insertion order is
  promoted.

The vault is read through a small Effect runtime built over `ForkCredentials.node`
with the shared memo map, so it reuses the app's existing Database layer rather
than opening a second connection. Reads are single-flight and TTL-cached; a read
failure leaves the current pool intact and falls back to environment keys. The
fork credential surface calls `bumpZenVaultPool()` after add / remove / rename /
set-default, so the pool updates immediately instead of waiting out the TTL.

## 2. Routing: the model id selects the key

There is no session router. **The account suffix in the model id is the explicit
intent**, parsed per request by `resolveZenModelParts`.

- The **last** `@zen-` marker is authoritative routing metadata. It survives a
  context suffix (`base@300k@zen-<hash>` routes to `<hash>`) and neutralizes
  junk after the account (`base@zen-x@300k` routes to `x`, sends `base`).
  Malformed double-account ids route on the last account and have every trailing
  marker stripped before the wire.
- A marker at index 0 — pure routing metadata with no model — is left untouched.
- Account-qualified models are emitted from the `provider.models` hook as
  `${baseModelID}@${account.id}` with display name `${baseName} (${label})`, for
  both provider ids. The bare catalog models remain the default-account entries.
  `zenAccountModelAliases` returns nothing for an already-qualified id, so
  aliases never nest.

Bare (unqualified) models resolve by provider, in `resolveZenRequest`:

1. An explicit account suffix wins over everything and **fails closed** — if the
   named account is gone, the request errors rather than silently falling
   through to another key.
2. For `opencode`, the `public` sentinel is a credential-free route in its own
   right, not an invitation to pick the pool default, and it is preserved all the
   way to transport. It never enters the account pool.
3. For `opencode-go`, a directly connected provider credential outranks the pool
   default, and the account id is attached when that key is also in the pool so
   observation stays tied to the unified identity.
4. For `opencode`, a populated pool owns ordinary routing. This is what keeps
   stale legacy auth state from shadowing a vault-selected account.
5. Only when the pool is empty does provider auth act as a compatibility
   fallback.

## 3. Transport

Zen has no loopback proxy. Routing happens in an `options.fetch` wrapper that the
SDK client is constructed with, so client count stays at one per provider.

`provider.ts` injects the wrapper in the provider loaders:

- The `opencode` custom loader attaches `zenProviderFetch`, and adds
  `apiKey: ZEN_PUBLIC_API_KEY` when no credential is available.
  `snowflake-cortex` is the in-tree precedent for a provider loader supplying
  `options.fetch`.
- The `opencode-go` loader attaches `zenGoProviderFetch`.

The wrapper (`routedZenProviderFetch`):

- parses the request body's `model` field;
- resolves the route as above;
- sets `Authorization: Bearer <selected key>`;
- rewrites the body to the de-qualified base model id, so upstream never sees
  the account suffix;
- on a non-ok response, records status and reset time into the pool;
- reports the account back on the response via `withRoutedAccount`
  (`provider/routing-metadata.ts`), which sets the routed-account header.

Two further transports serve already-committed routes, where selection is
decided and must not be revisited:

- `committedZenProviderFetch(accountID)` reuses the bearer the committed binding
  already injected, refuses a request naming a different explicit `@zen-`
  account, and still de-qualifies the model and observes failures. A committed
  route can never be replaced by the pool default at the physical boundary.
- `committedPublicZenProviderFetch` pins the public sentinel and fails closed if
  a request carries an explicit `@zen-` account, because Public has no account
  to authorize. Public route health is owned by the shared route-health owner,
  so there is deliberately no pool observation here.

## 4. Failure state

`ZenAccountPool.observe(accountId, status, resetAt)` is best-effort,
process-local bookkeeping:

- `402` → `QUOTA_EXHAUSTED` (no reset).
- `429` → `COOLING_DOWN` with the parsed `retry-after` as `resetAt`.
- `2xx` → clears the record.

`state()` promotes a `COOLING_DOWN` account back to `READY` once `now` reaches
`resetAt`, and drops the record. There is no learned cooldown window and no
persistence: a restart clears state, which is acceptable because upstream
re-teaches it within a request.

Observation has two paths, because the fetch wrapper cannot see in-band errors
inside a 200 SSE stream:

- The transport path above sees non-ok responses directly.
- The plugin `event` hook watches `message.updated`, attributes the message to
  the account named by its model suffix, feeds an `APIError` into `observe`, and
  treats a completed error-free message as evidence the account works — but only
  when the pool currently holds that key back, so ordinary updates do not keep
  re-clearing state.

## 5. Surfacing per-key state

- `zenLimitSnapshot(now)` returns the pool snapshot: `{ accountId, label, source,
  isDefault, state, resetAt }` per account.
- The `opencodeZen` quota adapter turns that into one `zenAccounts` row per key
  via `zenKeyLimitsRows`, carrying `keyId`, `label`, mapped state, `exhausted`,
  `isDefault`, `resetAt` / `resetAfterSeconds`, and the free-tier estimate.
- The panel's `WindowRow` renders any row carrying `resetAt` /
  `resetAfterSeconds`, so countdowns and `ResetCell` need no special casing.
- `zenQuotaAccounts()` returns pool ids and wire keys for quota adapters that
  must read a per-key upstream usage gate. The provider loaders call
  `syncZenAccountPool()` before reading it, so env and vault keys are both
  present when they decide whether the Zen providers are configured.

**Free-tier nuance worth keeping:** the free limiter is IP-scoped, so the daily
free-tier estimate is computed once and shared across keys. Per-key
differentiation comes only from the in-memory 402/429 observation. The shared
`daily <source>` window keeps its single `zenUtcDayEnd(fetchedAt)` reset; Zen
does not mint one quota window per key.

## 6. Hosted model catalog discovery

The models.dev catalog is the source of truth, with a live fallback:

- `zenHostedCatalog()` fetches `https://opencode.ai/zen/v1/models` and returns
  explicit freshness semantics — `fresh`, `stale`, `expired`, `unavailable`.
  Fresh data returns directly; bounded-stale data stays usable while one
  background refresh runs; expired data gets one synchronous attempt and stays
  observably expired; unavailable data yields an empty set.
- The catalog is cached in memory and persisted to `zen-public-models.json` in
  the cache directory, written `0o600` via a temp file plus rename, versioned,
  and rejected when implausible (bad timestamp, empty or oversized list, invalid
  ids). Discovery is disabled in tests unless a test fetch or cache file is set.
- `discoverZenSystemOneModel` synthesizes the documented zero-cost System One
  model only for the exact free id `jev-1.13-free`, and only while the live
  `/models` surface advertises it. Go is not synthesized, and paid Jev stays
  catalog-owned so local billing metadata cannot drift.
- When the user has no credential, the `opencode` loader prunes catalog models,
  keeping only models that are both advertised by the hosted catalog and already
  trusted as zero-cost.

## Open questions still open

1. **What does a paid Zen key return on exhaustion?** The in-repo evidence is
   free-tier only. Error-body discrimination over `FreeUsageLimitError` and a
   `402` handler are the observed shapes; paid-key credit exhaustion is
   unverified and must be observed at runtime, not assumed.
2. **Does a paid key ever have model-level restrictions?** No in-tree evidence.
   If gating appears, the WorkBuddy `canAdmitModel` shape is the precedent — but
   that would be new Zen code, not something Zen already does.
3. **Should failure state drive routing?** Today it is display-only and
   process-local; nothing consumes `COOLING_DOWN` to steer selection.
4. **Session affinity for Zen?** Deliberately absent — the model suffix is the
   intent channel. If per-session stickiness is ever wanted, WorkBuddy's
   `AccountRouter` is the in-tree precedent, and adopting it is a real behavior
   change rather than a wiring fix.

## Test conventions and seams

Tests live under `packages/opencode/test/**` and run with `bun test` from
`packages/opencode`, never repo root. Zen coverage includes
`test/plugin/zen-verify.test.ts`, `test/plugin/zen-smoke.test.ts`,
`test/plugin/zen-selector.test.ts`, `test/quota/opencode-zen.test.ts`, and
`test/usage/zen-free.test.ts`.

Zen exposes explicit test-only seams, following the isolation approach of the
WorkBuddy governor's `setEntitlementFile`:

- `setTestZenFetch` — replace the base fetch; `undefined` restores the real one.
- `setTestZenCatalogCacheFile` — redirect hosted-catalog cache I/O.
- `setTestZenVaultCredentials` — pin the vault credential list, bypassing SQLite.
- `resetZenPoolForTest` — replace the pool with a fresh instance.
