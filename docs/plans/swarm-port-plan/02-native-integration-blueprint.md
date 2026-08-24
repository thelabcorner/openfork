# 02 — Native Integration Blueprint: where swarms live in the opencode monorepo

**Author:** architect (native core architect)
**Status:** DRAFT v1 — planning only, no code written
**Inputs:** openswarm plugin source (`C:\Users\slooshied\Documents\openswarm`, 14 modules under `src/`), host repo survey (`C:\Users\slooshied\WebstormProjects\opencode`), binding doctrine in root `../../handoff/AGENTS.md` + `../../../packages/opencode/AGENTS.md` + `../../../packages/schema/AGENTS.md`.
**Peer inputs pending:** scout's hack inventory (`01-plugin-capability-map.md`) for §6 cross-check; api-designer owns final wire contracts (§5 marks the seam).

---

## 1. Executive summary

openswarm today is a **plugin that impersonates a runtime**: it re-enters opencode through the HTTP client it is handed, scrapes its own server's SSE stream to see events the plugin hook drops, classifies its own injected prompts by text-prefix sniffing, and keeps an entire second database beside the host's. Every one of those contortions exists because the plugin boundary forbids what swarms actually need: **in-process access to sessions, bus, storage, and permissions**.

The blueprint removes the boundary instead of working around it:

1. **Swarm becomes a first-class server subsystem** living in `packages/opencode/src/swarm/` as Effect services initialized per project instance (`InstanceState`), with pure domain logic kept dependency-clean and wire contracts in `../../../packages/schema`.
2. **Members stay real root Sessions** (the plugin's proven topology) but gain **first-class linkage rows** in the host's own drizzle/SQLite store — membership is data, not title emoji and prefix heuristics.
3. **One persistence layer**: swarm tables join the host drizzle schema in `../../../packages/core` (`*.sql.ts` + core-applied migrations). The dedicated `.opencode/swarms/swarms.db`, its hand-rolled migration chain, its dual DDL sources, and its serialized-write queue all die; a one-time read-only importer absorbs legacy databases.
4. **One event plane**: swarm lifecycle publishes through the host `GlobalBus` → SSE → generated SDK event stream. The plugin's separate SSE subscription, polling backstops, and event-type allowlists are deleted.
5. **Permissions become declarative at spawn**: member rulesets are derived once from coordinator policy and attached to the session; the ask-hook interception layer, worktree-scoping heuristics, and V1/V2 duality workarounds collapse into one integration seam.
6. **The runtime adapter dies entirely** — the engine calls session services directly in-process. ~14 modules port over with their semantics intact (mailbox state machine, DAG scheduler, leases, hive, emergency guard) minus their isolation shims.

Net effect: roughly 60–70% of openswarm's code survives as logic; nearly 100% of its *hacks* die. The plan is sequenced so each phase lands behind the existing V1 API contract and SDK generation flow, with no behavior change to non-swarm users until opt-in.

---

## 2. Host repo survey notes (what exists, where)

Everything below was verified by direct reading during this survey unless marked *(unverified)*.

### 2.1 Binding doctrine (root `../../handoff/AGENTS.md`)

- Dependency direction: **Schema ← Core and Protocol ← Server**; Client may depend on Schema + Protocol, never Core/Server; `sdk-next` composes Client+Core+Server. Confirmed against `../../../packages/schema/package.json` (deps: effect only) and `../../../packages/protocol/package.json` (deps: `@opencode-ai/schema` + effect).
- **V1 HTTP API is the production app surface**, route groups under `../../../packages/opencode/src/server/routes/instance/httpapi`. V2 / `SessionV2` is beta — do not build product behavior on it.
- SDK regeneration: legacy JS SDK via `./packages/sdk/js/script/build.ts`; after changing Protocol or Server `HttpApi`, run `bun run generate` from `../../../packages/client`. Never hand-edit `src/generated` / `src/generated-effect`.

### 2.2 Module shape & Effect conventions (`../../../packages/opencode/AGENTS.md`)

- No `export namespace`; flat exports + self-reexport (`export * as Foo from "./foo"`). Multi-sibling directories get **no barrel index** — consumers import specific siblings.
- Drizzle schema lives in **`packages/core/src/**/*.sql.ts`**; migrations live in `../../../packages/core` and are applied by core.
- Services via `makeRuntime` (`src/effect/run-service.ts`) + `InstanceState` (`src/effect/instance-state.ts`, `ScopedCache` keyed by directory) for per-directory/per-project state with automatic disposal. Background loops via `Effect.repeat`/`Effect.schedule` + `Effect.forkScoped` inside the layer. `src/project/bootstrap.ts` wraps every service `init()` in `forkDetach` — init is fire-and-forget.
- Typed errors via `Schema.TaggedErrorClass`; branded IDs via `Schema.brand`.

### 2.3 Wire-contract doctrine (`../../../packages/schema/AGENTS.md`)

- Schema owns **browser-safe wire and storage contracts** only — serializable definitions, no services/runtime. A domain may keep "a minimal public wire contract here when SDK generation needs it" (canonical example: `plugin.added` payload).
- Current contracts unversioned; legacy = explicit `V1` names, eventually isolated under `src/v1/`. Events classified `current` / `shared transitional` / `V1-only` before entering a public manifest. One canonical definition per contract; facades must re-export the exact canonical value.

### 2.4 Host inventory relevant to swarms

| Area | Location | What's there | Swarm relevance |
|---|---|---|---|
| Session model | `../../../packages/opencode/src/session` (25 files: `session.ts`, `prompt.ts`, `message-v2.ts`, `status.ts`, `tools.ts`, …) | V1 session CRUD, prompt loop, status events, tool registry | Members ARE these sessions; engine drives them |
| Event bus | `../../../packages/opencode/src/bus/global.ts` | Thin `GlobalBus` EventEmitter; `GlobalEvent = {directory?, project?, workspace?, payload}` with ascending `evt_` ids stamped on emit | The single event plane swarm publishes into |
| Server | `../../../packages/opencode/src/server` (`server.ts`, `event.ts`, `projectors.ts`, `init-projectors.ts`, `global-lifecycle.ts`, `routes/`) | HTTP/SSE serving, event projection to clients | Swarm routes + event fan-out ride this |
| Plugin loader | `../../../packages/opencode/src/plugin/loader.ts` (+ `index.ts`) | Loads external plugins, hands them `PluginInput{client, project, directory, worktree, serverUrl, $}` | What openswarm uses today; becomes the *deprecation* surface, not the home |
| Storage | `packages/opencode/src/storage/{storage.ts,schema.ts}` + drizzle tables in `packages/core/src/**/*.sql.ts` | Host SQLite store, migrations applied by core | Swarm tables land here (§4.4) |
| Config | `../../../packages/opencode/src/config` | Self-export pattern modules (`export * as ConfigAgent from "./agent"`) | New `config/swarm` module follows suit |
| Agent | `../../../packages/opencode/src/agent` | Agent presets/definitions | The `swarm` member agent ships as a built-in preset |
| Permission | `../../../packages/opencode/src/permission` | Permission engine; merge = agent permission + session ruleset (no parent inheritance — confirmed by openswarm's compat report fact 8) | Spawn-time rulesets replace ask-hook interception |
| Tool registry | `../../../packages/opencode/src/tool` | Built-in tools | `swarm_*` tools become first-class tools here |
| Worktree | `../../../packages/opencode/src/worktree` | Worktree management | Member worktree placement policy |
| Project/instance | `../../../packages/opencode/src/project`, `bootstrap.ts`, `InstanceState` | Per-directory instance lifecycle | Swarm engine lifecycle owner |
| Provider catalog | `../../../packages/core/src/catalog.ts`, `../../../packages/opencode/src/provider` | Model/provider metadata incl. pricing/capabilities | Replaces openswarm `models/catalog.ts` wholesale |
| Wire schemas | `packages/schema/src/*.ts` | Browser-safe contracts (e.g. `plugin.added`) | Swarm entity/event wire schemas |
| HttpApi contract | `packages/protocol/src/*` (schema-only deps) | Current `/api/...` surfaces | Swarm route contract (with api-designer) |
| Apps | `../../../packages/app` (web renderer), `../../../packages/desktop` (Electron main/renderer), TUI in `../../../packages/opencode/src/cli` | UIs consume generated client + SSE events | UX consumes; no engine code in apps |

### 2.5 openswarm inventory (what ports)

14 modules under `src/`: `core` (types, swarm ops, self-heal/match, fence, events), `messaging` (broker, formatter, mentions, need, senders, timeline), `scheduler` (scheduler, dag affinity), `supervisor` (supervisor, recovery, stalls), `storage` (sqlite-store, chunkdb-store, migrate, schema.sql, json-schema), `hive` (diagnostics, digest, relevance, resonance), `humanchat/tracker`, `permissions` (clamp, propagate), `notices/aggregator`, `emergency/killswitch`, `revive/revive`, `models/catalog`, `probe/compat`, `runtime/opencode-runtime` — plus the ~1.5k-line `plugin.ts` orchestration monolith (tool registry + hooks + sweep loop + watchdog). Semantics documented in the plugin's own docs (`docs/STORAGE.md`, `SCHEDULER.md`, `MESSAGING.md`, `ROOT_MEMBER_SESSIONS_PLAN.md`, `OPENCODE_COMPATIBILITY_REPORT.md`), which I treat as accurate primers (they cite file:line and were spot-checked against `src/plugin.ts`).

Key verified openswarm facts that shape this blueprint:

- Members are **root sessions** titled `🐝 <swarm> / <member>` with metadata `{swarmID, memberName, swarmMember}`; desktop lists roots only; `parentID` immutable post-create (compat report addendum).
- Busy-session prompts are absorbed natively (run loop re-reads history); idle-session prompts start fresh runs — the human-chat design relies on this (ROOT_MEMBER_SESSIONS_PLAN §5.3.4).
- Store: single SQLite DB per workspace at `<project>/.opencode/swarms/swarms.db`, WAL, FK on, busy_timeout 5000, one serialized promise queue, `user_version` migration chain (7 steps), CAS blackboard, atomic task claims, exactly-once message claims (STORAGE.md §§2–4).
- Scheduler: deterministic DAG readiness recompute, atomic claims, 30-min claim leases, retry budget (default 2), affinity assignment, watchdog (5-min silence, strike 1 nudge / strike 3 release), dependent notifications (SCHEDULER.md).
- Messaging: durable per-recipient mailbox rows, queued→scheduled→delivered/expired/failed state machine, urgent TTL 60 min, retry budget 3, cooldown 30 s, human-chat deferral, need routing whisper/shout, `[DATA]` trust fence (MESSAGING.md).

---

## 3. Target architecture

### 3.1 Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ packages/app (web)   packages/desktop (Electron main+renderer)   TUI        │
│        │                     │                        │                      │
│        └────────── generated SDK client (@opencode-ai/client) ──────┘       │
│                     │ HTTP + SSE (/api/event, /api/swarm/*)                 │
├─────────────────────────┼───────────────────────────────────────────────────┤
│ packages/opencode  (server process)                                          │
│                                                                             │
│  server/routes/instance/httpapi/swarm.ts   ← V1 route group (api-designer)  │
│        │                                                                     │
│  ┌──────▼──────────────────────────────────────────────────────────────┐    │
│  │ src/swarm/  (NEW — the engine, Effect services per project instance)│    │
│  │                                                                     │    │
│  │  SwarmService      create/delete/status/reassign/emergency facade   │    │
│  │  SwarmBroker       durable mailbox delivery → SessionPrompt         │    │
│  │  SwarmScheduler    DAG readiness, claims, leases, retries           │    │
│  │  SwarmSupervisor   event reduce (idle/error/deleted), recovery      │    │
│  │  SwarmStalls       stall classifier + escalation ladder             │    │
│  │  SwarmHumanChat    user-chat suppression state machine              │    │
│  │  SwarmHive         blackboard/beliefs/annotations/consolidation     │    │
│  │  SwarmNotices      debounced coordinator digests                    │    │
│  │  SwarmEmergency    freeze/stop/nuke guard                           │    │
│  │  SwarmRender       envelopes, fences, timelines (pure functions)    │    │
│  └──────┬──────────────┬───────────────┬──────────────────────────────┘    │
│         │              │               │                                    │
│  session/ (V1)    permission/       GlobalBus ──► server/event.ts ──► SSE   │
│  prompt/create    rulesets @spawn        │                                   │
│         │              │               │                                   │
│  ┌──────▼──────────────▼───────────────▼───────────────────────────────┐    │
│  │ storage (host SQLite via drizzle)  +  swarm_* tables from core      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  tool/swarm/* (first-class tools)      config/swarm (self-export module)    │
│  agent presets (built-in "swarm" agent doctrine)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ packages/core: src/swarm.sql.ts (drizzle tables) + migrations                │
│ packages/schema: src/swarm.ts (wire entities + event payloads, browser-safe) │
│ packages/protocol: swarm route contract (current /api surface)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component responsibilities

- **SwarmService** — the façade every consumer (tools, routes, CLI) talks to. Owns swarm/member/task/message/blackboard operations, delegates persistence to the host store, publishes bus events. Holds no timers itself.
- **SwarmBroker** — mailbox delivery state machine (claim → prompt → delivered / revert+retry / expire). Prompts members through the same internal path the API's `promptAsync` uses (in-process call, not self-HTTP). Respects human-chat deferral + cooldown policies.
- **SwarmScheduler** — deterministic DAG passes triggered by bus events (task/member changes) plus a low-frequency safety-net sweep (`Effect.schedule`, jittered, unref'd). Atomic claims and lease expiry stay conditional UPDATEs in the store layer.
- **SwarmSupervisor** — reduces session events (`session.idle`, `session.error`, `session.deleted`, status) into member-state transitions; runs startup reconciliation (detection-only; respawn is explicit revive, preserving openswarm's invariant).
- **SwarmHumanChat** — per-member suppression window while the user chats directly with a member. Detection is structural (see §6-H1), not prefix-based.
- **SwarmHive / Notices / Emergency / Stalls / Render** — near-direct ports of their openswarm counterparts with persistence swapped to host storage and notification dedup backed by durable event rows.
- **First-class tools** (`tool/swarm/*`) — thin argument-validation + delegation to SwarmService. Registered like built-ins so any agent (not just members) can drive swarms; availability gated by config.
- **Config module** (`config/swarm`) — `enabled`, default member model, policy defaults, deprecation toggle for the legacy plugin. Follows the self-export pattern.

---

## 4. Key decisions

### 4.1 Packaging — where the code lives

| Option | Description | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Split by dep-direction (chosen)** | Wire schemas → `packages/schema/src/swarm.ts`; drizzle tables+migrations → `packages/core/src/swarm.sql.ts`; engine/tools/routes/config → `packages/opencode/src/swarm/…` etc.; route contract → `../../../packages/protocol` | Client/apps can render swarm state without importing the server; matches every stated rule; sdk-next composes for free | Three touch-points per feature change | ✅ |
| B. Everything in `packages/opencode/src/swarm/` | Single package | Fastest | Desktop/web would depend on server internals or duplicate types; violates the spirit of the schema boundary; blocks future sdk-next swarm clients | ❌ |
| C. New top-level `packages/swarm` package | Isolation | Clean ownership | Needs session/prompt access → either depends on `@opencode-ai/opencode` (cycle-ish, heavy) or re-creates a runtime-port abstraction — i.e. rebuilds the plugin problem inside the monorepo | ❌ (revisit only if clustering extracts swarms to their own service) |

Pure domain logic that needs no IO (DAG readiness computation, affinity scoring, belief confidence math, digest hashing) may initially live in `packages/opencode/src/swarm/domain/`; if sdk-next ever needs it, lift to `packages/core/src/swarm-domain` then — a move, not a rewrite, because it will already be IO-free.

### 4.2 Process model

| Option | Description | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. In-server service (chosen)** | Engine = Effect services inside the opencode server process, one instance per project via `InstanceState` | Zero IPC; direct Bus/Session/storage access; single writer per DB; headless serve + desktop + TUI all get identical behavior free; lifecycle/disposal handled by existing bootstrap | Shares the event loop with LLM streaming; server crash pauses swarms (mitigated: durable state + startup reconcile, which openswarm already does well) | ✅ |
| B. Separate supervisor process | Standalone daemon owns swarms | Survives server restarts; isolation | Cross-process SQLite contention (two writers on one DB or a second DB + sync), bespoke IPC protocol, deployment story ×3 (serve/desktop/tui), breaks "one artifact" parity | ❌ |
| C. Hybrid (engine in-server, sweeps on worker threads) | — | CPU isolation for sweeps | Premature; sweeps are cheap DB passes; Bun worker + Effect runtime bridging cost > benefit today | ❌ (note as future option if profiling demands) |

Event-loop contention mitigation (see §8): bounded, jittered sweeps; no unbounded loops; all member prompting goes through the host's existing queueing semantics rather than fire-and-forget promises.

### 4.3 Swarm ↔ Session relationship

**Decision:** members remain real root Sessions (proven topology — visible in Home/tabs, chat-able by the user, mid-turn absorption works). The swarm relationship becomes **first-class data**, not convention:

- `swarm_member.session_id` references the session id (swarm-owned pointer; sessions do not gain a back-reference column — avoids coupling the core session table to an optional feature).
- Coordinator is a member row with `role='coordinator'` bound to the creating session; "parent" exists only in swarm-domain terms, exactly as openswarm's ROOT_MEMBER_SESSIONS_PLAN decided — we adopt that decision natively.
- Titles become **free-form again**: the 🐝 emoji stops being load-bearing (UI derives membership from tables). Spawn sets a readable default title (`<swarm> / <member>`); auto-titling suppression for member sessions should be handled by a spawn flag on the session-creation path rather than the emoji trick (§6-H3).
- Member identity available to any subsystem via a lookup (`session_id → member`), which also gives permissions/tools a first-class "am I a swarm member" check without sniffing.

### 4.4 Persistence

| Option | Description | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Host drizzle store (chosen)** | 11 `swarm_*` tables in `packages/core/src/swarm.sql.ts`, migrations applied by core, `project_id` scoping like other tables | One connection/lock regime; transactions can span session+swarm state; one migration system; multi-project scoping solved by existing columns; backup/restore is one file | Swarm growth shares DB budget with everything else (WAL + short writes make this fine at swarm scale) | ✅ |
| B. Dedicated DB (status quo) | Keep `.opencode/swarms/swarms.db` | Blast-radius isolation; portable | Two drivers, two lock regimes, no cross joins (member↔session integrity enforced by app code — the exact bug class openswarm fights with ownership guards), two migration stories, discovery/scoping hacks | ❌ |

Table set (carried over from openswarm's proven schema, STORAGE.md §2): `swarm`, `swarm_member` (+ `human_chat_at`), `swarm_task` (+ lease columns), `swarm_task_dependency`, `swarm_message`, `swarm_blackboard`, `swarm_path_claim`, `swarm_artifact_annotation`, `swarm_belief`, `swarm_subscription`, `swarm_event`. Column style per root AGENTS.md (snake_case, no string-renamed fields). Invariants worth keeping verbatim: partial UNIQUE for active path claims, CAS guards on blackboard/task-claim/message-claim, terminal-state guards, cascade deletes scoped by `project_id` + `swarm_id`.

**Migration story for existing `.opencode/swarms/swarms.db`:** one-time, read-only importer (new module `packages/opencode/src/swarm/migrate-legacy.ts`). Reads the legacy DB (its `user_version` chain ≤7 is documented and stable), maps workspace dir → host project id, inserts rows into native tables, records imported-at marker, leaves the legacy file untouched (rollback = delete native rows). Runs lazily on first swarm-service init per project, or via an explicit CLI/API verb. Legacy child-session members import as-is; they keep working (all machinery is session-id keyed) and re-root naturally on next respawn — same passive-migration stance openswarm chose (ROOT_MEMBER_SESSIONS_PLAN §5.10).

### 4.5 Eventing

Publish swarm events into the existing pipeline: engine → `GlobalBus.emit("event", {directory, payload})` → `server/event.ts` projection → SSE → generated SDK. Requirements for api-designer (who owns exact names/shapes):

- **Entities:** `swarm.updated` (upsert snapshots: swarm/member/task/mail counts) as the coarse-grained feed UIs subscribe to.
- **Fine-grained:** `swarm.member.status` (incl. `chatting` transitions), `swarm.task.state`, `swarm.message.delivery` (queued/delivered/expired/failed verdicts — the sender-truth surface MESSAGING.md §2 promises), `swarm.permission.pending/resolved`, `swarm.emergency.tripped/cleared`, `swarm.hive.consolidated/pruned`, `swarm.stall.diagnosed`.
- All payloads defined once in `packages/schema/src/swarm.ts` (browser-safe, per schema-package doctrine), classified `current` for the manifest; nothing V1-only leaks in.
- Permission observability: pending asks become queryable rows/events emitted by the permission engine itself, so the engine subscribes in-process and the SSE-scraping backstop dies. *(Exact seam unverified — open question Q3, api-designer to confirm.)*
- Internal consumers (scheduler triggers, supervisor reduce) subscribe to the same bus — one event plane, no side channel.

### 4.6 Multi-project / multi-instance / headless / desktop implications

- **Multi-project:** swarm rows carry `project_id`; the engine instantiates per opened project via `InstanceState` (ScopedCache keyed by directory) — matching how other per-project services behave. Cross-project swarms are out of scope (matches openswarm).
- **Multi-instance (two servers on one project):** both processes would pass through the same DB. Scheduler/sweep must therefore be safe under multi-writer: keep openswarm's conditional-UPDATE claim discipline (it was designed for exactly-once under concurrency) and gate sweeps with a lightweight DB lease row (single `swarm_runtime` row per project: `owner_instance`, `heartbeat_at`) so only one instance actively schedules while others stand by. *(New requirement vs openswarm, which assumed one process — flagged as risk R6.)*
- **Headless serve parity:** everything user-visible flows through HTTP+SSE, so `opencode serve` gets full swarm functionality by construction — this *replaces* openswarm's DESKTOP.md concerns about plugin loading differences across hosts.
- **Desktop split:** renderer consumes the generated client + SSE (ux-designer's lane). Electron main needs nothing swarm-specific initially (notifications can ride existing app-notification plumbing fed by swarm events). No engine code in main ⇒ packaged-EXE staleness trap (root AGENTS.md warning) doesn't apply to swarm logic beyond normal build freshness.
- **TUI:** consumes the same events/routes; parity is a UX-lane decision, not an architecture constraint.

---

## 5. New / changed modules list (dep-direction compliant)

| # | Module | New/Changed | Responsibility | Deps (must satisfy direction) |
|---|---|---|---|---|
| 1 | `packages/schema/src/swarm.ts` (+ siblings if it grows) | NEW | Browser-safe wire contracts: swarm/member/task/message/blackboard/belief entities + event payloads + ID schemas (`Swarm.ID`, `Swarm.Member.Name`, …) following schema-package naming/optional/mutability rules | effect only ✓ |
| 2 | `packages/protocol/src/swarm.ts` | NEW | Route contract for current `/api` swarm surface (contract authorship shared with api-designer) | schema ✓ |
| 3 | `packages/core/src/swarm.sql.ts` | NEW | Drizzle tables (11 `swarm_*`) + migration registration | schema (allowed) ✓ |
| 4 | `packages/opencode/src/swarm/service.ts` | NEW | SwarmService façade; ops + validation + bus publishing | core, schema, session, storage ✓ (server-side pkg) |
| 5 | `packages/opencode/src/swarm/broker.ts` | NEW | Mailbox delivery state machine → in-process member prompting | service, session ✓ |
| 6 | `packages/opencode/src/swarm/scheduler.ts` (+ `domain/dag.ts`) | NEW | Readiness passes, claims, leases, retries, affinity | service, storage ✓ |
| 7 | `packages/opencode/src/swarm/supervisor.ts` | NEW | Event reduce, member lifecycle, startup reconcile | bus, service ✓ |
| 8 | `packages/opencode/src/swarm/stalls.ts` | NEW | Stall diagnosis + escalation ladder (port) | service ✓ |
| 9 | `packages/opencode/src/swarm/humanchat.ts` | NEW | Suppression windows around direct user chat | service ✓ |
| 10 | `packages/opencode/src/swarm/hive.ts` | NEW | Blackboard/beliefs/annotations/consolidation/relevance-hook point | service, storage ✓ |
| 11 | `packages/opencode/src/swarm/notices.ts` | NEW | Debounced coordinator digests (port, thinner) | broker, render ✓ |
| 12 | `packages/opencode/src/swarm/emergency.ts` | NEW | Freeze/stop/nuke guard; durable state row replaces JSON file | service, storage ✓ |
| 13 | `packages/opencode/src/swarm/render.ts` | NEW | Envelopes, `[DATA]` fence, timelines, mention extraction (pure) | none (pure) ✓ |
| 14 | `packages/opencode/src/swarm/migrate-legacy.ts` | NEW | Read-only importer from `.opencode/swarms/swarms.db` | storage, node sqlite reader ✓ |
| 15 | `packages/opencode/src/tool/swarm/*.ts` | NEW | First-class `swarm_*` tools delegating to SwarmService | swarm service, tool kit ✓ |
| 16 | `packages/opencode/src/config/swarm.ts` | NEW | `ConfigSwarm` self-export module (enabled, defaults, policies) | config pattern ✓ |
| 17 | `../../../packages/opencode/src/agent` (preset entry) | CHANGED | Ship built-in `swarm` member-agent doctrine (P2P peer text, currently `.opencode/agents/swarm.md` in the plugin repo) | — ✓ |
| 18 | `../../../packages/opencode/src/event-manifest.ts` | CHANGED | Register swarm event types | schema ✓ |
| 19 | `packages/opencode/src/server/routes/instance/httpapi/swarm.ts` | NEW | V1 route group handlers → SwarmService | service, protocol ✓ |
| 20 | `../../../packages/client` + `../../../packages/sdk/js` | REGENERATED | `bun run generate` / `./packages/sdk/js/script/build.ts` — never hand-edited | scripted ✓ |
| 21 | `../../../packages/plugin` | CHANGED (later phase) | Deprecation notice when a swarm plugin is detected alongside native swarms | — ✓ |
| 22 | `../../../packages/app`, `../../../packages/desktop` | CHANGED (ux lane) | Consume generated client + events; swarm panels | client/schema only ✓ |

Dependency audit: nothing new crosses Client→Core/Server; Schema gains no runtime behavior; Core gains only tables; all orchestration sits server-side where session access already lives.

---

## 6. Deleted-hacks list (what DIES when native)

> Basis: direct reading of `openswarm/src/plugin.ts` (lines cited) + plugin docs. Scout's exhaustive inventory (`01-plugin-capability-map.md`) should be diffed against this table before implementation starts — I've requested it; deltas expected on watchdog/stall minutiae.

| # | Hack (today) | Evidence | Native replacement |
|---|---|---|---|
| H1 | **Prefix-sniffing self-injection classification** — injected prompts recognized by text prefixes (`[NEW MESSAGE FROM:`, `[TEAM SYNC —`, `[WATCHDOG]`, `You are \``, `Resumed after…`) plus an in-memory messageID LRU registry (`swarm-inj-`) | ROOT_MEMBER_SESSIONS_PLAN §5.3.1; humanchat tracker wiring in `plugin.ts:650-653` | Injection sites set a structured source marker on the created user message (engine creates messages in-process, so the field is authoritative, not inferred). Human-chat detection reads the field; registry + prefixes deleted |
| H2 | **SSE scraping of its own server** — separate `client.v2.event` subscription loop w/ exponential backoff because the plugin event hook drops location-less V2 permission events | `plugin.ts:787-837` (`v2EventLoop`, `PERMISSION_LIFECYCLE_EVENT_TYPES` incl. `session.next.moved`) | Engine subscribes to `GlobalBus` directly; permission pending/resolved become first-class store rows + events (Q3) |
| H3 | **Polling backstop for pending asks** — throttled GET polls per member session as a safety net | `plugin.ts:128-132` (`PERM_POLL_THROTTLE_MS`) | Same as H2: authoritative pending-permission state is local; no polls |
| H4 | **Title emoji trick** — `🐝 <swarm>/<member>` titles defeat auto-titling and encode membership | ROOT_MEMBER_SESSIONS_PLAN §3.3-5, §5.5 | Membership from `swarm_member` rows; auto-title suppression via explicit spawn flag; emoji optional cosmetic |
| H5 | **Abort-stamp heuristics** — in-memory `recentAborts` map + 10 s attribution window + JSON-string regex over error payloads (`looksLikeAbortError`) to detect operator stops on older builds | `plugin.ts:49-112` | Typed `session.idle reason:"aborted"` read in-process; typed error classes (`Schema.TaggedErrorClass`) replace JSON regex; no time-window attribution |
| H6 | **Worktree-scoping permission heuristics** — `..`-traversal rejection, slash normalization, temp-dir allowance, empty-worktree legacy blanket rules (P-D1/D2/D3), bash-vs-glob wildcard special-casing | `plugin.ts:369-443` (`applyWorktreeScoping`) | Declarative permission ruleset computed once at spawn from coordinator policy and attached to the session (V1 update accepts permission rulesets — compat report fact 9); engine never intercepts asks except for dynamic escalation, which becomes an explicit API action |
| H7 | **Coordinator-permission inheritance + propagation sweep** — `inheritCoordinatorPermission` fallback + 10 s `propagateSwarmAutopermissions` clamp-and-copy pass | `plugin.ts:338-344`, sweep at `plugin.ts:886-889` | Rulesets derived at spawn; policy changes propagate via explicit `swarm_permissions` action writing member rows (already the tool semantic) — no periodic re-clamping |
| H8 | **Allow-all high-risk advisory machinery** — flood caps (`ADVISORY_PER_MEMBER_MS`, `ADVISORY_PER_SWARM_MAX`), batch buffers, dedup sets (`allowAllAdvisedIds`, `notifiedProviderErrors`) | `plugin.ts:138-151, 584-604` | Under declarative rulesets there is no silent auto-allow to trace; residual advisories become ordinary durable events; dedup via unique event keys instead of in-memory Sets |
| H9 | **Watchdog silence accounting** — `lastSeenActivity`/`watchdogStrikes`/`lastWatchdogNudgeAt` anti-self-feed maps, kickoff grace windows | `plugin.ts:554-563`; SCHEDULER.md §7 | Nudges carry the structured injection marker (H1) so liveness excludes them structurally; strikes/leases persist on task/member rows; watchdog shrinks to lease-expiry + stall ladder on typed events |
| H10 | **Idle-continue counter** — `MAX_CONTINUE_ATTEMPTS=12` + `continueNotifiedTasks` dedup Set | `plugin.ts:45-47, 537-542` | Explicit `max_continues` policy column on the task row; continuation attempts recorded as events; dedup by uniqueness |
| H11 | **NoticeAggregator debounce + gone-coordinator throttles** — in-memory timers/maps to avoid spamming dead sessions | `plugin.ts:520-540, 630-644` | Notifications are durable rows delivered through the broker; batching becomes a render/UI concern; dead-coordinator handling falls out of member-status checks |
| H12 | **Re-root healing** — respawns silently re-root legacy child members; parentID-immutability workaround | compat report addendum; `respawnMember` | All members born root; legacy children import as-is and re-root on natural respawn — healing pass deleted after cutover |
| H13 | **V1/V2 permission-engine duality workarounds** — dual event-type sets, injectable `v2Client`, graceful degradation branches | `plugin.ts:114-126, 488-495` | One engine, one seam (H2/H3); degradation branches deleted |
| H14 | **Module-level singleton + test-dispose hook** — sticky runtime leaking across bun test workers | `plugin.ts:445-466` | Effect Layer + `InstanceState` lifecycle; tests compose isolated layers; no global mutable state |
| H15 | **Dual DDL + drift test** — `schema.sql` vs `SCHEMA` constant kept in lock-step by a test | STORAGE.md §1, §3 | Drizzle schema is the single source; core migrations; drift test deleted |
| H16 | **Serialized promise queue + cross-runtime driver pick** (`bun:sqlite` vs `node:sqlite`) | STORAGE.md §1 | Host storage's established concurrency approach; one driver |
| H17 | **Duplicated model catalog** — pricing/capability/variant logic re-implemented in `models/catalog.ts` | `plugin.ts:27` imports | Host provider catalog (`../../../packages/core/src/catalog.ts`, `../../../packages/opencode/src/provider`) reused; module deleted |
| H18 | **Emergency state as loose JSON file** read at init | `plugin.ts:641-644` | Durable `swarm_emergency` row (or global storage key) surfaced via API/events; same freeze/stop/nuke semantics |
| H19 | **HTTP-client runtime adapter** — entire `runtime/opencode-runtime.ts` translating engine intents into REST calls to the server it lives inside | module + `PluginInput.client` usage | Direct in-process service calls (session create/prompt/abort/update); adapter deleted wholesale |
| H20 | **Capability probe harness** (`probe/compat.ts`) proving the plugin CAN do things through public APIs | `src/probe/` | Obsolete — native code has the capabilities by construction; host tests cover regressions |

Kept deliberately (not hacks): the `[DATA]` trust-fence rendering discipline (H1-adjacent but it's a *prompt-security* feature — moves to `render.ts`); mention resolution/fuzzy member matching (UX quality); belief/annotation TTL semantics; exactly-once claim SQL patterns (they're correct engineering, they just migrate into the host store layer).

---

## 7. Sequencing notes for implementers

Ordered so every phase is independently shippable and the V1 contract stays intact:

1. **Phase 0 — Contracts & tables.** `schema/src/swarm.ts` entities+events; `core/src/swarm.sql.ts` tables+migrations; `event-manifest` registration. No behavior. Gate: typecheck + contract tests per schema-package test doctrine (optional-omits-undefined, identifier uniqueness, manifest classification).
2. **Phase 1 — Engine skeleton.** `swarm/service.ts` + storage access + config module + built-in agent preset. Create/spawn/status work in-process; expose via a minimal V1 route group; regenerate client+SDK. Tools still unavailable externally.
3. **Phase 2 — Orchestration core.** Broker + scheduler + supervisor on `GlobalBus`; human-chat suppression with structured injection markers; emergency guard. This is where openswarm's battle-tested semantics land mostly verbatim — port tests with them (openswarm's unit suites are the spec).
4. **Phase 3 — Permissions.** Spawn-time ruleset derivation; dynamic escalation action; kill H6/H7/H13 behaviors. Coordinate with api-designer for the pending-permission observability seam (Q3).
5. **Phase 4 — Full surface.** Complete route group + first-class tools + hive/stalls/notices/revive; regenerate SDK; TUI/web/desktop can light up (ux lane).
6. **Phase 5 — Migration & coexistence.** Legacy importer; plugin-deprecation detection ("native swarms enabled + swarm plugin configured" → actionable warning); docs.
7. **Phase 6 — Cleanup.** Delete deprecated shims once telemetry shows adoption; close V1-compat notes.

Cross-cutting rules: every phase regenerates SDK via the sanctioned scripts; tests run from package dirs (never repo root); typecheck via `bun typecheck` per package; branch naming per root AGENTS.md (≤3 hyphen-separated words, no `feat/` prefixes).

---

## 8. Risks & mitigations (architecture-level)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Event-loop contention**: scheduler sweeps + broker deliveries compete with LLM streaming in one process | Medium | Latency spikes on active turns | Sweeps via `Effect.schedule` with jitter + skip-if-running (openswarm's re-entrancy guard semantics preserved); deliveries bounded per pass; measure before adding workers (option C stays on the shelf) |
| R2 | **DB locking** on the shared store under bursty swarm writes | Low-Medium | Write stalls affecting normal sessions | WAL (host default), short transactions, openswarm's conditional-UPDATE claim SQL carried over; no locks held across external calls (openswarm rule adopted as doctrine) |
| R3 | **Dual writers on a member session** (user typing vs engine delivering mail) | Medium | Confusing interleaving — but this is *by design* (human-chat feature) | Suppression windows (humanchat) + structured injection markers make interleaving legible; native mid-turn absorption already handles the mechanics (verified) |
| R4 | **Session ownership ambiguity**: who may abort/delete member sessions | Medium | User deletes a member mid-task → DAG deadlock (openswarm handles via `session.deleted` → stopped + task release) | Port the supervisor's deletion/failure handling unchanged; UI surfaces member-task bindings so deletion is informed (ux lane) |
| R5 | **Crash blast radius**: server crash pauses all swarms | Low | Stalled work until restart | Durable-first design inherited from openswarm (enqueue-before-delivery, claim leases, startup reconcile); recovery stays detection-only, respawn explicit |
| R6 | **Multi-instance double-scheduling** (two serves on one project) | Low | Duplicate assignments, flapping | DB lease row elects one active scheduler per project; claim CAS makes even a split-brain pass safe (worst case: wasted pass, not corruption) |
| R7 | **Schema-layer scope creep** — pulling runtime behavior into `../../../packages/schema` | Medium | Boundary erosion the whole repo pays for | Schema-package AGENTS.md is explicit; reviewer gate: swarm schema PRs contain zero imports beyond effect |
| R8 | **Clustering future** (AGENTS.md: local drains process-local "until clustering is implemented") | Certain eventually | Engine assumptions break if sessions place remotely | Keep engine decisions DB-row-driven (never in-memory-only truth), route all member actions through service seams that could later proxy to a remote placement; document as the exit criterion for option C-packaging revisit |
| R9 | **Migration data loss** from legacy `swarms.db` | Low | User loses swarm history | Importer is read-only + additive; legacy file untouched; dry-run verb reports what would import |
| R10 | **Permission-model regression** — declarative rulesets weaker than the ask-hook gauntlet | Medium | Members escape worktree bounds | Rulesets derive from the same boundary math (worktree+temp allow, deny-by-default outside) but evaluated by the host permission engine, which is the audited path; keep openswarm's P-D1/D2/D3 edge cases as ruleset-generation tests |

---

## 9. OPEN QUESTIONS

1. **Q1 — Wire-contract placement detail:** do swarm routes belong in the V1 httpapi group only, or additionally as a `../../../packages/protocol` current-surface contract now? Root AGENTS.md says V1 is the production surface; schema/protocol AGENTS.md says protocol+sdk-next are the current `/api` surfaces. Needs api-designer + a look at how recent features (e.g. question/permission V2 work) straddled this. *(Owner: api-designer.)*
2. **Q2 — Programmatic session seam:** exact in-process entry points for create/promptAsync/abort equivalent to the REST verbs (likely `../../../packages/opencode/src/session/session.ts` + `prompt.ts` internals). Must be confirmed by reading those files before Phase 1; the blueprint assumes clean callable services exist since the server routes are thin. *(Unverified.)*
3. **Q3 — Pending-permission observability:** does the permission engine already persist pending asks queryably, or is that an addition? Determines how much of H2/H3's replacement is new engine work vs pure consumption. *(Owner: api-designer; unverified.)*
4. **Q4 — Session metadata linkage:** is there an existing generic `session.metadata` write path usable for swarm hints (nice-to-have for UI filtering), or is `swarm_member.session_id` the only linkage? Preference is swarm-owned tables regardless; this only affects convenience queries.
5. **Q5 — Auto-title suppression mechanism:** does session creation accept a "no auto-title" flag natively, or must member spawns set a non-default title (the emoji trick's honest successor)? Small but user-visible.
6. **Q6 — InstanceState granularity:** swarms are project-scoped but `InstanceState` is directory-keyed — confirm whether multiple directories of one project share the swarm engine instance or whether the lease-row election (R6) covers it.
7. **Q7 — Built-in agent preset mechanics:** where built-in agent doctrines live in `../../../packages/opencode/src/agent` and how user overrides merge — needed for shipping the `swarm` doctrine without forcing config.
8. **Q8 — Scout delta:** scout's capability map may surface hacks/heuristics I under-weighted (stall-ladder internals, revive specifics, chunkdb backend). Section 6 should be reconciled against `01-plugin-capability-map.md` before implementation planning freezes.
9. **Q9 — Chunkdb backend fate:** openswarm supports a compressed-KV alternative store (`storeBackend: "chunkdb"`). Recommendation: let it die (native storage makes it pointless) — confirm nobody depends on it.
10. **Q10 — Desktop notification path:** whether Electron main already exposes a generic event→OS-notification bridge the ux lane can subscribe to, or swarm notifications need main-process work.

---

## Appendix A — Decision log (for migration-chief synthesis)

| Decision | Choice | Key rationale | Reversibility |
|---|---|---|---|
| Packaging | Split schema/core/opencode per dep-direction | Only option satisfying all three AGENTS.md doctrines simultaneously | Medium (moves are mechanical later) |
| Process model | In-server Effect services | Zero-IPC parity across serve/desktop/TUI; openswarm already proves durability covers crashes | High pre-Phase-2, low after |
| Member topology | Root sessions + swarm-owned linkage rows | Proven by plugin; kills title/prefix conventions | Low (matches shipped plugin behavior) |
| Persistence | Host drizzle store + read-only legacy importer | One lock regime, real FK integrity, one migration system | Medium |
| Eventing | Publish into GlobalBus→SSE→SDK | One event plane; kills scraping/polling | High |
| Permissions | Declarative spawn-time rulesets | Deletes the largest heuristic cluster (H6-H8, H13) | Medium (needs Q3 answer first) |
| Legacy DB | Passive import, file untouched | Matches openswarm's own passive-migration stance | High |
