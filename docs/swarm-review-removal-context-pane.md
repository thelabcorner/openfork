# Handoff: Remove Review Pane, Promote Context Tab to a Right-Side Pane

Status: design/ideation only, no code written yet.
Audience: implementation agent picking this up cold.

## Goal

1. Delete the "review" feature entirely from this fork (both the legacy design's `review-tab.tsx` and the v2 `ReviewPanelV2`, plus its diff pipeline, state, keybinds, and UI chrome).
2. Take `SessionContextTab` — currently a tab living *inside* the review pane's tab strip (`SessionSidePanel`) — and turn it into a standalone right-side pane, structurally identical to `BrowserPanelV2` (left/right sidecar panel pattern) and `ProjectExplorerPanel`.

## Why this is not a small deletion

Review and Context are not independent features today — they're both magic-string tab values (`"review"`, `"context"`) inside one shared `Tabs` component (`SessionSidePanel`), and they're cross-wired:

- Opening the context tab **currently force-opens the review panel** (`components/session-context-usage.tsx` → `openSessionContext()` calls `view.reviewPanel.open(..., "context-button")` before `tabs.open("context")`).
- Closing the context tab auto-closes the review panel if it was opened *for* context and nothing else is open (`view().reviewPanel.source === "context-button"` tracked in `context/layout.tsx`).
- The tab-reducer (`context/layout-tabs.ts`, `openSessionTab()`) special-cases both `"review"` and `"context"` string literals directly — they're not normal closable/sortable tabs.
- `pages/session/helpers.ts` (`createSessionTabs`) filters `"review"` out of the sortable tab list and computes `contextOpen` from the same shared tab state.
- The "Changes" file-tree tab filters by diff data that `session.tsx` computes for the review pane (`reviewDiffs`, `canReview`, etc.) — deleting review's data plumbing without checking this will silently break the file-tree "Changes" view.
- `session-panel-layout.ts` combines `review`+`terminal`+`files` visibility into a stacking layout computation — its input shape needs to lose `review`.

**Implication:** this is a decoupling task before it's a deletion task. Ripping out review first without extracting context cleanly will break context; extracting context first (in a way that no longer depends on the review-panel's open state) makes the review deletion mechanical afterward. Do it in that order.

## Existing pane abstraction to conform to

There's no formal `Pane` interface in the codebase — `BrowserPanelV2` and `ProjectExplorerPanel` just follow the same hand-rolled convention by copying each other (`project-explorer-panel.tsx` even says "structural mirror of BrowserPanelV2" in its docstring). New context pane should be the third copy of this pattern:

1. **Component**: `XPanel(props: { state: XPanelState; onClose: () => void })`, root node `<div id="x-panel" data-x-panel style={{width: state.panelWidth()+"px"}}>`, class `flex h-full min-h-0 shrink-0 ... overflow-hidden bg-v2-background-bg-base contain-strict`.
2. **State module** `x-panel-state.ts`: `createXPanelState()` → persisted store (`persisted(Persist.global("x-panel"), createStore({...}))`) holding *only* local UI prefs (width, scroll position, expand mode). Returns `{ ready, panelWidth, ...mutators }`, exported type `XPanelState = ReturnType<typeof createXPanelState>`.
3. **Open/closed boolean lives in `context/layout.tsx`, not the state module** — added to the `createStore({...})` schema alongside `browser`/`projectExplorer` (`layout.tsx:~299-304`), exposed as `layout.<name>.{opened, open, close, toggle}` (mirror `layout.tsx:786-810`). This split exists because the titlebar toggle button and the panel body are separate component instances that both need to read/flip the same boolean.
4. **Mount point**: decided by what context the pane needs.
   - `BrowserPanelV2` mounts at shell level (`pages/layout-new.tsx`) because it only needs server/global-scoped context — it survives route changes.
   - `ProjectExplorerPanel` mounts inside `pages/session.tsx` because it needs `useFile()`/`useSDK()`, which only exist under the session route's context providers (`layout-new.tsx` has a comment documenting the exact runtime error you get if you try to mount it at shell level: `"File context must be used within a context provider"`).
   - `SessionContextTab` depends on `useSync()`, `useSDK()`, `useProviders()`, and critically `useSessionLayout()` for `params.id` and per-session `view()`. **It must follow the ProjectExplorerPanel pattern and mount in `pages/session.tsx`**, not the shell.
5. **Titlebar toggle**: `command.register("<name>-toggle", () => [{ id: "<name>.toggle", keybind: "mod+shift+<letter>", onSelect: () => layout.<name>.toggle() }])` in `titlebar.tsx`, plus an `IconButtonV2` with `state={layout.<name>.opened() ? "pressed" : undefined}`, `aria-controls="<name>-panel"`.
6. **i18n**: add `command.<name>.toggle` (and any panel-header strings) to every locale file in `src/i18n/*.ts`, English source first.

## Proposed sequencing

### Phase 1 — Extract Context as an independent pane (land this first, review still present)
1. Add `layout.contextPanel` to `context/layout.tsx` (opened/open/close/toggle + persisted `panelOpened` in the store schema). Pick the actual key name carefully — `layout.context` may collide with existing naming; suggest `layout.sessionContext` or `layout.contextPanel` to avoid ambiguity with JS `context` idiom.
2. Create `pages/session/v2/context-panel-state.ts` mirroring `project-explorer-panel-state.ts` (width only, probably no editor sub-panel needed — check whether `SessionContextTab` needs its own resize/scroll persistence beyond what `view().scroll("context")` already gives it).
3. Create `pages/session/v2/context-panel.tsx` (`ContextPanel`) as a thin wrapper: header bar (title + close button, matching Browser/ProjectExplorer chrome) + `<SessionContextTab />` body. `SessionContextTab` itself needs no prop changes — it's already fully self-sufficient via hooks.
4. Mount `ContextPanel` in `pages/session.tsx` next to the existing `ProjectExplorerPanel` `<Show>` block, gated on `isDesktop() && layout.contextPanel.opened()`.
5. Rewire `components/session-context-usage.tsx`:
   - `openSessionContext()` → `layout.contextPanel.open()` instead of `view.reviewPanel.open(..., "context-button")` + `tabs.open("context")`.
   - Close path → `layout.contextPanel.close()` instead of `tabs().close("context")`. Delete the `reviewPanel.source === "context-button"` auto-close logic entirely — it becomes dead code once context no longer opens review as a side effect.
6. Remove `"context"` special-casing from `context/layout-tabs.ts` (`openSessionTab`) and `pages/session/helpers.ts` (`contextOpen`, `createSessionTabs`) — context is no longer a tab in that state machine.
7. Remove the `Tabs.Trigger value="context"` / `Tabs.Content value="context"` blocks from `session-side-panel.tsx` (both legacy and v2 code paths).
8. Add titlebar toggle button + command + keybind + i18n strings for the context pane, following the browser/project-explorer pattern exactly.
9. Decide which edge it docks on. Browser and ProjectExplorer are already "opposite edges" of each other — check current left/right assignment before picking a third slot; if both edges are taken, context pane likely needs to share an edge with one of them (stacked/tabbed) or the layout needs a policy for >2 right-side panes. **This is a real open question, flag it to the user before committing to a layout — don't just guess.**

### Phase 2 — Delete Review entirely (only after Phase 1 lands and is verified working)
1. Delete `pages/session/v2/review-panel-v2.tsx`, `review-panel-v2-state.ts`, `pages/session/review-tab.tsx`, `pages/session/v2/review-diff-kinds.ts`.
2. Remove `view().reviewPanel` from `context/layout.tsx` (opened/open/close/toggle, `source` tracking, `store.review`, `layout.review.diffStyle`).
3. Remove review's `Tabs.Trigger`/`Tabs.Content` blocks from `session-side-panel.tsx` (both design paths), and the `reviewTab`/`reviewPanel` props threaded into it from `session.tsx`.
4. In `session.tsx`, remove `reviewDiffs`, `canReview`, `hasReview`, `reviewCount`, `focusReviewDiff`, `activeReviewFile` — **but first check what "Changes" file-tree tab consumes**. If the file-tree's diff-filtered view depends on the same diff-fetching pipeline, either keep a minimal diff-fetch path alive for that feature or confirm with the user whether "Changes" file-tree filtering should also be removed as part of this.
5. Remove `"review"` from `context/layout-tabs.ts` special-casing and `pages/session/helpers.ts` (`createSessionTabs`'s review exclusion logic), and simplify `sessionPanelLayout()` (`session-panel-layout.ts`) to drop the `review` input.
6. Remove the review toggle command/keybind/button from `use-session-commands.tsx` and `session-header.tsx`.
7. Sweep i18n files for now-orphaned `command.review.*`/review-panel strings.
8. Grep-verify no remaining imports of deleted modules; run typecheck (this is a Solid/TS app — `tsc` will catch most dangling references).

## Risk / verification checklist for whoever implements this
- [ ] Confirm whether "Changes" file-tree tab is meant to survive review's removal, and if so, where its diff data now comes from.
- [ ] Confirm target dock edge for the new context pane (left/right, and interaction with browser/project-explorer if they already occupy both edges).
- [ ] Check `session-panel-layout.ts` callers after removing `review` from its input shape — anything destructuring `{ review, terminal, files }` needs updating.
- [ ] Check for e2e tests referencing review pane or context tab-strip selectors (`packages/app/e2e/**`) — these will need rewriting against the new pane's DOM (`#context-panel` instead of tab-strip `role="tabpanel"`).
- [ ] Full-text grep for `"review"` and `reviewPanel` after Phase 2 to catch stragglers in commands, settings, telemetry, or persisted-store migrations (bumping the layout persist version, e.g. `layout.v6` → `layout.v7`, is likely needed since the store shape changes — check `Persist.serverGlobal(..., "layout", ["layout.v6"])` versioning convention in `layout.tsx`).

## Key files (for quick reference)
| Concern | File |
|---|---|
| Shared layout/pane open-state | `context/layout.tsx` |
| Tab-reducer special-casing | `context/layout-tabs.ts` |
| Session tab-state helper | `pages/session/helpers.ts` |
| Review+context tab strip host | `pages/session/session-side-panel.tsx` |
| Review v2 UI | `pages/session/v2/review-panel-v2.tsx`, `review-panel-v2-state.ts` |
| Review legacy UI | `pages/session/review-tab.tsx` |
| Context tab content (keep, move) | `components/session/session-context-tab.tsx` |
| Context tab trigger/open logic (rewire) | `components/session-context-usage.tsx` |
| Pane pattern to copy | `pages/session/v2/project-explorer-panel.tsx`, `project-explorer-panel-state.ts` |
| Pane pattern to copy (shell-mounted variant) | `pages/session/v2/browser-panel-v2.tsx`, `browser-panel-v2-state.ts` |
| Session page (mounts panes, owns review data today) | `pages/session.tsx` |
| Stacking layout math (loses `review` input) | `pages/session/session-panel-layout.ts` |
| Titlebar toggle buttons/commands | `components/titlebar.tsx` |
