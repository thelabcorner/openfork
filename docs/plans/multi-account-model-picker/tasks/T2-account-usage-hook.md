# T2 — Generalise the per-account usage hook into `use-account-usage`

**Goal:** One descriptor-driven hook that answers "what is this account's headroom for this
model" for any multi-account provider. WorkBuddy behaviour must not change.

**Scope note.** The second-provider adoption half of this task is retired: that provider is
no longer part of OpenFork, so there is no second binding, quota field or picker surface to
build. What survives is the generalisation below — the hook becomes descriptor-parameterised,
and the renderer keeps a documented path for the next multi-account provider.

## Context

`packages/app/src/hooks/use-workbuddy-usage/index.ts` (350 lines) already implements almost
everything this feature needs, but hardcoded to WorkBuddy:

- `accounts()` — per-account balances, richest first;
- `rateFor(modelID)` — published vs **observed** credits/request (`observedRateFor`, :207);
- `forModel(modelID)` — the funding-source resolution, including the subtle promo-model
  branch (free models draw from the per-(account,model) 24h window, not the credit pool,
  :253-296) and the "pool row must pick the way the router picks" comment (:267-274);
- `modelVariants(modelID)` — already returns pool + one entry per account (:338-349),
  consumed at `dialog-select-model.tsx:195` and `:2006` for bar normalisation.

Everything provider-specific in that hook is already covered by two descriptor fields —
`accountsField` and `headroomKind` (PROVIDER-MATRIX §2) — so the hook is one extraction away
from being provider-agnostic, and a provider with no picker-side usage surface today is the
case this generalisation exists to cover.

## Files to touch

- NEW `packages/app/src/hooks/use-account-usage/index.ts` — the generalised core,
  parameterised by `MultiAccountProvider`.
- NEW `packages/app/src/hooks/use-account-usage/index.test.ts` — fixture-driven, including a
  fixture driven by a **second, non-WorkBuddy descriptor** so the generalisation is proven
  rather than asserted.
- EDIT `packages/app/src/hooks/use-workbuddy-usage/index.ts` — becomes a thin binding
  (`useAccountUsage(MULTI_ACCOUNT_PROVIDERS.workbuddy)`) that re-exports the existing types
  and function names so the three call sites in `dialog-select-model.tsx` are untouched.
- EDIT `packages/app/src/utils/limits-format.ts` — a provider's `accountsField` helper goes
  here (pure, tested), equivalent to `workBuddyCredits` /
  `workBuddyAccountCreditsExhausted`; do not inline funding maths in the hook.

## Steps

1. Extract the core with the provider descriptor as input: `accountsField`,
   `headroomKind`, and the account-label map drive every WorkBuddy-specific branch.
2. Keep the two funding modes explicit:
   - `credits`: pool balance ÷ rate, with the "0 credits blocks even free models" rule
     (:255-262) preserved verbatim — it is a real Tencent behaviour, not a heuristic;
   - `window`: per-(account,model) `remainingEstimate`/`remainingPercent` only. No current
     provider uses it, but it is the reason the descriptor has a `headroomKind`.
3. Normalize the output to `AccountOption`-shaped data (ARCHITECTURE §6.1) *in addition to*
   the legacy `WorkBuddyModelUsage` shape, so T5/T7 consume the new shape while today's
   rows keep working.
4. Guard the "hook instantiated outside a limits-capable tree" path exactly as today
   (:113-133) — the picker is mounted from stories and the home view.
5. Make `dialog-select-model.tsx`'s `usageFor` resolve through the registry: replace the
   `provider.id === "workbuddy"` branch at `:1683-1704` with a descriptor lookup that
   returns the right binding's data, so the next provider is a registry entry, not a branch.

## Acceptance

- [ ] WorkBuddy rows are pixel-identical before/after (bars, `~requests`, promo badge,
      `x0.00` rate, tooltip account line).
- [ ] Every registered descriptor resolves a binding, and an unregistered provider id falls
      through to today's path with no special case.
- [ ] `grep -rn 'provider.id ===' packages/app/src/hooks` returns no new hit.
- [ ] Exactly one `useLimits()`-owning hook instance per selector view (assert with a spy
      in the test; the file's own comment at `:113` warns about this).
- [ ] `use-account-usage` tests cover: no quota, quota without accounts, one account, many
      accounts, promo-free model, 0-credit account, unknown rate, and a second descriptor.

## Risk

- **Behavioural drift in the promo branch.** The free-model path has three interacting
  rules (per-model window, pool exhaustion, best-account pick). Port it as a whole, with
  its comments, and add a fixture per rule *before* refactoring.
- A provider's server-side limit snapshot may seed placeholder rows the picker must not show
  (`workbuddyLimitSnapshot` filters its own). The hook must not assume any such filter
  exists on older servers — drop reports whose model id is not in the provider's catalog.
