# Limits / Quota — Architecture

## 1. Guiding Principles

- **Observability, not enforcement.** Quota is advisory display state. A stale or failed read never blocks inference (`ok:false` envelope, never HTTP 5xx).
- **OpenCode `auth.json` is the primary substrate.** For `codex/openai`, `openrouter`, `kimi`, `deepseek`, `xai`, `zai`, `opencode-go` we read the key the user already gave OpenCode (`type: api | oauth | wellknown` → `key = api.key | oauth.access | wellknown.token`). No duplicate login.
- **Credential ownership is split.** Some credentials are `host` (OpenCode-owned, mutable, refreshable), some `external-readonly` (Claude Code Keychain/`~/.claude/.credentials.json` — never mutate/refresh lest we sign the external client out), some `application-managed` (future). Refresh policy depends on ownership.
- **Normalize at the edge.** Heterogeneous provider semantics (percent used vs percent remaining vs balance vs spend, seconds vs ISO dates, rolling vs fixed windows) become one `UsageWindow`/`ProviderResult` before any UI sees them. UI is a dumb `GenericUsageCard`.
- **Coalesce aggressively.** Same-provider concurrent reads collapse to one fetch (`registry.createSingleFlight` + provider-level `pendingFetch` for Claude/xAI). Cross-provider reads run in parallel (`Promise.all`).
- **DRY with key-switcher.** The Go per-credential calculator (`fork/usage-cache.ts` + `ForkClient.usage()` + `useForkUsage` heartbeat/SSE/cooldown) is the Go source of truth. Limits pane reuses that hook, not a second calculator.

## 2. System Context

```
┌── Frontend ──────────────────────────────┐
│  useLimits()                             │
│   ├─ useQuota()  ─┐                      │
│   ├─ useForkUsage()├── merge ─┐          │
│   └─ useOpenRouterFreeUsage()─┘        │
│           │                             │
│   filtered + sorted + worstRemaining    │
│           │                             │
│   ProviderCard / WindowRow / BillingCard│  ← premium dense zinc, depletion anxiety, live countdown
└───────────┼──────────────────────────────┘
            │ sdk.client.quota.* / ForkClient / experimental.openrouterFreeUsage
            ▼
┌── Backend ───────────────────────────────┐
│  GET /quota/providers (configured only)  │
│  GET /quota/:providerId  → Adapter.fetch() → ProviderResult
│     registry.resolveAdapter(id|alias)
│     singleFlight(providerId, fetch)
│        ├─ opencode-go  → officialUsageCache (L1) + local fallback (L2)
│        ├─ claude       → loadClaudeCredential() → GET https://api.anthropic.com/api/oauth/usage + toClaudeUsage()
│        ├─ codex        → GET https://chatgpt.com/backend-api/wham/usage (Bearer+AccountId)
│        ├─ xai          → POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig (gRPC-web+protobuf) + JWT refresh coalesce
│        ├─ openrouter   → GET https://openrouter.ai/api/v1/credits
│        ├─ kimi         → GET https://api.kimi.com/coding/v1/usages (used vs remaining dual path)
│        └─ deepseek etc.
└─────────────────────────────────────────┘
```

### Two Data Planes — Never Mix

```
Account Quota Plane          Session Telemetry Plane
─────────────────            ───────────────────────
provider-side entitlement    conversation consumption
→ quota/providers/*.ts       → message.info.tokens/cost + context limits
→ ProviderResult             → SessionContextTab / SessionContextMetrics
→ Limits pane                → Context pane
```

Keep them separate in types, stores, and UI. “40% of 5h window used” ≠ “40% of context filled”.

## 3. Provider Registry — Static, Declarative, Dynamic-Ready

OpenChamber’s registry is static (`claude`, `codex`, `cursor`, `kimi`, `openrouter`, `xai`, `opencode-go`, …) because quota needs a dedicated parser even if OpenCode knows the model. We keep that for now:

```ts
// packages/opencode/src/quota/quota.ts
adapters: readonly Adapter[] = [
  opencodeGo(auth, credentials, usageCache),
  claude(http, auth),     // NEW
  codex(http, auth),      // NEW
  xai(http, auth),        // NEW (with token refresh)
  openRouter(http, auth), // existing, enhanced label
  kimi(http, auth),
  deepseek(http, auth),
]
```

Future dynamic path (UsageTray-inspired): allow `ProviderManifest {id,name,aliases,permissions:{network:[...],files:[...]}, quota:{endpoint, authKind, metricKind}}` and generate an adapter at runtime. Not required for T2-T4, but the `Adapter` interface (`id/aliases/configured/fetch`) already isolates that step — adding a manifest loader later is additive.

## 4. Normalized Model

### UsageWindow (single UI atom)

```ts
type UsageWindow = {
  usedPercent: number | null        // 0..100, null for balance-only
  remainingPercent: number | null   // 100-usedPercent, null for balance-only
  windowSeconds: number | null      // for sorting (5h=18000, 7d=604800)
  resetAt: number | null            // epoch ms (absolute)
  resetAfterSeconds: number | null  // derived from resetAt for countdown
  valueLabel: string | null         // "$9.85 left · $0.15 spent" / "$18.93 of $19.99 remaining" / "Unlimited"
}
```

`toUsageWindow({usedPercent, windowSeconds, resetAt, valueLabel})` is the sole constructor — it clamps 0..100, computes `remainingPercent`, and derives `resetAfterSeconds` from `resetAt`.

`valueLabel`-only windows (`usedPercent===null`) are first-class — do not invent fake percents for balance providers.

### ProviderResult (store boundary)

```ts
type ProviderResult = {
  providerId, providerName, ok, configured,
  usage: { windows: Record<string,UsageWindow>, models?: Record<string,{windows:Record<string,UsageWindow>}> } | null,
  planLabel?: string | null,
  error?: string,
  fetchedAt: number
}
```

`ok:false` + `configured:true` = transient provider error (rendered as card with message). `ok:false` + `configured:false` = filtered out by frontend.

### Metric Kinds (internal, before projection)

Internally distinguish `utilization` (percent+reset), `balance` (valueLabel), `spend` (spend_control), `rate-limit`. All project to `UsageWindow` at `buildResult` time — UI only sees `UsageWindow`.

## 5. Credential Resolution (OpenCode-first)

```
auth.json (Api | Oauth | WellKnown)
   ↓  aliases e.g. ["codex","openai","chatgpt"]  or ["claude","anthropic"]
authKey(auth, aliases) → {id,key} | undefined
   ↓  Oauth: key = access
```

- **Codex:** needs `access` + optional `accountId` (from JWT `chatgpt_account_id`). AccountId is sent as `ChatGPT-Account-Id` header when present (same as codex plugin).
- **Claude:** external-readonly priority: Keychain → `~/.claude/.credentials.json` → `auth.json` → `CLAUDE_CODE_OAUTH_TOKEN`. Port `loadClaudeCredential()` (hash fingerprint `sha256(access\0refresh)` for cache key). Never call refresh here — reread each request.
- **xAI:** `auth.xai` OAuth (`access`, `refresh`, `expires`). Refresh is allowed because ownership is `host` (OpenCode owns the token). Coalesce via module `refreshPromise` + `REFRESH_SKEW_MS=120s` + JWT `exp` check (same as `plugin/xai.ts`).

## 6. Caching / Coalescing / Refresh

- **Same-provider coalesce:** `registry.createSingleFlight()` (quota) + per-provider `pendingFetch`/`refreshPromise` (Claude 429 cooldown, xAI token refresh). Callers `Promise.all([codex,claude,codex])` → one actual Codex fetch.
- **Cross-provider parallelism:** Frontend `Promise.all(quotas.map(get))` + backend `Effect.forEach(adapters, configured(), {concurrency:"unbounded"})`.
- **Stale-while-rate-limited (Claude):** On 429, store `cooldownUntil=Date.now()+retry-after(5m default, 60m max)`, return `cachedUsage` per credential fingerprint if available → `stale`.
- **Polling (frontend):** Shared hook, not per-card. `first mount → start interval (3m) + visibility raf → fetch selected providers`; last consumer unmount → clear. Already exists in `useForkUsage` (60s heartbeat + `session.status→idle` SSE 3s debounce). `useLimits` reuses that heartbeat and `useNow()` (global wall-clock second ticker) for countdowns — zero extra timers per card.
- **No per-render fetch.** Presentation flip `used↔remaining` reads `remainingPercent` already in the window — no refetch.

## 7. Go — First-Class Source

**Source:** `GET https://opencode.ai/zen/go/v1/usage` `Authorization: Bearer <key>` (official, remote-authoritative). Fallback: `fork/usage-cache` local aggregation (`buildLocalWindows`/`buildAggregateWindows`) which sums `providerID=opencode-go, role=assistant, cost` buckets vs limits `$12/5h $30/week $60/month`.

**Reuse:** `officialUsageCache` is module-global (not layer-scoped) per `usage-cache.ts` doc — preserves 5-min gate even with multiple directories/windows. `ForkClient.usage()` already exposes `aggregate + byCredential[]`. `useLimits` will consume `useForkUsage().usage()` for per-credential detail instead of re-deriving from quota’s single-credential aggregate.

**Display:** Limits pane renders:
- Aggregate card `OpenCode Go — All keys` (quota aggregate or `byCredential` aggregate)
- + per-credential subcards `OpenCode Go — <label>` (from `byCredential[]`) when `byCredential.length>1` or when any credential has distinct windows. Collapsed initially, expandable (mirrors key-switcher `UsageBreakdownV2`).

**Failure:** official 5xx → serve `stale` snapshot if available, keep `fetchedAt` age; local windows stay valid.

## 8. OpenRouter — Two Metrics, One Card

- **Credits:** `GET /api/v1/credits` → `total_credits/total_usage` → `valueLabel="$X left · $Y spent"` (ported). This is the pane’s primary OpenRouter card.
- **Free:** `FreeUsageReport` from `OpenRouterFreeUsageTracker` via `experimental.openrouterFreeUsage.get` (or direct `GET /api/v1/key` + optional `/credits`). Free report already has `remaining/limit/usedPercent/window/resetsAt/rate/projection/models`. `useLimits` merges it as additive windows under the same provider card (or as a second synthetic provider `openrouter-free` if visual separation is clearer). Premium UX shows both stacked: balance row + free progress+countdown+table.

## 9. Frontend — Dedicated System Hook

```
// packages/app/src/hooks/use-limits.ts  (new, the system)
export function useLimits() {
  const quota = useQuota()               // thin over sdk.client.quota.*
  const go = useForkUsage()              // already global singleton
  const free = useOpenRouterFreeUsage()  // already
  const now = useNow()                   // countdown
  // merge, filter (!configured → drop), sort, compute worstRemaining, tone
  // expose { providers, goByCredential, isLoading, error, refresh, cooldown }
}
```

- **Filtering:** `providers.filter(p=>p.configured)` — single place. `LimitsPanelContent` never sees `Not configured`.
- **Sorting:** configured→ok→name; windows sorted by `windowSeconds asc → key`.
- **Tone:** `worstRemaining = min(windows.*.remainingPercent)` → `maxUsed = 100-worstRemaining` — most exhausted window wins (same as OpenChamber sidebar risk).
- **DRY helpers:** import `toneForRemaining/colorFor`, `formatCountdown`, `formatResetDate`, `displayWindowLabel`, `sortWindows` from `utils/limits-format.ts` (also imported by key-switcher/usage-gauge).

## 10. Presentation Contract

`ProviderCard` receives `ProviderResult` (never raw). It knows nothing about `fetch`/`OAuth`/`gRPC-web`. It only needs `percent/valueLabel/resetAt/windowSeconds`. This *anti-corruption* boundary is why adding a provider never touches UI.

## 11. Failure Isolation

- Provider `fetch` throws → caught → `buildResult({ok:false, error: message})` envelope. HTTP stays 200 (quota routes never 5xx).
- `providers()` catches per-adapter `configured()` throws, treats as `false`.
- Optional enrichments (Cursor plan/credits, OpenRouter free, Go model-scoped windows) fail independently from core windows.

---

## References

- `openchamber/openchamber:packages/web/server/lib/quota/**` — provider registry, `toUsageWindow`/`buildResult`, `loadClaudeCredential`, `toClaudeUsage`, codex/xai parsers.
- `Rana-Faraz/usage-tray-windows:plugins/*/plugin.js` — local credential discovery + host `ctx` capabilities + strategy-based acquisition.
- Existing: `../../../packages/opencode/src/quota/format.ts`, `registry.ts`, `fork/usage-cache.ts`, `fork-usage.tsx`.
