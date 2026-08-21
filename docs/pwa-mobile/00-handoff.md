# PWA Mobile UI — Coordinator Handoff (read this FIRST, do not re-explore what is here)

- **Mission:** ideate a **local-webserver mobile PWA UI** for opencode — premium, iOS-PWA-first UX for accessing/controlling/interacting with agent sessions. Heavily based on the Electron desktop UI (fewer features), shadcn-zinc styling on the existing design system, **New York dense spacing**, one source of truth shared with desktop wherever possible.
- **Phase:** IDEATION ONLY. Deliverables are markdown design docs in `docs/pwa-mobile/`. **No production code changes.**
- **Author:** swarm coordinator (`ox-alpha`, 2026-08-21). Every claim below marked ✅ was **verified by reading the cited file**. Anything marked ⚠️ is UNVERIFIED — the named owner must confirm it before asserting it anywhere.
- **Trust rule for all members:** every statement in your doc needs either a `path:line` citation or an explicit "inference/unverified" label. Do not invent endpoints, props, or file names. If it's not in this doc and you haven't read it, go read it — then it becomes citable.

---

## 1. Scope contract (fixed by operator — do not relitigate)

**IN scope:**
1. Access to **all projects / all sessions** (cross-project session browsing)
2. The **@mention "spotlight search"** experience
3. The **context breakdown pane** (context usage/window visualization)
4. **Full agent chat UX** with premium tool UX matching the desktop app

**OUT of scope (hard exclusions):** project **file explorer**; **browser** pane.

**Non-negotiable qualities:** premium UI/UX, rich interactions, shadcn-zinc aesthetic, New York dense spacing, iOS PWA native feel (safe areas, sheets, gestures), maximal logic/component sharing with the desktop app via ONE source of truth.

**Design target API: V1 HTTP API only.** V2 APIs / `SessionV2` are beta infrastructure — do not design around them (repo AGENTS.md mandate).

---

## 2. Verified repo map (✅ = coordinator read these files; cite them freely)

### 2.1 Monorepo shape
- Bun workspaces under `packages/`: `app, cli, client, codemode, console, containers, core, desktop, docs, effect-drizzle-sqlite, effect-sqlite-node, enterprise, function, http-recorder, httpapi-codegen, identity, llm, opencode, plugin, protocol, schema, script, sdk-next, sdk, server, session-ui, slack, stats, storybook, tui, ui, web`.
- `packages/web` is the Astro marketing/docs site — **irrelevant** to this mission.

### 2.2 Desktop is a THIN shell — the app UI is shared already
✅ `packages/desktop/src/renderer/index.tsx` (441 lines total):
- Implements a `Platform` object (`createPlatform`, :123–307) wiring ~30 native capabilities (pickers, notifications, storage, drafts, updater, deep links, WSL servers, clipboard images…).
- Mounts the real UI: `<AppInterface defaultServer={…} servers={…} router={router} …>` at :396, wrapped in `PlatformProvider` (:417) + `AppBaseProviders` (:419).
- Router is injected (`DesktopMemoryRouter`, MemoryRouter, :115–121); locale loading :325–335; splash/loading states :315–321.
- **Implication:** the "one source of truth" seam ALREADY EXISTS — it is `@opencode-ai/app`'s `AppInterface` + the `Platform` interface. A PWA is plausibly "another shell," exactly like Electron is.

### 2.3 `packages/app` (`@opencode-ai/app`) — the real application
✅ `src/app.tsx` (713 lines): `AppInterface` composition root.
- Providers wired at :42–62: `CommandProvider, CommentsProvider, FileProvider, ForkUsageProvider, SessionGroupsProvider, ServerSDKProvider, ServerSyncProvider, GlobalProvider, HighlightsProvider, LanguageProvider, LayoutProvider, ModelsProvider, NotificationProvider, PermissionProvider, PromptProvider, ServerConnection/ServerProvider, SettingsProvider, TabsProvider, SDKProvider, WslServersProvider` (+ ui-level `I18nProvider, DialogProvider, FileComponentProvider, ThemeProvider, MetaProvider, QueryClientProvider` :3–21).
- Routing via `@solidjs/router` (:11–20); lazy pages :75–76.
- Dual layout system: `settings.general.newLayoutDesigns()` gates Legacy (`pages/layout.tsx`) vs New (`pages/layout-new.tsx`) (:64–65, :86).
✅ `src/pages/`: `home.tsx` (NewHome) + `home/legacy-home.tsx`, `session.tsx` (+ `session/` dir incl. `file-tabs.tsx`, `v2/project-explorer-editor-pane.tsx`), `layout.tsx`, `layout-new.tsx`, `directory-layout.tsx`, `new-session/`, `group-tab.tsx`, `error.tsx`.
✅ `src/context/` (61 files): the entire state layer — notably `platform.tsx`, `command.tsx`, `server-sync.tsx`, `server-session.ts` (+ v2 reducer), `sdk.tsx`, `permission.tsx` (+ auto-respond), `prompt.tsx`, `tabs.tsx`, `settings.tsx`, `language.tsx`, `models.tsx`, `notification.tsx`, `local-agent.ts`, `layout*.ts`. Tests colocated (`*.test.ts`) — bun test.
✅ `package.json`: SolidJS + `@solidjs/router` + `@tanstack/solid-query` + `@tanstack/solid-virtual`; UI deps `@kobalte/core`, `@corvu/drawer` (drawer primitive!), `tailwindcss` (v4 catalog), `tw-animate-css`, `motion` 12.x, codemirror 6, shiki, ghostty-web (terminal), `fuzzysort`, luxon, remeda; data deps `@opencode-ai/client` (**vendored tgz**: `file:vendor/opencode-ai-client-1.17.13-v3.tgz`, :67) + workspace `core/schema/sdk/session-ui/ui` (:68–72). Vite + `vite-plugin-solid`; tests: `bun test --conditions=solid` (unit) and Playwright e2e (`test:e2e*` scripts).

### 2.4 The `Platform` seam (the PWA integration point)
✅ `packages/app/src/context/platform.tsx`:
- `PlatformName = "web" | "desktop"` (:20) — a PWA would add a name (or reuse `"web"`; decide in 03).
- `PlatformBase` (:35–100+): `openExternal, openPath?, revealPath?, refresh, restart, notify, openAttachmentPickerDialog?, getPathForFile?, saveFilePickerDialog?, storage?(name)→SyncStorage|AsyncStorage, draftStore?: DraftStore, windowID?, updater?, fetch?, getDefaultServer/setDefaultServer, wslServers?, displayBackend…` — most are optional; web currently runs without many of them. **This is where haptics/share/install-prompts would slot in if needed.**

### 2.5 Spotlight / command palette (feature: @mention spotlight search)
✅ `packages/app/src/components/dialog-command-palette-v2.tsx`: `DialogCommandPaletteV2` (:38) and `DialogHomeCommandPaletteV2` (:64) built on a shared model `./command-palette.ts` (`createCommandPaletteModel`, entry factories for commands/files/models/sessions, `uniqueCommandPaletteEntries`); fuzzy matching via `matchesEntry` (:37); renders through ui `Dialog` + `ScrollView` (:191–207); file rows show dir/name split with `FileIcon` (:280–286).
✅ Command system: `src/context/command.tsx` — palette id `"command.palette"` (:13), `CommandOption` (:75), registration/trigger API (:426–451), persisted catalog (`Persist.global("command.catalog.v1")` :278), sources `"palette" | "keybind" | "slash"` (:101).

### 2.6 @mention machinery (composer)
✅ `packages/app/src/components/prompt-input/at-mention-search.ts` — `createAtMentionSearch`, `toMentionOptions` (maps ranked **server** mention results to popover options, :14).
✅ `prompt-input/external-path-search.ts` — external-directory mentions with approval **at mention time** (:117 comment).
✅ Wired into `components/prompt-input.tsx` (:59 imports; drag-dropzone "@mention" label :1655) and `components/prompt-input-v2.tsx` (mention part types `agent`/`file` :460–514).
✅ Request assembly: `prompt-input/build-request-parts.ts` (mention regex :42, comment mentions → file parts :163–193); `submit.ts` (mention source spans :185–194). Drag overlay typing `"image" | "@mention"` in `attachments.ts`/`transient-state.ts`/`drag-overlay.tsx`.
⚠️ The exact **server endpoint** backing `createAtMentionSearch` (likely `file.ts` handler) — OWNER: api-data must read `at-mention-search.ts` + `handlers/file.ts` and cite it.

### 2.7 Context breakdown pane (feature)
✅ `packages/app/src/components/session-context-usage.tsx` exists; related: `usage-gauge-v2.tsx`, `status-popover.tsx`/`status-popover-body.tsx`, `usage/` dir, `session-usage-warning-banner.tsx`.
✅ `packages/session-ui` exports `./context` and `./context/*` (`src/context/` — context visualization components) per its package.json exports (:17–18).
⚠️ Exact data source (which endpoint/model fields feed the breakdown) — OWNER: api-data.

### 2.8 Chat & tool UX building blocks (feature: full agent chat)
✅ `packages/session-ui/src/components/` (77 entries) — the desktop tool/message kit, all reusable candidates:
- Messages/timeline: `message-part.tsx` (+css/stories/tests), `message-nav.tsx`, `message-file.ts(x)`, `session-turn.tsx`, `session-retry.tsx`, `part-default-open.ts`.
- Tools: `basic-tool.tsx`, `git-tool.tsx`, `sqlite-tool.tsx`, `typecheck-tool.tsx`, `sympy-tool.tsx`, `tool-output.tsx`, `tool-error-card.tsx`, `tool-status-title.tsx`, `tool-count-label.tsx`, `tool-count-summary.tsx`, `apply-patch-file.ts`.
- Diffs/review: `session-diff.ts`, `session-review.tsx`, `line-comment.tsx` (+styles/annotations), `@pierre/diffs` dep.
- Markdown streaming: `markdown-stream.ts` + worker infra (`markdown.worker.ts`, worker-protocol/queue/transport) + `markdown-cache.tsx`; shiki + `@shikijs/stream`.
- Composer primitives: `dock-prompt.tsx`; v2 composer: exports `./v2/prompt-input` (+ `/interaction`, `/store`, `/types`) — Solid store-based.
- Misc: `shell-timer.tsx`, `file-media.tsx`, `file-search.tsx`.
✅ Every component ships `.stories.tsx` → `packages/storybook` exists for visual work.

### 2.9 Design system (`packages/ui` — `@opencode-ai/ui`)
✅ `src/components/` (133 entries): ~60 primitives, each with colocated `.css` + `.stories.tsx`: button, icon-button, text-field, inline-input, select, dropdown-menu, context-menu, dialog, popover, hover-card, tooltip, toast, tabs, accordion, collapsible, card, avatar, tag, list, switch, checkbox, radio-group, spinner, progress, progress-circle, scroll-view, keybind, image-preview, diff-changes, dock-surface, resize-handle, sticky-accordion-header, animated-number, text-reveal/shimmer/strikethrough, typewriter, motion-spring, file-icon/provider-icon/app-icon (+spritesheets), logo/splash, font.
✅ Stack: Kobalte-based (shadcn-style), Tailwind v4, `tw-animate-css`, `motion` 12.x, `solid-sonner` (toasts), katex, dompurify.
✅ Theming: `src/theme/` (`index.ts`, `context.tsx`, `themes/*.json` shipped in package files); styles entry `src/styles/index.css` + `styles/tailwind/index.css`; v2 layer: `v2/components/*` + `v2/styles/*` + generator `script/build-oc2-v2-overrides.ts` (`generate:v2-oc2`). Icons spritesheet via `vite-plugin-icons-spritesheet`.
⚠️ Actual token inventory (CSS var names, zinc-ness of current neutrals, radius/spacing scale) — OWNER: design-system reads `src/theme/**` + `src/styles/**` and cites.

### 2.10 Excluded-feature locations (for the scope matrix only — do NOT design them)
✅ File explorer: `packages/app/src/components/project-explorer-tree.tsx` (+css, context menu), `file-tree.tsx`, `file-tree-v2.tsx` (+model), `pierre-tree.test.ts` (`@pierre/trees` dep in app).
✅ Browser pane (verified by ux-architect): `packages/app/src/pages/session/v2/browser-panel-v2.tsx` (+ `v2/browser/*`) — marked OUT in scope matrix; do not design it.

### 2.11 Backend — V1 HTTP API (production surface)
✅ `packages/opencode/src/server/routes/instance/httpapi/`: `api.ts`, `server.ts`, `public.ts`, `event.ts` (SSE/event stream), `websocket-tracker.ts` (WS support exists), `lifecycle.ts`, `errors.ts`, `middleware/`, `groups/`, and `handlers/` (24 files): `config, control-plane, control, event, experimental, file, fork-credential, global, instance, mcp, permission, project-copy, project, provider, pty, question, session-errors, session-group, session, sync, tool, tui, usage, workspace`.
- There is an **AGENTS.md inside `httpapi/`** — api-data MUST read it before citing route shapes.
⚠️ Concrete route shapes/auth — OWNER: api-data (read `api.ts` + relevant handlers; cite `path:line`).
✅ SDK chain: `packages/sdk/js` (legacy JS SDK; regen via `./packages/sdk/js/script/build.ts`), `packages/client` (generated; run `bun run generate` in `packages/client` after HttpApi changes; never edit `src/generated` by hand), `packages/sdk-next` (composes Client+Core+Server).

### 2.12 Dev & verification workflows (from repo AGENTS.md — binding)
- Local web iteration TODAY: backend `bun run --conditions=browser ./src/index.ts serve --port 4096` (from `packages/opencode`); app dev server `bun dev -- --port 4444` (from `packages/app`) → opens at `http://localhost:4444` targeting `localhost:4096`. (`opencode dev web` proxies prod — do not use for local UI work.)
- Desktop debugging: `bun run dev` from `packages/desktop`. NEVER restart the app/server process while debugging (app AGENTS.md).
- Tests: `bun test` from package dirs only (root guard). Typecheck: `bun typecheck` per package (tsgo), never raw `tsc`.
- i18n: **mandatory** — every user-visible string gets an i18n key; `en.ts` is designer-written source copy, byte-for-byte stable; ~70 locale files in `packages/app/src/i18n/`; `ui` and `session-ui` have their own i18n modules. Never hardcode English; never change existing English strings/keys.
- Dependency direction (binding): Schema → Core/Protocol → Server; Client may depend on Schema+Protocol only; `sdk-next` composes Client/Core/Server; app currently depends on client+core+schema+sdk+session-ui+ui.
- Effect v4 style (if any server-side addition is proposed): bind services to named variables, no nested service yields, prefer `Schema.UnknownFromJsonString`/`decodeUnknownOption` over manual JSON.parse.
- Commits (only if ever asked): conventional `type(scope): summary`, branch ≤3 hyphen-separated words, default branch `dev`.

---

## 3. Already-decided constraints (treat as axioms; cite this section)

1. **Ideation only.** Markdown in `docs/pwa-mobile/`. Zero production code edits.
2. **V1 API only** for all data-flow design.
3. **One source of truth with desktop is a hard goal.** Prefer "share/extraction" over "port/copy" wherever the dependency rules allow; when copying is unavoidable, say why sharing was rejected.
4. **Exclusions are absolute:** no file explorer, no browser pane designs (a one-line scope-matrix mention is fine).
5. **Aesthetic:** shadcn-zinc on top of the EXISTING `@opencode-ai/ui` token system (extend it, don't fork it), New York dense spacing, iOS-PWA-native interaction feel.
6. **i18n plan required** in every UX-facing doc (name the keys you'd add, e.g. `pwa.tab.sessions`).
7. **Premium bar:** every flow spec'd to production quality — loading/empty/error/streaming/offline states included.

## 4. Seeded open questions (owners may add; answer or explicitly defer)

- Does `opencode serve` already host static assets (see `public.ts`, `tui.ts`)? → api-data
- SSE vs WebSocket for live sync on mobile battery budgets; reconnect/backfill semantics (`event.ts`, `sync.ts`, `websocket-tracker.ts`)? → api-data
- Auth model for LAN access from a phone (basic auth? pairing QR/token?)? → api-data (+ux for pairing UX)
- Reuse `"web"` PlatformName vs add `"pwa"`; which `Platform` optionals must a PWA implement? → reuse-strategist
- Can `AppInterface` render mobile-grade chrome without forking pages, or do we extract shared route components? → reuse-strategist + ux-architect jointly
- Existing responsive breakpoints/media queries in app CSS? → ux-architect (quick grep; report finding)
- Keyboard (`visualViewport`) + safe-area handling strategy; `100dvh` pitfalls? → pwa-platform
- iOS push notifications (16.4+) vs in-app-only notifications for PWA? → pwa-platform
- Service-worker caching boundary vs SSE/Query invalidation? → pwa-platform + api-data jointly

## 5. Division of labor (do not write into a peer's doc; reference theirs instead)

| Doc | Owner | Owns |
|---|---|---|
| `00-handoff.md` | coordinator | this file (done) |
| `01-ux-architecture.md` | ux-architect | IA, navigation model, screen inventory, scope matrix, gestures, states, routing map |
| `02-design-system.md` | design-system | tokens/zinc mapping, density scale, typography, touch targets, motion, component disposition (reuse/adapt/new) |
| `03-source-of-truth.md` | reuse-strategist | THE architecture decision: new package vs platform variant vs extraction; Platform interface deltas; bundle strategy; migration plan |
| `04-api-and-data.md` | api-data | V1 endpoint inventory for scoped features, auth, serving strategy, realtime sync, offline/query patterns |
| `05-chat-and-tools.md` | chat-tool-ux | timeline/tool UX on mobile, diffs, permissions UX, composer+@mention UX, context-pane-as-mobile-pattern |
| `06-pwa-platform.md` | pwa-platform | manifest/SW/safe areas/keyboard/iOS quirks/push/perf budgets/dev+test workflow |
| `07-synthesis.md` + `00-overview.md` top matter | coordinator | written AFTER members deliver |

**Dependency etiquette:** 01 and 03 are upstream-ish; 05 consumes 01's nav model and 02's component dispositions — where you depend on a peer's undecided point, write `[DEPENDS: 03 §x]` and proceed with a stated assumption. Never silently duplicate a peer's decision.

## 6. Verification ledger

Verified by coordinator (✅ above): desktop thin-shell pattern; AppInterface providers/routes; full `context/`, `components/` (app), `components/` (ui), `components/` (session-ui) listings; Platform interface head; @mention module set; palette files; httpapi handler inventory; package.json dependency stacks (app/session-ui/ui/web); dev workflows; AGENTS.md rules (root, app, desktop, session-ui, ui, httpapi-noted).
Verified by members since: browser pane = `pages/session/v2/browser-panel-v2.tsx` (+`v2/browser/*`) [ux-architect]; app is desktop-first responsive-wise (only ~640px breakpoints) BUT a `display-mode: standalone` dvh fix already exists at `packages/app/src/index.css:20–25` [ux-architect]; ui theme themes are auto-discovered via `import.meta.glob` (`packages/ui/src/theme/context.tsx:26–38`) so a new `themes/zinc.json` needs zero registration code [design-system]; LATENT BUG: `--surface-disabled` is referenced by button/checkbox/switch CSS but defined nowhere — any new theme must define it; upstream fix recommended [design-system]; `opencode serve` ALREADY hosts static UI same-origin (catch-all uiRoute → embedded bundle map, SPA fallback: `server.ts:207–216`, `shared/ui.ts:44–76`; CORS allowlist `cors.ts:11–20`) [api-data]; realtime is SSE-only via `/event`, no Last-Event-ID resume ⇒ reconnect = refetch-on-`server.connected` + keyset cursor; `/sync/history` is workspace replication, not client backfill [api-data]; auth today = optional Basic (`OPENCODE_SERVER_PASSWORD`) + `?auth_token=` consumed and URL-stripped by entry.tsx [api-data]; context pane is CLIENT-computed (tokens ÷ model limit, `session-context-metrics.ts:29–67`) — no endpoint needed [api-data]; @mention backing search = `GET /find/search` server-side but MISSING from vendored client (app falls back to legacy `/find/file`, `context/file.tsx:318–330`) ⇒ regenerate client via `bun run generate` in packages/client to unlock it [api-data]; repo is ~80% PWA-ready: `index.html` already ships the full PWA head (`viewport-fit=cover` :7, manifest link :14, apple-touch-icon :13, `black-translucent` :16–18, h-dvh root :25), a web `Platform` impl exists (`entry.tsx:123–136`), manifest assets are served auth-exempt (`public-ui.ts:4–8`), and NO service worker exists anywhere yet [pwa-platform]; prompt drafts are ALREADY IndexedDB content-addressed with GC (`draft-store.ts:97–154`) [pwa-platform]; notifications pipeline through `Platform.notify` gated by settings (`notification.tsx:343–429`) so PWA push needs only a notify-impl per shell, not feature changes [pwa-platform]; Inter font ships as variable TTF (`app/src/index.css:13–18`) — woff2 conversion flagged as cheapest perf win [pwa-platform]; ARCHITECTURE DECISION (03): **Option A′ — third shell inside packages/app**: `PlatformName` gains `"pwa"`, new `entry-pwa.tsx` + `pwa.html` beside the existing web entry, SAME `AppInterface`, browser-history routing, mobile chrome = third layout variant (`pages/layout-mobile.tsx`) following the legacy/new dual-layout precedent; rejected separate-package (state layer unexported ⇒ port-or-depend anyway) and new-shared-module (extraction already happened at package granularity); targeted extractions queued in-package as F1–F3 [reuse-strategist]; PERF BUG FOUND: `ProjectExplorerPanel` is statically imported (`pages/session.tsx:31`), pulling codemirror+shiki into the session chunk on ALL surfaces today — lazy-boundary it in phase 0 (desktop win too) [reuse-strategist]; router = zero new routes + settings-as-sheet (no `/settings` route exists); mobile updater stays OMITTED — SW update flow ends in `Platform.refresh()`=reload [reuse-strategist]; chat spec: turn-level virtualization (SessionTurn = virtual row via @tanstack/solid-virtual), tool rows expand inline exactly as desktop + [NEW] Maximize chevron → full-height sheet, diffs unified <640px (split selectable, never wrap), `SessionReview` is the ONLY file-inspection surface (explorer replaced, not emulated), permissions = approval sheet w/ hold-to-confirm bound to V1 reply shape [chat-tool-ux]; OPEN ITEM: pending-question ask-surface component unlocated (timeline hides pending questions, `message-part.tsx:801`) — must be located before any mobile ask-sheet build [chat-tool-ux].
NOT yet verified: nothing remains from the original list — all ⚠️ items above were closed by members (see citations). Residual unknowns live in each doc's own open-questions section (e.g. prompt-while-running semantics, untraced per api-data §7).

— end of handoff —
