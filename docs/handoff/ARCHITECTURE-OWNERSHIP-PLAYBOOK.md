# Architecture Ownership Playbook

This playbook exists because the instance-bootstrap/concurrent-session incident
was not a one-line performance bug. It was an architectural process failure: the
implementation optimized a consumer-owned reconstruction path instead of proving
where the data should be owned.

Use this document when a task crosses storage, runtime, server, transport,
client state, Electron, or dense UI. The root `AGENTS.md` is the mandatory short
contract; this file is the longer reasoning model.

## 1. Product requirement is not data ownership

A visible component may define the user-facing fact:

- "show whether a session is thinking";
- "show context pressure";
- "show which model is active";
- "show whether a token is valid";
- "show pricing/usage information";
- "show whether a project moved".

That does not mean the component owns the computation. Treat the UI as the
requirement caller, then work backward only far enough to name the fact. After
that, switch directions and design outward from the producer.

Correct framing:

```text
fact needed -> authoritative producer/table/event -> owning service/lifetime
-> ownership tier -> minimal projection -> route/transport -> client cache
-> presentation
```

Incorrect framing:

```text
component needs display -> existing SDK method exists -> response looks small
-> add scheduler/hover delay/cache -> declare it cheap enough
```

## 2. The ownership ladder

Classify the fact before choosing a route.

### Tier 0: process/global truth

Facts that belong to the running process or global durable store. Examples:
health, identity, auth/token validation, paired devices, global preferences,
global project catalog, global event transport, aggregate usage/quota.

Design pressure: zero workspace instance creation, no `Location.Service`, no
workspace config, no plugin/tool/LSP/VCS/snapshot dependencies.

### Tier 1: durable location metadata

Facts indexed by a directory, project, workspace, or session but answerable from
durable metadata. Examples: recent root sessions for a directory, project row,
workspace row, session row aggregates, move metadata, cheap path normalization.

Design pressure: explicit location is allowed, but the answer still must not
bootstrap the execution runtime.

### Tier 2: workspace configuration/catalog

Facts requiring workspace config/catalog resolution but not execution. Examples:
resolved provider/model catalog for a directory, workspace agents/commands, MCP
metadata, config-derived choices.

Design pressure: require explicit location, initialize only the narrow config
services needed, and do not leak into execution services by route-group accident.

### Tier 3: execution/runtime

Facts/actions that require the runtime: prompts, tool calls, shell/PTY, file
mutation, VCS/snapshot mutation, permissioned workspace execution, live LSP or
formatter work.

Design pressure: full instance creation can be correct here, but it still needs
attribution, bounded background work, cleanup, and a specific runtime reason.

## 3. Architectural smells

The following are stop signs, not optimization TODOs.

### Small response, huge ownership

If the response body is tiny but the path crosses
`WorkspaceRoutingMiddleware -> InstanceContextMiddleware -> InstanceStore.load`,
the route is not cheap. You must account for project resolution, config, plugin
init, tool reload, warmup, watchers, and service caches.

### Optional directory with cwd fallback

Optional location is dangerous on server routes. If missing input can become
`process.cwd()`, the route has silently selected an owner the caller did not
choose. Cwd fallback is acceptable at CLI command admission, not inside server
routing semantics.

### Metric-only history hydration

Hydrating message/part history solely to draw sidebars, badges, rows, tab
labels, context indicators, cache ratios, model labels, or thinking state is a
data-ownership bug. Dense UI needs materialized row fields or compact telemetry.

### Admission control as architecture

Schedulers, semaphores, queues, lazy imports, shared clocks, hover delays,
viewport gates, and caches are useful guardrails. They do not justify an
operation that should not exist at that layer.

### Route group inheritance

`provider`, `session`, `config`, `project`, and similar nouns can contain mixed
ownership tiers. Do not let one runtime-heavy sibling force cheap durable reads
through the same middleware.

### Semantic inference from artifacts

If the runtime emits `reasoning/text/tool/step/status` events, the UI should not
infer state from absence, message shape, or rendered part structure. Project the
semantic lifecycle where it happens.

### Hidden UI as a worker

Keep-mounted panels, hidden tabs, popovers, inactive context panes, and invisible
sidebars are not free. They must not keep provider catalogs, session hydration,
global streams, or timers alive unless that work is still product-visible and
bounded.

## 4. The bottom-up design worksheet

Before coding cross-layer behavior, fill this in mentally or in the task doc.

```text
User-visible fact:
Authoritative producer/table/event:
Owning service and lifetime:
Ownership tier:
Existing materialized field/event/projection:
Missing projection, if any:
Required route and middleware:
Could missing input reach process.cwd()? yes/no
Does this call enter InstanceStore? yes/no; why is that necessary?
Concurrency multiplier: sessions / rows / parts / listeners / bytes / projects
Negative invariant test:
Trigger-state benchmark:
Removal candidate before optimization:
```

If the worksheet says `InstanceStore: yes` and the fact is health, auth,
global usage, preferences, durable session metadata, startup project catalog, or
sidebar telemetry, the design is almost certainly wrong.

## 5. Projection design principles

When many consumers need small facts, project once upstream.

- Prefer incremental updates from the producer over polling derived state from
  histories.
- Prefer scalar/materialized snapshots over arrays of artifacts that clients scan.
- Keep live overlays bounded by TTL/LRU and separate from durable history.
- Coalesce transport updates; do not turn telemetry into another raw delta stream.
- Batch snapshot reads by session/project IDs instead of N per row.
- Preserve detail views: full history remains valid when the user opens a rich
  session page. It is not valid as background decoration infrastructure.

Session telemetry is the reference pattern: execution already knows request,
model, text, reasoning, tool, streamed, ended, retry, and idle transitions. The
right sidebar contract is a compact projection of those transitions, not a row
component repeatedly walking `Message[]` and `Part[]`.

## 6. Route design principles

Routes should make ownership visible.

- Tier 0 routes live on root/global surfaces and never use instance middleware.
- Tier 1 routes may accept explicit directory/session/project identifiers but
  should read durable storage or process-global state directly.
- Tier 2 routes require explicit location and should initialize only config or
  catalog services actually needed.
- Tier 3 routes require explicit runtime ownership and may enter `InstanceStore`.
- Missing location on Tier 2/3 should fail closed or be derived from an addressed
  session/workspace row. It should not become cwd.
- If a generated SDK namespace is misleading, trust the URL and middleware, not
  the namespace name.

## 7. Concurrency model

Think in multipliers, not averages.

Ask what scales with:

- active sessions;
- visible rows;
- hidden mounted rows;
- message count;
- part count;
- event rate;
- provider/catalog size;
- listener count;
- project/workspace count;
- bytes retained in queues or replay buffers;
- SQLite work under write pressure;
- Electron renderer long tasks.

Then ask whether the system has one shared owner or N mostly-idle copies. The
best optimization is often replacing N reconstructed computations with one
producer-owned projection.

## 8. Closure standard

A fix is not closed because the code looks cleaner or a local benchmark improved.

Closure needs:

- the actual trigger state, not an adjacent easier state;
- before/after evidence for the scarce resource that was binding;
- negative invariants that catch the ownership bug;
- teardown evidence where listeners/watchers/timers/fibers are involved;
- scoped conclusions that do not overclaim beyond the scenario measured.

Examples:

- Startup first paint does not prove selected/working sidebar behavior.
- A browser-only profile does not prove Electron chrome + sidecar behavior.
- One active timeline does not prove six concurrent sessions plus sidebar rows.
- A successful response does not prove zero implicit instance creation.
- Bounded scheduler wait does not prove the scheduled work should exist.

## 9. Review heuristics for agents

When reviewing a proposed patch, ask these in order:

1. What fact is being displayed or acted on?
2. Who already knows that fact first?
3. Is the proposed owner closer to the producer or merely closer to the UI?
4. Does the route cross instance middleware?
5. Does any missing location fall back to cwd?
6. Does the implementation hydrate a large structure to compute a small scalar?
7. Is there an N-per-row/session/timer/listener multiplier?
8. Is the patch deleting unnecessary work or only scheduling it more politely?
9. What negative invariant would fail if the old bug came back?
10. Was that invariant tested under the triggering workload?

The desired agent behavior is not "always backend first." It is: **source of
truth first, owner second, projection third, client last.**

