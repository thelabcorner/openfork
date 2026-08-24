# 05 — Chat & Tools on Mobile (Timeline, Tool UX, Diffs, Permissions, Composer, Context Pane)

> Owner: `chat-tool-ux` · Swarm `pwa-mobile` · Phase: IDEATION ONLY (no code changes).
> Upstream: [00-handoff §2.6–2.8, §3](00-handoff.md). Consumes 01 (nav model), 02 (tokens/density/disposition), 03 (source-of-truth), 04 (V1 endpoints/sync), 06 (keyboard/safe areas/platform).
>
> **Citation discipline:** every reused component carries a `path:line` citation I read in this repo, or cites the coordinator's verified handoff section. Anything I did not verify is labeled **inference** or **[DEPENDS]**. New mobile-only patterns are tagged **[NEW-PATTERN]**; reused desktop patterns are tagged **[SHARED]**.

---

## 0. Design stance (read this first)

The desktop chat is already built from a shared kit (`../../../packages/session-ui`) rendered inside `AppInterface` (`../../../packages/app/src/app.tsx`). The mobile PWA's chat must be **the same components with a mobile behavior shell around them**, not a rewritten chat. Three signature decisions govern everything below (also published to the hive):

1. **Turn-level virtualization.** The timeline virtualizes at `SessionTurn` granularity, not per-part. Turns are already the auto-scroll unit (`session-turn.tsx:379–383`); parts mutate every token during streaming, so part-level rows would thrash measurements.
2. **Inline-expand parity + promote-to-sheet.** Tool rows expand inline exactly like desktop (`basic-tool.tsx` untouched). A mobile-only affordance promotes any open tool body into a full-height sheet when the inline body is too tall to read comfortably.
3. **Unified diffs by default; diff review replaces the file explorer.** Below 640 px (= the existing `--breakpoint-sm` token, per 02 §3.3), unified is the default and recommended style; split stays selectable with per-pane horizontal pan. With the explorer excluded (00-handoff §1), `SessionReview` is the *only* file-inspection surface on mobile.

Everything else is parameterization of these three.

---

## 1. Timeline spec

### 1.1 Component mapping — what each session-ui piece becomes on a phone

| Desktop building block | Path | Mobile disposition |
|---|---|---|
| Turn container | `packages/session-ui/src/components/session-turn.tsx:153–540` | **[SHARED]** one turn = one virtual row |
| Part renderer / registry | `packages/session-ui/src/components/message-part.tsx:257` (`PART_MAPPING`), `:1608–1629` (`Part`) | **[SHARED]** unchanged; extensible via `registerPartComponent` (`message-part.tsx:1025–1027`) |
| Assistant parts w/ context grouping | `message-part.tsx:811–913` (`AssistantParts`), `groupParts` `:750–792`, `CONTEXT_GROUP_TOOLS` `:694` | **[SHARED]** read/glob/grep/list collapse into "Gathered context" group — ideal density win on phones |
| Markdown streaming projection | `markdown-stream.ts:53–122`; worker queue `markdown-worker-queue.ts:36–48`; worker infra `markdown.worker.ts`, `markdown-worker-protocol.ts`, `markdown-worker-transport.ts`, cache `markdown-cache.tsx` | **[SHARED]** runs as-is; workers are PWA-safe (module workers) |
| Token pacing | `message-part.tsx:259–261` (`TEXT_RENDER_PACE_MS=24`, `TEXT_RENDER_IMMEDIATE=512`), `createPacedValue` `:279–341` | **[SHARED]** keep identical pacing — it exists precisely to protect weak render loops |
| Tool count summary | `tool-count-summary.tsx:10–47` (`AnimatedCountList`), `tool-count-label.tsx` | **[SHARED]** |
| User message bubble | `message-part.tsx:1356–1567` (`UserMessageDisplay`) | **[SHARED]** copy/revert actions move into long-press menu (§8) but remain rendered for a11y |
| Retry card | `session-retry.tsx:8–73` | **[SHARED]** |
| Compaction/interrupted divider | `message-part.tsx:1810–1827` (`MessageDivider`), `session-turn.tsx:292–297` | **[SHARED]** |

**Virtualization strategy [NEW-PATTERN]:**
- App already ships `@tanstack/solid-virtual` (00-handoff §2.3 ✅ package.json; used today at `packages/app/src/components/prompt-input/slash-popover.tsx:2`).
- One scroller per session screen; rows = turns keyed by user-message ID (`SessionTurn` resolves its assistant children via `parentID`, `session-turn.tsx:272–290`).
- Dynamic measurement via `measureElement`; `overscan` ≈ 1 viewport above / 2 below; estimate ~120 px/turn initially.
- Heavy default-open tool bodies already defer mounting bottom-first ("viewport starts at the latest turn", `basic-tool.tsx:64–67`) — this composes correctly with opening a session scrolled to bottom.
- Long sessions: window the turn list itself (fetch pages) — data layer owned by api-data, `[DEPENDS: 04 §sync]`.

### 1.2 Streaming states

All states below are produced by existing primitives; mobile only restyles containers:

- **Token streaming:** paced markdown reveal (`message-part.tsx:343–354` `PacedMarkdown`); streaming detection = assistant message without `time.completed` (`message-part.tsx:1882–1884`). Incremental code-fence append without re-lexing (`markdown-stream.ts:106–121`); latest-wins highlight queue prevents worker pileup (`markdown-worker-queue.ts:36–48`).
- **Part transitions:** grouped parts use custom equality so streaming appends don't remount upstream parts (`message-part.tsx:843–846` `{ equals: sameGroups }`). Mobile adds nothing here — do not introduce keyed animations that break this.
- **Thinking states:** while working with zero visible parts → shimmer "Thinking" + reasoning-heading reveal (`session-turn.tsx:372–377`, `:422–434`, `TextShimmer`/`TextReveal`). While tools run, per-row shimmer titles (`basic-tool.tsx:224`) and the context-group status label flip Gathering→Gathered (`message-part.tsx:1177–1181`).
- **Retry-in-progress:** `SessionStatus.type === "retry"` renders countdown card incl. provider-specific copy (`session-retry.tsx:10–51`).
- **Interrupted turn:** divider + meta suffix (`session-turn.tsx:292–297`; `message-part.tsx:1834–1837` detects `MessageAbortedError`).
- **Working chrome:** assistant region is `aria-hidden` while working and the container is `aria-live="off"` (`session-turn.tsx:401,410`) — keep exactly; iOS VoiceOver + streaming otherwise becomes unusable.

### 1.3 Scroll anchoring + jump-to-latest

- **[SHARED] anchor contract:** `createAutoScroll({ working, onUserInteracted, overflowAnchor: "dynamic" })` (`session-turn.tsx:379–383`, hook from `@opencode-ai/ui/hooks`). Mobile must feed it real signals: any touch-scroll sets "user interacted"; tapping jump-to-latest resets it.
- **[NEW-PATTERN] Jump-to-latest pill:** floating pill bottom-center above the composer; visible iff (a) an active turn is streaming, and (b) the newest turn's bottom is >200 px below viewport bottom. Tap = smooth-pin to newest turn + clear user-interaction flag. Badge shows "+N" new parts since scroll-away (count derived from `grouped()` length delta — cheap memo, no store change).
- **Keyboard interplay:** the 06 `KeyboardInset` store drives re-anchoring — on viewport shrink, if pinned-to-latest, stay pinned; no component other than the inset store touches visualViewport.
- Rubber-banding: overscroll glow/bounce is fine inside the scroller; the pill and composer live outside the virtualized scroller so bounce never displaces them.

---

## 2. Tool UX on small screens

### 2.1 Collapsed row anatomy (all families)

**[SHARED]** `BasicTool` (`basic-tool.tsx:99–321`): icon + shimmer title while pending (`:224`), subtitle/args hidden until not-pending (`:226`), arrow only when body exists and openable (`:270`). Pending/running rows cannot be opened unless `allowOpenWhilePending` (`:192–196`); `locked` rows can't close (`:194`). Keep all of it — on a phone the collapsed row IS the tool UX for 90% of tools.

Mobile deltas (per 02-design-system density/touch rules):
- Trigger rows pay the full 44 px hit tier (list-row class per 02); visual density stays New-York dense, hit slop absorbs the difference.
- **Tap semantics:** tap anywhere on a collapsed row toggles inline expand (pending rows locked per `basic-tool.tsx:192–196`); the Maximize chevron inside an *open* body promotes it to the full-height sheet (§2.3); long-press opens the action menu (§8) without changing expand state.
- Subtitle truncation: single line, middle-ellipsis for paths (desktop truncates tail); full value available in expanded body and long-press copy.

### 2.2 Per-family lifecycle

Defaults come from `partDefaultOpen` (`part-default-open.ts:19–26`): bash/shell closed unless `shell=true`; edit/write/patch/apply_patch open iff `edit=true` and not deletion-only (`deletionOnly` `:3–17`). Unchanged on mobile.

| Family | Renderer | Collapsed shows | Expanded body (mobile policy) |
|---|---|---|---|
| read/list/glob/grep | registered in `message-part.tsx:2124–2260`; grouped into ContextToolGroup `:1136–1287` | group header w/ animated counts (`AnimatedCountList` keys `ui.messagePart.context.read/search/list` `:1188–1204`) | per-item bodies: file text via FileComponent `overflow="scroll"` (`:2166–2177`), parsed grep groups w/ match highlight (`:2035–2075`), glob rows (`:2095–2122`). Inline cap 40 vh → promote-to-sheet. |
| bash/shell | `getTool("shell")` aliasing (`message-part.tsx:1664–1666`); `ShellTimer` `:70` import | command as subtitle | output via `SmartToolOutput`; monospace, no wrap toggle v1; timer chip stays. |
| edit/write/patch/apply_patch | `ToolFileAccordion` sticky per-file headers (`message-part.tsx:1673–1707`); patch parsing `apply-patch-file.ts:18–60` | filename + DiffChanges | per-file diff (unified default, §3). Deletion-only edits stay closed by default (`part-default-open.ts:3–17`) — show "N deletions" chip instead. |
| git | `GitOutput` (`git-tool.tsx`, wired `message-part.tsx:71`) | action label (status/log/diff…) | structured output; long logs promote-to-sheet. *(Deeper internals unverified — inference.)* |
| typecheck | `TypecheckOutput` (`typecheck-tool.tsx:34–50+` parses XML diagnostics) | pass/fail + count | diagnostic list rows (file:line, severity color); tap row → copy coords (no editor to open — §3 exclusion). |
| sqlite / sympy | `SqliteOutput` / `SympyOutput` (`sqlite-tool.tsx`, `sympy-tool.tsx`, wired `message-part.tsx:73–74`) | action label | tables/results horizontally scrollable; math rendered via markdown/katex path. *(Internals unverified — inference.)* |
| task (subagents) | error/title path w/ session link (`message-part.tsx:1725–1739,1770–1780`) | agent name + description | tap navigates to child session (`data.navigateToSession`) — pushes the existing session route (01: zero new routes; `/server/:serverKey/session/:id`). |
| question | hidden while pending/running (`renderable` `message-part.tsx:801`, `hideQuestion` `:1715–1717`) | — | answered questions render inline afterwards. **Pending questions must surface as a mobile ask-sheet** — see §4.4 (inference: desktop surfaces them outside the timeline; component unverified). |
| webfetch/websearch | `message-part.tsx:2262–2293+`, links extracted `ExaOutput` `:999–1023` | URL/provider subtitle | links open external via Platform `openExternal` (00-handoff §2.4). |
| unknown/MCP | `GenericTool` (`basic-tool.tsx:342–384`): input JSON + SmartToolOutput | tool name + label heuristic (`label()` `:323–326`) | same; JSON pretty-printed into CodeView (`tool-output.tsx:8–24`). |
| errors | `ToolErrorCard` (`tool-error-card.tsx:22–168`): collapsible, copy button, i18n name map `:45–65` | red-tinted card, failure reason as subtitle | expanded shows full error + Copy; share via §2.4. |

### 2.3 Progressive disclosure rules

1. Default openness = desktop defaults (`part-default-open.ts`) — parity beats cleverness.
2. One level deep by default: expanding a context group does not auto-expand items (`ContextToolGroup` per-item toggles, `message-part.tsx:1224–1244`).
3. Bodies taller than ~40 vh get internal scroll + a **Maximize** affordance **[NEW-PATTERN]**: chevron-up button in the body header opens the same body in a full-height detent sheet (component reuse: the body JSX is lifted, not rebuilt). Close returns scroll position to the inline body. This is the only mobile-only tool interaction, and it wraps — never modifies — session-ui components.
4. Never auto-expand anything during streaming except what `partDefaultOpen` already opens at mount; mid-stream expansions cause layout jumps that the virtualizer punishes.

### 2.4 Result truncation policies

- **Server-side truncation markers are already handled**: grep "(Results truncated" (`message-part.tsx:2003,2015`) and glob "(Results are truncated" (`:2086–2091`) render explicit truncation footnotes. Do not double-truncate client-side.
- **Client rendering caps:** review diffs guard at 500 changed lines with explicit "render anyway" (`session-review.tsx:29,411–416,591–612`); patch-diff parse cache LRU=16 (`session-diff.ts:28,55–72`).
- **Mobile policy:** all scrollable bodies become internally scrollable regions (`data-scrollable role="region" tabIndex=0` — already emitted, e.g. `tool-output.tsx:62–70`) capped at 40 vh inline; content beyond that is reached by scrolling inside the region or Maximize-to-sheet. **No new data truncation on mobile** — parity with desktop bytes.
- Copy always copies the FULL underlying string (existing behavior: clipboard helpers `message-part.tsx:77–99`), never the visually truncated slice.

### 2.5 Copy / share affordances

- **[SHARED]** Copy buttons exist on user messages, assistant text parts, and error cards (`message-part.tsx:1515–1563,1915–1931`; `tool-error-card.tsx`). On mobile they also appear in long-press menus (§8).
- **[NEW-PATTERN] Share:** `Platform.share?(payload)` — specced as an optional, no-op-safe platform addition in 03-source-of-truth's platform-delta tables; PWA impl uses Web Share API with clipboard fallback. Surfaces: tool body header, error card, diff file header. If Platform lacks `share`, hide — no dead buttons.

---

## 3. Diff viewing on narrow viewports

Surfaces involved: turn-level summary (`session-turn.tsx:436–527`: ≤10 files, `DiffChanges` +/- chips, sticky accordion headers, lazy `fileComponent mode="diff"` `:509–513`) and full review (`session-review.tsx`).

### 3.1 Stance

- **Unified is the default below 640 px** (`--breakpoint-sm`, `theme.css:25` per 02 §3.3) and the recommended style overall. The unified/split RadioGroup already exists (`session-review.tsx:347–358`) — keep it reachable in a compact segmented control in the review header.
- **Split, if chosen, pans horizontally per pane.** No soft wrap, ever: wrapped diff lines corrupt gutter alignment and review accuracy; horizontal pan preserves code integrity. Each pane gets its own scroll origin; sync scrolling is out of scope v1.
- **Wrap tradeoff (explicit):** we accept horizontal panning over wrapping. Rationale: diffs are read against line numbers and columns; wrapping breaks both and makes hunk boundaries ambiguous. Long-line languages suffer, but the file switcher + per-hunk navigation mitigate.
- **Mount economy is already solved:** viewport-proximity mounting with 300 px margin (`REVIEW_MOUNT_MARGIN`, `session-review.tsx:30,205–227`), placeholder boxes (`:584–590`), binary-file guard (`:397,514`), oversized guard (`:411–416`). Reuse verbatim inside the mobile scroller.

### 3.2 File switcher pattern **[NEW-PATTERN]**

Desktop review relies on a wide canvas; on a phone the accordion headers alone are the switcher, plus:
- A horizontally-scrollable **file chip strip** pinned under the review header: one chip per changed file (FileIcon + basename + DiffChanges), tap = expand that file and scroll to it (the focus/scroll machinery exists: `focusedFile` prop and comment-focus scrollTo loop, `session-review.tsx:108,287–338`).
- Expand/collapse-all button already exists (`:270–273,360–370`) — render as icon button on mobile.

### 3.3 What is NOT possible without the file explorer (excluded per 00-handoff §1)

- Browsing arbitrary repo files or directory trees — no tree UI anywhere in chat/review.
- Opening non-changed files for reading.
- Editing files from the review surface.
**What replaces it:** diff review only. Changed files are inspectable through: turn summary accordions, SessionReview, media previews (`media={{ mode: "auto", readFile }}` `session-review.tsx:119,634–639`), and read-tool outputs in the timeline. Line comments remain fully functional (selection → comment controller, `session-review.tsx:435–503`; annotations render through the same FileComponent props `:613–640`) because they attach to diff lines, not to an editor. The desktop "open file" button in review headers (`onViewFile`, `:523–537`) is **hidden on mobile** rather than stubbed.

---

## 4. Permission requests on mobile

Data layer verified: `../../../packages/app/src/context/permission.tsx` — respond shape `{ sessionID, permissionID, response: "once"|"always"|"reject", directory? }` (`:25–30`), V1 listing via `client.permission.list({ directory })` (`:260–263`), `permission.asked` event listener (`:334–349`), deduped respond map (`:228–244`), auto-accept store persisted as `permission.v3` (`:191–212`), helpers from `context/permission-auto-respond.ts` (`acceptKey`, `autoRespondsPermission`, … `:17–23`). Route shapes deferred: **[DEPENDS: 04 §permissions]**.

### 4.1 Approval sheet pattern **[NEW-PATTERN]**

- Incoming `permission.asked` while the app is open → **bottom sheet, non-dismissable** (no backdrop-close, no swipe-down): title = tool/action, subtitle = session, body = request detail (command/diff/path depending on type), actions stacked full-width:
  - **Allow once** → `response: "once"` (primary)
  - **Always allow** → `response: "always"` (secondary, with scope caption "for this session")
  - **Deny** → `response: "reject"` (destructive styling)
- Queue semantics: multiple pending requests are supported by the data layer (`permission.list` returns arrays, `permission.tsx:260–267`); the sheet shows "1 of N" paging dots; answering advances to the next.
- Background arrival: if the sheet can't present (app backgrounded), fall back to Notification via `Platform.notify` (pipeline already exists, gated by settings — 06-pwa-platform §push; notification.tsx:343–429). Full push only when installed-to-home-screen on iOS 16.4+; browser-tab iOS is in-app only.
- Danger styling: Deny uses critical tokens from the 02 zinc palette; "Always allow" for shell-type requests additionally requires a second tap ("Hold to confirm" press-and-hold 600 ms) — mobile fat-finger insurance. Note: 02 found `--surface-disabled` referenced-but-undefined upstream; the zinc theme must define it or disabled sheet actions render wrong.

### 4.2 Auto-respond interplay

- Sheet header carries an **Auto-accept edits** switch bound to `toggleAutoAccept(sessionID, directory)` (`permission.tsx:167–169`). When enabled, incoming asks are answered automatically (`respondPending`, `:316–325`) and the sheet must NOT appear for auto-responded types; the session header instead shows an "auto-accepting" state pill driven by `isAutoAccepting` (`:161–163`).
- Turning auto-accept ON immediately drains already-pending permissions (`enable()` re-lists and responds, `:385–410`) — reflect this in UI copy ("will also answer N waiting requests").
- Composer-adjacent indicator mirrors desktop's affordance so the state is visible where thumbs are.

### 4.3 Question-type prompts

The timeline hides pending `question` parts (`message-part.tsx:801,1715–1717`). Desktop's interactive ask UI is **located**: `../../../packages/app/src/pages/session/composer/session-question-dock.tsx` — a `DockPrompt` shell instance (`dock-prompt.tsx:4–23`, `kind: "question" | "permission"`), multi-select option rows, per-tab draft cache, submitted via a QuestionAnswer mutation; sibling `session-permission-dock.tsx` pairs with it (located by api-data). On mobile both docks collapse into ONE detent-sheet system: DockPrompt's header/content/footer slots are already the right decomposition for the corvu sheet — the ask-sheet renders option rows as full-width buttons and reuses the existing `session.question.pending.*` keys for the count badge.

---

## 5. Composer spec

Composition core: session-ui v2 prompt input — `packages/session-ui/src/v2/components/prompt-input/{index.tsx,store.ts,machine.ts,interaction.ts,types.ts}` (exports `./v2/prompt-input` per 00-handoff §2.8). Part model verified in `types.ts:9–114`: text/file/agent/external-path parts, image attachments, model selection `{providerID, modelID, variant}`, persisted state (prompt+cursor+model+context items), history in `normal|shell` modes, suggestions typed `agent|command|file|reference|resource`. App-side mention machinery: `packages/app/src/components/prompt-input/*` (30 modules, incl. `at-mention-search.ts`, `slash-popover.tsx`, `attachments.ts`, `image-attachments.tsx`, `paste.ts`, `submit.ts`, `build-request-parts.ts`, `external-path-search.ts`, `history.ts`).

### 5.1 Layout **[NEW-PATTERN]**

Docked composer fixed above the home indicator: attachment strip (chips, from `image-attachments.tsx` patterns) → text area (auto-grow 1–6 lines) → controls row: [+ attach] [@ mention] [/ commands] · model chip · agent chip · Send. Send button morphs to **Stop** while the session is busy (interrupt, §7). Shell mode toggle (history already models `normal|shell`, `types.ts:90–95`) lives behind the [/] key.

### 5.2 @mention trigger UX

- Desktop popover (`slash-popover.tsx`, caret-anchored, virtualized rows ROW_HEIGHT=28 `:54`, load-more threshold 12 `:55`) does not fit above a phone keyboard. **[NEW-PATTERN]** Typing `@` opens a **picker sheet docked above the keyboard** (not a modal): search field pre-focused with the query fragment, grouped rows via `buildAtRows`/`groupTitleKey` (`at-rows.ts`), recents pinned first — `toMentionOptions` already de-dupes results against recents (`at-mention-search.ts:16–21`).
- Search behavior is inherited verbatim: 70 ms debounce, page size 200, abort-stale generation guards, incremental `loadMore` (`at-mention-search.ts:6–7,46–128`).
- Option kinds map to picker sections: files/symbols server-ranked via `GET /find/search` — the vendored client lacks it today; regenerating (`bun run generate` in `../../../packages/client`) unlocks fuzzy file+symbol search with highlight positions (04-api-and-data §1, closing handoff §2.6's ⚠️), agents (`AtOption type:"agent"` `slash-popover.tsx:12–42`), external paths with approval-at-mention-time status (`type:"external"`, `external-path-search.ts` per handoff §2.6 ✅).
- Selecting inserts the typed part into the store as file/agent part (v2 part model `types.ts:13–26`); rendering with source-span highlighting already exists in the timeline (`HighlightedText`, `message-part.tsx:1571–1606`).

### 5.3 Attachments / camera

- **[SHARED]** attachment pipeline: `attachments.ts`, paste support (`paste.ts`), image chips (`image-attachments.tsx`).
- **[NEW-PATTERN]** attach button opens an action sheet: Photo Library / Camera / Files. Files route through `Platform.openAttachmentPickerDialog?` (00-handoff §2.4); camera uses `<input type="file" capture="environment">` in the PWA (fallback if platform picker absent). Images compress client-side before upload if >2 MB (policy; implementation detail `[DEPENDS: 03]`).

### 5.4 Slash commands

`SlashCommand { id, trigger, title, description?, keybind?, type: builtin|custom, source?: command|mcp|skill }` (`slash-popover.tsx:44–52`); registration/catalog per handoff §2.5 (`command.tsx`, sources `"palette"|"keybind"|"slash"`). Mobile: typing `/` opens the same picker-sheet surface as @mention, filtered to slash entries; keybind hints hidden (no hardware keyboard assumption), descriptions shown instead.

### 5.5 Model / agent pickers

Bottom sheets (detent: half). Contents from ModelsProvider/agents registry (providers wired in `AppInterface`, handoff §2.3 ✅). Current selection shown as compact chips in the controls row; long lists get the same virtualized row pattern as `slash-popover.tsx:2`.

### 5.6 Send / interrupt states

- idle → Send (accent). disabled when empty & no attachments.
- busy → Stop (destructive-tinted icon) issuing interrupt `[DEPENDS: 04 §session-routes]`.
- retrying → Send disabled with spinner glyph; the turn shows `SessionRetry` card (`session-retry.tsx`).
- offline → Send queues into the client outbox and flushes via `prompt_async` on reconnect (04-api-and-data §5); chip reads "will send when connected". Mobile always submits via async prompt, never sync prompt (04 §6).

### 5.7 Keyboard contract

UX contract only (mechanism owned by 06): a single `KeyboardInset` store `{keyboardHeight, viewportBottom, keyboardOpen}` from rAF-throttled visualViewport events is the ONLY reader of visualViewport (06-pwa-platform, hive-published). Composer anchors to `viewportBottom` while open, safe-area-inset-bottom when closed; picker sheets and suggestion surfaces clamp to the same store and dock to the *visual* viewport top edge, never under the keyboard; focus changes never scroll the timeline (anchor preserved per §1.3).

---

## 6. Context breakdown pane → mobile pattern

Today (verified): `session-context-usage.tsx` renders a ProgressCircle button/indicator (`variants: "button"|"indicator"` `:16–20`) showing usage % computed from the last assistant message tokens vs model `limit.context` (`session-context-metrics.ts:29–64`, usage% `:62`), tooltip with cost/usage/tokens (`:86–95`), opening via `layout.sessionContext.toggle()` (`:57–60`). The pane itself is `session-context-tab.tsx` (1035 lines): breakdown sections colored by category (`system/user/assistant/tool/other`, `:42–48`), token categories input/output/reasoning/cacheRead/cacheWrite (`:50–56`), per-model aggregation + live generation progress (`session-context-model-metrics.ts`, imports `:29–38`), metric cells with live dots (`MetricCell`/`LiveDot` `:92–121`), and session export (`downloadSessionExport` `:21`).

**Decision: detent sheet, not a dedicated route** — aligned with 01's hybrid-nav decision (context-as-sheet, corvu/drawer detent modality); data is client-computed from message tokens ÷ model limit, no endpoint needed (04-api-and-data). It is glanceable metadata tied to the current chat; a route would lose chat scroll state and add back-stack noise.

- **Entry points:** (1) the usage indicator in the session header (`variant:"indicator"`, `session-context-usage.tsx:101–105`); (2) a compact usage chip at the composer's left edge. Both call the same open action.
- **Detents:** half (summary: big % ring, cost, tokens, model limit line) and full (breakdown stack: category bars, per-model table, token/cost categories, export button). Drag handles between detents; swipe-down closes.
- **Adaptation:** sections render single-column; tooltips become static captions (tooltips don't exist on touch); the live dot animation is kept (`LiveDot` `:92–102`) — cheap and informative.
- **Export:** keeps `downloadSessionExport`; on PWA prefer Platform `share`/download fallback (§2.5).

---

## 7. Session controls subset

| Control | Source | Mobile placement |
|---|---|---|
| Interrupt | send-button morph (§5.6); data via session status (`session-turn.tsx:326–331`) | composer Stop |
| Fork | `dialog-fork.tsx:25–104` lists fork points (user msgs, 200-char preview `:50`) | long-press message → "Fork from here…"; renders as sheet listing the same forkable messages; selecting navigates within the existing route set (01: zero new routes) |
| Retry (manual) | user-message actions already model revert/fork (`UserActions`, `message-part.tsx:185–189`; revert button `:1536–1549`) | failed/error turn footer: "Edit & resend" (loads prompt into composer via draft flow) + "Retry" (resend last user msg) |
| Retry (automatic) | `session-retry.tsx` countdown card | unchanged, inline |
| Review changes entry | turn diffs header (`session-turn.tsx:442–452`) | header gains "Review all" link → full review surface (§3) |
| Archive / groups | home-owned IA | session long-press menu exposes Archive/Rename/Move-to-group; management screens owned by ux-architect `[DEPENDS: 01 §home]` |

---

## 8. Long-press action menus per element type **[NEW-PATTERN]**

One menu system (bottom action sheet — per 02's dialog→bottom-sheet / dropdown-menu→action-sheet dispositions; haptic tick on open via `Platform.haptics?` typed sketch from 03, degrade silently where absent):

- **User message:** Copy text · Edit & resend · Fork from here · Revert to here · Select attachments (per-attachment copy/share).
- **Assistant message / text part:** Copy response · Share… · Copy last code block (when body contains fenced code).
- **Tool row:** Copy output (full string) · Maximize (opens detail sheet) · Share… · (errors:) Copy error.
- **Diff file header:** Copy path · Copy patch · Share diff…
- **Session row (home/timeline header):** Pin · Rename · Archive · Move to group · Fork · Delete-confirm. (Menu contents spec'd here; list-screen ownership `[DEPENDS: 01 §home]`.)
- Menu items render only when their action exists (mirrors conditional desktop actions, e.g. revert only when `actions.revert` provided, `message-part.tsx:1536`).

---

## 9. i18n key plan

Rules binding this plan: i18n mandatory, `en.ts` designer-written and byte-for-byte stable, never alter existing keys (00-handoff §2.12; app/session-ui AGENTS.md localization sections). Existing namespaces observed and reused wherever possible: `ui.tool.*`, `ui.sessionTurn.*` (incl. `diffs.changed`, `retry.*`, `status.thinking/gatheringContext/gatheredContext`), `ui.sessionReview.*` (incl. `largeDiff.*`, `diffStyle.*`), `ui.messagePart.*`, `ui.basicTool.*`, `ui.toolErrorCard.*`, `ui.lineComment.submit`, `ui.common.*`, `context.usage.*`.

New keys (proposal — final English copy owned by design):

```
pwa.chat.jumpToLatest            "Jump to latest"
pwa.chat.newParts                plural "{count} new"
pwa.tool.maximize                "Expand full screen"
pwa.tool.closeFull               "Close"
pwa.tool.copyOutput              "Copy output"
pwa.tool.share                   "Share…"
pwa.permission.title             "Permission requested"
pwa.permission.allowOnce         "Allow once"
pwa.permission.allowAlways       "Always allow"
pwa.permission.deny              "Deny"
pwa.permission.queue             "{index} of {total}"
pwa.permission.autoAccept        "Auto-accept edits"
pwa.permission.autoAcceptHint    "Will also answer {count} waiting requests"
pwa.permission.holdToConfirm     "Hold to confirm"
pwa.composer.attach              "Attach"
pwa.composer.mention             "Mention"
pwa.composer.commands            "Commands"
pwa.composer.send                "Send"
pwa.composer.stop                "Stop"
pwa.composer.queuedOffline       "Will send when connected"
pwa.composer.shellMode           "Shell mode"
pwa.mention.searchPlaceholder    "Search files, symbols, agents"
pwa.mention.empty                "No matches"
pwa.mention.recent               "Recent"
pwa.context.sheetTitle           "Context usage"
pwa.context.export               "Export session"
pwa.review.fileSwitcherLabel     "Changed files"
pwa.review.reviewAll             "Review all"
pwa.menu.sessionPin              "Pin"
pwa.menu.sessionRename           "Rename"
pwa.menu.sessionArchive          "Archive"
pwa.menu.sessionGroup            "Move to group"
pwa.menu.sessionDelete           "Delete…"
pwa.state.reconnecting           "Reconnecting…"
```

Dedupe with 06-pwa-platform §8.3: the offline banner reuses 06's `pwa.offline.banner.label` (do NOT add a second key); `pwa.state.reconnecting` remains 05-owned unless 06 already covers it in synthesis.

Plural-sensitive keys (`newParts`, `autoAcceptHint`, permission queue) must go through `language.plural(...)` per app AGENTS.md — no locale branching in components.

## 9b. State matrix (every surface × empty/loading/error/streaming/offline)

| Surface | Empty | Loading | Error | Streaming | Offline |
|---|---|---|---|---|---|
| Timeline | "No messages yet" + composer focused | skeleton turn rows (shimmer, matches `TextShimmer` language) | turn error Card (`session-turn.tsx:528–532`) + retry actions | live pacing + thinking states (§1.2) | cached transcript + banner `pwa.state.offlineBanner` `[DEPENDS: 04 §offline]` |
| Tool rows | n/a (only render when part exists) | shimmer title while pending (`basic-tool.tsx:224`) | ToolErrorCard (`tool-error-card.tsx`) | pending lock (can't open, `:192–196`) | cached outputs render; running tools show stale-pending note |
| Diff review | `props.empty` slot (`session-review.tsx:94,389`) | placeholders 160 px (`:584–590`) | large-diff guard w/ render-anyway (`:591–612`); binary guard (`:397`) | n/a (post-turn) | cached diffs render |
| Permissions sheet | never empty when shown | spinner while `permission.list` resolves (`permission.tsx:260–267`) | respond failure → toast + retry (dedupe map tolerates re-send `:228–244`) | n/a | deny/allow requires network; offline shows "will answer when connected" and keeps sheet queued |
| Composer | placeholder rotation (`placeholder.ts` exists) | — | submit failure toast + draft preserved (`submission-state.ts`, `history.ts`) | send→stop morph | queued-send chip (§5.6) |
| Mention picker | `pwa.mention.empty` | searching spinner (`searching` signal, `at-mention-search.ts:50`) | silent-empty after abort (`:71–75`) — show empty state | n/a | server search unavailable → recents-only mode |
| Context sheet | "No usage yet" (pre-first-token) | ring indeterminate | metrics absent → hide cells gracefully (`getSessionContext` returns undefined, `session-context-metrics.ts:42–47`) | LiveDot pulse (`session-context-tab.tsx:92–102`) | last-known values + timestamp |

---

## 10. Open questions & risks

- **Q1 — SDK type naming vs V1 axiom.** session-ui components type against `@opencode-ai/sdk/v2` (`message-part.tsx:34`, `session-turn.tsx:1–8`, `session-diff.ts:3–4`), yet the app context explicitly branches on protocol kind and calls V1 routes (`permission.tsx:215,260–263`). Treat "sdk/v2 types" as the shared *type vocabulary*, not a mandate to design on V2 endpoints. Endpoint inventory remains api-data's: `[DEPENDS: 04]`. Risk: someone reads the imports as license to use V2 APIs — synthesis doc should restate the axiom.
- **Q2 — Virtualizer + iOS momentum scroll.** `measureElement` during rubber-band can produce jittery row heights. Mitigation proposed (pill/composer outside scroller; anchor re-run on visualViewport change) but needs device validation `[DEPENDS: 06]`.
- **Q3 — Worker availability on first paint.** Shiki/markdown workers (`markdown.worker.ts`) must lazily spawn; low-end Android cold-start budget is 06's to enforce. Fallback: synchronous `completedProjection` path already exists (`markdown-stream.ts:53–54`).
- **Q4 — Sheet stacking depth (ANSWERED for ux-architect, in-thread + §4/§5):** proposed z-order, bottom-of-screen wins: permission approval > question ask-sheet > tool Maximize/detail sheet > mention/slash pickers > model/agent pickers > context breakdown. Rules: only one non-permission sheet may host the keyboard at a time; a higher-priority sheet *suspends* (does not close) the lower one and restores it on dismiss; permission sheets are never suspended. Registry lives in 01's sheet layer; detent tokens from 02.
- **Q5 — Question/ask UI source (CLOSED by api-data):** `../../../packages/app/src/pages/session/composer/session-question-dock.tsx` on the shared `DockPrompt` shell (`dock-prompt.tsx:4–23`), sibling `session-permission-dock.tsx`; events flow server-sdk.tsx:53–57 → event-reducer.ts:433–455. Mobile ask-sheet builds on the same shell decomposition (§4.3) — permission and question sheets share one primitive.
- **Q6 — Haptics/share Platform additions.** `Platform.haptic?` / `Platform.share?` are new optional seams (00-handoff §2.4 head); reuse-strategist owns the interface delta `[DEPENDS: 03]`.
- **R1 — Performance.** Turn-level virtualization + deferred mounts (`basic-tool.tsx:61–97`) should hold 60 fps, but streaming pace constants were tuned on desktop; revisit `TEXT_RENDER_PACE_MS` only with benchmark evidence (app AGENTS.md requires baseline-before-change).
- **R2 — Truncation drift.** Any client-side truncation added for mobile risks diverging from desktop copy semantics; policy §2.4 forbids it — enforcement is review-time.
- **R3 — Split-diff demand.** Some users will insist on split on phones; we ship it (pan-mode) but expect bug reports about horizontal scroll traps inside vertical scroll. Mitigate with clear pane edges `[DEPENDS: 02 §affordances]`.
- **R4 — Excluded-code leakage.** The file explorer is out of scope but statically imported today (`session.tsx:31` per 03), pulling codemirror+shiki into every session chunk; 03's phase-0 lazy boundary is what makes the exclusion real on mobile — synthesis should track it as a gate, not a nicety.

— end of 05 —
