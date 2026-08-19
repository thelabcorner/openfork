# Tool detect + hot-reload — architecture proposal

> Status: proposal for maintainer review. Synthesized from swarm exploration (t1 tool
> lifecycle map, t2 watch/reload infrastructure map, t3 SDK/protocol tool surface map) and
> the architecture design (deliverable/t4 — authoritative, v7; blackboard
> `design/hot-reload`). All refs verified on branch `openfork` @ 93e423f1d2. Path
> convention: bare `src/…`
> paths mean `packages/opencode/src/…`; `packages/schema`, `packages/core`, `packages/client`
> are written in full; everything else is relative to the repo root.

## 1. Goal & non-goals

**Goal:** let users change their tools — `.opencode/tool(s)/*.{js,ts}` custom files,
plugin-provided tools, and MCP server configuration — and have the change take effect
**without restarting the opencode server or tearing down running sessions**. Detection is
file-change-driven with a manual escape hatch; reload is atomic and validated; clients are
notified over the existing event stream.

**Scope (what reloads):**

| scope | what | phase |
|---|---|---|
| (a) | file-based custom tools `{tool,tools}/*.{js,ts}` — change + new-file (create event) | **P0** |
| (d) | "install" by adding a tool file (create event) | **P0** |
| (a) | plugin-provided tools from a changed plugin file `{plugin,plugins}/*.{ts,js}` | P1 |
| (c) | MCP config changes (add/remove server) | P1 |
| (b) | built-in tools in dev mode (watch `src/tool/*`) | P2 |

**Non-goals (explicitly out):**

- No reload of built-in tools in production (P2 is dev-only; production builtins ship in the
  release bundle — `dist/node/node.js` — and cannot be re-imported at runtime).
- No "tool removed while agent config references it" handling — that failure mode does not
  exist: `Agent.Info` has no tools field (agents carry only permission rulesets, t1 §4);
  sessions compute tool lists dynamically.
- No changes to the V2 SessionRunner registry. Per AGENTS.md the V2 registry is
  session-scoped and re-reads per session start; document that V1 reload does not affect
  active V2 sessions (out of V1 scope).
- No new config-file hot-reload machinery. Config reload stays trigger-only (see §2); tool
  reload does not silently change that contract.

## 2. Current state (ground truth from t1/t2/t3)

### Tool definition & registration

- Every tool is `Tool.define(id, initEffect)` (`packages/opencode/src/tool/tool.ts:151`);
  a shared wrapper (`wrap`, tool.ts:99-149) hoists schema decoding, maps decode failures to
  `InvalidArgumentsError`, and truncates output. One file per tool (`src/tool/read.ts`, etc.).
- `ToolRegistry` (`@opencode/ToolRegistry`, `src/tool/registry.ts:108`) holds per-directory
  `InstanceState` state `{ custom, builtin, task, read }` — **plain arrays, built once, then
  frozen** (registry.ts:89-94, 163). `all()`/`ids()`/`tools()` re-read that cached state on
  every call (registry.ts:344-347) but nothing ever rebuilds it.
- Custom tools come from two sources, both converted via `fromPlugin()` (registry.ts:167-223,
  Zod → Schema + JSON Schema):
  1. File scan `{tool,tools}/*.{js,ts}` in every config dir, `import(pathToFileURL(match).href)`
     (registry.ts:225-239) — **module cache is never busted** (t2: #1 gap).
  2. Plugin hooks `p.tool ?? {}` (registry.ts:241-246) — read once at state build; the
     registry does NOT read through `plugin.list()` per turn.
- **MCP tools are NOT in the registry.** They're merged per-turn in `SessionTools.resolve`
  (`src/session/tools.ts:390`) from `MCP.tools()`. This is the working precedent for
  "tools change at runtime": on `notifications/tools/list_changed` the MCP service re-lists
  defs and publishes `McpEvent.ToolsChanged` (mcp/index.ts:462-471); the next prompt step
  picks it up with **zero cache invalidation**.

### Dispatch semantics (what makes hot-reload safe — for free)

- Per-agent tool lists are recomputed **per model call**, inside the prompt step loop:
  `SessionTools.resolve` (session/tools.ts:41) from `session/prompt.ts:1412`. Nothing caches
  per-agent lists.
- Each `ai`-SDK `tool()`'s `execute` is a **closure over the registry `Tool.Def` captured at
  build time** (tools.ts:99-134) — never re-resolved by name at execution. Consequence: an
  in-flight tool call runs the old def to completion; a state swap only affects the **next**
  resolve.
- Therefore a registry state swap needs **zero session invalidation**: the next prompt step
  reads the new state, exactly like MCP tools do today. **No session-invalidation protocol is
  needed — this is the key enabler.**
- Sessions capture the registry *service handle* at layer build (prompt.ts:136), so
  `InstanceState.invalidate` (instance-state.ts:64) is **not** the lever — it would rebuild
  the whole per-directory scope and orphan the running handle (and tear down MCP/permission
  state). The swap must happen **in place, inside the existing service instance**.

### Watch / reload infrastructure that exists

- **File watching:** core `FileWatcher` service (`@opencode/v2/FileWatcher`,
  `packages/core/src/filesystem/watcher.ts:55-134`) over `@parcel/watcher` native bindings;
  publishes `file.watcher.updated` `{file, event: add|change|unlink}` via EventV2.
  `.opencode/tool(s)` and `.opencode/plugin(s)` are NOT in `Ignore.PATTERNS`
  (`packages/core/src/filesystem/ignore.ts:3-46`), so their changes already emit watcher
  events. V1 code already consumes this stream by filtering on path
  (src/project/vcs.ts:319-331) — Server→Core dependency direction is proven.
  **Caveats:** the project-dir subscription is gated on `OPENCODE_EXPERIMENTAL_FILEWATCHER`
  (defaults false, core/src/flag/flag.ts:37-39) + VCS (watcher.ts:106-113); the desktop main
  forces the flag on (desktop/src/main/server.ts:50); the watcher covers only the project dir
  + git dir — the **global config dir (`~/.config/opencode`) is NOT watched**.
- **Config reload is trigger-only, never fs-driven:** `Config.invalidate()` only busts the
  *global* cache (config.ts:633-635); local config is `InstanceState` run-once. Full rebuilds
  happen via `configUpdate` → `disposeAllInstancesAndEmitGlobalDisposed` (global teardown),
  SIGUSR2 (worker.ts:63-71), or `markInstanceForReload` (single instance). All are
  explicit triggers; none watch `opencode.json`.
- **Module cache busting does not exist anywhere** in the repo, and Bun's cache is hostile to
  the standard ESM idiom. Three independent spike sets (Bun v1.3.14; evidence/q1-spike v2 +
  deliverable/reload-spike + evidence/q1-spike3) proved **`import(file://…?v=<mtime>)` does
  NOT work**: Bun keys its dynamic-import cache by pathname only and ignores query strings
  entirely — same-pathname re-import always returns the first-loaded module, even for fresh
  `?v=` values and even after failed-import retries (it covers ALL imports, not just failed
  ones). **Q10 SETTLED — P0 mechanism is `Bun.build` bundle → `data:`-URL import:**
  ```ts
  const out = await Bun.build({ entrypoints: [toolPath], format: "esm" })
  const text = await out.outputs[0].text()
  await import("data:text/javascript;base64," + Buffer.from(text).toString("base64"))
  ```
  **Verified properties (spike3 4c):** relative imports AND bare/node_modules specifiers
  (`zod` etc.) are BUNDLED inline — no misresolution, no stale deps (both re-resolved on
  edit); CONTENT-ADDRESSED freshness (same content = same URL = cached; changed = fresh);
  ZERO file pollution (no copies → no glob interference, no watcher loop, no cleanup, no
  name-reuse hazard); same-realm, no IPC. **No self-contained constraint needed** — bundling
  handles deps, so the zod-import case works. **Caveats (documented):** `import.meta.url`
  inside a tool is a `data:` URL (`import.meta.dir`/`filename` undefined) → tools must use
  `fromPlugin` ctx.directory/worktree (already provided); a runtime dynamic `import()` inside
  tool code breaks under bundling (those tools fall back to manual/restart, Q9 bucket);
  per-reload `Bun.build` cost (acceptable — reloads are rare and debounced).
  **Fallback (if `Bun.build` unavailable): versioned-copy re-import** — copy `tool/foo.ts` →
  `tool/foo.__v<N>.ts` in the SAME dir and import the copy (verified fresh module + relative
  resolution), with documented hazards: same-dir copies serve CACHED relative deps (entry-only
  bust), leftover copies ARE picked up by the `{tool,tools}` glob (bogus `foo__v3` tool →
  exclude `*.__v<digits>.ts` from registry Glob.scanSync L227 + watcher/poll predicates),
  name reuse serves a stale module (use a monotonic per-process counter), stale-copy cleanup
  after swap. Multi-file plugins (P1): single-ENTRY plugins reuse the bundle mechanism; only
  non-bundlable cases (runtime dynamic import, `import.meta` dependence) need subprocess/
  worker or documented restart (Q9). See §3.3 for the full mechanism and constraints.
- **Event plumbing is fully reusable:** `Event.define` in `packages/schema/src/*-event.ts` →
  `EventManifest.Definitions` (event-manifest.ts:63-82) → `EventV2Bridge.publish`
  (event-v2-bridge.ts:19-33, auto-attaches instance location) → instance SSE `GET /event`
  (httpapi/handlers/event.ts:89-98, directory/workspace-filtered) or global SSE
  `/global/event`. Precedent: `McpEvent.ToolsChanged` (schema/src/mcp-event.ts:6-11).

### HTTP/SDK surface (t3)

- Only two tool endpoints exist, both on the V1 `InstanceHttpApi` **experimental** group
  (documented "read-only routes", groups/experimental.ts:261):
  `GET /experimental/tool` (ToolList `[{id, description, parameters}]`,
  groups/experimental.ts:152-163) and `GET /experimental/tool/ids`
  (groups/experimental.ts:164-175). Nothing in `@opencode-ai/protocol` or the generated
  client — the app/TUI/desktop never fetch tool definitions (tool calls render from
  streamed `SessionMessage.ToolPart`s, session-event.ts:273-373), so a changed schema cannot
  break UI rendering.
- A reload endpoint is **new V1 surface**; a state-changing `POST` belongs in its own
  `HttpApiGroup` under `packages/opencode/src/server/routes/instance/httpapi`, not the
  read-only experimental group.
- SDK cost of adding an endpoint/event: `bun run generate` from `packages/client`
  (regenerates `src/generated/{client,types,index,client-error}.ts` + `generated-effect/*`);
  legacy JS SDK regen via `packages/sdk/js/script/build.ts`. Never hand-edit generated files.

## 3. Recommended architecture

**One option, justified vs alternatives:** *snapshot-swap registry + watcher-driven
`ToolReload` service*. Rejected: full `InstanceState.invalidate` (never reaches running
sessions — handle captured at layer build), per-turn disk read-through (module-cache + scan
cost; doesn't fix plugin hooks being read once), subprocess re-import for P0 (heavy; reserved
for P1 multi-file plugins, Q9).

### 3.1 Registry: snapshot swap in place

`ToolRegistry`'s per-directory state becomes a **`Ref<State>`** inside the existing service
(plain `Ref`; `SubscriptionRef` only if the HTTP layer wants change broadcast):

```ts
// src/tool/registry.ts — shape of the change
const stateRef = yield* Ref.make<State>(buildState()) // per-directory, as today
const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
  const s = yield* Ref.get(stateRef)                  // read-through, not InstanceState.get
  return [...s.builtin, ...s.custom] as Tool.Def[]
})
// tools()/named()/ids() likewise read through stateRef
```

- **Swap = `Ref.set(nextState)`.** Atomic: readers see old XOR new, never a half state
  (no locks, no torn reads, trivial diff). Because sessions already hold this handle and
  `resolve` runs per turn, the new state is live from the next prompt step with zero
  invalidation.
- Builtin/task/read construction stays untouched in P0; the swap replaces only the `custom`
  slice (file + plugin tools).
- Side note: `ToolJsonSchema`'s module-level WeakMap (src/tool/json-schema.ts:6) is
  stale-safe for new Schema objects, but reusing the same Schema instance after a reload that
  changes a def's schema returns stale JSON Schema — bust the WeakMap entry on reload (key by
  def identity+version).

### 3.2 Detection: watcher (primary) + polling (fallback) + manual (always)

Pipeline: `trigger → debounce 150-300ms + coalesce + one-at-a-time gate + backoff →
Bun.build bundle → data:-URL import (versioned-copy fallback) → shape check + fromPlugin →
validate → build State → Ref.set → emit event`.

- **Primary: reuse core `FileWatcher` events** and filter by path. Match predicate (exact,
  from the registry scan scope, registry.ts:225-229): `abs file ∈ <dir>/tool/*.{js,ts} or
  <dir>/tools/*.{js,ts} for any dir in config.directories()` — a cheap per-event test against
  the directories list, no per-path subscription needed. **Coverage caveat:** the core
  watcher only watches the project dir + git dir (watcher.ts:106-124), while
  `config.directories()` (config/paths.ts:23-41) also includes the global config dir and home
  `.opencode` dirs — tool/plugin files there emit no `file.watcher.updated` today. Those are
  covered by the polling fallback (below), not the watcher.
- **One mechanism, two activation modes** keyed on `Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER`:
  desktop forces it on (desktop/src/main/server.ts:50), so desktop can subscribe to the
  existing stream with zero new wiring; CLI/TUI (flag off by default) needs `ToolReload`'s own
  `@parcel/watcher` subscription via `EffectBridge.bind` with `InstanceState`-scoped cleanup
  (the AGENTS.md-sanctioned path).
- **Fallback: polling + content fingerprint** (hash + size of each watched file) on the
  global config dir + project `.opencode` tool/plugin dirs, interval ~2s. Catches: watcher
  failure/unavailability, atomic-save replace patterns, global-dir changes. Cheap — a handful
  of files.
- **Manual: always available.** `POST /tool/reload` (V1, §3.5) + CLI flag/command (P1) — the
  escape hatch, the test path, the fix for any watcher failure.
- **Half-written files:** prefer rename-based saves (parcel emits create+unlink or change)
  and enforce **read-twice stability** — two identical content hashes N ms apart — before
  treating a file as final. Note: with content-addressed freshness, debounce + read-twice
  are a **build-churn guard, not a correctness mechanism** — unchanged content yields the
  same bundle URL (cache hit), so reloads are idempotent by construction.

### 3.3 Reload semantics

- **Validate before swap (mandatory).** Pipeline: re-read file from disk → `Bun.build`
  (build/syntax errors surface HERE — clean, before any import) → `data:`-URL import →
  shape check `isPluginTool` (registry.ts:443) → `fromPlugin` conversion → **self-conflict**
  (dup id within the reload set ⇒ hard error, no swap) → **cross-conflict** vs current
  snapshot (policy per §5 Q2; P0 default = preserve existing precedence builtin > file >
  plugin + last-write-wins, emit a warning) → build new `State` → `Ref.set`. ANY failure:
  keep the old state, publish an error event + i18n message, notify.
  **Design properties:** bundling makes the tool file's dependencies part of the built
  artifact — no self-contained constraint on the primary path (a `zod` import works), no
  static-scan guard needed, and syntax/build errors surface synchronously at `Bun.build`
  (not at import, not as cached-path failures). Tools that rely on `import.meta.url`/`dir`
  (undefined under `data:`) must use the `fromPlugin` ctx.directory/worktree instead —
  document; a best-effort static check can i18n-error on obvious `import.meta` dependence.
- **Module re-import (the #1 gap) — Q10 SETTLED: `Bun.build` bundle → `data:`-URL.** `?v=`
  busting is dead on Bun (see §2):
  - **Primary: bundle → `data:`-URL import (verified, dominates).**
    `Bun.build({ entrypoints: [toolPath], format: "esm" })` → base64 the output →
    `import("data:text/javascript;base64," + …)`. Relative AND bare deps (zod etc.) are
    bundled inline — no misresolution, no stale deps; content-addressed freshness; zero file
    pollution (no glob interference, no watcher loop, no cleanup, no name-reuse hazard);
    same-realm, no IPC. `.js`/`.ts` both work. No self-contained constraint.
    **Caveats:** `import.meta.url`/`dir`/`filename` are undefined in a `data:` module →
    tools must use `fromPlugin` ctx.directory/worktree; a runtime dynamic `import()` inside
    tool code breaks (document; those tools fall to manual/restart, Q9 bucket); per-reload
    `Bun.build` cost is acceptable (reloads rare, debounced).
  - **Fallback: versioned-copy re-import (only if `Bun.build` unavailable).** Copy the
    changed file to `tool/foo.ts` → `tool/foo.__v<N>.ts` in the SAME dir and import the
    copy — fresh module with relative resolution, but with documented hazards: same-dir
    copies serve CACHED relative deps (entry-only bust), leftover copies match the
    `{tool,tools}` glob (bogus tool → exclude `*.__v<digits>.ts` from registry
    `Glob.scanSync` L227 + watcher/poll predicates), name reuse serves a stale module (use a
    monotonic per-process counter), stale-copy cleanup after swap.
  - **P1 (multi-file plugins): single-entry plugins reuse the bundle mechanism** (fresh
    hooks incl. their static-import graph). The multi-file limitation shrinks to
    **non-bundlable** cases — runtime dynamic `import()`, `import.meta`-dependent code —
    which need a fresh subprocess/worker module graph (execute over IPC) or a documented
    "restart required" (Q9).
- **In-flight safety is free.** Dispatch captures the execute closure at build time; an
  in-flight call keeps the old def, the swap affects only the next resolve (t1 §2). State
  this as an invariant in code comments.
- **Plugin hooks (P1 path) need three steps.** Re-importing a plugin file does NOT rebuild
  the hooks array in place (plugin/index.ts:132-279 is one-shot): (1) re-load the changed
  entry via the bundle mechanism (single-entry plugins — fresh hooks incl. their
  static-import graph), or subprocess/worker graph / documented restart for non-bundlable
  cases (Q9), (2) re-`applyPlugin`, calling
  the OLD hook's `dispose()` first — there is no per-hook unsubscribe today
  (plugin/index.ts:253-276); the instance finalizer stays as the final cleanup — and (3) the
  registry `Ref` swap (§3.1; the registry converted `p.tool` once at build and does not read
  through `plugin.list()` per turn). The custom-file path needs only (1) + (3), with the
  bundle mechanism for step (1).
- **Permissions survive.** Permission rules are evaluated per-call against patterns keyed by
  tool name (src/permission/index.ts:29-113); reloading a def keeps its rules. New tools fall
  to the default ask path; a renamed/removed tool leaves a dangling rule → warn, keep the
  rule (may return).
- **Stateful tools.** P0/P1 custom/plugin tools are stateless `fromPlugin()` wrappers;
  module-level state in a tool file resets on re-import (expected, documented). Builtin state
  (bash shell) is untouched because builtins aren't reloaded until P2, which adds a per-tool
  context provider (keyed name+source) so state survives reload for compatible defs.

### 3.4 Notification

- **Internal:** `Ref` reads propagate by construction (per-turn resolve); use
  `SubscriptionRef` only if an explicit change stream is wanted.
- **External:** one new event — `ToolEvent.Reloaded` =
  `Event.define({ type: "tool.reloaded", schema: { added, updated, removed: ToolID[], location?, error? } })`
  in a new `packages/schema/src/tool-event.ts`, inventoried in `EventManifest.Definitions`
  (event-manifest.ts:63-82), published via `EventV2Bridge` after a successful swap. Exact
  precedent: `McpEvent.ToolsChanged` (schema/src/mcp-event.ts:6-11, published at
  mcp/index.ts:451/470). Clients receive it over the instance SSE `GET /event`.
  Event type name (`tool.reloaded` vs `tools.reloaded`) is §5 Q5.
- **The app MUST add a handler + tool-query invalidation** for the event to reach the UI:
  today the app has NO handler for `mcp.tools.changed` either (only
  `mcp.status.changed`/`mcp.resources.changed`, server-sync.tsx:604-605). Follow the app
  refetch precedent (event-reducer.ts:43, server-sync.tsx:604-605): on `tool.reloaded`,
  invalidate the tool queries so a future `/tool` fetch returns fresh data. (The chat UI
  itself needs nothing — it renders tool calls from streamed ToolParts, not fetched defs, so
  schema changes never break rendering.)
- Keep the event out of `EventManifest.ServerDefinitions` / Protocol unless a current client
  requires it (schema AGENTS.md: V1-only events stay out of Protocol).

### 3.5 HTTP surface (V1-first)

New `HttpApiGroup` (e.g. `tool`) under `packages/opencode/src/server/routes/instance/httpapi`:

- `POST /tool/reload` — triggers a reload of the instance's tool registry, returns
  `{ ok, added, updated, removed }` or `{ ok: false, error }`. Middleware: InstanceContext +
  WorkspaceRouting + Authorization (existing pattern, httpapi/AGENTS.md). Authz scope per
  §5 Q6.
- Existing `GET /experimental/tool` + `/experimental/tool/ids` stay as-is (read-only; they
  read through the now-swappable registry and immediately reflect reloads — no change needed).
  Clients refetch them after the event.

### 3.6 Failure modes (design handles all)

| failure | behavior |
|---|---|
| watcher unavailable / crashes / watch-limit | polling fallback (fingerprint) + error event; keep last-good state |
| invalid file mid-edit (half-written) | debounce + read-twice stability + validate-before-swap → old state retained; error event + i18n message |
| Bun caches all imports by pathname | never re-import the same pathname — P0 bundles to `data:`-URL (content-addressed, primary); versioned-copy fallback if `Bun.build` unavailable; subprocess/restart for non-bundlable (§3.3, Q9) |
| tool removed while permission rules reference it | per-call rules by name just stop matching (harmless); reload validation emits dangling-ref warning, rules kept (agents have no static tool lists — the "removed tool referenced by agent config" failure mode does not exist) |
| concurrent edits / autosave loops | debounce + coalesce + one-at-a-time gate + backoff rate limit |
| stale plugin hook subscriptions (P1) | call old hook `dispose()` on replace; instance finalizer remains the final cleanup |
| name shadowing regressions | warning in event payload (P0 default); strict-reject option per §5 Q2 |
| `import.meta` misdirection (bundle primary) | tool's `import.meta.url` = `data:` URL, `dir`/`filename` undefined → tools MUST use `fromPlugin` ctx.directory/worktree; best-effort static check → i18n error for obvious `import.meta` dependence |
| runtime dynamic `import()` in tool code | breaks under bundling → documented limitation; those tools fall to manual/restart (P1 Q9 bucket) |
| negative node_modules lookup cached by Bun | a reload build for a bare-import tool fails "Could not resolve" if the project had no `node_modules` at startup (Bun caches the miss) → mitigate: on that error fall back to restart/subprocess, or touch the resolution root at startup |
| versioned-copy pollution (fallback only) | `*.__v<digits>.ts` excluded from registry `Glob.scanSync` (L227) + watcher/poll predicates; monotonic per-process names (name reuse serves stale module); stale-copy cleanup after swap |

### 3.7 Proposed code shape (V1)

- **NEW** `packages/opencode/src/tool/reload.ts` — `ToolReload` namespace (self-reexport
  `export * as ToolReload from "./reload"` per AGENTS.md module shape).
  `Context.Service` `@opencode/ToolReload`: `start()` (subscribes `file.watcher.updated`,
  starts poll) + `reload(reason: "watcher" | "poll" | "manual")` running the pipeline:
  filter/debounce → re-read + `Bun.build` bundle → `data:`-URL import (versioned-copy
  fallback) → validate → `Ref.set` → `EventV2Bridge.publish`.
  Internal state: dirty set + in-flight gate (`Ref`). Split out `reload/watcher.ts` only if it
  outgrows one file.
- **EDIT** `packages/opencode/src/tool/registry.ts` — `State` → `Ref<State>`; extract the
  file scan (L225-239) + `fromPlugin` conversion into reusable functions; add a refresh/swap
  method used by `ToolReload`; replace the re-import site (L234) with the bundle helper.
  Builtin/task/read untouched in P0.
- **EDIT** `packages/opencode/src/tool/json-schema.ts` — module-level WeakMap (L6) is
  stale-safe for new Schema instances; if a reload reuses the SAME Schema instance with a
  changed def, key by def identity+version.
- **NEW** `packages/schema/src/tool-event.ts` + **EDIT** `packages/schema/src/event-manifest.ts`
  — `ToolEvent.Reloaded`.
- **NEW** `packages/opencode/src/server/routes/instance/httpapi/groups/tool.ts` (+ handlers) —
  `POST /tool/reload`; instance-scoped; calls `ToolReload.reload`. (P1: CLI command.)
- **EDIT** `packages/opencode/src/plugin/index.ts` (P1) — `Plugin.reload(entry)`:
  bundle re-import for single-entry plugins (hook dispose + re-apply + registry refresh);
  subprocess/worker graph or documented restart for non-bundlable cases (Q9).
- **EDIT** `packages/opencode/src/effect/instance-state.ts` — pattern reuse only:
  per-directory `ToolReload` state via the existing `ScopedCache` pattern.
- P2: `LayerRef`-based builtin layer swap (atomic service-layer hot-swap with
  acquire/release; verified idiomatic in effect-smol).
- Layering: `ToolReload` → `{ ToolRegistry (swap), FileWatcher events (EventV2 pubsub),
  EventV2Bridge (publish), Plugin (P1), InstanceState (scope) }`. Dependency direction
  Server→Core proven (vcs.ts precedent).

## 4. Phased plan

**P0 — file-based custom tools `{tool,tools}/*.{js,ts}` reload + new-file detection
(scopes a-file + d), the smallest viable user win.**
1. **SPIKE — DONE (Q1/Q10 resolved, cross-platform verified):** `?v=` busting is invalid on
   Bun (three independent spike sets: evidence/q1-spike v2 + deliverable/reload-spike +
   evidence/q1-spike3). P0 mechanism SETTLED: `Bun.build` bundle → `data:`-URL import —
   verified GREEN on win32 AND Linux (evidence/q1-spike3 v2). versioned-copy is the
   documented fallback if `Bun.build` is unavailable.
2. Registry refactor: `Ref<State>` + read-through `all()/tools()/named()/ids()` + extracted
   `buildCustom()`.
3. `ToolReload` service: detection (FileWatcher filter + poll fallback + manual), debounce,
   read-twice stability, validate-before-swap, one-at-a-time gate, `Ref.set`,
   `tool.reloaded` event.
4. V1 `POST /tool/reload` endpoint (own HttpApiGroup) + `bun run generate` from
   `packages/client`.
5. App handler + tool-query invalidation on `tool.reloaded` (event-reducer /
   server-sync precedent).
6. Verify desktop via `bun run dev` from `packages/desktop` (not the packaged exe); any
   user-visible reload string uses i18n keys.

**P1 — plugin files + MCP config (scopes a-plugin + c).** Plugin file reload: bundle
re-import for single-entry plugins (fresh hooks incl. their static-import graph; old-hook
`dispose` + registry refresh); the multi-file limitation shrinks to **non-bundlable** cases
(runtime dynamic `import()`, `import.meta` dependence) → subprocess/worker module graph
(execute over IPC) or documented "restart required" (settle in Q9). MCP config changes
handled incrementally via `MCP.add`/`disconnect` (mcp/index.ts:641/653) — NO full instance
teardown. CLI trigger. Dangling-ref warnings surfaced.

**P2 — dev-mode builtins + stateful tools (scope b).** Builtin re-import via the
bundle → `data:`-URL mechanism + `LayerRef` resource lifecycle so `src/tool/*.ts` edits
hot-swap under `bun dev`; per-tool context providers so stateful tools (bash shell) survive
reload. Optionally defer (dev-experience ROI — §5 Q8).

## 5. Open questions for maintainers

- **Q1 — module re-import mechanism: RESOLVED (Q10 settled, cross-platform verified).**
  Three independent spike sets (Bun v1.3.14) proved `?v=` cache-busting does NOT work —
  Bun keys dynamic imports by pathname and ignores queries. P0 mechanism is `Bun.build`
  bundle → `data:`-URL import: verified GREEN on win32 AND Linux (WSL2; evidence/q1-spike3
  v2) for bare/relative/both import shapes, with content-addressed idempotency confirmed.
  One residual caveat (failure table): Bun caches negative `node_modules` lookups —
  mitigate by falling back to restart/subprocess on "Could not resolve", or touch the
  resolution root at startup. versioned-copy remains the documented fallback if `Bun.build`
  is unavailable.
- **Q2 — conflict policy:** keep today's silent precedence (builtin > file > plugin,
  last-write-wins) with a `tool.reloaded` warning (recommended P0), or make collisions a
  hard no-swap error? Changing the current shadowing behavior is a user-visible change.
- **Q3 — feature flag:** new `OPENCODE_EXPERIMENTAL_TOOL_RELOAD`, or reuse
  `OPENCODE_EXPERIMENTAL_FILEWATCHER` (the watcher is already flag-gated; CLI/TUI would need
  their own subscription either way)?
- **Q4 — global config dir coverage:** poll-only for `~/.config/opencode` tool/plugin files
  (P0), or extend core `FileWatcher` with a config-dir node (P1)? The core watcher today
  covers only the project dir + git dir.
- **Q5 — event type name:** `tool.reloaded` (assignment wording) vs `tools.reloaded`
  (matches `mcp.tools.changed`); payload `{ added, updated, removed }` either way.
- **Q6 — authz for manual reload:** is `POST /tool/reload` any client with instance access,
  or gated by a permission rule? A reload can change what the model may execute.
- **Q7 — V2 interplay:** the V2 SessionRunner registry is Session-scoped (AGENTS.md) and
  re-reads per session start; confirm V1 reload intentionally does not touch active V2
  sessions (documented as out of V1 scope).
- **Q8 — builtins P2 ROI:** is dev-mode builtin hot-swap worth the cost (bundle re-import +
  `LayerRef` + stateful tool providers) vs documenting "restart `bun dev` for builtin
  changes"?
- **Q9 — P1 plugins: non-bundlable cases only.** Single-entry plugins reuse the bundle
  mechanism (fresh hooks incl. their static-import graph). The remaining decision is for
  non-bundlable cases — runtime dynamic `import()`, `import.meta`-dependent code: fresh
  subprocess/worker module graph (execute over IPC) vs documented "restart required"?
- **Q10 — P0 re-import mechanism: SETTLED.** `Bun.build` bundle → `data:`-URL import is the
  primary (verified: deps bundled inline, content-addressed freshness, zero pollution);
  versioned-copy is the documented fallback if `Bun.build` is unavailable; subprocess is
  P1-non-bundlable-only. No longer open — recorded for context.
