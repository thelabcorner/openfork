# Desktop control transport implementation ledger

Date: October 1, 2026. Scope: isolate finite session-control HTTP requests from the desktop renderer's default Chromium network session. This is a unit-level transport implementation; no Electron app or sidecar was restarted or exercised.

## Ownership path

The durable session/runtime remains owned by the V1 sidecar and its existing routes. The renderer session store initiates prompt admission, interest registration, cancellation, and lifecycle operations through the existing V1/current API clients. Those clients already receive `Platform.fetch`; ordinary Electron desktop fetch was Chromium `globalThis.fetch`, sharing its default-session connection pool with provider/catalog/history traffic. The new platform adapter classifies only explicit POST control paths, checks the origin against the URL returned by the app's sidecar initialization, and sends the small request through a main-process IPC bridge. Main validates the trusted main-frame sender, exact active sidecar origin, loopback HTTP protocol, path/method allowlist, headers, body bounds, and in-flight limits again. It then uses a separate nonpersistent Electron `Session.fetch` network session. The IPC result is reconstructed as a renderer `Response`; domain response parsing and state ownership are unchanged.

The demand path begins at a user/session action or timeline interest transition. Route+method classification decides eligibility; callers cannot pass a `priority` field or select a network session. Only the verified local sidecar origin is dispatched. Remote server connections, regular API reads (including history/catalog), SSE streams, and nonallowlisted writes remain on the existing renderer fetch implementation.

## Transport boundary

- Shared browser-safe classifier lives in `packages/app/src/utils/sidecar-control-request.ts` and is imported by the desktop renderer and main-process validator. It includes session creation, prompt admission, interrupt/abort/pause/resume, permission/question replies, Goal session control, and global event-interest mutation. Reads, catalog calls, prompt output/message reads, and unrelated writes are excluded.
- `packages/desktop/src/renderer/control-fetch.ts` applies the classifier and compares the request origin to `awaitInitialization().url`. If the selected SDK connection is remote, it falls through unchanged to the original renderer fetch.
- `packages/desktop/src/main/sidecar-control-transport.ts` checks that the configured origin is loopback HTTP and equals the request origin, rechecks route eligibility, forwards only Basic authorization/content type/accept/directory/workspace headers, omits credentials/cookies, disables cache, rejects redirects, and bounds request/response payload sizes.
- `packages/desktop/src/main/ipc.ts` permits only the trusted main frame, caps active requests at eight per renderer and 64 process-wide, aborts when the renderer is destroyed, and accepts request-ID cancellation. The isolated Electron partition is in-memory (`cache: false`); no renderer web contents use it.
- This dispatch is network-session isolation, not server scheduling. It does not claim an SSE cursor/replay barrier, isolate the sidecar event loop/database, or guarantee end-to-end latency under server-side blocking.

## Validation

The installed Electron 42.3.3 declaration in `packages/desktop/node_modules/electron/electron.d.ts` documents `Session.fetch` as using Chromium's network stack and explicitly states that session-scoped fetch uses that session. Unit coverage verifies the finite route/method classifier, local-origin and active-origin checks, forbidden headers/cookie exclusion, auth/location preservation, request cancellation, remote/read fallback, and control completion while an ordinary renderer request remains blocked.

```text
packages/app:
  bun test --conditions=solid --preload ./happydom.ts ./src/utils/sidecar-control-request.test.ts ./src/context/latest-state-request.test.ts ./src/context/server-sdk.test.ts
  43 passed, 0 failed
  bun run typecheck
  passed

packages/desktop:
  bun test ./src/main/sidecar-control-transport.test.ts ./src/renderer/control-fetch.test.ts
  7 passed, 0 failed
  bun run typecheck
  passed
```

## Limits

- Unit tests prove that the adapter selects a separate injected transport while the ordinary fetch is blocked. They do not yet prove Electron's live pool isolation through an Electron fixture or measure actual sidecar activation latency.
- IPC copies bounded request/response text between processes. The current allowlist intentionally excludes long-running output/message reads; current/legacy prompt admission routes are included where they acknowledge admission, while the streaming event path itself is unchanged.
- Cancellation is wired to the underlying `AbortController`; server-side effects already admitted before cancellation remain governed by the existing API semantics.
- A real Electron active-session test is still needed to verify priority under the actual default-session pool saturated by concurrent provider/catalog traffic and to correlate IPC start, isolated fetch, server registry application, and subsequent event delivery.

## Review: urgent signals must also bypass stalled admissions

The initial dedicated control pool still mixed prompt/session creation with cancellation and interest. Six prompt admissions blocked on runtime setup could fill that pool before cancellation reached the server. Production IPC now uses two separate ephemeral Electron sessions: runtime admission and urgent control. The shared exact-route classifier selects the class; callers cannot supply it. IPC reserves urgent capacity (16 process-wide, eight per trusted renderer) separately from admission (48 process-wide, six per renderer), with a total ceiling of 64. V1 permission/question reply routes are included using their actual generated SDK paths. The existing positive app-renderer `RendererTrust` allowlist now guards dispatch and cancellation; guests/subframes cannot acquire the capability merely by belonging to a window.

`packages/desktop/test/electron-control-ipc-gate.test.ts` builds an isolated test entrypoint and invokes the **production IPC registration** through Electron renderer IPC. Six prompt requests remain held at the fake loopback peer while an urgent interest request finishes through the separate session. Latest observed result: Electron 42.3.3; urgent completion 6.96 ms; six admissions still held at completion; six admissions subsequently aborted; an unregistered renderer rejected. Test passes and desktop typecheck passes. The fixture owns private user data under its temporary build directory and removes it only after Electron exits; startup errors are captured without an Electron error dialog.

The fixture uses node-enabled test renderer windows to exercise IPC; it does not claim to validate the production preload sandbox or real sidecar domain scheduling. Its CJS test bundle adapts only `windows.ts` import-meta filename resolution because the production main build is ESM. Actual authenticated sidecar routing, local runner cancellation and complete 1/3/6 session-to-DOM progress remain separate gates.

Eight obsolete `openfork-ipc-gate-*` data directories remain in the Windows temp directory from early fixture attempts. Automatic approval review rejected their checked native PowerShell cleanup as blocked by policy without a more specific reason. Future fixture data lives inside its build directory and has verified parent-process cleanup; no alternate deletion workaround was attempted.

## October 2 integrated native-sidecar closure

The earlier limit above is now superseded by `packages/desktop/test/electron-native-sidecar-markdown-gate.test.ts`. During bring-up this gate exposed a fixture defect: it labeled its Platform as desktop but implemented Platform.fetch with raw Chromium fetch. One long-lived SSE connection plus five prompt POSTs consumed Chromium's six same-origin HTTP/1.1 connections, so the sixth prompt never reached the sidecar until a socket was released. That result did **not** exercise the production desktop control transport.

The fixture now uses a sandboxed preload bridge into the main process, production `createDesktopFetch`, and production `createSidecarControlTransport`. Admission and urgent traffic therefore use the same two isolated Electron Session partitions as the desktop application, while the SSE reader remains in the renderer/default pool. Active turns use the V1 `prompt_async` admission route, and an urgent `/global/event/interest` mutation is issued while the admission set is live.

Latest integrated result: Electron 42.3.3 / Node 24.15.0 / Chromium 148.0.7778.218; concurrency 1/3/6 all passed; ten admissions returned 204 and all ten model starts were observed; all visible tails rendered and store state converged; the renderer opened exactly one SSE connection; transport evidence recorded ten admission fetches and seven urgent/control fetches; the urgent probe returned 200 while admission traffic was outstanding; teardown left zero roots. The fixture also now reports the actual model-release `missing` set and fails immediately instead of silently waiting for a late model start.

This closes the desktop connection-pool isolation gate for the tested native sidecar topology. It remains intentionally distinct from claims about arbitrary remote servers or OS/network failures: only the active local sidecar origin is eligible for the privileged IPC transport, and remote/read traffic stays on ordinary fetch.
