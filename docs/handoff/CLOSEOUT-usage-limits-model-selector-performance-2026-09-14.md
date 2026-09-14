# Usage / Limits / Model Selector performance campaign — evidence ledger

Date: 2026-09-14

## Scope and worktree safety

The campaign is scoped to the Usage dashboard, Limits projection/fetch lifecycle, and `dialog-select-model.tsx`. The worktree was already heavily dirty from concurrent campaigns; no reset, restore, clean, stash, commit, or push was performed. Scoped files were re-read before mutation and concurrent edits were preserved.

## Changes made

### Usage

- Bounded the large model, session, and maintenance-model detail tables to 200 initially, with explicit 200-row progressive expansion. The underlying data remains complete and sorting/filtering still operates on the full data set; only DOM admission is bounded.
- Converted repeated chart geometry and punchcard maxima to Solid memos so hover reads reuse structural chart projection instead of rescanning/rebuilding period arrays.
- Corrected Usage summary cache identity so refresh is an invalidation revision rather than part of the logical `(window, project)` cache key. This prevents refresh revisions from permanently fragmenting the client cache.
- Added a browser benchmark fixture covering 1,000 models / 1,000 maintenance rows / 400 periods and request-count invariants.

### Limits

- Added an explicit `active` lifecycle gate to `useLimits`.
- Provider discovery, provider quota fanout, and focus-triggered refresh are now suppressed while an owning surface is inactive.
- Context-pane Limits passes its tab-active accessor; the model selector passes `store.open`. The standalone Limits pane keeps its existing mount/unmount lifecycle.
- The existing shared `useNow` clock already has one global timer and the pane already passed `now` down to countdown leaves. This campaign preserved that architecture rather than introducing per-row timers.

### Model selector

- Replaced recents membership's per-recent `.some()` scan with a single model-key `Set`.
- Added one memoized render-row navigation index and reused it for virtualizer active-row retention and selected-row reveal, removing repeated full render-row scans / index-map rebuilds from interaction paths.
- Model-selector-owned limits polling is now inactive while the selector is closed.
- Added a browser benchmark fixture intended to measure cold/warm open, post-debounce search work, mounted option count, and quota request deltas at configurable catalog sizes.

## Evidence ledger

| Surface | Dataset / method | Evidence |
|---|---|---|
| Usage browser | Chromium production build; 1,000 models, 1,000 maintenance models, 400 periods | PASS. `initialVisibleMs=569.68`, `modelsSwitchMs=107.10`, `activitySwitchMs=96.30`, `maintenanceSwitchMs=68.80`, `searchMs=16.40`, `overviewNodes=332`, `modelsNodes=2637`, filtered `searchNodes=248`, `maintenanceNodes=2232`, `usageRequests=1`. These are post-patch measurements only and are **not** represented as before/after deltas. |
| Usage request invariant | Same browser run | Tab navigation produced exactly one Usage summary request total. |
| Focused correctness | Bun/Solid unit suite | 54 tests passed, 0 failed across selector search/order/accounts, usage-yield, usage grouping/identity, and subsidy semantics. |
| Production build | `bun run build` | Completed successfully during benchmark web-server build. |
| Package typecheck | `bun run typecheck` | Blocked by pre-existing unrelated repo failures including React imports in `context-history` / `context-ledger`, SDK inferred-type serialization, server-session test type drift, and chat-sidebar types. No campaign file appeared in the reported errors. |
| Model selector browser harness | 644-model fixture | Re-run on isolated ports `3107/4197` after adding the selector search hook completed the production build and cleared the old selector-input locator blocker, but still stopped before measurement because the benchmark's earlier home-ready locator (`[data-action="home-add-project-row"]`) was not present. This remains a benchmark-harness/precondition blocker, not evidence of selector latency; no latency number is claimed. |

## Adversarial audit / remaining work

The current Usage browser result proves bounded DOM admission and request locality, but it does not yet provide a valid pre-patch A/B baseline. The selector benchmark must be repaired to target the actual V2 search element and then run at 644 / 1,000 / 2,000 models with repeated cold/warm samples. A dedicated Limits browser fixture should likewise measure 1-second tick CPU, hidden-tab request suppression, 50-provider / hundreds-window DOM behavior, and concurrent Limits + selector request fanout.

One architectural issue remains larger than this patch: `useLimits()` is still instantiated independently by the composer, Limits pane, and selector. Server caching prevents the worst upstream pressure, and inactive gating now removes closed-selector/hidden-tab work, but true renderer-side single-flight/shared snapshot ownership would require a carefully scoped resource context. That should be implemented only with browser request evidence because a giant global quota memo would trade request deduplication for broad invalidation and lifetime retention.

No claim is made that the campaign is fully closed until those browser measurements exist. The code changes above are deliberately evidence-bounded rather than declaring unmeasured wins.
