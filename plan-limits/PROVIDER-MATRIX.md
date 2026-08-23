# Provider Matrix — Limits System

> Each row = one logical provider card in Limits pane. `configured` = `auth.json` alias present.
> Columns: `Auth alias → Credential kind → Endpoint/proto → Normalized windows → Refresh → Brittleness`.

| # | ProviderId (`providerId`) | Aliases (auth.json keys) | Auth file / type | Owner | Protocol | Endpoint | Normalized `windows` keys | Reset | Model-scoped? | Extra |
|---|---------------------------|--------------------------|------------------|-------|----------|----------|---------------------------|-------|---------------|-------|
| 1 | `opencode-go` | `opencode-go`, `opencode` | `Api.key` (Go API key) + ForkCredentials.active | host | REST JSON (official) | `GET https://opencode.ai/zen/go/v1/usage` `Bearer <key>` | `5h` (rolling), `weekly`, `monthly` | `resets_at` ISO | no | **Multi-key:** `ForkClient.usage() → {aggregate, byCredential[]}` used by UI. Cache L1 TTL 5m, single-flight, stale-last-good. Fallback local `buildLocalWindows` from DB. |
| 2 | `claude` | `claude`, `anthropic` | **External-readonly** Keychain → `~/.claude/.credentials.json` → `auth.json` `claude` OAuth → `CLAUDE_CODE_OAUTH_TOKEN` | external | REST JSON (private OAuth) | `GET https://api.anthropic.com/api/oauth/usage` `anthropic-beta: oauth-2025-04-20` | `5h` (kind=session), `7d` (weekly_all), `extra_usage` (spend.enabled), `models: {Model->{7d}}` (weekly_scoped) | `resets_at` ISO / limits array | **yes** (per-model weekly_scoped) | 429 → cooldown 5m default (Retry-After capped 60m) per fingerprint. Cache per `sha256(access\0refresh)`. Never refresh OAuth (reread each call). |
| 3 | `codex` | `codex`, `openai`, `chatgpt` | `Oauth.access` + `accountId` (JWT `chatgpt_account_id`) | host | REST JSON (internal) | `GET https://chatgpt.com/backend-api/wham/usage` `Bearer` + `ChatGPT-Account-Id` | `5h`/`7d` (primary/secondary `limit_window_seconds`→label), `credits_balance` (USD, Unlimited), `credits` (spend_control.individual_limit) | `reset_at` ISO / seconds | no | 401 → “Session expired — please re-authenticate with OpenAI”. Refresh via `auth.openai.com/oauth/token` (token already owned by Codex plugin). |
| 4 | `xai` | `xai` | `Oauth.access+refresh+expires` (JWT `exp`) | host | **gRPC-Web + protobuf** | `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` `application/grpc-web+proto` `Bearer` + refresh coalesce (`refreshPromise`, `REFRESH_SKEW 120s`, `JWT exp` check) | `billing_cycle` (single) | varint `[1,5,1]` candidate or first future epoch-sec | no | Parser: `parseFrames`→gRPC-Web framing→`scanProtobuf` fixed32/varint → `percent [1]|[1,1]` + `resetAt [1,5,1]`. Trailer `grpc-status`. Timeout 15s. Refresh writes back to `auth.json`. |
| 5 | `openrouter` | `openrouter` | `Api.key` | host | REST JSON (public) | `GET https://openrouter.ai/api/v1/credits` | `credits` (`valueLabel="$X left · $Y spent"`, no percents) | none | no | Free plan is **separate** metric (see #5b). Fallback: if `/credits` denied, core `/key` fields still used upstream (not yet in our pane — free path covers it). |
| 5b| `openrouter-free` *(synthetic, merged under openrouter card)* | `openrouter` (same key) + `OPENROUTER_MANAGEMENT_KEY` | `FreeUsageReport` tracker (local DB + `/api/v1/key`) | host | Internal tracker (REST + local) | `OpenRouterFreeUsageTracker.getUsage()` → `remaining/limit/used/window/rate/projection` | `free` window + per-model table | `window.resetsAt` | per-model breakdown | Rendered as additive progress+countdown+model table in same OpenRouter card. |
| 6 | `kimi-for-coding` | `kimi-for-coding`, `kimi` | `Api.key` | host | REST JSON (public) | `GET https://api.kimi.com/coding/v1/usages` | `weekly` (payload `usage {limit,used|remaining,resetTime}`) + `Rate Limit (5h)` / `Rate Limit (Xd)` via `window.duration/timeUnit` | `resetTime` ISO / `detail.resetTime` | no | Handles `used` vs `remaining` dual: `if used → used/total else remaining → 1-remaining/total`. |
| 7 | `deepseek` | `deepseek` | `Api.key` | host | REST JSON (public) | `GET https://api.deepseek.com/user/balance` `Accept-Encoding: identity` | `credits_balance` (`valueLabel="$x.xx"|"¥x.xx"`, no percents) | none | no | Picks USD balance first, else CNY. 401/403 → “Session expired — please re-authenticate with DeepSeek”. |
| — | *future:* `minimax-*`, `zai`, `cursor`, `copilot`, `google` | (registry placeholder) |  |  |  |  |  |  |  | Static registry today; UsageTray manifest model shows dynamic plugin path for later. Not blocking T1-T8. |

### Display Rules

- **Filtered:** `configured===false` → not rendered at all (T7).
- **Failed but configured:** card renders with `ok:false` red block and message (not hidden).
- **Go sub-cards:** when `byCredential.length>1`, render `OpenCode Go — <label>` per credential (from `ForkClient.usage().byCredential`) plus aggregate on top. When single key, only aggregate.
- **OpenRouter:** single card with two stacked sections: top `Credits` valueLabel row, bottom `Free` rich row (progress+countdown+table) when `freeReport` present.

### Test Fixtures Needed (T9)

```
claude-limits-array.json  (session+weekly_all+weekly_scoped)
claude-legacy-five-hour.json
codex-primary-secondary.json
xai-grpc-web.bin  (pre-framed protobuf + trailer)
openrouter-credits.json
opencode-go-official.json
kimi-used-weekly.json / kimi-remaining-5h.json
```

Each fixture covers: happy, missing fields, wrong types, 401, 429, malformed JSON/protobuf, redirect→login.

