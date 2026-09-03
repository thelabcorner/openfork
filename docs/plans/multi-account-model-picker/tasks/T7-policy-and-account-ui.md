# T7 — Policy section, rich account rows, footer

**Goal:** The premium surface. Everything in UX-SPEC §3 renders with live data, and "Auto"
tells the truth about which account it will use.

**Do not start until T4's endpoint returns real `preview` values** (ADR-3).

## Files to touch

- NEW `packages/app/src/hooks/use-account-routing/index.ts` + test — merges
  `useLimits()` (T2 output) with `sdk.client.experimental.accountRouting` (T3) and exposes
  the degradation tier.
- NEW `packages/app/src/utils/account-policy-preview.ts` + test — the renderer mirror of
  `rankAccounts` used at tier `quota`.
- EDIT `packages/app/src/components/model-account-submenu.tsx` — `AutoPolicySection`,
  full `AccountOptionList` rows, `AccountSubmenuFooter`.
- EDIT `packages/app/src/context/models.tsx` — `accountPolicy: Record<providerID, AutoPolicy>`
  store + getter/setter, persisted like `subProvider` (`:206-214`) but **separate** from it
  (ADR-5).
- EDIT `packages/app/src/i18n/en.ts` — the full key block from UX-SPEC §8.

## Steps

1. **Hook.** One instance in `ModelSelectorPopoverV2View`; single-flight the routing fetch
   per (provider, session) and refresh it on popover open, not on hover. Expose
   `source(): "routing" | "quota" | "labels"`.
2. **Policy section.** Radio rows for each advertised policy; second-line preview text per
   UX-SPEC §3.1, with the " · estimated" suffix at tier `quota`. Hide unadvertised policies.
   Selecting a policy writes the per-provider preference **and** selects the corresponding
   model id in one action.
3. **Account rows.** Two-line layout matching `OpenRouterEndpointList`'s geometry
   (`:487-500`): state dot (`colorFor` from `usage-gauge-v2`), label, `[Bound]`/`[Best]`
   badge, mini bar, percent, check; second line = credits/requests + reset, or the block
   reason. Disabled rows keep a live countdown driven by the view's existing minute tick
   (`createPolled`, `:1421`) — never a per-row timer.
4. **Ordering.** From `rankAccounts` (or the mirror). Freeze the order while the submenu is
   open, mirroring `openOrder` in the list.
5. **Rebind toast.** When pinning an account inside an active session that is bound
   elsewhere, show the one-line toast from UX-SPEC §3.2 via `utils/toast`. Once per pin, not
   once per render.
6. **Footer.** "Use for all {Provider} models" checkbox (writes the provider default) and
   "Manage accounts…" (opens the provider's auth surface). Add the cold-start note at tiers
   `quota`/`labels`.
7. **Collapsed-row numbers follow the same source** (UX-SPEC §2): the row's bar/`~requests`
   describe the account that Enter would use. Route both through one memo so they cannot
   disagree.

## Acceptance

- [ ] Each policy row names the account the server would actually pick — verified against
      `/experimental/account-routing`'s `preview` in a test, and manually for one send per
      policy.
- [ ] With the routing endpoint disabled, everything still renders with " · estimated" and
      no bound badge.
- [ ] Blocked accounts state *why*, in text, with a real clock time.
- [ ] "Use for all" makes a newly selected model of the same provider inherit the pin/policy.
- [ ] Pinning mid-session shows the rebind toast exactly once.
- [ ] No provider-id literal added to `dialog-select-model.tsx` (grep check in review).

## Risk

- **Preview drift** is the feature's core risk. Mitigate with: the shared ranker (T4), the
  parity test (T10), and the explicit "estimated" label whenever the source is not the
  server.
- **Over-refresh.** The routing snapshot must not poll on a timer while the popover is open;
  quota already polls. Refresh on open + on explicit user action only.
- Emails are long. Enforce truncation at every level (chip 72px, label flex-1 truncate,
  badge and percent `shrink-0`) and add the 40-char story.
