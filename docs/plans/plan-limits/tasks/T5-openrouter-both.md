# T5 — OpenRouter: Credits + Free (both in one card)

**Goal:** OpenRouter card shows `credits: $X left · $Y spent` (like `codex` credits) **and** free-usage `remaining/limit/percent + model breakdown` using the existing `OpenRouterFreeUsageTracker`.

## Current

- `providers/openrouter.ts` returns single window `credits: toUsageWindow({usedPercent:null, valueLabel:"$18.93 of $19.99 remaining"})` — inconsistent with screenshot + OpenChamber which renders `"$9.85 left · $0.15 spent"` (remaining + spent, not remaining-of-total).
- Free usage (`FreeUsageReport`) is fetched via `experimental.openrouterFreeUsage` but never merged into limits pane; `FreeUsageBar` is used elsewhere (models panel, context tab) standalone.

## Files

- EDIT `../../../../packages/opencode/src/quota/providers/openrouter.ts` — fix `valueLabel` to `"$${formatMoney(remaining)} left · $${formatMoney(totalUsage)} spent"` (match OpenChamber + `../../../handoff/HANDOFF-quota-reimplementation.md` note). Keep `usedPercent:null` (balance metric).
- NEW `packages/app/src/hooks/use-limits/free-merge.ts` or inline in `useLimits` — merges `FreeUsageReport` into synthetic window(s) for the OpenRouter card.
- EDIT `../../../../packages/app/src/hooks/use-limits/index.ts` — add `openRouterFree` branch.
- EDIT `packages/app/src/components/limits/*` — render both stacked: top `Credits` row, bottom `Free Usage` rich block.

## Steps

1. Patch `openrouter.ts` valueLabel: `remaining = total_credits - total_usage`; `label = "$"+formatMoney(remaining)+" left · $"+formatMoney(totalUsage)+" spent"` (per `openrouter.js` upstream). Add test assert for this exact string (covers screenshot).
2. In `useLimits`, add `freeReport = useOpenRouterFreeUsage({enabled: isConfigured("openrouter")})` (already has heartbeat/visibility). When `freeReport.data` present and `status !== "depleted"`? Always show if present.
3. Convert free report to window(s): primary `free: toUsageWindow({usedPercent: 100-freeReport.free.remainingPercent, resetAt: new Date(freeReport.free.window.resetsAt).getTime()})` but display via `FreeUsageBar` rich component instead of generic progress bar (reuse existing `FreeUsageBar` + `FreeUsageModelsTable` components directly inside OpenRouter card — don’t reinvent). This gives the premium model breakdown required.
4. Card layout (inside OpenRouter `ProviderCard` expansion):
   ```
   OpenRouter
     Credits   $9.85 left · $0.15 spent    [balance row, no bar, no countdown]
     ─────────────────────────────────
     Free Usage   42% remaining  (Generic WindowRow OR FreeUsageBar)
       67 / 200 requests · resets in 5h 12m · Fri Aug 22 23:00
       [bar 67% used → 33% remaining, warning color]
       Models table  claude-3.5  12 req  1.2k tokens  $0.03
   ```
   Choose `FreeUsageBar` when `freeReport` present (already has tone, burnRate, projection). Fall back to generic window if tracker disabled.

## Acceptance

- [ ] With `openrouter` API key present and credits `{total_credits:"10", total_usage:"0.15"}` → card shows `"$9.85 left · $0.15 spent"` (not `"of remaining"`).
- [ ] With same key and free tracker enabled (`OPENROUTER_MANAGEMENT_KEY` or default), card additionally shows `Free Usage` block with `remaining/limit`, live countdown (`window.secondsUntilReset`), and model table (no duplication in other cards).
- [ ] When free report is `undefined` (no key or tracker not configured) → only credits row shows, no crash.
- [ ] Filtering unchanged: OpenRouter appears only when `openrouter` configured; free block is additive inside that card, not a second card when disconnected.

## Note

- Keep `FreeUsageReport` types from `../../../../packages/opencode/src/openrouter/free-usage/types.ts` — do not duplicate schema. Import `FreeUsageBar` directly.
