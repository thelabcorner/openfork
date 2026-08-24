# T3 — Codex / ChatGPT Provider (port openchamber/codex.js)

**Goal:** Add `codex` (`aliases openai, codex, chatgpt`) showing Codex’s primary/secondary rate windows + `credits_balance` + `credits` (spend_control), resetting via chatgpt.com.

## Upstream Reference

- `openchamber:packages/web/server/lib/quota/providers/codex.js`
- `GET https://chatgpt.com/backend-api/wham/usage` `Authorization: Bearer <access>` `ChatGPT-Account-Id: <accountId>` (from JWT `chatgpt_account_id`)

## Files

- NEW `../../../../packages/opencode/src/quota/providers/codex.ts`
- EDIT `quota.ts` registry entry
- NEW `packages/opencode/test/quota/providers.codex.test.ts`

## Steps

1. `isConfigured()` → `normalizeAuthEntry(getAuthEntry(auth, ["openai","codex","chatgpt"]))?.access|token` non-empty.
2. `fetchQuota()`:
   - resolve `entry = normalizeAuthEntry(getAuthEntry(...))`; if no token → `buildResult({ok:false,configured:false, error:"Not configured"})`.
   - `headers={Authorization:"Bearer "+access, "Content-Type":"application/json", ...(accountId?{"ChatGPT-Account-Id":accountId}:{})}`
   - `fetchJson(http, "https://chatgpt.com/backend-api/wham/usage", access)` is not usable (needs custom headers) — instead use `HttpClient` directly (like xai) or extend `fetchJson` to accept `accountId` header. Simplest: use `Effect`+`http.execute` inline (consistent with xai).
   - On `!response.ok` → `ok:false, error: 401?"Session expired — …":"API error: "+status`.
   - Parse: `primary = payload.rate_limit.primary_window`, `secondary = payload.rate_limit.secondary_window`, `credits = payload.credits`, `spend_control = payload.spend_control.individual_limit`.
   - `windows[resolveWindowLabel(limit_window_seconds)] = toUsageWindow({usedPercent: toNumber(used_percent), windowSeconds, resetAt: toTimestamp(reset_at)})`.
   - `credits_balance = toUsageWindow({usedPercent:null, valueLabel: unlimited?"Unlimited":"$"+formatMoney(balance)})`.
   - `credits` (spend) = `toUsageWindow({usedPercent: spend.used_percent, valueLabel: spent+" / "+limit+" used"})` if present.
3. Helper `resolveWindowLabel(seconds)` — `18000→5h`, `604800→7d`, fallback `durationToLabel`.
4. Register `ProviderSummary {providerId:"codex", providerName:"Codex"}`.

## Acceptance

- [ ] Fixture `codex-primary-secondary.json` (primary 5h 61%, reset 2026-08-22T12:00Z, secondary 7d 12%, credits $0) → pane shows three windows + countdowns.
- [ ] `auth.json {openai:{type:"oauth",access:"…",accountId:"…"}}` is recognized (alias openai→codex) and sends AccountId header (assert via captured request).
- [ ] 401 yields re-auth message, not generic status.
- [ ] `business spend_control` fixture adds `credits` window when present.
