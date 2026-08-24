# T4 — xAI Provider (gRPC-Web + protobuf, port openchamber/xai.js)

**Goal:** Add `xai` (`billing_cycle` window, JWT-aware refresh, single-flight) faithful to upstream’s gRPC-Web parser and token lifecycle.

## Upstream Reference

- `openchamber:packages/web/server/lib/quota/providers/xai.js` (348 lines)
- `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` body `Uint8Array([0,0,0,0,0])` headers `Authorization: Bearer`, `Origin: https://grok.com`, `Content-Type: application/grpc-web+proto`
- Parses `gRPC-Web framing → protobuf wire → fixed32 percent [1]|[1,1] + varint resetAt [1,5,1]`
- Refresh via `POST https://auth.x.ai/oauth2/token` `client_id=b1a00492-073a-47ea-816f-4c329264a828` grant `refresh_token`; skew 120s; coalesced `refreshPromise`; writes back to `auth.json`.

## Files

- NEW `../../../../packages/opencode/src/quota/providers/xai.ts`
- EDIT `quota.ts` (add xai)
- NEW `packages/opencode/test/quota/providers.xai.test.ts` (+ binary fixture `xai-grpc-web.bin`)

## Steps

1. **Auth helpers** — port `readXaiAuth()`, `decodeJwtClaims()`, `tokenNeedsRefresh(entry)`, `refreshXaiOauth(entry)` (fetch token URL, `Effect` wrapper, single-flight `refreshPromise`, write back via `Auth.set("xai", refreshed)` — injectable `fetch` for tests).
2. **Ensure fresh access** — `ensureFreshAccess(entry)` checks stored `expires` + JWT `exp` vs `REFRESH_SKEW_MS` (120s). If needs refresh and no `refresh` → throw; else `refreshXaiOauth`.
3. **gRPC helpers** — port `readVarint`, `scanProtobuf` (wire type 0=varint,1=fixed64,2=length-delimited,5=fixed32), `parseFrames`, `parseGrpcTrailerStatus`, `looksLikeProtobuf`, `parseUsage` — keep same depth limit (4), field paths `USAGE_PERCENT_PATHS=[[1],[1,1]]`, reset candidate `[1,5,1]`. Convert helpers to TS with `Uint8Array`/`DataView`. Keep `EMPTY_GRPC_WEB_BODY`.
4. **fetchUsage(token)** — `POST USAGE_URL` with headers above, `AbortSignal.timeout(15000)`, check `grpc-status` header and trailer statuses, then `parseUsage(new Uint8Array(await response.arrayBuffer()))`. Throw on empty/malformed with same messages as upstream (for test pins).
5. **fetchQuota** — `readXaiAuth` → `ensureFreshAccess` → `fetchUsage(access)` → `buildResult({windows:{billing_cycle: toUsageWindow({usedPercent, resetAt})}})`; catch → `ok:false, configured:true, error`.
6. Register `id:"xai" name:"xAI" aliases:["xai"]`.

## Acceptance

- [ ] Takes existing `auth.json` `xai: {type:"oauth", access, refresh, expires}` (already present in local `~/.config/opencode/auth.json`) — no extra config.
- [ ] Binary fixture `xai-grpc-web.bin` (from upstream `xai.test.js`) yields `usedPercent=45, resetAt≈Fri, Aug 28 07:57` (per screenshot).
- [ ] Expired JWT triggers single `POST .../oauth2/token` before usage fetch (coalesced; second concurrent call reuses same promise).
- [ ] Malformed protobuf surfaces `ok:false` with message, not crash.
- [ ] Frontend shows single `Billing Cycle` card with `45%` + countdown + `45% remaining` depletion bar.

## Risks

- Protobuf field numbers are fragile → pin via binary fixture, never heuristically guess (keep upstream’s exact scan logic).
- OpenChamber writes back refreshed `auth.json` using `readAuthFile/writeAuthFile` (file-level). Here we must use `Auth.set` via `ForkCredentials`/`Auth` service — ensure `refresh` persists across SDK restarts.
