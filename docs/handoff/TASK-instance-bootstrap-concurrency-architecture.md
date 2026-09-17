# TASK: Instance Bootstrap, Concurrent-Session Clogging, and Shared-Ownership Architecture

## 0. Metadata

- **Created:** 2026-09-16 UTC
- **Scope:** `/webstormprojects/opencode`
- **Status:** ACTIVE / evidence-driven remediation campaign
- **Supersedes for current work:** `docs/handoff/TASK-concurrent-session-lag.md`
- **Do not delete predecessor:** it contains useful historical hypotheses and falsifications.

## 1. Mission

Eliminate the remaining concurrent-session clogging by fixing the architectural mechanisms that multiply work under load, rather than repeatedly shaving cost from individual copies of the same machinery.

The current campaign has exposed a second, broader problem: **read-only/global/bootstrap operations can accidentally materialize a complete workspace instance**. A full instance may initialize configuration, plugins, tools, VCS, snapshotting, formatting/LSP services, listeners, watchers, and other runtime state. That is unacceptable when the caller only needs a token check, process metadata, session status, pricing/catalog data, or another global/read-only answer.

The `$HOME` instance is the loudest reproduction because `$HOME` contains broad config/plugin state, but **the architectural bug exists even for an empty or one-file directory**. Unnecessary instance creation is unnecessary instance creation.

This document is the durable campaign ledger. Update it when a hypothesis is confirmed/falsified, when instrumentation is added/removed, and when a phase closes.

## 2. Non-negotiable invariants

### I1 — No implicit workspace ownership

**A request that does not explicitly identify a directory/workspace must not materialize an instance by falling back to `process.cwd()`.**

`process.cwd()` may be a CLI convenience at an outer command boundary. It is not a valid hidden routing decision for server APIs.

### I2 — Read-only/global queries cannot create execution runtimes

Health, auth/token validation, project catalogs, durable session indexes, active-session status, usage/pricing metadata, global config/preferences, capability discovery, and similar reads must be served by bootstrap-free/global services or lightweight storage/location services.

They must not initialize the full workspace execution graph.

### I3 — Instance construction must have an explicit reason

Every full instance materialization should be attributable to:

1. an explicit location supplied by the caller; and
2. an operation that actually requires workspace runtime services.

If we cannot answer "which request created this instance and why was a full runtime necessary?", observability is insufficient.

### I4 — Shared ownership beats N cheaper copies

For dense UI and concurrent-session surfaces, prefer one shared controller/runtime/cache/observer/portal with lightweight per-item intent/data over N individually optimized controller graphs.

This applies to tooltips, floating cards, session-derived metrics, model metadata, timers, observers, stream consumers, and other repeated per-row machinery.

### I5 — Background work must remain bounded under concurrency

A bad session/plugin/caller must not be able to create an unbounded scheduler retry loop, SSE/event fan-out loop, listener accumulation, async-prompt storm, or renderer queue storm.

Admission control and circuit breakers belong at ownership boundaries, not only in callers.

### I6 — Measure before claiming closure

Do not call a cause fixed because the code looks right. Verify with fresh-process runtime evidence: request paths, instance creation count/reasons, CPU, memory, listener counts, request service times, renderer long tasks, and event rates.

## 3. Ground-truth incident: concurrent-session freeze

### 3.1 Backend stall was real, not just renderer perception — `[VERIFIED]`

During a live freeze:

- renderer requests were admitted with essentially no scheduler wait;
- backend service time ballooned instead:
  - `session-active` ~27.5 s;
  - `session-info` ~27.4 s;
  - `provider-list` ~17.5 s;
  - protocol detection ~5 s;
- renderer working set reached roughly 2.8–2.9 GB;
- backend utility memory reached roughly 1.2–2.3 GB during the observed incident;
- both renderer and backend utility consumed substantial CPU during the frozen intervals.

**Implication:** renderer scheduling alone cannot explain the incident. The backend process was being globally obstructed by pathological work.

### 3.2 Async prompt failure storm — `[VERIFIED]`

Server logs showed repeated `prompt_async failed` events at roughly 250–500 ms cadence. Before the original process was killed, the observed failure count exceeded 1,600 and was still increasing.

Prominent storming sessions were OpenSwarm members such as `pwh1-adversary` and `asset-frontier`.

Healthy swarm sessions were created with a valid OpenCode agent. Broken sessions had been persisted with `agent=localMCP-chat`, which is an MCP/tool namespace rather than a valid OpenCode agent.

### 3.3 Failure loop — `[VERIFIED]`

Observed mechanism:

1. invalid agent persisted on session creation;
2. `prompt_async` returned HTTP 204 before asynchronous execution failed;
3. prompt execution detected `Agent not found` and published `session.error`;
4. OpenSwarm released the task without retry cost and marked the member idle;
5. scheduler immediately reclaimed the same ready task for the same idle member;
6. `prompt_async` was issued again;
7. loop repeated indefinitely.

There was also a duplicate-error amplification path: `SessionPrompt` could publish the detailed error and the async HTTP handler could publish another generic error after the forked effect failed.

## 4. Fixes already implemented in this campaign

### F1 — Reject invalid session agent at admission — `[IMPLEMENTED, TESTED]`

`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`

Session creation now rejects an unknown agent instead of persisting a configuration state that can only fail later during asynchronous prompt execution.

Targeted session lifecycle regression passed. Package typecheck showed only a pre-existing unrelated error in `script/spad-repo-null.ts` during the original pass.

### F2 — OpenSwarm no longer hot-loops an errored member — `[IMPLEMENTED, TESTED IN OPENSWARM]`

OpenSwarm supervisor behavior was changed so a non-abort worker `session.error` no longer returns the same member to immediate-idle eligibility:

- transient/systemic error -> `interrupted`;
- deterministic configuration error -> `failed`;
- duplicate late errors cannot resurrect an already stopped/stopping/failed member;
- released work may still be assigned to another healthy member.

Focused regression tests passed, including the deterministic unknown-agent case and scheduler non-reassignment invariant.

### F3 — Chat sidebar tooltip architecture changed from N controllers to one shared controller — `[IMPLEMENTED, LIVE-VERIFIED]`

`packages/app/src/pages/session/v2/chat-sidebar-pane.tsx`

The chat pane now follows the same architectural class as the model-selector tooltip system:

- one delegated hover/focus state machine for the pane;
- one tooltip portal;
- one positioning owner;
- rows/controls publish lightweight tooltip intent via metadata;
- at most one active text observer;
- rich session hover card and simple tooltips share the same owner.

Live measurement at the same persisted UI state:

- 69 tooltip targets preserved;
- Kobalte `TooltipV2` roots in the pane: **69 -> 0**;
- pane DOM: roughly **550 -> 484 nodes** (~12% reduction at that state);
- idle portal count: 0;
- hover portal count: exactly 1;
- tooltip-to-tooltip handoff keeps one portal;
- leave tears down to 0;
- ARIA and live text updates verified.

A generic pooled observer optimization remains useful for `TooltipV2` elsewhere in the application.

### F4 — Dev-token validation no longer probes `/config` — `[IMPLEMENTED, TESTED, LIVE-VERIFIED]`

`packages/mobile/dev/agent-token-provision.ts`

The desktop mobile-dev token validator used `/config` as an authenticated liveness probe. With no explicit directory, that route fell back to `process.cwd()` and materialized a complete `$HOME` instance merely to test whether a token still worked.

Probe changed to bootstrap-free `/global/health`.

Focused mobile token suite: **11 pass / 0 fail**.

Live effect: the immediate startup `$HOME` instance disappeared.

### F5 — Global path bootstrap prefers bootstrap-free global health metadata — `[IMPLEMENTED]`

`packages/app/src/context/global-sync/bootstrap.ts`

Global bootstrap no longer needs to ask instance-scoped `/path` with no directory on current servers. `/global/health` path metadata is preferred, with legacy fallback retained for old servers.

### F6 — Active-session bootstrap prefers current global-safe endpoint — `[IMPLEMENTED, TESTED]`

`packages/app/src/utils/server-compat.ts`
`packages/app/src/context/server-sync.tsx`

Hybrid/current servers can expose the current active-session endpoint while compatibility detection still reports `v1`. Compatibility now tries the current endpoint first and falls back to legacy `/session/status` only when required by an actually old server.

Focused compatibility suite: **17 pass / 0 fail**.

### F7 — Session-context valuation no longer starts an unnecessary global provider query — `[IMPLEMENTED, NEEDS FINAL REPRO]`

`packages/app/src/components/usage/use-usage-valuation.ts`
`packages/app/src/components/session/session-context-tab.tsx`

The session context tab already owns the authoritative directory-scoped provider/model catalog. It nevertheless started a second global provider query for valuation fallback while the keep-mounted tab was hidden.

`createUsageValuation` now supports disabling the global catalog; session context uses scoped providers only. The genuinely directory-agnostic `/usage` page retains global catalog behavior.

This removes one class of hidden global/provider work without changing session pricing/model semantics.

## 5. Remaining `$HOME` instance — current highest-priority investigation

### Current reproduction — `[VERIFIED, FIXED FOR STARTUP]`

After F4/F5/F6, clean startup no longer creates `$HOME` immediately. The first instance is the actual active PresGEN project.

The delayed `$HOME` instance was instrumented at the workspace-routing fallback and identified exactly:

- `GET /provider` arrived with no explicit directory/header;
- `WorkspaceRoutingMiddleware.defaultDirectory()` fell back to `process.cwd()`;
- that immediately materialized `$HOME` through `InstanceContextMiddleware -> InstanceStore.load()`;
- the resulting `$HOME` bootstrap paid config + plugin + toolReload + warmup services solely for a provider/catalog read.

Two client owners were then found and fixed:

1. `pages/layout.tsx` constructed `useProviders(() => undefined)` solely to decide whether to display the getting-started provider banner. It now scopes that provider check to the active directory.
2. `session-composer-controls.ts` launched both the correct directory provider query and a second `providers(null)` query; the global query was used only as part of the model-loading boolean. The duplicate global query was removed.

Fresh-process verification then ran for more than 60 seconds with the temporary fallback probe enabled. The only full instance created was the explicitly active PresGEN project; there were **zero** implicit-cwd probe hits and **zero** `$HOME` instances.

The temporary router probe has been removed.

### Remaining architectural requirement

Startup is clean, but the fallback itself is still architecturally unsafe. Phase B must remove the ability of server APIs to silently invent a workspace from `process.cwd()` and add permanent bounded attribution so every full instance materialization can be explained.

Permanent attribution should record:

- HTTP method;
- pathname;
- explicit directory/workspace input if present;
- whether routing used a fallback;
- resolved directory;
- request/correlation id if available;
- instance cold/warm result;
- bootstrap reason/service owner.

For development diagnostics, also record a compact caller/category tag where practical. Do not retain noisy stack dumps in production hot paths.

The original startup acceptance criterion is now satisfied:

> A fresh startup can run for at least 60 seconds without materializing `$HOME` unless a user action explicitly targets `$HOME`.

Do not treat that as campaign closure; it proves only that the known startup callers were removed.

## 6. The larger instance-ownership problem

The campaign must not stop after the final `$HOME` trigger is removed.

### Problem statement

Today, an instance-scoped route can cause a monolithic runtime bootstrap. This couples cheap reads to expensive execution services. The cost is wrong even when the target directory is tiny.

### Required architectural separation

Classify server operations into service tiers and make dependencies explicit.

#### Tier 0 — Process/global services

Examples:

- health / identity / protocol capability;
- auth and device-token validation;
- global config/preferences;
- durable project catalog;
- global active-session status/index;
- usage/quota/account metadata;
- global event transport control.

**Must never require a workspace instance.**

#### Tier 1 — Durable location metadata

Examples:

- project/workspace identity for an explicit directory;
- durable session root/index reads;
- cheap path/location normalization;
- stored metadata that can be answered from DB/files without execution runtime.

May require an explicit location, but **must not initialize plugins/tools/LSP/VCS/snapshot simply because a location exists**.

#### Tier 2 — Workspace configuration/catalog

Examples that may genuinely need directory-local config:

- resolved provider/model catalog;
- agents/commands derived from workspace config;
- MCP/config metadata.

This tier should pay only the services it actually requires. Audit whether the present monolithic instance can be decomposed or lazily service-loaded.

#### Tier 3 — Execution/runtime services

Examples:

- prompt/tool execution;
- plugin runtime;
- shell/PTY execution;
- LSP/format where requested;
- VCS/snapshot mutations where requested.

Only this tier should justify the full execution graph, and even here expensive services should be lazy where possible.

## 7. Required endpoint audit

Build an inventory of every route/middleware path that can call location/instance creation. For each endpoint record:

| Endpoint/category | Explicit location required? | Current bootstrap tier | Correct tier | Can fallback to cwd? | Fix/status |
|---|---:|---:|---:|---:|---|
| `/global/health` | no | 0 | 0 | no | good |
| dev token probe | no | formerly full instance via `/config` | 0 | formerly yes | F4 fixed |
| global path bootstrap | no | formerly instance `/path` | 0 | formerly yes | F5 fixed/current-first |
| active sessions | no | formerly legacy `/session/status` | 0 | formerly yes | F6 current-first/fallback |
| session-context valuation | session dir exists | formerly extra global `/provider` | 2 scoped | formerly yes | F7 fixed, verify |
| remaining delayed `$HOME` request | unknown | full instance | unknown | likely | **OPEN** |

Expand this table comprehensively from source. Do not stop at routes observed in one startup.

## 8. Instance bootstrap audit

Read and map the current construction path, including at minimum:

- workspace routing middleware;
- location service map;
- instance context/provider;
- project bootstrap;
- config service initialization;
- plugin/tool reload initialization;
- VCS/snapshot/format/LSP startup;
- event/listener registration;
- disposal/reference ownership.

Answer these questions with source evidence:

1. Which services are eagerly initialized for every instance today?
2. Which are actually needed by each endpoint class?
3. Which service constructors register listeners/watchers/timers even when unused?
4. Can service layers be lazily memoized independently inside a location instead of booting as a monolith?
5. Can read-only handlers depend on narrower services without touching `Instance` at all?
6. Does disposing an instance reliably remove every listener/watcher/timer it created?

## 9. Event/listener accumulation — still open

### Evidence — `[VERIFIED OBSERVATION, ROOT CAUSE UNPROVEN]`

During the freeze the backend logged an unusually high event-listener count around 50 and had many loopback connections.

OpenSwarm itself has a global singleton runtime, so do **not** claim one OpenSwarm runtime per project without new evidence.

### Work required

Instrument listener ownership by source/category:

- EventV2 subscribers;
- SSE/global event streams;
- per-location subscriptions;
- plugin listeners;
- desktop/browser bridge listeners;
- OpenSwarm subscriptions;
- any watcher-to-event bridges.

For each listener class track create/dispose counts and current live count. Reproduce navigation, project opening, multiple concurrent sessions, and app idle. Live count must converge after teardown.

## 10. Frontend redirect/DnD churn — still open

During the original freeze the renderer repeatedly threw `Too many redirects` with a captured stack through:

`tabs.tsx -> navigateTab -> titlebar-tab-strip -> titlebar-tab-nav`

Renderer also emitted repeated drag/drop teardown warnings such as nonexistent draggable/droppable/transformer removal.

These are real frontend defects/freeze multipliers, but backend stalls were independently proven, so do not relabel them as the sole root cause.

Required work:

1. patch redirect recursion/loop with an explicit navigation invariant;
2. identify why tab/project reconciliation repeatedly mounts/unmounts DnD registrations;
3. verify no warning/error storm under concurrent session updates;
4. re-profile renderer after backend fixes.

## 11. Shared-ownership audit for dense UI

The tooltip conversion established the preferred pattern. Audit remaining dense session/sidebar surfaces for repeated ownership:

- floating cards/popovers;
- model metadata derivation;
- per-row timers;
- observers;
- context/pricing calculations;
- duplicated Recent/project row runtimes;
- permission/question badges;
- live-rate calculations;
- sorting/grouping across unrelated project directories.

For each candidate ask:

> Can rows expose immutable/lightweight intent and let one pane-level owner perform the expensive work only for the active/visible item?

Do not automatically centralize cheap pure values. Centralize ownership graphs that allocate observers, timers, portals, subscriptions, or large reactive dependency trees.

## 12. Server-side circuit breakers / admission safety

After the active incident is stable, add defense in depth so one buggy caller cannot melt the process.

Candidates to evaluate with measurements:

- per-session async-prompt in-flight admission/deduplication;
- bounded repeated-failure backoff/circuit breaker;
- structured async prompt failure logging preserving actual nested cause;
- elimination/deduplication of duplicate `session.error` publication;
- per-instance/global request concurrency protection for expensive bootstrap work;
- cold-instance bootstrap coalescing so identical concurrent requests await one initialization;
- hard prohibition on implicit-cwd routing for server APIs.

Do not add generic throttles that merely hide ownership bugs. Prefer deterministic rejection/coalescing at the responsible boundary.

## 13. Execution sequence

### Phase A — Identify and eliminate the final implicit `$HOME` creation

- [x] Add targeted instance-admission/routing telemetry.
- [x] Fresh-process repro for >=60 seconds.
- [x] Capture exact endpoint and caller category for delayed `$HOME` creation (`GET /provider`).
- [x] Fix eager client owners that were requesting an implicit global provider catalog.
- [x] Remove temporary/noisy instrumentation.
- [x] Re-run fresh-process repro; prove only explicitly requested project instances exist for >60 seconds.

### Phase A2 — Lightweight session telemetry projection

The sidebar currently needs live observability such as:

- tokens/sec;
- whether the model is reasoning/thinking vs emitting visible text vs executing a tool;
- current context usage and context-window percentage;
- input/output/reasoning/cache-read/cache-write token counters;
- cache-hit ratio;
- model/provider/variant identity needed to interpret context limits;
- turn timing / generated-time metadata.

**This must not require materializing a full session UI/runtime, loading message history/parts, or creating a workspace instance.**

Required architecture:

- [ ] Inventory where each metric is produced today and distinguish authoritative provider-reported counters from renderer-derived approximations.
- [ ] Define a compact `SessionTelemetry`/`SessionActivity` snapshot keyed by session ID and owned by a global/session service, not by a location runtime.
- [ ] Update it incrementally from events already produced during execution; do not rescan messages/parts per row or per timer tick.
- [ ] Expose bootstrap-free global read/subscription semantics for active/recent sessions.
- [ ] Sidebar rows consume the tiny telemetry projection directly and never bootstrap a workspace solely for metrics.
- [ ] Keep the rich session/context panel free to load deeper history only when the user actually opens it.
- [ ] Use one shared cadence/clock only for display values that truly require wall time; counters/rates should update from incremental state rather than N timer-driven rescans.
- [ ] Preserve existing UX and metric fidelity, including thinking state, TPS, context percentage, and cache-hit information.
- [ ] Add memory bounds/TTL for completed-session telemetry so the global projection cannot grow forever.

#### A2.1 — Concrete telemetry contract

The projection should be keyed by `sessionID` and contain only compact state required by dense/global UI. Proposed shape (names may move during implementation, semantics may not):

```ts
type SessionTelemetry = {
  sessionID: string
  phase: "idle" | "requesting" | "reasoning" | "generating" | "tool" | "waiting" | "retrying"
  updatedAt: number

  model?: { providerID: string; modelID: string; variant?: string }

  // Current provider step / most recently settled provider step.
  step?: {
    assistantMessageID: string
    requestSentAt?: number
    firstTokenAt?: number
    streamedAt?: number
    completedAt?: number

    // Incremental live counters; never reconstructed by scanning part arrays.
    visibleChars: number
    reasoningChars: number

    // Provider-authoritative settlement counters when available.
    tokens?: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }

  // Full-session aggregates are already materialized on Session rows. Keep
  // these here only if doing so removes a second lookup; do not recompute them.
  aggregate?: {
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }
}
```

Derived UI values must be O(1):

- **thinking status:** `phase === "reasoning"` (authoritative lifecycle, not absence-based inference);
- **generating status:** `phase === "generating"`;
- **tool status:** `phase === "tool"`;
- **TPS:** live incremental char/token progress over one tiny rolling window, or settled provider tokens over the exact measured stream/request window; no `Part[]` scan;
- **context usage:** latest provider-reported step token total divided by the current model context limit; this matches the existing last-assistant-with-tokens semantics without loading message history;
- **cache-hit ratio:** aggregate/session-row cache-read / (`cache-read + fresh-input`) for the full-session badge, plus latest-step ratio if a live/turn-specific surface needs it;
- **cost:** existing materialized session aggregate;
- **model/variant:** existing session row or Step.Started/model-switch metadata;
- **elapsed state:** one shared UI clock may convert timestamps into display durations; the server should not emit timer ticks.

#### A2.2 — Ownership and transport rules

1. The telemetry owner is **global/session-scoped**, not location-scoped. Reading telemetry must never touch `InstanceStore`, `LocationServiceMap`, provider catalogs, plugins, tools, VCS, snapshot, LSP, format, or watchers.
2. The producer updates telemetry from events already emitted by execution:
   - Step.Started -> request/model/assistant identity;
   - Text.Started/Delta/Ended -> generating phase + visible-char progress;
   - Reasoning.Started/Delta/Ended -> reasoning phase + reasoning-char progress;
   - Tool.Called/Success/Failed -> tool phase / settlement;
   - Step.Streamed -> stream boundary;
   - Step.Ended -> authoritative provider usage/cost settlement;
   - retry/status/permission/question lifecycle -> retrying/waiting where available.
3. Content deltas may be coalesced internally. Telemetry must not re-broadcast raw content. Emit bounded telemetry updates (for example at a short cadence or on semantic phase changes) so 50 streaming sessions cannot create another event storm.
4. Initial reads use one bootstrap-free global snapshot endpoint keyed/batched by session IDs. Live updates use one global event/subscription channel. No N-per-row requests or N-per-session SSE streams.
5. Completed/idle entries retain only the latest compact settlement snapshot for a bounded TTL/LRU. Durable session aggregates remain in the session table; telemetry is not a second history database.
6. The rich context/session page may still load history when explicitly opened. Dense navigation/sidebar UI must not.

#### A2.3 — Current waste to delete after cutover

`chat-sidebar-pane.tsx` currently:

- queues `session.prefetch(session.id, 200)` merely to hydrate row metrics;
- dynamically imports context/rate aggregation modules for row metrics;
- scans message history and the global part map to compute accumulated generation/tool time;
- scans messages again to find the latest assistant/model;
- computes context usage by finding the last assistant with tokens;
- scans the active assistant's full `Part[]` every second for live progress/TPS;
- labels the fallback state "thinking" by exclusion rather than from reasoning lifecycle.

All of that metric-specific hydration/scanning should disappear from the sidebar after A2 cutover. Prefetch on actual navigation/focus may remain for perceived session-open latency, but it must not be required to display telemetry.

### Phase B — Comprehensive implicit-bootstrap route audit

- [ ] Enumerate every route using workspace/location/instance middleware.
- [ ] Identify all optional/missing-directory schemas.
- [ ] Identify every `process.cwd()` fallback reachable from server requests.
- [ ] Classify every endpoint into Tiers 0–3.
- [ ] Move Tier 0/1 reads off full instances.
- [ ] Require explicit location for remaining instance-scoped server APIs.
- [ ] Add regression tests: missing location must not create an instance.

### Phase C — Decompose/lazify instance services

- [ ] Measure cold bootstrap service-by-service cost.
- [ ] Map eager dependencies.
- [ ] Lazify services that are not universally required.
- [ ] Ensure config/catalog-only requests do not initialize execution-only services.
- [ ] Verify listener/watcher/timer ownership and disposal.

### Phase D — Listener/subscription closure

- [ ] Add per-owner listener counters.
- [ ] Reproduce 1, 3, 6+ concurrent sessions.
- [ ] Find non-converging listener classes.
- [ ] Fix leaks/duplicate subscriptions.
- [ ] Verify steady-state listener counts after sessions complete/navigation occurs.

### Phase E — Renderer multiplier closure

- [ ] Fix `Too many redirects` loop.
- [ ] Fix DnD teardown churn.
- [ ] Audit remaining per-row ownership graphs using the shared-tooltip pattern.
- [ ] Capture fresh renderer CPU profile under concurrency.

### Phase F — End-to-end load verification

- [ ] Baseline idle CPU/memory/listeners/DOM/request latencies.
- [ ] Run 1 concurrent session.
- [ ] Run 3 concurrent sessions.
- [ ] Run 6+ concurrent sessions / representative Agent Swarm.
- [ ] Capture backend request service times and event rates.
- [ ] Capture renderer long tasks/event drain telemetry.
- [ ] Confirm no retry storm, no listener growth, no implicit instance growth, no redirect storm.
- [ ] Record before/after metrics in this document.

## 14. Test/measurement gates

Minimum gates before declaring this campaign closed:

1. **Implicit instance gate:** fresh startup >=60 s creates no `$HOME` instance absent explicit user action.
2. **Route gate:** a server request with missing location cannot silently create a workspace instance.
3. **Token gate:** dev-token validation remains bootstrap-free and all token tests pass.
4. **Compatibility gate:** old-server fallbacks remain covered, but current hybrid servers choose bootstrap-free/current routes.
5. **Provider gate:** hidden session-context UI cannot start an implicit global provider instance.
6. **Retry gate:** invalid session configuration cannot create an unbounded `prompt_async` retry loop.
7. **Listener gate:** listener/subscription counts converge after session completion/navigation/disposal.
8. **Renderer gate:** no repeated redirect exception or DnD warning storm during concurrent activity.
9. **Load gate:** backend service latency remains bounded when multiple sessions stream simultaneously.

## 15. Working rules

- Preserve unrelated dirty work. No reset/stash/clean of the primary checkout.
- Use narrow diffs and grouped commits when the user asks to commit.
- Temporary probes must be explicitly marked and removed after they answer their question.
- Prefer wire/runtime evidence over generated-client naming or comments.
- Never infer that a route is global because its SDK namespace is named `global`; verify the actual URL and middleware.
- Never infer that a request is cheap because its payload is small; verify what services it materializes.
- Keep `[VERIFIED]`, `[IMPLEMENTED]`, `[UNVERIFIED]`, and `[FALSIFIED]` distinctions honest.
- When a new finding changes the architecture, update this ledger before moving on.

## 16. Current next action

**Phase A2 is now the immediate implementation target.** The $HOME startup reproduction is closed, but it exposed the more important ownership defect: dense/global UI is reconstructing live session telemetry from heavyweight message/part hydration.

Implementation order:

1. Define the compact global SessionTelemetry contract and its bounded in-memory owner.
2. Feed it directly from the existing SessionEvent.Step/Text/Reasoning/Tool lifecycle and session.status transitions; do not introduce a second raw-content stream.
3. Expose a bootstrap-free global snapshot/batch read for session IDs and carry live updates on the existing global event transport.
4. Cut the chat sidebar over from session.prefetch(..., 200) + message/part scans to O(1) telemetry lookups.
5. Delete metric-only hydration/dynamic aggregation from sidebar rows. Keep navigation prefetch (limit=20) only as an explicit UX warm path.
6. Measure 1/3/6+ concurrent sessions: telemetry update rate, renderer work, request count, retained memory, TPS/context/cache correctness.
7. Then continue Phase B route inventory and Phase C instance decomposition.

### Newly verified A2 source facts

- Durable/global Session rows **already materialize** aggregate cost and input/output/reasoning/cache-read/cache-write token counters. Recomputing those from message history in dense UI is unnecessary.
- SessionEvent.Step.Started already carries assistant message ID, model, agent, and requestSentAt.
- SessionEvent.Step.Streamed already marks the provider response-body boundary.
- SessionEvent.Step.Ended already carries authoritative settled cost and token classes.
- SessionEvent.Text.*, Reasoning.*, and Tool.* already provide exact semantic phase transitions needed for generating/thinking/tool status.
- The current sidebar still hydrates up to **200 messages per visible/working row** for metrics, dynamically loads the context metric implementation, scans message arrays and global part maps, and derives live state from those heavyweight structures. This is the path to remove.
- The existing global /usage/summary is bootstrap-free/global analytics, but it is an aggregate historical query and is **not** the right primitive for live per-session telemetry. Do not poll it for sidebar state.

## 17. Development-process postmortem — why this architecture survived multiple performance passes

This incident was not caused by a lack of optimization effort. It survived
because several optimization passes started from the **consumer implementation**
and optimized the work they found there instead of first asking which layer
should own the fact being displayed.

The corrective principle is not "always write backend code before UI code." The
UI still defines product requirements. The failure was **consumer-first data
ownership**: using the easiest existing client surface as the architecture and
then making that path progressively cheaper.

### 17.1 Evidence trail

1. **The sidebar's initial architecture already owned history-derived metrics.**
   `git log -S 'session.prefetch(session.id, 200)'` traces the 200-message metric
   hydration to `73b863d2d7` (`perf(app): stabilize chat sidebar row identity and
   scope reactive updates`, 2026-08-23). That pass did valuable renderer work —
   stable row identity, a shared IntersectionObserver, shared clocks, fewer
   remounts — but it accepted the premise that a sidebar row should hydrate and
   inspect session history to obtain its metrics.

2. **The concurrent-lag investigation found the local multiplier but remained
   one abstraction layer too high.** `TASK-concurrent-session-lag.md` correctly
   identified the `1s ticker x working rows x Part[] walks` scaling mechanism and
   proposed single-pass scans, caching, narrower part slices, slower/event-driven
   recomputation, and visibility gating. Those are reasonable local remedies,
   but none asks why the navigation pane reconstructs execution telemetry from
   message artifacts in the first place.

3. **The next pass optimized admission around the same ownership mistake.**
   `d8e3e4a47e` (`perf(app): coordinate startup session hydration`, 2026-09-15)
   added shared request scheduling, priority lanes, promotion, and serialization
   of speculative sidebar/tab/metric hydration. The current source still shows
   the residue: `pumpMetrics()` gives the 200-message metric prefetch one producer
   slot. That bounds contention, but it serializes unnecessary work rather than
   deleting it.

4. **The startup closeout tested the wrong state for the remaining path.**
   `CLOSEOUT-startup-sidebar-project-explorer-performance-2026-09-15.md` correctly
   removed passive viewport hydration for idle rows and moved full-history metrics
   behind selected/working/intentional interaction. Its live acceptance point was
   `sidebar.first-rows`, where transport was idle. But selected/working rows are
   exactly the state that auto-activates rich metrics. An idle first-paint trace
   therefore could not prove the active-concurrency path that later failed.

5. **Earlier concurrency closeout coverage was broad but did not include this
   ownership path end-to-end.** The campaign measured runner history, SQLite
   fairness, EventV2 routing, transport pressure, timeline topology, Markdown,
   Explorer, Context, tab previews, reconnect, and a real Chromium timeline.
   Those measurements remain useful for the mechanisms they exercised. They do
   not prove that Electron chrome/sidebar plus sidecar instance routing remains
   cheap while several background sessions are working.

6. **The server API made the consumer-first choice dangerously easy.**
   `WorkspaceRoutingMiddleware.defaultDirectory()` still maps a request with no
   directory/header to `process.cwd()`. `InstanceContextMiddleware` then calls
   `InstanceStore.load()`. The instance gate initializes config, plugins, and
   ToolReload; warmup can initialize LSP, ShareNext, format, VCS, snapshot, and
   project services. Thus a seemingly tiny `GET /provider`, `/config`, `/path`,
   or legacy session read can hide a complete workspace ownership decision.

7. **Route grouping reinforces the wrong default.** Entire resource groups such
   as `provider` and `session` are wrapped in instance middleware even though
   some reads are conceptually global/durable while other siblings genuinely
   require workspace execution context. Grouping by API noun made it convenient
   to inherit the heaviest ownership semantics from the group.

8. **Important architecture methodology existed, but not where source agents
   were guaranteed to read it.** The concurrency successor handoff already says
   to verbally simulate the request through storage/server/transport/renderer and
   prefer removal of shared coupling over local micro-optimization. Meanwhile
   `packages/app/AGENTS.md`, `packages/opencode/AGENTS.md`, and
   `packages/desktop/AGENTS.md` all referred agents to a repository-root
   `AGENTS.md` that did not exist. The strongest architecture lessons were buried
   in campaign documents instead of the repository instruction hierarchy.

### 17.2 Failure modes to prevent

- **Existing-API bias:** "there is already an SDK method for this" was treated
  as evidence that the route was an appropriate dependency. API existence says
  nothing about ownership tier or transitive bootstrap cost.
- **Payload-size fallacy:** small JSON responses were treated as cheap without
  tracing middleware/service materialization.
- **Progressive-is-cheap fallacy:** deferring a history scan until hover/working
  state changes *when* it is paid, not *what* it costs when many sessions are
  simultaneously active.
- **Bounding before deleting:** schedulers, queues, observers, and dwell timers
  made the wrong producer safer and therefore easier to mistake for a solved
  architecture.
- **Semantic reconstruction in presentation:** thinking/generating/tool state was
  inferred from message/part shape even though execution emits exact lifecycle
  transitions. This costs more and is semantically weaker.
- **Missing bottom-up data inventory:** durable Session rows already carry cost
  and aggregate token classes, while execution events already carry step/model/
  reasoning/text/tool transitions. These should have been inventoried before a
  UI metric implementation was accepted.
- **Scenario mismatch at closure:** first-paint/idle and single-timeline evidence
  was generalized to working-session/sidebar behavior not exercised by those
  benchmarks.
- **Optimizing a route instead of challenging the boundary:** once a request
  entered `InstanceStore`, work focused on warmup latency and admission. The
  stronger question is whether the request has any right to create an instance.
- **No enforceable negative invariant:** prior tests could remain green while an
  endpoint silently created cwd. "Response is correct" must be accompanied by
  "instance creation count is zero" for Tier 0/1 surfaces.

### 17.3 Correct development model from now on

For cross-layer state and performance work, agents must proceed in this order:

1. Write down the user-visible fact required, without choosing a data source.
2. Locate the authoritative durable/runtime producer and existing events/rows.
3. Classify ownership Tier 0/1/2/3.
4. Trace the current request path through middleware and every service it can
   materialize; count hidden ownership transitions.
5. Reuse or create the smallest upstream materialized/incremental projection.
6. Expose one bootstrap-free/bounded transport appropriate to the ownership
   tier.
7. Make the client a cheap consumer of that projection.
8. Only then optimize presentation mechanics such as observers, virtualization,
   clocks, or portals.
9. Validate the actual trigger state at 1 / 3 / 6+ concurrent sessions and add
   negative invariants that make architectural regression fail loudly.

The repository instruction hierarchy has been updated alongside this postmortem:
a real root `AGENTS.md` now carries the architecture contract, with specialized
rules in App, Desktop, Core, OpenCode/HttpApi, Schema, Session UI, shared UI,
server tests, performance E2E, and handoff guidance. The longer practical guide
is `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`; use it as the review model
for any follow-up work that touches cross-layer data ownership or concurrency.
