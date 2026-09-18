# Runtime and product surfaces

## Surface matrix

| Surface | Path | Product status | Runtime role |
| --- | --- | --- | --- |
| Desktop GUI | `packages/desktop` + `packages/app` | **Primary OpenFork product** | Electron host plus Solid renderer and local sidecar lifecycle. |
| Browser GUI | `packages/app` | Supported client surface | Solid/Vite client that connects to an OpenCode server over HTTP/SSE. |
| Mobile PWA | `packages/mobile` | Fork product surface | Separate static/mobile client for the same local-server model. |
| TUI | `packages/tui` + embedded CLI references in `packages/opencode` | **Not an OpenFork product** | Retained compatibility dependency required by upstream embedded CLI code. |
| Local server/sidecar | `packages/opencode`, `packages/server`, `packages/core` | Internal client runtime | Sessions, tools, providers, persistence, local APIs, workspace execution. |
| Standalone upstream CLI package | `packages/cli` upstream only | Pruned | Not shipped/maintained as an OpenFork package. |
| Hosted SaaS/web console | upstream console/web/stats/etc. | Pruned | Explicitly outside fork product scope. |

## GUI

`packages/app` is the reusable Solid application. It is used by the Electron
renderer and can also run as a browser client.

Important sublayers include:

- `src/context/*` — server/client state, projections, settings, files, tabs,
  permissions, goals, scheduled tasks, and transport;
- `src/components/*` — shared interaction surfaces;
- `src/pages/*` — route-level GUI;
- `packages/session-ui` — session/message presentation primitives;
- `packages/ui` — lower-level shared UI system.

The GUI is not the owner of durable session/runtime facts. It should consume
materialized server/Core projections and browser-safe contracts.

## Desktop

The Electron package wraps the GUI and provides native authority.

```text
packages/desktop/src/main
  native OS + windows + browser authority + IPC + sidecar lifecycle

packages/desktop/src/preload
  typed bridge

packages/desktop/src/renderer
  desktop shell around packages/app
```

The renderer should access native capabilities only through `window.api`. The main
process owns IPC handlers.

The local sidecar is intentionally a separate process boundary so workspace/runtime
work does not execute inside the sandboxed renderer.

## Browser GUI

`packages/app/src/entry.tsx` can construct an HTTP server connection directly. In
development it defaults to the local OpenCode server; in deployed/static form it can
connect to an explicitly selected compatible server.

This is still a **client**. Static hosting of the GUI does not imply OpenFork hosts a
SaaS backend.

## Mobile PWA

`packages/mobile` is a separate static client rather than a responsive bundle served
by the Electron sidecar. It connects to the same server model with its own reconnect,
streaming, navigation, and mobile presentation logic.

The desktop README documents the intended split: the sidecar can be exposed as an API
server, while the PWA itself is hosted separately.

## TUI

`packages/tui` is present in the workspace, but its status is unusual:

- it is not an OpenFork product;
- `keep-manifest.json` records it as
  `deferred-coupled-to-embedded-cli`;
- upstream embedded CLI code inside `packages/opencode` still imports it, so pruning
  the package would break installation/typechecking without first decoupling that CLI;
- OpenFork should generally take upstream behavior for this compatibility surface
  rather than grow fork-specific TUI product features.

There is an older extraction specification in
`docs/specs/tui-package.md`. Current source has moved beyond some of its dependency
targets (for example the present package still imports Core), so use source plus the
manifest as current truth and treat the spec as migration/design history where they
disagree.

## Local server is not hosted backend infrastructure

The local server is required for the client architecture:

- HTTP and event transport;
- session execution;
- provider/model access;
- tools, shell, files, Git, PTY, and workspace services;
- local persistence;
- fork features such as Goal Mode, quota/usage, session groups, checkpoints, and
  scheduled tasks.

That is categorically different from upstream hosted infrastructure for multi-tenant
SaaS, console, telemetry products, hosted web, enterprise services, or cloud
deployment. Those concerns are pruned from the fork.
