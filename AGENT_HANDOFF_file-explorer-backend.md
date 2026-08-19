# Handoff: File-explorer mutation backend (fs.write/delete/rename/mkdir) + agent-edit event wiring

## 0. Handoff metadata

- Date/time (UTC): 2026-08-15 (approx, per conversation date; exact wall-clock not captured)
- Sending agent role/model: Claude Sonnet 5, general UI/product-implementation agent, single session, no prior turns on this repo beyond this feature
- Receiving agent role/model: unspecified execution agent, presumed to have backend/protocol/codegen capability in this monorepo
- Reason for handoff (verbatim from user):
  > "Do everything you need to do on the UI implementation now since you are REALLY good at UI design, leave all of the backend implementation in a taskfile / EXTREMELY COMPREHENSIVE handoff document for my execution agent to handle since we will probably run out of tokens before we can finish."
  This is a **specialization + anticipated context-limit handoff**, not a failure recovery. The UI portion (this document's companion work) is believed complete and typecheck-verified; nothing here reflects a rejected or failed attempt.
- Trust guidance for prior work: **MIXED, leaning high on structure / unverified on runtime.** Every claim in this document about *what code exists and what it typechecks against* is verified (see §10). Every claim about *how it behaves at runtime* (does the panel actually render correctly, does drag-and-drop actually work end-to-end, does CodeMirror actually mount without console errors) is **unverified** — I did not run the Electron app in this session. Treat runtime behavior as an untested hypothesis, not a fact.

  **UPDATE, post-initial-handoff**: the user ran the actual Electron dev app after this document was first written and hit a real, observed runtime crash: `Error: File context must be used within a context provider`, thrown from `ProjectExplorerTree` via `useFile()`. Root cause: my original architectural claim that `ProjectExplorerPanel` could mount at the app-shell level (`layout-new.tsx`), "mirroring `BrowserPanelV2`'s persists-across-routes placement," was **wrong** — confirmed by reading `app.tsx` closely for the first time under pressure of the live error. `FileProvider`/`SDKProvider` (directory-scoped context) are only mounted **inside** session/draft routes (`session.tsx`'s `SessionProviders`, `app.tsx`'s `ResolvedDraftRoute`), not at the shell level — unlike the browser panel, which only needs server-scoped context (`ServerSyncProvider`, mounted shell-wide) since it has no concept of "which project." **Fix applied and typecheck-verified, but not yet re-tested live at the time of this update**: moved the panel's mount point out of `layout-new.tsx` entirely and into `session.tsx`'s `Page()`, as the first child of the existing `panelRow` div (the same directory-scoped row that already hosts the composer and the right-side review/terminal/files dock). `layout.projectExplorer`'s open/close toggle state stays shared/global (titlebar button still works app-wide); only the DOM mount and the width-state module instantiation moved to be session-scoped. See §6 decision 6 and §9 for the corrected architecture and what's still unverified about it. **Practical consequence for the user's original ask**: the project explorer no longer persists across the home/no-session screen the way the browser panel does — it's only visible while a session route is active. This is a real, load-bearing correction to the original design, not a cosmetic one.

---

## 1. The user's actual goal

- User's words (across the conversation, condensed to the load-bearing asks):
  > "I want to add a new pane on the left with an EXTREMELY RICH project file-tree; similar to jetbrains IDEs... we need the ability to drag-n-drop files from the project filetree into the chat-composer to mention them... We should also be able to right-click the files and bring up the same context menu we use for the tabs, etc... and have a lot of the options available in the actual windows explorer right-click context menu. If the user double-clicks a file; it should open up another pane... with an IDE-like text editor with syntax highlighting etc... Essentially we're turning OpenCode into an agent-oriented IDE."
  >
  > "For 'double-click opens an editor pane' — Fully editable buffer (type, save, undo)" (explicit choice when I asked read-only-preview vs. fully-editable-buffer).
  >
  > "I currently DO NOT like the current opencode FileTree / FileTreeV2 implementation etc, it looks like trash and its very poorly functional compared to jetbrains IDEs." — this ruled out reusing `FileTreeV2`'s *view* (its virtualization/drag-source *mechanics* were still reused; the visual/interaction layer was rebuilt from scratch).
  >
  > "i do like the feature of being able to mention / comment on lines for the agent in the IDE pane though; we SHOULD carry this feature over." — line-comment-to-agent (currently in `SessionFileView`/`createLineCommentControllerV2`) must be preserved conceptually. **This was NOT ported in this session** — see §2 "Not started."
  >
  > "it needs to be EXTREMELY OPTIMIZED FOR PERFORMANCE / RENDERING PERFORMANCE... BUILD UPON THE EXISTING CODEBASE / UI/UX styles. ShadCN-zinc. New York DENSE spacing. Premium."

- My interpretation of the goal, translated into the backend specialist's frame: the UI layer (built in this session) is a complete, typechecked "IDE shell" — tree, editor, tabs, context menu — that currently has **zero working mutation capability** because no such capability exists anywhere in this codebase's client-reachable API surface. The backend agent's job is to build exactly the four endpoints this UI already expects (a fixed, already-defined contract — see §3), wire one existing-but-unconsumed event into the sync layer, and NOT redesign the UI-side contract without a strong reason (see §12).

- Known ambiguities / things I had to infer (flag each):
  - **Hash semantics are undefined and I invented a placeholder.** The client's `FileOpsPort.write()` takes an `expectedHash?: string` for optimistic concurrency, and my editor pane computes this today with a throwaway djb2-style checksum (`placeholderHash()` in `project-explorer-editor-pane.tsx`). This is explicitly a placeholder — I do not know what hash algorithm (if any) `packages/core/src/file-mutation.ts`'s `writeIfUnchanged()` actually expects or returns. **This is the single most important open question for the receiving agent to resolve** (see §9, §11).
  - Whether `fs.read`/`fs.list` should also start returning a real content hash (so the editor doesn't need a separate round-trip or a fake client-side hash) is my inference of the "right" design, not something the user specified. Flagging as a recommendation, not a requirement.
  - "the same context menu we use for the tabs" — I interpreted this as "use the same `MenuV2.Context` primitive and interaction pattern," not "literally the same menu items" (tabs and files have almost entirely different actions). Unconfirmed with the user.
  - Multi-select in the tree (JetBrains supports shift/ctrl-click multi-select for bulk operations) was never explicitly requested. I did not build it. Flagging as a likely-desired but unconfirmed future ask, not a defect.

---

## 2. Current state of the task

### Done and verified
- All new/changed files in `packages/app` typecheck cleanly: `bun run --filter @opencode-ai/app typecheck` — the only errors present are in files I never touched (`session.tsx`, `HostedBrowserWebview.tsx`, `session-panel-layout.test.ts`), confirmed pre-existing via `git diff --stat` showing changes to those files that are **not** in my working set (see §3 "Files read but not modified" and §9 for how I confirmed this).
- `packages/ui` and `packages/session-ui` typecheck cleanly (I did not touch either package's source, only consumed already-exported members like `FileIcon`, `ResizeHandle`, `MenuV2`).
- `bun test packages/app/src/context/layout.test.ts` — 4 pass, 0 fail. Confirms my additive change to `context/layout.tsx` (`layout.projectExplorer.{opened,open,close,toggle}`) did not regress the existing layout store's tested behavior. **Note: I did not add a new test for `layout.projectExplorer` itself** — it is exercised only by typecheck + manual code review, not a dedicated test.
- `bun add` for CodeMirror packages completed successfully and resolved: `codemirror@6.0.2`, `@codemirror/language-data@6.5.2`, `@codemirror/state@6.7.1`, `@codemirror/view@6.43.8`, `@codemirror/commands@6.10.4`, `@codemirror/language@6.12.4`, `@codemirror/search@6.7.1`, `@codemirror/autocomplete@6.20.3`, `@lezer/highlight@1.2.3` — all now direct dependencies of `packages/app/package.json` (not just transitive via the `codemirror` meta-package; direct sub-package imports required this for bun's module resolution to succeed under typecheck).

### Done but NOT verified
- **The entire runtime behavior of every new UI component.** I did not start the Electron dev app, did not open a browser/webview, did not click anything. Everything below is "compiles and reads correctly to me," not "observed working":
  - `ProjectExplorerPanel` mounting inside `layout-new.tsx` without layout/CSS breakage.
  - `ProjectExplorerTree`: virtualized row rendering at 22px density, drag-start payload format, keyboard navigation, inline rename/create/delete row transitions, context-menu positioning.
  - `ProjectExplorerEditorPane`: CodeMirror actually mounting into the `host` ref, tab switching preserving/discarding state correctly, the `Compartment`-based language reconfiguration actually applying syntax highlighting, the theme/`HighlightStyle` actually producing legible colors against `--v2-*` tokens (some of which — `--v2-syntax-keyword`, `--v2-syntax-string`, etc. — **I referenced with CSS fallback values but did not confirm exist as real tokens in `packages/ui/src/v2/styles/theme.css`**; if they don't exist, the highlighting will silently fall back to the hardcoded fallback colors I wrote inline, which is safe but may not match the app's real syntax-color palette used elsewhere e.g. in the composer's markdown code blocks).
  - The `addToActiveChat`/`registerProjectExplorerAddToChat` bridge (`project-explorer-active-prompt.ts`) actually receiving a registration from `prompt-input-v2.tsx` at the right time, and correctly targeting the visible session's prompt scope when multiple composer instances could theoretically be mounted.
  - The titlebar toggle button and `mod+shift+p` keybind actually working and not colliding with anything (I checked existing `keybind: "mod..."` strings via grep across `packages/app/src` and found no `mod+shift+p` in use, but did not exhaustively check keybinds registered dynamically or in `packages/ui`/`packages/session-ui`).
- **`platform.revealPath` / clipboard writes** ("Reveal in Explorer", "Copy Path") — wired to real, pre-existing platform primitives, but never exercised.
- **The 22px row height / JetBrains-density visual claim** — I did not screenshot or visually compare against JetBrains. It is a deliberate, reasoned design choice (documented in `project-explorer-tree.css`'s header comment), not a validated pixel match.

### In progress / partially done
- None. Everything started in this session was either finished (typechecked, self-consistent) or explicitly not started (below).

### Not started
- **All backend work** — this entire document is the specification for it (§6, §7, §11).
- **Line-comment-to-agent porting onto the CodeMirror editor.** The user explicitly asked for this to carry over (§1). I deferred it because it depends on the editor architecture being stable and reviewed first, and because `createLineCommentControllerV2` + the "pierre" selection bridge (`packages/session-ui/src/pierre/selection-bridge.ts`, `packages/session-ui/src/line-comment-annotations-v2.tsx` or similarly named) are coupled to the *existing* read-only `SessionFileView`'s DOM/selection model in ways I did not investigate deeply enough in this session to port safely. **This is a real gap against an explicit user request — do not treat it as done.**
- **Live git-status coloring.** `ProjectExplorerTree` accepts an optional `gitStatus?: ReadonlyMap<string, Kind>` prop (same `Kind = "add"|"del"|"mix"` type `FileTreeV2` already uses) and the CSS/row rendering fully supports it, but **no caller currently supplies this map** — `ProjectExplorerPanel` doesn't pass `gitStatus` to the tree at all. Wiring a project-wide (not diff-scoped) git-status source was out of scope for this session; I don't know if one exists (the existing `kinds` map in `review-panel-v2.tsx` is diff-scoped, not general-project-status). This is UI work, not backend, but flagging so it isn't assumed done.
- **Multi-select** in the tree — not built (§1).
- **A dedicated test file for the new components** — none written. All verification is typecheck + one pre-existing test suite (`layout.test.ts`) that happens to still pass.

### Blocked
- All backend endpoints are blocked on the receiving agent's implementation — that is the entire point of this handoff.

---

## 3. Concrete artifacts, paths, and identifiers

### Files created (this session, `packages/app/src`)
- `utils/file-ops-port.ts` — **the contract** (see §6). `FileOpsPort` interface, `FileOpsNotImplementedError`, `FileOpsConflictError`, `notImplementedFileOpsPort` (default stub, currently wired everywhere).
- `utils/project-explorer-favorites.ts` — standalone persisted favorited-file-paths store (`Persist.global("project-explorer-favorites")`). Pure client-side, no backend dependency, not in scope for this handoff.
- `components/project-explorer-tree.tsx` — the ground-up virtualized tree (`@tanstack/solid-virtual`, reused from `file-tree-v2.tsx`'s pattern; data layer reused from `context/file/tree-store.ts` via `useFile().tree`).
- `components/project-explorer-tree.css` — row/icon/status/inline-input styling.
- `components/project-explorer-tree-context-menu.tsx` — `MenuV2.Context`-based right-click menu (pattern copied from `titlebar-tab-context-menu.tsx`).
- `pages/session/v2/project-explorer-panel.tsx` — top-level panel: tree + editor + two `ResizeHandle`s, header toolbar (new file/new folder/collapse).
- `pages/session/v2/project-explorer-panel-state.ts` — persisted width state (`Persist.global("project-explorer-panel")`), modeled on `browser-panel-v2-state.ts`.
- `pages/session/v2/project-explorer-editor-pane.tsx` — the CodeMirror 6 editable buffer, tabs, dirty-state, save (`Ctrl/Cmd+S`), conflict-banner UI shell.
- `pages/session/v2/project-explorer-editor-pane.css` — tab strip + conflict banner styling.
- `pages/session/v2/project-explorer-active-prompt.ts` — the composer-scope bridge (see §6, why it exists).

### Files modified (this session)
- `packages/app/src/context/layout.tsx` — added `DEFAULT_PROJECT_EXPLORER_PANEL_OPENED`, a `projectExplorer: { panelOpened }` field in the persisted store shape, and a `layout.projectExplorer.{opened,open,close,toggle}` accessor block (mirrors the existing `layout.browser` block exactly, ~25 lines added near it). **Verified**: `layout.test.ts` still passes; typecheck clean.
- `packages/app/src/components/titlebar.tsx` — added `command.register("project-explorer-toggle", ...)` (id `projectExplorer.toggle`, keybind `mod+shift+p`) and a titlebar `IconButtonV2` (icon `filetree`) next to the existing browser-toggle button. **Unverified at runtime.**
- `packages/app/src/components/prompt-input-v2.tsx` — added one `createEffect`/`onCleanup` block inside `usePromptInputV2Controller` that registers this composer's `prompt.context.add` with `project-explorer-active-prompt.ts` on every mount (see §6 for why). Two-line import additions (`onCleanup` from solid-js, `registerProjectExplorerAddToChat`).
- `packages/app/src/pages/layout-new.tsx` — mounted `<ProjectExplorerPanel>` as a new `<Show>`-gated sibling **before** `<main>` (browser panel is the equivalent sibling **after** `<main>`), added `createProjectExplorerPanelState()` call and `projectExplorerVisible` memo (mirrors `browserVisible`).
- `packages/app/src/i18n/en.ts` — ~28 new keys, all prefixed `projectExplorer.*` or `command.projectExplorer.*`, plus one generic `common.collapse` key that didn't exist before.
- `packages/app/package.json`, `bun.lock` — the CodeMirror dependency additions (§2).

### Files read but not modified (for context — do not assume these were touched)
- `packages/app/src/components/file-tree-v2.tsx`, `file-tree-v2-model.ts`, `file-tree.tsx` — mined for reusable patterns (drag-source dataTransfer format, `flattenLiveFileTreeV2`, virtualizer config), not edited.
- `packages/ui/src/components/file-icon.tsx` — confirmed this already has a full, rich per-extension icon set (588 lines, `FileIcon` component, color + mono variants) — **this eliminated an assumed-necessary "build a file-icon set" task**. Reused directly, unmodified.
- `packages/ui/src/components/resize-handle.tsx` — confirmed generic `edge`/`direction`-aware API, reused with `edge="end"` (opposite of the browser panel's `edge="start"`) with zero changes needed to the component itself.
- `packages/app/src/context/platform.tsx` — confirmed `revealPath?(path): Promise<boolean>` already exists; no new platform primitive needed for "Reveal in Explorer."
- `packages/app/src/context/file.tsx`, `context/file/tree-store.ts`, `context/file/types.ts` — confirmed `fs.read`/`fs.list`/`fs.find` are the **only** client-reachable filesystem endpoints (`sdk().client.file.list`, `sdk().client.file.read`), both one-shot fetches with a Solid store cache on top, no subscription model.
- `packages/protocol/src/groups/fs.ts` — confirmed the full current `FileSystemGroup` route surface (`fs.read`, `fs.list`, `fs.find` — nothing else). **This is the file the receiving agent needs to extend.**
- `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` — confirmed current handlers (`list`, `content`/read, `findText`, `findFile`, `findSymbol`, `status`). **This is the file the receiving agent needs to extend.**
- `packages/core/src/file-mutation.ts` — confirmed `writeIfUnchanged(input: ConditionalWriteInput)` already exists with content-hash optimistic concurrency + per-path `KeyedMutex` locking, and its own inline TODOs say it is **not yet wired to any watcher/event integration** and **not exposed over HTTP**. This is almost certainly the service the new `fs.write` handler should call into — I did not read its full implementation in enough depth to confirm its exact hash algorithm or `ConditionalWriteInput` shape (this file needs a close read by the receiving agent — see §11 item 1).
- `packages/schema/src/filesystem.ts` — confirmed `FileSystem.Event.Edited` (`type: "file.edited"`, payload `{ file }`) already exists and is published from `packages/opencode/src/tool/{write,edit,patch,apply_patch}.ts` on every agent-tool file mutation, but has **zero client consumers** (not in `packages/app/src/context/global-sync/event-reducer.ts`, not listened to anywhere in `packages/app/src`).
- `packages/app/src/context/global-sync/event-reducer.ts` — confirmed the central client event-type switch does not include `file.watcher.updated` or `file.edited` — both are handled today (if at all) via ad hoc raw `sdk().event.listen(...)` calls outside this central reducer (in `context/file.tsx` and `pages/session.tsx`).

### Commands run (with outcome)
- `bun add codemirror @codemirror/language-data` (in `packages/app`) — succeeded, 104 packages installed.
- `bun add @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/search @codemirror/autocomplete @lezer/highlight` (in `packages/app`) — succeeded, 43 packages resolved.
- `bun run --filter @opencode-ai/app typecheck` — run multiple times through the session; final run has zero errors attributable to any file in §3's "created/modified" lists (remaining errors are in `session.tsx`, `HostedBrowserWebview.tsx`, `session-panel-layout.test.ts`, confirmed via `git diff --stat` to be pre-existing/concurrent changes I never authored).
- `bun run --filter @opencode-ai/ui typecheck`, `bun run --filter @opencode-ai/session-ui typecheck` — both exit 0.
- `cd packages/app && bun test src/context/layout.test.ts` — 4 pass, 0 fail.
- `cd packages/app && bun test src/context/permission-auto-respond.test.ts src/components/dialog-select-model-search.test.ts` (from an earlier, unrelated part of this session, unaffected by this feature) — all passed; noted here only because it's the same session's baseline evidence that the test runner itself works in this environment.

### External sources consulted
- None (no web research for this feature; all findings are from reading this repository directly).

### Credentials, configs, environment notes
- None relevant. No new environment variables, no new config files. The `FileOpsNotImplementedError` message references this document by its exact filename (`AGENT_HANDOFF_file-explorer-backend.md`) — **if the receiving agent renames or moves this file, update the string literals in `utils/file-ops-port.ts`'s error message and the code comments in `project-explorer-panel.tsx`/`project-explorer-panel-state.ts`/`project-explorer-active-prompt.ts` that reference it by name.**

---

## 4. What I actually attempted (chronological, recency-weighted)

1. **Most recent**: fixed a real interaction bug in `ProjectExplorerRow`'s inline rename/create input — `onBlur` would fire the commit handler even after `Escape` had already called cancel, because Solid's blur event fires regardless of *why* focus was lost. Added a `settled` closure flag, set on both commit and cancel paths, checked in `onBlur` before committing. **Outcome: fixed, typechecks, not runtime-verified** (I reasoned through the event ordering; I did not click through it in a browser).
2. Wired the "Add to Chat" context-menu action. **First attempt**: called `usePrompt()` directly inside `ProjectExplorerPanel`. **Caught myself**: `ProjectExplorerPanel` mounts in `layout-new.tsx`, outside `session.tsx`'s nested, session-scoped `PromptProvider` — this would have silently written context into the wrong (outer, session-agnostic) prompt scope whenever a session route was actually active. **Second attempt (kept)**: built `project-explorer-active-prompt.ts` as an explicit registration bridge, registered from `prompt-input-v2.tsx` (the file that reliably has the *correct* in-scope `usePrompt()`). This is a real design decision with a real alternative rejected mid-session — see §6 decision log.
3. Added CodeMirror as a dependency, hit `Cannot find module '@codemirror/state'` etc. under typecheck despite `codemirror` (the meta-package) being installed — diagnosed as bun's strict resolution not surfacing transitive sub-package types for direct import statements, fixed by explicitly `bun add`-ing each `@codemirror/*` sub-package used directly. **Outcome: fixed, typecheck confirms.**
4. Built the tree's context-menu wiring by wrapping each virtualized row in `MenuV2.Context`, matching the existing `titlebar-tab-context-menu.tsx` pattern exactly (per-item `Trigger`, not a single shared menu instance) — this was a deliberate choice to follow established convention rather than invent a new context-menu architecture.
5. Investigated (via targeted `grep`/`Read`, not exhaustive) whether an editable text editor or a file-write endpoint already existed anywhere in the monorepo, before writing any editor/mutation code, specifically to avoid duplicating something that already existed (this repo has a strong "reuse existing patterns" norm observed throughout the session). Confirmed neither existed — this finding is what produced the "real gap" framing of this whole handoff.

No attempts were abandoned or reverted except the `usePrompt()` scope mistake in item 2 above, which was caught before being left in the codebase (not a dead end that shipped, but worth knowing about since the *reason* — nested `PromptProvider` scoping — could bite the receiving agent elsewhere too, e.g. if they add any other app-shell-level feature that needs to reach into the active session's prompt).

---

## 5. User feedback on prior attempts

- Approved (explicit, quoted):
  - "Fully editable buffer (type, save, undo)" — chosen explicitly over "read-only syntax-highlighted preview" when I asked (§1).
  - "we should carry this feature over" (line comments) — approved as a requirement, **not yet delivered** (§2).
  - "leave all of the backend implementation in a taskfile / EXTREMELY COMPREHENSIVE handoff document... follow this spec: C:\Users\slooshied\WebstormProjects\presGEN_v2\agent-skills\AGENT_HANDOFF_SKILL.md" — this document is my attempt to satisfy that instruction; I read the full skill file before writing this.
- Rejected: nothing in this session — no UI iteration was shown back to the user and rejected. This is a **first pass**, not a revision.
- Corrections the user made to my understanding: "I currently DO NOT like the current opencode FileTree / FileTreeV2 implementation... it looks like trash" — corrected my initial framing (which had assumed reusing `FileTreeV2`'s view layer, per my own earlier planning-phase writeup) into "rebuild the view from scratch, reuse only the data/virtualization mechanics."
- Open questions the user has not answered:
  - Whether "the same context menu we use for the tabs" meant literal item parity or just the same interaction pattern (I assumed the latter — see §1).
  - Whether multi-select is wanted (never asked, never built).
  - What the actual hash/versioning contract for optimistic-concurrency writes should be (this is really a question for the *backend* design, addressed to the receiving agent, not something the user was asked).

---

## 6. Decisions made and rationale

1. **Decision**: Build every mutation-capable UI element (context menu items, editor save) against a client-side `FileOpsPort` interface with a `notImplementedFileOpsPort` default, rather than leaving those UI affordances unbuilt or hidden until the backend exists.
   - Alternatives considered: (a) hide Rename/Delete/New File/New Folder/Save entirely until backend lands; (b) build them as disabled/greyed-out.
   - Why I chose this one: the user asked me to do "everything you need to do on the UI implementation now" — building against a stable, well-documented interface means the receiving agent's job is purely "satisfy this interface," with zero UI changes required once the backend lands (just swap `notImplementedFileOpsPort` for a real implementation at the call site in `layout-new.tsx`/`project-explorer-panel.tsx`). Hiding the affordances would have meant re-adding UI later; disabling them would have hidden the fact that they're fully interaction-complete already.
   - Reversibility: easy — swapping the port implementation is a one-line change per mount site.
   - Who approved it: me alone (implicit in the user's "do everything on the UI" instruction; not explicitly discussed).

2. **Decision**: `expectedHash` is computed client-side today via a non-cryptographic placeholder checksum (`placeholderHash()`), clearly commented as such.
   - Alternatives considered: (a) omit `expectedHash` entirely from the interface until the backend defines it; (b) block the whole editor pane on this being resolved first.
   - Why I chose this one: keeps the *shape* of the conflict-handling flow (save → possible `FileOpsConflictError` → conflict banner) fully built and testable in isolation once the backend exists, without forcing a stop-the-world dependency. But this is explicitly **not** a proposal for what the real hash should be — see §9, this is the single highest-priority open question.
   - Reversibility: easy — it's one function, replace its body once the backend's real hash contract is known.
   - Who approved it: me alone.

3. **Decision**: `layout.projectExplorer.{opened,...}` lives in the shared `context/layout.tsx` store (touching a large, sensitive, shared file) rather than being self-contained in the new panel's own state module.
   - Alternatives considered: keep everything (open state + width) in `project-explorer-panel-state.ts` alone, matching my first draft.
   - Why I chose this one: the titlebar toggle button and the panel itself are **separate component instances** that need to read/write the *same* open/closed boolean reactively. Two separate `createStore` calls both backed by the same `localStorage` key (via `persisted()`) do **not** share in-memory reactivity — I confirmed this is exactly the split `BrowserPanelV2` already uses (`layout.browser` for open/close, `browser-panel-v2-state.ts` for width only) and mirrored it exactly rather than inventing a different pattern.
   - Reversibility: hard-ish — reverting means re-threading the open state as a prop again, and the titlebar button would need a different data source. Not recommended.
   - Who approved it: me alone, but directly modeled on an existing, presumably-approved pattern in the codebase (`layout.browser`), not invented.

4. **Decision**: git-status coloring is wired end-to-end in the tree component (props, CSS) but **no data source is connected**.
   - Alternatives considered: build a project-wide git-status hook now.
   - Why I chose this one: I did not find an existing "whole-project git status" data source in this session (only diff-scoped `kinds` maps used by the review panel) and did not want to guess at a new server-side or client-side git integration without more investigation than this session's time budget allowed. This is a UI-completeness gap, not a backend gap, but flagged here so it isn't assumed solved.
   - Reversibility: easy — it's an unused optional prop; wiring real data is additive.
   - Who approved it: not discussed with the user.

5. **Decision**: Did not port line-comment-to-agent onto the new editor in this session, despite it being an explicit user requirement.
   - Alternatives considered: attempt a fast/shallow port.
   - Why I chose this one: given the session's already-large scope (new panel architecture + new tree + new context menu + new editor engine + this handoff document), I judged that a shallow, unverified port of a feature coupled to `createLineCommentControllerV2`'s existing DOM/selection assumptions was higher-risk than clearly deferring it. **This is my judgment call, not something the user agreed to skip** — flag prominently to the user/receiving agent, do not let it quietly disappear.
   - Reversibility: N/A (not attempted).
   - Who approved it: not approved — this is a gap I am disclosing, not a decision the user signed off on.

6. **Decision (post-hoc correction)**: moved `ProjectExplorerPanel`'s mount point from `layout-new.tsx` (app-shell level) to `session.tsx`'s `Page()` (inside the directory-scoped `panelRow`), after the user hit a live `useFile()` context error (§0 update).
   - Alternatives considered: (a) give the panel its own independent `SDKProvider`/`FileProvider` pair at the shell level, resolving "current directory" from some shell-level signal (active tab, last-visited session, etc.) rather than the route's own resolved directory; (b) the fix I actually made — mount inside the existing, already-correct, already-tested directory resolution that `session.tsx` does for the composer and every other directory-scoped panel.
   - Why I chose (b): option (a) would have meant re-deriving "what is the current directory" via a second, parallel code path outside the route system's own careful resolution logic (`createSessionLineage`, `TargetServerRoute`, etc., which I did not fully read and would not want to duplicate or subtly diverge from). Getting that wrong risks showing the wrong project's files in edge cases like mid-navigation or multi-tab. Reusing the route's own already-correct directory scope is strictly safer, at the cost of the panel no longer being visible on the home/no-session screen.
   - Reversibility: easy to iterate further (e.g., also mounting a second instance inside the draft route for pre-session visibility) but reverting to shell-level would reintroduce the crash — do not do that without solving the underlying directory-resolution problem first.
   - Who approved it: not discussed with the user before making the fix (made under the immediate pressure of a live crash the user reported); the user has not yet confirmed the fix resolves it, since this correction was applied but not re-tested live before this document was updated (see §10).

---

## 7. Known constraints and invariants

- Hard constraints (must not be violated):
  - The client contract is `packages/app/src/utils/file-ops-port.ts`'s `FileOpsPort` interface (`write`, `delete`, `rename`, `mkdir`). Every UI call site is already written against this exact shape. **Do not change the UI call sites to match a different backend API shape — change the backend to satisfy this interface, or if the interface genuinely needs to change, that's a UI change too and should go back through review, not be silently reshaped from the backend side.**
  - `write()`'s `expectedHash` must enable **optimistic concurrency**: if the file changed since the client last read it (most likely because the agent wrote to it), the write must fail in a way the client can distinguish (→ `FileOpsConflictError`) from a generic failure (→ generic error toast) and from "not implemented" (→ the current `FileOpsNotImplementedError`, which should stop being thrown once real implementations replace `notImplementedFileOpsPort`).
- Soft preferences (user stated but flexible):
  - "EXTREMELY OPTIMIZED FOR PERFORMANCE" — applies to the UI (already addressed: virtualization, lazy CodeMirror language loading via `@codemirror/language-data`'s async `LanguageDescription.load()`). For the backend, the closest equivalent concern is: don't make `fs.write`/`fs.delete`/`fs.rename`/`fs.mkdir` block on anything unnecessary, and reuse `file-mutation.ts`'s existing per-path `KeyedMutex` rather than introducing a second locking mechanism.
  - "ShadCN-zinc. New York DENSE spacing. Premium." — UI-only, already addressed, not applicable to backend work.
- Things the user has explicitly said NOT to do or change: nothing backend-specific was discussed with the user (the backend scope itself is my own decomposition of "make the write path exist," approved implicitly by the user's request to hand it off as a distinct unit of work).

---

## 8. Dead ends and things already ruled out

No dead ends to report for the backend portion — no backend code was attempted in this session (by design; that's the whole point of the handoff). The one UI-side dead end (calling `usePrompt()` directly from the panel, caught before shipping) is documented in §4 item 2 and §6 decision 3's neighbor; it doesn't affect backend work but is worth knowing about if the receiving agent ever needs to reach session-scoped state from an app-shell-scoped component elsewhere.

---

## 9. Risks, suspicions, and unknowns

- **SUSPECTED, not verified**: `packages/core/src/file-mutation.ts`'s `writeIfUnchanged()` is the right service to build `fs.write` on top of. I read enough of this file to know it exists, has optimistic concurrency and per-path locking, and has TODOs about missing event/watcher integration — I did **not** read its full implementation closely enough to confirm its exact `ConditionalWriteInput` shape, its hash algorithm (if any), or whether it's already used by anything else that a new HTTP handler might conflict with.
- **UNKNOWN**: what hash/version scheme (if any) `fs.read` should start returning so the client doesn't need a placeholder. Options I can see from here, not adjudicated: (a) a real content hash (sha256 etc.) computed server-side and returned in `FileContent`; (b) file mtime; (c) an opaque server-issued version token. **This decision blocks §11 item 1's design and should be made deliberately, not inherited from my placeholder.**
- **UNKNOWN**: whether `packages/opencode/src/tool/{write,edit,patch,apply_patch}.ts` (the agent's own write paths) should be routed through the *same* `file-mutation.ts` service/lock as the new client-facing `fs.write`, for true mutual exclusion between a human editing in the new pane and the agent editing via tools at the same time. If they use separate code paths with separate/no locking, two concurrent writers could still race even after this handoff's endpoints exist. I did not investigate whether `write.ts`/`edit.ts`/etc. already use `file-mutation.ts` or a different write path — **this is probably the most safety-critical open question in this entire handoff**, more important than the hash-format question.
- **RISK**: `FileSystem.Event.Edited` (`file.edited`) is published on the same event bus already used for other `EventV2` events that reach the client (confirmed other event types cross the wire via this bus), but I did not directly confirm `file.edited` specifically survives the SSE round-trip to the client — I'm inferring it does because it uses the same publish mechanism as events that *are* confirmed to reach the client. If it turns out `file.edited` is filtered somewhere before reaching the client, the "auto-reload / conflict banner on agent edit" UX (§11 item 3) needs a different signal.
- **RISK**: the CodeMirror theme references `--v2-syntax-*` CSS custom properties with inline fallback values (§2, "Done but NOT verified"). If those tokens don't exist in `packages/ui/src/v2/styles/theme.css`, syntax highlighting will use the fallback colors (safe, not broken) but may look visually inconsistent with markdown code blocks elsewhere in the app that might use a different syntax palette. Not a backend concern, but worth the receiving agent's awareness if they're asked to also verify visual consistency.
- **Assumptions I made that could be wrong**:
  - That "one composer registered = the right composer" (§6 decision, the `project-explorer-active-prompt.ts` bridge) holds in all cases. If the app ever mounts multiple `PromptInputV2Composer` instances simultaneously (e.g., a future split-view feature), "last mounted wins" could target the wrong one. Not a problem today (confirmed single composer per session route in this session's reading), but a latent assumption.
  - That `platform.revealPath` and `navigator.clipboard.writeText` work identically across the desktop platforms this app ships for. Not verified per-platform.

---

## 10. Validation status summary

| Item | Status | How verified (or why not) |
|---|---|---|
| New/modified files typecheck (`packages/app`) | Verified | `bun run --filter @opencode-ai/app typecheck` — zero errors in any file listed in §3; remaining errors confirmed pre-existing via `git diff --stat` on files I never opened |
| `packages/ui`, `packages/session-ui` unaffected | Verified | Both `typecheck` scripts exit 0 |
| `layout.tsx` change doesn't break existing tests | Verified | `layout.test.ts` — 4/4 pass |
| CodeMirror dependencies install and resolve | Verified | `bun add` succeeded; typecheck errors for `Cannot find module '@codemirror/...'` disappeared after adding direct deps |
| Panel renders correctly in the running app | **Tried, failed, fixed, NOT re-verified** | User ran the live app and hit `File context must be used within a context provider` (crashed on mount); root cause diagnosed and a fix applied (moved mount from `layout-new.tsx` to `session.tsx`, §6 decision 6), typecheck-clean, but not yet re-tested live |
| Tree virtualization performs well at real project scale | **Not verified** | No project with a large file tree was opened; virtualizer config (`overscan: 12`, `estimateSize: 22`) is reasoned from `file-tree-v2.tsx`'s proven config, not independently measured |
| Drag-to-mention still works from the new tree | **Not verified** | Drag source emits the same `dataTransfer` payload as the existing, working `file-tree-v2.tsx` (`file:` scheme) by direct code comparison; the receiving end (`attachments.ts`'s `handleDrop`) was not re-tested |
| Context menu opens/positions correctly | **Not verified** | Pattern copied from an existing, presumably-working component; not independently run |
| CodeMirror editor mounts, types, saves (against the stub port), shows syntax highlighting | **Not verified** | No runtime check performed |
| Inline rename/create/delete row UI | **Not verified**, one bug found and fixed via code review (§4 item 1) | No runtime check performed after the fix |
| "Add to Chat" reaches the correct composer | **Not verified** | Reasoned through the provider-nesting issue and fixed it via the registration bridge (§4 item 2), but never clicked it |
| Titlebar toggle button / keybind | **Not verified** | No collision found via `grep` of existing `keybind: "mod..."` strings, but grep is not exhaustive (dynamically-registered keybinds elsewhere in the codebase, if any, wouldn't be caught) |
| Line-comment-to-agent carried over to new editor | **Not done** | Explicitly deferred, see §2, §6 |
| Live git-status coloring in new tree | **Not done** | Prop/CSS exist, no data source wired, see §2, §6 |
| Backend: `fs.write`/`delete`/`rename`/`mkdir` | **Not started** | This entire document is the spec for it |

---

## 11. Recommended next actions

1. **Read `packages/core/src/file-mutation.ts` in full**, and separately, read `packages/opencode/src/tool/write.ts` and `edit.ts` to determine whether the agent's own file-mutation tool calls already route through this same service. — *because* this determines whether the new `fs.write` endpoint gets true mutual exclusion against concurrent agent writes "for free," or whether the agent's write paths also need to be migrated onto the shared service/lock as part of this work. Expected signal of success: a clear written answer (in code comments or a follow-up note) to "does `write.ts`'s agent tool and the new `fs.write` HTTP handler contend on the same lock for the same file path?"

2. **Design and document the hash/version contract** for optimistic concurrency (real content hash vs. mtime vs. opaque token), update `fs.read`'s response (`FileContent`) to include it if it doesn't already, and have `fs.write` require/validate it. — *because* the client's `placeholderHash()` (in `project-explorer-editor-pane.tsx`) is a deliberate stand-in that must be replaced, not built upon. Expected signal of success: the client's `placeholderHash()` function can be deleted entirely, replaced by reading a real hash field off the object `file.get(path)`/`FileContent` already returns from the existing `fs.read` call.

3. **Implement `fs.write`** in `packages/protocol/src/groups/fs.ts` (new route definition) and `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts` (new handler), calling into `file-mutation.ts`'s `writeIfUnchanged()` (or its post-item-1/2 evolution). On hash mismatch, return a distinguishable error (e.g. HTTP 409) that the SDK codegen surfaces as something the client can catch and map to `FileOpsConflictError` (already defined client-side in `utils/file-ops-port.ts`, currently unused because nothing throws it yet). — *because* this is the highest-value single endpoint (unblocks Save, the most-used mutation). Expected signal of success: from the new editor pane, typing in a file and pressing Ctrl/Cmd+S actually persists to disk, and a second concurrent write with a stale hash gets rejected instead of silently overwriting.

4. **Implement `fs.delete`, `fs.rename`, `fs.mkdir`** the same way, in the same two files. — *because* these unblock the tree's context-menu actions, which are fully built and wired client-side already (§3). Expected signal of success: Rename/Delete/New File/New Folder in the tree's context menu actually mutate the filesystem and the tree reflects it (it should — `useFile().tree` already refreshes on `file.watcher.updated` events per `context/file/watcher.ts`, assuming that watcher is enabled — see §9/§11 item 5 for the caveat about it being experimental-flag-gated).

5. **Regenerate the SDK client** (`packages/sdk/js`) after the protocol changes, and swap `notImplementedFileOpsPort` for a real implementation calling the new SDK methods, at the point(s) it's currently passed in `packages/app/src/pages/layout-new.tsx` (`<ProjectExplorerPanel state={...} onClose={...} />` — currently no `fileOps` prop is passed at all, so it defaults to the stub; add `fileOps={realFileOpsPort}` there once it exists). — *because* this is the single call-site change needed to light up every already-built UI affordance at once. Expected signal of success: no other UI file needs to change.

6. **Promote `file.edited` into `packages/app/src/context/global-sync/event-reducer.ts`** as a first-class, session-correlated case, and wire the editor pane's already-built (but currently unwired) conflict/auto-reload UX to it. — *because* without this, the editor pane's dirty-state/save flow works but has no live "the agent just changed this file out from under you" signal; the only way a conflict surfaces today would be via a failed save's `FileOpsConflictError` after the fact, not proactively. Expected signal of success: with a file open in the new editor and clean (no local edits), triggering an agent tool-write to that same file (e.g. via a live session) causes the buffer to silently refresh with the new content; with local edits present, a banner appears instead of silent overwrite.

7. **Confirm `Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER`'s status** (`packages/core/src/filesystem/watcher.ts`) — the generic OS-level watcher that today keeps the tree/file cache fresh is gated behind this experimental flag. If it's off by default, the new tree's rename/delete/create UI will work (server-side mutation succeeds) but the **tree view itself may not visually update** without a manual refresh, because it relies on the same watcher-driven invalidation (`context/file/watcher.ts`'s `invalidateFromWatcher`) that's already used by the existing file browser. — *because* this could make freshly-implemented CRUD operations look broken in manual testing even when the backend is correct. Expected signal of success: after a rename via the context menu, the tree updates without a manual reload.

8. Only after 1–7: **attempt the line-comment-to-agent port** onto the CodeMirror editor pane (§2, §6 item 5) — this was explicitly requested by the user and explicitly not done in this session. It is UI work, not backend work, but is listed last here because it's independent of the backend endpoints and lower-risk to attempt once the editor's core behavior (open/edit/save/conflict) is confirmed stable at runtime.

---

## 12. Do-not-touch / do-not-repeat list

- **Do not change the `FileOpsPort` interface shape** (`write`/`delete`/`rename`/`mkdir` signatures in `utils/file-ops-port.ts`) to match whatever the backend implementation finds convenient. Every UI call site is already written against this exact interface; changing it means re-touching UI code that was built and typechecked in this session. If the interface genuinely needs to change (e.g., the hash-contract decision in §11 item 2 requires a different `write()` signature), that's fine — but treat it as a deliberate interface revision, update all call sites together, and don't let the shape drift silently.
- **Do not reuse or extend `FileTreeV2`/`file-tree-v2.tsx`'s visual layer.** The user explicitly rejected its look and feel ("looks like trash"). `ProjectExplorerTree` is the intended replacement for this feature; `FileTreeV2` should be left alone (it's still used elsewhere — the review panel's diff file list — and is out of scope for this feature).
- **Do not repurpose `layout.sidebar`** (the legacy global project-navigation sidebar state) for anything related to this panel. It's a different, unrelated concept, not rendered in the shell this feature lives in (`layout-new.tsx`) — this was investigated and deliberately avoided during the planning phase of this session; reusing it would reintroduce exactly the confusion that was avoided.
- **Do not build a second locking/concurrency mechanism** for file writes if `file-mutation.ts`'s existing `KeyedMutex` + hash-based optimistic concurrency can be reused/extended (§7, §11 item 1). It already exists specifically for this purpose per its own code comments.
- **Do not silently drop the line-comment-to-agent requirement.** It is a real, explicit, approved user requirement that simply wasn't reached in this session (§2, §6). If the receiving agent's scope is backend-only, at minimum flag this back to the user/orchestrating process rather than letting it quietly disappear from tracking.
- **Do not assume the CSS `--v2-syntax-*` tokens referenced in `project-explorer-editor-pane.tsx`'s `cmHighlightStyle` exist** — verify against `packages/ui/src/v2/styles/theme.css` before relying on them for anything beyond "has a safe fallback."

---

## 13. Synthesis instruction to the receiving agent

Before writing any backend code:

1. Restate the user's goal in your own words, including that the UI is already complete and typechecked, and that your job is specifically to satisfy the `FileOpsPort` interface (§3, §6, §12) — not to redesign the client.
2. Restate the current state: UI done-and-typechecked-but-runtime-unverified; backend not started; line-comment porting and live git-status both explicitly deferred, not done.
3. Restate the two highest-risk open questions before writing code: (a) does the agent's own tool-write path need to share a lock with the new client-facing write endpoint (§9, §11 item 1), and (b) what hash/version contract should `expectedHash` actually use (§9, §11 item 2). Both should be resolved deliberately, not inherited from this session's placeholder.
4. Flag anything in this handoff you don't trust or don't understand, especially anything marked SUSPECTED or UNKNOWN in §9, before proceeding past it.
5. Confirm with the user (or verify directly against the code) anything load-bearing before taking a destructive or hard-to-reverse action — in particular, before wiring the agent's own write tools onto a shared lock (§11 item 1), since that changes behavior for the agent's existing, presumably-working file-editing capability, not just new UI.
