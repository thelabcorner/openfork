# T1 — Core Foundation (shared helpers + registry seam)

**Goal:** DRY pure helpers and a minimal quota registry that all later provider + UI work reuses. No visible UX change after this task.

## Context

- `../../../../packages/opencode/src/quota/format.ts` already has `toUsageWindow/buildResult/computeUsedPercent` but helpers for tone/color/countdown/display label live duplicated in `limits-panel.tsx` and `usage-gauge-v2.tsx` + `openrouter-free-usage-bar.tsx`.
- `../../../../packages/app/src/pages/session/limits-panel.tsx` is a monolithic 567-line file with inline `WindowRow/ProviderCard/LimitsPanelContent`.
- Future adapters must all speak the same `Adapter` contract (`registry.ts`) + `ProviderResult`.

## Files to Touch

- NEW `../../../../packages/app/src/utils/limits-format.ts` (or `packages/app/src/hooks/use-limits/format.ts`) — pure, testable.
- MOVE/DEDUP: extract `toneForRemaining`, `colorForTone`, `formatPercent`, `formatRemainingPercent`, `formatResetDate`, `formatCountdownSeconds`, `formatAge`, `displayWindowLabel`, `sortWindows` from `limits-panel.tsx` + `usage-gauge-v2.tsx`.
- KEEP `packages/opencode/src/quota/{schema,format,registry}.ts` as is; add re-export barrel if needed for free-report types.
- NEW `../../../../packages/app/src/hooks/use-limits/index.ts` *shell* (empty hook that today just wraps `sdk.client.quota` vs later merges fork+free). Stubbed to prove seam exists.

## Steps

1. Create `utils/limits-format.ts` with pure functions + unit-test file `limits-format.test.ts` (no React/Solid).
2. Patch `usage-gauge-v2.tsx` and `limits-panel.tsx` to import from it (delete local duplicates).
3. Create `hooks/use-limits/index.ts` returning `{providers:[], isLoading:false}` stub plus `useQuotaShell` (thin over `sdk.client.quota.providers/get`). Wire `LimitsPanelContent` to use it (still fetches same 4 adapters) to prove hook seam.
4. Ensure `registry.resolveAdapter` alias handling (case-insensitive) stays covered (existing `registry.test.ts`).

## Acceptance

- [ ] `bun test packages/app -- limits-format` passes; `bun typecheck` green.
- [ ] `limits-panel` visually unchanged (use snapshot or manual open).
- [ ] Helper file has 100% pure-function coverage for countdown/percent/age edge cases (null, 0, negative, >100).
- [ ] Hook stub has no network-side behavior change (`/quota/providers` still returns same 4 adapters).

## Risk

- Locale helpers (`language.t` inside `displayWindowLabel`) need `intl` param vs `useLanguage()` inside pure file → keep formatting pure + translate at call site. Do not let pure helper import `useLanguage`.
