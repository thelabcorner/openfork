# Runtime and product surfaces

## Surface matrix

| Surface | Path | Product status | Runtime role |
| --- | --- | --- | --- |
| Desktop GUI | `packages/desktop` + `packages/app` | **Primary OpenFork product** | Electron host plus Solid renderer and local sidecar lifecycle. |
| Browser GUI | `packages/app` | Supported OpenFork client surface | Solid/Vite client that connects to the OpenFork local server over HTTP/SSE. |
| Mobile PWA | `packages/mobile` + `packages/app/src/pwa-*.tsx` | Fork product surface | Independently hosted PWA shell around the authoritative shared application runtime, with pairing/OFXP identity pinning and verified sidecar transport at the host boundary. |
| TUI | `packages/tui` + embedded CLI references in `packages/opencode` | **Not an OpenFork product** | Retained coupling dependency required by inherited embedded CLI code. |
| Local server/sidecar | `packages/opencode`, `packages/server`, `packages/core` | Internal client runtime | Sessions, tools, providers, persistence, local APIs, workspace execution. |
| OXP / ChatGPT external-agent surface | `packages/opencode/src/oxp` + `packages/desktop/src/main/oxp` | First-party OpenFork integration surface | Secure-MCP augmentation, Session supervision, durable worker delegation, file exchange, tunnel lifecycle, and parent-tool-epoch continuity guidance. |
| Native Swarm | `packages/core/src/swarm` + `packages/opencode/src/swarm` + `packages/app/src/pages/swarm` | **First-party OpenFork product/domain surface** | Durable multi-Session collaboration, DAG work, peer mail, claims/deliverables, process-global orchestration, Tier-0 API, and lazy premium control UI. |
| Standalone upstream CLI package | `packages/cli` upstream only | Pruned | Not shipped/maintained as an OpenFork package. |
| Hosted SaaS/web console | upstream console/web/stats/etc. | Pruned | Explicitly outside fork product scope. |

## GUI

`packages/app` is the reusable Solid application. It is used by the Electron
renderer and can also run as a browser client.

The **new/V2 layout is the primary OpenFork GUI direction**. This is independent of
the V1-first execution/local-API policy. In current code, new-layout presentation is
the default and the legacy interface has passed its configured sunset, so product UI
work should normally extend the new/V2 presentation rather than legacy layout
components.

Important sublayers include:

- `src/context/*` — server/client state, projections, settings, files, tabs,
  permissions, goals, scheduled tasks, and transport;
- `src/components/*` — shared interaction surfaces;
- `src/pages/*` — route-level GUI;
- `packages/session-ui` — session/message presentation primitives;
- `packages/ui` — lower-level shared UI system.

The GUI is not the owner of durable session/runtime facts. It should consume
materialized server/Core projections and browser-safe contracts.

Native Swarm follows this rule strictly: the group/tab and control panel consume
virtual SessionGroup membership, compact Swarm projections, SessionTelemetry,
Permission, and Question state. They do not scan Session transcripts to infer
roster/task/runtime truth. The panel is lazy-loaded only for
`kind:"swarm"` groups.

A V2/new-layout component therefore does not imply current/V2 execution or a
current Protocol endpoint. Prefer the newer presentation while keeping domain/API
ownership where it actually belongs.

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

### OXP

OXP is not another browser/client API for the GUI. It is the first-party
ChatGPT/OpenAI external-agent adapter. Electron main owns the native tunnel,
secure-credential, tray/autostart, and replacement lifecycle. The sidecar owns the
dedicated OXP MCP endpoint and projects OpenFork-owned capabilities rather than
duplicating their implementations.

ChatGPT parent access to OXP is host-time-bounded. The current architecture treats
each parent session as having an observed, non-renewing 25-minute
tool epoch. Calls do not renew the deadline. The first call at/after 20 minutes
receives a continuity reminder directing unfinished work into a durable
`openfork_worker`; a successful post-25-minute call begins a new observed epoch.

The epoch tracker is process-local advisory state, not authorization. Worker
Sessions remain the durable continuity mechanism and continue even while the
parent cannot issue OXP calls. See
[the durable epoch contract](../architecture/oxp-parent-tool-epoch.md).

## Browser GUI

`packages/app/src/entry.tsx` can construct an HTTP server connection directly. In
development it defaults to the OpenFork local server. A different server is supported
only when that server's compatibility with the exact OpenFork client contract is
explicitly established; generic OpenCode-server compatibility is not promised.

This is still a **client**. Static hosting of the GUI does not imply OpenFork hosts a
SaaS backend.

## Mobile PWA

`packages/mobile` is an independently hosted static PWA shell rather than an HTML
bundle served by the Electron sidecar. It is intentionally thin: pairing, QR scanning,
service-worker/install behavior, OFXP/OpenFork Network identity pinning, credential
persistence, and the verified development proxy belong to the mobile host.

After trust succeeds the shell lazy-loads `@opencode-ai/app/pwa-client`. Session
transport/sync, reconnect behavior, navigation, timeline rendering, prompt assembly,
tools, permissions, models, goals, settings, and other application semantics remain
owned by `packages/app` and the shared browser-safe contexts. Mobile-specific
presentation can specialize those shared surfaces, but must not grow a parallel
session/runtime implementation.

The PWA and API server can be deployed separately. The stored API URL is a transport
location, not the durable backend identity: paired mobile clients pin the public OFXP
peer/fingerprint/realm when available and verify it before sending a stored device
credential on later cold starts.

## TUI

`packages/tui` is present in the workspace, but its status is unusual:

- it is not an OpenFork product;
- `keep-manifest.json` records it as
  `deferred-coupled-to-embedded-cli`;
- upstream embedded CLI code inside `packages/opencode` still imports it, so pruning
  the package would break installation/typechecking without first decoupling that CLI;
- OpenFork should generally avoid investing product work in this retained dependency.
  Taking upstream changes here is a maintenance shortcut, not an OpenCode
  compatibility promise.

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
  scheduled tasks, and native Swarm.

That is categorically different from upstream hosted infrastructure for multi-tenant
SaaS, console, telemetry products, hosted web, enterprise services, or cloud
deployment. Those concerns are pruned from the fork.
