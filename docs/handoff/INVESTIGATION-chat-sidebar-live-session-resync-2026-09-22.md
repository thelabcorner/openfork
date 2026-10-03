# Chat Sidebar Live-Session Resynchronization Investigation

**Date:** 2026-09-22  
**Scope:** Read-only architecture/performance investigation. No implementation changes were made.  
**Allowed write:** this investigation ledger only.

## Executive finding

The observed behavior is explained by a **split source-of-truth / failed bootstrap reconciliation path**, not by the Chat sidebar virtualization itself.

OpenFork already has the correct high-performance server projection for this UI fact: process-global `SessionTelemetry`. It is bootstrap-free, batched, bounded, coalesced, and updated directly from both the legacy/V1 processor and the current/Core runner.

However, the Chat sidebar still decides whether a row is "working" from the older client `session_working(sessionID)` path. After a renderer reload that store is cold. The one global active-session bootstrap intended to reseed it is incomplete for V1 production activity because the V1 compatibility adapter prefers the current/V2 `/api/session/active` endpoint whenever it exists; that endpoint reports Core/V2 execution ownership, not V1 `SessionStatus` activity. The request succeeds, so the adapter never reaches its legacy status fallback.

The sidebar separately fetches the correct telemetry snapshot, but then discards its liveness information by gating the live UI on `session_working()`.

Entering a V1 session "fixes" the row because directory bootstrap runs a deferred legacy `session.status()` request and writes those statuses back into the shared session store. Opening a detail route is therefore accidentally acting as the missing reconciliation step.

**Confidence: high.** The full source path matches the reported behavior exactly.

---

## Architecture worksheet

**User-visible fact:** a session is currently requesting / reasoning / generating / running a tool / retrying.

**Authoritative producer:** the execution path itself.

**Existing materialized projection:** `SessionTelemetry.Info.phase`.

**Owning service / lifetime:** process-global `SessionTelemetry.Service`.

**Ownership tier:** Tier 0 / process-global projection.

**Route:** fork-owned `global.sessionTelemetry` snapshot + global `session.telemetry.updated` events.

**InstanceStore required:** no.

**History hydration required:** no.

**Per-row request/subscription required:** no.

**Concurrency multiplier:** one batched snapshot for known visible IDs; one shared coalesced event channel. Telemetry's live state is bounded and the event flusher is shared.

**Negative invariants for the eventual fix:**
- no `child(..., { bootstrap: true })` just to learn sidebar activity;
- no legacy `session.status()` fan-out per project/directory;
- no message/part history scan;
- no per-row polling;
- no per-row SSE/listener;
- no directory/Instance materialization;
- no process.cwd fallback;
- no new token-rate client computation.

These follow `AGENTS.md`, `packages/app/AGENTS.md`, `packages/core/AGENTS.md`, and `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`.

---

## Confirmed data path

### 1. V1 production execution already writes SessionTelemetry

`packages/opencode/src/session/processor.ts`:

- around 991: `SessionStatus.set(...busy)`
- around 1004: `telemetry.begin(...)`
- around 445: every provider stream event reaches `telemetry.observe(...)`
- around 712: provider settlement reaches `telemetry.settle(...)`
- around 1034: response-body completion reaches `telemetry.streamed(...)`

`packages/opencode/src/session/status.ts`:

- retry status calls `telemetry.retry(sessionID)`
- idle status calls `telemetry.idle(sessionID)`

Normal V1 run-state cleanup also drives `SessionStatus` back to idle.

Therefore an already-running V1 generation has a process-global telemetry state independent of whether a renderer has ever opened its session route.

### 2. Current/Core execution also writes the same SessionTelemetry service

`packages/core/src/session/runner/llm.ts` uses the same `SessionTelemetry.Service` for begin, observe, settle, and idle.

`SessionTelemetry.node` is a global app node (`makeGlobalNode`).

This makes telemetry the existing cross-runtime semantic phase projection.

### 3. SessionTelemetry is already designed for exactly this sidebar use case

`packages/core/src/session/telemetry.ts`:

- one process-global live-state map;
- idle TTL: 15 minutes;
- max live states: 2048;
- one wake-driven flusher;
- flush delay: 75 ms;
- no idle periodic timer;
- snapshot reads are batched;
- snapshot overlays current live memory over settled DB state;
- no Location / Instance creation.

`packages/schema/src/session-telemetry.ts` explicitly documents the event as a bounded, coalesced UI projection where one event may update many sessions.

Phases are:

- `idle`
- `requesting`
- `reasoning`
- `generating`
- `tool`
- `retrying`

### 4. The app already has the correct bootstrap-free transport

`packages/app/src/context/server-sync.tsx`:

- owns one server-scoped telemetry cache;
- `telemetry.ensure(ids)` deduplicates IDs;
- requests are coalesced;
- snapshot chunks are capped at 500 IDs;
- request uses `global.sessionTelemetry`;
- response is stored in `globalStore.telemetry`;
- live `session.telemetry.updated` events reconcile into the same store.

The global endpoint:

`packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`

is explicitly documented as a compact session telemetry read that **never materializes directory config, plugins, providers, tools, or a workspace runtime**.

### 5. Stream-interest optimization is not the problem

`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` only suppresses events recognized by `isSessionStreamContentEvent(...)`.

`session.telemetry.updated` is not a raw session-content delta, so it remains globally deliverable even when a session timeline is not activated.

No change to stream-content interest is necessary.

---

## Exact failure chain

### A. Renderer reload destroys the client working store

`packages/app/src/context/server-session.ts` starts with:

- empty `session_status`;
- `session_working(id)` is derived from that status map plus paused state.

So a renderer reload begins with every session effectively idle until some reconciliation source repopulates the store.

### B. The intended global active-session bootstrap is incomplete in V1 compatibility mode

`packages/app/src/context/server-sync.tsx` creates one `activeSessionsQuery`.

It calls:

`serverSDK.api.session.active()`

and then seeds `session_status` with the result.

The query is intentionally one-shot:

- `staleTime: Infinity`
- `gcTime: Infinity`
- no refetch on mount/reconnect/window focus.

This is architecturally desirable **if the source is complete**.

### C. The V1 compatibility adapter prefers the wrong successful source

`packages/app/src/utils/server-compat.ts`, V1 `active()`:

1. first calls `input.current.session.active()`;
2. only falls back to legacy `session.status()` if the current request throws.

The comment says hybrid/current servers expose the current active-session surface even while compatibility reports V1.

The issue is semantic, not transport availability: the current endpoint can successfully return an incomplete set for V1 execution.

### D. Current `/api/session/active` is Core/V2 execution state

`packages/core/src/session.ts`:

`active: execution.active`

`packages/core/src/session/execution.ts` defines that as execution owned by the current process/Core runner.

`packages/server/src/handlers/session.ts` builds `session.active` from that current execution set plus durable paused sessions.

It does not union V1 `SessionStatus` activity.

Therefore, on a V1 production generation, the current endpoint can return no running entry while the V1 processor and `SessionTelemetry` correctly know the session is active.

Because the request succeeds, `server-compat.ts` never executes its legacy fallback.

### E. The Chat sidebar receives correct telemetry but gates it behind the cold status store

`packages/app/src/pages/session/v2/chat-sidebar-pane.tsx`:

- around 566-570: batches `telemetry.ensure(...)` for all sessions the pane can render;
- around 861: row runtime reads `serverSync().telemetry.get(sessionID)`;
- `telemetryLive(...)` treats every non-idle telemetry phase as live.

But:

- around 346-349: pane-level `isWorking` reads only `session.data.session_working(id)`;
- around 840: row runtime `isWorking` also reads only `session_working(id)`;
- around 886-889: `live` returns undefined unless that separate `isWorking()` is true;
- around 2374: the visible live indicator is wrapped in `<Show when={isWorking()}>`.

So the correct process-global telemetry snapshot can literally say `phase: "generating"`, while the row remains visually idle because the legacy client status map is cold.

The same stale boolean also affects:
- "working first" row pinning;
- the sidebar working-count badge.

### F. Entering the session repairs the wrong store

The Chat sidebar intentionally reads project stores with:

`child(project.worktree, { bootstrap: false })`

This is correct for performance.

When the actual V1 session/directory route is entered, directory bootstrap runs.

`packages/app/src/context/global-sync/bootstrap.ts`, around 620-645:

- for V1 only, deferred bootstrap calls `input.sdk.session.status()`;
- writes returned statuses into the shared session store;
- resolves those active session records.

That repopulates `session_status`, `session_working(id)` flips true, and the sidebar begins rendering the telemetry it already had.

This is the direct explanation for the reported "enter the session and it suddenly resynchronizes" behavior.

---

## Why the obvious fixes are wrong

### Do not enable directory bootstrap in the Chat sidebar

Changing `bootstrap: false` to true would turn a cheap navigation surface into an Instance/workspace initializer and recreate the request-amplification problem the architecture docs explicitly prohibit.

### Do not poll `session.status()` per directory

That scales with projects/directories, can enter legacy workspace routing, and makes the sidebar pay for a location-scoped status API to learn a process-global fact.

### Do not add a status request per row

That creates N transport work and violates the dense-navigation O(1) projection rule.

### Do not hydrate message history to infer activity

The execution layer already knows the phase. Reconstructing it from `Message[]` / `Part[]` is both slower and less correct.

### Do not subscribe every sidebar row to raw content deltas

Telemetry already provides one compact coalesced shared update stream. Stream-content interest should remain scoped to activated timelines.

### Do not "fix" it with a periodic high-frequency active poll

A snapshot-on-connect plus event-driven live projection already exists. Polling would add work while still preserving two competing truths.

---

## Recommended implementation architecture

This section is a design recommendation only; nothing below was implemented.

### Layer 1 — make sidebar semantic activity telemetry-authoritative

For dense UI rendering, derive "live/generating" from the existing compact phase projection:

`telemetry.phase !== "idle"`

The current status store can remain a compatibility/control fallback, but it should not be allowed to veto a live telemetry phase.

A tactical form is:

`displayWorking = session_working(sessionID) || telemetry.phase !== "idle"`

A cleaner form is a single shared server-sync accessor such as a session display/activity projection, rather than reimplementing that union in each component.

The sidebar should use that one accessor consistently for:

- working-first pinning;
- global working count;
- row live-state gate;
- progress indicator visibility.

The semantic label/timer should continue to come from `SessionTelemetry.phase` / `telemetryLive()`.

**Performance:** zero additional requests, zero additional listeners, zero additional timers. The pane already loads telemetry.

### Layer 2 — repair the global active-session bootstrap source

The one-shot `session.active` bootstrap is a good architecture, but it must represent activity from both execution systems.

The preferred server-side shape is a process-global active projection that unions:

1. current/Core execution activity;
2. legacy/V1 active execution;
3. durable paused sessions.

Because `SessionTelemetry` is already global and fed by both runners, it is the natural existing projection to build on. A narrowly scoped `active()` / active-ID view can be added to that service, or a sibling global liveness projection can be maintained directly from execution/status transitions.

Then `/api/session/active` can return one complete process-wide result and the V1 compatibility adapter's current-first behavior becomes semantically valid.

Important nuance: keep **liveness** and **semantic phase** distinct.

- `session.active`: discovery / generic running-or-paused bootstrap.
- `SessionTelemetry.phase`: requesting/reasoning/generating/tool/retrying presentation.

This avoids forcing generic control semantics into the UI telemetry schema.

### Layer 3 — centralize consumers

Other surfaces currently use `session_working()` directly and are exposed to the same cold-bootstrap/drift class:

- `packages/app/src/components/titlebar-tab-state.ts`
- `packages/app/src/pages/layout/project-avatar-state.ts`
- legacy `packages/app/src/pages/layout/sidebar-items.tsx`
- session page/composer controls

Not every control should blindly switch to telemetry: Stop/interruption semantics may require actual execution liveness. But **display-only busy/generating surfaces** should consume the same compact display activity projection so reload behavior is consistent.

---

## Performance characteristics of the recommended direction

No new hot path is required.

Existing telemetry characteristics:

- process-global;
- live state bounded to 2048;
- idle TTL 15 min;
- 75 ms shared flush/coalescing interval;
- one event can carry multiple session updates;
- snapshot batches up to 500 IDs per request;
- snapshot does not create Instance/Location state;
- sidebar already uses one shared clock for timer presentation.

For the sidebar specifically, the safest client implementation should depend only on the telemetry **phase** for working-state invalidation, not the full telemetry object, so token-count/character changes do not force group reordering work. The detailed row can remain reactive to the richer telemetry object for its timer/rate display.

No per-token sort/filter pass should be introduced.

---

## Regression / acceptance matrix for implementation

### Correctness

1. Start a V1 generation outside the OpenFork renderer, then open/reload OpenFork while it is already running.
   - Chat sidebar shows the session as live without entering it.

2. Alt-F5 while a V1 session is:
   - requesting;
   - reasoning;
   - generating text;
   - in a long tool;
   - retrying.
   - Each phase reappears from snapshot without route navigation.

3. Current/Core session active during reload.
   - Same result.

4. Six or more mixed V1/current concurrent sessions.
   - Every active row is shown correctly.
   - Working count is correct.
   - Working-first pinning is correct.

5. Session becomes active after renderer is already connected.
   - Global telemetry/status event updates the row without opening it.

6. Session goes idle.
   - Indicator clears without navigation.

7. Paused session.
   - Never rendered as working merely because of stale status/telemetry.

### Negative invariants

During the tests above assert:

- no implicit workspace/Instance initialization caused by sidebar activity;
- no `session.status()` per-directory fan-out during sidebar startup;
- no message history fetch solely for activity;
- no one-request-per-row pattern;
- no one-listener-per-row pattern;
- no raw background content subscription expansion;
- no process.cwd fallback.

### Request-budget assertions

At sidebar cold start:

- one process-wide active bootstrap;
- telemetry snapshots bounded by `ceil(unknownVisibleSessionIDs / 500)`;
- zero legacy directory status calls caused by the Chat sidebar itself.

### Performance trigger state

Profile with:
- 1 active session;
- 3 concurrent;
- 6 concurrent;
- a larger visible sidebar with 6 active rows.

Measure:
- main-thread work from telemetry events;
- number of group recomputations;
- DOM updates per telemetry phase change vs per token;
- finite request count;
- SSE bytes/event rate;
- memory retained by telemetry cache.

The target is phase-change-driven group activity, not token-rate group activity.

---

## Existing test gap

Current tests prove pieces but not the failing composition:

- `packages/core/test/session-telemetry.test.ts` proves snapshot returns live requesting/reasoning/generating/tool phases.
- `packages/app/src/context/server-sync.test.ts` proves active-session bootstrap is cached once and seeds statuses.
- `packages/app/e2e/regression/remote-tab-busy.spec.ts` proves a mocked current `/api/session/active` can drive a remote tab busy indicator.

Missing regression:

> V1-compatible renderer + hybrid server where current `/api/session/active` exists but does not contain the already-running V1 session, while SessionTelemetry does.

That is the composition that reproduces the reported bug.

---

## Related prior documentation

`docs/plans/swarm/swarm-tab-stop-pause.md` already identifies `session_working` drift as a pre-existing reliability problem and notes that mount seeding from `session.active` is one-shot.

`docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md` explicitly names SessionTelemetry as the reference pattern for sidebar state and states that sidebar telemetry should not enter InstanceStore.

`docs/handoff/CLOSEOUT-pwa-mobile-contention-2026-09-14.md` records the performance motivation for replacing per-directory status fan-out with one global active-session request. That optimization is directionally correct; the bug is that the global active source is not semantically complete for V1 execution on a hybrid server.

---

## Root-cause statement

**The Chat sidebar is not missing a performant server-side source of truth. It already has one. The defect is that renderer startup seeds its legacy `session_working` gate from an incomplete cross-runtime `session.active` source, while the sidebar's correct process-global SessionTelemetry projection is treated as secondary data and cannot make a row live by itself. Opening a session triggers location-scoped legacy status bootstrap and masks the missing global reconciliation.**

The eventual fix should preserve the current cheap `bootstrap:false` sidebar architecture, make compact global telemetry authoritative for semantic live presentation, and repair the process-global active bootstrap so it is truthful across V1 and current execution without introducing polling, history hydration, or per-directory work.

---

## Implementation closeout — 2026-09-22

The implementation was completed after this investigation. The final design is slightly stronger than the initial client-side recommendation above: the Chat sidebar does **not** own a second activity signal at all.

### Final architecture

1. **Process-global active bootstrap is now cross-runtime truthful.**

   `SessionTelemetry.Service` exposes an `active` snapshot of its bounded in-memory live states. `/api/session/active` unions:

   - current/Core `SessionExecution.active`;
   - process-global `SessionTelemetry.active`, which includes V1 and current provider execution;
   - durable paused sessions, with paused winning any transient overlap.

   This preserves the single process-wide cold-start request and removes the hybrid-server semantic hole without introducing directory work.

2. **Telemetry repairs the canonical client status store only at activity edges.**

   `server-sync.tsx` derives a transition from the previous and next telemetry phases:

   - unknown/idle -> non-idle: seed `session.status = busy` only if the canonical status store is not already working and the session is not paused;
   - live -> live: no status write;
   - live -> idle: clear the canonical working status;
   - unknown -> idle snapshot: no write, so a legitimate pre-provider busy state cannot be erased by an older settled telemetry row.

   Reconciliation is performed through the existing `session.status` reducer path. That event family is explicitly excluded from metadata hydration, so this causes no session fetch, message history read, directory bootstrap, or InstanceStore entry.

3. **The Chat sidebar remains on `session_working()`.**

   Working-first pinning, working counts, row progress rendering, tabs, avatars, and controls continue to consume the same canonical status projection. No new sidebar listener, memo graph, timer, polling loop, or transport exists.

### Performance properties

- **New recurring network requests:** 0.
- **New timers:** 0.
- **New SSE subscriptions/listeners:** 0.
- **New per-row requests:** 0.
- **New history scans:** 0.
- **New Instance/workspace bootstraps:** 0.
- **New token-rate UI recomputation path:** 0.
- `SessionTelemetry.active` scans only the already-bounded live-state map (max 2048) when the existing one-shot `session.active` bootstrap is requested.
- The app has exactly one `session.active()` caller; its query uses `staleTime: Infinity`, no mount/reconnect/window-focus refetch, and no `refetchInterval`.
- Live telemetry was already being reduced. The only additional hot-path work is a constant-time phase-edge comparison inside that existing reducer; the canonical status store is written only on live/idle boundaries, never on token deltas or live-to-live phase changes.

### Regression coverage added

- Core telemetry test verifies `telemetry.active` contains a session after `begin()` and removes it after `idle()`.
- App unit test verifies status reconciliation only occurs on meaningful activity edges, including the initial-idle/pre-provider race and paused-session guard.
- HTTP integration regression reproduces the original hybrid failure mode with a **real in-flight V1 provider run** and proves `/api/session/active` reports it as `running` before any renderer/session-page hydration occurs.

### Validation

- `packages/core/test/session-telemetry.test.ts`: **1 passed, 0 failed**.
- `packages/app/src/context/server-sync.test.ts`: **22 passed, 0 failed**.
- exact V1 HTTP active-snapshot regression: **1 passed, 0 failed**.
- `packages/core` typecheck: **pass**.
- `packages/server` typecheck: **pass**.
- `packages/app` typecheck: **pass**.
- `packages/opencode` full package typecheck remains red on unrelated pre-existing/concurrent diagnostics; after the final test design there are **no diagnostics from the changed HTTP session test**.
- CRLF-aware `git diff --check`: **clean**.
