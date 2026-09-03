# T3 — Server: account-routing snapshot endpoint + bare-id catalog union

**Goal:** Give the renderer a live, advisory view of account eligibility and session
bindings, and fix the catalog gap that makes "Auto" unavailable for some models.

## Context

Everything the UI needs already exists in-process; it is just not reachable from the
renderer:

- `accountRegistry.all()` / `snapshot()` and `accountRouter.bindingsSnapshot()` are served
  on the plugin's own loopback proxy at `/health` and `/metrics`
  (`plugin/workbuddy.ts:1055-1077`) — a debug surface, not an API.
- `governor.metrics()` (`workbuddy-governor.ts:881-902`) carries `state`, `cooldownUntil`,
  `packageCreditsRemaining` and per-model reports.
- `workbuddyLimitSnapshot()` / `verdentLimitSnapshot()` already export the non-secret
  per-account model reports (`workbuddy.ts:211-220`, `verdent.ts:97-106`).

**The catalog gap.** `WorkBuddyPlugin.models()` emits bare (auto-routable) ids only for
`accounts[0]`'s catalog (`workbuddy.ts:1253-1261`). A model that only account #2 is
entitled to therefore has **no** bare id, so the collapsed row would have no Auto option —
even though `AccountRouter.select()` already filters candidates by `account.catalog.ids`
(`workbuddy-accounts.ts:592-597`) and would route it correctly.

## Files to touch

- EDIT `packages/opencode/src/plugin/workbuddy.ts` — bare ids over the **union** of all
  accounts' catalogs (dedupe by id; keep per-account ids as-is).
- NEW `packages/opencode/src/server/.../handlers/experimental.ts` (edit) + group entry in
  `.../groups/experimental.ts` next to `openrouterEndpoints` (`:243-246`).
- NEW `packages/opencode/src/plugin/account-registry-index.ts` — a tiny registry mapping
  `providerId -> { accounts(), bindings(), unbind(session) }` so the handler does not import
  plugin internals per provider.
- EDIT `packages/opencode/src/server/.../experimental.ts` capabilities response — add
  `accountRoutingPolicies: string[]` (empty until T4).
- EDIT `packages/sdk/js/src/v2/gen/*` — regenerate.

## API

```
GET /experimental/account-routing?provider=workbuddy[&session=<id>][&model=<id>]
200 {
  ok: true,
  provider: "workbuddy",
  policies: ["sticky"],                       // widened by T4
  boundAccountId: "wb-3f1c9a" | null,         // for the given session
  accounts: [{
    id, label, state, cooldownUntil, hasKnownCredits, packageCreditsRemaining,
    servesModel: true | false | null,
    modelWindow: { remainingPercent, usedObserved, resetAt, limited } | null,
  }],
  preview: { sticky: "wb-3f1c9a", ... } | null   // filled by T4
}
```

Failure is **never** a 5xx surprise for the UI: unknown provider → `{ ok:false, reason }`
with 200, matching the quota envelope discipline
(`docs/plans/plan-limits/ARCHITECTURE.md` §1).

## Steps

1. Catalog union fix + a test asserting a model present only on account #2 gets a bare id.
2. Registry index + handler. In-process reads only — do **not** HTTP to the loopback proxy.
3. `unbind` route: `accountRouter.unbind(session)` for the given provider; returns the new
   binding state.
4. Capabilities field, defaulting to `["sticky"]` so an older renderer sees a truthful
   (single-policy) answer.
5. Never leak secrets: no tokens, no `authPath`, no `uid` beyond what `accountLabels()`
   already exposes. Add an assertion test on the serialized payload keys.

## Acceptance

- [ ] `GET /experimental/account-routing?provider=workbuddy` returns accounts + bindings on
      a machine with ≥1 enrolled account, and `{ok:false}` on one with none.
- [ ] Payload contains no credential material (key-allowlist test).
- [ ] A model entitled only to a non-first account now has a bare id in `provider.models`.
- [ ] Renderer with the endpoint stubbed out (404) still works — verified in T5/T6 by the
      tier-`quota` story.
- [ ] SDK types regenerated and committed.

## Risk

- **Enumeration cost.** `catalogFor(account)` can hit the network per account
  (`workbuddy.ts:787-819`). The handler must use the *cached* catalog only
  (`account.catalog` / `discoveryCache`) and never trigger discovery, or opening the picker
  fans out N HTTP calls.
- Session id availability: the renderer must pass the current session so `boundAccountId`
  is meaningful; when absent, return `null` rather than a random binding.
