# T6 — OpenCode Go: All Keys (first-class usage API source)

**Goal:** Limits pane shows **every** Go API key, not just the active one, using the same authoritative source the key-switcher uses (`GET https://opencode.ai/zen/go/v1/usage` via `officialUsageCache`) with fallback to local aggregation.

## Principle (from plan)

> The first-class source for Go is the usage API route from OpenCode itself. We can fallback to our own decimals very similar to how we handle it in the key switcher.

## Current

- `providers/opencode-go.ts` `fetch()` branches:
  ```ts
  active = yield* credentials.active(); if(active) return snapshotToResult(get(active.id,active.key))
  else { resolved = yield* authKey(auth, ALIASES); return get(`auth:${resolved.id}`, resolved.key) }
  ```
  → only one credential ever queried.

- Frontend `ForkClient.usage()` already returns `{aggregate: ForkWindowUsage[], byCredential: ForkCredentialUsage[]}` where each `ForkCredentialUsage.windows` contains `spentUSD/limitUSD/estimatedPercent/resetsAt/clearsAt/callsInWindow/source`. This is computed from `usage-cache.ts` L1 (official) + L2 (local) exactly as described above, with 5-min gate per credential.

## Decision (reuse, don’t duplicate)

Do **not** re-implement per-credential fetching in `quota/providers/opencode-go.ts`. Instead, expose detail via the existing `/fork/usage` path and have `useLimits` merge it.

Alternatives rejected:
- Making `quota/providers/opencode-go.ts` iterate all credentials → duplicates `usage-cache` logic and loses L2 local math.
- Adding new `/quota/opencode-go/credentials` → new API surface for something `/fork/usage` already does.

## Files

- EDIT `../../../../packages/opencode/src/quota/providers/opencode-go.ts` — keep aggregate behavior but add comment/optional additive `models?:...` or `byCredential` note; no logic change (still aggregate).
- EDIT `../../../../packages/app/src/hooks/use-limits/index.ts` — consume `useForkUsage()`:
  ```ts
  const go = useForkUsage()
  const goByCredential = () => go.usage.latest?.byCredential ?? []
  const goAggregate = () => go.usage.latest?.aggregate ?? []
  ```
- EDIT `../../../../packages/app/src/pages/session/limits-panel.tsx` (or new `components/limits/GoCards.tsx`) — render:
  - `OpenCode Go — All keys` aggregate card (from `quotas` aggregate OR `goAggregate` if quota stale)
  - + for each `byCredential` where `windows.length>0` a subcard `OpenCode Go — <label>` (label from `ForkCredentialInfo.label` matched by `credentialID`)

## Mapping `ForkWindowUsage → UsageWindow`

```ts
toUsageWindow({
  usedPercent: w.estimatedPercent ?? (w.limitUSD>0 ? (w.spentUSD/w.limitUSD)*100 : null),
  windowSeconds: w.label==="5h"?18000: w.label==="week"?604800: w.label==="month"?2592000:null,
  resetAt: w.resetsAt,
  valueLabel: null,
})
```

Keep `windowSeconds` for sorting, `resetAt` for countdown, `usedPercent` for depletion bar. Display `w.callsInWindow` under title (like `UsageBreakdownV2` shows `29 calls`) and `source` badge (`api` fresh vs `local` vs `cached`).

## Steps

1. Add `useForkUsage` import to `useLimits`. Ensure hook is already provided by `ForkUsageProvider` (root `App.tsx` already does). Guard for SSR/before provider.
2. Add helper `forkWindowToUsageWindow(w: ForkWindowUsage): UsageWindow`.
3. In `use-limits` return, expose `goByCredential` sorted by `worstRemaining asc`.
4. In Limits panel, after filtering quotas, replace single Go card rendering with:
   ```
   if(providerId==="opencode-go" && goByCredential().length>1) {
     render AggregateCard
     For each credential → render GoCredentialCard (same WindowRow component)
   } else render normal ProviderCard
   ```
   When `byCredential.length<=1`, keep single card to avoid noise.
5. Keep `quota`’s aggregate as fallback when `fork/usage` fetch fails (use `quotas` value). Log but don’t crash.

## Acceptance

- [ ] With 3 Go API keys added via key-switcher, pane shows `OpenCode Go — All keys` + 3 subcards `OpenCode Go — Personal / Work / …` each with 5h/week/month rows and `xx calls` subtitle (matches key-switcher `UsageBreakdownV2` numbers, within rounding).
- [ ] When only one key, pane shows exactly one Go card (no empty subcards).
- [ ] Official snapshot `percent/resetsAt` is used when available; when official fetch is pending/stale, pane shows `source: local` values via `estimatedPercent` (fallback) without extra network call.
- [ ] Hiding `configured:false` still holds: if no Go key configured, Go section absent entirely.
- [ ] No second implementation of `buildLocalWindows` in pane — all math stays in `usage-cache.ts`.
