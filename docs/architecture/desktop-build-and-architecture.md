# OpenCode Desktop — Build, Runtime Map (Bun vs Node) & V1/V2 Reality

> Authoritative reference for the patched working tree. Fact-checked against the repo at
> branch `api-keys-tab-menu` (2026-08-13). Every claim below was verified by reading the
> cited source in THIS tree — not assumed from upstream.

---

## 0. The runtime map — what runs on Bun, what runs on Node

This is the single most important mental model for this codebase. The same TypeScript
source runs under **two different JavaScript runtimes**, selected by where it executes.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ BUN RUNTIME (primary dev/CLI/server runtime)                             │
│                                                                          │
│  • `bun run --conditions=browser ./src/index.ts serve --port 4096`      │
│    (the dev backend — what the web app at vite:4444 talks to)            │
│  • `opencode` CLI / `bun run dev` — all packages/opencode CLI commands   │
│  • All tests: `bun test` (bun:sqlite driver, bun condition)              │
│  • `bun run generate` (packages/client) + `bun ./script/build.ts`       │
│    (packages/sdk/js) — the two regen steps                               │
│  • build scripts themselves (prebuild.ts, build.ts, build-node.ts)       │
│                                                                          │
│  Driver selection: package.json conditional exports resolve `bun` branch │
│    #sqlite  → src/database/sqlite.bun.ts  (bun:sqlite Database)          │
│    #pty     → src/pty/pty.bun.ts                                         │
└──────────────────────────────────────────────────────────────────────────┘
                              │
   ┌──────────────────────────┼──────────────────────────────────────────┐
   │                          │                                          │
   ▼                          ▼                                          ▼
┌─────────────────────┐ ┌──────────────────────────┐ ┌─────────────────────────────┐
│ NODE RUNTIME (1)    │ │ NODE RUNTIME (2)          │ │ NODE RUNTIME (3)             │
│ Electron MAIN       │ │ Electron SIDECAR          │ │ Electron RENDERER           │
│ process             │ │ (utilityProcess fork)     │ │ (Chromium, NOT Node)        │
│                     │ │                          │ │                             │
│ BrowserWindow,      │ │ runs `sidecar.js` which   │ │ SolidJS app (packages/app   │
│ BrowserManager,     │ │ imports                   │ │ src via @opencode-ai/app),  │
│ CDP control,        │ │   virtual:opencode-server │ │ talks ONLY to the sidecar   │
│ window.api IPC      │ │   = ../opencode/dist/    │ │ over authenticated HTTP     │
│ (packages/desktop   │ │     node/node.js          │ │ via window.api preload      │
│  src/main)          │ │                          │ │ (contextIsolation, sandbox) │
│                     │ │ THAT bundle is built by   │ │                             │
│                     │ │ Bun BUT targeted at Node: │ │ no Node, no node_modules,   │
│                     │ │   Bun.build({ target:     │ │ no direct server access     │
│                     │ │   "node", entrypoints:    │ │                             │
│                     │ │   ["./src/node.ts"],      │ │                             │
│                     │ │   outdir: "./dist/node" })│ │                             │
│                     │ │                          │ │                             │
│                     │ │ Driver selection: `node`  │ │                             │
│                     │ │ branch of conditional     │ │                             │
│                     │ │ exports:                  │ │                             │
│                     │ │   #sqlite →               │ │                             │
│                     │ │   src/database/           │ │                             │
│                     │ │   sqlite.node.ts          │ │                             │
│                     │ │   (node:sqlite            │ │                             │
│                     │ │   DatabaseSync)           │ │                             │
│                     │ │   #pty → pty.node.ts      │ │                             │
└─────────────────────┴──────────────────────────┴─────────────────────────────┘
```

### 0.1 What this means in practice

1. **The sidecar is Bun-built, Node-run.** `packages/desktop/scripts/prebuild.ts` runs
   `cd ../opencode && bun script/build-node.ts`; that script does
   `Bun.build({ target: "node", entrypoints: ["./src/node.ts"], outdir: "./dist/node" })`
   (verified: `packages/opencode/script/build-node.ts`). So server code written and tested
   under Bun must ALSO work under Node — the `node` conditional exports exist precisely
   because of this. **FTS5 / SQLite code must pass on both runtimes** (the search feature
   is tested 21/21 on bun:sqlite AND node:sqlite).

2. **Conditional exports are the runtime switch.** `packages/core/package.json`:
   - `"./database/sqlite": { "bun": "./src/database/sqlite.bun.ts", "node": "./src/database/sqlite.node.ts", "default": "./src/database/sqlite.bun.ts" }`
   - `"./pty": { "bun": "./src/pty/pty.bun.ts", "node": "./src/pty/pty.node.ts", "default": "./src/pty/pty.bun.ts" }`
   Bun picks the `bun` branch; Electron's Node picks the `node` branch. When a feature
   touches these boundaries, you must implement BOTH drivers or the packaged app breaks.

3. **The packaged server bundle** (`packages/opencode/dist/node/node.js`) is what the
   desktop sidecar executes. Server changes in `packages/opencode` and `packages/core`
   are baked in through this bundle — but ONLY if `bun script/build-node.ts` re-runs
   (it runs automatically via `prebuild` before `bun run build` in packages/desktop).

4. **Two sidecar modes** (verified `packages/desktop/src/main/index.ts:67`):
   - V1 (default): `utilityProcess.fork(sidecar.js)` — the Bun-built Node bundle above.
   - V2 (opt-in, `OPENCODE_SIDECAR_V2=1`): `startBackgroundCli` — spawns the standalone
     `opencode` CLI binary (a Bun-compiled executable) as a child process.
   Either way the renderer talks to it identically over HTTP.

5. **Dev backend vs packaged sidecar can disagree.** The dev loop
   (`bun run --conditions=browser ./src/index.ts serve --port 4096`) runs FRESH source on
   Bun; the packaged app runs the bundled snapshot. They can be minutes/hours apart. When
   debugging "works in dev, fails in exe", the first suspect is a stale bundle.

6. **No Node in the renderer.** The renderer is sandboxed Chromium. All native access goes
   through the preload `window.api` surface (contextIsolation:true, nodeIntegration:false,
   sandbox:true — verified `packages/desktop/src/main/windows.ts:199-204`).

---

## 1. The V1/V2 reality (read this second)

OpenCode Desktop is a **deliberate mix of V1 and V2 libraries and surfaces**. There is no
consistency. Key facts, each verified:

### 1.1 The Desktop app still uses the V1 API; V2 is opt-in

- `packages/app/src/utils/server-protocol.ts` (`detectServerProtocol`): probes
  `/global/health`; the legacy `{healthy:true}` shape resolves `"v1"`, otherwise probes the
  V2 surface. `ServerProtocol = "v1" | "v2"`.
- `packages/app/src/utils/server-compat.ts`: `createV1Api(input)` is built unconditionally
  (line 87); the effective API is `protocol === "v1" ? v1 : input.current` (line 89).
  **V1 is the default compatibility surface; V2 only when the server declares it.**
- Desktop sidecar defaults to V1: `SIDECAR_VERSION = OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"`
  (verified `packages/desktop/src/main/index.ts:67`).

### 1.2 Two permission engines, different event names

- V1 (`packages/opencode/src/permission/index.ts`): publishes `permission.asked`
  (`Event.Asked`, line 106); replies via `permission.replied`.
- V2 (`packages/core/src/permission.ts`): publishes `permission.v2.asked` (`Event.Asked`,
  line 190) and `permission.v2.replied`.
- The plugin `permission.ask` hook was historically declared-but-never-fired; revived for
  the V1 engine only. Legacy SDK `permission.updated`/`permission.replied` are **no longer
  emitted**.
- Rule: sidecar/server code (SessionV2 paths, tools) is V2 (`ctx.ask` →
  `permission.v2.*`). App/TUI paths are V1.

### 1.3 Two session/message stores in the same DB

- V1: `message` + `part` tables (legacy JSON store).
- V2: `session_message` table (event-sourced projection) + `session`, `session_input`, etc.
- **Both are written by live workflows in the same SQLite DB.** Content features must
  index BOTH — see `packages/core/src/session/search.ts` (`SessionSearch.search` merges
  V2 `session_message` and V1 `part` matches).

### 1.4 Two client SDK stacks

- The app uses BOTH `@opencode-ai/client/promise` (Effect client) and
  `@opencode-ai/sdk/v2/client` (JS SDK v2). Different shapes/naming (`v2.session` vs
  `v2.sessions`).
- Generated trees: `packages/client/src/generated` + `generated-effect`;
  `packages/sdk/js/src/gen` (v1) + `src/v2/gen` (v2). Different regen commands touch
  different trees (see §4).

### 1.5 Vestigial / misleading names

- `packages/desktop/src/main/webview-zoom.ts` — **Tauri-derived and vestigial**, NOT real
  webview usage. The browser feature uses `webviewTag` on the main window.
- `packages/opencode/src/mcp/browser.ts` — external-auth browser helper, NOT automation.
- `McpBrowser` type names in generated SDK (`mcp.browser.open.failed`) — unrelated to the
  browser feature.

### 1.6 Rules for working in this tree

1. New code targets the V2/new-style surface **unless the seam is provably V1** — mirror
   that seam exactly.
2. Never "fix" or migrate V1 code as part of a feature.
3. Conflicting pattern? Flag it with file:line — don't guess canonical.
4. Prefer paths that bypass the dual-client mess (desktop renderer → `window.api.*`).

---

## 2. Building the Desktop installer (.exe)

Authoritative steps for the **current working-tree changes** on Windows (PowerShell 7, Bun).

### 2.1 Install (usually nothing to do)

From repo root (default branch is `dev`):

- `bun install` has already run.
- `bun.lock` intentionally resolves `@opencode-ai/app` and `@opencode-ai/session-ui`
  through the patched client tarball
  `packages/app/vendor/opencode-ai-client-1.17.13-v3.tgz`.
- **This vendor patch is intentional. Keep it.**
  - No `bun install` to "normalize". No tarball replacement. No lockfile regen unless a
    feature genuinely requires it and the implications are understood.
- What the tarball actually gates: it stands in for **`@opencode-ai/client` only**
  (verified: `packages/app/package.json:57`, `packages/session-ui/package.json:41`).
  `@opencode-ai/app` + `@opencode-ai/session-ui` are `workspace:*` and their source IS
  bundled (verified: `packages/desktop/package.json:39`). So UI edits in
  `packages/app/src/**`, `packages/session-ui/src/**`, `packages/desktop/src/renderer/**`
  DO reach the packaged exe; `packages/client/src/**` does NOT (tarball boundary).

### 2.2 Typecheck changed packages (optional but quick)

From each package directory (NEVER repo root, NEVER `tsc`):

```powershell
cd packages/core
bun typecheck        # tsgo --noEmit

cd ../opencode
bun typecheck        # tsgo --noEmit
```

Notes:
- `packages/core` has PRE-EXISTING errors in `src/database/chunk-sealer.ts` (prototype
  debris). Your files must be clean; that file is not yours.
- `packages/app` has pre-existing i18n parity failures (closed api-key lane keys). Not your
  regression.
- Same rule for `packages/protocol`, `packages/server`, `packages/client`,
  `packages/sdk/js`, `packages/desktop`.

### 2.3 Build the desktop app

From `packages/desktop`:

```powershell
$env:OPENCODE_CHANNEL='prod'
bun run build
bun run package:win
```

- **`OPENCODE_CHANNEL='prod'` is REQUIRED.** Default `dev` builds a separate "OpenCode Dev"
  app. Prod installs to `%LOCALAPPDATA%\Programs\OpenCode` and produces `OpenCode.exe`.
- `bun run build` runs `prebuild` first (`bun ./scripts/prebuild.ts`) which runs
  `cd ../opencode && bun script/build-node.ts` — regenerating `dist/node/node.js` (the
  sidecar bundle) — then electron-vite bundles main/sidecar/renderer. The sidecar imports
  `virtual:opencode-server` = `../opencode/dist/node/node.js` (verified
  `packages/desktop/electron.vite.config.ts:68`), so server changes in `packages/opencode`
  + `packages/core` are baked in.
- `bun run package:win` (electron-builder NSIS oneClick, `perMachine=false`).
- **Gotcha:** env var must be set in the SAME shell invocation as `package:win` — separate
  tool calls do not share environment (first silent failure produced the dev-channel app).

### 2.4 Output

```text
packages/desktop/dist/opencode-desktop-win-x64.exe   (~124-130 MB)
```

- **Do NOT run the installer yourself.** Silent install (`/S`) can terminate the running
  OpenCode/chat process. Hand the `.exe` to the user.
- Verify: size, timestamp, SHA-256, and that `win-unpacked/OpenCode.exe` (prod) exists
  rather than `OpenCode Dev.exe`.

### 2.5 Rebuild discipline

- After Protocol/Server `HttpApi` changes, run BOTH regens (§4) before building.
- The running app may execute OLD bundled code (sidecar from the installed exe). Reinstall
  the new exe to observe fixes; verify against the CURRENT tree before judging behavior.

---

## 3. Architecture map (where things live)

### 3.1 Core process split

```text
Electron main + renderer (packages/desktop)
       ↕ authenticated local HTTP (Basic auth, random per-launch password)
OpenCode agent sidecar (virtual:opencode-server = ../opencode/dist/node/node.js)
```

- Sidecar spawn: `packages/desktop/src/main/server.ts` (`utilityProcess.fork(sidecar.js)`
  V1) / `background-cli.ts` (`startBackgroundCli` V2 opt-in).
- Auth: `packages/server/src/middleware/authorization.ts` — `auth_token` query or `Basic`
  header; `packages/server/src/auth.ts` compares against `OPENCODE_SERVER_PASSWORD`
  (empty password ⇒ unsecured).
- Renderer gets server info via `await-initialization` IPC (`serverReady` Deferred in
  `packages/desktop/src/main/index.ts`) and talks to the sidecar through preload
  `window.api` only.

### 3.2 Server API composition (Effect HttpApi)

- Protocol groups: `packages/protocol/src/groups/*.ts` — `HttpApiGroup.make("server.X")` +
  `HttpApiEndpoint` + OpenApi annotations; SSE via `HttpApiSchema.StreamSse`; typed errors
  via `Schema.TaggedErrorClass` + `httpApiStatus` (`packages/protocol/src/errors.ts`).
- Composition: `packages/protocol/src/api.ts` (`makeApiFromGroup` + `.add()` per group).
- Handlers: `packages/server/src/handlers/*.ts` (`HttpApiBuilder.group(Api, ...)`),
  assembled in `handlers.ts` (`Layer.mergeAll`) + `routes.ts`.
- Browser example (landed): `packages/protocol/src/groups/browser.ts` (server.browser
  group), `packages/server/src/handlers/browser.ts`,
  `packages/core/src/browser/host-broker.ts`.

### 3.3 Model tools

- `packages/opencode/src/tool/*.ts` using `Tool.Def`
  (`{id, description, parameters, execute -> ExecuteResult{title, metadata, output, attachments?}}`).
- Registry: `packages/opencode/src/tool/registry.ts` (builtins init + array + node deps).
- Permissions via `ctx.ask` (V2 engine). Browser tools: `packages/opencode/src/tool/browser/*.ts`.

### 3.4 Desktop browser feature (collaborative browser)

- Embedding verdict (verified in `deliverable/browser-phase0-embedding`): **`<webview>`
  over `WebContentsView`** — a WebContentsView paints ABOVE the window's web contents, so
  the agent-cursor overlay (app DOM, z-40) could never cover the guest. `<webview>` is a
  DOM element in the same coordinate space.
- Main engine: `packages/desktop/src/main/browser/*` — `guest.ts` (GuestRegistry +
  webview hardening), `control-session.ts` (CDP 1.3, Runtime/Accessibility/Network/Log,
  per-guest semaphore), `operations.ts` (19 ops incl. premium: refs/snapshotVersion,
  highlight, query, React profiler, recording), `arbitration.ts` (control epoch +
  expected-agent-input queue + human preemption), `host.ts` (loopback bridge, Bearer auth,
  hello/event registration to sidecar).
- Renderer: `packages/desktop/src/renderer/browser/*` — BrowserPanelV2 (right pane,
  mirroring ReviewPanelV2), AgentBrowserCursor (T3 spec: 160/40ms choreography, 700ms
  linger, coordinate formula `x*zoom*scale + offset - scroll`), viewport/device system.
- Preload: `window.api.browser` (subscribe-less push via fixed channels).

---

## 4. Regenerating SDK surfaces (MANDATORY after Protocol/HttpApi changes)

**TWO independent regen steps.** Missing the second repeatedly caused stale-SDK bugs
where the app's client lacked new endpoints:

```powershell
# Step 1 — packages/client (Effect client + generated)
cd packages/client
bun run generate        # script/build.ts -> src/generated + src/generated-effect

# Step 2 — packages/sdk/js (the JS SDK the app imports)
cd ../sdk/js
bun ./script/build.ts   # src/gen (v1) + src/v2/gen (v2) from openapi.json
```

- Never hand-edit `src/generated`, `src/generated-effect`, `packages/sdk/js/src/*/gen/*`.
- `packages/client` has `check:generated` (`bun run generate && git diff --exit-code`).
- The sdk/js build runs `bun dev generate` in `packages/opencode` to produce
  `openapi.json`; if that errors (e.g. "StatusOutput is not defined"), the server tree is
  broken — fix server code first, then regen.

---

## 5. Common traps (learned the hard way)

1. **Stale SDK** — changed protocol, ran only one regen. App's `v2.session.*` silently
   missing → runtime TypeError → UI error state. Run BOTH regens.
2. **Wrong shell env** — `OPENCODE_CHANNEL` in one call, `package:win` in another.
   Same-shell or the dev-channel app gets built.
3. **Old installed exe** — the running desktop app spawns its sidecar from the INSTALLED
   exe's bundle, not the working tree. Rebuild + reinstall.
4. **Wrong protocol assumptions** — desktop defaults to V1 (`OPENCODE_SIDECAR_V2` opt-in);
   V2 chosen per-server via `detectServerProtocol`.
5. **Permission event mismatch** — `permission.asked` vs `permission.v2.asked`. Know your
   engine.
6. **Searching only one session store** — V1 `message`/`part` AND V2 `session_message`
   both hold content.
7. **Treating vestigial code as live** — `webview-zoom.ts` (Tauri), `McpBrowser`
   (auth-only).
8. **Installer execution** — never `/S`; kills the chat session.
9. **Bun-tested ≠ Node-safe** — the sidecar runs the Bun-built bundle under Electron's
   Node. SQLite/pty/streaming code must work under BOTH (`node` conditional exports).

---

## 6. Implementation checklist (new feature)

1. Confirm the runtime: is this code destined for Bun (dev/CLI), Node (Electron
   main/sidecar), or both (shared core)? If both, test both conditions.
2. Confirm the protocol surface: V1 or V2? Which permission engine? Which client stack?
3. Map the seam files with file:line before editing.
4. If touching Protocol/HttpApi: run BOTH regens, verify generated diffs are regen-only.
5. Typecheck from package dirs; distinguish pre-existing noise (chunk-sealer.ts, i18n
   parity) from your breakage.
6. Build: `$env:OPENCODE_CHANNEL='prod'` + `bun run build` + `bun run package:win` in ONE
   shell; verify `win-unpacked/OpenCode.exe` (prod).
7. Hand the exe to the user; never run the installer.
