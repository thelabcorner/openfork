# HANDOFF — Prompt Input (Chat Composer) Paste/Typing Performance + Large-Paste-to-Attachment

> **STATUS: IMPLEMENTED.** §3 Track A + §4.2 trims (1)–(3) landed via a parallel agent (`interaction.ts` paste branch, `largePaste`/`pasteFilename` in `attachments.ts`, gated `ids`, early-exit `blank`, `parsePromptInputV2Editor` returns `{ parts, text }`; tests: `attachments.test.ts`, `machine.test.ts`). §4.1 P0 debounce landed in `../../packages/app/src/utils/draft-store.ts` (500ms trailing coalesce per key, `flush()` on `DraftStore`, `removeItem` cancels pending — resurrection-proof at the chokepoint, pending-aware `getItem`, `attachDraftFlush` wired in `createBrowserDraftStore` for hidden/pagehide/beforeunload). `../../packages/app/test-browser/prompt-persistence.test.ts` updated to the deferred-write contract (+3 new debounce tests). Verified: session-ui 24/24, app browser-suite 51/51, app `src/utils` 123/123; typecheck clean except known baselines (session-ui TS2307 pre-existing; app errors confined to the parallel agent's unrelated `HostedBrowserWebview`/`browserHostClient` WIP). §8 item (4) cursor-TreeWalker remains intentionally NOT done (needs fixture tests). Desktop renderer (`../../packages/desktop/src/renderer/index.tsx`) builds its own `createDraftStore` without `attachDraftFlush` — optional follow-up.

Audience: the implementing agent. Everything marked **[VERIFIED]** was directly confirmed by the previous agent (code read at exact locations listed, live-tested in Storybook, or executed as tests). Do **not** re-verify these. Only items marked **[NEEDS-CHECK]** require your confirmation. Your job is design decisions + implementation, not rediscovery.

---

## 0. Mission

Two-track fix for the V2 chat composer (`PromptInputV2`) being extremely laggy with very long prompts, and stalling on giant pastes:

1. **Track A (feature/guardrail, ChatGPT-style):** pastes above a size threshold become a file attachment chip (`pasted-<timestamp>.md`) instead of being injected into the contenteditable. The infrastructure for this already exists end-to-end; it just isn't wired (see §3 — there is a dead guard today).
2. **Track B (performance):** eliminate the per-keystroke O(n)-in-prompt-size work, dominated by full-state serialization on every store change (§4.1) and several full-string allocations in the input pipeline (§4.2).
3. **Virtualization:** explicitly out of scope / not recommended — see §7 for why, so you don't burn time on it.

---

## 1. Component & data-flow map (all [VERIFIED] by code read)

The active composer is `PromptInputV2` in `../../packages/session-ui/src/v2/components/prompt-input`. Used by:
- `../../packages/app/src/pages/session.tsx` (~line 2069, `<PromptInputV2Composer>` when `settings.general.newLayoutDesigns()`)
- `../../packages/app/src/pages/new-session/new-session-view.tsx` (always)

Legacy V1 composer is `../../packages/app/src/components/prompt-input.tsx` (only shown when new-layout designs are OFF). It hides its scrollbar entirely and has its own separate paste handler. **Out of scope unless you choose parity work; do not assume V2 findings transfer.**

Data flow on every keystroke (editor `onInput`, `index.tsx` ~lines 171–177):

```
DOM input event
→ promptInputV2Cursor(editor)            // Range.selectNodeContents + setEnd + range.toString().length  (O(n) string alloc)
→ parsePromptInputV2Editor(editor)       // full DOM walk, string buffer concat                       (O(n))
→ images = parts.filter(type==="image")
→ controller.onInput(joined, [...prompt, ...images], cursor)   // joined = ANOTHER full .map().join("")  (O(n))
   ├─ draft.setPrompt(prompt, cursor)    // replaces whole array in Solid store (new identity)
   └─ dispatch({type:"input.changed", value, persist:false})
       ├─ transitionPromptInputV2(...)   // machine.ts inputChanged — see §4.3
       └─ setState(reconcile(result.state))                    // deep reconcile per keystroke
→ Solid effect (index.tsx ~70–78) re-runs on new parts identity but is skipped once via `localInput` flag
   → editor DOM is NOT rebuilt during typing [VERIFIED]
```

Store layer: `store.ts` — `createPromptInputV2Store`; `setPrompt` batches `setStore()("prompt", prompt)` + cursor. Pure helpers `insertText`, `insertMention`, `withOffsets`.

Persistence layer (this is the big one — §4.1):
- App wraps stores with `persisted(target, [store, setState])` — `packages/app/src/utils/persist.ts:568`. It delegates to `makePersisted` from `@solid-primitives/storage` (line 684), which issues a `setItem` **on every store change with no debounce**.
- Draft prompts persist through `Persist.prompt(...)` (`persist.ts:525`, sets `draft: true`) → routed to `platform.draftStore` (line 580–594) → `createBrowserDraftStore()` / `createDraftStore` in `../../packages/app/src/utils/draft-store.ts`.
- `DraftStore.setItem` (`draft-store.ts:83–88`) does, **per call**: `JSON.parse(value)` → deep async `encode()` walk (per-object `Object.entries` + `Promise.all` allocations; extracts blobs) → `JSON.stringify`. For an N-char prompt that is multiple full copies of the document **on every keystroke**, off the main thread only in the sense that it's async — the encode/stringify work is main-thread JS.
- Storage targets: IndexedDB in browser (`createBrowserDraftStore`, db `opencode-drafts`, stores `documents`/`blobs`); desktop uses `platform.storage` files; non-draft keys go through localStorage wrappers with an LRU cache (`persist.ts:33–77`).

Interaction/machine: `interaction.ts` (`createPromptInputV2Controller`) + `machine.ts` (`transitionPromptInputV2`). Relevant events: `input.changed` (machine.ts:64, 84–118), `key.down` (192–228).

Attachments: `attachments.ts` — `addAttachments(files)` → `add(file)` → `attachmentMime()` (text/* normalizes to `"text/plain"`, line 254) → `blobReference()` (SHA-256 id + objectURL) → appended to prompt parts as `{ type: "image", ... }` (**yes, the literal type is `"image"` for ALL attachments incl. pdf/text** — attachments.ts:124–131).

---

## 2. Environment & verification setup ([VERIFIED] live, this session)

- Storybook renders the composer standalone with zero backend: package `packages/storybook`, run `bun run storybook` (port 6006). Direct story URL:
  `http://localhost:6006/iframe.html?id=session-ui-prompt-input-v2--controlled-composition&viewMode=story`
  The story seeds attachments (incl. a `.md` card rendering with a "Markdown" type label — observed live) and a long prompt reaching max-height.
- Web dev server: `bun dev -- --port 4444` from `../../packages/app` (works without backend for shell/home; needs backend for real sessions).
- Backend: `bun run --conditions=browser ./src/index.ts serve --port 4096` from `../../packages/opencode` — **currently fails on this machine** with `database disk image is malformed` (pre-existing local DB corruption; do NOT touch, do NOT chase).
- Browser automation (openchamber_web panel) quirks learned the hard way:
  - Its `type` action **replaces** the entire contenteditable content rather than appending.
  - No persistent hover: synthetic clicks do not leave `pointerenter` latched; transient states (<1s) cannot be captured because inter-call latency > 800ms.
  - Panel occasionally navigates itself back to the previously open URL; retry `browser.open`.
- Typecheck: `bun typecheck` per package. `../../packages/ui` clean. `../../packages/session-ui` has ONE **pre-existing** error unrelated to this work: `src/v2/components/session-review-file-preview-v2.tsx(24,46): TS2307 Cannot find module './session-changes-v2'` (confirmed present with working tree stashed). Leave it alone / don't count it against your diff.
- Tests: `bun test src/components/scroll-view.test.ts` in `../../packages/ui` → 8/8 pass (baseline). Run tests from package dirs, never repo root.
- Repo rules that bite here (`AGENTS.md`s): any user-visible copy MUST go through i18n (`language.t`) — this applies if you add any toast/message for paste conversion; record perf baselines before/after (there is a `../../packages/app/bench` dir culture); never restart the app/server processes; conventional commits (`fix(app): …` / `perf(session-ui): …`).

---

## 3. Track A — Large-paste → attachment (ChatGPT-style)

### 3.1 The dead guard ([VERIFIED] — key finding)

`attachments.ts:275–278` already defines:

```ts
function largePaste(text: string) {
  if (text.length >= 8000) return true
  return text.split("\n").length - 1 >= 120
}
```

and `handlePaste` checks it (line 171). **But it is unreachable for the common case.** `interaction.ts onPaste` (~lines 415–442) routes to `attachments.handlePaste(event)` ONLY when the clipboard has files OR has no `text/plain`. Plain-text-with-content pastes take the other branch: `input.view.onPaste?.(event)` (app hook) → if not prevented → `document.execCommand("insertText", false, hugeText)` → native DOM injection → full re-parse pipeline. So today, an 8k+ char paste is inserted verbatim into the editor. (Note: even if `handlePaste` were reached, its text branch inserts the full text into the store/editor via `addPart` — it throttles execCommand, not document size. It is NOT an attachment conversion.)

### 3.2 What to build

In `interaction.ts onPaste`, plain-text branch, after `event.preventDefault()` and before `execCommand`:

```ts
if (largePaste(text)) {
  event.preventDefault()
  const file = new File([text], pasteFilename(), { type: "text/markdown" })
  void attachments?.addAttachments([file])
  return
}
```

- Export `largePaste` from `attachments.ts` (single source of truth for the threshold; consider raising char threshold slightly, e.g. 8–16k — your call, but reuse ONE function everywhere).
- Filename: `pasted-<timestamp>.md` style (e.g. `pasted-2026-08-21T09-41-00.md`). Timestamped names also sidestep the duplicate-detection heuristics (those only apply to `image` blob-id matching anyway — attachments.ts:110–123).
- `attachmentMime` will classify it `text/plain`; the chip renders via existing `AttachmentCardV2` + `typeLabel` machinery (live-verified rendering of `.md` cards).
- If `attachments` is undefined (controller created without attachment config), fall through to current behavior.
- **No toast/message by default** — the chip appearing IS the feedback, and adding copy triggers the full i18n process across all locales (see repo AGENTS.md; only do it if you're willing to own that).
- Parity follow-ups (optional, same pattern): (a) `handleDrop` text-drop branch currently only handles `file:` prefixes and files — route oversized text drops through the same conversion; (b) legacy V1 `handlePaste` in `../../packages/app/src/components/prompt-input.tsx` if you want parity.

### 3.3 Submit-path safety ([VERIFIED] infra, [NEEDS-CHECK] one thing)

Picked files (including `.md`, `.txt`, pdf) already flow through the exact same `addAttachments` → parts path, and the storybook card proves the UI half. **[NEEDS-CHECK]** Confirm the submit path sends non-image attachments correctly for a text/markdown part (follow `createPromptSubmit` in `../../packages/app/src/components/prompt-input-v2.tsx` ~line 423 → `submit.ts`; attachments carry `blob.url` objectURL and get read via `blobDataUrl` in `utils/draft-store.ts:156`). Since picked `.md` files already work in production via the file picker, paste-conversion inherits identical semantics — you are not creating a new submission category.

---

## 4. Track B — Performance

### 4.1 P0: debounce draft persistence (highest yield)

**[VERIFIED]** chain: store change → `makePersisted` (no debounce, `persist.ts:684`) → draft branch `setItem` (`persist.ts:672–675`, keeps `draftLatest`) → `DraftStore.setItem` (`draft-store.ts:83–88`): `JSON.parse` + recursive async `encode` + `JSON.stringify` of the whole draft document per keystroke.

Implement coalesced writes. Recommended shape:
- Debounce **at the draft-storage seam**, not inside Solid: wrap the `currentStorage` adapter built for `draft: true` targets in `persist.ts` (~line 583–589), or equivalently wrap `driver.set` inside `createDraftStore`. Trailing debounce ~400–700ms per key.
- The `versions` map in `DraftStore` already makes late async writes safe (stale-write guard) — debouncing composes cleanly with it.
- **Flush paths (must-have, else users lose drafts):** `removeItem` bypasses the timer (immediate + cancels pending), flush pending writes on `document.visibilitychange → hidden` and `pagehide`/`beforeunload`, and expose/implement an immediate write on submit (submit clears the draft via `removeItem` — verify that ordering: cancel pending set AFTER the clear, or you'll resurrect cleared drafts. This resurrection hazard is the #1 bug risk of this change).
- Scope: only `draft: true` targets need this; settings/localStorage keys are small. Don't debounce those.

### 4.2 P1: per-keystroke allocation trims (component + controller)

All [VERIFIED] locations; each is safe to trim independently:

1. `index.tsx` onInput (~171–177): `prompt.map(p => p.content).join("")` exists only to feed the machine's `input.changed.value`. The machine (machine.ts:84–118) uses `value` solely for: `value === "!"` shell trigger, `/^\/\S*$/` inline-command match, and the `@`-query regex over `value.slice(0, cursor)`. Options: (a) compute the `@`-query from the tail of the parsed text (parse already has the parts; the query cannot contain whitespace, so a bounded backward scan from cursor over the last text part suffices) and pass a tiny summary instead of the full string; or (b) minimal version — keep passing `value` but build it once: have `parsePromptInputV2Editor` accumulate the joined string while walking (it already buffers all text) and return `{ parts, text }` so the extra `.map().join("")` disappears.
2. `interaction.ts onKeyDown` (~238–245): computes `ids: suggestions().map(i => i.id)` and `draft.state.prompt.every(...)` on EVERY keydown even though `keyDown` in machine.ts ignores both when the popover is closed (except `empty` in shell mode). Gate `ids` computation on `state.popover.type !== "closed"`; compute `empty` lazily/cheaply (first non-empty part check with early exit — it already early-exits via `every`, fine).
3. `prompt-input-v2.tsx` `blank` memo (~334–340): full `.join("")` + `.trim()` of the whole prompt on every prompt change just to detect emptiness → replace with an early-exit scan (any part with non-whitespace content → not blank). Runs per keystroke.
4. `promptInputV2Cursor` (`index.tsx` ~380–387) and `editorCursor` (`interaction.ts` ~495–502): both do `range.toString().length` — a full-document string alloc per keystroke. You MAY optimize with a TreeWalker length-sum, **but** semantics must stay byte-identical: Chrome's `range.toString()` emits `\n` between block boundaries, and `parsePromptInputV2Editor` counts DIV/P separators as `\n` (index.tsx:365–368) — a naive text-node sum undercounts on multi-block content and corrupts mention offsets. If you do this, port the parser's block-boundary rule exactly and unit-test against `range.toString()` on multi-line fixtures.
5. `setState(reconcile(result.state))` per keystroke (`interaction.ts` ~213): small object; leave unless profiling says otherwise.

Non-issues ([VERIFIED] — do not waste time): the editor-DOM rebuild effect is correctly suppressed during typing via `localInput`; `canSubmit()` iterates few parts; `renderPromptInputV2Editor` replaceChildren is external-changes-only.

### 4.3 P2: measure

- Micro-bench the pure layers with `bun bench`-style scripts (repo precedent: `../../packages/app/bench`): `store.insertText`/`withOffsets` and `DraftStore` encode/setItem roundtrip at 10k / 100k / 500k chars, before vs after.
- Manual: storybook story + typing a 100k-char document (paste sub-threshold chunks repeatedly, or seed the store). Compare keystroke latency feel + Performance profile (look for: `encode` frames, `range.toString`, GC).
- Record numbers in the PR description (repo convention).

---

## 5. Already done by previous agent — DO NOT redo/revert ([VERIFIED])

Custom overlay scrollbar work, complete and verified (unrelated to perf but in the same files — rebase awareness):

- `../../packages/ui/src/components/scroll-view.tsx`: exported `ScrollViewOverlayScrollbar` (ScrollView-pill overlay thumb for external viewports; hover/scroll reveal, pointer-capture drag via `scrollTopFromThumbPointer`, resize observer, cleanup). Appends after `ScrollView`.
- `../../packages/session-ui/src/v2/components/prompt-input/index.tsx`: imports it, added `let editorArea` ref on the `relative min-h-[60px]` wrapper, mounted `<ScrollViewOverlayScrollbar viewport={() => editor} hoverTarget={() => editorArea} />`, added `no-scrollbar` to the editor class (native bar hidden).
- `../../packages/ui`: `bun typecheck` clean; `scroll-view.test.ts` 8/8 green.

Note many OTHER files in the working tree are modified by parallel work (git status shows broad churn across app/core/opencode/etc.). Stage only what you touch.

## 6. Constraints & conventions for the implementation

- Style: prefer `createStore` over signals (SolidJS rule in packages/app/AGENTS.md); no comments unless non-obvious; no `else` after `return`; inline single-use values; functional array methods; Bun APIs where applicable.
- i18n: any visible copy (toast labels, aria-labels for new UI) via `language.t` / ui `useI18n` — no hardcoded English. Prefer designs needing no new copy.
- Tests: from package dirs only (`cd packages/session-ui && bun test src/...`). Existing suites to keep green: session-ui prompt-input tests if present under `src/v2/components/prompt-input/` (check `*.test.ts`), app `session-composer-state.test.ts`.
- Never restart app/server processes; ask the operator to relaunch if needed.

## 7. Why NOT virtualization (read before attempting)

The editor is a single `contenteditable` div. True virtualization (windowing DOM nodes) is incompatible with native caret/selection/IME across chunk boundaries and would require replacing contenteditable entirely (e.g., ProseMirror/Lexical-style custom view or a plain `<textarea>`, which cannot host inline mention spans). ChatGPT's actual mitigation is exactly Track A: cap what enters the composer, overflow goes to attachments. Recommendation: implement Tracks A+B; if long-doc editing latency is STILL unsatisfactory after P0/P1, the strategic option is a textarea-based mode toggle (plain-text editing, mentions as `@path` strings) — a product decision, not a perf patch.

## 8. Suggested order of work

1. §4.1 debounce (+flush/resurrection guard) — biggest win, self-contained in `persist.ts`/`draft-store.ts`.
2. §3 Track A wiring in `interaction.ts onPaste` (+ export `largePaste`).
3. §4.2 trims (1)–(3); (4) only with fixture tests.
4. Benchmarks before/after; typecheck both packages (ignore the known TS2307); targeted tests.
