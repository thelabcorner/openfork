# HANDOFF — Re-implement `quota/providers/http.ts` and `quota/providers/openrouter.ts`

## Context

A filesystem crash at 2026-08-21 23:41 zeroed the working tree. The entire
`../../packages/opencode/src/quota` module was untracked and unrecoverable from git,
stashes, t3 checkpoints, WebStorm Local History, and VSS shadow copies. It was
recovered from opencode's own session-snapshot object stores
(`~/.local/share/opencode/snapshot/...`) — **except two files**, whose final
versions never made it into any snapshot blob:

1. `../../packages/opencode/src/quota/providers/http.ts` (~2 KB)
2. `../../packages/opencode/src/quota/providers/openrouter.ts` (~3.3 KB)

Everything else in the module is restored and consistent, so these two files
can be re-implemented exactly. Their contracts are fully pinned down by their
consumers and by `../../packages/opencode/test/quota/providers.test.ts`, which
contains passing-level assertions against both. Re-implement to satisfy those
tests and `bun test test/quota` from `../../packages/opencode` should go green.

The module is a port of OpenChamber's (MIT) quota tracker
(`packages/web/server/lib/quota/providers/*.js`) — upstream source can be
consulted for the originals these files were ported from:
`http.js` (the GET-JSON seam) and `openrouter.js`.

---

## 1. `../../packages/opencode/src/quota/providers/http.ts`

Shared HTTP seam used by `deepseek.ts`, `kimi.ts` (and originally
`openrouter.ts`). Its original doc comment began:

> Bounded GET-JSON seam for provider account endpoints. Adapters receive a
> discriminated outcome instead of exceptions so each can fold failures into
> its result envelope the way OpenChamber's per-provider try/catch did.

### Exports (exact, from import sites)

```ts
import { fetchJson, outcomeError, type FetchOutcome } from "./http"
```

### `fetchJson`

```ts
fetchJson(
  http: HttpClient.HttpClient,          // from "effect/unstable/http"
  url: string,
  key: string,                          // sent as `Authorization: Bearer <key>`
  headers?: Record<string, string>,     // extra headers, e.g. { "Accept-Encoding": "identity" }
): Effect.Effect<FetchOutcome>
```

Behavior derived from consumers/tests:

- GET request to `url`, `Authorization: Bearer ${key}` header, plus any extra
  `headers` (deepseek passes `{ "Accept-Encoding": "identity" }`).
- Parses the response body as JSON.
- Returns a discriminated outcome, never throws.

### `FetchOutcome`

Discriminated union. The `status` error shape is pinned exactly by code that
pattern-matches it (deepseek.ts):

```ts
export type FetchOutcome =
  | { ok: true; body: unknown }                       // body = parsed JSON (raw, unvalidated)
  | { ok: false; error: "status"; status: number }    // non-2xx response
  | { ok: false; error: ... }                         // see notes below
```

Notes:

- The `{ error: "status", status }` variant is confirmed: `deepseek.ts` checks
  `outcome.error === "status" && (outcome.status === 401 || outcome.status === 403)`.
- Additional failure variants (network error, JSON parse failure) existed in
  all likelihood ("Bounded" in the doc comment suggests a timeout as well);
  exact variant names are unknown. Suggested minimal set that satisfies all
  surviving code: `"network"` and optionally `"parse"`/`"timeout"`. Only
  `outcomeError` needs to handle their rendering.

### `outcomeError`

```ts
outcomeError(outcome: Extract<FetchOutcome, { ok: false }>): string
```

Pinned by the openrouter test: a 401 response must surface as exactly
`"API error: 401"`. So at minimum:

```ts
if (outcome.error === "status") return `API error: ${outcome.status}`
```

Render other variants as human-readable strings (e.g. network failures).
Providers sometimes wrap it (deepseek overrides 401/403 with a
re-authenticate message), so keep it generic.

---

## 2. `../../packages/opencode/src/quota/providers/openrouter.ts`

OpenRouter credits adapter. Follows the exact shape of the recovered
`deepseek.ts` (its closest sibling — same "monetary balance, null percents"
pattern).

### Shape (from `quota.ts` and the test suite)

```ts
import { openrouter } from "../../src/quota/providers/openrouter"

export const openrouter = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({ ... })
```

- `id: "openrouter"`, `name: "OpenRouter"`, `aliases: ["openrouter"]`
- `configured()` → `Effect.map(authKey(auth, ALIASES), (key) => key !== undefined)`
  (must NOT make any network call — asserted by the test with a dying client)
- `fetch()`:
  1. `authKey(auth, ALIASES)`; if absent →
     `buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: false, error: "Not configured" })`
  2. `fetchJson(http, OPENROUTER_CREDITS_URL, resolved.key)` where the URL
     contains `/credits` — OpenRouter's endpoint is
     `https://openrouter.ai/api/v1/credits`
  3. On `!outcome.ok` →
     `buildResult({ ..., ok: false, configured: true, error: outcomeError(outcome) })`
  4. Parse `outcome.body` → `payload.data` (use `asObject`) →
     `total_credits` and `total_usage` are **numeric strings** (e.g. `"19.99"`, `"1.06"`).
     If missing → `error: "No quota data in response"` (exact string, asserted).
  5. Success → single window keyed `credits`:

```ts
usage: {
  windows: {
    credits: toUsageWindow({
      usedPercent: null,        // monetary balance: null percents (asserted)
      valueLabel: `$${formatMoney(remaining)} of $${formatMoney(total)} remaining`,
    }),
  },
}
```

### Pinned assertions (from `providers.test.ts`)

With auth `{ openrouter: { type: "api", key: "or" } }` and body
`{ data: { total_credits: "19.99", total_usage: "1.06" } }`:

- exactly one HTTP call; request header `authorization` is `Bearer or`
- `result.ok === true`
- `credits.usedPercent === null`, `credits.remainingPercent === null`
- `credits.valueLabel === "$18.93 of $19.99 remaining"`
  (19.99 − 1.06 = 18.93, rendered via `formatMoney` → `toFixed(2)`)

With body `{ data: {} }` → `ok: false`, `error: "No quota data in response"`.
With HTTP 401 → `ok: false`, `error: "API error: 401"` (plain `outcomeError`,
no custom override).

---

## Helpers available (all recovered, do not re-invent)

From `../format`: `asObject`, `toNumber`, `toUsageWindow`, `buildResult`,
`formatMoney` (`value.toFixed(2)`, null if not finite).
From `../registry`: `Adapter` interface
(`{ id, name, aliases, configured(): Effect<boolean>, fetch(): Effect<ProviderResult> }`).
From `./key`: `authKey(auth, aliases)` → `Effect<{ id, key } | undefined>`.

Reference implementations to copy structure from: `providers/deepseek.ts`
(near-identical problem shape) and `providers/kimi.ts`.

## Validation

```bash
cd packages/opencode
bun test test/quota test/server/httpapi-quota.test.ts
```

`test/quota/providers.test.ts` imports both files directly and asserts all of
the behavior above; `registry.test.ts` and `httpapi-quota.test.ts` cover the
surrounding module. `quota.ts` (line 14) imports `./providers/openrouter`, so
the package will not typecheck until both files exist.
