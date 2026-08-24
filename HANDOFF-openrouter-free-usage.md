# HANDOFF — openrouter-free-usage 500

## Issue
`GET /experimental/openrouter-free-usage` returned 500 for ANY failure:
- No `OPENROUTER_MANAGEMENT_KEY` / `OPENROUTER_API_KEY` set
- No `openrouter` integration credential configured
- Invalid key (upstream 401 on `/api/v1/credits` or `/api/v1/analytics/query`)
- Network/transport failure

Root cause: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:368-384` mapped all tracker errors to opaque `HttpApiError.InternalServerError({})` and also 500'd when `managementKey` was missing.

## Fix applied
- No key configured → returns degraded `FreeUsageReport` (`limit: 50`, `status: "depleted"`, `stale: true`, `models: []`, note explains why) instead of 500.
- Tracker throws (401, timeout, etc.) → same degraded response, never 500.

## What remains for agent
Determine the CORRECT management key and verify it works:

1. Check environment:
   - `OPENROUTER_MANAGEMENT_KEY` ?
   - `OPENROUTER_API_KEY` ? (fallback)
2. Check integration credentials (stored in `Credential` for `openrouter`):
   - Look at `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts:347-362` (reads `credential.list(openrouter)`).
   - Verify the active entry has a valid `key` or `oauth.access`.
3. If a real key exists but upstream still 401s:
   - The key may be an API key, not a management key (`/api/v1/analytics/query` requires management key).
   - Confirm with OpenRouter docs whether `/api/v1/credits` and `/api/v1/analytics/query` need management key vs standard API key.
4. Verify degraded response renders correctly in `packages/app/src/utils/openrouter-free-usage.ts` and `use-openrouter-free-usage.ts` (negative cache, circuit breaker).

Files edited: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`
No SDK/client regeneration needed (response schema unchanged).
