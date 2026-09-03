# OpenCode Zen: multi-API-key parallel routing

Status: ideation / not started. No code has been written for this yet.

## Goal

Today `opencode-zen` (`packages/opencode/src/quota/providers/opencode-zen.ts`) is a
plain OpenAI-compatible provider: one API key, one credential, used serially.
`verdent.ts` and `workbuddy.ts` (in `packages/opencode/src/plugin/`) both solve a
harder problem — many accounts, each with its own quota — by running a local
loopback proxy in front of a **registry** of accounts and a **router** that picks
which account serves each request, with a stateful **governor** per account that
tracks quota/cooldown and blocks bad accounts automatically.

The ask: give Zen the same shape, so a user can hand OpenCode `N` Zen API keys and
have requests spread across them instead of pinning to one key until it's
exhausted or erroring out.

## Why Zen is a simpler case than Verdent/WorkBuddy

Both existing plugins carry a lot of weight that doesn't apply here:

- **Verdent**: no public API. The plugin exists to *reverse-engineer* a private,
  encrypted proxy protocol (AES-256-GCM, custom headers, device fingerprinting)
  and pretend it's OpenAI-compatible locally. Zen already speaks a normal,
  documented OpenAI-compatible API — no protocol translation needed.
- **WorkBuddy**: the governor encodes vendor-specific admission rules (which
  models a given account tier may call, 402 = hard quota exhaustion, promotional
  model seeding, etc.) reverse-engineered from a specific backend.
- Both discover credentials from OS credential stores / desktop app session
  files, because the user never manually issues a token.

Zen keys are user-issued API keys with (presumably) a documented or inferable
quota shape (requests/tokens per day, or credit balance). So the new plugin can
reuse the *pattern* — registry + router + governor — without reimplementing
protocol reverse-engineering or desktop credential scraping.

## Proposed shape

```
packages/opencode/src/plugin/
  zen.ts              # Hooks/PluginInput entry point, mirrors verdent.ts's role
  zen-accounts.ts      # ZenRegistry, ZenRouter, ZenVault, ZenAccount (mirrors verdent-accounts.ts)
  zen-governor.ts       # per-key quota/cooldown state machine (mirrors workbuddy-governor.ts,
                         # but Zen-specific: no model-entitlement tiers, just rate/credit tracking)
```

### 1. Credential intake (`ZenVault` / discovery)

Sources, in priority order (matches the Verdent env-token pattern at
`verdent-accounts.ts:403-428`):

- `ZEN_API_KEY` (single, back-compat with today's config)
- `ZEN_API_KEYS` (comma-separated list)
- `ZEN_API_KEY_2`, `ZEN_API_KEY_3`, ... numbered env vars
- An on-disk vault (`~/.local/share/opencode/zen/accounts.json` or similar,
  encrypted at rest the way `VerdentVault` does) for keys added via a CLI/TUI
  command (`opencode auth zen add <key>`), so this isn't env-var-only.

Each key becomes a `ZenAccount`: `{ id, label, apiKey, governor, source, mtime,
everUsed }`. Ordering for failover comes entirely from the governor's
`resetAt` plus this `everUsed` flag (below) — no separate load or
last-released bookkeeping needed.
`id` is a stable hash of the key (never the raw key) so accounts are
addressable in logs/UI without leaking secrets — same as
`stableVerdentIdentity`.

### 2. Governor (per-key state)

A trimmed-down version of `WorkBuddyEntitlementGovernor`. Responsibilities:

- Track observed rate-limit responses (HTTP 429) and hard quota errors
  (whatever Zen returns for exhausted balance — likely 402 or a specific error
  body) per key.
- Maintain a state machine: `READY -> COOLING_DOWN -> QUOTA_EXHAUSTED`, with
  reset timestamps parsed from response headers if Zen sends
  `x-ratelimit-reset` / `retry-after`, else exponential backoff learned from
  repeated failures (same estimation trick as `estimateZenFreeLimit` in
  `opencode-zen.ts`, which already does statistical limit-learning for the
  *free* tier — that logic is directly reusable per-key here).
- No model-entitlement tiers needed (unlike WorkBuddy) unless Zen itself gates
  specific models per key/plan — if it doesn't, this governor is strictly
  simpler: just "is this key usable right now."
- **The governor's `resetAt` is the router's ordering key.** This is the same
  `resetAt` timestamp already computed for the limits panel
  (`limits-panel.tsx:69,113,199-213` — every window row, including the free-tier
  and Verdent-style windows, resolves to a `resetAt`/`resetAfterSeconds` pair
  today). The Zen governor should compute and expose that identical value per
  key rather than inventing a second notion of "when this key comes back," so
  the router's failover ordering and the limits panel's displayed countdown
  are always reading the same number.

### 3. Router (session-bound key selection)

This is a direct copy of `VerdentRouter.select()`'s model, not a departure
from it — that's the whole point. One key per session, sticky:

- **Session affinity, always**: a session binds to exactly one key and every
  request from that session uses that key. Requests from the same session
  must never be split across keys concurrently — that's the failure mode to
  avoid, not a feature to add. This also keeps any provider-side prompt
  caching keyed by API key intact for the life of the session.
- **Automatic failover on exhaustion only, ordered by reset window — not
  load**: if the bound key's governor reports `QUOTA_EXHAUSTED` or a cooldown
  window, and only then, the router unbinds the session and rebinds it to
  the next key in a queue sorted by exactly two rules, applied in order:

  1. **Primary: `resetAt` ascending.** Whichever already-used key resets
     soonest goes first.
  2. **Never-yet-used keys always sort last**, below every already-used key,
     regardless of what their (nonexistent) reset window would be.

  So the queue looks like: `[key resetting soonest, ..., key resetting
  furthest out, ...untouched keys held in reserve]`.

  This is the opposite of "spread load evenly" — it's deliberately
  front-loading the keys closest to reset. Picking the soonest-to-reset key
  next means we come back around to it again sooner, so its reset events
  keep landing while it's in rotation instead of while it sits idle. Reach
  for an unused reserve key only once every already-used key has taken its
  turn: pulling in a fresh key early doesn't shorten anyone's reset window,
  it just adds a key whose window hasn't even started counting down, which
  is strictly worse for how soon the *pool* has a `READY` key on hand. This
  replaces `verdent-accounts.ts:660-666`'s in-flight/queued-load tie-break —
  Zen has no per-key concurrency signal worth balancing on. The switch
  happens between requests, not mid-flight — an in-progress request finishes
  on the key it started with.
- **Manual override**: the user can explicitly pin/switch a session to a
  specific key id at any time (mirrors `VerdentRouter.select()`'s
  `explicitAccountId` path), which then becomes the new sticky binding.
- **Where "parallel" comes from**: not from splitting one session's traffic
  across keys, but from *different sessions* independently binding to
  *different* keys. Today, with one shared key, every session queues behind
  the same rate limit; with N keys, up to N sessions can each have their own
  key and run without contending with each other. Concurrency is achieved
  by spreading sessions across keys, never by spreading one session's
  requests across keys.

### 4. Transport

Because Zen is already OpenAI-compatible and has no private protocol to
impersonate, this plugin does **not** need Verdent's loopback HTTP proxy. The
router can sit directly in front of the existing `@ai-sdk/openai-compatible`
client construction: pick an account, construct (or reuse a cached) client
instance with that account's `apiKey` and `baseURL`, dispatch. A loopback
proxy would only become necessary if we want to unify retry/failover logic in
one place across all callers (including callers that construct their own SDK
client) — worth deciding explicitly rather than copying Verdent's approach by
default.

### 5. Surfacing to the rest of the app

- `zenLimitSnapshot()` (mirrors `verdentLimitSnapshot` in `verdent.ts:98-111`):
  exposes per-key usage to the limits panel /
  `packages/app/src/pages/session/limits-panel.tsx` so the user can see which
  keys are healthy/exhausted, not just an aggregate.
- The existing `estimateZenFreeLimit` quota-estimation code in
  `quota/providers/opencode-zen.ts` currently assumes one account; it should
  be called once per `ZenAccount` and the results merged/labeled, the same
  way `verdentLimitSnapshot` maps over `verdentRegistry.all()`.
- Per key, the panel should show its position in the failover queue
  alongside its `resetAt`, so the user can see *why* the router will pick key
  B next and not just that key A is exhausted — the ordering should be
  legible, not a black box.

## Open questions to resolve before implementation

1. **What does Zen actually return on rate-limit / exhaustion?** Need to hit
   the real API (or check existing logs) to know if this is 429 + headers,
   402, or something else, before the governor's state machine can be
   written correctly — this is the single biggest unknown, and everything
   about backoff/cooldown timing depends on it.
2. **Does a Zen API key ever have model-level restrictions** (e.g. some keys
   are free-tier and can't hit paid models)? Determines whether the governor
   needs WorkBuddy's `canAdmitModel` concept or can skip it.
3. **Key storage**: is an on-disk vault wanted, or is env-var-only (`ZEN_API_KEYS`)
   sufficient for v1? Vault adds a CLI/UI surface (add/remove/list keys) that
   is real scope; env-only is a much smaller first cut and still delivers
   parallelism.
4. **Where does client construction currently happen for Zen?** — it wasn't
   found in `provider.ts` in this pass (only `zenmux` referenced); needs a
   proper trace of how a Zen provider config currently turns into an SDK
   client before the router can be spliced in at the right seam.

## Suggested incremental path

1. Env-only multi-key support (`ZEN_API_KEYS`) + governor + router, no vault,
   no UI — validates the failover/parallelism logic cheaply.
2. Per-key limits-panel surfacing, reusing the existing free-tier estimation
   code per key.
3. Vault + CLI management commands, once the shape has proven out.
