# T2 — Generalise the per-account usage hook (and give Verdent one)

**Goal:** One descriptor-driven hook that answers "what is this account's headroom for this
model" for any multi-account provider. WorkBuddy behaviour must not change; Verdent gains a
usage surface it has never had.

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

Verdent has `usage.verdentAccounts[]` on the quota result
(`quota/providers/verdent.ts:203-210`, `limits-format.ts:82-86`) and **zero** picker-side
consumption — `dialog-select-model.tsx` never mentions verdent. So Verdent rows show no
bar, no rate, no promo badge today.

## Files to touch

- NEW `packages/app/src/hooks/use-account-usage/index.ts` — the generalised core,
  parameterised by `MultiAccountProvider`.
- NEW `packages/app/src/hooks/use-account-usage/index.test.ts` — fixture-driven.
- EDIT `packages/app/src/hooks/use-workbuddy-usage/index.ts` — becomes a thin binding
  (`useAccountUsage(MULTI_ACCOUNT_PROVIDERS.workbuddy)`) that re-exports the existing types
  and function names so the three call sites in `dialog-select-model.tsx` are untouched.
- NEW `packages/app/src/hooks/use-verdent-usage.ts` — the Verdent binding.
- EDIT `packages/app/src/utils/limits-format.ts` — if `verdentAccounts` needs a helper
  equivalent to `workBuddyCredits` / `workBuddyAccountCreditsExhausted`, add it there
  (pure, tested), do not inline it in the hook.

## Steps

1. Extract the core with the provider descriptor as input: `accountsField`,
   `headroomKind`, and the account-label map drive every WorkBuddy-specific branch.
2. Keep the two funding modes explicit:
   - `credits` (WorkBuddy): pool balance ÷ rate, with the "0 credits blocks even free
     models" rule (:255-262) preserved verbatim — it is a real Tencent behaviour, not a
     heuristic;
   - `window` (Verdent): per-(account,model) `remainingEstimate`/`remainingPercent` only.
3. Normalize the output to `AccountOption`-shaped data (ARCHITECTURE §6.1) *in addition to*
   the legacy `WorkBuddyModelUsage` shape, so T5/T7 consume the new shape while today's
   rows keep working.
4. Guard the "hook instantiated outside a limits-capable tree" path exactly as today
   (:113-133) — the picker is mounted from stories and the home view.
5. Wire the Verdent binding into `dialog-select-model.tsx`'s `usageFor` via the descriptor
   lookup, replacing the `provider.id === "workbuddy"` branch at `:1683-1704` with a
   registry lookup that returns the right hook's data.

## Acceptance

- [ ] WorkBuddy rows are pixel-identical before/after (bars, `~requests`, promo badge,
      `x0.00` rate, tooltip account line).
- [ ] Verdent rows now render a headroom bar and reset countdown driven by
      `usage.verdentAccounts`.
- [ ] Exactly one `useLimits()`-owning hook instance per selector view (assert with a spy
      in the test; the file's own comment at `:113` warns about this).
- [ ] `use-account-usage` tests cover: no quota, quota without accounts, one account, many
      accounts, promo-free model, 0-credit account, unknown rate.

## Risk

- **Behavioural drift in the promo branch.** The free-model path has three interacting
  rules (per-model window, pool exhaustion, best-account pick). Port it as a whole, with
  its comments, and add a fixture per rule *before* refactoring.
- Verdent's governor seeds WorkBuddy's hy3/hy4 placeholder rows; `verdentLimitSnapshot`
  filters them server-side (`verdent.ts:104`) but the hook must not assume that filter
  exists on older servers — drop reports whose model id is not in the Verdent catalog.
