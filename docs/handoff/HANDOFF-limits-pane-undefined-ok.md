# HANDOFF — Limits pane: "Couldn't load limits" + `TypeError: Cannot read properties of undefined (reading 'ok')`

Date: 2026-08-29
Author: exploration + fix pass

## Status

- **Refresh cooldown work: DONE** (see §8). Cooldown is now derived from real
  per-provider cache state instead of a flat 30s guess.
- **The `undefined.ok` crash: root-caused in §2 Candidate A. A guard landed
  in `use-limits` (via concurrent edits, see §9), but the full chain is NOT
  end-to-end verified in a running app — see §5 blockers.**

> **§9 is important — another agent is concurrently editing the same files.**
> Read it before you start.

---

## 0. The symptom

User screenshot (OCR'd, image was not readable by this model) shows the Limits pane:

```
Context Usage Limits          <- limits.panel.title is "Limits"; "Context Usage Limits"
                                 is the ContextPanel tab label, not the standalone pane
PLAN USAGE & BALANCES         <- limits.panel.subtitle  ("Plan usage & balances")
Loading limits…               <- limits.loading

Couldn't load limits          <- limits.error

TypeError: Cannot read properties of undefined (reading 'ok')

[Retry]                       <- limits.error.retry
```

That composite can only be rendered by **one place in the tree** —
`packages/app/src/pages/session/limits-panel.tsx:621-640`:

```tsx
<Switch>
  <Match when={isLoading() && !providers()}> …spinner… </Match>
  <Match when={hasError() && !providers()}>          // <-- the screenshot
    <span …>{language.t("limits.error")}</span>
    <span …>{String(error() ?? "")}</span>            // "TypeError: … reading 'ok'"
    <button onClick={refresh}>{language.t("limits.error.retry")}</button>
  </Match>
  …
```

So, precisely:

- `providers()` is `undefined` (the hook's `connected()` memo returned `undefined`, i.e. the
  quotas resource is neither `ready` nor `refreshing`, or `quotasRes.latest` is undefined), AND
- `hasError()` is truthy, AND
- `error()` stringifies to `TypeError: Cannot read properties of undefined (reading 'ok')`.

i.e. **the fetcher function threw** rather than resolving — `createResource` stores the thrown
value as `resource.error`. Panes that render `hasError() && !providers()` therefore show the raw
TypeError. The `[Retry]` button calls `refresh()`.

---

## 1. The call chain (all files read in full)

### Front end

| File | Role |
|---|---|
| `packages/app/src/pages/session/limits-panel.tsx` | Pure projection. `LimitsPanelContent` at :475, `ProviderGroup` at :254, error `<Match>` at :628. |
| `packages/app/src/hooks/use-limits/index.ts` | Owns fetching, filtering, sorting, cooldown, Go/OpenRouter merges. **221 lines, read fully.** |
| `packages/app/src/utils/limits-format.ts` | Pure formatting + `ProviderResult` type. |
| `packages/app/src/i18n/en.ts:476-482` | `limits.panel.title`, `limits.panel.subtitle`, `limits.loading`, `limits.error`, `limits.error.retry`. |
| `packages/app/src/context/server-sdk.tsx` | `useServerSDK()` → `sdk().client` (unified SDK). |
| `packages/app/src/utils/server.ts` | `createSdkForServer` → `createOpencodeClient` from `@opencode-ai/sdk/v2/client`. |
| `packages/app/src/utils/fork-client.ts` | `/fork/usage`, `/fork/credential` (Go path; has its own `.ok` read at :69 — **different** code path, not the pane error). |
| `packages/app/src/hooks/use-openrouter-free-usage.ts` | Shared singleton poller for OpenRouter free usage; uses `useSDK()`, not `useServerSDK()`. |

### Back end

| File | Role |
|---|---|
| `packages/opencode/src/server/routes/instance/httpapi/groups/quota.ts` | `QuotaApi`: `GET /quota/providers`, `GET /quota/:providerID`. |
| `…/httpapi/handlers/quota.ts` | 23 lines. `providers → quota.providers()`, `get → quota.get(...)` mapped to `notFound`. |
| `packages/opencode/src/quota/quota.ts` | Service + adapter list (11 adapters incl. untracked `workbuddy`). |
| `packages/opencode/src/quota/registry.ts` | `resolveAdapter`, `createSingleFlight`. |
| `packages/opencode/src/quota/format.ts`, `schema.ts` | `buildResult`, `ProviderResult` schema. |
| `packages/opencode/src/quota/providers/*.ts` | 13 adapters. |
| `packages/sdk/js/src/v2/gen/{sdk.gen.ts,client/client.gen.ts}` | Generated client. |

### The generated client (critical)

`packages/sdk/js/src/v2/gen/client/client.gen.ts`:

```ts
return opts.responseStyle === "data"
  ? data
  : { data, ...result }      // line 194-199  (success)
```

Default `responseStyle` is **`"fields"`** (not `"data"`, despite the `Config` JSDoc saying
`@default 'fields'` at `client/types.gen.ts:43`). Nothing in `packages/app/src` sets
`responseStyle` except `context/session-groups.ts:58` (`"fields"`, explicit). `use-limits` does
not set it, so responses come back as `{ data, request, response }` — matching the
`response.data` reads in the hook. That is consistent and **probably fine**, but it is the one
assumption worth re-verifying against the installed `@hey-api/client-fetch` version, because
`packages/sdk/js/node_modules/@hey-api/client-fetch` **does not exist** on this machine (only
`@hey-api/openapi-ts` is installed). The generated client is vendored under `src/v2/gen`, so it
does not need the package at runtime — but it means the vendored copy is the only source of
truth and may be out of sync with the upstream generator.

---

## 2. Root-cause candidates, ranked

### Candidate A (strongest): `getEffectiveResult` / downstream reads `r.ok` on an `undefined` result

`use-limits/index.ts:116-133`:

```ts
const results = await Promise.all(
  input.providers.map(async (entry) => {
    try {
      const response = await sdk().client.quota.get({ providerID: entry.providerId }, { throwOnError: false })
      return response.data as ProviderResult     // <-- `.data` of `undefined` if the client
                                                 //     returned `undefined` (network path)
    } catch (err) { … }
  }),
)
```

The generated client returns **`undefined`** (not a result object) in the non-`throwOnError`
network-failure branch:

```ts
} catch (error) {
  …
  if (opts.throwOnError) throw finalError
  return opts.responseStyle === "data"
    ? undefined                                  // client.gen.ts:109-110
    : { error: finalError, request, response: undefined as any }
}
```

and in the HTTP-error branch:

```ts
if (opts.throwOnError) throw finalError
return opts.responseStyle === "data"
  ? undefined                                    // client.gen.ts:227-228
  : { error: finalError, ...result }
```

With `responseStyle: "fields"` (the default) the network branch **does** return an object whose
`.data` is `undefined` — and `response.data as ProviderResult` then yields `undefined`, which
flows straight into:

- `results.forEach(r => { if (r.ok && r.usage) … })` at :134 → **throws
  `TypeError: Cannot read properties of undefined (reading 'ok')`** — *but this throw happens
  outside the inner `try`, so it escapes the `Promise.all` fetcher and becomes the resource
  error*, and
- `connected()` → `raw.filter(r => r.configured)` at :153 → would also throw, and
- `getEffectiveResult(r)` at :56-57 reads `r.ok`.

This reproduces **all three** observed facts at once: the exact TypeError text, `providers()`
staying `undefined` (the resource never resolves), and `hasError()` truthy.

Two independent ways to get there:

1. **Network failure** (fetch threw — server unreachable / aborted / CORS / Electron preflight).
   The client catches, does not rethrow (`throwOnError: false`), and returns
   `{ error, request, response: undefined }` → `.data === undefined`.
2. **HTTP error status** (401/403/404/5xx). Same shape → `.data === undefined`. Note the quota
   group is `.middleware(Authorization)` (`groups/quota.ts:47`) and I confirmed a bare
   `GET /quota/providers` against a locally started server returns **401** (no auth header) —
   so if the desktop renderer's `sdk()` ever loses/re-creates its auth, every provider `get`
   returns an error envelope with `data === undefined`.

   Also note `GET /quota/{providerID}` for an unknown provider id maps to `notFound(...)`
   (`handlers/quota.ts:15-18`) → a **404 envelope**, again `data === undefined`.

The inner `try`/`catch` gives a false sense of safety: it only guards the `await`, not the
`response.data` cast or anything downstream.

### Candidate B: untracked `workbuddy` adapter is the newest variable

`git status` shows these are **untracked/uncommitted**:

- `packages/opencode/src/quota/providers/workbuddy.ts` (untracked, 367 lines)
- `packages/opencode/src/plugin/workbuddy-accounts.ts`, `workbuddy.ts`, `workbuddy-governor.ts` (untracked)
- `packages/opencode/test/quota/providers/workbuddy.test.ts` (untracked)
- `packages/opencode/src/quota/quota.ts` **modified** to add `workbuddy()` to the adapter list
- `packages/opencode/src/quota/format.ts` **modified** (adds `planLabel` to `buildResult`)
- `packages/app/src/utils/limits-format.ts` **modified** (adds `bonus:` prefix handling)

`workbuddy.ts` is the only adapter that:
- is `configured` purely from a local vault (`vault().list().length > 0`) — so it can appear
  in `/quota/providers` while its `fetch` depends on `AccountVault` and a reverse-engineered
  Tencent endpoint, and
- emits window keys with a `bonus:` prefix, which the **uncommitted** front-end change to
  `limits-format.ts` is what teaches the pane to skip.

If the running desktop build has the new backend (workbuddy in the list) but an **older
front-end bundle** (no `bonus:` handling), or vice-versa, the pane can render a window key that
`displayWindowLabel`/`resolveTierGate` were never taught — that produces weird labels, not a
TypeError, so **B is a secondary suspicion, not the TypeError itself.** Worth confirming the two
halves are in sync in the build the user is running.

### Candidate C: `opencode-zen` injection + `providers()` gating interaction

Commit `1dbfc47683` ("fix(limits): always show OpenCode Zen free quota") changed
`use-limits/index.ts` so that:

- `providerData()` returns a **hard-coded fallback list** (`opencode-zen`, `claude`) when
  `providersRes.error` is set and the resource is not ready (lines 82-91), and
- `opencode-zen` is always injected even when the server's list omits it (lines 103-105), and
- sorting pins Zen first (lines 170-172).

Consequence: when `/quota/providers` fails, `providerData()` still returns a list, so the
quotas resource **does** run — and it now runs against injected ids. `/quota/opencode-zen`
resolves fine (adapter id `opencode-zen`), but remember `opencodeZen.fetch()` at
`providers/opencode-zen.ts:169-184` **always** returns `ok: true`, so it is not the thrower.

The real hazard in that commit: `providerData()` returns the fallback **only when
`providersRes.error`**, and returns `undefined` while merely loading. Combined with Candidate A
(a throw inside the quotas fetcher), `providers()` stays `undefined` **and** `hasError()` is
true → exactly the screenshot. The commit made the failure *visible* rather than *fixed*.

### Candidate D (lower): `useOpenRouterFreeUsage` / `useSDK` vs `useServerSDK`

`use-limits` uses `useServerSDK()`; `use-openrouter-free-usage.ts` uses `useSDK()` and stashes
it in a **module-level** `sdkClient` set once by the first subscriber. If the two contexts
resolve to different servers/ports, or the first subscriber captured a stale SDK, the singleton
poller silently fails with `"no-sdk"`. That failure is swallowed (`.catch(() => undefined)` in
`fork-usage.tsx`, `Promise.reject(new Error("no-sdk"))` at `use-openrouter-free-usage.ts:32`)
and does **not** produce the TypeError — but it is a real divergence worth cleaning up.

---

## 3. What I verified vs. what is still a hypothesis

**Verified:**
- The exact error surface is `limits-panel.tsx:628-640`, and it requires
  `hasError() && !providers()`.
- `error()` is populated from a **thrown** value inside the `createResource` fetcher
  (`use-limits/index.ts:109-146`); the inner `try` wraps only the `await`, not `response.data`
  or the subsequent `results.forEach`.
- Generated client returns `undefined` for `.data` on both network failure and HTTP error when
  `throwOnError: false` (`client.gen.ts:107-115`, `:222-232`).
- Default `responseStyle` is `"fields"`; `use-limits` does not override it.
- Quota routes are behind `Authorization` middleware; an unauthenticated `GET /quota/providers`
  against a locally started server (`bun run --conditions=browser ./src/index.ts serve --port 4099`,
  from `packages/opencode`) returns **401**. Unknown provider id → mapped to a 404 `ApiNotFoundError`.
- `packages/sdk/js/node_modules/@hey-api/client-fetch` is **not installed**; only
  `@hey-api/openapi-ts`. The client is vendored under `src/v2/gen`.
- `git status` in the worktree (see §2 Candidate B for the untracked list).

**Hypothesis (not verified — I could not run the desktop app):**
- Which of the two failure modes actually fires in the user's build (network failure vs 401/404
  envelope), and whether `workbuddy` is present in the running backend.
- Whether the desktop renderer's `sdk()` carries auth on `/quota/*`.

---

## 4. Blockers I hit (read this before re-doing the investigation)

1. **I could not read the user's screenshot.** This model does not support image input. All
   symptom detail above comes from the OCR text the user pasted. If a real screenshot exists,
   have a vision-capable agent confirm whether the header says "Context Usage Limits" (Context
   Panel tab) vs "Limits" (standalone pane) — it changes which mount point is involved
   (`context-panel.tsx:152` vs `layout-new.tsx:123` / `limits-panel.tsx:687`).
2. **`packages/app/AGENTS.md` forbids restarting the app or server.** I started a backend on
   port 4099 to probe `401`, then killed it. A smarter agent should confirm with the user before
   any further process launches.
3. **`bun run --conditions=browser ./src/index.ts serve --port N` works** (server printed
   `opencode server listening on http://127.0.0.1:4099`), but every route needs auth — even
   `/health` and `/doc` returned 401. To exercise `/quota/*` you need the Basic auth header the
   app builds (`utils/server.ts:26-32`, `Authorization: Basic base64("opencode:<password>")`).
4. An earlier transient: `git status --short` at one point reported four `UU` conflicted files
   (`packages/core/src/session/sql.ts`, `packages/core/src/database/{migration,schema}.gen.ts`,
   `packages/core/schema.json`) and a `bun` run failed with literal `<<<<<<< Updated upstream`
   markers in `packages/core/src/session/sql.ts:61`. On re-check, `git status` is clean of
   conflicts and no markers remain in those files. **The tree is currently consistent** — but if
   `bun` suddenly reports a syntax error in `packages/core/src/session/sql.ts`, re-check for a
   merge conflict rather than assuming the file is corrupt.

---

## 5. Suggested next steps (in order)

1. **Reproduce with the network tab open.** Run the desktop app (`bun run dev` from
   `packages/desktop`, per `docs/handoff/AGENTS.md` — tell the user; don't start it
   yourself), open the Limits pane, and capture the `/quota/providers` and `/quota/<id>`
   responses. If they are 401/404/error envelopes → Candidate A confirmed.
2. **Read `response.data` defensively** in `use-limits/index.ts`. The minimal, correct fix is to
   treat a missing `data` as a failed provider result instead of casting `undefined` to
   `ProviderResult` — and to move the `results.forEach` (and any other `r.ok` read) inside
   guard logic so one bad entry cannot throw out of the fetcher. Note `app/AGENTS.md` asks you
   to avoid `try`/`catch` where possible and to prefer inference, so shape the fix as a normal
   fallback value rather than more `catch` blocks.
3. **Harden the error surface** in `limits-panel.tsx:628-640` so a resource error shows a
   localized message (`limits.error` already exists) rather than `String(error())`. Per
   `app/AGENTS.md`, never hardcode user-visible English — use the existing `limits.*` keys.
4. **Reconcile the two SDK contexts** (`useServerSDK` in `use-limits` vs `useSDK` in
   `use-openrouter-free-usage`) so the singleton poller cannot capture a stale client.
5. **Confirm backend/frontend parity for the uncommitted WorkBuddy work** — the pane must not
   assume `bonus:`-prefixed keys are handled when the running bundle predates the
   `limits-format.ts` change.

## 6. Existing tests / generators to re-run after any change

- `packages/opencode`: `bun test test/quota` (run from the package dir — tests cannot run from
  the repo root per `docs/handoff/AGENTS.md`).
- `packages/opencode`: `bun typecheck` (never bare `tsc`).
- If you touch anything under `packages/opencode/src/server/routes/**`:
  `bun run build` from `packages/sdk/js`, then verify with
  `rg -n "quota" packages/sdk/js/src/v2/gen/sdk.gen.ts`. Do **not** hand-edit `src/v2/gen`.
- If you touch `packages/protocol`: also `bun run generate` from `packages/client`.

## 8. Refresh cooldown — DONE

### The problem

`use-limits/index.ts` gated refresh behind a flat `COOLDOWN_MS = 30_000`, which had no
relationship to whether a refresh would actually return new data. Clicking refresh at t=31s
refetched, every cached provider returned `cache.fresh()` with its original `fetchedAt`, and the
pane repainted **identical numbers** — the button looked enabled and did nothing.

### Correction to the original premise

"All providers are 5 minutes" is **wrong** — only 6 of 10 are:

| Provider | Server TTL | Source |
|---|---|---|
| kimi, codex, xai, workbuddy | 5 min | `providers/http.ts` `CACHE_TTL_MS` via `createQuotaCache` |
| claude | 5 min | `providers/claude.ts` `USAGE_CACHE_TTL_MS` (hand-rolled cache) |
| opencode-go | 5 min | `fork/usage-cache.ts` `OFFICIAL_TTL_MS` |
| **openrouter, deepseek** | **none** | `fetchJson` on every call |
| **opencode-zen** | **none** | local DB snapshot |
| **nvidia** | **none** | pure local computation |

A flat 5-min cooldown would have needlessly frozen Zen — the row commit `1dbfc47683` deliberately
pinned to the top of the pane.

### The fix (user chose "backend publishes nextRefreshAt")

1. **`quota/schema.ts`** — `ProviderResult.nextRefreshAt: Schema.optional(Schema.Finite)`.
   Documented as "absent means refresh now, NEVER never-refresh", so an older server can't
   disable the button forever.
2. **`quota/format.ts`** — `buildResult` accepts and forwards `nextRefreshAt` (conditional spread,
   so `0` is preserved and absent stays absent — there's a test for this).
3. **`quota/providers/http.ts`** — `createQuotaCache.nextRefreshAt()` returns
   `max(cached.fetchedAt + ttlMs, cooldownUntil)`. A 429 backoff (up to `cooldownMaxMs` = 1h)
   correctly outlives the 5-min TTL. Also exports `NEXT_REFRESH_NOW = 0`.
4. **kimi / codex / xai** — wrap returns in a local `withNextRefresh(result, cache)`.
5. **claude** — hand-rolls its cache, so it gets `nextRefreshAtOf(fetchedAt, cooldownUntil)`.
6. **workbuddy** — per-account caches; provider-level value is the **max across accounts**
   (a refresh is only useful once the slowest account is re-readable).
7. **opencode-go** — derives it from `snapshot.fetchedAt + OFFICIAL_TTL_MS`.
8. **openrouter / deepseek / nvidia / opencode-zen** — explicitly `NEXT_REFRESH_NOW` on every
   return path (uncached → refresh always does real work).
9. **`use-limits/index.ts`** — new `providerCooldownRemainingMs` memo takes the max of
   `nextRefreshAt` across providers; `cooldownRemainingMs` now takes
   `max(REFRESH_FLOOR_MS, claudeBackoff, providerCooldown)`.
   `COOLDOWN_MS` 30s → `REFRESH_FLOOR_MS` 5s (anti-mash only; real gating is now data-driven).

### Verification

- `packages/sdk/js`: `bun run build` re-run; `nextRefreshAt?: number` confirmed in
  `src/v2/gen/types.gen.ts:10776`.
- New `packages/opencode/test/quota/cache.test.ts` — 7 tests covering empty cache, TTL, 429
  backoff exceeding TTL, `Retry-After` cap, cooldown cleared by a later success, reset, custom TTL.
- New test in `format.test.ts` for `nextRefreshAt` presence/absence/`0`.
- `bun test test/quota` from `packages/opencode`: **56 pass / 0 fail**.
- `bun test test/fork`: **21 pass / 0 fail**.
- Typecheck: 0 errors in any `quota/**` or limits file. Remaining errors in both packages are
  pre-existing in unrelated files (measured baseline: app 17 → 9, all in
  `prompt-input-v2.tsx`, `HostedBrowserWebview.tsx`, `browserHostClient.ts`,
  `session-composer-controls.ts`, `session-ui/message-part.tsx`).

### Known remaining gap (deliberate, per user decision)

The 5-min 429 backoff in `use-limits` is still **claude-only**. Kimi/codex/xai/workbuddy have the
same backend cooldown but don't set `lastRateLimitedAt`. Now that the backend publishes
`nextRefreshAt`, this client-side special case is largely redundant and could be deleted — the
backend value is authoritative and covers all providers. Left in place per instruction.
Also note `outcomeError()` (`http.ts:53`) hardcodes "Anthropic is throttling…" for **every**
provider's 429, which is wrong copy and makes `isRateLimited()` detection provider-agnostic only
by accident.

## 9. Concurrent edits — READ BEFORE CONTINUING

Another agent/session is editing the same files in this workspace. Evidence: while working I
observed `packages/app/src/utils/limits-format.ts` and `packages/app/src/hooks/use-limits/index.ts`
gain substantial WorkBuddy-related code I did not write (`ProviderModelUsage`, `parseWorkBuddyKey`,
`workBuddyCredits`, `isWorkBuddyNonGating`, and a `!response.data` guard in the quotas fetcher that
matches §2 Candidate A). Untracked `packages/app/src/hooks/use-workbuddy-usage/` and
`.workbuddy-ai/` also appeared mid-session.

Consequences to be aware of:

- My `nextRefreshAt` changes and their WorkBuddy changes are **composable** (different concerns,
  no overlapping hunks), and `bun test test/quota` passes with both present.
- `limits-format.ts` had a `bonus:` prefix convention from the earlier uncommitted work that has
  since been **replaced** by an `aggregate:` / `account:` scheme
  (`parseWorkBuddyKey`). Any assumption about `bonus:` is now stale.
- `opencode-zen.ts` was rewritten by someone to drop an `Effect.catchAll` that used a
  non-existent `zenUtcDayStart` import and an API that doesn't exist on this Effect version —
  that was a real crash source (every Zen request threw). Worth confirming they finished.
- **Re-read any file before editing it**, and re-run `git status` — the tree is not stable.

## 7. Related handoffs

- `docs/handoff/HANDOFF-quota-reimplementation.md` — how `quota/providers/http.ts` and
  `openrouter.ts` were re-implemented after a filesystem crash; pins the `FetchOutcome`
  contract.
- `docs/handoff/HANDOFF-zen-free-usage-limits.md` — the Zen free-quota source that
  `opencode-zen` reads; relevant to Candidate C.
