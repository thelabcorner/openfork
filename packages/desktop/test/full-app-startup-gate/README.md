# Full application startup and navigation gate

This fixture is the cross-layer complement to the native sidecar/Markdown gates.
Those gates prove the production sidecar, control transport, global session event
stream, and Markdown renderer in isolation. This one mounts the production
`AppBaseProviders` + `AppInterface` composition inside an isolated Electron
renderer, so the measured path includes the actual router, `NewAppLayout`, Home,
the home session controller, sidebar, `ServerSync`, and usage owners.

The gate begins after a known server has been selected and is ready: it supplies
that server directly and disables `ConnectionGate`'s redundant health wait. It
does not claim to measure desktop bootstrap, server selection, or health-probe
startup. Its cold boundary is the first production app mount for that server,
with a fresh Electron profile and an existing project directory. The fixture
uses the same `html`, `body`, and `#root` sizing as the desktop renderer entry
so virtualized session content receives a real window viewport.

## Ownership path

Durable `SessionTable` rows and lifecycle/status facts are projected by the
bootstrap-free global API. `InstanceStore` remains the authoritative owner for
workspace runtime construction and records the explicit caller/location/reason
when an execution route first needs it. On the client, one server-scoped
`ServerSDK` owns the global event SSE; `ServerSync` reduces compact root/status
events into the shared home projection. `HomeSessionsController` reads bounded
`global.sessionRoots` snapshots by known project directory, and `NewHome` plus
the real chat sidebar render those rows without loading message history. Only an
explicit detail-route open may request history. Usage and model/catalog work
remain with their singleton or explicitly lazy owners.

The reverse demand path starts at a visible home row: rendering it needs project
identity, a compact root/status value, and shared event updates. It does not need
messages, parts, per-row subscriptions, or a workspace `Instance`. Clicking a row
changes to the detail route and is the first action allowed to hydrate history.
An externally created session must become visible on Home through the global
event/index path without changing the current route or creating a UI tab.

## Scenarios and negative invariants

The cold profile is isolated to a fixture-owned directory and starts with one
known project and no session tabs. The gate first opens the production
`/new-session` draft action from empty Home and separately records route mount,
visible editable composer, focus, `/config` request start/completion, and route
settlement. It holds the directory provider-catalog response at the real sidecar
fetch boundary and requires the composer to become usable while that response is
still pending. This distinguishes composer readiness from optional catalog work
and from config-read latency without fabricating a provider result. It then
returns to Home. Before
any explicit prompt route, the production app must make zero implicit-location
or Tier 0/1 `InstanceStore.load` calls, including failed global-root requests
with omitted or empty location. The fixture disables auto-share, so the only
expected `InstanceStore.load` creation is the first explicit `prompt_async`
execution in the known workspace; any other load fails the owner assertion. A
session created through the local test sidecar while Home remains mounted must
appear in the Home list while the URL stays `/` and the tab store remains empty.

The gate then exercises one, three, and six concurrently working sessions. One
session is opened in the actual detail route; the remainder stay untabbed and
must remain status-only. The Home-row click must execute the real lazy
`SessionPage`, render the streamed tail, and avoid history reloads or
dynamic-import/renderer errors. It records roots-query count by directory,
history and part reads, server-scoped SSE opens, session-root owners, optional
usage/catalog calls, and every authoritative `InstanceStore.load` attribution.
The required
invariants are:

- cold Home and project discovery make zero implicit-location or Tier 0 instance
  loads;
- a detail route is the only history-hydration trigger; background rows never
  request messages or parts;
- root queries are bounded by known project directories, not multiplied by
  visible rows or active sessions;
- one global event SSE is opened per server context, not one per row/session;
- the explicit prompt path is attributable to its explicit directory, caller,
  route, and Tier 3 execution reason; any other load must map to an explicitly
  reviewed Tier 2 owner;
- 1/3/6 stream progress remains observable with one selected detail and the
  other working sessions untabbed;
- global `/fork/credential` and `/fork/usage` reads are held only after the Home
  and row ownership invariants have been observed, and do not prevent session
  updates. Only naturally demanded requests are held; zero held requests is
  recorded as an unexercised optional-work condition, never replaced with a
  synthetic provider response. Directory-bound provider/catalog reads remain live;
- the test records source fingerprint, Node sidecar artifact SHA-256, and the
  Electron/Chromium/Node runtime versions alongside each result.

Instrumentation belongs only to this fixture and the private test sidecar
artifact. Product services and product-visible flags stay unchanged. This gate
must not use a live app or server, ports reserved by other tests, shared Vite
cache/profile paths, or a run that silently resolves a missing directory to the
test process working directory.

## Evidence boundary

This test establishes only behavior for its exact current source fingerprint,
private Electron runtime, fixture workspace, and 1/3/6 scenario. A green result
does not establish cold Markdown layout cost (covered separately), arbitrary
project-count scaling, or packaged-build behavior. The test must emit an
inspectable failure if any required production surface cannot mount; a partial
SDK/context mount is not a passing fallback.

For the adversarial V1 history-open case, run the same gate with
`OPENFORK_FULL_APP_GATE_LARGE_HISTORY_PARTS=80000`. After the real sidecar has
migrated its fixture database and Home has observed the newly created session,
the fixture-only Electron IPC inserts one user message and 80,000 short parts in
one SQLite transaction. It then measures the ordinary Home-row click and
production paginated history request. The recovery row then opens the explicit
V1 detail reader, fetches and renders two successive pages, and holds a third
page across Close before releasing its response. This mode asserts the initial
64-part response and 79,936 omissions; each detail page contains at most 16
parts, 1,024 code points per slice, and 128 KiB on the wire; no keyed full
message or legacy part fetch; a usable composer; and unchanged 64-part shared
history and omission metadata after the late response. The detail page is gone
after Close, and renderer/console errors remain empty. The insertion timing is
reported separately from detail-open timing. This is a test database fixture,
not a production mutation path; it exercises the real V1 SQLite page query,
HTTP response, client-store normalization, and visible timeline.

The default gate also overlaps a real `GET /usage/summary` with opening a cold
session. A test-only transform recognizes the aliased `usage_record` summary
query in the production `scanDb` SQLite adapter and holds it after statement
admission but before the native worker request. While that scan remains held,
the gate selects a session in a project not previously materialized during the
app lifetime and requires the detail route, composer, session interest, and
initial history response to become ready. It verifies the summary remains
pending until the barrier is released and then returns 200. This proves
independence at the actual scan-statement admission seam; it does not simulate
the CPU cost of scanning a large populated usage table.
