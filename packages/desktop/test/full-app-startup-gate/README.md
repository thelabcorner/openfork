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
with a fresh Electron profile and an existing project directory.

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
known project and no session tabs. Before any session creation or explicit detail
route, the production Home must make zero implicit-location or Tier 0
`InstanceStore.load` calls, including failed global-root requests with omitted
or empty location. The fixture disables auto-share, so the only expected
`InstanceStore.load` creation is the first explicit `prompt_async` execution in
the known workspace; any other load fails the owner assertion. A session created through the local test sidecar while Home remains
mounted must appear in the Home list while the URL stays `/` and the tab store
remains empty.

The gate then exercises one, three, and six concurrently working sessions. One
session is opened in the actual detail route; the remainder stay untabbed and
must remain status-only. It records roots-query count by directory, history and
part reads, server-scoped SSE opens, session-root owners, optional usage/catalog
calls, and every authoritative `InstanceStore.load` attribution. The required
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
