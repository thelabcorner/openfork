# Server ownership audit: startup catalogs and session-critical blockers

Date: 2026-10-01. Scope: read-only source/build evidence review for the catalog, location-service, provider, and storage paths. This is an architecture audit, not a performance closeout. The storage guide and map were absent at `C:\DEV_STORAGE_GUIDE.md` and `C:\DEV_STORAGE_MAP.json` (per parent investigation); no process was restarted and no runtime state was mutated.

## Findings

### The V1 startup agent query now crosses the current location graph

`packages/app/src/context/global-sync/bootstrap.ts:408-440` defines `loadAgentsQuery`. When protocol detection resolves to `v1` and a legacy client exists, the code tries `sdk.list({ location: { directory } })` first, then falls back to `legacy.app.agents()` only on 404/405. The change's own comment says the reason is richer `system prompt` metadata. Parent-provided build-fingerprint/build-excerpts evidence confirms the installed app shell contains this current-first branch, so the source/build identity uncertainty for this path is resolved. The ledger's measured `/api/agent` request was 93.6 s.

The route ownership is confirmed: current `packages/server/src/handlers/agent.ts:7-13` calls `AgentV2.Service` under the default API's `LocationMiddleware` (`packages/server/src/api.ts:1-8`). `packages/server/src/location.ts:17-22, 32-43, 50-61` wraps the result with location metadata and uses `LocationServiceMap.Service`; absent an explicit directory it substitutes `process.cwd()`. That makes this a Tier 2 workspace catalog read with a server-side implicit-location defect. The actual startup caller supplies a directory, so the fallback is not evidence about this request.

`packages/core/src/location-services.ts:51-95, 125-186` defines one per-location graph containing `Config`, `AgentV2`, plugins, catalog/AISDK, integrations, filesystem search/index/watchers, PTY, tools, snapshot/checkpoint, session runner/model, and other services. `buildLocationServiceMap` hoists and compiles the *whole group* and retains it in a 60-minute `LayerMap`. Therefore the agent read is owned by a broad graph boundary even though `AgentV2.node` itself has no dependencies (`packages/core/src/agent.ts:111`). This supports the ledger's ownership diagnosis. It does not prove every node's expensive runtime work executes merely on graph acquisition; service-level lazy `InstanceState` and `init()` behavior must be checked per member before attributing latency to plugins, watchers, tools, or indexing.

A key qualification: the old V1 fallback is also not demonstrably narrow. `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts:149-153` declares the legacy `app.agents` endpoint inside the instance group, and that group applies `InstanceContextMiddleware` and `WorkspaceRoutingMiddleware` (`:190-196`). Thus the current-first switch is a real API-generation/ownership change and gives a measured slow current path, but source alone does **not** prove it introduced a slower ownership tier than the previous fallback. Do not label this diff the measured cause without a controlled comparison or staged trace. The correct repair is still a narrow shared Tier 2 resolved-agent projection exposed to V1, not selecting a current route whose graph is broader; preserving rich prompt data means the projection must explicitly include the needed fields.

**Confidence:** high for installed switch, route, map group, and cwd fallback; medium for graph-acquisition cost; low for the switch as the cause of the 93.6 s delay.

### Provider catalog is definitely on the full instance bootstrap path

`packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts:31-94` puts GET `/provider` in a group with `WorkspaceRoutingMiddleware` and `InstanceContextMiddleware`. The group also contains OAuth operations, so shared group middleware makes even catalog listing pay the same boundary. `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts` shows the list's actual dependencies: workspace `Config.get()`, `ModelsDev.get()`, `Provider.list()`, auth credential reads, and optional compatibility projection. These are a mix of Tier 2 config/catalog and credential metadata; OAuth mutation belongs elsewhere. There is no evident need for PTY, snapshot, LSP, VCS, tool registry, or session execution just to render provider choices.

Middleware calls `InstanceStore.load` (`middleware/instance-context.ts:36-60`). `InstanceStore.boot` resolves project identity, then waits for `InstanceBootstrap.gate` (`project/instance-store.ts:37-76`); that gate does config load, `plugin.init()`, and `toolReload.start()` (`project/bootstrap.ts:43-62`). Warmup for LSP/ShareNext/format/VCS/snapshot/project is detached after request admission (`bootstrap.ts:64-84`, `instance-store.ts` load completion), so it should not be named as a direct gate without evidence of another synchronous dependency. The plugin and project resolution stages are genuine request blockers. The existing timing log labels bootstrap stages, which is a useful instrumentation owner; the ledger correctly leaves individual attribution unresolved.

**Confidence:** high for provider route/middleware/bootstrap chain; low for the cause of the measured 101 s. Best narrow owner: explicit-location Tier 2 provider/config catalog that reads already-resolved config/provider/auth state and does not acquire `InstanceStore`. Keep OAuth mutation under runtime/auth semantics.

### Server cwd fallback differs across the two APIs

Current `/api/*` calls enter `packages/server/src/location.ts:32-43`, which defaults to cwd; this violates the repository's no-implicit-instance routing invariant. The experimental `/provider` group uses `WorkspaceRoutingMiddleware`; `workspace-routing.ts:165-192` requires explicit directory/session location (or explicit workspace resolution) and returns `MissingDirectory` at `:212-218`. This is a meaningful distinction: the existing current API is more permissive and the current-first agent change makes that problematic fallback reachable from the startup query if its directory argument is ever lost. Add a zero-implicit-location negative invariant at the API route boundary.

### SQLite protections reduce some contention but do not isolate the sidecar event loop

`packages/core/src/database/sqlite.node.ts:103-124` executes `DatabaseSync` `statement.all()` directly inside a synchronous `try` in the calling JS process. The Effect wrapper makes the API composable; it does not move native execution to a worker. `packages/core/src/database/database.ts:55-86` configures the primary 5 s busy timeout and a separate query-only read handle with 250 ms timeout (`:memory:` excluded); the file-backed reader avoids queueing behind the primary connection's single-permit semaphore. Existing backfill/sealer code also uses separate handles/shorter timeouts. These are useful connection/lock mitigations, but both handles remain on the same sidecar event loop; a slow query, native lock wait, or synchronous checkpoint still blocks HTTP/SSE/control callbacks on that thread.

The report's statement that there's no priority-aware writer admission is consistent with the inspected API surface, but this audit did not inspect every transaction caller/semaphore policy. Do not infer that current SQLite locking caused the catalog stalls. A worker-backed storage owner is a sound architecture direction only after preserving transaction order, execution lease authority, and migration/schema lifecycle; it requires a separate design and measured proof. First-stage instrumentation should put enqueue/start/end around actual synchronous execution and expose query identity/duration and event-loop delay.

**Confidence:** high for synchronous native execution and separate readers; medium for lack of priority admission; low for storage as cause of current 90+ second catalog timings.

## End-to-end paths and reverse demand

Agent catalog: `AgentV2/Agent config -> LocationServiceMap -> /api/agent LocationMiddleware -> query cache loadAgentsQuery -> startup/agent-picker consumers`. Reverse: startup needs selectable agent metadata, so it schedules the catalog query; the request reaches a location graph containing execution-adjacent services. A narrow owner should resolve the fields from config once per explicit location and publish the same compact projection to both V1 and current clients.

Provider catalog: `workspace config + ModelsDev + credentials/provider catalog -> Provider handler -> /provider group middleware -> InstanceStore + bootstrap gate -> client provider query -> model selector`. Reverse: model selector asks for choices; current group uses an instance only because the route group couples catalog GET to OAuth actions. Split read ownership from mutation ownership and preserve provider/account semantics at the projection boundary.

Storage: `domain query/transaction -> Database client -> SQLite native sync call -> Node event loop -> HTTP/SSE/cancel scheduling`. Reverse: each route waits for its result, but any native call on that event loop can prevent unrelated callbacks. Dedicated read connections address one semaphore bottleneck, not event-loop isolation or single-writer priority.

## Concrete architecture

1. Define an explicit-location `AgentCatalog` Tier 2 owner from canonical config resolution. It returns a revisioned, browser-safe projection including the system prompt field Agent Studio actually needs. Keep V1 as the product client/API contract and add a narrow adapter; current UI compatibility may consume the same projection. Do not make V1 startup call `/api/agent` to obtain a richer shape.
2. Split provider catalog reads from OAuth/action routes. Catalog resolution may use explicit config and durable credentials, with a bounded refresh owner for external metadata; it must not create an execution instance. Keep auth mutation and any action that genuinely needs runtime in a separate route.
3. Make all server workspace/catalog APIs fail on missing location. Derive location only from an addressed durable session/workspace or require explicit input. Assert zero LocationServiceMap/InstanceStore acquisition for Tier 0/1 and zero full execution graphs for catalog-only calls.
4. Instrument before queue redesign: correlate request ID through route, location-map build/cache hit, each `InstanceBootstrap.gate` stage, provider discovery, SQL sync execution, response write. Separate request wait, service construction, external wait, DB native time, and event-loop delay. A total handler span cannot identify a 93 s blocker.
5. If traces confirm synchronous storage is blocking control, move native query execution to a storage worker/process behind a single authoritative service. Add explicit short-transaction admission for session control/lifecycle and bounded/fair background work; preserve the existing DB file and lease/order semantics. Separate SQLite handles alone are insufficient.

## Evidence, measurements, and hypotheses

- **Measured (parent ledger):** installed `/api/agent` request elapsed 93.6 s; `/provider` 101.1 s. These are total resource/service durations, not per-stage CPU evidence.
- **Build-confirmed (parent):** installed app bundle contains the current-first V1 branch; installed main bundle compiles `buildLocationServiceMap`.
- **Source-confirmed:** current agent uses LocationMiddleware and LocationServiceMap; map compiles full locationServices group; provider read's route group enters InstanceStore/bootstrap; node SQLite calls are synchronous; configured busy timeouts are 5 s and 250 ms.
- **Not demonstrated:** which layer consumed either long request; all graph services doing expensive work on acquisition; current-first switch being slower than legacy V1 `app.agents`; SQLite being the initiating stall; provider discovery/plugin init duration; whether cwd fallback occurred in measured requests.

No tests or benchmarks were run for this audit. The next discriminating measurement is a controlled trace of a cold and warm catalog request with spans around graph acquisition and each bootstrap/catalog stage, followed by a negative test that deliberately blocks optional catalog/plugin work while session control acknowledgement remains responsive.

