# HANDOFF — Project Explorer massive gaps + metadata (WORSE after latest patch)

Date: 2026-08-30
Author: muse-spark-1.2 (this session)
Status: **NOT FIXED — worse**

> Copy-paste prompt for next agent (Claude) is in §6.

---

## 0. Symptom

**User report:** "It still is not solved, if not even worse now!"

Latest screenshot (2026-08-30) of the left `PROJECT` pane shows:

- `_archivetest` at very top,
- then void,
- `.git` (badge `6`), `.sync-scratch`, `artifacts` (`65 MB 10d ago`), `claude-first-party-plan` (`113 KB 6d ago`) clustered in upper half,
- then **huge empty void** (~45% of pane height) where ~10-15 top-level dirs should be,
- then `docs` (`45 12 MB 18h ago`), `github` (`122 KB 10d ago`), `infra` (`84 KB 10d ago`), `nix` (`45 KB 9d ago`) clustered near middle,
- then another void to bottom. Scroll thumb tiny → virtualizer thinks many rows exist.

Metadata *does* now appear (so backend `size`/`mtime`/`lineCount` pipeline partly works), but spacing is unusable.

**Expected (premium JetBrains):** `packages/app/src/components/project-explorer-tree.css:1-4` says *denser, higher-contrast, tighter row height, no gap between rows*. Dense 22px rows, `gap:0`, full-color `FileIcon` always, filename color by `Kind` (`add`=`success`, `mix`=`info`, `del`=`danger line-through`), `project-explorer-count` pill, `size`/`lines`/`time` on the right (`362 B · Jul 9`, `601 B · 6d ago`, `840 B · 2d ago`), live relative time, tooltips, skeleton/empty/error states. Reference is second image from original issue (tight list with `forgexprint.Dockerfile 362 B · Jul 9` etc.), not the void screenshot.

**Also observed:** Earlier session showed toast `Failed to list files / Unexpected server error. Check server logs for details.` from `packages/app/src/context/file.tsx:157-166` / `packages/app/src/context/file/tree-store.ts:186-196` → fixed server-side but gaps remain.

---

## 1. What I changed (all UNCOMMITTED — run `git diff HEAD` to see)

### 1a. `packages/core/src/filesystem/index.ts:143-168`
**Bug fixed:** `attachMeta` used `Effect.map(info => { ... return fs.readFileStringSafe(...).pipe(...) })` — mapper returned `Effect<Entry>` for line-count files, so `forEach` collected `Entry | Effect<Entry>` and persisted invalid blobs → next `GET /file?path=` threw.

```ts
// Before (bug)
Effect.map(info => {
  const base={...size,mtime}
  if (tooBig||binary) return base
  return fs.readFileStringSafe(abs).pipe(Effect.map(...)) // <- nested Effect
})

// After (fix)
Effect.flatMap(info => {
  if (tooBig||binary) return Effect.succeed(base)
  return fs.readFileStringSafe(abs).pipe(...)
})
```

Plus `LINE_COUNT_MAX_BYTES=512*1024`, `BINARY_EXT_RE`, and `tryLoadFromSearchDB` now restores `lineCount` `packages/core/src/filesystem/index.ts:388-394`. `bun test test/filesystem/index.test.ts` 7 pass, `index-serialization` 8 pass.

### 1b. `packages/app/src/components/project-explorer-tree.tsx` (full rewrite, 688→~750 lines)
Restored premium that checkpoint `7be910e1` had deleted:
- `import {onCleanup} + format* from at-row-meta` `packages/app/src/components/project-explorer-tree.tsx:1-19`
- `rootError` memo, `now` 60s ticker `packages/app/src/components/project-explorer-tree.tsx:54-75`, `TreeSkeleton` (8 pulse rows), `EmptyState` (search vs empty), inline error `data-slot=project-explorer-error` with retry `file.tree.list("",{force:true})`, sticky `Loading N files…` bar
- Virtualizer `gap:0` + `overflow:hidden` on absolute row `packages/app/src/components/project-explorer-tree.tsx:188-191,379-382`
- `ProjectExplorerRow` now derives `folderCount` (when `state.loaded` → `children(dir).length`), `size`/`mtime`/`lineCount` with string→number coercion, `relativeTime`/`absoluteTime` via `formatRelativeTime(t, now)`/`formatAbsoluteTime(t, intl())`, renders `packages/app/src/components/project-explorer-tree.tsx:580-780`:
  ```tsx
  <span data-slot="project-explorer-meta">
    <span data-slot="project-explorer-count">{formatFolderCount}</span>
    <span data-slot="project-explorer-size">{formatFileSize}</span>
    <span data-slot="project-explorer-lines">{formatLineCount}</span>
    <span data-slot="project-explorer-time">{relativeTime}</span>
  </span>
  ```

### 1c. `packages/app/src/components/project-explorer-tree.css`
- Container `gap:0;padding:0;margin:0` `packages/app/src/components/project-explorer-tree.css:6-10`
- `meta` as `flex gap:6px justify-content:flex-end max-width:46%` plus pill `count` (16×14, 999px, `bg-layer-03`, dashed `data-empty`), `size`/`lines`/`time` 10.5px tabular-nums, selected recolor, responsive hides `@media ≤340px time, ≤300px lines, ≤260px size` `packages/app/src/components/project-explorer-tree.css:33-110`

### 1d. Contracts (already in working dir before my patch, kept)
- `packages/schema/src/filesystem.ts:25` `lineCount`, `packages/opencode/src/server/routes/instance/httpapi/groups/file.ts:168` `LegacyEntry.lineCount`, `handlers/file.ts:233` spread, `packages/sdk/js/src/v2/gen/types.gen.ts:2505`

**Typecheck:** `typecheck bottomUp project-explorer-tree.tsx` → 0 P0/P1 (80× `TS6307` include false positives only; `changed` shows 2 pre-existing P1 in `prompt-input-v2.tsx`). `bun test` core filesystem passes.

**But gaps are now larger** → virtualizer positioning bug introduced by the rewrite.

---

## 2. Regression hunt (checkpoint tool)

```
checkpoint search touchedPath:packages/app/src/components/project-explorer-tree.tsx --across worktree
checkpoint view 7be910e1-a03c-4703-9099-0ffeb4508c59
checkpoint diff 7be910e1
git log --oneline -20 -- that-file
git show 81fbbdd576 --stat
```

- `81fbbdd576 feat(app): add project explorer…` is origin.
- `7be910e1` (`ses_fb4b76765ffeJMZfkmqAIrNUlw`, `Project explorer rendering issues`) deleted 688, added 330 — stripped skeleton/error/now/folderCount/meta. Its parent is last known good premium. `HEAD` `a177345523` is the stripped version. My patch tried to re-add premium but introduced gap bug.

---

## 3. Hypotheses for gaps (check in order)

1. **Virtualizer `gap` / `measureElement`** — `@tanstack/solid-virtual` `createVirtualizer`. We force `gap:0` but installed version may ignore or have default `gap:??`, or `measureElement` auto-measures row height >22 due to meta flex wrapping → `item.start` spaced far. Check `initialRect:{w:0,h:600}`, `estimateSize:()=>22`, `overscan:12`, `getScrollElement:()=>virtualScrollElement(root())` (`packages/app/src/components/virtual-scroll-element.ts:1-4` → `closest(".scroll-view__viewport")`). If `root` not yet connected → null → initialRect path.
2. **Sparse `virtualRowKeys`** — `rangeExtractor` does `defaultRangeExtractor(range)` + adds `focused` index if missing `packages/app/src/components/project-explorer-tree.tsx:197-203`. If `focused` is `docs` (or `selected`), `For each virtualRowKeys` renders `[0..12, 20]` with hole `13-19` → visible gap. `focused` initially undefined, but verify `selected`/`focused` signals after my change.
3. **ContextMenu wrapper** — each row wrapped in `<ProjectExplorerTreeContextMenu>` → `MenuV2.Context.Trigger class="block w-full min-w-0" as="div"` `packages/app/src/components/project-explorer-tree-context-menu.tsx:60-63`. That block div may have margin/padding from `ui` inflating measured height. Absolute row has `overflow:hidden` but trigger inside may measure larger.
4. **CSS flex vs absolute** — tree container `display:flex flex-col gap:0` but children are absolute; flex gap irrelevant. `ScrollView` viewport `packages/ui/src/components/scroll-view.tsx:99-388` `flex:1 overflow-y:auto` may add padding.
5. **`visibleRows` undercount** — `visibleRows` is `rows()` when not searching, `rows()` from `flattenLiveFileTreeV2((p)=>file.tree.children(p),expanded)` `packages/app/src/components/file-tree-v2-model.ts:79-99`. If `children("")` incomplete (FileIndex still loading, `state.loaded` false) then `visibleRows.length` small but `virtualizer.getTotalSize()` uses that small count → totalSize small, not large. Gap indicates totalSize large but rendered keys sparse — so more likely (2) or (1).

---

## 4. Files to inspect (read before editing)

```
packages/app/src/components/project-explorer-tree.tsx:181-204,342-380
packages/app/src/components/project-explorer-tree.css
packages/app/src/components/file-tree-v2-model.ts
packages/app/src/components/virtual-scroll-element.ts
packages/app/src/components/project-explorer-tree-context-menu.tsx
packages/app/src/context/file.tsx:153-167
packages/app/src/context/file/tree-store.ts:118-204
packages/core/src/filesystem/index.ts:143-220
packages/app/src/components/prompt-input/at-row-meta.ts:28-105
packages/ui/src/components/scroll-view.tsx + .css
```

I18n keys exist: `projectExplorer.folder.empty`, `projectExplorer.folder.count.tooltip`, `projectExplorer.folder.count` (plural), `projectExplorer.meta.modifiedAbsolute`, `toast.file.listFailed.title`, `common.retry` `packages/app/src/i18n/en.ts:34-40`.

---

## 5. How to reproduce without restarting server (per AGENTS.md NEVER restart app/server)

- Backend: `bun run --conditions=browser ./src/index.ts serve --port 4096` in `packages/opencode` (if not already running — ask user before launching).
- App: `bun dev -- --port 4444` in `packages/app`.
- Open `http://localhost:4444`, toggle Project Explorer (`layout.projectExplorer` in `context/layout.tsx`, titlebar `filetree` icon, `ProjectExplorerPanel` in `pages/session.tsx:2401` + `project-explorer-panel.tsx:180`).
- Hard refresh, observe gaps. DevTools → inspect `[data-component=project-explorer-tree]` height vs `visibleRows().length*22` vs `virtualizer.getTotalSize()` vs `virtualizer.getVirtualItems().map(i=>[i.key,i.start,i.size])` vs `virtualScrollElement(root())`.

---

## 6. Claude prompt (paste this to Claude)

> You are fixing OpenCode’s Project Explorer.
>
> **Broken:** left `PROJECT` pane shows huge voids between rows (e.g. `claude-first-party-plan` → void → `docs` gap ~45% viewport, `_archivetest` top then cluster then void). Only ~9 top-level dirs visible. Metadata *does* show (`45 12 MB 18h ago`, `6` on `.git`) so backend `size`/`mtime`/`lineCount` works, but spacing unusable. Second screenshot in issue (tight `362 B · Jul 9` list) is expected.
>
> **What was done:** `git diff HEAD` shows my uncommitted patch: fixed `packages/core/src/filesystem/index.ts:149-162` `Effect.map`→`flatMap` bug that caused `Unexpected server error` on `GET /file`, and rewrote `project-explorer-tree.tsx/css` to premium (skeleton, error+retry, now ticker, folderCount/size/lines/time via `at-row-meta`, virtualizer `gap:0 overflow:hidden`). Gaps got worse → virtualizer bug.
>
> **Regression:** `checkpoint 7be910e1-a03c-4703-9099-0ffeb4508c59` stripped premium; parent is last good. `HEAD` is stripped.
>
> **Fix gaps first, then polish to JetBrains density (22px, gap:0, tabular-nums, hover/selected/focused, count pill, responsive hides).**
>
> **Investigate in order:** (1) `@tanstack/solid-virtual` `gap`/`measureElement`/`initialRect`/`getScrollElement` (`virtual-scroll-element.ts`), (2) `rangeExtractor` adding `focused` → sparse `virtualRowKeys` → holes, (3) `MenuV2.Context.Trigger block w-full` wrapper inflating measured height, (4) `ScrollView` viewport, (5) `visibleRows` undercount.
>
> **Read before editing:** `project-explorer-tree.tsx:181-204,342-380`, `project-explorer-tree.css`, `file-tree-v2-model.ts`, `virtual-scroll-element.ts`, `project-explorer-tree-context-menu.tsx:60-63`, `context/file.tsx:153-167`, `tree-store.ts:118-204`, `filesystem/index.ts:143-220`, `at-row-meta.ts`.
>
> **Repro:** `bun dev -- --port 4444` (`packages/app`) + backend on `4096`, open `http://localhost:4444`, inspect `visibleRows.length`, `getTotalSize()`, `getVirtualItems()`.
>
> **Accept:** no voids, contiguous 22px rows, `size·lines·time` + `count·size·time` right-aligned, skeletons/error/empty work, typecheck 0 P0/P1, filesystem tests pass. Keep `gap:0` intent but verify against installed `@tanstack/solid-virtual` API.

---

## 7. Current git status

`git status --porcelain` shows ~45 modified files (my premium patch + unrelated quota/workbuddy changes already in working dir). The project-explorer relevant diff is only the 3 files above — isolate them when fixing. Do not `git checkout` unrelated files without asking.

## 8. Next agent checklist

- [ ] `git diff HEAD -- packages/app/src/components/project-explorer-tree.tsx packages/app/src/components/project-explorer-tree.css packages/core/src/filesystem/index.ts`
- [ ] Reproduce at `http://localhost:4444`, log `visibleRows`, `getTotalSize`, `getVirtualItems`, `virtualScrollElement`
- [ ] Fix gap bug (likely `rangeExtractor` or `measureElement`/`gap`)
- [ ] Verify dense JetBrains list + metadata + skeleton/error
- [ ] `typecheck changed` / `bottomUp` 0 P0/P1, `bun test` filesystem

