# Scheduled Tasks — Runtime Architecture

**Status:** authoritative design document for the feature  
**Audience:** implementing agent or engineer starting T1

## 1. The bottom-up path, narrated first

`AGENTS.md` requires the real path to be narrated before patching. Here it is.

### 1.1 Producer → consumer (the supply path)

```text
user intent (\"every weekday at 09:00, run /review\")
        │
        ├── editor / HTTP API ───────────────────────────────────────┐
        │                                                           │
        └── conversation                                            │
              ↓                                                     │
            scheduled_task tool                                     │
              ↓ active human worker-root provenance + intent policy │
            ScheduledTaskAgent                                      │
              ↓ durable Session ownership (project + directory)     │
              └─────────────────────────────────────────────────────┤
                                                                    ↓
                                            ScheduledTask.Service.create
                                                                    ↓
                                      durable specification row scheduled_task
        ↓
         recurrence engine computes next_run_at      pure function, no I/O
        ↓
         ScheduledTask service writes the due cursor    authoritative owner
        ↓
         ScheduledTaskRunner (process-global, Tier 0)
              holds **one** timer armed to MIN(next_run_at)
        ↓      timer fires
         CAS claim → lease acquired (exactly-once)
        ↓
         ScheduledTaskExecutor (Tier 3 boundary — the **only** place
              that is allowed to materialize an Instance)
        ↓
         InstanceStore.load({ directory }) → session create → hostPrompt
        ↓
         scheduled_task_run row settled (ok / failed / skipped)
        ↓
         compact EventV2 projection event (no history, no bodies)
        ↓
         client store patches one row → Scheduled inbox   badge
```

### 1.2 UI → source of truth (the reverse demand path)

Walking backwards from every thing the UI wants to show:

| UI needs | Answered by | Cost |
|---|---|---|
| Task list (name, enabled, schedule summary) | `scheduled_task` rows | One indexed query, **Tier 0** |
| \"Next run in 4m 12s\" | `next_run_at` **already materialized** on the row | Zero — it is a stored integer, not a recomputation |
| \"Last run succeeded / failed\" | `last_run_status`   `last_run_at` denormalized onto the task row | Zero extra queries |
| Link to the current execution attempt's session | `scheduled_task_run.session_id` scalar, attempt-fenced and written before Goal/model work | No session hydration |
| Unread inbox badge count | `COUNT(*) WHERE acknowledged_at IS NULL AND status IN (...)` | One aggregate, indexed |
| Run history for one opened task | `scheduled_task_run` paged by task | **Only on explicit open** |
| The actual agent output | Navigate to the session | Normal session detail path |

**Every single UI need is answered by a scalar that the producer already knew at
the moment it changed.** Nothing in this table requires loading messages, parts,
history, or an Instance. That is the test `AGENTS.md` demands — \"load 200 messages
to draw one badge\" does not appear anywhere in this table.

## 2. Ownership tier classification

This feature **spans tiers**, and that is the single most important fact about it.
The design succeeds or fails on keeping the boundary sharp.

| Operation | Tier | Justification |
|---|---|---|
| List / get / create / update / delete / enable a task | **0** | It is durable global catalog state. `AGENTS.md` lists \"durable project catalog, global session indexes/status\" as Tier 0. A schedule is the same kind of fact. |
| Conversational create | **0** | One durable Session lookup establishes project/directory ownership, then the same `ScheduledTask.Service.create` writer runs. The uncontended hot path has no extra idempotency preflight and no Instance/runtime materialization; only duplicate/replay recovery performs an indexed name lookup. |
| List runs / acknowledge a run / inbox count | **0** | Durable history rows keyed by task. |
| Timer arming, due scan, lease claim | **0** | Process-global bookkeeping over a global table. Must **never** touch `InstanceStore`. |
| Validating that a task's target directory still exists | **1** | Durable location metadata. Requires an explicit directory, no runtime init. |
| Resolving agent/model availability for the editor dropdowns | **2** | Workspace configuration catalog. Already owned by existing provider/agent routes — **reuse them, do not mirror them into the scheduler group.** |
| Firing a run (instance load, session create, prompt) | **3** | Full execution graph. The executor is the **sole** Tier 3 component. |

### 2.1 The boundary rule, stated as an invariant

+ **A scheduled task exists, is listed, is edited, is enabled, and becomes due
+ without any Instance ever being materialized. An Instance is created at
exactly
+ one moment: after a lease is successfully claimed and immediately before
agent
+ work begins.**

This is the negative invariant required by `AGENTS.md` § \"Performance Closure
Standard\", and T9 turns it into a failing test.

A concrete trap to avoid: it is *very* tempting to put the scheduler routes in the
existing `InstanceHttpApi` next to `session` and `goal`, because a task \"belongs to
a project\". Doing so drags every sidebar poll through
`WorkspaceRoutingMiddleware → InstanceContextMiddleware → InstanceStore.load`,
which initializes config, plugins, tool reload, and warmup services. The route
group **must** go on `RootHttpApi` (alongside `ControlApi`, `GlobalApi`,
`UsageApi`), not `InstanceHttpApi`. The HttpApi `AGENTS.md` states this directly:
\"Do not put a cheap endpoint behind heavy group middleware merely because it
shares a noun with runtime-heavy siblings.\"

## 3. Data model

Three tables. The split is not cosmetic — each has a different **writer**, a
different **lifetime**, and a different **failure meaning**.

### 3.1 `scheduled_task` — user-owned specification

Writer: the user through API/UI, the trusted conversational admission producer,
or a loop file. Lifetime: until deleted.

```ts
// packages/core/src/scheduled-task/sql.ts
export const ScheduledTaskTable = sqliteTable(
  \"scheduled_task\",
  {
    id: text().$type<ScheduledTask.ID>().primaryKey(),

    // -- ownership ------------------------------------------------
    // Nullable: a global task (\"every Monday, summarize all projects\")
    // is a real use case — Codex supports running one task across more
    // than one project. See §3.5 for the fan-out decision.
    project_id: text()
      .$type<ProjectSchema.ID>()
      .references(() => ProjectTable.id, { onDelete: \"cascade\" }),
    // Explicit target directory. NOT NULL by construction for project
    // tasks. This is the `AGENTS.md` \"missing location is toxic\" rule:
    // a task with no directory must fail to fire, not fall back to cwd.
    target_directory: DatabasePath.absoluteColumn(),

    // -- identity -------------------------------------------------
    name: text().notNull(),
    enabled: integer({ mode: \"boolean\" }).notNull().default(false),
    revision: integer().notNull().default(0),  // optimistic concurrency

    // -- schedule specification (see 02-scheduling-semantics.md) -----
    schedule: text({ mode: \"json\" })
      .$type<ScheduledTask.Schedule>()
      .notNull(),
    timezone: text(),                      // IANA id; null = host zone

    // -- what to run ---------------------------------------------
    action: text({ mode: \"json\" })
      .$type<ScheduledTask.Action>()
      .notNull(),

   	// -- policy (all explicit, none implicit) ---------------------
    policy: text({ mode: \"json \" })
      .$type<ScheduledTask.Policy>()
      .notNull()
      .default({}),

    // -- THE DUE CURSOR ---------------------------------------
    // The single most important column in the feature. Materialized
so
    // that \"what is due?\" is an index range scan, not N recurrence
    // evaluations. NULL = not scheduled (disabled, or exhausted
once).
    next_run_at: integer(),

    // -- denormalized projection for O(1) row decoration ------------
    // Written by the settle step. Exists so a sidebar row never
queries
    // the runs table. This is the \"compact projection\" `AGENTS.md`
    // demands for dense navigation surfaces.
    last_run_at: integer(),
    last_run_status: text().$type<ScheduledTask.RunStatus>(),
    last_run_id: text().$type<ScheduledTask.RunID>(),
    consecutive_failures: integer().notNull().default(0),

    // -- creation provenance --------------------------------------
    source: text().$type<\"api\" | \"agent\" | \"loop_file\">().notNull().default(\"api\"),
    source_path: text(),
    // Scalar correlation only: pruning the conversation must not erase
    // why this durable schedule exists.
    source_message_id: text(),

    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    // THE scan index. Partial on enabled so the due query touches only
    // live rows. Drizzle emits this via a raw index in the migration.
    index(\"scheduled_task_due_idx\").on(table.enabled, table.next_run_at),
    index(\"scheduled_task_project_idx\").on(table.project_id, table.name),
    uniqueIndex(\"scheduled_task_source_path_idx\").on(table.source_path),
  ],
)
```

#### Creation provenance and conversational idempotency

Task-definition provenance and execution-turn provenance are separate planes.
An agent-created task stores `source=agent` plus the exact durable
`source_message_id` of the human worker root that authorized creation. The
message id is deliberately a scalar, not a foreign key: deleting/pruning a
conversation must not erase schedule attribution.

Public HTTP creation does not accept either field. Only the trusted
`ScheduledTaskAgent` producer may stamp agent origin. It first proves that the
**active/latest worker root itself** is a provenance-qualified human
Prompt/Command, then a domain-specific policy proves that this text explicitly
requested scheduling or confirmed the immediately preceding scheduling
proposal. A later host/scheduled/subagent worker root cannot borrow older human
consent.

Provider retries are convergent rather than duplicate-producing without taxing
the uncontended create path. The agent goes directly through the canonical
IMMEDIATE create transaction. Only if that create reports a duplicate/validation
conflict does it perform an indexed `(project_id, name)` recovery read. The same
`source_message_id + exact normalized task specification` returns the existing
row with `created=false`; the same name with different authorization/spec fails
closed instead of silently mutating user-owned automation.

### 3.2 `scheduled_task_lease` — runtime claim cursor

Writer: the runner. Lifetime: one firing attempt. **Deliberately not columns on
`scheduled_task`.**

This split is copied straight from the reasoning already written into
`packages/core/src/goal/sql.ts`:

+ \"Keeping the operational cursor separate from Goal specification state means a
+ process crash cannot manufacture Goal progress, and user-owned Goal revisions
+ remain independent from runner bookkeeping.\"

The same logic applies verbatim. If lease state lived on the spec row, every
heartbeat would bump `time_updated` and race with user edits guarded by
`revision`.

```ts
export const ScheduledTaskLeaseTable = sqliteTable(
  \"scheduled_task_lease\",
  {
    // ONE lease per task — this PK *is* the mutual exclusion
primitive.
    task_id: text()
      .$type<ScheduledTask.ID>()
      .primaryKey()
      .references(() => ScheduledTaskTable.id, { onDelete: \"cascade\" }),
    // The logical instant this lease is firing FOR. Not \"now\" — the
    // scheduled instant. Carried into the run row so catch-up
semantics
    // and idempotency are expressible. See 02 §4.
    fire_for: integer().notNull(),
    lease_id: text().notNull(),
    owner: text(),                     // PROCESS_OWNER_ID or NULL
    acquired_at: integer().notNull(),
    heartbeat_at: integer().notNull(),
    attempt: integer().notNull().default(1),
  },
  (table) => [
    uniqueIndex(\"scheduled_task_lease_id_idx\").on(table.lease_id),
    index(\"scheduled_task_lease_heartbeat_idx\").on(table.heartbeat_at),
  ],
)
```

### 3.3 `scheduled_task_run` — append-only outcome history

Writer: the executor. Lifetime: retained per retention policy.

Following the `goal_evidence` precedent, **external references are scalar IDs, not
foreign keys**. The comment in `goal/sql.ts` explains why: \"Session/checkpoint/message
cleanup must not erase the fact that evidence existed.\" A run history that
silently deletes itself when a user prunes a session is a broken audit trail.

```ts
export const ScheduledTaskRunTable = sqliteTable(
  \"scheduled_task_run\",
  {
    id: text().$type<ScheduledTask.RunID>().primaryKey(),
    task_id: text()
      .$type<ScheduledTask.ID>()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: \"cascade\" }),

    // The logical scheduled instant. With the unique index below this
is
    // the **idempotency key**: the database itself refuses a second
run
    // for the same logical instant, even if every layer above it
has a bug.
    fire_for: integer().notNull(),
    trigger: text().$type<\"schedule\" | \"manual\" | \"catchup\" | \"retry\">()
      .notNull(),

    status: text().$type<ScheduledTask.RunStatus>().notNull(),
    //  queued | running | waiting | succeeded | failed | skipped | abandoned
    //  `waiting` is the permission-pause state (03 § 5.1) and is an unread
    //  inbox status.

    // Scalar references — intentionally NOT foreign keys.
    session_id: text(),
    workspace_id: text(),
    directory: text(),

    skip_reason: text().$type<ScheduledTask.SkipReason>(),
    error_kind: text().$type<ScheduledTask.ErrorKind>(),
    error_message: text(),

    // Inbox read state. Codex's Scheduled view \"acts as your inbox\"
with
    // an unread indicator; this is that bit, owned server-side so
it
    // converges across desktop / web / mobile.
    acknowledged_at: integer(),

    started_at: integer().notNull(),
    finished_at: integer(),
  },
  (table) => [
    // IDEMPOTENCY. The single most important constraint in the
feature.
    uniqueIndex(\"scheduled_task_run_logical_idx\")
      .on(table.task_id, table.fire_for),
    index(\"scheduled_task_run_task_started_idx\")
      .on(table.task_id, table.started_at),
    // Inbox query: unacknowledged runs, newest first.
    index(\"scheduled_task_run_inbox_idx\")
      .on(table.acknowledged_at, table.started_at),
  ],
)
```

#### Session aggregate correlation

`scheduled_task_run.session_id` is the authoritative run -> Session pointer for
the current attempt and remains a scalar reference so Session pruning cannot erase
run history. The inverse classification needed by process-global consumers does
**not** justify another run-table index or history scan.

The original one-run-per-Session implementation stamps
`scheduledTaskID + scheduledTaskRunID` into V1 Session metadata. The next
continuity tranche supersedes the run-owned aggregate assumption: task-owned
Sessions keep task identity, while run identity remains on
`scheduled_task_run.session_id` plus the scheduled turn's typed provenance.
See `08-scheduler-workspace-session-continuity.md` for the normative migration.
Producer-owned Scheduled keys remain registered with the shared
`SessionMetadataOwnership` policy during that migration:

- public/general Session creation cannot mint them;
- generic metadata replacement retains the current producer-owned values while
  preserving replacement semantics for ordinary caller metadata;
- a fork/derived Session strips them because it is a new aggregate and must not
  inherit the source Session's producer identity.

This is aggregate provenance, not conversational authority. Individual scheduled
prompt authority continues to come only from the typed turn-provenance contract
described in 03 § 3.1.

The resulting task/run Session is also **not a subagent-style opaque worker**.
Producer-owned Scheduled metadata classifies task-owned aggregates; it does not
make the root Session host-only. The compatibility/default `new` policy still
creates one root per run, while `reuse` and `auto` may bind many runs to one
task-owned root and `existing` may target an ordinary user-owned root. Every run
remains independently auditable through its run row and typed
`scheduled-task.run` turn provenance.

Conversational authority is deliberately narrower than aggregate mutation
authority. The ordinary V1 Session prompt/command/shell transport may drive a
well-formed Scheduled run root, but public update/delete/fork/control/history
mutation continues to treat the producer-owned aggregate as protected. A partial
or malformed Scheduled metadata envelope fails closed rather than becoming an
ordinary public Session.

Human focus also reuses the shared Session input/execution plane rather than
introducing a scheduler-specific interrupt protocol. If a human prompt arrives
while an autonomous Scheduled provider cycle is already active, that in-flight
cycle may reach its safe terminal boundary; the durable User input establishes
the shared `SessionInput` user frontier and owns the **next** provider cycle ahead
of host/automatic work. This is the same safe-cycle steering law used by the
generalized Session/Swarm architecture, not an immediate blind cancellation of
an already-running provider stream.

Project navigation treats these roots as ordinary project Sessions even when the
executor's physical directory differs from the canonical worktree. The
bootstrap-free global root census can therefore be scoped by `projectID`; the
canonical worktree cache is the bounded project-wide root index, while sandbox
and detail stores remain physical-directory slices. Ordinary
`session.created|updated|deleted` events mirror a foreign-directory root into
that already-materialized project index (and, when present, its physical detail
store) without consulting Scheduled Task state. A partial
`(project_id,time_updated,id) WHERE parent_id IS NULL` index keeps that census
ordered and bounded.

**Note on the `retry` trigger vs the unique index.** A retry of the same logical
instant must *not* insert a second row — it **updates** the existing row and
increments `scheduled_task_lease.attempt`. This is deliberate: the inbox should
show \"the 09:00 run\" once, with its final outcome, not three rows for one
morning. If per-attempt forensics are later needed, add a child
`scheduled_task_attempt` table rather than relaxing this unique index.

### 3.4 Why not extend `goal_automation`? (rejected alternative)

It looks attractive — the lease columns already exist there. It is wrong:

- `goal_automation.session_id` is the **primary key**. A schedule that has never
  run has **no session**. You would have to invent a phantom session to hold a
row.
- Its lifecycle is \"continue an active conversation\"; ours is \"originate one\".
- `claim` there revalidates **goal focus**, which is meaningless pre-session.
- Coupling would mean deleting a session cascades away a schedule that should
  outlive it.

**Reuse the pattern, not the table.** T3 should literally re-read
`goal/automation.ts` and mirror its `claim`/`release`/recovery structure.

### 3.5 Multi-project fan-out (T0 decision: one target in v1)

Codex supports one task running across more than one project. That would imply a
join table (`scheduled_task_target`) and a fan-out of N runs per firing. T0
resolved this explicitly: **v1 has one target per task**, so the idempotency key
remains `(task_id, fire_for)`. If fan-out lands later,
`scheduled_task_run.fire_for` must become `(task_id, target_id, fire_for)` in the
unique index. That is an intentional future migration, not an unresolved v1
design choice; see decision 4 in `06-risks-and-open-questions.md`.

## 4. The due cursor invariant

This is the load-bearing idea. State it precisely:

+ **`next_run_at` is the authoritative, materialized, indexed answer to \"when
+ should this task next fire\". It is recomputed at exactly three moments —
task
+ mutation, run settlement, and timezone-data change — and at no other
time.**

What this buys:

1. **The due query is a range scan.**
   `SELECT ... WHERE enabled = 1 AND next_run_at <= :now ORDER BY next_run_at`
   No cron parsing in the hot loop. 1000 tasks cost one index seek.
2. **One timer, not N.** The runner arms a single timer to
   `MIN(next_run_at) - now`. `AGENTS.md` § \"Concurrency And Shared
Ownership\"
   requires exactly this: \"Prefer one shared owner for expensive observers,
   timers...\". Note the related warning though — \"A single shared timer that
   wakes N expensive per-row computations is still N work.\" Our single timer
   wakes and does **one query**, not N evaluations. That distinction is why
the
   cursor must be materialized rather than computed on wake.
3. **The UI gets the countdown for free.** No client-side cron library, no
   \"next run\" endpoint, no per-row timer. One shared 1s ticker in the client
   formats N already-known integers.

## 5. The lease protocol (exactly-once)

Four independent mechanisms stack here. Any one could fail; together they make
double-firing a database-level impossibility rather than a timing hope.

### Layer 1 — Compare-and-set acquisition

Uses the same database-CAS doctrine originally demonstrated by
`GoalAutomation.claim`, but not its process-owner recovery policy:

```ts
const claimed = yield* db
  .insert(ScheduledTaskLeaseTable)
  .values({ task_id, fire_for, lease_id, owner: PROCESS_OWNER_ID, ... })
  .onConflictDoNothing()         // <- PK on task_id rejects the second claimant
  .returning()
  .get()
if (!claimed) return undefined        // someone else owns this firing
```

### Layer 2 — Revalidate after claiming, before spending

`goal/automation.ts` does this and the reason generalizes perfectly:
\"Policy/lifecycle/focus may have changed after the reservation was created.\"

After acquiring the lease, and **before** loading an Instance, re-read the task
row and abort if: it was disabled, deleted, its `revision` changed in a way that
invalidates `fire_for`, its target directory no longer exists, or a run row for
this `fire_for` already reached a terminal status.

### Layer 3 — Database-enforced idempotency

The `uniqueIndex(task_id, fire_for)` on `scheduled_task_run`. Even if two
processes somehow both believed they held the lease, the **second INSERT
fails**. The executor treats a conflict on that index as \"another actor already
fired this instant\" and exits without starting work.

### Layer 4 — Crash recovery by owner identity

`goal/automation.ts` historically carried this assumption:

+ \"A different process owner in this local SQLite database can only be a
+ crashed/restarted predecessor. Requeue those claims once at service
+ construction. Same-process duplicate service instances share the module owner id
+ and therefore never steal one another's live reservation.\"

**That assumption is not sound in the supported shared-realm multi-process
topology, for Goal or ScheduledTask.** A second live OpenCode process can share
the same SQLite database. Blind foreign-owner clearing can therefore steal live
work. Goal worker continuation is planned to move beneath shared Session
execution ownership; ScheduledTask already uses a separate heartbeat lease.

**Therefore the recovery rule is heartbeat-based, not identity-based:**

```text
reclaim a lease only when
    heartbeat_at < now - LEASE_TTL      (stale — owner is gone or wedged)
OR
    owner = PROCESS_OWNER_ID            (explicit same-process teardown/startup
                                         reconciliation where no run can be live)
```

with `LEASE_TTL` comfortably larger than the heartbeat interval (current
implementation: heartbeat 30s, TTL 150s). Reclaiming a stale ScheduledTask lease
increments `attempt` and is recorded as such.

The newer RuntimeOwner design can replace feature-local
`scheduled-owner:<pid>:<uuid>` identity with one process-incarnation ID while
leaving this per-run heartbeat/retry policy intact. Shared identity does not turn
ScheduledTask into a Session-style non-expiring execution owner.

### Heartbeat cost

A heartbeat is one `UPDATE ... SET heartbeat_at = ? WHERE lease_id = ?` every
30s **per active run**, not per task. Idle tasks have no lease row at all. A
machine with 200 schedules and zero active runs performs **zero** heartbeat
writes. This satisfies the `AGENTS.md` requirement that background work be
bounded in the dimension that actually costs.

## 6. Service topology

```text
packages/schema/src/scheduled-task.ts         browser-safe contracts only
     ↑
     │
     ├── packages/core/src/scheduled-task/
     │     sql.ts         tables
     │     schema.ts      tagged errors (mirrors goal/schema.ts)
     │     recurrence.ts    **pure** — no DB, no clock read, no I/O
     │     index.ts       ScheduledTask.Service  (Tier 0, GlobalNode)
     │     lease.ts       ScheduledTaskLease.Service (Tier 0)
     │
     └── packages/opencode/src/scheduled-task/
           runner.ts      the single timer   claim loop (Tier 0)
           executor.ts    TIER 3 BOUNDARY — the only Instance loader
```

**Why the split across packages.** `AGENTS.md` § Workspace: \"Runtime
dependencies stay directed from Schema to Core and Protocol, then from Core and
Protocol to Server/OpenCode.\" The **domain** (rows, recurrence, leases) is Core
because it is pure durable state. The **runner and executor** live in
`packages/opencode` because they depend on `InstanceStore`, `SessionPrompt`, and
other OpenCode-owned runtime that Core must not see.

**Why `makeGlobalNode`.** `packages/core/src/effect/app-node.ts` defines `global`
and `location` tags. The scheduler is unambiguously `global` — one per process,
not one per directory. Registering it as a location node would create one
timer *per loaded instance*, which is the timer-fanout bug this design exists
to prevent.

### 6.1 Runner state machine

```text
             ┌────────────┐
             │    IDLE    │   no enabled task has a non-null next_run_at
             └─────┬──────┘
         task mutated │ MIN(next_run_at) exists
                     ▼
             ┌────────────┐  one timer, armed to the earliest instant
             │   ARMED    │  (clamped to MAX_SLEEP to survive clock jumps
             └─────┬──────┘   and suspend/resume — see 02 §5)
                     │ fires / invalidated / woken
                     ▼
             ┌────────────┐  one range-scan query; for each due task
             │  SCANNING  │  attempt a CAS claim (bounded concurrency)
             └─────┬──────┘
                     ▼
             ┌────────────┐  claimed → revalidate → executor → settle
             │  DISPATCH  │                                                        │
             └─────┬──────┘                                                      │
                     └──────── recompute next_run_at  ─────────────┘
                                  then re-arm
```

**Invalidation sources** (each must re-arm the timer): task created/updated/
deleted/enabled/disabled, run settled, manual \"run now\", loop-file sync, and
process resume after suspend.

## 7. Transport and events

Follow the Goal precedent exactly. `packages/schema/src/goal.ts` declares live
events with this comment, which applies unchanged here:

+ \"Live protocol events. These are intentionally non-durable in EventV2: the
+ authoritative ... rows ... are the durable source of truth, while these
+ notifications keep clients incrementally coherent.\"

Proposed events — **compact projections only, never output bodies**:

```ts
const Created   = define({ type: \"scheduledTask.created\",   schema: { taskID: ID, info: Info } })
const Updated   = define({ type: \"scheduledTask.updated\",   schema: { taskID: ID, info: Info } })
const Removed   = define({ type: \"scheduledTask.removed\",   schema: { taskID: ID } })
const RunStarted = define({ type: \"scheduledTask.runStarted\", schema: { taskID: ID, run: RunInfo } })
const RunSettled = define({ type: \"scheduledTask.runSettled\", schema: { taskID: ID, run: RunInfo } })
```

Register in `packages/schema/src/event-manifest.ts` alongside
`...Goal.Event.Definitions`.

`RunInfo` carries `{ id, taskID, fireFor, status, sessionID?, errorKind?,
acknowledgedAt?, startedAt, finishedAt? }`. It does **not** carry the agent's
output. If a client wants the result it navigates to `sessionID` and uses the
ordinary session detail path — the `AGENTS.md` rule that \"rich history hydration
is for an explicitly opened detail surface, not for background row decoration.\"

### 7.1 Event rate bound

Worst realistic case: 50 tasks on `* * * * *` (every minute) = 100 events/minute
≈ 1.7/s. Acceptable. But the **policy layer must enforce a minimum interval**
(suggest 60s floor, configurable) so a user cannot author a per-second cron and
saturate the event bus. Record this as a bounded-event-rate invariant in T9.

## 8. API surface and SDK obligation

Per the repo-root `AGENTS.md` § API Surfaces, the scheduler group is added to
`packages/opencode/src/server/routes/**`, which means it belongs to the
**Unified SDK** generated from `OpenCodeHttpApi`. After changing routes, run
`bun run build` from `packages/sdk/js`. Do **not** edit generated client files.
If Protocol also changes, `bun run generate` from `packages/client` too.

Group placement — **this is the architecturally load-bearing choice**:

```ts
// api.ts
export const RootHttpApi = HttpApi.make(\"opencode-root\")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(ForkCredentialApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(ProviderSettingsApi)
  .addHttpApi(UsageApi)
  .addHttpApi(ScheduledTaskApi)      // <- HERE. Tier 0. No instance middleware.
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)
```

**Not** `InstanceHttpApi`. See §2.1.

`runNow` also belongs to this Tier 0 group. The HTTP operation does exactly one
kind of work: validate and durably enqueue a `queued` manual run. It neither
materializes an Instance nor waits for agent work. The process-global runner is
woken by the authoritative `scheduledTask.runUpdated` event and only the
executor crosses the Tier 3 boundary. Classifying the route by the eventual
consumer rather than the work performed by the route would violate the
producer/ownership rule in both root and httpapi `AGENTS.md`.

The enqueue is restart-safe even if the writer dies before publishing its
process-local event: SQLite triggers advance a durable scheduler generation in
the same transaction as runnable-state mutations. Every runner owns one clamped
timer; when no recurrence cursor exists that timer performs a generation-only
reconciliation read. An unchanged generation re-arms without a due scan. A
changed generation performs the normal due scan. This is the cross-process
liveness floor; EventV2 remains the zero-latency same-process fast path.

## 9. Negative invariants (the closeout contract)

`AGENTS.md`: \"Every cross-layer performance closeout must include at least one
negative invariant that would have caught the original bug.\" These are ours.
Each becomes a test in T9.

| # | Invariant | How it is proven |
|---|---|---|
| N1 | **Zero implicit instances.** List/get/create/update/delete/enable/ack/runNow and the entire idle timer loop create exactly **0** `InstanceStore.load` calls — including when directory/workspace query params are omitted. | Instrument `InstanceStore.load` with a counter; assert 0 across the full CRUD + manual enqueue + 60 minutes of simulated idle time. |
| N2 | **One timer.** N tasks ⇒ 1 armed timer, not N. | Assert the scheduler's active timer count is ≤1 with 200 tasks loaded. |
| N3 | **No double-fire.** Two concurrent runners over one DB, 100 simultaneously-due tasks ⇒ exactly 100 run rows. | Two service instances, distinct owner ids, shared SQLite file. |
| N4 | **No per-row transport.** Rendering 50 task rows issues **one** list request and **zero** per-row requests or per-row subscriptions. | Network assertion in the client test. |
| N5 | **No history hydration for decoration.** The task list and inbox badge load **0** messages/parts. | Assert no message queries during list render. |
| N6 | **No cwd fallback.** A task whose target directory is missing or deleted **fails explicitly** (`skipped` / `target_missing`) and never resolves to `process.cwd()`. | Delete the directory, fire, assert skip reason and assert cwd was never read. |
| N7 | **Convergent teardown.** After disposal, zero armed timers, zero held leases owned by this process, zero leaked fibers. | Dispose and assert. |
| N8 | **Bounded event rate.** Events per second stay under the configured ceiling under a pathological schedule set. | Count emissions over a simulated hour. |
| N9 | **No recurrence evaluation in the hot loop.** The due scan performs 0 cron parses. | Spy on the recurrence module during a scan. |
| N10 | **Lost process-local wake cannot strand durable work.** A peer may commit runnable work and die before EventV2 publication; another idle process must discover it within the reconciliation bound without polling the task table. | Commit a queued run without publishing EventV2; assert the DB trigger advances the generation and an idle runner executes it after one reconciliation interval. |

## 10. Phasing

| Phase | Contents | Shippable? |
|---|---|---|
| **P1 — Spine** | T1 T2 T3 T4 T5. One target per task, `once`   `cron` only, no UI beyond API. | Internally, via SDK |
| **P2 — Surface** | T6 T8. Daily/weekly sugar, Scheduled inbox, badge, editor. | Yes |
| **P3 — Portability** | T7 loop files. | Yes |
| **P4 — Depth** | Goal composition polish, worktree target mode, multi-project fan-out, retention sweeper. | Yes |

Do not start P2 before N1–N3 pass. A scheduler with a beautiful inbox and a
double-fire bug is worse than no scheduler, because it spends real tokens and
mutates real repositories twice.
