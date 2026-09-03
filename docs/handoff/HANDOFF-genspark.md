# Genspark provider — credits, catalog, auth

## Pack pricing (observed 2026-09-01)
- Pack: **$20 / 7500 credits = 375 credits per dollar**, valid 3 months, packs stack.
- Probe `GET https://www.genspark.ai/api/tool_cli/me` with `X-Api-Key: gsk-...` + `X-GSK-CLI-Caps: cli-groups-v2,cli-paths-v3,cli-actions-v4` + `X-GSK-CLI-Version: 1.7.1` returned `credit_balance: 10270.85` (user had >1 pack), `plan: plus`, `email: thedabcorner@gmail.com`.
- One real session `ses_fa420c096ffedHcSjgzWc59E30` (`deep-seek-v4-flash` on `genspark`, 53,044 tokens: 53,009 in + 11 out + 24 reasoning, file `Downloads/new-session---2026-09-01t07-29-12-553z.json.br:1`) burned **12 credits** → `12/53.044 ≈ 226 credits/M` ≈ `226/375 ≈ $0.603/M`. This matches a $0.60/M flash tier and validates the 375× conversion.

## Catalog
- Source is `GET {host}/api/tool_cli/opencode-config` (`@genspark/cli` `client.js:getOpencodeConfig`, `index.js:1937` `gsk init-opencode`). Same payload the CLI writes to `opencode.json` provider `genspark-llm-proxy`.
- Authenticated, **not a completion** — no credits. We call it directly (no `gsk` spawn, no file write).
- Cache: `Global.Path.cache/genspark-catalog-{hostHash}.json`, 24h TTL keyed on `host()` (`GENSPARK_BASE_URL`/`GSK_BASE_URL` override, default `https://www.genspark.ai`), `Flock` for cross-process safety — mirrors CLI `config.js:232`.
- Static `MODEL_METADATA` (30 models) is fallback only (no key, offline, fetch failure).
- `discoverModels` is add-only (`if (!models[id])`) so it cannot replace/remove — live catalog is applied by **replacement** in `provider.ts:genspark` custom loader, not via that hook.

## Auth
- Mirrors `gsk login` device-code: `POST /api/cli_auth/device_code` → `auth_url` → poll `GET /api/cli_auth/token?code=` until `approved` + `api_key`. `unauthenticatedRequest` sends only `Content-Type` (no caps), matching CLI.
- Stored as `X-Api-Key: gsk-...` (same key the LLM proxy `https://www.genspark.ai/api/llm_proxy/v1` uses via `Authorization: Bearer` in `@ai-sdk/openai-compatible`).
- Quota and LLM proxy share the same key; provider is always visible (`autoload:true` even without key) so the picker shows models before auth, with fallback catalog.
- Legacy compat: if `auth/env/gsk-file` is empty, falls back to `.opencode.json` `provider.genspark-llm-proxy.options.apiKey` so existing `gsk init-opencode` configs keep working.

## Quota (limits panel)
- Adapter `src/quota/providers/genspark.ts` hits `GET /api/tool_cli/me` with `X-Api-Key` + caps/version, parses `credit_balance` and `plan`, returns one window `credits: "10,270.85 credits"` + `planLabel` (e.g. `Plus`). No windows/percent — credits are a balance, not a time window.
- Limits panel renders it generically via `ProviderGroup` (same path as `deepseek` `credits_balance`).

## Picker (dialog + tooltip)
- `7500/20 = 375` is the single source of truth (`useGensparkUsage.ts:4`).
- Credits/M = $/M * 375. `$` comes from `hasPublishedPricing(item.cost)` or borrowed sibling via `pricingFallbackForDisplay` (same map the cheapness sorter uses); when absent we fall back to `$0.60/M` → `225 credits/M` so `deep-seek-v4-flash` never shows `—` (observed 226/M anchors this).
- `useGensparkUsage` parses `remainingCredits` from the quota `valueLabel`, estimates `creditsPerRequest ≈ credits/M * 1k/1M`, then `estimatedRequests = remaining / creditsPerRequest`. `ModelStretchBar` length is log-normalized against the max across visible models, same as `workbuddy`.
- `dialog-select-model.tsx:price()` and `model-tooltip.tsx:ModelTooltipCostTable` branch on `provider.id === "genspark"` to show `credits/M` via `formatCreditsPerMillion` instead of `formatCostPerMillion`, and suppress the `Free` tag (cost 0 would otherwise look free).
