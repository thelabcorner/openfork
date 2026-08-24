# T9 — Testing, Fixtures & Hardening

**Goal:** Every provider is fixture-testable without live accounts; edge cases, refresh/429/protobuf, and hide-not-connected are contract-tested.

## Fixtures (store under `packages/opencode/test/quota/fixtures/`)

```
claude-limits-array.json           // limits[] with session/weekly_all/weekly_scoped + extra_usage
claude-legacy-five-hour.json
codex-primary-secondary.json       // primary 5h, secondary 7d, credits_balance, spend_control
xai-grpc-web.bin                   // pre-framed gRPC-web payload from upstream xai.test.js
openrouter-credits.json            // {data:{total_credits:"19.99", total_usage:"0.15"}}
opencode-go-official.json          // {usage:{rolling:{percent:12,resetsAt:"..."},weekly:{...},monthly:{...}}}
kimi-used-weekly.json / kimi-remaining-5h.json
deepseek-balance-usd.json / deepseek-403.json
```

Also keep negative fixtures: `malformed-json.json`, `missing-fields.json`, `429-retry-after.json`, `redirect.html`.

## Backend Tests

- **Provider unit tests** `test/quota/providers.<provider>.test.ts` per OpenChamber pattern (see `claude/index.test.js`, `codex.test.js`, `xai.test.js`):
  - `configured()` is cheap (mocked `Auth.get` only, never `HttpClient`).
  - `fetch()` happy path: single `fetch` call assert headers (`Authorization: Bearer …`, `ChatGPT-Account-Id`, `anthropic-beta`, `application/grpc-web+proto`), `ok:true`, correct `windows` keys/percents.
  - Missing fields → `No quota data in response`.
  - 401/403 → correct re-auth message.
  - 429 (Claude) → cooldown + stale cache path.
  - Malformed JSON/protobuf → `ok:false` not throw.
- **Registry test** `registry.test.ts` — alias resolution case-insensitive, `resolveAdapter` with aliases, `createSingleFlight` coalesces concurrent same-id calls.
- **HTTP seam test** `http.test.ts` — `FetchOutcome` discriminants `ok:true|status|network|parse|timeout`, `outcomeError` renders `API error: 401`.
- **Integration** `test/server/httpapi-quota.test.ts` — `GET /quota/providers` lists all registered + `configured` booleans; `GET /quota/:providerId` not-found 404 vs 200 with envelope.

## Frontend Tests

- **`hooks/use-limits.test.tsx`** (Solid `renderHook` + mock `sdk`/`ForkClient`/`free`):
  - Mixed `configured` input → `providers` excludes disconnected.
  - Go `byCredential.length=3` → `goByCredential` length.
  - OpenRouter free report merge → additive window under same card.
  - Sorting: windows sorted by `windowSeconds asc`; providers sorted `configured→ok→name`.
  - WorstRemaining + tone calc.
- **Panel rendering** `limits-panel.test.tsx` (optional snapshot): mocked hook returns 2 providers → renders 2 cards; `configured:false` absent.
- **Format helpers** `utils/limits-format.test.ts`: `formatCountdown(0)`→`0s`, `90_000`→`1m 30s`; `formatPercent(null)`→`—`; `displayWindowLabel("credits_balance")`→`Balance`.

## Hardening Checklist

- [ ] `HttpClient` timeouts (`REQUEST_TIMEOUT 10s` for http, 15s for xAI) — no hanging.
- [ ] Single-flight for `claude`/`xai` refresh (second concurrent refresh reuses promise) — assert with `Promise.all([fetchQuota(),fetchQuota()])` → 1 fetch call.
- [ ] `configured()` never hits network (assert HTTP not called).
- [ ] Protobuf parser `scanProtobuf` rejects malformed varint/frame (test with truncated `xai-grpc-web.bin`).
- [ ] `fork/usage-cache` 5-min gate unchanged — integration test proves second `get` within TTL reuses `fetchedAt` without extra fetch.
- [ ] Frontend `useLimits` cooldown 30s respected (two `refresh()` within 10s → second no-op, shows `Xs`).
- [ ] No live-provider test requires real key; all via injected `FetchHttpClient` stub or `HttpClient` mock.

## Done When

- [ ] `bun test test/quota` + `bun test packages/app -- use-limits` all green.
- [ ] No provider `fetch` touches file beyond `auth.json` / `Auth` service (host capability boundary).
- [ ] Add `docs/limits-system` note to `../../../../FORK.md` owned paths if new files (`quota/providers/claude.ts`, `codex.ts`, `xai.ts`) added.
