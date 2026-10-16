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

## October 3 continuation: cold draft `GET /project/current` ownership

The full-app cold draft route requests `ctx.sdk.api.project.current({ location })`
from `packages/app/src/pages/home/home-controller.ts` when it needs active
project identity; global directory hydration also requests the same endpoint
from `packages/app/src/context/global-sync/bootstrap.ts`. Before the fix, the
`project.current` operation lived in the shared `ProjectApi` group, whose
`InstanceContextMiddleware` called `InstanceStore.load` for the explicit routed
directory. The handler then read `InstanceState.context.project`, so an identity
read was gated on runtime bootstrap. That bootstrap calls
`Project.Service.fromDirectory`, which can migrate project IDs, write project
and directory rows, relink sessions/workspaces, emit project events, and launch
favicon discovery. The response body was small; its producer path was not.

The `/project/current` path, `project.current` operation ID, query contract, and
`Project.Info` response schema are preserved in a dedicated explicit-location
route group with WorkspaceRouting + Authorization and no InstanceContext. Its
handler calls `Project.Service.currentForDirectory`: canonical ID/worktree/VCS
still come from `ProjectV2.resolve`; an existing durable Project row supplies
name/icon/commands/time/sandbox metadata; a previous ID row is read as a
migration fallback without mutation; missing rows receive the same default
project projection. It does not migrate IDs, write project/directory/session/
workspace state, emit events, or discover icons. List, initGit, update, and
directories remain under their existing project/runtime route owner.

The reverse demand path is: a cold draft needs a project identity to resolve
project-scoped UI/session context -> the SDK calls `project.current` for the
selected explicit location -> WorkspaceRouting validates/owns that location ->
ProjectV2 resolves canonical identity and Project's read-only row projection
returns `Project.Info`. The required work scales with project/Git identity
resolution and one durable row read, not InstanceStore bootstrap, plugins, tool
reload, or warmup. Missing or relative locations fail with 400; the route has
no cwd fallback.

Evidence: `bun test test/server/httpapi-project-current-location.test.ts`
passed one real HTTP test / seven assertions using the production route group,
handler, and Project service, with a route graph that provides no InstanceStore.
It checks the unchanged endpoint response identity/worktree/VCS/sandbox fields,
rejects missing and relative locations, and verifies that answering the cold
read does not write the ProjectV2 repo-local identity cache or create a
ProjectTable or SessionTable row. SDK generation was rerun after the route
split; the response/client shape remains unchanged. This proves route-level
InstanceStore exclusion and read-only behavior; it is not a full Electron
cold-draft performance measurement. Package typecheck reports no diagnostics in
this route, service, or test; the command remains non-green because concurrent
`test/session/capability-invocation-gateway.test.ts` has unrelated type errors.
An adjacent project-copy/initGit suite attempt under the same concurrent load
hit the generic 5 s timeout and Windows cleanup `EBUSY` in two cases; this is
not evidence those full integration paths passed. The focused HTTP ownership
gate and SDK build both pass.

## October 3 continuation: cold Home `GET /config` ownership

The full-app cold Home trace found that V1 directory hydration's deferred
`sdk.config.get()` (`packages/app/src/context/global-sync/bootstrap.ts`) was the
first route to materialize an execution Instance before any prompt. The request
used an explicit directory, but `/config` shared `InstanceContextMiddleware` with
the config mutation and provider-catalog operations. Its handler called
`Config.Service.get()`, whose first read runs the full per-location config
initializer: project discovery, plugin path normalization, command/agent/plugin
catalog scans, `.gitignore`/default-config writes, a detached NPM install, and
Console token environment mutation. The initializer was therefore both the wrong
route owner and a source of avoidable project-open work.

The fix splits the unchanged `GET /config` path and `config.get` operation ID into
a WorkspaceRouting + Authorization Tier-2 read group. It still requires the
explicit location selected by the normal workspace routing contract, resolves
the project worktree without persisting Project state, and reads the same
effective V1 config precedence/projection. The new `Config.getForLocation` uses
an independent bounded 32-location cache, with shared global config and
invalidation on config mutation. Its read-only config path does not write schema
defaults or legacy migrations, create `.gitignore`, install NPM dependencies, or
mutate the Console-token environment. PATCH and `/config/providers` remain under
their prior instance/runtime owner.

Evidence: `bun test test/server/httpapi-config-location.test.ts` passed 1 HTTP
test / 7 assertions, using the production route group, handler, and Config
service with no `InstanceStore` service in the route graph. An explicit temporary
workspace's on-disk config is returned; omitted and relative locations return
400; NPM install count stays zero; no `.gitignore` is created; and config bytes
remain unchanged. Combined with the existing mutation and provider-shape checks,
`bun test test/server/httpapi-config.test.ts test/server/httpapi-config-location.test.ts`
passed 3 tests / 12 assertions. This is a focused ownership gate, not the
end-to-end Electron startup closeout; rerun the full-app Home gate to confirm its
production route graph now creates zero instances before prompt admission.

## October 3 continuation: explicit-location `GET /vcs` branch metadata

The cold draft/full-app route also requests `GET /vcs`. Before the fix,
`InstanceApi` grouped this branch metadata read with `/vcs/status`, diff, and
apply under `InstanceContextMiddleware`; its handler called `Vcs.Service`, whose
branch/default-branch methods read `InstanceState`. That meant asking for two
small Git metadata fields required `InstanceStore.load` and the instance's VCS
state initialization.

Only `GET /vcs` now lives in a dedicated explicit-location read group with
WorkspaceRouting + Authorization. It calls the shared `Git.Service` directly
with `WorkspaceRouteContext.directory` and returns `{ branch, default_branch }`
from `Git.branch(directory)` and `Git.defaultBranch(directory)?.name`. The URL,
`vcs.get` operation ID, query fields, and `Vcs.Info` schema are unchanged.
`/vcs/status`, diff, raw diff, and apply remain under the instance middleware.
This removes VCS state/watchers and full execution bootstrap from a branch-label
read; the necessary work is two explicit-directory Git metadata queries.

Evidence: `bun test test/server/httpapi-vcs-branch-location.test.ts` passed a
real HTTP gate (1 test / 9 assertions) with production API/handler, actual Git
service, and a route graph that contains no `InstanceStore`. It compares git
and non-git responses to direct Git service results (including the current
wire's null fields for a non-git directory), and proves missing/relative
locations return 400. SDK generation completed successfully with generated
client files unchanged. Package typecheck reported no diagnostics in the VCS
route, handler, or HTTP test; it remains non-green due unrelated diagnostics in
`test/session/capability-invocation-gateway.test.ts`. This gate does not measure
a complete Electron session open.

## October 3 continuation: defer command catalog until slash demand

The cold Home trace then found `GET /command` as the first remaining request to
materialize an Instance. V1 directory bootstrap invoked `loadCommands` from its
MCP-enabled late phase, and `createDirSyncContext` asks for that phase during
ordinary directory hydration. The reverse demand path is narrower: the catalog
is consumed by the V1/V2 prompt slash suggestions and by submit-time leading
`/name` resolution. `Command.Service.list()` joins workspace config commands,
connected MCP prompt descriptors, and discovered Skills, so replacing it with a
partial cheap projection would silently change the command surface and would
still need explicit ownership decisions for MCP and Skill discovery.

The repair removes command listing from both directory bootstrap and the child
store's MCP activation callback. `ServerSync.commands.ensure(directory)` now
starts the unchanged V1/V2 catalog request only when either composer opens its
slash picker or a submit begins with `/name`. Slash suggestions and submit share
one per-directory in-flight/result owner and use interactive request priority;
ordinary prompt submits do not request the catalog. The owner commits once,
retries after a failed request, and rejects results invalidated by disposal,
config/command updates, MCP refresh, or a selected-target change. MCP status and
resource synchronization remains under its existing demand path.

Evidence: `bun test --conditions=solid --preload ./happydom.ts
src/context/global-sync/command-catalog.test.ts` passed 4 tests / 14 assertions
for shared concurrent demand, one commit, failure retry, invalidation fencing,
stale-target rejection, and retry after a still-current catalog invalidation. The same app harness passed
`src/context/global-sync/bootstrap.test.ts` (25 tests / 62 assertions), including
the negative check that MCP-enabled directory bootstrap leaves `command` empty
and performs no command read, and `src/context/global-sync/child-store.test.ts`
(6 tests / 48 assertions). `src/components/prompt-input/submit.test.ts` passed
9 tests / 30 assertions, including zero catalog loads for ordinary prompt and
one load before resolving `/review`. The session-ui controller test passed 1
test proving V2 slash intent opens the demand callback once across repeated
typing. App typecheck has no diagnostics in touched files; it remains red on
three unrelated implicit-any diagnostics in `pages/session/v2/chat-sidebar-tree.test.ts`
(lines 361–363). Session-ui typecheck passed. This is source-level demand
ownership evidence; rerun the full-app Electron gate for the final cold
Home/new-session/session-detail request count.

### October 5 complete timeline recovery and presentation ownership

`PartTable -> MessageV2.timelinePartsBatchPage -> SessionRead handlers -> unified
SDK sessionRead adapter -> createServerSession recovery owner -> canonical part
store -> virtual timeline row -> session-ui Markdown/tool display` is the current
detail path. The reverse demand is an explicitly active timeline, not a sidebar
badge, prefetch, or per-message component. The batch route is Tier 1: durable
session/message ownership and current-part overlays, with no execution Instance
materialization. Admission is at most 200 message owners per batch and one request
at a time per session; part pages are capped at 512 items / 2 MiB, with a single
oversized row allowed alone to ensure progress. More than 200 loaded owners drain
in successive batches rather than becoming an error. Older batch snapshots cannot
overwrite live changes or resurrect removed messages/parts; refreshed bootstrap
windows retain their new recovery ownership.

This supersedes the earlier one-message-at-a-time recovery description. The client
has no fallback to N keyed message reads or N per-message timeline-part requests.
Failure and retry are session-scoped. Activated detail surfaces recover all durable
parts; hidden prefetches do not start complete content drains. The app regression
suite passes 106 tests / 267 assertions, including 450 owners draining in three
batches, missing-route failure without fan-out, live text/tool completion winning
over an old snapshot, removal tombstones, and fresh-window replacement.

Presentation has two separate authoritative facts: paint visibility comes from
intersection plus CSS/document visibility; accessibility exposure comes from ARIA.
The former must not depend on the latter. Likewise, app-owned scroll gestures are
the source of follow/escape intent; virtual measurements, browser clamping, and
accordion resizing are not evidence of user scrolling. Markdown workers and the
DOM scheduler remain presentation-only and introduce no server/history requests.

Delegated human interjection uses the durable worker metadata owner, independently
of producer configuration ownership. Canonical prompt and user-action admission
bind protected selection for both root and nested workers. The server emits an
O(1) `humanInterjection` capability on existing V1 session snapshots/events; the
GUI uses it for composer visibility and conversational submission without catalog
readiness, auto-accept mutation or history-derived delegation inference.

Stop remains a bootstrap-free process-global execution-owner operation. It now
permits valid delegated workers and revokes only the observed recovery generation
after a successful interrupt; stale aborts cannot erase a newer recovery cursor.
Permission/question replies use the active-response registry's authoritative
request location, preserving explicit query/workspace fences while accepting
ambiguous raw/encoded percent-containing headers. No execution instance is loaded
for these responses. October 5 human-interjection tests cover blocked bootstrap,
nested/root ownership, occupied/paused/stopped input, aggregate-mutation denial,
and delayed stale cancellation; detailed measurements and limits are in the main
investigation ledger and `human-interjection-*.log` evidence.

Swarm containment now settles task-owned unknown outcomes before removing Session
hazards or releasing generation fences. Session-owned orphan recovery validates
the authoritative member binding and routes any existing lease back to the task
owner; OXP/native tools and the explicit shell fallback use that same service.
Resume readiness is shared by HTTP and OXP and refuses unresolved dead-generation
effects before clearing pause. Aggregate age scans coalesce across operational
wakes; exact-binding renewal discovery prevents impossible immediate deadlines.
See `swarm-session-recovery-2026-10-05.md` for the actual live trigger, negative
invariants, recovery evidence, and remaining closure limits.

