# 06 — PWA / iOS Technical Foundation

- **Owner:** pwa-platform · **Phase:** IDEATION ONLY (no production code changes)
- **Reads first:** `00-handoff.md` (§2.12 dev workflows, §3 constraints, §4 seeded questions)
- **Citation rule:** every repo claim carries `path:line`; web-platform claims are marked `[WEB]` with iOS version sensitivity where relevant.
- **Cross-doc dependencies:** `[DEPENDS: 03]` source-of-truth/Platform deltas · `[DEPENDS: 04]` endpoints/auth/serving/SSE semantics · `[DEPENDS: 01]` nav geometry · `[DEPENDS: 02]` tokens/fonts · `[DEPENDS: 05]` composer consumption of the keyboard contract.

---

## 0. Executive summary

The repo is already ~80% PWA-ready on the meta side and the entire app-side seam exists:

1. `../../../packages/app/index.html` already ships the PWA-critical head: `viewport-fit=cover` + `interactive-widget=resizes-content` (`index.html:7`), `apple-touch-icon` (`index.html:13`), a manifest link to `/site.webmanifest` (`index.html:14`), `theme-color` (`index.html:15`), `apple-mobile-web-app-capable` + `black-translucent` status bar (`index.html:16-18`), an `overscroll-none overflow-hidden` body (`index.html:23`) and a `h-dvh` root (`index.html:25`).
2. A **web Platform implementation already exists** — `packages/app/src/entry.tsx:123-136` builds `platform: "web"` with Web-Notification `notify` (`entry.tsx:58-81`), reload-based `refresh`/`restart` (`entry.tsx:90-96`), and IndexedDB-backed drafts via `createBrowserDraftStore()` (`entry.tsx:125`, `draft-store.ts:97-154`). The PWA shell is an *extension* of this entry, not a new architecture. `[RESOLVED: 03]` — PlatformName gains `"pwa"` as a third shell inside packages/app (`entry-pwa.tsx` + `pwa.html`).
3. The backend already serves manifest assets as **auth-exempt public paths** — `/site.webmanifest`, `/web-app-manifest-192x192.png`, `/web-app-manifest-512x512.png` (`packages/opencode/src/server/shared/public-ui.ts:4-8`, tested at `packages/opencode/test/server/httpapi-ui.test.ts:431`). Serving strategy itself is `[DEPENDS: 04]`.
4. What's missing is exactly this doc's scope: a service worker (none exists today — `navigator.serviceWorker` has zero matches repo-wide), keyboard-inset contract, storage-durability policy, push capability matrix, perf budgets, and an iOS-specific dev/test workflow.

**Decisions published to the hive** (peers may consume): SW caching boundary (§3) and the composer keyboard contract (§2.4).

---

## 1. Manifest & meta

### 1.1 Current state (verified)

| Item | Status | Evidence |
|---|---|---|
| Viewport meta w/ `viewport-fit=cover` + `interactive-widget=resizes-content` | ✅ present | `packages/app/index.html:7` |
| Manifest link → `/site.webmanifest` | ✅ linked | `index.html:14`; served auth-exempt per `public-ui.ts:4-8` |
| Icons 192/512 (manifest-referenced) | ✅ exist server-side | `public-ui.ts:6-7`; asserted by `httpapi-ui.test.ts:431` |
| apple-touch-icon 180×180 | ✅ present | `index.html:13` |
| `theme-color` #fafafa | ✅ present | `index.html:15` |
| `apple-mobile-web-app-capable=yes`, status-bar `black-translucent` | ✅ present | `index.html:16-18` |
| Title "OpenCode" | ✅ present | `index.html:9` |
| Theme-flash prevention script | ✅ inlined at build | `index.html:21` + `vite.js:39-45` (`transformIndexHtml`) |
| ⚠️ Maskable icon (`purpose: "maskable"`) | **unverified** — current 512 icon's safe-zone compliance unknown | needs asset audit |

### 1.2 Target manifest fields (proposal)

Extend the existing `/site.webmanifest` rather than adding a second manifest:

```jsonc
{
  "name": "OpenCode",
  "short_name": "OpenCode",            // home-screen label; matches index.html:9 title
  "display": "standalone",
  "start_url": "/",                     // root; session deep-links restore via router
  "background_color": "#fafafa",        // match --v2-background-bg-deep fallback, index.html:2
  "theme_color": "#fafafa",             // match index.html:15
  "icons": [
    { "src": "/web-app-manifest-192x192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/web-app-manifest-512x512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/maskable-512x512.png", "sizes": "512x512", "type": "image/png",
      "purpose": "maskable" }          // NEW: icon with ≥10% safe-zone padding
  ]
}
```

Notes:
- **iOS ignores most manifest fields** `[WEB, version-sensitive]`: home-screen name comes from `<title>`/`apple-mobile-web-app-title`, icon from `apple-touch-icon` (`index.html:13`). Manifest `display`/icons matter for Android/desktop install and future-proofing. Keep both channels consistent.
- **Status bar:** keep `black-translucent` (`index.html:18`) so content extends under the status bar; this makes `env(safe-area-inset-top)` padding mandatory on every fixed header (§2.3). This pairs with `viewport-fit=cover` (`index.html:7`).
- **Auth-exempt serving is load-bearing:** because `public-ui.ts:10-11` whitelists only GETs of those three paths, a password-protected server still renders/installable icons pre-auth. Any *new* assets added to the manifest (e.g. maskable icon) must be added to `PUBLIC_UI_PATHS` or they will 401 under password auth — flag for `[DEPENDS: 04]`.
- Dark mode: consider a second `theme-color` via `media="(prefers-color-scheme: dark)"` once design-system confirms dark token values `[DEPENDS: 02]`. iOS Safari honors media-scoped theme-color for the tab bar tint `[WEB, version-sensitive: iOS 15+]`.

### 1.3 Splash strategy on iOS — honest limitation

iOS does **not** support manifest `splash screens` and offers no native splash customization beyond: solid background derived from page background + centered `apple-touch-icon` `[WEB, version-sensitive: behavior stable since ~iOS 11.3]`. Therefore:

**Pre-render paint plan (zero-JS first paint):**
1. Keep the existing inline theme-preload script (`index.html:21`, injected inline by `vite.js:39-45`) — it sets background before CSS loads, preventing white flash. Desktop does the same trick natively (`desktop/src/renderer/index.tsx:353-360` syncs computed background to the window).
2. Put a static skeleton **inside `#root`** in `index.html` (inline SVG logo mark + dimmed bars matching New York dense spacing `[DEPENDS: 02]`). Solid's `render(...)` into `#root` (`entry.tsx:169-183`) replaces children wholesale on mount, so the static markup costs nothing after hydration. This mirrors desktop's `LoadingSplash` (`desktop/src/renderer/index.tsx:315-321`) but without waiting for JS.
3. Boot sequence stays sequential-but-fast: `loadInitialLocale()` → render (`entry.tsx:157-185`). Do not add blocking work (SW registration, push init) before first paint — see §6 budgets.

---

## 2. Viewport, safe areas & keyboard

### 2.1 Unit policy: `dvh` vs `svh`/`lvh`

- The app frame is already `h-dvh` (`index.html:25`). Keep `100dvh` as the app-frame unit; it tracks the collapsing Safari URL bar so the frame fills the visible viewport during scroll `[WEB, dvh/svh/lvh: Safari 15.4+]`.
- **Critical iOS gotcha:** `dvh` tracks the *URL bar*, **not the keyboard**. When the software keyboard opens, `100dvh` does NOT shrink on iOS — only `visualViewport` shrinks. Any layout that expects `dvh` to react to the keyboard will be wrong. This is why §2.4 exists.
- Use `svh` only for full-bleed overlays that should never be taller than the smallest viewport (e.g., the offline sheet); avoid `lvh` except for deliberate under-keyboard backdrops.
- **Standalone-mode override already exists (verified):** `@media (display-mode: standalone) { #root { height: 100vh } }` — `packages/app/src/index.css:20-25`, comment: "WebKit excludes safe-area insets from dvh in installed apps." Keep this rule under mobile chrome; it also proves the `display-mode: standalone` media query matches reliably in our target environment (reused for install detection, §8.2).

### 2.2 `interactive-widget` behavior

`interactive-widget=resizes-content` is already set (`index.html:7`). `[WEB]` This key is **Chromium-only** (Android Chrome resizes the layout viewport when the keyboard opens); **Safari ignores it**. Consequence: on Android the DOM layout itself shrinks (composer rides up "for free"), while on iOS nothing in normal layout moves. The KeyboardInset store (§2.4) is therefore required for iOS and harmless on Android (it reports near-zero insets there). One code path, two platform behaviors absorbed in one place.

### 2.3 Safe-area usage map

With `viewport-fit=cover` (`index.html:7`) + `black-translucent` (`index.html:18`), content renders edge-to-edge under system chrome. Padding contract (geometry values owned by `[DEPENDS: 01]`):

| Surface | Inset usage |
|---|---|
| Header / top bar | `padding-top: env(safe-area-inset-top)` |
| Tab bar (bottom nav) | `padding-bottom: env(safe-area-inset-bottom)` |
| Sheets / drawers (`@corvu/drawer`, handoff §2.3) | bottom inset on the sheet footer; respect grab-handle area |
| Composer (keyboard closed) | `padding-bottom: env(safe-area-inset-bottom)` |
| Composer (keyboard open) | switch to KeyboardInset anchor (§2.4); home-indicator inset is covered by the keyboard |
| Landscape notches | `env(safe-area-inset-left/right)` on horizontal page padding |

Rule: **one element per edge owns its inset** — parents don't add inset padding AND children don't repeat it (double-padding is the classic cover-mode bug).

### 2.4 KeyboardInset contract (consumed by chat-tool-ux) — DECISION

Single source of truth for keyboard state; **no other component may read `visualViewport` directly**.

```
KeyboardInset store (new, app-level context):
  {
    keyboardHeight: number      // px, >= 0; layoutViewport.height - visualViewport.height clamped
    viewportBottom: number      // px from layout-viewport top to visual-viewport bottom
                                //   = visualViewport.offsetTop + visualViewport.height
    keyboardOpen: boolean       // keyboardHeight > threshold (~60px, filters toolbar flicker)
  }
Feed:
  visualViewport 'resize' + 'scroll' events, rAF-throttled (coalesce; iOS fires both per keystroke)
  baseline = window.innerHeight captured at focus-time (layout viewport is stable on iOS)
Consumers:
  - Composer: while keyboardOpen, position bottom edge at viewportBottom
    (transform: translateY, never re-flow height); when closed, fall back to
    env(safe-area-inset-bottom) (§2.3).
  - On input focus: scroll focused element so caret sits above viewportBottom
    (scrollIntoView against the timeline scroller, not window).
  - Sheets/popovers/dialogs: clamp max-height to viewportBottom; center within visual viewport.
    (02 §5.1: the upstream bottom-sheet primitive ships this clamp as part of its own contract,
    so the constraint travels with the component.)
```

Rationale documented for peers: iOS keyboard overlays the layout viewport; `dvh` doesn't move (§2.1); Android resizes layout (§2.2) so the same store reads ~0 there. `[WEB, visualViewport: Safari 13+]`.

### 2.5 Scroll & touch hygiene (mostly already in place)

- `overscroll-none` on body (`index.html:23`) kills pull-to-refresh/rubber-band chaining `[WEB, overscroll-behavior: Safari 16+; older iOS ignores it — acceptable degradation]`.
- `-webkit-tap-highlight-color: transparent` globally; press feedback comes from component states instead (design-system owns press styling `[DEPENDS: 02]`).
- `touch-action: manipulation` on interactive elements to suppress double-tap-zoom conflicts inside the timeline and tool cards.
- **Haptics: unavailable on iOS** — `navigator.vibrate` is not exposed by iOS Safari at all `[WEB, true through iOS 17.x — recheck minors]`; press feedback must be visual/audio only. The `Platform.haptics?` sketch in `[03]` stays optional + capability-detected (Android Chrome yes, iOS no) and no design may depend on it.
- Momentum scrolling is default `[WEB, iOS 13+]`; do **not** reintroduce `-webkit-overflow-scrolling` hacks.
- **`position:fixed` pitfalls in standalone mode** `[WEB, version-sensitive]`: fixed elements can visually detach/lag during momentum scrolling, and jump when the keyboard toggles. Policy: fixed chrome limited to header/tab-bar/composer shells; anything inside the timeline uses `position: sticky` within the scroll container. Never animate `top/bottom` on fixed elements — use `transform` (compositor-only).

---

## 3. Service worker strategy — DECISION (published to hive)

No service worker exists today (zero `navigator.serviceWorker` references repo-wide). Greenfield.

### 3.1 Caching boundary

| Class | Strategy | Rationale |
|---|---|---|
| Hashed build assets (`/assets/*.{js,css}`, fonts, icons) | **Precache at install**, keyed by build revision | Content-hashed by Vite → immutable; cache-first is always correct |
| `index.html` (+ inlined preload script) | Precache; **network-first on navigation** with cache fallback | Navigation must pick up new deployments promptly |
| `site.webmanifest`, icons | Precache (auth-exempt paths, `public-ui.ts:4-8`) | Needed for install UX even pre-auth |
| **ALL API routes** (every V1 endpoint, `[DEPENDS: 04]` inventory) | **Network-only passthrough — never cached, never fulfilled from cache** | Data freshness is owned exclusively by TanStack Query invalidation + ServerSync; a second cache layer would fight them and serve stale sessions/errors |
| **SSE event stream** (`event.ts` route, handoff §2.11) | Network-only; SW must not intercept/buffer | Long-lived stream; buffering breaks reconnect semantics `[DEPENDS: 04]` |
| Auth/token exchanges | Network-only | Never persist credentials in Cache Storage |

This boundary is the joint answer to handoff §4 ("Service-worker caching boundary vs SSE/Query invalidation") together with api-data: **the SW owns bytes, Query/ServerSync own truth.**

### 3.2 Versioning & update flow (ties into `Platform.refresh`)

```
register('/sw.js', { scope: '/' })
  └─ registration.onupdatefound → new worker installing
       └─ newWorker.state = 'installed' (and navigator.serviceWorker.controller exists)
            → emit update-available → in-app refresh prompt (i18n keys §8.3)
                 ├─ accept  → newWorker.postMessage('SKIP_WAITING')
                 │            → 'controllerchange' fires → Platform.refresh()
                 └─ dismiss → apply on next natural reload
```

- `Platform.refresh()` is already defined and web-implemented as `window.location.reload()` (`platform.tsx:52`; `entry.tsx:90-92`) — the exact hook the update prompt calls. Desktop's analog is its updater trio `{state, check, install}` (`platform.tsx:82`; `desktop/src/renderer/index.tsx:222-226`); per `[RESOLVED: 03]`, mobile **omits `updater?`** — the SW update prompt lives in the PWA shell (`entry-pwa.tsx`) and terminates in `Platform.refresh()`, mirroring desktop's reload semantics without adopting the native-updater interface.
- Waiting-worker UX avoids the classic trap of `skipWaiting()` unconditionally, which mid-session swaps assets under a running app and breaks lazy-chunk imports.
- Old caches are deleted in `activate` (workers kill obsolete revisions); precache manifest is generated at build time from the Vite bundle (ideation: small build plugin alongside `vite.js:18-36`).

### 3.3 Offline scope

Offline = **shell + explicit offline state**, not offline data:
- Cached shell boots; API calls fail fast → app renders its existing error/empty states (premium bar requires designed offline states, handoff constraint 7).
- Drafts remain readable/writable offline (IndexedDB, §4) — composing continues offline; submit path is the client outbox flushing `prompt_async` per `[DEPENDS: 04]` §5 mobile contracts (permissions approve/deny are live-only with an offline gate — never cached, matching §3.1).
- No offline reads of sessions/timeline. Backfill-on-reconnect semantics belong to ServerSync `[DEPENDS: 04]`.

### 3.4 Cache storage limits

`[WEB, version-sensitive]` iOS enforces origin quotas nondeterministically and may evict Cache Storage + IndexedDB under pressure (no published hard number; historically tight vs desktop Chrome). Mitigations: keep precache lean (budget §6.1: ≤ ~2.5 MB shell), cap runtime additions (only fonts/icons enter cache), prune old revisions on activate, and treat any cache write failure as non-fatal (try/catch around `cache.addAll`, degrade to network-only).

---

## 4. Storage durability (ITP & eviction)

### 4.1 Threat model

`[WEB, version-sensitive]` Safari's ITP caps **script-writable storage (localStorage AND IndexedDB) at 7 days of no user interaction** for regular Safari tabs. Home-screen-installed PWAs are treated as apps and are exempt from the 7-day cap, but ALL web storage remains subject to quota-pressure eviction. Net policy: nothing critical may assume permanence; everything critical must be recoverable.

### 4.2 What lives where today (verified)

| Data | Store | Evidence | Durability verdict |
|---|---|---|---|
| Prompt drafts + attachment blobs | **IndexedDB** `opencode-drafts` (`documents` + `blobs` stores), content-addressed blobs (SHA-256), orphan-GC on open | `draft-store.ts:97-154`, blob GC `:107-121`, hashing `:24-29`; wired as `Platform.draftStore` (`entry.tsx:125`, interface `platform.tsx:76`) | ✅ correct store already; survives tab storage culling when installed; needs re-creation UX if evicted |
| Settings / persisted app state | localStorage names `opencode.global.dat`, `opencode.window`, legacy `default.dat` via `Persist` | `persist.ts:27-30`; `Platform.storage` defaults to localStorage (`platform.tsx:72-73`) | ⚠️ low-value data; loss = annoyance only. Acceptable in localStorage; optionally migrate high-value prefs to IDB later |
| Notification history | persisted store, capped 500 entries / 30-day TTL | `notification.tsx:60-68`, persistence `:240-245` | low-value; fine |
| Default server URL | localStorage `opencode.settings.dat:defaultServerUrl` | `entry.tsx:15,110-114` | re-pairing flow covers loss ([DEPENDS: 04]) |

### 4.3 Mitigations (design)

1. **Drafts stay in IndexedDB** (already true — no change needed; cite as precedent for any new durable data).
2. **Eviction detection:** on boot, if settings keys are absent but an `opencode.drafts.seen` marker existed, show a one-time "preferences were reset" notice (i18n §8.3) rather than silently degrading.
3. **Re-auth over re-data:** credentials are never stored client-side beyond what `[DEPENDS: 04]`'s pairing model dictates; storage loss degrades to the pairing/connect screen, which must be one tap from cold-start (§8.1).
4. **Never block boot on storage:** all `Persist` reads are async-ready (`persist.ts:10-15` returns ready-gated stores); boot proceeds with defaults on storage failure.

---

## 5. Notifications — capability matrix & graceful degradation

### 5.1 Matrix `[WEB, version-sensitive — verify on target iOS minors]`

| Surface | Foreground in-app toast/badge | System notification (app unfocused) | Background push (app closed) |
|---|---|---|---|
| Desktop (Electron) | ✅ toasts | ✅ `Notification` API, unfocused-only (`desktop/src/renderer/index.tsx:243-257`) | n/a (sidecar local) |
| Browser tab, iOS Safari | ✅ | ❌ Notification API effectively unavailable in-tab on iOS | ❌ |
| **PWA installed to Home Screen, iOS/iPadOS 16.4+** | ✅ | ✅ via SW `showNotification` | ✅ Web Push (Push API + VAPID), **requires installed + granted permission** |
| PWA installed, iOS < 16.4 | ✅ | ❌ | ❌ |
| Android/desktop Chrome PWA | ✅ | ✅ | ✅ (standard Web Push) |

### 5.2 Existing pipeline is capability-agnostic (verified)

The notification domain logic already routes through `Platform.notify(title, description?, onClick?)` (`platform.tsx:58`), triggered by SSE `session.idle` / `session.error` events with settings gates `settings.notifications.agent()` / `.errors()` (`notification.tsx:343-369`, `:371-416`, subscription `:418-429`). **No feature code changes for PWA** — only the `notify` implementation differs per shell:

- Today's web impl requests permission lazily and skips when the tab is focused (`entry.tsx:58-81`) — correct pattern, keep it.
- PWA impl adds: if installed + `PushManager` available → subscribe (VAPID; endpoint registration is `[DEPENDS: 04]` server work) and show via SW `showNotification`; else fall back to exactly today's in-page `Notification` path; else in-app toasts only.
- Click-to-context parity: desktop focuses the window then navigates (`desktop/src/renderer/index.tsx:251-256`); PWA notification `onclick` → `clients.openWindow`/`focus` + navigate to the same `/{dir}/session/{id}` href shape used at `notification.tsx:362`.

### 5.3 Graceful degradation ladder

1. Installed + 16.4+ + permission granted → full push.
2. Installed + permission denied/unavailable → in-app notifications only (already rich: unseen badges, sounds via `playSoundById`, error toasts — `notification.tsx:350-352`, `:407-414`).
3. Not installed (browser tab) → in-app only; settings copy explains "Add to Home Screen to get notified when runs finish" (i18n §8.3).
4. Settings surfaces stay identical across tiers — gating logic already lives in settings (`notification.tsx:363`, `:402`).

Honest limits: no badge API on iOS (`navigator.setAppBadge` unsupported `[WEB, as of iOS 17.x — recheck]`); background processing beyond push display is unavailable (no Background Sync on iOS) — reconnect/backfill is visibility-change driven `[DEPENDS: 04]`.

---

## 6. Performance budgets

Targets are proposals for a mid-tier iPhone (A14/A15 class, iPhone 12/13) over LAN Wi-Fi to the local server. Measure, don't trust: baselines via Playwright performance run (the harness already separates `performance/**` from functional e2e, `playwright.config.ts:12`).

### 6.1 Budgets

| Metric | Budget | Notes |
|---|---|---|
| First paint (shell, warm) | < 0.5 s | static skeleton in HTML (§1.3) paints with zero JS |
| LCP (cold, LAN) | < 2.5 s | |
| TTI / interactive | < 3.0 s cold, < 1.5 s warm-SW | |
| INP (tap→paint) | < 200 ms p75 | guard heavy handlers behind rAF/worker |
| Initial JS (home route) | ≤ 300 KB gzip total | app entry + shared chunks |
| Per-route lazy chunk | ≤ 150 KB gzip | enforced at review; route-level splitting already exists (`app.tsx:75-76` lazy pages, handoff §2.3) |
| SW precache total | ≤ 2.5 MB | §3.4 eviction pressure |

### 6.2 Leverage that already exists (do not rebuild)

- **Route-level code splitting**: lazy pages at `app.tsx:75-76` (handoff §2.3) — mobile nav must stay within this pattern; no eager imports of session UI from home. ⚠️ Known chunk-bloat fix queued as `[03]` phase 0: `ProjectExplorerPanel` is statically imported (`session.tsx:31`), pulling codemirror+shiki into the session chunk on all surfaces today — that lazy boundary directly serves this doc's ≤150 KB/route budget.
- **Markdown/shiki offloading already exists**: `markdown.worker.ts` + `markdown-worker{-transport,-queue,-protocol}.ts` + `markdown-stream.ts` + `markdown-cache.tsx` in `../../../packages/session-ui/src/components` (all verified present). Streaming highlight runs off-main-thread — the mobile timeline MUST consume this path, never import shiki onto the main thread. ES-format workers are configured (`worker.format: "es"`, `vite.js:31-33`).
- **Virtualization**: `@tanstack/solid-virtual` is already an app dependency (handoff §2.3 package.json citation) — long timelines render virtualized.
- **Fonts/images**: app CSS self-hosts two faces today — JetBrainsMono Nerd Font Mono as woff2 and **Inter as a variable TTF** (`packages/app/src/index.css:6-18`). Policy: `font-display: swap`, preload only primary weights, lazy-decode images in `file-media.tsx` paths. ⚠️ Budget flag: the Inter `.ttf` variable file is likely the largest single non-JS shell asset — converting/subsetting to woff2 is the cheapest precache-size win available; coordinate with design-system `[DEPENDS: 02]`.
- Sentry is wired for web with release tagging (`entry.tsx:138-155`; build plugin `vite.config.ts:5-20`) — reuse for mobile field perf/error monitoring rather than adding tooling.

---

## 7. Dev / debug workflow

### 7.1 Baseline loop (binding, from AGENTS.md via handoff §2.12)

- Backend: `bun run --conditions=browser ./src/index.ts serve --port 4096` (from `../../../packages/opencode`)
- App dev server: `bun dev -- --port 4444` (from `../../../packages/app`) → `http://localhost:4444` targets `localhost:4096`
- `opencode dev web` proxies prod — never for local UI work.
- Never restart app/server processes while debugging (app AGENTS.md).

### 7.2 Phone-on-LAN testing (works today, with two caveats)

The dev server already binds `0.0.0.0` with `allowedHosts: true` (`vite.config.ts:24-28`), so a phone on the same Wi-Fi can load `http://<dev-machine-LAN-IP>:4444`. Caveats:

1. **API base resolution:** in DEV the app targets `VITE_OPENCODE_SERVER_HOST:PORT` (`entry.tsx:103-108`), defaulting to localhost — set `VITE_OPENCODE_SERVER_HOST=<LAN-IP>` when serving to a phone (the env plumbing already exists; Playwright uses the same vars, `playwright.config.ts:5-6,29-30`).
2. **Service workers won't register over plain-HTTP LAN origins** (secure-context requirement; localhost is exempt, LAN IPs are not) `[WEB]`. Options, in preference order:
   - HTTPS on the dev server via `server.https` + mkcert CA trusted on the phone (additive vite config change, ideation) — doubly motivated now: SW secure context AND protecting Basic-auth credentials on LAN (`[DEPENDS: 04]` §4 flags plaintext-Basic risk);
   - SSH reverse tunnel exposing the dev server as phone-localhost;
   - validate SW logic in desktop Chromium emulation, and treat real-device SW checks as part of the manual smoke checklist (§7.4).

### 7.3 iOS remote inspection

Safari → Develop → [device] → page (requires cable + Settings ▸ Safari ▸ Advanced ▸ Web Inspector). Inspect: `visualViewport` live values (validates §2.4 contract), safe-area insets, SW state, Cache Storage, push permission. Xcode's Simulator (macOS) covers safe-area/keyboard matrix without hardware.

### 7.4 WebKit gotcha checklist (run on device per release)

1. Keyboard opens/closes over composer → caret stays visible (§2.4).
2. Sheet + keyboard: sheet clamps to visual viewport, no clipped footer.
3. Rotate portrait↔landscape: insets recompute, no double-padding.
4. Background app mid-stream → return resumes SSE + timeline `[DEPENDS: 04]`.
5. Update prompt appears after redeploy; accept applies cleanly (no lazy-chunk crash).
6. Offline cold start → shell + offline state, drafts editable.
7. A2HS: icon/name correct; launch shows pre-render paint (§1.3), no white flash.
8. Push (16.4+, installed): grant → background turn-complete arrives; tap deep-links to session.
9. Long-list momentum scroll: sticky headers don't detach (§2.5); virtualized timeline (`@tanstack/solid-virtual` turn rows per `[05]`) edge-bounces cleanly — row measurement must not jump during rubber-band overscroll `[05 Q2: flagged for device validation here]`.
10. Double-tap on tool cards doesn't zoom; tap highlights suppressed.

### 7.5 Playwright mapping (existing infra)

Current config is Chromium-desktop-only (`playwright.config.ts:39-44`) with CI-aware workers/retries/reuse (`:8-9,18-21`) and env-driven server wiring (`:5-6,23-32`). Proposal:

```ts
projects: [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },          // unchanged
  { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },          // layout/UA/touch/DPR
]
```

- WebKit project validates layout, safe-area emulation (`viewport` + `deviceScaleFactor` from the descriptor), touch interactions, and the KeyboardInset math (drive `visualViewport` via page JS — Playwright cannot synthesize a real iOS keyboard `[WEB]`).
- Honest limit: Playwright's WebKit ≠ iOS SW/push runtime; SW behaviors assert in chromium project; final say stays with the §7.4 device checklist.
- All new tests follow `../../../packages/app/e2e/AGENTS.md` hygiene (no wall-clock waits; assert observable outcomes).

### 7.6 CI considerations

Config is already CI-shaped (`forbidOnly`, retries 2, 5 workers, trace-on-retry — `playwright.config.ts:9,14,19-21,35`). Additions: gate `webkit-mobile` on an env flag until flake budget is known; publish Playwright HTML report artifact (output dir already configured, `:22`); keep `performance/**` out of functional lanes (`:12`). Real-device verification remains a manual release checklist — no device farm assumed.

---

## 8. Install / onboarding / update UX

### 8.1 First-run pairing & connect

Auth/pairing mechanics are `[DEPENDS: 04]` (handoff §4 seeds the question). Platform-side requirements this doc commits to:
- Cold start with no reachable server lands on the connect screen with **zero dead ends** (boot already tolerates missing server URL — `entry.tsx:110-114` falls back through stored value → origin).
- Token-in-link bootstrap exists (`?auth_token=` consumed then scrubbed from history — `entry.tsx:159-167`); pairing UX should reuse this handoff (QR → URL containing token) rather than inventing a second channel `[DEPENDS: 04]`.
- Storage-eviction recovery reuses the same connect screen (§4.3).

### 8.2 A2HS education (iOS has no install prompt)

`beforeinstallprompt` never fires on iOS `[WEB]` — install is manual: Share ▸ Add to Home Screen. Design:
- Contextual coach-mark shown **once**, only when: Safari-family in-tab + not standalone + user has a working server connection (value first, ask second).
- Detection: `navigator.standalone === true` OR `matchMedia('(display-mode: standalone)')`; the media query is already proven in-repo by the standalone layout override (`index.css:20-25`) — keep both checks for older-iOS safety `[WEB]`.
- Copy explains the payoff honestly: full-screen, keyboard/push capability (§5), dockable.
- Dismissal persists (settings store); never re-prompt after dismissal.

### 8.3 i18n keys (constraint 6 — designer-written `en.ts` copy TBD)

`pwa.update.available.title` / `pwa.update.available.body` / `pwa.update.available.action`
`pwa.install.coach.title` / `pwa.install.coach.body` / `pwa.install.coach.dismiss`
`pwa.push.enable.title` / `pwa.push.enable.body` / `pwa.push.enable.action`
`pwa.push.unavailable.notice` (browser-tab tier explanation, §5.3)
`pwa.offline.banner.label`
`pwa.storage.reset.notice` (§4.3 eviction notice)

All strings flow through `language.t(...)`; no hardcoded English (app AGENTS.md localization rules).

### 8.4 Update UX

Update-available prompt (§3.2) is a passive banner, not a modal: "Refresh to update". Applied updates confirm with a transient toast (`pwa.update.applied` family) so users learn the reload was an upgrade. Force-update escape hatch (protocol drift vs old shells) is a `[DEPENDS: 04]` decision; the SW revision check gives us the detection primitive either way.

---

## 9. Risk register — top 10 iOS PWA gotchas

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Keyboard doesn't resize `dvh`/layout on iOS; composer floats wrong | High | KeyboardInset store (§2.4); composer anchors to `visualViewport`; test matrix §7.4-1 |
| 2 | SW cannot register on plain-HTTP LAN dev origin | High (dev velocity) | mkcert HTTPS / tunnel / chromium-emulation split (§7.2) |
| 3 | ITP 7-day + pressure eviction wipes settings/state | Medium-High | Durable data in IndexedDB (drafts already are, §4.2); eviction notice; re-auth flow (§4.3) |
| 4 | Push silently absent (<16.4, not installed, denied) | Medium | Capability ladder + settings copy per tier (§5.3); never promise what the tier can't do |
| 5 | No `beforeinstallprompt` → users never discover install | Medium | One-shot contextual coach-mark post-connect (§8.2) |
| 6 | Launch white-flash (no native splash control) | Medium | Inline theme script (exists, §1.3) + static skeleton in `#root` |
| 7 | `position:fixed` lag/jump during momentum + keyboard transitions | Medium | Fixed only for app chrome; sticky inside scrollers; transform-only animation (§2.5) |
| 8 | SSE dies on background; stale timeline on resume | Medium | visibilitychange resync owned by ServerSync `[DEPENDS: 04]`; SW must not buffer SSE (§3.1) |
| 9 | Nondeterministic Cache Storage eviction breaks offline shell | Low-Medium | Lean precache ≤2.5 MB; prune old revisions; graceful network-only degrade (§3.4) |
| 10 | Double-tap zoom / tap-highlight / rubber-band feel un-native | Low | `touch-action`, tap-highlight reset, `overscroll-none` (present, §2.5); older-iOS no-op accepted |

Version-sensitivity disclaimer: items marked `[WEB, version-sensitive]` reflect iOS behavior as of 16.4–17.x knowledge; re-verify each minor release (esp. push, badging, storage caps).

---

## 10. Open questions & dependency recap

- `[RESOLVED: 03]` — PlatformName gains `"pwa"` (third shell inside packages/app: `entry-pwa.tsx` + `pwa.html` beside the web entry); mobile **omits** `updater?` (`platform.tsx:82` stays desktop-only) — SW update flow ends in `Platform.refresh()` (§3.2).
- `[DEPENDS: 04]` — endpoint inventory for the SW network-only denylist; SSE reconnect/backfill; push server (VAPID endpoint registration); auth/pairing channel; whether new public assets join `PUBLIC_UI_PATHS` (`public-ui.ts:4-8`).
- `[DEPENDS: 01]` — tab-bar/header geometry consuming the safe-area map (§2.3).
- `[DEPENDS: 02]` — dark theme-color pair, font preload set, press-state styling replacing tap-highlight.
- `[DEPENDS: 05]` — composer/sheet components consuming KeyboardInset (§2.4); confirm no component reads `visualViewport` directly.
- Unverified here, flagged inline: maskable-icon safe-zone compliance (§1.1); `setAppBadge` support on current iOS minors (§5.3).

*— end of 06 —*
