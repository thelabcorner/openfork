# Workspace package map

## Dependency spine

```mermaid
flowchart TD
  Schema["schema"] --> Protocol["protocol"]
  Schema --> LLM["llm"]
  Schema --> Core["core"]
  Protocol --> Client["client"]
  Core --> Server["server"]
  Protocol --> Server
  Core --> Host["OpenFork local host<br/>packages/opencode"]
  LLM --> Host
  Protocol --> Host
  Server --> Host
  Host --> SDK["sdk/js generated unified client"]

  SDK --> App["app"]
  Schema --> App
  SessionUI["session-ui"] --> App
  UI["ui"] --> App
  App --> Desktop["desktop"]
  SDK --> Mobile["mobile"]
  UI --> Mobile
  SDK --> TUI["retained tui dependency"]
```

This diagram shows architectural intent and primary edges, not every current
`package.json` dependency. Transitional client-to-Core imports still exist and are
called out below.

## Package inventory

| Package | Role |
| --- | --- |
| `packages/app` | Main Solid GUI. Browser-capable and embedded by desktop. **V2/new-layout is the primary presentation direction** even though runtime/API generations remain hybrid. |
| `packages/browser-visual` | Fork-owned browser visual capture/runtime support shared with desktop browser features. |
| `packages/mobile` | Fork-owned mobile PWA client. |
| `packages/client` | Generated client for the upstream-current Protocol `ServerApi`; transitional/reference surface for OpenFork unless explicitly retained by a fork feature. |
| `packages/codemode` | Code-mode support package. |
| `packages/core` | Durable domain state, current/V2 session runtime, event/projector services, persistence, location services, shared process/runtime primitives. |
| `packages/desktop` | Electron main/preload/renderer host, native integration, browser authority, sidecar lifecycle, and OXP native tunnel/secure-secret/tray/autostart lifecycle. |
| `packages/effect-drizzle-sqlite` | Effect/Drizzle SQLite integration support. |
| `packages/effect-sqlite-node` | Node SQLite Effect integration support. |
| `packages/http-recorder` | HTTP recording/test support used by provider/runtime tests. |
| `packages/httpapi-codegen` | Code generation support for HTTP APIs. |
| `packages/llm` | Provider protocol and model-wire adapters. |
| `packages/opencode` | OpenFork local host/sidecar (legacy package name), mature V1 production runtime, retained CLI host, full HTTP API composition, fork-rich tool/runtime integrations, and the first-party OXP semantic/MCP endpoint. V1 is repaired/extended here and receives selective current/V2 backports. |
| `packages/plugin` | OpenFork's inherited/forked plugin contracts and runtime helpers. No generic compatibility with OpenCode plugins is promised. |
| `packages/protocol` | Browser-safe upstream-current API contract built on Schema. Useful as a donor/shared contract surface, but not an OpenFork product compatibility target by itself. |
| `packages/schema` | Shared browser-safe domain/wire schemas and branded IDs. |
| `packages/script` | Shared script/build utilities. |
| `packages/sdk/js` | Generated unified SDK for the complete `OpenCodeHttpApi`. |
| `packages/server` | Shared server middleware/handlers/location infrastructure used by the local host. |
| `packages/session-ui` | Shared session/message GUI components. Its V2 presentation components are first-class OpenFork UI building blocks, not merely migration artifacts. |
| `packages/tui` | Upstream-coupled retained dependency; not an OpenFork product or compatibility promise. |
| `packages/ui` | Shared low-level UI system/primitives. |

## Contract packages vs implementation packages

### Browser-safe contracts

- `packages/schema`
- V1 browser-safe contracts retained by the local product;
- `packages/protocol` and `packages/client` where the existing hybrid tree or a
  deliberate fork feature still consumes them;
- generated surfaces in `packages/sdk/js` where required by the V1/fork local host.

Client/runtime separation remains required, but **current Protocol is not the
required destination**. Prefer a stable V1/fork browser-safe contract rather than
coupling presentation directly to Core/Server internals.

These contracts are OpenFork-local contracts. Matching an upstream OpenCode package
or namespace does not imply that third-party OpenCode clients/plugins are supported.

### Domain/runtime implementation

- `packages/core`
- `packages/opencode`
- `packages/server`
- `packages/llm`

These packages may own local persistence, execution, provider protocols, process
state, or workspace services and therefore should not leak implementation types into
browser code as the long-term design.

### Presentation

- `packages/app`
- `packages/mobile`
- `packages/session-ui`
- `packages/ui`
- `packages/tui` (retained coupling only; not an OpenFork product)

For desktop/browser product work, prefer the established **V2/new-layout
presentation system**. This preference does not authorize pulling the current/V2
runtime or Protocol API into the client; presentation and transport/runtime
generation are independent.

## Current transitional dependency debt

The root architecture contract says client runtime code may depend on Schema and
Protocol but should not depend on Core or Server implementation.

Current manifests/source still include Core dependencies/imports in:

- `packages/app`;
- `packages/session-ui`;
- `packages/tui`.

This map records that as **layering debt**, not evidence that OpenFork should finish
the upstream current-client migration. Do not use the existing imports as precedent
for adding more client-to-Core coupling. Prefer moving browser-safe types/projections
into Schema or a V1/fork-owned browser-safe API boundary; use Protocol only when it
is deliberately retained rather than by default.

## API generation ownership

### Protocol client

```text
packages/protocol
  ServerApi
    -> packages/client
```

This is upstream's current-client generation path. In OpenFork it is **not a product
target or parity requirement**. Regenerate it when retained code actually changes
Protocol; do not migrate V1 callers onto it merely to advance upstream's migration.

### Unified SDK

```text
packages/opencode
  OpenCodeHttpApi
    = Protocol ServerApi
    + root/global APIs
    + local instance/runtime APIs
    + fork-owned route groups
      -> packages/sdk/js
```

The unified SDK remains relevant to the hybrid local host and fork-owned routes.
Its current/v2-generated namespaces are implementation details, not a mandate to
adopt the current client API architecture.

## Repository-level support directories

| Path | Role |
| --- | --- |
| `script/` | Fork sync/prune, generation, release, translation, probes, and repository automation. |
| `patches/` | Dependency patches applied by the workspace. |
| `extensions/` | Client-side extensions such as the Chrome integration. |
| `benchmarks/` | Repository-level benchmark harnesses. |
| `experiments/` | Prototypes and measured experiments that are not production packages. |
| `.openfork/` | Repository-local OpenFork agents, commands, tools, themes, and config. |
| `docs/` | Architecture, maps, plans, specs, handoffs, and evidence. |
