# T7 — Frontend Dedicated System Hook (`useLimits`)

**Goal:** One hook owns all quota fetching, merging (quota + Go detail + OpenRouter free), filtering, sorting, and shared refresh policy. Pane becomes a pure projection.

## Why a Dedicated System

- Today `LimitsPanelContent` does `Promise.all(quota.get)` inline, plus separate `now` tick, plus `focus` listener, plus sort/filter — duplicated from `DialogCredentialSwitcherV2`/`UsageBreakdownV2`.
- `useForkUsage` already handles Go heartbeat (60s), SSE `session.status→idle` 3s debounce, visibility pause, and `trackPending`.
- `useOpenRouterFreeUsage` already has 30s poll + visibility debounce + stale flag.
- Without a hook, adding a fourth provider duplicates cooldown, sorting, worstRemaining math again.

## Files

- NEW `packages/app/src/hooks/use-limits.ts` (or `hooks/use-limits/{index,types,merge}.ts`)
- NEW `packages/app/src/utils/limits-format.ts` (if not done in T1) — `toneForRemaining`, `colorForTone`, `formatPercent`, `formatCountdown`, `formatResetDate`, `displayWindowLabel`, `sortWindows`, `worstRemainingFor`.
- EDIT `packages/app/src/pages/session/limits-panel.tsx` → delete inline fetch/sort, import `useLimits` + `useNow`.

## Hook Contract

```ts
export interface LimitsHook {
  providers: LimitProvider[]           // filtered configured=true, sorted
  goByCredential: ForkCredentialUsage[]// from useForkUsage
  openRouterFree?: FreeUsageReport
  isLoading: boolean
  error: unknown
  refresh(): void                      // respects 30s cooldown
  isCoolingDown: boolean
  cooldownRemainingMs: number
}

export interface LimitProvider extends ProviderResult {
  windowsSorted: [string, UsageWindow][]
  worstRemaining: number | null
  tone: "danger"|"warning"|"success"|"muted"
}

export function useLimits(): LimitsHook
```

## Internal Steps

1. **Quota layer**
   ```ts
   const [providersRes] = createResource(tick, () => sdk.client.quota.providers({throwOnError:true}))
   const [quotasRes] = createResource(() => providersRes()?.providers, ps =>
     Promise.all(ps.map(p=>sdk.client.quota.get({providerID:p.providerId},{throwOnError:false})
       .then(r=>r.data as ProviderResult).catch(e=>fallbackEnvelope(p,e)))) )
   ```
2. **Go layer** `const go = useForkUsage()` — read `go.usage.latest?.byCredential`
3. **Free layer** `const free = useOpenRouterFreeUsage({enabled: isConfigured(openrouter)})`
4. **Merge** `createMemo`:
   - `raw = quotasRes() ?? []`
   - `filtered = raw.filter(r=>r.configured)`  // THE hide-not-connected rule, single place
   - enrich each with `windowsSorted = sortWindows(Object.entries(r.usage?.windows??{}))`, `worstRemaining = min(remaining)`, `tone`
   - sort providers: `configured desc → ok desc → name localeCompare` (deterministic)
5. **Refresh**
   - `const [tick, setTick]=createSignal(0)`, `lastRefreshedAt` signal tied to `useNow()`.
   - `COOLDOWN_MS=30_000` (same as key-switcher). `refresh=()=>{if(isCoolingDown||isLoading) return; setLastRefreshedAt(now()); setTick(v=>v+1)}`
   - `visibilitychange` + `focus` → debounce 200ms → `refresh()`
   - `serverSDK.event.listen("session.status")` idle → `setTimeout(refetchQuotas, 3s)` (mirror `fork-usage.tsx`)
   - `onCleanup` removes listeners.
6. **Expose** `isLoading = providersRes.loading||quotasRes.loading`, `error = providersRes.error ?? quotasRes.error`.

## Acceptance

- [ ] All limits data flows through `useLimits` — `limits-panel.tsx` has no direct `sdk.client.quota` calls left (search grep shows zero).
- [ ] `configured:false` providers never reach `providers` array (unit test `use-limits/filter.test.ts` with mixed configured).
- [ ] Cooldown mirrors key-switcher: clicking refresh twice within 30s shows `Xs` countdown, second click ignored.
- [ ] `worstRemaining` and `windowsSorted` are computed once in hook, not per-card.
- [ ] Hook has story/test with mock `sdk` and mock `ForkUsage` + `FreeUsage` providers (no network).
