# OpenFork right-click menu optimization — 2026-10-10

## Ownership and scope

The primary UI is V2/new layout; production runtime may remain V1. UI components must consume supplied state, not hydrate sessions or provider catalogs merely to decorate rows. This pass followed `packages/app/AGENTS.md` and `packages/ui/AGENTS.md` and did not restart desktop or server processes.

Existing edits to `session-context-menu.tsx`, `session-menu-model.ts`, and `session-model-picker-runtime.tsx` belong to concurrent work. They were inspected but **not rewritten, staged, or committed** by this pass.

## Entry-point inventory

| Host | Initial assessment | This pass |
| --- | --- | --- |
| Home session rows | Full `SessionContextMenu` graph attached to every rendered row | Demand-loaded menu owner at click coordinates; idle row keeps only a cursor signal and handler |
| Chats sidebar sessions/groups | Lazy cursor mode already installed | Preserved concurrent edits |
| Titlebar session/group tabs | Lazy cursor mode already installed | Keyboard anchor fallback and request-identity close guard |
| Project explorer tree | Controlled cursor-anchored file menu | Benefits from shared keyed renderer |
| Browser tab menu | Native Kobalte context owner per tab | Benefits from shared keyed renderer; per-tab ownership still remains |
| Generic right-click fallback | Demand-loaded, captures selection snapshot before popup opens | Keyboard anchor fallback |
| OXP activity | Controlled cursor menu with guarded busy actions | Reviewed; no changes |
| Terminal tabs | Mixed native and controlled menu paths | Reviewed; no changes |

## Implemented mechanics

1. `session-menu/menu-reconciliation.ts` supplies a shared live Solid store reconciled by domain IDs, including nested submenu item IDs. Model mutations update item properties and current action callbacks while the item identity remains stable. Only instantiated by a mounted menu renderer, never by the list itself.
2. `session-menu/menu-renderer.tsx` uses that store, reads labels and icons reactively, and invokes **current** action handlers rather than ones captured on original mount. Searchable submenu radio/action partitions and query filtering are memoized.
3. `home/home-rows.tsx` replaces eager per-row session menu ownership with a cursor signal and demand-loaded menu, retaining open, archive, group, and background-open actions.
4. `context-menu-position.ts` preserves genuine pointer coordinates with no DOM measurement; keyboard context-menu events whose coordinates are `(0,0)` anchor to the trigger geometry instead. Used in Home sessions, titlebar tabs, and generic fallback.
5. Home/titlebar close handlers compare request object identity to avoid dismissing a new menu because an older keyed menu reported disposal.
6. Shared `menu-v2.css` bounds menu height to the viewport and permits vertical scrolling, keeping late session/group actions accessible when the app window is short.

## Validation and honesty gates

- App TypeScript `bun run typecheck`: **passed** after the final changes.
- Focused unit regressions: **14 passed / 0 failed**. Includes 4 new pointer/keyboard-position tests, 8 existing editable-selection tests, and 2 existing dismiss-controller tests.
- Browser-mode menu reconciliation: **4 passed / 0 failed** (118 assertions). Covers stable section/item ownership, live disabled/action state, moves/deletions/field removal, nested submenu state, and 100 successive updates of three items without additional keyed-owner instantiations.
- Full `bun run test:browser`: **not green** (35 passed / 8 failed; 7 module errors). Errors included unrelated `jsxDEV` import failures in command-palette, prompt, settings, and toast tests; one unrelated timeline-projection assertion failed. This is not a completed package-wide regression gate.
- No measured before/after Electron menu-open latency, memory heap size, or first-paint score. The 100-refresh test demonstrates deterministic owner retention, **not** a wall-clock or production throughput claim.
- No live UI visual/focus integration or screenshot verified here; no running service was restarted.

## Remaining production gates (not claimed complete)

- Exercise actual Electron UI with 25/50/100 simultaneous active sessions; capture startup owners/heap, p50/p95/p99 menu-open latency and frame consistency on Home, Chats, titlebar, groups, file explorer, and terminal.
- Verify pointer and Shift+F10 keyboard opening, roving-focus navigation, tall-menu scrolling and submenu collision behavior at compact window sizes; confirm focus returns to the correct trigger after close.
- Reconcile the in-flight session group/model menu changes before editing those files; ensure group bulk-action concurrency, permissions, stale state and cancellation are verified by their owners.
- Evaluate demand-mounting native browser/terminal context menu graphs once their actual cost is profiled. Avoid blind refactors that trade keyboard semantics for theoretical mount savings.
- Re-run broad test suite after unrelated `jsxDEV` and timeline failures have been resolved or isolated. Treat success of focused tests as only the narrow verified gate.
