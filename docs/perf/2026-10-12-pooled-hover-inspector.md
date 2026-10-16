# Tab and chat sidebar hover inspector — pooled ownership and cache audit

Date: 2026-10-12. Scope: `packages/app` renderer. No backend/API changes.

## Regression mechanism

The original titlebar rendered one independent hover owner per session and group tab. Each owner had its own timer/open signal and Kobalte HoverCard portal. A global "warm hover" timestamp did not provide mutual exclusion. Several cards could remain on screen at once, and lazy popover wrappers could change tab DOM ownership while click gestures were in flight.

## Current ownership

- **Titlebar:** `TitlebarTabStrip` owns one `createTabPreviewController`, delegated pointer events on the strip, and one lazy `TabPreviewPopover`. Session and group tabs are plain stable link/button trees: no per-tab hover controllers or portalled cards. Once first requested, one physical `SessionPreviewCard`/virtualizer remains mounted, hidden while dormant.
- **Chat sidebar:** one pane-level delegated tooltip controller. The tooltip shell mounts after first request; the rich `SessionPreviewCard` mounts after first session hover and is then reused across row hovers, hidden between them. Plain-text tooltips remain separate presentation within that same tooltip shell.
- Both pooled cards gate their live status clock and telemetry while not active. Titlebar global resize/scroll and loss-of-focus listeners are present only during an active preview, without reinstalling them as tabs change. Sidebar positioning listeners are similarly active-only.
- A forced dismissal resets context-menu/pointer locks, including when an underlying tab is clicked, dragged, closed, or app focus is lost. Portalled-card hover grace preserves interactive crossing without retaining old popovers.
- A single `SessionPreviewCard` implementation remains canonical for the two surfaces.

## Cache policy

`session-preview-cache.ts` derives relationships once per session ID and authoritative immutable group snapshot. The `WeakMap` snapshot key avoids retaining historical group revisions. Each source bucket holds at most 24 recently used session projections, with LRU eviction. Group-only projections use group-object weak keys. Session-group membership indexes already use producer-owned weak snapshot caching; this adds reuse of the *downstream derived trees*.

Execution/status/telemetry data stays live and is **not** frozen inside a time-to-live cache. Remote-server group snapshots are produced and observed by `SessionGroupsProvider`, not fetched per tab.

## Reproducible synthetic benchmark

Run `bun --conditions=solid scripts/bench-session-preview-cache.ts` from `packages/app`.

Fixture: 64 subagent groups with 16 workers per group, 16 hot session IDs, 1000 lookups per path, existing group index construction excluded.

| Path | Wall time | Throughput |
|---|---:|---:|
| Recompute session relationship projection | 101.331 ms | 9,869 lookups/s |
| Reuse cached projection | 0.334 ms | 2,995,806 lookups/s |

Observed **303.6x warm-path speedup for the isolated model lookup**. This does not measure GPU paint, Electron interaction latency, cold first-hover duration, or heap retention. It must not be presented as end-to-end UI speedup.

## Verification and limitations

- `bun run typecheck` in `packages/app`: passes after pooling, cache and inactive-lifecycle changes.
- Targeted hover-controller, timing, cache and model tests pass (37 tests across 3 files in one run).
- `bun test --conditions=browser --preload ./happydom.ts ./src/components/session-preview`: 40 passed.
- Broad sidebar suite with browser condition: 242 passed, 5 `jsxDEV` module export errors on TSX module imports (not an application test assertion failure). The non-browser condition has separate expected client-reactivity failures; use appropriate DOM conditions when assessing those tests.
- Live renderer CDP was unavailable at `127.0.0.1:9222`; no running Electron instance was restarted or modified. Visual/interactive smoke-testing inside the actual Electron renderer remains a separate verification gate.

## Smoke-test matrix when a renderer is already available

Rapidly traverse 20+ session/group tabs; assert exactly one `[data-component="session-tab-popover"]`, stable card identity, and correct content on each transition. Click tab bodies and X buttons while hovering. Test stopped/working tabs, groups, special-agent/session children, same/different servers, drag reorder, off-screen tabs, close while menu open, fullscreen/window blur, theme switching, and sidebar rich/text hover transitions. Reopen the same group after membership changes to confirm fresh tree content.
