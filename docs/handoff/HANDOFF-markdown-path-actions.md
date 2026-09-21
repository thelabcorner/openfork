# Handoff — markdown path/URL actions resolution fix

## Status

**Resolved in source and verified through the full deterministic path chain, including the 2026-09-18 abbreviated-path regression.**

The original `sink_ab.mjs` exemplar from the earlier handoff no longer exists anywhere
under `/webstormprojects`, and `lane4-scratch` is also gone, so that exact historical
path should now correctly report missing. The remaining bug was nevertheless real: the
renderer reconstructed absolute paths from `sdk().directory` even though `/find/search`
is resolved against the server's canonical instance directory. Those roots can differ
because of aliases, symlinks, worktrees, or compatibility routing.

The fix makes `/find/search` return one authoritative `base` for the page, uses that base
for markdown path actions, probes candidate existence before reveal/open, and preserves
old-server/old-desktop fallbacks.

### 2026-09-18 addendum — human-abbreviated absolute paths

Fresh runtime evidence exposed one case the original closeout did not cover. Assistant
prose can intentionally shorten a long path with a whole `...` or `…` segment, e.g.
`C:\Users\slooshied\WebstormProjects\presGEN_v2\third_party_modules\forgeprint\...\forgeprint-output\iter00-baseline`
or `E:\...\bigfootSalesForm\forgeprint-output\verify\report.html`. The previous
absolute-path fast path treated that omission marker as a real directory and sent the
literal path to the desktop filesystem, producing a false `File not found`.

The corrected ownership model is: written target -> session workspace identity ->
canonical `/find/search` base + bounded file-index candidates -> native existence probe.
Concrete absolute paths still bypass search. Only paths containing a whole omission
segment enter abbreviation resolution. An abbreviated absolute prefix is accepted only
when it matches the current workspace root; omissions inside the workspace are expanded
against bounded index results. The implementation never recursively crawls a drive or
home directory and never emits a literal omission segment to `stat`/Open/Reveal.

The abbreviated search page is capped at 128 candidates while ordinary path actions keep
the historical 50-result page. This is interaction-only work: no new timeline scan,
observer, subscription, backend route, or background filesystem activity was added.

## What the feature does

Hovering an inline-code span in message markdown pops a dense floating toolbar.

- **path**: Copy · Reveal in File Explorer · Open · `⋯` Open with (installed editors)
- **url**: Copy · Open in browser

Detection reuses the existing `inlineCodeKind()` in session-ui, which already tags spans
`data-inline-code-kind="path|url"`. No second detector was written.

## Files

New (all in `packages/app/src/components/`):

- `markdown-target.ts` (+ `.test.ts`) — cleans written text: strips prose punctuation,
  surrounding quotes, and `file.ts:12:34` line suffixes. Copy keeps text verbatim.
- `markdown-path-resolve.ts` (+ `.test.ts`) — `isAbsolutePath`, `normalizeSeparators`,
  `joinPath`, `rankPathMatches`, `pathCandidates`, plus the resolver registry.
- `markdown-target-actions.tsx` — the toolbar. Document-level `pointerover` delegation,
  portal, anchored above the span.

New e2e: `packages/app/e2e/regression/markdown-target-actions.spec.ts`

Changed:

- `packages/app/src/app.tsx` — mounts `<MarkdownTargetActions />` inside `ServerShell`.
- `packages/app/src/pages/session.tsx` (~line 515) — publishes the path resolver.
- `packages/app/src/i18n/en.ts` — `markdown.target.*` keys.
- `packages/app/src/context/platform.tsx` — optional `pathExists?()`.
- `packages/desktop/src/main/ipc.ts` — `path-exists` handler.
- `packages/desktop/src/preload/index.ts` + `types.ts` — `pathExists` bridge.
- `packages/desktop/src/renderer/index.tsx` — exposes `pathExists` on the platform object.
- `packages/app/e2e/utils/mock-server.ts` — emits tool `metadata` (was `structured` only;
  the v2 reducer reads `metadata`, so mocked transcripts silently lost all tool metadata).

## Architecture notes (read before changing)

1. **Mount point matters.** The toolbar was first mounted inside `<main>` next to
   `props.children` in `pages/layout.tsx`. It mounted and was then **disposed** — the
   `makeEventListener` listener was torn off while a raw `addEventListener` control
   survived. That is how it was diagnosed. It now lives in `ServerShell` (`app.tsx`),
   above the layout arms, so navigation cannot dispose it. Do not move it back down.

2. **Resolver is a cross-scope bridge.** The toolbar is app-wide; the file index
   (`useFile().searchMentions`) is session-scoped. `session.tsx` registers a resolver via
   `setMarkdownPathResolver` (module-level registry, same precedent as
   `pages/session/handoff`). If no session is mounted, relative paths resolve to `[]`.

3. **Resolution returns ranked candidates, not one path.** `pathCandidates()` now prefers
   an explicit relative subpath joined to the server-authoritative search `base`, then
   ranked index hits under that same base, then the client-directory literal fallback.
    Concrete absolute mentions remain direct. Abbreviated absolute mentions route through
    the session resolver and are re-rooted only when the canonical workspace satisfies the
    visible path pattern. The toolbar probes with `platform.pathExists` and
   uses the first existing candidate. Older desktop builds without the probe still use
   the first ranked candidate.

4. **Search queries the basename**, then `rankPathMatches` re-applies the full written
   text. For explicit subpaths, the canonical literal is attempted before fuzzy same-name
   hits, so a target remains reachable even when 50 duplicate-name results push it off
   the search page.

5. **Compatibility is intentional.** New servers return `MentionSearchPage.base`. The V1
   adapter synthesizes that base from the routed/configured directory. Older servers that
   omit it still fall back to the client directory.

## Root cause and final fix

The renderer-side project root was not authoritative. `file.searchMentions()` searched
inside the server instance, but the toolbar rebuilt returned relative paths against
`sdk().directory`. A valid index result could therefore become an invalid absolute path
before the desktop filesystem probe ever saw it.

Final chain:

1. `/find/search` returns `{ base, results, hasMore, total }`, where `base` is
   `InstanceState.context.directory`.
2. The app preserves `base` through mention normalization and the V1 compatibility
   adapter.
3. The session resolver passes `canonicalDirectory: page.base` to `pathCandidates()`.
4. Explicit relative subpaths are tested canonically first, ahead of fuzzy duplicate-name
   hits.
5. `firstExistingPath()` probes candidates serially and exits on the first existing path.
   A stale row or one failed probe cannot block a later valid candidate.
6. If every probe throws, the infrastructure error is surfaced rather than mislabeled as
   `File not found`.
7. Desktop `path-exists` now returns `false` only for `ENOENT`/`ENOTDIR`; other filesystem
   errors propagate. `shell.openPath()` error strings are also promoted to real errors.

The server sends one page-level base instead of a repeated absolute path per result. This
is both more canonical and substantially smaller on the wire.

## Verification state

- **68/68 focused tests pass** across `server-compat.test.ts`,
  `at-mention-search.test.ts`, `markdown-path-resolve.test.ts`, and
  `markdown-target.test.ts`.
- Edge coverage includes Windows/POSIX/UNC paths, mixed separators, filesystem roots,
  Windows drive designators, case-aware dedupe, stale candidates, partial/all probe
  failures, and a 50-decoy duplicate-filename case where the intended subpath is absent
  from the search page.
- Additional invariant fuzz covered 125 combinations of separator style, path depth, root
  style, filename casing, and 60 same-name decoys with no duplicate candidates or
  canonical-order violations.
- The real HTTP API exerciser reports **PASS** for `GET /find/search` and verifies
  `base === ctx.directory` plus a real seeded-file result. The overall coverage command
  still exits nonzero because the repository already has 86 unrelated routes with no
  scenario; the run itself reported `210 pass, 0 fail, 0 skip`.
- Unified SDK was regenerated. `packages/sdk/js` build + typecheck passes.
- App and desktop package typechecks still fail only in pre-existing unrelated dirty-tree
  areas (`context-history`, `context-ledger`, session event types, browser
  appearance/sidebar, desktop onboarding). There are no diagnostics in the markdown
  resolver, search route, compatibility adapter, generated SDK, or desktop path IPC
  changes.
- Hostile 50-duplicate candidate construction improved from **105.6 µs/call, 102
  candidates** to **59.5 µs/call, 52 candidates**, about **44% lower resolver CPU time**
  and roughly half the worst-case probe ceiling.
- Page-level `base` reduces a synthetic repeated-absolute response by about **73%** at 50,
  200, and 1000 search results.
- The desktop process was not restarted during this work. Source-level desktop IPC
  behavior is compiled/audited, while live manual click-through requires the normal next
  desktop launch to load changed main/preload code.
- 2026-09-18 abbreviation addendum verification: app-focused path suite **69 pass / 0
  fail**, session-ui classifier **3 pass / 0 fail**, targeted Playwright regression **1
  pass in 5.1s**, session-ui typecheck **PASS**, app production build **PASS** (4965
  modules, ~1m11s). Current app-wide typecheck remains blocked by unrelated dirty-tree
  diagnostics in `context-history`, `context-ledger`, `context/sdk.tsx`,
  `server-session.test.ts`, and `session-message.test.ts`.
- Final interaction microbench (5 samples, median): concrete absolute fast path **0.386
  µs/op**; 50-candidate abbreviation ranking **104.28 µs/op**; full 128-candidate bound
  **254.857 µs/op**. The added work is therefore sub-millisecond even at the hard search
  bound and is paid only after an explicit filesystem action.

## Unrelated work in the same working tree

Earlier in the session the question-tool expanded output was redesigned
(`packages/session-ui/src/components/message-part.tsx` + `.css`): subgrid-aligned option
rows, content-hugging highlights, visible details rule. That is complete and verified;
do not confuse it with the path-actions work.
