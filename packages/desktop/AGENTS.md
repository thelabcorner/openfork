# Desktop package notes

For the process/product boundary, read `../../docs/map/surfaces.md` and
`../../docs/map/architecture.md` before changing Electron/renderer/sidecar
ownership.

- The desktop app is the product integration surface, but the Electron renderer
  is not the default owner of domain state. For cross-layer features, trace from
  the authoritative server/domain producer through the sidecar/API into the UI
  as required by the root `AGENTS.md`; do not design a backend around whatever
  data happens to be easiest for a renderer component to fetch.
- When a desktop performance issue involves server calls, verify the complete
  Electron -> sidecar -> route middleware -> instance/service path. A fast UI
  call can still trigger a full workspace bootstrap behind the sidecar.
- Desktop-wide closure must exercise the real triggering state (including
  multiple active sessions when relevant). Browser-only or idle-startup evidence
  proves only that narrower scenario.
- Desktop startup, pairing, liveness, mobile-dev, and status probes must use
  bootstrap-free `/global/*` or other Tier 0/1 surfaces. Never probe an
  instance-scoped route without an explicit directory just because it is already
  authenticated and returns a small payload.
- The desktop renderer may define product requirements, but it does not own
  runtime/domain state. If the renderer needs a cross-session scalar, add or use
  the bottom-up server/core projection first, then consume it in the UI.
- A packaged-build, browser-only, or idle-startup profile cannot close a bug that
  appears only in the real Electron chrome/sidebar/sidecar path under several
  working sessions.
- `bun run dev` (from this directory) is the fast, high-signal way to debug the desktop app: it builds and launches the real Electron shell against current source, streams main-process console output (IPC errors, engine logs, uncaught exceptions) directly to the terminal, and hot-reloads renderer changes. Prefer this over reasoning about behavior from source alone, and over testing a packaged/installed build — a packaged build only reflects whatever was true when it was built, so it can make an already-fixed bug look unfixed for no reason related to the fix itself. Main-process changes (anything under `src/main`) require killing and relaunching the process, not just reloading the window.
- Desktop renderer is the same hybrid as `packages/app`: most new UI (prompt v2, session v2, file explorer v2, terminal v2) calls the **unified SDK** (`@opencode-ai/sdk/v2/client` via `useSDK().client`), while some legacy shims still use `@opencode-ai/client/promise`. If `sdk().client.experimental.*` is `undefined` at runtime, you regenerated the wrong package — see root `AGENTS.md` § Workspace / § API Surfaces. The EXE bundles whatever was last generated, so local Vite HMR success ≠ packaged-build success; always grep the generated file after `bun run build` in `packages/sdk/js`.
- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.
- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for native menus, picker titles, dialogs, buttons, accessible labels, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale and grammar logic in the shared typed i18n layer. Renderer code should resolve copy through the app language API, and the main process should consume typed native-translation bundles through `nativeT(...)`; native menus, dialogs, and IPC handlers must not inspect locales, choose plural categories, or assemble translated sentence fragments.
- Prefer complete translated phrases with only irreducible dynamic placeholders. If native UI needs richer grammar, deepen the shared bundle/API instead of adding locale branches to desktop feature code.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- For developer-facing terminology, prefer established usage in the target language's developer community over literal translations. Cross-check maintained Firefox, KDE, and VS Code localizations, using at least two independent corpora when available. Keep established English loanwords and acronyms instead of inventing unfamiliar terms.
- Translate whole native-menu and dialog phrases in context. Audit recurring concepts for consistency and review every exact-English value; retain it only when it is an intentional product/provider/tool name, URL, code token, keyboard legend, acronym, asset name, or established borrowing.
- Record the corpora used and flag uncertain or regional terminology in review notes.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.
