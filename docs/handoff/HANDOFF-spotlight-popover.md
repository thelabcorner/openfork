# HANDOFF — Spotlight Popover / @-Mention Search (Full Overhaul)

> **Status:** Ready for redesign. All matcher fixes (token-based out-of-order, CamelCase/acronym, density ranking, performance) are in `packages/ui/src/hooks/use-filtered-list.tsx`. The UI layer below is untouched — redesign here freely.

---

## 1. What the user sees (the "spotlight")

Two presentations of the same underlying search model (`useFilteredList`):

| Presentation | Component | Trigger | Key file |
|---|---|---|---|
| **Anchored overlay** (inside composer) | `PromptInputV2Popover` | Type `@` in `PromptInputV2` | `packages/session-ui/src/v2/components/prompt-input/index.tsx` |
| **Full-screen dialog** (mobile / spotlight) | `DialogCommandPaletteV2` | `F3` / command palette | `packages/app/src/components/dialog-command-palette-v2.tsx` |

Both use the same `useFilteredList` hook (`packages/ui/src/hooks/use-filtered-list.tsx`) for filtering and ranking.

---

## 2. Component map (all verified by file read)

### Core UI (session-ui package — the popover itself)

- `packages/session-ui/src/v2/components/prompt-input/index.tsx` — `PromptInputV2` component. Contains:
  - The `contenteditable` editor (`div` with `contenteditable`)
  - `PromptInputV2Popover` (lines 776–848) — the anchored dropdown
  - `PromptInputV2AddMenu` (lines 626–680) — the `+` menu that opens context/commands
  - `PromptInputV2Attachments` (lines 499–624) — attachment chips above editor
  - `renderPromptInputV2Editor` (lines 309–365) — DOM rebuild + cursor restore
  - `setEditorCursor` (lines 367–392) — TreeWalker-based caret placement
- `packages/session-ui/src/v2/components/prompt-input/interaction.ts` — `createPromptInputV2Controller`. Handles:
  - `dispatch()` for all events (`popover.select`, `mention.add`, `focus.editor`, etc.)
  - `restoreFocus()` (line 284) — rAF focus + cursor restore
  - `execute()` (line 179) — runs commands from machine transitions
  - `addPart()` (line 116) — inserts mentions/text/images
- `packages/session-ui/src/v2/components/prompt-input/store.ts` — `createPromptInputV2Store`. Handles:
  - `addMention()` (line 80) — inserts mention at `@` query or cursor
  - `addText()` (line 54) — inserts plain text
  - `setPrompt()` (line 32) — batch updates prompt + cursor
- `packages/session-ui/src/v2/components/prompt-input/machine.ts` — `transitionPromptInputV2`. State machine for:
  - `input.changed` (opens `@` context popover or `/` command inline)
  - `popover.select` (closes popover, pushes `mention.add` or `draft.setText`)
  - `key.down` (arrow navigation, Tab/Enter selection, Escape close)
- `packages/session-ui/src/v2/components/prompt-input/types.ts` — `PromptInputV2Suggestion`, `PromptInputV2Prompt`, etc.
- `packages/session-ui/src/v2/components/prompt-input/attachments.ts` — drag/drop + paste handling (`handleDrop`, `handlePaste`, `addAttachments`). Uses `focusEditor()` + `addPart()`.
- `packages/session-ui/src/v2/components/prompt-input/attachments.css` — drag overlay styles.

### Filtering / ranking (ui package — the matcher)

- `packages/ui/src/hooks/use-filtered-list.tsx` — `useFilteredList`. The matcher algorithm (just overhauled by swarm):
  - `filterWithTokens()` — token-based out-of-order substring matching
  - `tokenScore()` — scores original text + CamelCase split + acronym (`+10` for acronym, `+2` start/delimiter, `+1` embedded)
  - `densityBonus()` — counts max consecutive token sequence in haystack
  - Hybrid: token-first sorted by `(score → density → alphabetical)`, then fuzzysort-only hits by `(density → alphabetical)`
  - `splitCamelCase()` / `extractAcronym()` — CamelCase splitting (`dialogSelectModel` → `dialog`, `select`, `model`; acronym `DSM`)
  - `getNestedValue()` — nested property access for `filterKeys`
- `packages/ui/src/components/list.tsx` — `createList` wrapper (keyboard nav, loop, active tracking)

### App-level wrapper (app package — connects to SDK / sync)

- `packages/app/src/components/prompt-input-v2.tsx` — `PromptInputV2Composer`. The app-level controller that:
  - Creates `PromptInputV2` with `controller` from `createPromptInputV2Controller`
  - Defines `context` (references + agents + resources + recent files + file search results)
  - Defines `commands` (slash commands)
  - Defines `references` / `resources` (mentions from sync data)
  - Passes `searchContextFiles` (async file search via SDK)
  - Handles `onSuggestionSelect` (line 596) — for commands, triggers `command.trigger()`
- `packages/app/src/components/prompt-input/at-mention-search.ts` — `normalizeMentionPage`, `searchMentionsFallback`, `toMentionOptions`. Maps server mention results to popover options.
- `packages/app/src/components/prompt-input/at-row-meta.ts` — `atRowMeta` formatting helpers for mention rows.
- `packages/app/src/components/prompt-input/at-icons.tsx` — `atIcons` for symbol-kind rows.
- `packages/app/src/components/prompt-input/attachments.ts` — V1 attachment core (separate from session-ui v2 attachments).
- `packages/app/src/components/prompt-input/submit.ts` — `createPromptSubmit`, builds request parts from prompt + mentions.
- `packages/app/src/components/prompt-input/transient-state.ts` — `draggingType` state (`"image"` / `"@mention"` / `null`).
- `packages/app/src/components/prompt-input/build-request-parts.ts` — Parses `@mentions` from text for server submission.

### Full-screen spotlight / command palette (app package)

- `packages/app/src/components/dialog-command-palette-v2.tsx` — `DialogCommandPaletteV2`. The full-screen search dialog (mobile / spotlight). Uses the same `command-palette.ts` model.
- `packages/app/src/components/dialog-command-palette-v2.css` — Styles for the full-screen dialog.
- `packages/app/src/components/command-palette.ts` — `createCommandPaletteModel`, `matchesEntry`, `normalizeQuery`. The shared model for both anchored and full-screen presentations.
- `packages/app/src/components/dialog-select-model-unpaid-v2.tsx` — Related dialog (not spotlight directly).

### Legacy V1 (reference only — do not break)

- `packages/app/src/components/prompt-input.tsx` — Legacy `PromptInput` (v1). Has its own `at-mention-search` integration (`at-mention-search.ts`), `at-row-meta`, `at-icons`, `slash-popover`. The v2 component (`prompt-input-v2.tsx`) is the new design.

### Tests / stories

- `packages/session-ui/src/v2/components/prompt-input/store.test.ts` — Store tests (addMention, addText, etc.)
- `packages/session-ui/src/v2/components/prompt-input/machine.test.ts` — Machine transition tests
- `packages/session-ui/src/v2/components/prompt-input/attachments.test.ts` — Attachment tests
- `packages/session-ui/src/v2/components/prompt-input/prompt-input.stories.tsx` — Storybook stories
- `packages/app/e2e/regression/prompt-input-v2-command-draft.spec.ts` — E2E regression spec

### Key architecture docs

- `docs/architecture/at-mention-sync.md` — Full architecture proposal for @-mention sync (index, watcher, server routes, client behavior). References exact line numbers in `packages/app/src/components/prompt-input.tsx`, `packages/core/src/filesystem/search.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`, etc.
- `docs/plans/pwa-mobile/04-api-and-data.md` — References `@mention spotlight search` and `dialog-command-palette-v2`.

---

## 2. What was just fixed (before overhaul)

- `packages/ui/src/hooks/use-filtered-list.tsx` — Matcher overhauled by 4-member swarm (`camelcase-extract`, `prefix-scoring`, `perf-optimize`, `scattered-ranking`). Token-based out-of-order word matching + CamelCase splitting + acronym extraction (`DSM` from `DialogSelectModel`) + density ranking + hybrid fuzzysort fallback + regex cache optimization.
- `packages/session-ui/src/v2/components/prompt-input/store.ts` — `addMention` batched; `mentionQueryRange` added.
- `packages/session-ui/src/v2/components/prompt-input/interaction.ts` — `restoreFocus` fixed; `focusEditor` uses `restoreFocus()`.
- `packages/session-ui/src/v2/components/prompt-input/index.tsx` — `renderPromptInputV2Editor` re-focuses after `replaceChildren`.
- `packages/session-ui/src/v2/components/prompt-input/attachments.ts` — Drag/drop focus restored; `capture()` uses live `cursorPosition(editor)`.

---

## 3. Design notes for overhaul

- The popover (`PromptInputV2Popover`) is a `div` with `absolute` positioning (`-top-2 -translate-y-full`), `max-h-80`, `overflow-auto`, `rounded-xl`, `shadow-[var(--v2-elevation-raised)]`. It renders `For` over `items` with `button` rows (`data-suggestion-id`).
- The search input inside the popover (`input` with `ref` focusing via `requestAnimationFrame`) is only shown for `command-menu` (`search` prop). The `context` popover does NOT have a search input — filtering is done by the `useFilteredList` hook reacting to `setQuery()` from `onInput` events on the editor.
- The `PromptInputV2` component uses `Show when={state.popover.type !== "closed"}` to toggle the popover. The popover closes on `popover.select` (machine transition pushes `popover.close` + `focus.editor`).
- The full-screen `DialogCommandPaletteV2` uses the same `command-palette.ts` model but renders differently (full-screen sheet, large touch rows). It is NOT the same component as the anchored popover.
- The matcher (`useFilteredList`) is shared by both presentations. Changing the matcher affects both.
- The `context` list combines: `references()` (from sync data) + `agents` (available agents) + `resources` (MCP resources) + `recent()` (recent file paths) + `searchContextFiles()` (async file search results). The `filterKeys` is `"label"` for context.
- The `command` list uses `filterKeys: ["trigger", "title"]`.
- The `PromptInputV2Popover` has `emptyLabel`, `items`, `activeID`, `query`, `search` (optional), `onActiveChange`, `onSelect`. It does NOT expose `grouped` directly — grouping is handled by `useFilteredList` and consumed via `props.controller.suggestions()`.
- The `PromptInputV2` component passes `controller` (from `createPromptInputV2Controller`) which exposes `suggestions()`, `dispatch()`, `onKeyDown()`, `value()`, `parts()`, etc.

---

## 4. Where to start redesign

If redesigning the popover UI:

1. Read `packages/session-ui/src/v2/components/prompt-input/index.tsx` (lines 776–848 for `PromptInputV2Popover`)
2. Read `packages/session-ui/src/v2/components/prompt-input/interaction.ts` (how `popover.select` triggers mention insertion)
3. Read `packages/ui/src/hooks/use-filtered-list.tsx` (the matcher — just overhauled)
4. Read `packages/app/src/components/dialog-command-palette-v2.tsx` (full-screen presentation)
5. Read `packages/app/src/components/prompt-input-v2.tsx` (app-level controller / context composition)
6. Check `docs/architecture/at-mention-sync.md` for server/client architecture context

The matcher is now robust (token-based, CamelCase-aware, acronym-aware, density-ranked, hybrid with fuzzysort). The UI layer (`PromptInputV2Popover`) is the design surface — redesign freely.
