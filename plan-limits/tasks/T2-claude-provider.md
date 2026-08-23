# T2 — Claude Provider (port openchamber/claude)

**Goal:** Add `claude` to `quota.ts` registry so connected Claude users see `5h (session) · 7d (weekly_all) · extra_usage` + model-scoped weekly windows, with 429 stale-while-rate-limited.

## Upstream Reference

- `openchamber:packages/web/server/lib/quota/providers/claude/index.js`
- `openchamber:claude/transforms.js` + `claude/auth.js`
- Endpoint `GET https://api.anthropic.com/api/oauth/usage` `anthropic-beta: oauth-2025-04-20` `Authorization: Bearer <access>`
- Cache `cachedUsage {fingerprint, usage, planLabel}` + `cooldownUntil` (retry-after capped 60m, default 5m), single-flight `pendingFetch`.

## Context

- Claude credential is **external-readonly** (Keychain → `~/.claude/.credentials.json` → `auth.json` `claude|anthropic` → `CLAUDE_CODE_OAUTH_TOKEN`). Our port will lean on `auth.json` path first (like `codex`) to avoid host keychain access; add Keychain/`~/.claude` readers only if `auth.json` alias yields nothing (keep behavior but not required for T2 acceptance).
- Payload prefers `limits[]` array (kind `session`→5h, `weekly_all`→7d, `weekly_scoped`→model). Legacy `five_hour`/`seven_day` fallback if array missing. `extra_usage` only when `spend.enabled===true`. `models` derived from scoped entries.

## Files

- NEW `packages/opencode/src/quota/providers/claude.ts` (or `providers/claude/index.ts` + `providers/claude/transforms.ts`)
- EDIT `packages/opencode/src/quota/quota.ts` → add `claude(http,auth)` to `adapters[]`
- NEW `packages/opencode/test/quota/providers.claude.test.ts` (fixture-based, no live API)

## Steps

1. Implement `loadClaudeCredential()` — try `authKey(auth,["claude","anthropic"])`; if absent, return `undefined` (defer keychain/file readers to later follow-up, not blocking pane).
2. Implement fingerprint `sha256(access\0refresh)`, cooldown helper `cooldownFromHeader(retry-after)`, `cachedResultFor()`.
3. Implement `fetchQuotaUncoalesced()` exactly as upstream retry logic: fingerprint mismatch → reset cache; `Date.now()<cooldownUntil` → return cached or `Rate limited` error; `fetch(USAGE_URL)` with `Authorization`+`anthropic-beta`; 429→ set cooldown + return cached; 401/403→ `Claude session expired…`; else `!ok`→ `API error: <status>`; `response.json().then(toClaudeUsage)`.
4. Implement `toClaudeUsage(payload)` port (see `claude/transforms.js`) with `addWindow` helper → `toUsageWindow`.
5. Wrap `fetchQuota` with `pendingFetch` single-flight mirroring upstream.
6. Register adapter: `id:"claude" name:"Claude" aliases:["claude","anthropic"] configured():authKey!==undefined fetch():Effect<ProviderResult>`.

## Acceptance

- [ ] With `auth.json {claude:{type:"oauth",access:"…"}}` and fixture `claude-limits-array.json` (5h 42%, 7d 18%, model Opus 7d 5%, extra_usage $2/$10), pane shows those windows + model subcard.
- [ ] `isConfigured=false` when no alias → quota returns `configured:false` (future frontend hides it).
- [ ] 429 with `Retry-After: 120` returns cached payload within 120s, not fresh fetch.
- [ ] No live network in tests (inject `HttpClient` stub via `FetchHttpClient`).
