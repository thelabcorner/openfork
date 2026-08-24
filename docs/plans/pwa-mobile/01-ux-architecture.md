# 01 · UX Architecture & Navigation — opencode Mobile PWA

- **Owner:** ux-architect (swarm `pwa-mobile`)
- **Status:** REVISED — peer answers incorporated (03 route/chrome agreement, 04 API semantics, 05 pending, 06 platform answers, 02 token baseline)
- **Phase:** ideation only. No production code changes.
- **Upstream contract:** [00-handoff §1 scope, §3 constraints] is binding. V1 HTTP API only ([00-handoff §2.11]). One source of truth with desktop is a hard goal ([00-handoff §3.3]).
- **Citation convention:** `path:line` = verified by me or inherited from the coordinator's verified ledger ([00-handoff §2], ✅ items). Anything else is labeled **inference** or **external-knowledge** and must be re-verified before implementation.

---

## 0. Tenets (one line each)

1. **The phone is a window onto the agent, not a smaller desktop.** Chrome exists to reach sessions fast and disappear during a run.
2. **One session at a time, fully attended.** Mobile v1 optimizes depth on one running session over breadth across many.
3. **Share the brain, vary the body.** All state/context/logic shared with desktop; only presentation shells fork (mechanism owned by [DEPENDS: 03]).
4. **Nothing important is more than two taps away:** tab → screen, sheet → detail.
5. **Premium = restraint.** Fewer motions, executed perfectly (§9).

---

## 1. Screen inventory (strictly scoped)

Five surfaces total. Every surface maps to an operator-approved scope item ([00-handoff §1]).

| # | Screen | Scope item it serves | Desktop origin (reusable core) | Mobile presentation |
|---|---|---|---|---|
| S1 | **Home — all projects / all sessions** | "Access to all projects / all sessions" | `pages/home.tsx` (`NewHome`) with `home/home-projects*.tsx` + `home/home-sessions*.tsx` (file listing verified via glob of `../../../packages/app/src/pages`) | Tab 1: grouped session list w/ project sections; header holds project switcher + new-session action |
| S2 | **Session chat** | "Full agent chat UX with premium tool UX" | `pages/session.tsx` + `session/timeline/message-timeline.tsx` + composer region + docks (`session/composer/*.tsx`) | Pushed full-screen route; timeline + docked composer; tool cards inline |
| S3 | **Spotlight search** (@mention + command palette fusion) | "@mention spotlight search" | `components/dialog-command-palette-v2.tsx` (:38 `DialogCommandPaletteV2`, :64 `DialogHomeCommandPaletteV2`) over shared model `command-palette.ts` (`createCommandPaletteModel`); fuzzy via `matchesEntry` :37 | Tab 2 (full-screen search) AND anchored overlay when invoked by `@` inside the composer — same model, two presentations |
| S4 | **Context breakdown** | "Context breakdown pane" | `components/session-context-usage.tsx`, `usage-gauge-v2.tsx`, `status-popover(-body).tsx`, `usage/`; shared viz in `../../../packages/session-ui/src/context` (exports `./context`, `./context/*` per its package.json :17–18) | Detent sheet over S2 (not a tab — it is contextual to one session); compact gauge lives in chat header |
| S5 | **Settings subset** | implied by "settings subset" in task brief | `context/settings.tsx` provider; settings UI under `components/settings-v2/` (verified via its css breakpoints) | Pushed full-screen from Tab 3; subset only (appearance, server/connection, language, about) |

### 1.1 Excluded features — disposition lines only (absolute exclusions, [00-handoff §3.4])

- **File explorer** → OUT. Lives at `components/project-explorer-tree.tsx`, `file-tree.tsx`, `file-tree-v2.tsx` (+model), `pierre-tree.test.ts` ([00-handoff §2.10]) plus the v2 viewer family `pages/session/v2/project-explorer-{panel,editor-pane,svg-viewer,pdf-viewer,markdown-viewer,image-viewer,scrollbar}.tsx` and `v2/session-file-{list-v2,browser-tab}.tsx` (glob-verified). Not designed; not linked from any mobile surface.
- **Browser pane** → OUT. Located (this doc's assigned grep): `pages/session/v2/browser-panel-v2.tsx` — header comment :19 "BrowserPanelV2 — the hosted-browser right pane"; state `v2/browser-panel-v2-state.ts` (:12 `Persist.global("browser-panel-v2")`); toggle `v2/browser-panel-v2-sidebar-toggle.tsx` (:8); supporting dir `v2/browser/` (`HostedBrowserWebview.tsx`, `browserHostClient`, `BrowserDeviceToolbar.tsx`, `AgentActionTimeline.tsx`, `AgentBrowserCursor.tsx`, `browser-tab-context-menu.tsx`, …). Not designed; agent browser *tool activity* may still appear as timeline cards in S2 if chat-tool-ux specs it ([DEPENDS: 05]) — that is chat content, not the pane.

Everything else desktop offers is dispositioned feature-by-feature in §7.

---

## 2. Navigation model

### 2.1 Evaluation: tab bar vs stack vs hybrid

| Option | Fit for this scope | Verdict |
|---|---|---|
| **Pure stack** (UINavigationController-style) | Great for drill-in; but scope has three *peer* destinations (sessions / search / settings) that would bury each other 2–3 levels deep; reachability dies. | rejected |
| **Pure tabs** | Peer reachability solved; but session→chat, draft, group views are inherently hierarchical and would cram into one tab with fake nesting. | rejected |
| **Hybrid: 3-tab root + push stack + detent sheets** | Tabs give one-tap access to the three peers; stack handles every drill-in (home → session → diff viewer); sheets handle contextual modality (context breakdown, permission prompts, @mention overlay). Matches iOS conventions (external-knowledge: UIKit/SwiftUI combined patterns). | **CHOSEN** |

**Tab set (exactly 3):**

1. **Sessions** (S1 home)
2. **Search** (S3 spotlight, full-screen presentation)
3. **Settings** (S5)

Context breakdown (S4) is deliberately NOT a tab: it has no meaning without a session beneath it. It is a sheet over S2 (§2.5).

### 2.2 How the desktop three-pane collapses

Desktop new layout = left sidebar (projects/servers/sessions) + center timeline/composer + right side panel with tabs (context/files/etc.; `pages/session/session-side-panel.tsx`, which also hosts the excluded file-browser tab — `fileBrowserTabPanelID` :34).

Collapse order (wide → narrow):

1. **Left sidebar → becomes Home tab (S1).** Project tree flattens to sections; `layout/sidebar-*.tsx` data flows are reused, the tree component is not.
2. **Center → becomes the pushed chat route (S2), unchanged in role.**
3. **Right side panel → dissolves:** context tab → S4 sheet; files tab → excluded (explorer OUT); terminal tab → Later (§7); usage/models panels fold into S4/settings respectively.
4. **Titlebar/tabs system → replaced** by mobile header + status bar safe areas; desktop's window-tab concept (`TabsProvider`) does not carry to mobile navigation (mobile uses history stack instead) — but the persisted-tabs storage seam is reused for restore (§2.6).

### 2.3 Project switcher placement

- **Primary:** header control on Home (S1) — a project pill opening a bottom sheet listing all projects (reuses `home/home-projects-controller.tsx` data; presentation is mobile-new).
- **Secondary:** inside Spotlight (S3) as a `project:` filter entry and as results grouped by project — the palette model already fuses heterogeneous entries (`uniqueCommandPaletteEntries`, [00-handoff §2.5]).
- Switching project while inside a session pushes you to that project's filtered home view rather than yanking the timeline out from under you (**inference**: gentler than desktop's instant swap; avoids mid-stream disorientation).
- Server-level switching (multi-server incl. WSL) stays in Settings → Connection; the existing `ConnectionError` other-servers list (`app.tsx:542–562`) is directly reusable there.

### 2.4 Back semantics

Assumption locked with reuse-strategist: **real browser history**, not MemoryRouter — URLs carry state for relaunch and universal links. Gesture reality per [DEPENDS: 06 §edge-swipe]: in iOS *standalone* PWAs there is NO system edge-back gesture (no browser chrome); in the in-Safari tab, edge swipes ARE back/forward navigation. Therefore:

1. **Header back buttons are the primary back mechanism**, not an accessibility fallback — every pushed screen renders one (chat, settings, diff viewer, group views). History correctness still matters (deep links, relaunch) even though the gesture is absent in standalone.
2. Optional custom edge-swipe back, **gated to standalone mode** (detection: `matchMedia('(display-mode: standalone)')` / `navigator.standalone`; the media query is proven working in-repo by the override at `index.css:20–25`). Never enabled in-Safari, where it would fight system navigation [DEPENDS: 06].
3. Sheets/detents are **not** history entries; they close on swipe-down or scrim tap only. Sheet gestures stay vertical-only (corvu drawer default) — which conflicts with nothing in either context [DEPENDS: 06].
4. Redirect chains are pruned: routes that immediately `Navigate` (e.g. `DraftRoute` fallback `app.tsx:211`, `NewLayoutLegacySessionRedirect` `app.tsx:659`) use replace-semantics so back never lands in a redirect loop (**inference** on current behavior; route-history audit at implementation).
5. Tab switches DO push history (so back returns to the previous tab) but coalesce rapid tab flips (**inference**; prevents history spam).

### 2.5 Sheets & detents

`@corvu/drawer` is already an app dependency ([00-handoff §2.3]) — it is the sheet primitive; snap-point config is ours to spec.

| Sheet | Detents | Content |
|---|---|---|
| Context breakdown (S4) | ~50% and ~90% (**proposal**) | usage gauge + breakdown list; large detent for per-part detail |
| @mention overlay (from composer `@`) | anchored popover, grows to ~70% cap | fused palette rows (files/sessions/commands/models) |
| Permission prompt | bottom card, single detent | allow/deny per tool call — interaction spec owned by [DEPENDS: 05] |
| Question prompt | bottom card | same |
| Diff review | full-screen sheet | `@pierre/diffs` viewer reuse ([00-handoff §2.8]) |
| Project switcher | ~50% | project list |
| New-session model/agent pickers | ~60% (**proposal**) | reuses models data (`context/models.tsx`) |

iOS rubber-banding at top of sheet, grabber handle, scrim fade — standard corvu drawer capabilities (**inference** on exact props; confirm against corvu docs at implementation).

**Sheet stacking registry** (adopted from [DEPENDS: 05 §2.1]; independently converged). Z-order, bottom-of-screen wins, rendered top-down:

1. **Permission approval** — never suspended, never swipe-dismissable
2. Question ask-sheet
3. Tool Maximize/detail sheet
4. Mention/slash pickers
5. Model/agent pickers
6. Context breakdown

Rules: only ONE non-permission sheet may host the keyboard at a time; a higher-priority sheet SUSPENDS (never closes) the one beneath and restores it on dismiss; permission sheets interrupt anything. The registry lives in the mobile layout's sheet layer ([DEPENDS: 03]); detent/motion tokens from [DEPENDS: 02].

### 2.6 State restoration across PWA suspends

Reality: iOS suspends then may evict the PWA's web view at any time (**inference** — well-documented platform behavior; verify specifics in [DEPENDS: 06]). Therefore restoration = "cold relaunch must land where I left off."

What restores, and from where:

| State | Mechanism | Seam already in repo? |
|---|---|---|
| Location (which screen/session) | The URL itself — real history + launch URL carries state (agreed with reuse-strategist; desktop precedent persists last-active-url at `desktop/src/renderer/index.tsx:95–106` per their message) | ✅ pattern exists |
| Cold launch with no URL | stored fallback: last route snapshot | persistence seam exists: `Persist.global` used by command catalog (`context/command.tsx:278`) and browser panel (`v2/browser-panel-v2-state.ts:12`); `platform.storage?(name)` optional in PlatformBase ([00-handoff §2.4]) |
| Open drafts | `TabsProvider` persisted draft tabs (`DraftRoute` reads them, `app.tsx:202–224`) + `draftStore?` on Platform ([00-handoff §2.4]) | ✅ |
| Composer text | draft store per session | ✅ (same seam) |
| Scroll positions, expanded docks, last detent | session-scoped Persist keys (new, cheap) | seam exists, keys new |
| Data freshness | solid-query cache + SSE resync; note `QueryClient` defaults disable refetchOnReconnect/Mount/Focus (`app.tsx:301–308`) — so explicit invalidation is REQUIRED. Realtime is SSE-only (no general WS), frames carry no resume id ⇒ reconnect = refetch on `server.connected` + messages keyset cursor; suspend on background, refetch on foreground [DEPENDS: 04 §2] | ⚠️ gap flagged → design landed in 04 |

---

## 3. Routing map

Verified today in `../../../packages/app/src/app.tsx` (`Routes`, :634–667). Two layouts gate on `settings.general.newLayoutDesigns()` (:64–65 imports, :607 keyed Show, :644/:657 Shows).

### 3.1 Existing route table (as-is)

| Route | Component | Layout regime | Cite |
|---|---|---|---|
| `/` | `LegacyHome` | legacy only | app.tsx:647 |
| `/server/:serverKey/session/:id` | `LegacyTargetSessionRoute` | legacy only | app.tsx:648 |
| `/:dir` → `/session/:id?` | `DirectoryLayout` → `SessionRoute` | both (registered outside the legacy Show) | app.tsx:652–655 |
| `/` | `NewHome` | new layout | app.tsx:658 |
| `/:dir/session/:id` | `NewLayoutLegacySessionRedirect` | new layout | app.tsx:659 |
| `/server/:serverKey/session/:id` | `TargetSessionRoute` | new layout | app.tsx:660 |
| `/server/:serverKey/group/:groupId(/session/:sessionId)` | `GroupTabRoute` | new layout | app.tsx:661–662 |
| `/new-session` | `DraftRoute` (requires `tabs.ready()` + `draftId`, else Navigate `/`) | both | app.tsx:664, :202–224 |

### 3.2 Mobile mapping — REUSE, do not fork

Per agreement with reuse-strategist (msg_ab19c55f64024b0ab035f5b9126117f7): mobile deep links target the **existing shapes**; the third shell renders a sibling layout variant (working name `pages/layout-mobile.tsx`, selected by platform+viewport — mechanism theirs [DEPENDS: 03 §platform-gate]).

| Mobile screen | Route | Status |
|---|---|---|
| S1 Home | `/` (new-layout `NewHome`) | **reuse** — mobile chrome wraps it; content may need responsive variant (flag F1 below) |
| S2 Chat | `/server/:serverKey/session/:id` | **reuse** |
| Group views | `/server/:serverKey/group/:groupId(+/session/:sessionId)` | **reuse** — presented as filtered list / jumped-to session |
| Draft/new session | `/new-session?draftId=…` | **reuse** |
| Legacy compat | `/:dir/session/:id?` and legacy `/server/...` variant | untouched; mobile never emits these links; redirects already exist (:86–96, :659) |
| S3 Spotlight | none today (dialog-based) | **no new route** — overlay/sheet presentation of `DialogCommandPaletteV2`'s model; Search tab mounts the same model full-screen |
| S4 Context sheet | none today (side-panel tab) | **no new route** — sheet over S2 |
| S5 Settings | no route found in `app.tsx:634–667` (**verified absence**) | **CLOSED by [DEPENDS: 03]:** settings-as-sheet/screen everywhere — NO `/settings` route on any shell; universal links don't need it |

**Net: zero new paths.** Mobile adds a layout variant + presentation wrappers, not a route table. This keeps universal links, desktop URLs, and mobile URLs identical forever.

### 3.3 Route-level forks to flag (for reuse-strategist → 03 extraction specs)

- **F1 — Home content:** `NewHome` composes projects grid + sessions list tuned for wide viewports (`home/home-projects-view.tsx`, `home/home-sessions-view.tsx`). Controllers (`*-controller.tsx`) look reusable; the *views* likely need a mobile presentation. Extraction candidate: list-row components shared, page skeleton variant-owned.
- **F2 — Session page internals:** `pages/session.tsx` arranges three panes; the timeline (`timeline/message-timeline.tsx`), composer region and docks (`composer/*.tsx`) should be extracted-shareable; pane arrangement stays desktop-only. If SessionPage cannot render "timeline+composer only," 03 should spec the split.
- **F3 — Spotlight presentation:** `DialogCommandPaletteV2` renders through ui Dialog + ScrollView (:191–207) with a 640px row-stacking tweak already present (`dialog-command-palette-v2.css:210–220`). Full-screen mobile mode needs either a prop/presentation variant of the dialog or a second renderer over the same `command-palette.ts` model. Prefer the latter if Dialog constraints bite.

---

## 4. Gesture & interaction grammar

The complete vocabulary — nothing outside this list ships in v1:

| Gesture | Where | Behavior |
|---|---|---|
| **Pull-to-refresh** | Home (S1), group lists | Refreshes sessions/projects; overrides the no-auto-refetch defaults (`app.tsx:301–308`) via explicit invalidation; haptic-like tick at threshold (**inference**: visual substitute, see §9.2) |
| **Long-press** | Session rows, chat messages, tool cards | Context menu (ui context-menu primitive exists, [00-handoff §2.9]): open, rename, fork, share, archive, delete, copy link — all session-action endpoints verified by [DEPENDS: 04 §1.1] (PATCH title/archived, DELETE, POST fork, POST/DELETE share). Pin/unpin has NO verified endpoint → not in v1 |
| **Swipe-leading/trailing on session rows** | Home list | Trailing: reveal quick actions (default: archive / close — endpoints verified, [DEPENDS: 04 §1.1]); leading: reserved, OFF in v1 to reduce grammar size (**inference**: fewer destructive-by-accident paths) |
| **Edge-swipe back** | Pushed screens, STANDALONE ONLY | Custom gesture — no system edge-back exists in standalone PWAs [DEPENDS: 06]; disabled in-Safari where edges are system back/forward. Header back button remains primary (§2.4) |
| **Swipe-down** | Sheets | Dismiss at first detent; drag-to-detent otherwise |
| **Tap-up-expand** | Tool cards, collapsed parts | Collapsed row tap anywhere = toggle inline expand (pending/running rows locked); Maximize chevron inside an OPEN body promotes to full-height sheet via mobile-only wrapper (zero session-ui changes); long-press opens action menu WITHOUT changing expand state — spec'd by [DEPENDS: 05 §2.1]; trigger rows pay the full 44px hit tier |
| **Keyboard avoidance** | Composer, all sheets w/ inputs | Composer anchors to viewportBottom while keyboard open, safe-area-inset-bottom when closed, via 06's single KeyboardInset store (visualViewport rAF-throttled; no other component reads visualViewport; dvh does NOT track iOS keyboard) [DEPENDS: 06 §keyboard]. IA requirement: composer never overlays content; sheets clamp to the inset; docks (permission/question/todo) stack above composer in fixed z-order (**inference** for ordering: permission > question > followup > todo) |
| **Two-finger / pinch** | None in v1 | Cut — no viewport zoom on chrome; diffs get their own font-size stepper instead (**inference**) |

Grammar principles: one gesture = one meaning; nothing destructive on a single gesture (destructive actions require long-press menu or confirmation); every gesture has a visible button equivalent (accessibility + discoverability).

---

## 5. State matrix (complete, per screen)

Global states first — they wrap every screen:

- **Connecting/boot:** `ConnectionGate` splash already exists (`app.tsx:449–518`, splash overlay :512–515) — reuse as-is.
- **Server unreachable:** `ConnectionError` with retry + other-server picker (`app.tsx:520–565`) — reuse verbatim inside mobile chrome.
- **Offline (was connected):** persistent slim banner under the header; read-only cached content; composer submits enter a CLIENT-SIDE OUTBOX (FIFO flush into `POST /session/:id/prompt_async` on reconnect, per-item retry/cancel — [DEPENDS: 04 §5]; sync prompt unusable on mobile, handlers/session.ts:409–423). HARD EXCEPTION: permissions are live-only, never cached — approve/deny gates behind a "reconnecting" state when offline [DEPENDS: 04 §5].

Then per screen (L=loading, E=empty, Er=error, St=streaming, Off=offline, Sta=stale):

| Screen | L | E | Er | St | Off | Sta |
|---|---|---|---|---|---|---|
| **S1 Home** | Skeleton rows (shimmer primitives exist in ui, [00-handoff §2.9]); never blank flash | First-run: "No projects yet" + connect guidance; per-project: "No sessions" + New Session CTA | Row-level error chips; section retry; global fallback = ConnectionError | Live badges on actively-running session rows via ONE batched `GET /session/status` call — never per-row polling ([DEPENDS: 04 §1.2]; drives tab badge too) | Cached list + offline banner | Age indicators on rows ("2h"); pull-to-refresh clears |
| **S2 Chat** | Timeline skeleton + composer enabled-immediately (**inference**: composer usable while history loads) | Brand-new session: composer + starter hints | `SessionRouteErrorBoundary` exists (`app.tsx:71,108`) — reuse; per-part error cards exist (`tool-error-card.tsx`, [00-handoff §2.8]) | Streaming markdown via worker infra (`markdown-stream.ts` + workers, [00-handoff §2.8]); tool-run spinners; typing-safe scroll anchoring | Banner; submits enter outbox with per-item retry/cancel chips ([DEPENDS: 04 §5]); queued-but-unflushed items render in a distinct pending state at timeline bottom and reconcile via SSE `message.created` (prompt_async's 204 carries NO message id — match sessionID + optimistic text hash fallback [DEPENDS: 04 §5]); permission cards show reconnecting gate | Reconnect = refetch on `server.connected` + keyset cursor backfill (`before`+X-Next-Cursor) [DEPENDS: 04 §2]; truncation notice only if backfill fails |
| **S3 Spotlight** | Instant shell, async result shimmer | Zero-query: recents + commands (palette model already provides entry factories, [00-handoff §2.5]); no-hits: "No results" + query-echo | Source-scoped error rows (files source down ≠ whole palette dead) | n/a | Cached indexes only; server-backed file/symbol search degrades to legacy `/find/file` fallback (current app behavior, `context/file.tsx:318–330` per [DEPENDS: 04 §1]) | Recents marked with age |
| **S4 Context sheet** | Gauge placeholder pulse | "No context used yet" (fresh session) | Sheet shows error strip, chat continues unaffected | Gauge ticks live during streaming turns | Last-known values + timestamp | Timestamp chip on data |
| **S5 Settings** | Section skeletons | n/a (static structure) | Per-section retry | n/a | Read-only cached prefs; writes queue or fail visibly (**inference** pending [DEPENDS: 04]) | n/a |

Cross-cutting rules: every loading state reserves layout height (no CLS); every empty state names the next action; errors never dead-end (always one recovery affordance); streaming states are calm (one indicator per region, not five).

---

## 6. Screen-by-screen IA notes (concise)

- **S1 Home:** sticky header (project pill · title · new-session +). Sections: Running now (live sessions), Recent, by project. Rows: title, project tag, relative time, status dot, streaming glyph — NO message-preview snippets in v1 (session list has no embedded preview; snippets would cost one fetch per row — N+1 [DEPENDS: 04 §1.2]). Search field in header opens S3 (does not duplicate it).
- **S2 Chat:** header (back · title/model chip · context-gauge mini · overflow). Body: timeline only. Footer: composer + dock stack. Overflow menu: session actions (fork · rename · share · archive · delete — endpoints verified [DEPENDS: 04 §1.1]), open context sheet, open diff review.
- **S3 Spotlight:** full-screen take-over from tab; input pinned top (safe-area aware); segmented scopes (All · Sessions · Files · Commands · Models) mapping to palette entry factories; `@` prefix inside composer jumps to the anchored variant instead. File/symbol search upgrades to `GET /find/search` once the vendored client is regenerated ([DEPENDS: 04 §6]).
- **S4 Context sheet:** gauge header + breakdown rows (per part/category); tap row → detail at large detent; data is CLIENT-computed (message tokens ÷ model context limit — no endpoint needed, `session-context-metrics.ts:29–67` per [DEPENDS: 04]).
- **S5 Settings:** grouped list (Appearance · Connection & servers · Language · Notifications* · About). *Notifications contingent on [DEPENDS: 06 §push].

### 6.1 First-run & pairing UX (my half of the auth question)

api-data verified zero new endpoints are needed ([DEPENDS: 04 §4]) — pairing is pure presentation:

1. Desktop terminal prints an mDNS URL (`--mdns` → `opencode.local`) — the QR encodes `https://<host>:<port>/?auth_token=base64(user:pass)`.
2. Phone camera scan → opens the URL in Safari; `entry.tsx` consumes and strips the token from the address bar (already implemented, per [DEPENDS: 04 §4]).
3. Same-origin serving means the app just works — no server-picker friction on first run ([DEPENDS: 04 §3]).
4. After first successful load, offer the iOS Add-to-Home-Screen install hint (**inference**: A2HS must be user-initiated on iOS; timing proposal = dismissible banner after second visit).
5. Security caveats from 04 (plaintext Basic over LAN, token-in-URL log leakage, no rate limiting) surface as a one-time pairing-sheet footnote + About screen entry — honest, not alarming.

---

## 7. Feature scope matrix

Dispositions: **reuse** (ship as-is/shared) · **adapt** (shared logic, mobile presentation) · **later** (v2 candidate) · **cut** (not on mobile roadmap) · **OUT** (operator exclusion).

| Desktop feature (source) | Disposition | Rationale (one line) |
|---|---|---|
| Cross-project home (`pages/home.tsx`, `home/*`) | adapt | IS scope item 1; controllers shared, views responsive-split (F1) |
| Session timeline (`session/timeline/message-timeline.tsx`) | reuse | Core of scope item 4; session-ui kit is presentation-agnostic ([00-handoff §2.8]) |
| Composer + docks (`session/composer/*`: todo, revert, question, permission, followup) | adapt | Permission/question/todo/followup ship v1 as stacked bottom cards; revert dock **later** |
| @mention machinery (`prompt-input/at-mention-search.ts` :14, `build-request-parts.ts` :42,:163–193, `submit.ts` :185–194) | reuse | Scope item 3's engine; unchanged |
| External-path mentions w/ approval-at-mention (`prompt-input/external-path-search.ts` :117) | adapt | Approval flow becomes a sheet confirmation [DEPENDS: 05] |
| Command palette (`dialog-command-palette-v2.tsx`, `context/command.tsx`) | adapt | Same model, two presentations (tab + anchored); keybind-source commands hidden on touch (`sources "palette"|"keybind"|"slash"` :101) |
| Context breakdown (`session-context-usage.tsx`, `usage-gauge-v2.tsx`, `status-popover*.tsx`, session-ui `./context`) | adapt | Scope item; side-panel tab → detent sheet |
| Usage/fork panels (`session/usage-panel.tsx`, ForkUsageProvider) | adapt | Folds into S4 sheet + settings |
| Models panel (`session/models-panel.tsx`, `context/models.tsx`) | adapt | Becomes new-session/composer picker sheet |
| Permissions (`context/permission.tsx` + auto-respond) | adapt | Bottom-card UX; auto-respond rules surfaced in settings **later** [DEPENDS: 05] |
| Session groups (`SessionGroupsProvider`, `group-tab.tsx`, httpapi `groups/`) | adapt | Rendered as grouped sections/filter views on Home; group routes reused (§3.2) |
| Multi-server + WSL (`WslServersProvider`, server routes) | adapt | Server switcher in Settings; ConnectionError picker reused (`app.tsx:542–562`) |
| Terminal panels (`terminal-panel.tsx`, `-v2.tsx`) | later | PTY on touch is its own project; not in operator scope |
| Diff/review (`session-diff.ts`, `session-review.tsx`, `line-comment.tsx`, `@pierre/diffs`) | adapt | Full-screen sheet viewer v1; desktop's review "open file" button HIDDEN on mobile, not stubbed (no explorer) [DEPENDS: 05 §3]; line comments **later** |
| Markdown stream workers (`markdown-stream.ts` + worker infra) | reuse | Exactly as-is; perf-critical on mobile |
| File preview in chat (`message-file.ts(x)`, `file-media.tsx`) | adapt | Tap → lightbox/full-screen viewer; distinct from excluded explorer |
| Drafts (`draftStore`, PromptProvider, `/new-session`) | reuse | Storage seam + route already exist (§2.6) |
| Notifications (`NotificationProvider`) | adapt | In-app toasts (solid-sonner in ui deps, [00-handoff §2.9]); OS push pending [DEPENDS: 06 §push] |
| Themes/appearance (`ThemeProvider`, themes/*.json) | reuse | Settings subset item; zero work |
| i18n (~70 locales, `../../../packages/app/src/i18n`) | reuse | Mandatory per repo AGENTS.md; new keys only (§8) |
| Window/tab system (`TabsProvider`, titlebar tabs, `titlebar-tab-popover.css`) | cut | Replaced by nav stack; persisted-tab storage seam reused for restore |
| Sidebar family (`layout/sidebar-*.tsx`) | cut | Superseded by Home tab + project switcher sheet |
| Drag-drop attachments (`drag-overlay.tsx`, dropzone `prompt-input.tsx` :1655) | adapt | Touch: attachment picker button (`platform.openAttachmentPickerDialog?` slot exists, [00-handoff §2.4]); paste-image kept |
| Comments (`CommentsProvider`, line-comment) | later | Depends on review UX maturity; v1 read-only diffs |
| Storybook stories (every ui/session-ui component) | reuse | Mobile variants developed storybook-first |
| **File explorer** (`project-explorer-tree.tsx`, `file-tree*.tsx`, `v2/project-explorer-*`, `v2/session-file-*`) | **OUT** | Operator exclusion [00-handoff §1] |
| **Browser pane** (`v2/browser-panel-v2.tsx` + `v2/browser/*`) | **OUT** | Operator exclusion [00-handoff §1]; located in §1.1 |

---

## 8. i18n key plan (new chrome only)

Rules inherited (repo AGENTS.md, binding): every user-visible string keyed; `en.ts` designer-written byte-stable; never alter existing English keys/values; use `language.t(...)` / `language.plural(...)`; complete phrases, no concatenation. Existing palette/settings strings are REUSED wherever they already exist — audit before adding (e.g. `command.browser.toggle` exists for the excluded pane; don't create siblings).

Proposed namespace `pwa.*` (new file/module alongside existing app i18n):

```
pwa.tab.sessions            # "Sessions"
pwa.tab.search              # "Search"
pwa.tab.settings            # "Settings"
pwa.home.title              # "Sessions"  (header; may equal tab key — separate key anyway)
pwa.home.action.newSession  # "New session"
pwa.home.section.running    # "Running now"
pwa.home.section.recent     # "Recent"
pwa.home.empty.projects.title / pwa.home.empty.projects.body
pwa.home.empty.sessions.title / pwa.home.empty.sessions.body
pwa.chat.action.context     # "Context"
pwa.chat.action.review      # "Review changes"
pwa.chat.menu.title         # session overflow a11y label
pwa.spotlight.title         # "Search"
pwa.spotlight.placeholder   # "Search sessions, files, commands…"
pwa.spotlight.scope.all / .sessions / .files / .commands / .models
pwa.spotlight.empty.noResults  # plural-aware via language.plural base
pwa.sheet.context.title     # "Context usage"
pwa.row.swipe.close         # row quick-action
pwa.state.offline.banner    # "Offline — showing cached data"
pwa.state.reconnecting      # "Reconnecting…"
pwa.settings.connection     # section header (values mostly reuse existing settings keys)
pwa.project.switcher.title  # "Projects"
```

Count-sensitive strings (result counts, session counts) go through `language.plural(baseKey, count, params)` per AGENTS.md — no `.one/.other` branching in components.

Install/update/push/offline-storage chrome keys (`pwa.update.*`, `pwa.install.coach.*`, `pwa.push.*`, `pwa.offline.banner.label`, `pwa.storage.reset.notice`) are specified in [DEPENDS: 06 §8.3] — listed there, not duplicated here; this doc owns only the tab/home/chat/spotlight/sheet/settings namespaces above.

---

## 9. Premium UX principles (what "premium" concretely means here)

### 9.1 Motion restraint
- Motion budget per interaction: ONE animated property change (transform/opacity only), 150–250ms, spring-ish easing. No chained/staggered animations in v1 chrome.
- `prefers-reduced-motion` respected globally — the guard already exists (`index.css:163`); mobile chrome inherits it, and reduced-motion also disables pull-to-refresh elastic overscroll (**inference**/proposal).
- Token values (curves/durations) are design-system property [DEPENDS: 02 §motion]; this doc fixes only the budget.

### 9.2 Feedback within web limits
- iOS Safari does not support `navigator.vibrate` — CONFIRMED absent through iOS 17.x [DEPENDS: 06 §haptics]; Android Chrome exposes it, so any future capability must be feature-detected, never assumed. Therefore "haptic feel" is synthesized: press-scale micro-states (≤2% scale), threshold ticks in gestures, and instant visual acknowledgment (<1 frame intent registration).
- A future `haptics?` capability is now SPECCED by [DEPENDS: 03] as an optional, no-op-safe Platform extension (typed sketch incl. share/installPrompt siblings); iOS ships without it per the confirmed absence above — feature-detect or stay silent.

### 9.3 Density with breathing room
- Base rhythm: New York dense spacing ([00-handoff §3.5]) for chrome (rows, tab bar, menus); timeline gets relaxed line-height — dense where you scan, airy where you read.
- Minimum touch target 44×44pt everywhere including dense rows (external-knowledge: Apple HIG; CONFIRMED as the touch density tier with no slop exceptions in [DEPENDS: 02 §3.3]).
- One accent per screen-state: streaming glow OR selection highlight OR focus ring — never two at once.

### 9.4 No-jank budgets
- Scroll = 60fps under streaming load: virtualized lists (`@tanstack/solid-virtual` already an app dep, [00-handoff §2.3]), offscreen stream buffering, no synchronous markdown parse on main thread (workers already exist, [00-handoff §2.8]).
- Interaction latency budget: tap → visual feedback ≤ 100ms; sheet open ≤ 300ms to interactive.
- Numeric budgets fixed by [DEPENDS: 06 §6]: initial JS ≤300KB gzip (home route), ≤150KB per lazy route chunk, TTI <3s cold / <1.5s warm-SW, LCP <2.5s LAN, INP <200ms p75, SW precache ≤2.5MB total. IA honors them by keeping chrome node-count small (tab bar + header ≈ constant overhead per screen). Shell-asset flag from 06: Inter currently ships as a variable TTF (`index.css:13–18`) — woff2 conversion is the cheapest first-paint win.

### 9.5 Content-first chrome
- Chrome fades on scroll-down in chat, returns on scroll-up or touch (**inference**/proposal; standard iOS pattern).
- Nothing pulses/bounces to beg attention except genuinely new agent output; attention is spent only where the agent is working.

---

## 10. Open questions & risks

| # | Item | Owner / status |
|---|---|---|
| Q1 | ~~Can AppInterface host mobile chrome without forking pages?~~ **ANSWERED by [DEPENDS: 03]:** Option A′ third shell inside packages/app mounts the SAME AppInterface with browser history; pages/state-layer/palette/@mention/session-ui AS-IS; F1–F3 accepted as targeted in-package extractions (also found: ProjectExplorerPanel static import bloats session chunk on ALL surfaces — lazy-boundary planned phase 0). | closed |
| Q5 | ~~Settings has NO route~~ **ANSWERED by [DEPENDS: 03]:** settings-as-sheet/screen everywhere; no `/settings` route on any shell. | closed |
| Q2 | ~~Only width breakpoint today is 640px; no phone/tablet scale exists~~ **ANSWERED by [DEPENDS: 02 §4]:** do NOT build width breakpoints — key mobile chrome on `(pointer: coarse)` + `display-mode: standalone` (+ width tiebreaker); container queries for embed-width-sensitive parts (`getting-started` precedent, `index.css:28–31`); md 48rem reserved as tablet two-pane restore point. Existing ui scale sm 40rem…2xl 96rem unchanged. | closed |
| Q3 | `display-mode: standalone` dvh fix already exists (`index.css:20–25`) — confirms standalone was anticipated; remaining keyboard/safe-area strategy is 06's. | closed — keyboard contract landed ([DEPENDS: 06]: single KeyboardInset store) |
| Q4 | ~~Offline submit semantics undefined~~ **ANSWERED by [DEPENDS: 04 §5]:** client-side outbox flushing FIFO into `prompt_async` on reconnect (sync prompt unusable on mobile); permissions live-only with reconnecting gate. Incorporated in §5 global offline state. | closed |
| Q5 | Settings currently has NO route (verified absence in `app.tsx:634–667`); if universal links need `/settings`, a public route must be added for ALL shells, not just mobile. | decision deferred; flag to 03 |
| Q6 | ~~Edge-swipe back vs sheet interplay~~ **ANSWERED by [DEPENDS: 06]:** no system edge-back in standalone PWAs at all; sheets stay vertical-only (conflict-free in both contexts); custom edge-swipe gated to standalone proposed (§2.4); on 06's device checklist (§7.4). | closed |
| Q7 | ~~Haptics availability~~ **ANSWERED by [DEPENDS: 06 §haptics]:** `navigator.vibrate` absent on iOS through 17.x; Android Chrome exposes it ⇒ any Platform.haptics must be optional + capability-detected (03's call). | closed |
| Q8 | ~~Row quick-action endpoints unverified~~ **ANSWERED by [DEPENDS: 04 §1.1]:** rename/archive = PATCH session, delete = DELETE session, fork = POST fork, share = POST/DELETE share; busy badges via batched `GET /session/status`. Pin has NO endpoint → cut from v1. | closed |
| R1 | Risk: "full agent chat" scope creep — docks alone are five features. Mitigation: v1 ships permission/question/todo/followup; revert/comments deferred (§7). | tracked here |
| R2 | Risk: redirect-heavy routes (`app.tsx:211`, :659, legacy :86–96) creating back-stack loops once real history is trusted. Mitigation: route-history audit task at implementation; replace-semantics review. | tracked here |
| R3 | Risk: QueryClient's disabled auto-refetches (`app.tsx:301–308`) silently serving stale data after reconnect on mobile. Mitigation now CONCRETE: refetch on `server.connected` + keyset cursor backfill [DEPENDS: 04 §2]. | mitigated by 04 design |
| R4 | Risk: push/notification UX differs by install state (full push ONLY installed-to-homescreen iOS 16.4+; browser-tab = in-app only [DEPENDS: 06 §push]) — Settings must present capability honestly, and tab badges depend on install state. | tracked here; spec detail in 06 |

---

## 11. Handoff notes to peers

- **chat-tool-ux (05):** CONVERGED — their dock/sheet z-order + suspend-don't-close rules adopted into my §2.5 registry; tap-up-expand semantics cited in §4; review open-file hiding reflected in §7. Context-as-sheet decision independently matched. Nothing further needed from me.
- **design-system (02):** aligned — your pointer+standalone breakpoint answer is incorporated (Q2), touch-tier confirmation in §9.3, motion tokens referenced §9.1. Remaining from me: nothing blocking.
- **reuse-strategist (03):** LANDED (Option A′ third shell). F1–F3 accepted into their in-package extraction queue; Q1/Q5/R2 closed against their doc; PlatformName "pwa" + browser history + zero-new-routes all match my IA. Nothing further needed from me.
- **api-data (04):** both my blockers answered and incorporated (§4 long-press/swipe rows, §5 offline/outbox, §6.1 pairing). One UX ask back: keep the outbox flush order stable across reconnects so queued sends read chronologically in the timeline.
- **pwa-platform (06):** all three of my questions answered and incorporated (§2.4, §9.2, §9.4, R4). Your §8.3 key namespaces are cross-referenced from my §8 — no duplication.

— end of 01 —
