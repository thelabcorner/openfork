# T8 — Limits Panel Premium UX (depletion-anxiety, filtered, dense)

**Goal:** Rich, dense, premium pane (ShadCN zinc/new-york, Obsidian/Linear/Square/Vercel/Notion) that renders `useLimits()` with anxiety-inducing depletion and live reset countdowns.

## Current (T1)

- `_limits-panel.tsx` monolith → `ProviderCard` + `WindowRow` inline, mixed helpers.
- Shows `configured:false` dashed cards.

## Desired (faithful to OpenChamber dropdown + key-switcher)

Premium details from prompt:
- Show `X% remaining` opposed to `Y% used` (not just `Y% used`).
- Show countdowns to reset (take inspiration from key-switcher `UsageBreakdownV2`).
- Obsidian/Linear/Square/Vercel/Notion-esque: dense 10-11px, tight `gap-1.5/p-2.5`, zinc borders, tabular-nums, subtle `bg-layer-01/03`, `rounded-[8px]`.

## Files

- REFACTOR `packages/app/src/pages/session/limits-panel.tsx` → split into `components/limits/{ProviderCard, WindowRow, GoCredentialCards}.tsx` or keep inline but cleaned, now purely presentational.
- EDIT `packages/app/src/i18n/en.ts` — already added `limits.panel.subtitle`, `limits.remaining*`, `limits.allHealthy/attentionNeeded`, etc. Add any missing microcopy (e.g., `limits.countdown.never`).
- REUSE `utils/limits-format.ts` for `toneForRemaining/colorForTone/formatCountdown/formatResetDate`.

## Layout Spec

**Container:** `ScrollView` `p-2.5 gap-2.5` stacked cards. Top subheader `limits.panel.subtitle` + `atRiskCount` (`All healthy — no pressure` vs `2 providers needs attention`) + `N providers · Refresh Xs`.

**ProviderCard** (per `LimitProvider` from `useLimits`):
```
┌─ ProviderHeader ─────────────────────────────────┐
│ ProviderIcon  Claude                [58%? worst] │
│             Updated 2m ago · Active  ● tone dot │
└───────────────────────────────────────────────────┘
├─ Windows (sorted) ───────────────────────────────┤
│ 5-Hour   Resets in 2h 14m 12s  (icon outline-reset)
│ 58% used vs 42% remaining  [depletion bar 58% fill, warning color]
│ Sun, Aug 22 12:00  → 42% remaining (large)      │
│ ─────────────────────────────────────────────── │
│ 7-Day    Resets in 5d 3h …                      │
│ Weekly   18% used · 82% remaining               │
└───────────────────────────────────────────────────┘
```

- **Balance-only** windows (`credits` / `credits_balance`): single row `Credits: $9.85 left · $0.15 spent` (no bar, `valueLabel` only).
- **Go sub-cards**: when `goByCredential.length>1`, render aggregate `OpenCode Go — All keys` then subcards `Go — <label>` with same WindowRow shape plus `29 calls` subtitle (reuse `ForkWindowUsage.callsInWindow` under label, like `UsageBreakdownV2` shows `language.plural("usage.calls", callsInWindow)`).
- **Depletion anxiety:** remaining percent `13px 700` in tone color; used `10px 440 faint` ·; bar fill = `used%`; tone `danger ≤10%` else `warning ≤30%` else `success`; urgency label `Critical/At risk/Healthy` bottom row.

**OpenRouter additive:** inside OpenRouter card, after credits row, embed `FreeUsageBar` (already has `remaining/limit`, bar, countdown, burnRate, projection, model table) when `openRouterFree` present — reuse component, not re-implement.

**Live countdown:** `formatCountdownSeconds(resetSeconds, language)` ticks via `useNow()` (global second-aligned). Absolute date `formatResetDate(resetAt, intl)` shown right-aligned with tooltip.

## Steps

1. Replace `LimitsPanelContent` body: `const {providers, goByCredential, isLoading, error, refresh, isCoolingDown} = useLimits()`; remove old `createResource(providers)+Promise.all`.
2. Delete `configured:false` branch (hook already filtered); keep `ok:false` red block for configured-but-error.
3. Extract `WindowRow` to its own component file importing `limits-format.ts`; ensure `valueLabel`-only vs `%` branch.
4. Add Go multi-key rendering (conditional on `providerId==="opencode-go" && goByCredential.length>1`).
5. Add OpenRouter free merge (import `FreeUsageBar/FreeUsageModelsTable` from `openrouter-free-usage-bar.tsx`).
6. Density audit: ensure all text `10-11px`, `tracking-[0.03-0.04em] uppercase` for labels, `tabular-nums` for numbers, `rounded-[8px] border border-v2-border-border-muted` cards, `bg-v2-background-bg-layer-01` rows — align with `SessionContextTab` / `UsageBreakdownV2` density.

## Acceptance

- [ ] Non-connected providers absent (create auth with only openrouter+opencode-go, verify only 2 cards).
- [ ] 3 Go keys added → pane shows 4 Go cards (1 aggregate + 3 labeled), each matching key-switcher numbers.
- [ ] OpenRouter card shows both `$9.85 left · $0.15 spent` **and** free `67 / 200` bar+countdown when free tracker present.
- [ ] Every percent window shows `X% remaining` large + `Y% used` small + bar + `Critical/At risk/Healthy` + live `Resets in …` ticking.
- [ ] No direct `sdk` calls left in panel; all via `useLimits`.
- [ ] `bun typecheck` + visual snapshot matches design (dense zinc, not airy).
