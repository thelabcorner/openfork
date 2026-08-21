# 03 — Source of Truth: Reuse Architecture for the Mobile PWA

- **Owner:** reuse-strategist (swarm `pwa-mobile`)
- **Status:** DELIVERED (ideation; zero production code changed)
- **Upstream:** `00-handoff.md` §2 (verified repo map), §3 (axioms). Peer inputs: `01-ux-architecture.md` (nav model, fork flags F1–F3, Q5).
- **Citation key:** `path:line` = read by this doc's author. "handoff §x" = coordinator-verified in `00-handoff.md`. "01 §x" = verified by ux-architect. "inference" = reasoning, unverified.

---

## 0. TL;DR

**Decision: Option A′ — a third shell inside `packages/app`.** Add `"pwa"` to `PlatformName`, add a mobile entry (`src/entry-pwa.tsx` + `pwa.html`) as a sibling of the existing web entry, mount the **same** `AppInterface` with browser-history routing and a PWA `Platform` implementation, and render mobile chrome as a **third layout variant** beside the existing legacy/new dual-layout system. Pages, route components, state layer, palette/mention machinery, and the session-ui kit are consumed **as-is**; only shell chrome is mobile-specific. No new package, no second app.

The decisive fact: **the seam already exists and a second consumer of it already exists.** Desktop Electron mounts `<AppInterface>` from `@opencode-ai/app` through a 441-line thin shell (`packages/desktop/src/renderer/index.tsx:396–424`), and a plain-web entry doing exactly the same thing ships inside `packages/app` itself (`packages/app/src/entry.tsx:157–184`). A PWA is structurally "the web entry plus PWA platform capabilities plus mobile chrome" — not a new application.

---

## 1. Decision

### 1.1 Why the seam already exists (evidence)

Three independently verified facts collapse this decision:

1. **Desktop is a thin shell over shared UI.** The Electron renderer implements a `Platform` object wiring ~30 native capabilities (`packages/desktop/src/renderer/index.tsx:123–307`) and then mounts the real application: `<AppInterface defaultServer={…} servers={…} router={router} …>` (:396) wrapped in `PlatformProvider` (:417) + `AppBaseProviders` (:419). It contributes no pages, no routes, no state — those all live in `@opencode-ai/app` (handoff §2.2).
2. **A web shell already exists inside `packages/app`.** `packages/app/src/entry.tsx` constructs a complete `platform: "web"` implementation (:123–136: browser draft store, Notification-API notify, URL-guarded openExternal, localStorage-backed default-server persistence) and mounts `AppInterface` against a single HTTP server derived from `location.origin` (:103–108, :161–176). The web surface is even half-PWA-shaped today: `index.html` already carries `viewport-fit=cover`, `interactive-widget=resizes-content`, an `apple-mobile-web-app-capable` tag, `black-translucent` status-bar style, and a manifest link (`packages/app/index.html:7,14–18`).
3. **Layout variation at the router root is established practice.** `AppInterface` selects between `LegacyLayout` and `NewLayout` via the `settings.general.newLayoutDesigns()` flag (`packages/app/src/app.tsx:64–65, :607, :615–617`), keeping routed children identical underneath. A mobile variant is a third arm of an existing mechanism, not a new mechanism.

Given these, the operator axiom ("sharing > porting; copying requires justification", handoff §3.3) has a unique cheapest satisfying shape: become the **third consumer** of the existing composition root.

### 1.2 Options evaluated

| | **A′ (CHOSEN): third shell in `packages/app`** | **B: new `packages/mobile`** | **C: extract route components to a new shared module** |
|---|---|---|---|
| One-line shape | `PlatformName + "pwa"`, `entry-pwa.tsx`, mobile layout variant; pages shared | New package consuming `ui` + `session-ui` + client SDK, own shell | Move session/route-level components out of `app` into a shared module both shells consume |
| State layer (61 files, handoff §2.3) | Shared verbatim (`src/context/**`) | **Must port or depend on `@opencode-ai/app` anyway** → either way B collapses into A′ or into a copy | Shared (that's the point) |
| Provider stack (~20 providers, `app.tsx:42–62`) | Wired once in `AppInterface`; PWA inherits | Re-wired by hand in the new package → drift risk on every provider change | Shared |
| Desktop regression risk | Low: additive union member + new entry + new layout arm; desktop path untouched except one layout-resolver branch | None directly, but fixes must be double-applied → indirect regression source | **High**: touches `pages/session.tsx` (2000+ lines), every import path, all shells simultaneously |
| Bundle size control | Entry-level isolation: `pwa.html` builds its own graph; heavy deps handled per §6 | Cleanest theoretically — but only if mobile truly skips shared modules, which it can't (state layer) | Same as A′ |
| i18n | Shared `LanguageProvider` + ~70 locale files (handoff §2.12); new keys added once | Keys duplicated or package re-imports app i18n → coupling anyway | Shared |
| Test infra reuse | bun unit + Playwright + storybook all already target `packages/app` (§8) | New test scaffolding for near-identical surfaces | Shared |
| Axiom fit (share > port) | Maximal sharing by construction | Porting in disguise | Sharing, but pays extraction cost for ~zero marginal sharing over A′ |
| Verdict | ✅ **ADOPTED** | ❌ rejected | ❌ rejected |

### 1.3 Rationale, stated critically

**Against B (new package):** the valuable logic is not in `ui`/`session-ui` — it is the state layer in `packages/app/src/context/` (61 files: server-sync, sdk, permission, prompt, tabs, command, settings, language, models, notification…, handoff §2.3). Those modules are internal to `@opencode-ai/app` (its package exports are only `.`, `./desktop-menu`, `./i18n/desktop-native`, `./updater`, `./wsl/types`, `./vite`, `./index.css` — `packages/app/package.json:6–14`). So `packages/mobile` must either (a) depend on `@opencode-ai/app` — at which point it is just a second entry with extra steps, i.e. A′ with worse ergonomics — or (b) re-implement the contexts, which is porting and violates the axiom outright. Dependency-direction rules (handoff §2.12) add no obstacle to A′ but B would create a fourth consumer tier to police.

**Against C (further extraction):** C's premise — "extract shared components so two shells can consume them" — describes the status quo. The extraction already happened at package granularity: `@opencode-ai/app` *is* the shared module, and desktop is already its thin consumer. Extracting route-level components into yet another module would churn `pages/session.tsx` and the whole page tree for marginal architectural purity while risking the one thing we may not break: the production desktop app (AGENTS.md priorities: stability first). Where C's *instinct* is right — specific components that hard-code desktop chrome — A′ absorbs it as a targeted **extraction queue inside `packages/app`** (§2.6), not a structural split.

**Why A′ is safe rather than merely cheap:** the desktop build consumes `AppInterface` unchanged; the web build (`entry.tsx`) is untouched; the PWA adds a parallel entry whose blast radius is bounded by Vite's per-entry graphs (§6). The only shared-file edits are: one union member (`platform.tsx:20`), one layout-resolver branch (`app.tsx:607–617` region), and the extraction queue items — each independently shippable behind existing tests.

### 1.4 What A′ concretely adds (artifact inventory, ideation)

| Artifact | Location (proposed) | Notes |
|---|---|---|
| Platform name | `platform.tsx:20` → `"web" \| "desktop" \| "pwa"` + `{ platform: "pwa"; os?: never }` arm mirroring web at :133–141 | Rationale for a distinct name vs reusing `"web"`: §3.5 |
| Mobile entry | `packages/app/src/entry-pwa.tsx` (sibling of `entry.tsx`) | Starts from entry.tsx's platform impl; adds install/share/haptics (§3.4), standalone detection, last-route restore |
| HTML entry | `packages/app/pwa.html` + vite multi-input (§6) | Manifest/SW owned by doc 06 |
| Mobile layout | `packages/app/src/pages/layout-mobile.tsx` (name per 01) | Third arm of the router-root layout resolver; renders tab bar + sheet host around the same routed children (01 §2) |
| Extraction queue | In-place refactors inside `packages/app` | F1–F3 specs: §2.6 |

---

## 2. Reuse inventory

Dispositions: **AS-IS** (consume unchanged) · **ADAPT** (props/CSS-level changes, same module) · **EXTRACT** (move/expose within `packages/app`, no new package) · **MOBILE-ONLY** (new, lives beside shared code) · **OMIT** (desktop feature, never mounted on mobile).

### 2.1 Providers & state layer — AS-IS

The entire stack wired by `AppInterface`/`AppBaseProviders` is inherited by any shell that mounts them (`app.tsx:42–62`, :412–447): `CommandProvider, CommentsProvider, FileProvider, ForkUsageProvider, SessionGroupsProvider, ServerSDKProvider, ServerSyncProvider, GlobalProvider, HighlightsProvider, LanguageProvider, LayoutProvider, ModelsProvider, NotificationProvider, PermissionProvider, PromptProvider, ServerConnection/ServerProvider, SettingsProvider, TabsProvider, SDKProvider, WslServersProvider` + ui-level `I18nProvider, DialogProvider, FileComponentProvider, ThemeProvider, MetaProvider, QueryClientProvider`. Notable behaviors mobile gets for free:

- Query discipline tuned for server-synced data: `refetchOnReconnect/Mount/WindowFocus` all false (`app.tsx:300–309`) — correct starting point for a battery-conscious mobile client.
- Connection gate with health-check loop and 10s timeout (`app.tsx:449–518`); unreachable-server screen with other-server picker (`app.tsx:520–565`) — reusable as the PWA's offline/connect error surface (copy via existing keys `app.server.unreachable`, `app.server.retrying`, `app.server.otherServers`, `app.tsx:526,540,544`).
- Permission/notification/tab persistence ride on `Persist.global` storage seams (handoff §2.3; e.g. command catalog `Persist.global("command.catalog.v1")`, server list `Persist.global("server", ["server.v3"])` at `context/server.tsx:263–266`).

### 2.2 Command palette / spotlight search — AS-IS model, EXTRACT presentation (F3)

- Shared model: `createCommandPaletteModel` + entry factories (commands/files/models/sessions) + `uniqueCommandPaletteEntries` in `components/command-palette.ts`; fuzzy matching via `matchesEntry` (handoff §2.5, verified there).
- Desktop renderer: `DialogCommandPaletteV2` / `DialogHomeCommandPaletteV2` over ui `Dialog` + `ScrollView` (handoff §2.5).
- Command system: registration/trigger API, sources `"palette" | "keybind" | "slash"`, persisted catalog (`context/command.tsx`, handoff §2.5) — AS-IS.
- **Mobile disposition (F3, flagged by 01 §3.3):** keep the model AS-IS; build a mobile renderer (full-screen sheet, large-touch rows) over the same `command-palette.ts` model instead of forcing `DialogCommandPaletteV2` into small viewports. Precedent that the desktop dialog already thinks about narrow screens: a 640px accommodation exists in `dialog-command-palette-v2.css:210–220` (per 01) — but a modal dialog ≠ a mobile spotlight; second renderer preferred. This is presentation-layer duplication of ~one component over a shared model — justified because the alternative (cramming Dialog) degrades the flagship @mention experience (scope item 2).

### 2.3 Prompt-input & @mention machinery — AS-IS (verify keyboard behavior in phase 1)

All cited from handoff §2.6 (coordinator-verified): `components/prompt-input/at-mention-search.ts` (`createAtMentionSearch`, `toMentionOptions` mapping ranked server mention results), `prompt-input/external-path-search.ts` (external-directory mentions with approval at mention time), wiring in `prompt-input.tsx` / `prompt-input-v2.tsx` (mention part types agent/file), request assembly in `build-request-parts.ts` + `submit.ts`. Composer primitives also exist in `session-ui` (`dock-prompt.tsx`, v2 store-based composer exports, handoff §2.8).

Disposition: AS-IS for logic and part assembly. The composer is scope-critical (feature 4) and is where mobile input risks concentrate (virtual keyboard, `visualViewport`, autocorrect) — owned by pwa-platform doc 06; chat-tool-ux owns composer UX (05). Attachment picking needs a platform decision: `openAttachmentPickerDialog?` is optional (`platform.tsx:61–64`) and desktop-only-typed today; the PWA should implement it via a hidden `<input type="file">` bridge so drag-drop-centric flows degrade gracefully (inference — fallback behavior when undefined must be verified in phase 1).

### 2.4 Session building blocks & session-ui kit — AS-IS

`packages/session-ui/src/components/` (77 entries, handoff §2.8): message/timeline parts (`message-part.tsx`, `message-nav.tsx`, `session-turn.tsx`, `session-retry.tsx`), tool cards (`basic-tool.tsx`, `git-tool.tsx`, `tool-output.tsx`, `tool-error-card.tsx`, …), diffs/review (`session-diff.ts`, `session-review.tsx`, `line-comment.tsx`, `@pierre/diffs`), streaming markdown (`markdown-stream.ts` + worker infra), context visualization exports (`./context`, `./context/*`, handoff §2.7). Every component ships stories (handoff §2.8). Disposition: AS-IS wholesale — this is the "premium tool UX matching desktop" requirement, satisfied by construction.

Context breakdown pane (scope item 3): `session-context-usage.tsx`, `usage-gauge-v2.tsx`, `status-popover.tsx/-body.tsx`, `usage/` dir in app + session-ui context exports (handoff §2.7). Data-source question owned by api-data (04). On mobile it becomes a detent sheet (01), consuming the same components — ADAPT at most for sheet-width presentation.

### 2.5 Design system — AS-IS (extend, don't fork)

`@opencode-ai/ui`: ~60 Kobalte-based primitives with colocated css+stories, Tailwind v4, theme JSON shipped in-package, v2 layer + overrides generator (handoff §2.9). Per axiom 5 the PWA extends the existing token system; design-system (02) owns token/density decisions. Drawer/sheet primitive already a dependency: `@corvu/drawer` (`package.json:60`) — the mobile sheet host builds on what desktop already ships.

### 2.6 Extraction queue (F1–F3 from 01 §3.3) — EXTRACT, in place

These are the only places where sharing requires moving code, and all stay inside `packages/app`:

- **F1 Home content.** `pages/home/home-{projects,sessions}-view.tsx` views are wide-viewport-tuned; controllers look reusable (01 §3.3). Spec: keep controllers AS-IS; extract row/list-item presentation into shared components consumable by both `NewHome` and the mobile sessions tab; mobile-only composition stays in the mobile layout. Risk: low; pure presentation split.
- **F2 Session page internals.** `pages/session.tsx` arranges three panes desktop-first; timeline/composer/docks need to be addressable without the pane scaffold (01 §3.3). Spec: expose the center-column content (timeline + composer mount) as an exported component from the session page module; `ProjectExplorerPanel`/side-panel mounts stay desktop-path-only. This is the highest-value extraction (it is the walking skeleton's main screen) and the highest-risk one — see migration phase 2 gating.
- **F3 Spotlight renderer.** Covered in §2.2: second renderer over `command-palette.ts`.

Anti-goal guardrail: none of these create a parallel implementation of logic; they move *presentation boundaries*. If during extraction a component turns out to interleave logic and desktop chrome inseparably, stop and re-scope rather than fork-and-diverge (axiom 3).

### 2.7 OMIT on mobile (never mounted ⇒ ideally never fetched, see §6)

File explorer (`project-explorer-tree.tsx`, `file-tree*.tsx`, `@pierre/trees`, handoff §2.10), browser pane (`pages/session/v2/browser-panel-v2.tsx` + `v2/browser/*`, located by ux-architect), terminal pane (`components/terminal.tsx` — ghostty-web), desktop updater/WSL/menu machinery (`updater`, `wsl/`, `desktop-menu`), `settings-keybinds` UI (keyboard-centric). Exclusions are absolute per axiom 4; this section exists so bundle work (§6) knows what *should* fall out of the mobile graph.

---

## 3. Platform interface delta

Full interface read: `packages/app/src/context/platform.tsx` (150 lines). `PlatformBase` (:35–131) is mostly optional; the `Platform` union (:133–141) makes `openDirectoryPickerDialog` required only for `"desktop"`.

### 3.1 MUST implement (required by the type for any non-desktop arm)

| Member | Signature site | PWA implementation |
|---|---|---|
| `openExternal(url)` | `platform.tsx:40` | Reuse web impl verbatim: protocol-guarded `window.open(..., "noopener,noreferrer")` (`entry.tsx:83–88`) |
| `refresh()` | `platform.tsx:52` | `location.reload()` (`entry.tsx:90–92`) |
| `restart()` | `platform.tsx:55` | `location.reload()` (`entry.tsx:94–96`) |
| `notify(title, description?, onClick?)` | `platform.tsx:58` | Web Notifications impl exists (`entry.tsx:58–81`); PWA upgrades later to SW-shown notifications when installed — owned by 06 |

### 3.2 SHOULD implement (optional, but parity or UX requires it)

| Member | Site | Why / how |
|---|---|---|
| `storage?(name?)` | `platform.tsx:73` | Default localStorage is fine initially; revisit under SW/eviction pressure (06) |
| `draftStore?` | `platform.tsx:76` | `createBrowserDraftStore()` exists (`entry.tsx:125`) — reuse; drafts are core prompt UX |
| `getDefaultServer` / `setDefaultServer` | `platform.tsx:88–91` | localStorage-backed impl exists (`entry.tsx:131–135`); semantics §4 |
| `fetch?` | `platform.tsx:85` | Omit initially (default fetch); SW interception handles offline (06) |
| `openAttachmentPickerDialog?` | `platform.tsx:61–64` | Implement via hidden file input bridge so attachments work where drag-drop doesn't exist (inference: verify graceful degradation if omitted) |
| `saveFilePickerDialog?` | `platform.tsx:70` | Map to download/`navigator.share` of exported artifacts (inference; low priority) |
| `readClipboardImage?` | `platform.tsx:121` | Async Clipboard API `navigator.clipboard.read()` where permitted (inference; iOS Safari support partial — verify in 06) |
| `recordFatalRendererError?` | `platform.tsx:130` | Wire to Sentry only (Sentry init pattern: `entry.tsx:138–155`) |

### 3.3 OMIT (desktop-only by type or by nature)

`openPath`, `openLocalFile`, `revealPath` (:43–49), `getPathForFile` (:67), `updater` (:82), `wslServers` (:94), `getDisplayBackend`/`setDisplayBackend` (:97–100), `webviewZoom` (:103), `windowFullscreen` (:106), pinch-zoom prefs (:109–112), `runDesktopMenuAction` (:115), `checkAppExists` (:118), `exportDebugLogs` (:124), `setForceFocus` (:127), `openDirectoryPickerDialog` (desktop-arm-only, :139), `os` (web arm has `os?: never`, :135). All call sites already treat these as optional — desktop code guards them (e.g. `app.tsx:351` checks `platform === "desktop" && platform.exportDebugLogs`), so omission is type-safe.

### 3.4 Proposed additions to `PlatformBase` (typed sketches)

Placed alongside `notify` in `PlatformBase` (`platform.tsx:35–100+` region), all optional so web/desktop may omit:

```ts
/** Share content via the platform share sheet; no-op/unsupported where absent */
share?(payload: { title?: string; text?: string; url?: string }):
  Promise<"shared" | "cancelled" | "unsupported">

/** Install-state + install prompt for installed-web-app contexts */
installPrompt?: {
  /** True when a deferred install prompt was captured (Chromium beforeinstallprompt) */
  available(): boolean
  /** Running as installed app (display-mode: standalone, or navigator.standalone on iOS) */
  isStandalone(): boolean
  promptInstall(): Promise<"accepted" | "dismissed" | "unavailable">
}

/** Haptic feedback where the platform supports it; silent no-op elsewhere */
haptics?(style: "light" | "medium" | "heavy" | "success" | "warning" | "error"): void
```

Implementation notes: `share` maps to `navigator.share` guarded by `navigator.canShare` (requires secure context + user gesture — inference/MDN); `installPrompt.available()` is false on iOS Safari (no `beforeinstallprompt`) where install is manual via share-sheet — the banner UX must therefore be platform-aware (06 owns copy/UX; keys below); `haptics` maps to `navigator.vibrate` patterns on Android; **iOS Safari exposes no web haptics API — verified by 06 §2.5 (`navigator.vibrate` absent through iOS 17.x)**; capability-detect must return false on iOS permanently and no design may depend on haptics (02 informed).

i18n keys this doc introduces (axiom 6; final copy owned by 06/02): `pwa.install.banner.title`, `pwa.install.banner.action`, `pwa.install.banner.dismiss`, `pwa.share.session.title`. All other mobile copy reuses existing keys (e.g. connection errors, §2.1).

### 3.5 `"pwa"` vs reusing `"web"`

**Add `"pwa"`.** Reasons: (1) telemetry separation — `FatalRendererErrorLog.platform` (`platform.tsx:23–33`) and Sentry tags (`entry.tsx:144–146` tags `"web"`; desktop :55–58 tags `"desktop"`) would blur a PWA fleet into the generic-web bucket; (2) branch points exist and will grow — `DesktopCommands` branches on `platform === "desktop"` (`app.tsx:351`); install banners, share buttons, and standalone-only chrome need their own arm; (3) cost is one union member mirroring the web arm (`{ platform: "pwa"; os?: never }`). Known risk: any `=== "web"` check silently excludes `"pwa"` — a grep shows such checks live mainly in tests/storybook mocks (`test-browser/prompt-persistence.test.ts:22`, `utils/persist.test.ts:56`, `storybook/.storybook/mocks/app/context/platform.ts:4`), suggesting low blast radius, but a Phase-0 audit task is mandatory (inference on completeness of that grep).

---

## 4. ServerConnection story

Types read in full: `context/server.tsx`. `ServerConnection.Any = Http | Sidecar | Ssh`; Sidecar/Ssh are explicitly desktop-only (`server.tsx:190–222`). **The PWA speaks `Http` only** — which is exactly what the existing web entry already does.

- **Single local server default.** `getCurrentUrl()` semantics reused verbatim (`entry.tsx:103–108`): prod serves from the opencode server origin ⇒ `location.origin`; dev targets `localhost:4096` via env override. The PWA launched from `https://<host>/` talks to the server that served it. Server object shape: `{ type: "http", authToken, http: { url, ...auth } }` (`entry.tsx:161–168`). Same-origin serving is now **verified by 04**: `opencode serve` already hosts static UI via a catch-all route with SPA fallback (`server.ts:207–216`, `shared/ui.ts:44–76`, per 04 §3), so `pwa.html` ships as part of that embedded bundle — no separate origin, no CORS story.
- **`getDefaultServer` semantics for PWA origin.** Stored override wins, else origin: key `opencode.settings.dat:defaultServerUrl` (`entry.tsx:15, :110–114, :131–135`). This lets a user point a served PWA at a different instance than its serving origin. `ServerProvider` supports runtime switching (`setActive/add/remove`, `server.tsx:286–313`) and the unreachable screen lists alternates (`app.tsx:542–560`) — so multi-instance is inherited infrastructure even though we ship one server.
- **`canonicalLocalServer`** is passed for persisted-state migration (`entry.tsx:175`; migration logic `server.tsx:45–77`) — PWA passes it identically so upgraded clients don't lose project/server state.
- **Auth token intake** already exists: `?auth_token=` query param is consumed and stripped from history (`entry.tsx:116–121, :159`). This is the hook api-data's pairing/auth design (04) should target rather than inventing a new channel.
- **Health check:** web entry passes `disableHealthCheck` (`entry.tsx:177`); `ConnectionGate` still gates startup and treats http servers as fail-fast (`app.tsx:457–474`). Keep this posture on mobile (flaky LAN shouldn't spin the blocking checker); refine retry UX in phase 4.
- **Later:** user-added remote http servers via `add()` (`server.tsx:290–304`) — defer past the walking skeleton; auth model for LAN access is 04's open question (handoff §4).

---

## 5. Router strategy

- **Desktop uses MemoryRouter** (`renderer/index.tsx:20, :115–121`) because Electron windows have no meaningful URL bar; it persists last-active-url itself in localStorage (:95–113) and receives deep links via IPC events into `window.__OPENCODE__.deepLinks` (:76–93).
- **Web/PWA uses browser history.** `AppInterface` defaults to the framework `Router` when no `router` prop is passed (`app.tsx:609`), and `entry.tsx` passes none (:173–178). **Recommendation: do NOT inject MemoryRouter on mobile.** Browser history gives us: universal-link landings on real URLs, iOS back-swipe integration, shareable session URLs, and launch-restore for free (URL carries state). MemoryRouter would orphan deep links and fight the back gesture.
- **Deep links.** In-app and cross-device https URLs resolve through the existing route table — the cross-project session route `/server/:serverKey/session/:id` (`app.tsx:660`), group routes (:661–662), draft route `/new-session` (:664). Zero new paths (agreed with 01). True OS-level universal links require a public HTTPS origin + AASA association; LAN-IP origins cannot universal-link (inference). Custom `opencode://` schemes require a native wrapper — out of scope for a pure PWA; recorded as future extension, not designed here.
- **Launch routing.** Cold launch with a URL: resolves naturally. Cold launch from the home-screen icon lands on `/`: restore last route via a small persisted snapshot written by a history listener in `entry-pwa` (mechanism agreed with 01; precedent: desktop's last-active-url pattern, `renderer/index.tsx:95–106`). Only the no-URL case needs the snapshot.
- **Redirect hygiene (risk R2 from 01):** redirect-style routes must use replace semantics so back-swipe never loops: `DraftRoute` fallback `Navigate href="/"` (`app.tsx:211`), `NewLayoutLegacySessionRedirect` (:694–713), legacy session redirect chain (:86–96, :144–176). Audit these in phase 2 with a Playwright back-stack test (§8).
- **Settings has no route today** (verified absent from `app.tsx:634–667`; raised by 01 as Q5). Recommendation: mobile renders Settings as a sheet over any route (consistent with 01's "sheets are not history entries"), requiring **no new route in any shell**. Add a real `/settings` route only if deep-linking into settings becomes a requirement — and then for all shells, not mobile-only (a mobile-only route would fork the route table and violate the source-of-truth goal).

---

## 6. Bundle strategy

Heavy-dependency facts, verified:

| Dep | Where it loads today | Already lazy? | Mobile action |
|---|---|---|---|
| ghostty-web (terminal) | dynamic import with shared promise `loadGhostty()` (`components/terminal.tsx:33–44`); type-only imports elsewhere (`terminal.tsx:7`, `addons/serialize.ts:16`) | ✅ chunk-split | Never mount terminal ⇒ chunk never fetched. Nothing to do. |
| Markdown streaming worker | `markdown.worker.ts` loaded via `?worker&url` (`session-ui/src/components/markdown-worker.ts:1`); shiki grammars deliberately behind lazy imports (`message-file.ts:17`) | ✅ worker | Keep; it keeps shiki off the main thread — good for mobile jank budgets |
| Pierre diffs worker | `@pierre/diffs/worker/worker.js?worker&url` (`session-ui/src/pierre/worker.ts:2`) | ✅ worker | Keep |
| codemirror (+`@codemirror/language-data`, all 6 packages in `package.json:52–59,93`) | **statically imported** by `pages/session/v2/project-explorer-editor-pane.tsx:3–25` | ❌ | Lazy-boundary `ProjectExplorerPanel` (below) |
| shiki `bundledLanguages` | statically imported by `pages/session/v2/project-explorer-markdown-viewer.tsx:6` | ❌ (this instance) | Same boundary |

**The one concrete problem:** `ProjectExplorerPanel` is statically imported by the session page (`pages/session.tsx:31`), so codemirror + bundled shiki grammars ride in the session route chunk **today, on every surface**, despite the explorer being a desktop-only pane. Fix: wrap the mount point in a `lazy(() => import("@/pages/session/v2/project-explorer-panel"))` boundary (precedent abounds: `app.tsx:75–76`, `group-tab.tsx:9`, `dialog-select-file.tsx:25`, `directory-picker.tsx:9`, `status-popover.tsx:18–19`). This benefits desktop too and is proposed as a standalone, pre-PWA refactor (phase 0) so its effect is measurable in isolation.

Same treatment applies to the browser pane, which is statically imported by `layout-new.tsx:10–12` (`BrowserPanelV2`, `browserHostClient`) and referenced from `session.tsx:95` — excluded on mobile (axiom 4) and lazy-boundary candidates for everyone.

**Build topology:** add `pwa.html` as a second Vite input (config currently single-entry via `index.html` script tag, `index.html:26`; plugins/alias/worker-format already centralized in the shared plugin `vite.js:18–48`, consumed by `vite.config.ts:23`). Per-entry graphs mean desktop/web chunks are unaffected by mobile-only modules and vice versa; shared modules dedupe into common chunks automatically. Dev server already binds `0.0.0.0` with `allowedHosts: true` (`vite.config.ts:24–28`) — phone-on-LAN testing works today.

**Budgets:** initial JS for `pwa.html` should exclude codemirror/shiki-bundled/ghostty/browser-pane by construction after the above; numeric budgets and measurement methodology belong to 06 (perf owner). What this doc commits to: the *structural* guarantee that excluded features are not in the mobile initial graph.

---

## 7. Migration plan

Ordered phases; each ships something runnable. Walking skeleton = phase 1.

**Phase 0 — Foundations (low risk, mostly mechanical).**
`"pwa"` union member + audit of `=== "web"` checks; `pwa.html` + vite input; `entry-pwa.tsx` cloned from `entry.tsx` with PWA platform impl v0 (web impl + `installPrompt.isStandalone` + stubs); lazy boundaries for ProjectExplorerPanel/BrowserPanelV2 (desktop-verifiable win first). Manifest/SW authored per 06 but wired here. Upstream `@opencode-ai/ui` candidates from 02 ride this phase or alongside Phase 2 (zinc.json theme, explicit `--surface-disabled` definition fixing the latent button/checkbox/switch CSS bug, px→rem type tokens) — all shared-surface work with zero app coupling, none blocking the walking skeleton (02).
*Risk:* union-member blind spots (mitigated by the grep audit); lazy-boundary regressions on desktop (mitigated by existing desktop e2e, §8).

**Phase 1 — Walking skeleton (the proof).**
Connect → sessions list → open session → stream → prompt, end-to-end on a phone:
1. Connect: `ConnectionGate` + `?auth_token` intake against a LAN server (reuse `disableHealthCheck` posture).
2. Sessions list: mobile home rendering F1-extracted rows (or raw `NewHome` at first — acceptable skeleton shortcut, replaced in phase 2).
3. Open session: navigate `/server/:serverKey/session/:id`; F2 extraction minimally scoped: center column (timeline+composer) rendered without side panes.
4. Stream: `ServerSyncProvider`/SSE as-is; observe iOS background throttling (06 measures; api-data owns reconnect/backfill semantics, handoff §4).
5. Prompt: `PromptInput` as-is; virtual-keyboard behavior is the known wildcard (visualViewport — 06).
*Risk:* this phase discovers whether any assumption above is wrong (attachment-picker fallback, keyboard, SSE backgrounding). Timebox discovery; escalate findings to 04/05/06 rather than patching locally.

**Phase 2 — Navigation model completion.**
`layout-mobile.tsx` as third layout arm; tab bar + push stack + corvu/drawer sheet host (01 §2); F1/F2 extractions completed; redirect/back-stack audit (R2); settings-as-sheet (Q5 answer). 
*Risk:* layout-resolver change touches `AppInterface` root — gate on full desktop e2e suite green before merging; keep the legacy/new arms byte-identical in behavior.

**Phase 3 — Scoped-feature completion.**
Spotlight mobile renderer (F3); context-breakdown sheet; permissions UX on mobile (05 owns spec); tool-card interactions; share affordances (`platform.share`); install banner (06 copy).
*Risk:* low architecturally; coordination cost with 02/05.

**Phase 4 — Hardening.**
Offline/error states (04 semantics), notification upgrade path (06), perf budgets enforcement, Playwright mobile projects in CI, storybook mobile globals (§8), `"pwa"` telemetry dashboards.
*Risk:* SW caching vs SSE invalidation — joint 04+06 open question (handoff §4); do not ship SW aggressive caching before that is answered.

---

## 8. Testing story

All three existing layers extend naturally; nothing new is invented:

- **bun unit** (colocated, `bun test --conditions=solid`, `package.json:23`): platform-impl units for `entry-pwa` (storage-backed default server, standalone detection, share/install guards) following the existing mock style (`utils/persist.test.ts:56` mocks `usePlatform`); pure logic like last-route snapshot gets direct tests.
- **Playwright e2e** (`test:e2e*`, `package.json:26–29`): add device-profile projects (iPhone viewport, touch, `display-mode: standalone` emulation) targeting the `pwa.html` dev server; the walking skeleton (§7 phase 1) becomes the first mobile e2e flow; back-stack assertions cover R2 redirects. Existing desktop suites run unchanged as the regression gate for every shared-file edit (layout resolver, lazy boundaries).
- **Storybook** (`packages/storybook` exists; a web platform mock already lives at `storybook/.storybook/mocks/app/context/platform.ts:4`; ui/session-ui components ship stories per handoff §2.8–2.9): add a `"pwa"` platform mock + mobile viewport globals/layout so shared components are reviewed at touch sizes; F1/F2/F3 extracted components get stories in both presentations to keep divergence visible.
- **Manual matrix** (owned by 06): real iOS Safari standalone vs browser-tab, Android Chrome install flow, LAN latency profiles.

---

## 9. Open questions & risks

| # | Item | Type | Owner / next step |
|---|---|---|---|
| OQ1 | Does `PromptInput` degrade gracefully when `openAttachmentPickerDialog` is undefined? | inference, unverified | Verify in phase 1; implement file-input bridge if needed (§3.2) |
| OQ2 | iOS web haptics | **RESOLVED by 06 §2.5** — `navigator.vibrate` absent on iOS Safari through 17.x; Android Chrome yes | closed; `haptics` stays optional no-op-safe, capability-detect governs |
| OQ3 | Universal links need public HTTPS + AASA; LAN origins can't | inference | 04 decides deployment/hosting story; affects deep-link ambitions only, not in-app routing |
| OQ4 | Static-serving capability of `opencode serve` (does it host `pwa.html`?) | **RESOLVED by 04 §3** — same-origin embedded bundle, catch-all uiRoute + SPA fallback (`server.ts:207–216`) | closed; `pwa.html` rides the existing serving path |
| OQ5 | SW cache boundary vs SSE/query invalidation | open (handoff §4) | 06 + 04 jointly; gates phase 4 |
| OQ6 | Context-pane data source fields | open (handoff §2.7) | api-data (04) |
| R1 | `=== "web"` checks missing `"pwa"` post-union | risk | Phase-0 audit task; grep suggests few sites (§3.5) |
| R2 | Redirect loops in back-swipe (`app.tsx:211,694–713,86–96`) | risk (from 01) | Phase-2 audit + e2e back-stack test |
| R3 | Layout-resolver edit regresses desktop | risk | Gate phase 2 on full desktop e2e; arms otherwise untouched |
| R4 | F2 extraction destabilizes session page (2000+ lines, benchmark-sensitive per app AGENTS.md) | risk | Record production benchmark baseline before/after (repo rule); extract incrementally |
| R5 | Virtual keyboard/SSE backgrounding on iOS invalidate phase-1 assumptions | risk | Discovery timeboxed in phase 1; findings routed to 06/04 |
| R6 | Vendored client tgz pin (`@opencode-ai/client file:vendor/...`, `package.json:67`) constrains SDK drift between surfaces | note | Shared by all shells equally; no PWA-specific action |

---

## 10. Dependency notes

- **To 01 (ux-architect):** adopted your F1–F3 flags (§2.6), R2 (§5), Q5 answered — settings-as-sheet recommended, no new route (§5); haptics typed as optional no-op-safe (§3.4).
- **To 02 (design-system):** token work extends `@opencode-ai/ui` in place (§2.5); sheets build on `@corvu/drawer` already in the dependency set; haptics must not be load-bearing pending OQ2. Your `[DEPENDS: 03]` packaging question, answered: shared primitives you promote (bottom sheet/action sheet → `ui/v2`) live in the **ui package** and are consumed by all shells; PWA-local chrome (tab bar, large-title host) lives in **`packages/app` beside `layout-mobile.tsx`** — never in a new package (§1.4). px→rem sequencing is a ui-package concern independent of shell count; A′ adds no constraint beyond "one source, both shells consume".
- **To 04 (api-data):** PWA is Http-connection-only; auth should target the existing `?auth_token` intake (§4); serving question OQ4 decides `pwa.html` hosting.
- **To 05 (chat-tool-ux):** timeline/tool/composer components are AS-IS (§2.3–2.4); your doc specifies mobile presentation over them, not replacements.
- **To 06 (pwa-platform):** you own manifest/SW/keyboard/perf/manual-matrix details (§6–8 boundaries respected); `entry-pwa` platform impl is your implementation surface per §3. Answers to your synthesis asks: **PlatformName = add `"pwa"`** (§3.5, with phase-0 audit of `=== "web"` checks); **updater mapping = `updater?` stays OMITTED on mobile** (§3.3) — updates flow through your SW pipeline ending in `Platform.refresh()` (= `location.reload()`, §3.1), which is exactly the SKIP_WAITING → controllerchange → refresh chain you specced.
