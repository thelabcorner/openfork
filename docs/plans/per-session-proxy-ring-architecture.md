# Per-Session Proxy-Ring — Architecture Plan

Status: **Design / Planned (not yet implemented)**
Scope: opencode zen (and other free) provider models, per-session egress-IP rotation
Track: feature

---

## 0. Intent, and the honest "security" boundary

Goal: give every opencode session a **distinct egress IP** drawn from a ring of
proxies, with the ability to (a) rotate a session's proxy on demand, (b) have
many sessions on many distinct proxies, and (c) have many sessions share one
proxy — all toggleable from the settings modal.

What a per-session egress IP actually buys you:

- **Egress-IP isolation / anti-correlation** between sessions.
- **Resilience** if one proxy IP is blocked or rate-limited upstream.
- A different source IP in the upstream's **per-IP** rate view.

What it does **not** buy you (stated plainly so the design can't oversell it):

- TLS already encrypts the link; a proxy adds no confidentiality the channel
  lacked.
- Auth is still one zen token. Every session is still correlated to the same
  zen account regardless of IP.
- If the real objective is "zen should not be able to link my sessions," the
  true lever is **per-session zen credentials/accounts**, not proxy IPs. The
  proxy ring is necessary-but-not-sufficient for that goal. We therefore leave a
  clean seam for per-session tokens (Phase 6) and ship the proxy ring as the
  egress-isolation primitive.

**ToS / account-ban reality:** rotating egress IPs to multiply a free-tier quota
budget risks violating the zen free-tier terms and incurring account bans. The
feature MUST be:

- explicitly opt-in (default OFF),
- scoped to free models only by default (zen free, openrouter `:free`),
- framed in UI copy around "egress isolation," never "bypass limits."

---

## 1. Critical technical findings (why this is non-trivial)

The default LLM path is **Bun's global `fetch`**, wrapped once per SDK instance
in `packages/opencode/src/provider/provider.ts:2093-2120`. Two hard problems:

1. **No per-call proxy in Bun.** Bun's `fetch` honors `HTTP_PROXY` /
   `HTTPS_PROXY` env vars *globally* but exposes **no per-request proxy or
   `dispatcher` argument**. Therefore true per-session distinct IPs cannot use
   env vars — they must route through **undici's `fetch` with a `ProxyAgent`
   dispatcher**. undici is already in `bun.lock` (transitive, `undici@8.3.0`
   via `@effect/platform-node`); add it as a direct dependency.

2. **SDK instances are memoized** by `{ providerID, npm, options }` at
   `provider.ts:2077-2085`, and the fetch wrapper is constructed with **no
   session context**. The wrapper must become session-aware at *request time*,
   not at build time. The wrapper also currently controls only AbortSignal
   composition; the actual socket goes to `globalThis.fetch` at `:2094`.

Secondary findings from repo exploration:

- There is **no single proxy seam**. Four independent outbound HTTP stacks exist:
  AI-SDK default (Bun fetch), Effect native (`app-node-platform.ts:10`), Bun
  WebSocket (`plugin/openai/ws.ts:86-91`, already proxy-aware via `ProxyEnv`,
  but skips proxy on Node), and Electron `http.setGlobalProxyFromEnv()` (Node
  `http` only, separate process). The design uses one source of truth consumed
  by the two LLM paths.
- Only one proxy-env resolver exists: `packages/opencode/src/util/proxy-env.ts`
  (`getProxyForUrl`), honoring `<proto>_proxy` / `all_proxy` / `no_proxy` with
  case-insensitive lookup. This is reused for loopback bypass logic.
- Config is **Effect Schema** (`packages/core/src/v1/config/config.ts:32-215`),
  not zod; UI `Config` type is *generated* (`packages/sdk/js/src/v2/gen/`
  — never hand-edited; regen via `bun run build` in `packages/sdk/js`).

---

## 2. Data model

### 2.1 Config schema (authoritative)

New module `packages/core/src/v1/config/proxy-ring.ts` (self-reexport pattern,
registered into `config.ts`'s `Info` struct; then SDK regen):

```ts
export * as ConfigProxyRingV1 from "./proxy-ring"

import { Schema } from "effect"

export const Proxy = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  url: Schema.String,                                  // e.g. http://host:port, socks5://...
  protocol: Schema.Literal("http", "https", "socks5"), // socks5 = follow-up dispatcher
  auth: Schema.optional(Schema.Struct({
    username: Schema.String,
    password: Schema.String,
  })),
  enabled: Schema.optionalWith(Schema.Boolean, { default: true }),
}).annotate({ identifier: "ProxyRingProxy" })

export const Ring = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  strategy: Schema.Literal(
    "pinned",            // sticky IP for session lifetime (DEFAULT)
    "round-robin",       // advance per session bind
    "random",            // pick per bind
    "rotate-per-turn",   // advance each assistant turn
    "rotate-per-request" // advance each HTTP request (expensive; flagged)
  ),
  affinity: Schema.optionalWith(Schema.Boolean, { default: true }),
  maxSessionsPerProxy: Schema.optional(Schema.Number),
  memberIds: Schema.Array(Schema.String),              // -> Proxy.id
}).annotate({ identifier: "ProxyRing" })

export const Scope = Schema.Struct({
  onlyFreeModels: Schema.optionalWith(Schema.Boolean, { default: true }),
  providers: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ProxyRingScope" })

export const Info = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: false }),
  defaultRingId: Schema.optional(Schema.String),
  scope: Schema.optional(Scope),
  rings: Schema.optional(Schema.Record(Schema.String, Ring)),
  proxies: Schema.optional(Schema.Record(Schema.String, Proxy)),
}).annotate({ identifier: "ProxyRingConfig" })

export type Info = Schema.Schema.Type<typeof Info>
```

Registered in `packages/core/src/v1/config/config.ts`:

```ts
proxy_ring: Schema.optional(ConfigProxyRingV1.Info).annotate({
  description: "Per-session egress proxy rings for free-model providers",
}),
```

### 2.2 Runtime binding (persisted, not config)

`SessionProxyBinding` — persists across restart, surfaces in UI:

```ts
interface SessionProxyBinding {
  sessionID: string
  ringId: string
  proxyId: string | null     // null = direct (no proxy)
  strategyOverride?: Ring["strategy"]
  assignedAt: number
  rotatedAt: number
  rotatesPerTurn: boolean
}
```

Stored in a new Drizzle table (migration required). Indexed by `sessionID`.

### 2.3 Health record (runtime only, not persisted long-term)

```ts
interface ProxyHealth {
  proxyId: string
  consecutiveFails: number
  lastError?: string
  latencyMs?: number
  backoffUntil: number       // epoch ms; exclude until then
  lastUsedAt?: number
}
```

---

## 3. Core engine — `packages/opencode/src/provider/proxy-ring.ts`

Single module; the only seam the rest of the code touches.

### 3.1 Service interface

```ts
export interface ProxyRingInterface {
  // binding
  bind(sessionID: string, ringId?: string): Effect.Effect<SessionProxyBinding>
  unbind(sessionID: string): Effect.Effect<void>
  rotate(sessionID: string): Effect.Effect<SessionProxyBinding>
  getBinding(sessionID: string): Effect.Effect<SessionProxyBinding | undefined>

  // request-time resolution
  resolveProxyUrl(sessionID: string, model: { providerID: string; id: string }):
    Effect.Effect<string | undefined>   // undefined => direct, no proxy

  // registry / admin
  listRings(): Effect.Effect<ReadonlyArray<Ring>>
  listProxies(): Effect.Effect<ReadonlyArray<Proxy>>
  setHealth(proxyId: string, ok: boolean, latencyMs?: number): Effect.Effect<void>

  // turn hook
  onTurn(sessionID: string): Effect.Effect<void>   // rotate-per-turn advancement
}
export class ProxyRingService extends Context.Service<ProxyRingService, ProxyRingInterface>()(
  "@opencode/ProxyRing",
) {}
```

### 3.2 undici ProxyAgent cache

- One `ProxyAgent` per proxy URL (+ auth), keyed by `url|username`.
- TTL-bound (dispose after idle `N` min) so keep-alive sockets don't leak.
- `proxyFetch(input, init, proxyUrl?)`:
  - if `proxyUrl` → `undici.fetch(input, { ...init, dispatcher: agent })`
  - else → global `fetch` (preserves existing behavior for sessions without a ring)
- Interface is injectable so tests substitute a fake transport.

### 3.3 Request carrier — `AsyncLocalStorage`

- `ProxyRingContext` = `AsyncLocalStorage<{ sessionID; providerID; modelID }>`.
- Set at the **session turn boundary** in `llm.ts` *before* `streamText`, and
  inside the native Effect HttpClient layer. Read inside the fetch wrapper.
- Works in both Bun and Node, and across the AI-SDK path, so both LLM paths
  honor one source of truth.
- `currentProxyUrl()` reads ALS → sessionID → binding (respects scope gate) →
  proxy URL (or `undefined` for direct).

### 3.4 Selection + circuit breaker

- `resolveProxyUrl` gates on `scope`:
  - `onlyFreeModels` (default): eligible iff model matches the free predicate.
    Free predicate reuses `isFreeModel` (`packages/app/src/utils/model-cost.ts:259`)
    for UI and the quota adapter id `opencode-zen` (aliases `zen` /
    `opencode-free`, `quota/providers/opencode-zen.ts:18,171`) for the provider.
    Default scope => `opencode-zen` + openrouter `:free` only.
  - explicit `providers`/`models` lists override narrowly.
- Ring selection per strategy (see §2.1). `pinned` is the default to preserve
  keep-alive and avoid abrupt mid-session IP changes.
- **Health-weighted**: dead proxies (`consecutiveFails > N` or `backoffUntil >
  now`) are excluded; selection falls back to next healthy member, else direct
  (logged), never to a known-dead member. Exponential backoff grows per failure.
- Concurrency: binding registry + health map guarded by an Effect `Ref`/mutex
  (sessions run concurrently).

### 3.5 Scope warnings

- If a user adds a **paid** provider to the scope while `onlyFreeModels` is off,
  surface a settings warning. Never silently proxy paid traffic without explicit
  scope inclusion.

---

## 4. Request-path integration (the edits)

1. **`packages/opencode/src/provider/provider.ts:2093`** — replace the wrapper's
   final call:

   ```ts
   const res = await proxyFetch(
     input,
     { ...opts },
     ProxyRing.currentProxyUrl(),   // reads ALS; undefined => global fetch
   ).finally(...)
   ```

   `proxyFetch` is the §3.2 helper. When undefined, behavior is byte-identical
   to today (global `fetch`), so non-ringed sessions are unaffected.

2. **`packages/opencode/src/session/llm.ts`** turn entry — wrap the turn:

   ```ts
   yield* ProxyRingContext.run({ sessionID, providerID, modelID }, () =>
     Effect.promise(() => streamText({ ... })),
   )
   yield* ProxyRing.onTurn(sessionID)   // advance rotate-per-turn rings
   ```

3. **`packages/core/src/effect/app-node-platform.ts:10`** — provide a
   `FetchHttpClient` layer whose `fetch` consults the same ALS, so the native
   path stays process-global but is session-scoped at call time. Reuse the same
   `proxyFetch`.

All three must agree on the single `ProxyRingService` + single ALS.

---

## 5. Settings modal UX (V2)

New tab **"Network / Proxy Rings"** under the Server group.

Registry edits in `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
(trigger at `:54-90`, panel at `:101-118`); template = `settings-v2/servers.tsx`
(list + add/edit) and `settings-v2/dialog-server-v2.tsx` (form dialog). Config
read/write exactly like providers: `serverSync().updateConfig({ proxy_ring: ... })`
with optimistic `set` + rollback (`server-sync.tsx:776-804`). i18n keys added to
`packages/app/src/i18n/en.ts` (no hardcoded English strings per AGENTS.md).

### 5.1 Sections

- **Master toggle** (`Switch`) bound to `proxy_ring.enabled`. Emergency kill-switch
  env `OPENCODE_PROXY_RING_DISABLED` forces off at runtime (read in the engine).
- **Scope** — "Only free models" checkbox + provider/model chips.
- **Rings list** — card per ring: name, strategy badge, member count,
  #sessions bound, aggregate health. Add / Edit / Delete. Edit dialog = name +
  strategy `Select` + affinity toggle + max-sessions-per-proxy + member multiselect.
- **Proxies list** — CRUD + **bulk import** (paste newline/comma URL list) +
  **Test / Test all** (validates reachability and shows resolved egress IP).
  Per-proxy health badge (ok/warn/dead), latency, last-used.
- **Sessions** — panel listing active sessions with their bound proxy, a
  **Rotate** button (one click → next ring member), **Unbind**, and an affinity
  indicator. Premium affordance: a small proxy pill in the session header with
  hover-to-rotate, mirroring the per-row `Switch` pattern from `models.tsx`.

### 5.2 UX guarantees

- Rotating never blocks a turn: selection is synchronous off cached state.
- A failed proxy test shows the concrete error (CA? auth? unreachable?) — reuse
  desktop `setDefaultCACertificates` (`index.ts:173`) so custom CAs/MITM proxies
  work.
- Loopback bypass preserved: reuse `proxy-env.ts` `no_proxy` logic so local
  endpoints (sidecar, MCP) never traverse a proxy.

---

## 6. Build phases

1. **Engine** (`proxy-ring.ts`): service + `proxyFetch` + undici `ProxyAgent`
   cache + ALS + circuit breaker + health. Unit tests with a fake proxy transport.
2. **Wire**: `provider.ts` fetch wrapper + `llm.ts` carrier + native layer
   (`app-node-platform.ts:10`). Covered by the existing recorded LLM test
   harness (`test/session/llm-native-recorded.test.ts`).
3. **Config**: `proxy-ring.ts` schema in `config.ts`, SDK regen, v2-compat
   lowering (`config/v2-compat.ts`).
4. **Persistence**: `SessionProxyBinding` Drizzle table + migration.
5. **UI**: tab + rings / proxies / sessions panels + rotate affordance.
6. **Polish + seam**: health telemetry, bulk import, egress-IP display, and a
   **per-session-token seam stub** (the real session-isolation lever) — hook
   point for future per-session zen credentials without re-architecting.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Bun has no per-call proxy | Route proxied requests through undici `fetch` + `ProxyAgent`; cache agents per URL |
| Dead proxy breaks sessions | Circuit breaker + health-weighted selection; never select a dead member |
| Keep-alive destroyed by per-request rotation | Default strategy `pinned` (sticky IP); `rotate-per-request` opt-in & flagged expensive |
| Proxy CAs / MITM | Reuse desktop `setDefaultCACertificates` (`index.ts:173`); SOCKS via follow-up custom dispatcher |
| Loopback leak | Preserve `NO_PROXY`/loopback bypass (`proxy-env.ts`) |
| Scope creep to paid providers | Hard gate on `onlyFreeModels`; warn if paid provider added to scope |
| ToS / account ban | Opt-in, default OFF, free-only by default, "egress isolation" copy, token seam stub |
| Both LLM paths must match | One `ProxyRingService` + one ALS consumed by AI-SDK *and* native fetch |
| State loss on restart | Persist `SessionProxyBinding` in session DB (migration) |
| SDK type drift | Regenerate via `bun run build` in `packages/sdk/js`; never hand-edit `sdk/js/src/v2/gen/**` |
| Sidecar staleness (desktop dev) | Edits to `packages/core` require `bun run predev` + Electron restart (AGENTS.md) |

---

## 8. Open questions / decisions needed

- **SOCKS5 support**: defer to a follow-up with a custom undici dispatcher, or
  include in Phase 1? (Recommended: http/https in Phase 1, SOCKS5 follow-up.)
- **Default ring strategy**: `pinned` (recommended) vs `round-robin` on first bind.
- **Per-session token scope**: confirm whether zen supports per-session tokens
  before committing Phase 6 seam shape.
- **Test-all egress IP display**: depends on a trusted "what is my IP" endpoint;
  must be configurable / self-hostable to avoid leaking proxy topology to a third party.
