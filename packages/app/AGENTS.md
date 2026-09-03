## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

**The ONLY sanctioned way to run this app is `bun run dev` from `packages/desktop`.** It runs
`concurrently` with two halves: `desktop` (`scripts/dev-electron.ts` → `electron-vite dev` → Electron,
which spawns the opencode **sidecar** backend) and `pwa` (`bun --cwd ../mobile dev`, Vite on **:3301**).

- The desktop UI you are changing renders **inside Electron**, from the electron-vite renderer dev
  server on **`:5173`**. Loading `:5173` in an ordinary browser does NOT work — it dies with
  `TypeError: api.subscribe is not a function` because the Electron preload bridge is absent.
- `:3301` is the **mobile PWA pairing client**, not the desktop UI. It shows a "Pair this device"
  QR screen. Do not use it to verify desktop UI changes.
- `:3301` proxies the `API_PREFIXES` (see `packages/mobile/vite.config.ts`) to the sidecar, whose URL
  it reads **per request** from the well-known file `packages/mobile/.opencode-dev-url`. The sidecar
  binds an ephemeral port, so this file — not any hardcoded number — is the single source of truth
  for the backend address.
- If `/quota/providers` (or any API prefix) on `:3301` returns **503 `DesktopSidecarUnavailableError`**,
  the Electron half is not running. `.opencode-dev-url` will be missing. Fix that by getting the desktop
  app running — do NOT start a standalone backend to work around it.
- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.

### NEVER do this (this has burned real debugging time)

- **Do NOT start your own backend** with `bun run --conditions=browser ./src/index.ts serve --port 4096`,
  and do NOT start `packages/app`'s Vite standalone (`bun dev -- --port 4444`). Neither is wired to the
  sidecar this app actually uses. This was the previous contents of this section; it was wrong.
- **Many unrelated OpenCode instances run on this machine at all times, and that is expected** — the user
  keeps different versions for different purposes. Examples seen in the wild: WebStorm's bundled ACP agents
  (`~/AppData/Local/JetBrains/WebStorm*/acp-agents/opencode/<version>/opencode.exe acp`, often a dozen of
  them) and `:4096`. **A listening port is not evidence it is our backend.**
- Consequence of getting this wrong: you talk to a *stale, different-version* server, its routes 404 into
  the SPA HTML fallback, and the app dies at boot with
  `Request is not supported by this version of OpenCode Server (Server responded with text/html)`.
  That error means **you are on the wrong backend**, not that a route is missing.

### Inspecting the running desktop UI (CDP)

The only way to inspect the real renderer is Chrome DevTools Protocol:

```sh
# from packages/desktop. `unset` is REQUIRED: this shell inherits
# ELECTRON_RUN_AS_NODE from the host, which makes Electron boot as plain Node and
# die with "The requested module 'electron' does not provide an export named
# 'BrowserWindow'". scripts/dev-electron.ts deletes it for exactly this reason.
unset ELECTRON_RUN_AS_NODE && bunx electron-vite dev --remoteDebuggingPort 9222
```

Then drive `http://127.0.0.1:9222/json/list` → the page whose url contains `5173`, and issue
`Runtime.evaluate` over its `webSocketDebuggerUrl`. The Project Explorer only mounts on a **session**
page, not the home/chats view, so navigate to a session first (`a[data-slot="tab-link"]`, dispatching
`pointerdown`/`mousedown`/`mouseup`/`click` — a bare `.click()` does not navigate) and then use the
`button[aria-label="Toggle project explorer"]`.

### Changing packages/core? You MUST rebuild the sidecar

`electron-vite dev` alone does **not** rebuild the sidecar. The sidecar is a prebuilt bundle produced
by `bun run predev` (`buildLocalCliToResources()` + `build-node.ts`); its own comment reads *"the
hodgepodge means dev sidecar != the exe"*. `bun run dev` runs `predev` automatically via the npm
lifecycle hook, but invoking `electron-vite dev` directly skips it. Edits to `packages/core`
(FileIndex, filesystem, quota, …) will silently have no effect until you run `bun run predev` and
restart Electron. Symptom: your fix is in the source, tests pass, and the running app is unchanged.

### Identify the right process before debugging

Never infer the backend from `netstat` alone. Confirm the command line:

```sh
# our dev runner (expect: concurrently -n desktop,pwa ... packages/desktop)
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'concurrently|electron-vite' } | Select-Object ProcessId,CommandLine | Format-List"

# the authoritative backend URL (missing => sidecar is down)
cat packages/mobile/.opencode-dev-url
```

## API Clients — Which SDK to Use (app is hybrid)

`packages/app` is **mid-migration**: it imports BOTH clients in the same files. Do not pick by habit.

- **Unified SDK** (`@opencode-ai/sdk/v2/client` via `useSDK()` → `sdk().client`): covers `ServerApi` (health/session/message/provider/etc.) **PLUS** `InstanceHttpApi`/`RootHttpApi`/`EventApi` (`experimental/*`, `instance/*`, `control/*`, `workspace/*`, `pty/*`, `quota/*`, `sync/*`). This is the **only** client that has `sdk().client.experimental.openrouterEndpoints` / `.openrouterTelemetry`, `sdk().client.instance`, etc. New UI — `prompt-input-v2`, session v2, file explorer v2, terminal v2, permission/question v2 — uses this.
- **Protocol client** (`@opencode-ai/client/promise` → `OpenCode` / `OpenCodeClient`): covers `ServerApi` only (the `packages/protocol` surface). Still used by legacy shims: `server-session`, `global-sync` bootstraps, some `FileDiffInfo`/`SessionInfo` flows, and tests. It will **never** have `experimental.*` — if `sdk().client.experimental.*` is `undefined` at runtime (`Cannot read properties of undefined (reading 'get')`), you looked at / regenerated the wrong package.

Rules:

- Adding or touching `experimental/*`, `instance/*`, `control/*`, `workspace/*`, `quota/*`, `pte/*`, `sync/*`, `tool/*` under `packages/opencode/src/server/routes/instance/httpapi` → unified SDK. After change, run `bun run build` from `packages/sdk/js` (not `packages/client`), then verify with `rg -n "openrouterTelemetry" packages/sdk/js/src/v2/gen/sdk.gen.ts`.
- Touching `packages/protocol` ( `server/session`, `server/message`, `server/model`, etc.) → run `bun run generate` from `packages/client` **and** `bun run build` from `packages/sdk/js` if the same endpoint is also exposed via the unified `OpenCodeHttpApi`.
- Do not edit `packages/client/src/generated/**` or `packages/sdk/js/src/v2/gen/**` by hand.

See root `AGENTS.md` § Workspace / § API Surfaces for the full decision tree and verification steps. "V2" in a component name (`FileTreeV2`, `ModelSelectorPopoverV2`) is a UI iteration label, not an API version.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Localization

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for visible copy, placeholders, accessible labels, tooltips, menus, dialogs, toasts, empty states, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale complexity behind the shared typed i18n APIs. Feature and component code should use `language.t(...)` for ordinary copy and `language.plural(baseKey, count, params)` for count-sensitive copy. It must not inspect the locale, call `Intl.PluralRules`, construct or select plural-category keys such as `.one` or `.other`, or branch on locale-specific grammar.
- Prefer complete translated phrases. Do not concatenate grammatical fragments or make call sites assemble sentences. Keep placeholders to irreducible dynamic values such as names, paths, and counts.
- If a translation cannot be expressed by the current API, deepen the shared language/UI i18n module so one typed call owns locale selection, plural resolution, fallback, and interpolation. Do not leak that machinery into product code.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- For developer-facing terminology, prefer the words already used by the target language's developer community over literal dictionary translations. Cross-check maintained localized developer products such as Firefox, KDE, and VS Code; use at least two independent corpora when they are available. If established practice keeps an English loanword or acronym, keep it rather than inventing a translation.
- Translate complete UI phrases in context. A glossary hit is evidence, not permission to translate word-by-word. Check terse labels such as session, prompt, agent, model, fork, shell, terminal, workspace, and worktree in the same grammatical role before choosing a term.
- Before a locale is ready, audit recurring concepts for one consistent translation and review every value that still equals English. Classify retained English as a product name, provider/tool name, URL, code token, keyboard legend, acronym, asset name, or established borrowing; translate unexplained leftovers.
- In translation review notes, name the corpora used and call out uncertain or region-specific terminology so native speakers can focus review where it matters.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
