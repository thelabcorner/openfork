# Mobile Startup Profiling (LayoutProvider focus)

Status: measured report (2026-09-21)

## Method

- Live dev stack: `:3301` bound through the verified dev proxy to a running
  sidecar (`instanceID 44b6e704-…`, `ofxp.enabled=false` in this dev launch),
  inspected with the shared browser.
- The live PWA was measured unpaired. Pairing requires a code minted from the
  desktop UI, so the connected runtime (and therefore a live `LayoutProvider`
  mount) was **not** reachable in this environment; that part is covered by
  code-path analysis plus a synthetic hydration micro-measure.
- Production bundle numbers come from an isolated `vite build --outDir`
  (concurrent builds keep wiping `packages/mobile/dist`).

## Measured: dev-stack boot (unpaired)

| Phase | Cold (first visit) | Warm re-navigation |
| --- | --- | --- |
| `responseEnd` | 329 ms | 12 ms |
| `DOMContentLoaded` | 396 ms | 37 ms |
| `load` | 397 ms | 37 ms |
| Decoded resources | 445 KB (Vite module graph) | 445 KB, SW cache |
| Network transfer | dev module graph + `/global/health` | 300 B |

The service worker (`openfork-mobile-shared-runtime-v9`) is `activated` and
controlling on the second navigation; the warm numbers are cache-served. This
is a Vite dev module graph (`src/bootstrap.tsx` is served unbundled), not the
production bundle.

## Measured: production chunk graph

| Chunk | Raw | Gzip |
| --- | --- | --- |
| `pwa-client` (shared runtime, loaded after trust) | 988.9 KB | 271.2 KB |
| `session` | 581.1 KB | 167.0 KB |
| `connection-settings` | 13,903 B | 3,539 B |
| `connection-endpoint` (on demand) | 1,929 B | 888 B |
| `notification-settings` | separate lazy chunk | — |

Before/after for the Connection sheet in this workstream: the migration form
was first inlined, making the lazy chunk 15,227 B raw; after splitting it into
`connection-endpoint` the base chunk is 13,903 B and the form costs 1,929 B only
when expanded. The base was already above the earlier ~9.7 KiB figure before
this workstream; see `09-tunnel-ingress.md` for the budget note.

## LayoutProvider hydration

Path (`packages/app/src/context/layout.tsx:330`): the provider creates the
layout store with defaults and then hydrates it synchronously from
`Persist.serverGlobal(scope, "layout", ["layout.v8", "layout.v7"])`
(`opencode.global.dat` storage, key `layout`). Hydration runs the `migrate`
function (legacy sidebar/fileTree/sessionTabs/sessionView normalization) and,
for every stored session key, `normalizeStoredSessionTabs` dedupes and
normalizes the tab list.

Synthetic micro-measure (realistic payload: 60 sessions, 240 tabs, 20
workspaces, 17,729 stored bytes; 200 iterations, bun):

| Operation | Median | p95 | Max |
| --- | --- | --- | --- |
| `JSON.parse` of the stored payload | 0.061 ms | 0.080 ms | 0.104 ms |
| Per-key normalize walk | 0.046 ms | 0.066 ms | 0.567 ms |

Hydration parse + normalization is sub-millisecond at realistic sizes and is
not a startup bottleneck. The expensive startup step is the shared runtime
chunk graph (271 KB gzip), which is already lazy: `bootstrap.tsx` loads
`@opencode-ai/app/pwa-client` dynamically and preloads it during the
identity/credential probes instead of before them.

## Negative invariants checked

- One health polling owner: `useServerHealth` in
  `packages/app/src/utils/server-health.ts` is the only poll loop; the
  Connection sheet consumes `global.servers.health` and has no timers.
- The identity probe stays credential-free and precedes the credential check
  in `bootstrap.tsx`; the service worker never intercepts cross-origin,
  authorized, or non-static-destination requests (guard test).
- No metric-only history hydration was added by this workstream.

## Recommended follow-ups

1. Instrument `LayoutProvider` init with a dev-only `performance.mark` and
   capture a paired cold start on a real phone before considering any layout
   state changes; current evidence does not justify optimizing hydration.
2. Keep the bootstrap/runtime boundary: add a paired-device trace for
   session-open cost (timeline mount, first sync round trip) once pairing is
   available in a profiling environment.
3. Re-measure the Connection sheet budget after the concurrent revoke/network
   sections settle, and decide whether the base chunk should be split further.
