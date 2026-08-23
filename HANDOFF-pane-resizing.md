# Handoff — Anchor-Invariant Pane Resizing for OpenCode Desktop

## Context
- Source doc: `C:\Users\slooshied\Downloads\Anchor-Invariant Pane Resizing Architecture for OpenCode Desktop.md` (53 sections, divider-centric, pair-conserved `W_i' = W_i+Δ`, `W_{i+1}'=W_{i+1}-Δ`, outer boundaries fixed)
- Goal: Premium, mathematically optimized, rendering-performant pane resizing. Current width-based `left fixed + width change = right moves` breaks right-anchored panes.

## What was attempted

### 1. Core kernel
- Created `packages/ui/src/utils/pane-geometry.ts`:
  - `clampDelta`, `pairedWidths`, `verifyPairConservation`, `boundariesFromWidths`, `verifyBoundariesUnchanged`, `roundForCommit`
  - Pure O(1) arithmetic, no DOM
  - Added `pane-geometry.test.ts` (6 tests, later fixed boundary index bug `divider->boundary+1`)

### 2. ResizeHandle upgrade (`packages/ui/src/components/resize-handle.tsx`)
- Original was per-pane single: `current = startSize + delta` with edge/RTL handling, `onResize(clamp(current))` per `pointermove`, no rAF, no pair, no transient, no pointer capture robustness.
- Upgraded to:
  - `pair?: {left: {size,min,max,onResize,el}, right: {...}}` for divider
  - `targetRef` for single transient
  - `read-once` snapshot at `pointerdown` (store vs DOM), `requestAnimationFrame` coalesced (1 write/frame), pointer capture, `userSelect/cursor` handling, `onCollapse` threshold
  - `applySingle`: `delta` based on `edge`/`rtl`, `clamp`, transient `style.width/height` if `el` else `onResize`
  - `applyPaired`: `requestedDelta = pointer - start` (flipped for RTL/vertical), `pairedWidths` with `max`-aware clamping, transient 2 writes or fallback store, DEV conservation warn
  - `handleKeyDown` paired handling
  - Initially added debug instrumentation for 5s+ drags: collected `frames[]` with `expected` vs `actual` via `getBoundingClientRect`, downloaded JSON on `pointerup` if `duration>=5000`. Later removed after user feedback.

### 3. Debug instrumentation
- First JSON `pane-resize-paired-1787390504438.json` (372 frames, `left 916/right 643`, `hasPair true`, `edge start`):
  - Found `max err 496` at `t=60` (`expected 916` vs `actual 1412`, `actualSum 2055` vs `1559`): snapshot read store `916` but rendered `session` width was `1412` (`calc(100% - reserved)`), so expected vs actual diverged. Avg err 24.4.
  - Root cause: `pairLeftStart = pair.left.size` (store) vs DOM `calc` width.
- Fixed to measure DOM via `getBoundingClientRect()` at `pointerdown` if `el` exists (with sanity `|m-store|<800`).
- Second set of JSONs:
  - `pane-resize-single-1787390937531.json` (`edge end`, `473`, `hasPair false`, `actualSingle null`): tree handle had no `targetRef`, so no measurement, `expected` only, `actual` null. Revealed missing `targetRef`.
  - `pane-resize-single-1787390909280.json` (`edge start`, `603`, `hasPair false`, `actual==expected`): right-anchored single worked perfectly, but still single not paired for middle dividers.

### 4. Panel modifications
- `project-explorer-panel.tsx`: Added `treePaneRef`/`editorPaneRef`, made tree handle `pair` when `editorOpened` (internal `tree↔editor`), added `targetRef`, added `hideOuterHandle` prop to hide outer handle when explicit outer divider exists. Editor handle now `targetRef`.
- `usage-panel.tsx`, `models-panel.tsx`, `context-panel.tsx`, `limits-panel.tsx`: Added `pair` prop + `panelRef` + `targetRef` + `pair` passthrough. `limits-panel.tsx` and `limits-panel-state.ts` were missing (typecheck error `TS2307`) — created stubs.
- `session-side-panel.tsx`: Added `pair` prop, `fileTreePanelRef`, fixed `targetRef` from incorrect `getElementById("session-side-panel")` (outer) to inner `fileTreePanelRef`, added `pair` handling. Outer aside vs inner tree confusion noted.

### 5. Session layout (`packages/app/src/pages/session.tsx`)
- Added imports for `*_PANEL_WIDTH_MIN`, explorer widths, `clampSize`.
- Added `orderedRightPanes` memo (fileTree, usage, models, limits, context with `get/set/min/elId`).
- Added `rightPanePairFor(paneId)` (idx<=0 => undefined, idx>0 => left/right pair) and `sessionFirstRightPair` (session ↔ firstRight) and `explorerSessionPair` (explorer composite ↔ session).
- Added explicit dividers:
  - `D0: explorer↔session` as `w-2` divider after `ProjectExplorerPanel` when `explorerSessionPair()` exists, with `hideOuterHandle` on panel. Pair distributes delta between tree/editor.
  - `D1: session↔firstRight` as `w-2` divider after session panel when `orderedRightPanes.length>0 && !desktopSessionResizeOpen()` (when terminal closed). When `desktopSessionResizeOpen` true, existing session handle uses `sessionFirstRightPair`.
- Modified `ProjectExplorerPanel` to hide outer handle when `!!explorerSessionPair()`.
- Modified `Usage`/`Models`/`Limits`/`Context` to receive `pair={rightPanePairFor(id)}`.
- Session panel got `data-session-panel` for querying, and its handle now `pair={sessionFirstRightPair()}` when terminal open, plus explicit D1 when not.

### 6. Other
- `session-panel-layout.ts` etc. untouched.
- `limits-panel` stub fixed typecheck: `packages/app` now only has pre-existing `HostedBrowserWebview` errors.
- `ui` typecheck clean, `pane-geometry` 6/6, `ui` 33/33.

## Current state / Known issues
- `hasPair false` single for `edge=start` right-anchored panes (rightmost) is geometrically correct in flex (changing width moves left, right stays), but middle dividers that remain `single` (when `rightPanePairFor` returns `undefined` for first pane, or tree handle when editor closed) still use `calc(100% - reserved)` for session, so resizing a right pane via single will affect session via calc, not the adjacent left pane — violates invariant 2 (only adjacent should change). The explicit D0/D1 dividers attempt to fix, but:
  - Session's width in `calc` mode is not directly controlled by store, so `pair` that tries to set `layout.session.resize` has no visual effect until next calc; transient `style.width` on session may be overwritten by Solid's `style={{width: sessionPanelWidth()}}` (calc).
  - Explorer composite distribution (tree+editor) for outer resize is heuristic, not yet verified.
  - Initial JSON still shows drift for paired internal right dividers (usage↔models etc.)? The second set of single JSONs were perfect, but paired JSON had large initial error before DOM-measure fix — need re-measure after fix, but user says still terrible, so likely still single middle dividers or D0/D1 not working.
- Debug instrumentation removed in last step, so no longer auto-downloads.

## What user reported
- "That is still incorrect" with `pane-resize-single-1787391330996.json` (`edge start`, `hasPair false`, `775→320`, perfect `expected==actual` but still visually incorrect per user — likely because single right-anchored is correct per pane but system should be divider-paired, not single; the visual drift is the non-adjacent session moving instead of adjacent.
- Wants a handoff for a smarter agent.

## Files touched
- `packages/ui/src/utils/pane-geometry.ts` (new)
- `packages/ui/src/utils/pane-geometry.test.ts` (new)
- `packages/ui/src/components/resize-handle.tsx` (major)
- `packages/app/src/pages/session/v2/project-explorer-panel.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/app/src/pages/session/usage-panel.tsx`
- `packages/app/src/pages/session/models-panel.tsx`
- `packages/app/src/pages/session/context-panel.tsx`
- `packages/app/src/pages/session/limits-panel.tsx` (new)
- `packages/app/src/pages/session/limits-panel-state.ts` (new)
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/v2/project-explorer-panel-state.ts` (read)
- `packages/app/src/pages/session/session-panel-width.ts` (read)

## To reproduce
- `bun run dev` in `packages/desktop` or `bun dev -- --port 4444` in `packages/app` + backend `bun run --conditions=browser ./src/index.ts serve --port 4096`
- Open session with `newLayoutDesigns` on, open Project Explorer, FileTree, Usage, Models, Limits, Context (or at least 3 panes).
- Drag dividers:
  - Tree↔Editor internal (inside explorer) — should be paired, currently is when editor open.
  - Explorer↔Session (explicit D0) — should affect only those two.
  - Session↔FirstRight (explicit D1 or session handle) — should affect only those two.
  - FileTree↔Usage, Usage↔Models, etc. — via `rightPanePairFor`, should affect only adjacent.
- Observe: rightmost `D` should stay fixed, `A` fixed, only `B` or `C` moves, pair sum conserved. Currently user observes still incorrect (likely non-adjacent moves or outer drift).

## Next agent should
- Re-read the handoff doc invariants (§40, §52) and §18 pseudocode, §30 hot-path math.
- Decide on a true divider-centric layout: either CSS Grid with `grid-template-columns` and divider columns, or flex with explicit divider elements as sole handles and no per-pane handles for outer dividers. Ensure `N panes => N-1 dividers`, `one pane => no divider`.
- Fix `read-once` to always measure DOM (`getBoundingClientRect`) for both panes at `pointerdown`, not store, and handle `calc` vs fixed session width (make session fixed `px` when any right pane open, or make divider control `reserved` directly).
- Ensure `explorerSessionPair` distribution is correct and not heuristic; or make explorer panel a single fixed pane (not composite) for outer divider.
- Remove all `single` outer dividers; every outer divider must be `pair`. Rightmost single is okay only if it's truly the outer boundary (right edge fixed), but for internal dividers single is always wrong.
- Re-instrument debug (5s download) with correct `expected` vs `actual` (both via DOM, plus `containerWidth` and `boundaries[]` array) to prove `B_j' = B_j (j≠k)` and `W_i+W_{i+1} conserved`.
- Run `bun run --cwd packages/app typecheck` and `bun test` and verify visually in `http://localhost:4444`.

## Prompt for next agent
You are handed this handoff and the original `Anchor-Invariant Pane Resizing Architecture` doc. Fix pane resizing to be premium, mathematically correct, and rendering-performant. Do not patch single handles; implement divider transactions as specified.
