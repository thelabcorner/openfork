# Surface and UX

**Read after:** `01-architecture.md`  
**Owns:** HTTP contract, SDK, events, client store, Scheduled inbox

## 1. Route ownership is a correctness question, not a style one

The httpapi `AGENTS.md` is unambiguous: \"Do not put a cheap endpoint behind
heavy group middleware merely because it shares a noun with runtime-heavy
siblings. Split groups/boundaries when their ownership tiers differ.\"

Every scheduled-task HTTP endpoint is a Tier 0 read or write against the global
database. `runNow` is not an exception: its HTTP responsibility is only the
durable enqueue. The process-global runner consumes that durable work
asynchronously and the executor is the sole Tier 3 boundary. If the group were
placed behind `InstanceContextMiddleware`, then even opening the Scheduled pane
could bootstrap config, plugins, tools, LSP, VCS, and snapshot merely to render
rows that were already sitting in SQLite.

```
Group \"scheduledTask\"           (Tier 0 — NO instance middleware)
  GET    /scheduled-task               list (optional projectID filter)
  POST   /scheduled-task               create
  GET    /scheduled-task/:id           get
  PATCH  /scheduled-task/:id           update (bumps revision)
  DELETE /scheduled-task/:id           remove
  POST   /scheduled-task/:id/enabled    toggle (cheap, separate from update)
  GET    /scheduled-task/:id/run        run history
  GET    /scheduled-task/run            inbox across all tasks
  POST   /scheduled-task/run/:runID/ack acknowledge (clears unread)
  POST   /scheduled-task/preview         dry-run the recurrence engine
  POST   /scheduled-task/:id/run-now    manual fire
```

One group, one ownership tier. The route returns the persisted queued run before
agent work starts. Same-process EventV2 gives immediate wakeup; a transactional
scheduler-generation token gives cross-process/restart liveness if that
ephemeral wake is lost.

### 1.1 The `preview` endpoint is not optional polish

Cron is a user-hostile notation and DST is worse. `POST /scheduled-task/preview`
takes a schedule   timezone and returns the next N instants as epoch millis,
with a `warnings` array (`\"skips on DST spring-forward 2026-03-08\"`,
`\"fires twice on 2026-11-01\"`). This:

- lets the editor show \"Next: Tue 9:00 AM\" **before** saving;
- puts the **one** recurrence implementation on the server (no client cron
lib
  that can disagree with the server — a classic split-brain bug);
- gives T2 a free end-to-end test surface.

It is Tier 0 and pure: no database write, no instance.

## 2. Events

Register in the schema package alongside the existing domains and add the
definitions to the event manifest — the same way `Goal.Event.Definitions` is
spread into it. **Do not invent a side-channel.**

| Event | Payload | Why it exists |
| --- | --- | --- |
| `scheduledTask.created` | `Info` | List convergence |
| `scheduledTask.updated` | `Info` | Includes `next_run_at` changes |
| `scheduledTask.deleted` | `{ id }` | — |
| `scheduledTask.runStarted` | `Run` | Drives \"running now\" affordance |
| `scheduledTask.runUpdated` | `Run` | Publishes live projection changes, including Session binding / waiting↔running |
| `scheduledTask.runSettled` | `Run` | Drives the unread inbox badge |

**`updated` carrying `next_run_at` is the key design choice.** The client
never computes a next-run time. It receives an integer and formats it. One
shared 1-second ticker re-renders all countdowns; `AGENTS.md` § Concurrency
forbids per-row timers, and this satisfies that without cleverness.

## 3. SDK regeneration is a mandatory step, not a follow-up

`AGENTS.md` is explicit that the generated SDK is not hand-edited and must
be regenerated after API changes. T6 is **not done** until the generated
client types exist and typecheck. A UI task that begins by hand-writing
fetch calls against a not-yet-generated API is the failure mode to avoid —
hence the hard T6 → T8 dependency.

## 4. The Scheduled inbox

Codex's Scheduled view \"acts as your inbox\" and shows an unread indicator
on runs you haven't reviewed. That is the right mental model and it is
worth stating why: **a scheduling feature without a review surface is a
feature that silently burns tokens.** The output of unattended work has
to land somewhere a human actually looks.

Two views, one data source:

```
┌─ Scheduled ─────────────────────────────────────────┐
│  TASKS                                                   │
│  ● Nightly dep audit     daily 02:00    in 7h 12m   │
│  ● PR triage              weekdays 09:00 in 21h      │
│  ○ Weekly refactor        paused         —         │
│                                                    │
│  RUNS  (2 unread)                               │
│  • 02:00  Nightly dep audit    ✓  4m 12s        │
│  • 09:00  PR triage             ⏸ waiting        │
│    21:00  Nightly dep audit    ✗ quota          │
└─────────────────────────────────────────────────────┘
```

The `⏸ waiting` row is why `PermissionMode.pause` exists (03 § 5.1). It is
the single most important state in the inbox: work that stopped because it
needed a decision only a human can make.

### 4.1 Run Sessions are the canonical inspection surface

Every run that reaches execution materializes one producer-owned **root Session**. The executor binds that Session to the durable run with `attachRunSession` before model work begins; the binding transaction publishes `scheduledTask.runUpdated`, so the client learns `run.sessionID` while the worker is still active. The same Session ID remains on terminal run history.

The Scheduled inbox therefore exposes **Open session** for a run as soon as both `sessionID` and `directory` are present. Enterability is not implemented by the scheduler and there is no Scheduled-specific transcript viewer:

- Session addressing comes from the App's canonical `legacySessionHref` helper because the Scheduled pane is global and a run may target any directory;
- click/modifier/keyboard behavior comes from the shared `@opencode-ai/session-ui` Session-navigation primitive used by Task and Goal Auditor;
- once entered, ordinary Session hydration/SSE/timeline rendering owns the live transcript;
- Scheduled run Sessions are **root Sessions**, not fake subagents. Sharing enterability does not imply parent-child grouping.
- the run Session is directly promptable like any other user-drivable root chat;
  Scheduled producer metadata does not disable the composer or require a
  Scheduled-specific prompt endpoint;
- the App sends through the ordinary V1 Session prompt transport
  (`/session/:id/prompt_async` for the normal async composer path), while
  aggregate/control mutations remain producer-owned and fenced;
- if the Scheduled worker is already generating, a new human prompt takes focus
  at the next safe provider-cycle boundary through the shared `SessionInput`
  User frontier. Do not reinterpret “steer” as an unconditional interruption of
  an already-started provider stream.

Deleting a task/run catalog entry never deletes these Sessions, so inspection remains durable independently of scheduler retention.

The V2 Chats sidebar learns these Sessions from the **ordinary Session
projection**, never from the Scheduled store. Its canonical project worktree
cache performs a Tier-0 `projectID`-scoped root census so a run created in a
generated/worktree directory still appears under the owning project. If startup
begins from persisted directory-only project state, arrival of the authoritative
project catalog may upgrade that cache scope; correctness does not depend on that
race winning. Every root Session event also carries durable `projectID`, and the
ordinary Session event reducer routes a known foreign-directory root into the
canonical project index directly. Live create/update/delete therefore converge
through normal Session events; `scheduledTask.runSettled` is not a sidebar data
source.

### 4.2 Client store rules

- One store subscribing to the Scheduled Task events. No per-component polling.
- One shared ticker for all countdowns. Not one `setInterval` per row.
- The list query is **not** re-fetched on every event; events patch the
store.
- No client-side cron parsing. Ever. The server sends integers.

These four rules are direct consequences of the `AGENTS.md` concurrency
section — \"Prefer one shared owner for expensive observers, timers...\" —
and they are also just good sense.

## 5. The editor

Fields, in the order they matter:

1. **Name** — free text, unique per project.
2. **Target directory** — *required*, no default from ambient state (03 §
2.3).
3. **Isolation** — `directory` | `worktree`. Default `worktree` for git
repos.
4. **Schedule** — Once / Repeat with server-owned presets, multiple daily/weekly
   times, and an \"advanced cron\" escape hatch. Friendly interval/monthly/nth
   weekday controls require shared recurrence-schema support first; never lower
   them to cron in the browser. Live `preview` remains server-owned.
5. **Timezone** — defaults to the browser zone, **stored explicitly** (02 §
   timezone). Show it always; a hidden timezone is a future bug report.
6. **Conversation** — New / Reuse / Auto / Existing Session continuity. Existing
   uses the compact canonical root-Session picker; Auto rotates after durable
   human input. See 08.
7. **Prompt** — the durable task prompt, with shared Prompt Revisor integration.
   Revisor output may change prompt text only.
8. **Agent / model** — optional execution override using the canonical V2 model
   selector, not raw provider/model text fields.
9. **Run as goal** — optional, expands to objective   criteria   budget.
10. **Permission mode** — default `deny`, visible, with a plain-language
    explanation of each option.
11. **Advanced** — catch-up, overrun, jitter, retry, retention. Collapsed,
    but **present and explicit** (02 § \"no hidden defaults\").

The first-class `/scheduled` workspace and detailed New York/shadcn-zinc
calendar/editor architecture are specified in
`08-scheduler-workspace-session-continuity.md`.

### 5.1 Conversational creation and management are one agent tool, not a second scheduler

ChatGPT's tasks are created conversationally, and its docs show the
assistant inferring schedules from phrases like \"every weekday at 9\". It is
tempting to copy.

The first-party `scheduled_task` agent tool is the conversational lifecycle
surface. Omitting `action` remains backward-compatible creation; explicit
actions also cover list/get/update/remove/enable-disable, run history/inbox,
unread count/acknowledgement, run-now, preview, and agenda. It does **not** add a
natural-language scheduler or a second persistence path:

- the model translates the current human request into the existing structured
  `Schedule`, `Action`, and `Policy` schemas;
- `ScheduledTaskAgent` resolves ownership from the durable parent Session and
  delegates to the same Tier-0 `ScheduledTask.Service.create` writer used by
  HTTP/UI creation;
- the target directory is the Session's explicit durable location, never
  `process.cwd()`;
- `once` is an absolute instant and needs no zone; daily/weekly/cron wall-clock
  schedules require an explicit IANA timezone. The model may use authoritative
  user context to supply it, but if the intended zone is ambiguous it must ask
  rather than guess from the server host;
- creation is enabled immediately unless the authorizing human turn explicitly
  asks for a draft/disabled schedule, and the service computes/persists
  `next_run_at` transactionally through the canonical recurrence engine;
- the tool is provider-visible with a stable schema, but durable creation is
  host-authorized only when the **active worker root** is a
  provenance-qualified human Prompt/Command and its text explicitly requests
  scheduling or confirms the immediately preceding scheduling proposal;
- an older human request cannot be reused after a newer
  host/scheduled/subagent worker root becomes active;
- child Sessions cannot create durable schedules on behalf of the parent.
- management reads are confined to tasks whose target remains inside the durable
  parent Session directory tree; a task ID alone never widens that scope;
- durable management mutations require the current human Prompt/Command to
  explicitly request that mutation (or confirm the immediately preceding
  proposal), so an agent cannot opportunistically edit/delete/toggle/run/ack a
  task simply because doing so looks useful;
- update/toggle/remove/run-now/acknowledge use revision fences where applicable;
  checked remove/run-now/acknowledge verify the observed revision inside the
  mutation transaction, and acknowledgement also proves run -> task ownership;
- inbox/unread queries apply the visible task IDs before SQL limit/count rather
  than filtering a global inbox afterward;
- arbitrary Existing-Session binding and the global scheduler pause switch stay
  out of this project-scoped conversational surface. The former belongs to
  Session authority; the latter affects every project/task on the installation.
- the originating human turn is persisted as `source="agent"` plus the opaque
  `source_message_id`; execution later has its own independent
  `scheduled-task.run`/run-ID provenance.
- public HTTP creation cannot forge `source=agent` or `source_message_id`;
  those are trusted-producer fields.
- provider/tool replay is idempotent for the exact same source turn + exact
  schedule specification. A same-name but semantically different request fails
  closed rather than mutating an existing schedule.
- `once` is an absolute instant, so conversational admission normalizes away
  any gratuitous timezone before persistence/idempotency comparison. A replay
  with or without that semantically irrelevant field therefore converges.
- the common successful-create path does not perform an idempotency preflight:
  it uses the canonical IMMEDIATE create transaction directly; only a duplicate
  result pays one indexed recovery lookup.

Natural-language timing therefore remains a **generator** only. Management is a
typed lifecycle over the same durable rows, not a second scheduler. The persisted
source of truth is always the deterministic structured schedule, with an
explicit zone for conversational wall-clock schedules. If the intended
wall-clock timezone is ambiguous to the model, the tool call fails closed and
the agent asks rather than deriving user intent from the host machine.

This mirrors Goal creation's user-intent fence without coupling Scheduled Tasks
to Goal runtime semantics. A scheduled action may optionally create/run a Goal,
but scheduling itself remains a distinct durable aggregate.

## 6. Markdown loop files (optional, phase 2)

OpenChamber supports defining schedules as markdown \"loop files\" with YAML
frontmatter, discovered from a conventional directory, which makes them
committable and reviewable. That is genuinely good design — schedules
become code review artifacts rather than hidden local state.

The subtlety is **reconciliation direction**. A file-sourced task and a
UI-sourced task cannot both be authoritative. Rules:

- `source` column is `api` | `agent` | `loop_file`; `source_path` is set
  for `loop_file`, while `source_message_id` correlates agent creation to its
  authorizing turn.
- **File-sourced tasks are read-only in the UI** except for the enabled
  toggle and manual run. Editing the schedule means editing the file.
- File removed ⇒ task **disabled and tombstoned**, not deleted. Run history
  survives a branch switch. This matters more than it sounds: checking out
  an old branch should not silently destroy your audit trail.
- `revision` is the content hash of the frontmatter, so re-sync is
idempotent
  and a no-op re-read does not perturb `next_run_at`.

**Watcher ownership.** `AGENTS.md` is explicit that filesystem watchers are
expensive observers requiring a single shared owner. The canonical watcher is a
**location-scoped** service whose native subscription is finalized when that
location graph expires. That lifetime is insufficient for file-authoritative
schedules: an inactive project can change on disk while no location graph exists.

Keeping every project location graph alive merely for loop files would materialize
the broader location stack (config/plugins/indexes/snapshots/etc.) and violate the
Tier-0 scheduler boundary. Adding a second process-global watcher would violate the
single-observer rule. Therefore T7 remains deferred until the repository has a
process-global/project-catalog-owned filesystem invalidation primitive that can
prove the same coverage without materializing locations.

## 7. Notifications

There is already one process-global PushV2 subsystem. Scheduled runs reuse it;
they do **not** create a parallel notifier.

- `notify=failure` (default): attempt a push for terminal `failed` or
  `abandoned` logical runs.
- `notify=always`: attempt a push for every terminal logical run
  (`succeeded|failed|skipped|abandoned`).
- `notify=never`: suppress scheduled **outcome** pushes.
- A retryable failed attempt does not notify until the logical run actually
  exhausts/reaches a terminal outcome.
- Scheduled Sessions suppress the generic Session completed/failed push path so
  one run cannot produce both a generic chat notification and a Scheduled
  notification.
- Permission/question pushes remain governed by the explicit
  `permission=pause` interaction policy; they are actionable live attention,
  not run-outcome notifications.

Push delivery is **best-effort attention**, not durable run truth. The Scheduled
inbox/run rows remain authoritative. `RunSettled` is a live accelerator and the
existing Web Push transport intentionally has no durable retry queue for every
transport failure.

Current PushV2 subscriptions are mobile-owned. For a run with a Session, the
notification uses the existing `/session/:id` deep-link contract; the mobile
service worker canonicalizes that to `/?session=...` for warm and cold opens.
A terminal run that never reached Session creation navigates to `/`, the
universally valid mobile fallback. The payload still carries
`kind=scheduled-task-run`, `taskID`, and `runID` so a future desktop/browser
push consumer can route the same semantic event to the richer Scheduled inbox.

## 8. Negative UX requirements

- The Scheduled pane must render **with zero Instance loads**. T9 proves
it
  with a probe — the httpapi `AGENTS.md` asks for exactly this kind of
  regression (\"add a regression that records/probes instance loads and proves
  the count remains zero\").
- No component may own a `setInterval` per task row.
- No endpoint may accept a missing directory and infer one.
- Deleting a task must **not** delete its sessions.
- Scheduled Tasks must not implement a second Session viewer, router, or modifier-click contract. Run inspection delegates to the shared Session navigation/timeline architecture.

## 9. Cross-surface consistency

The supported product clients are the desktop/web GUI and mobile PWA. Inbox read
state (`acknowledged_at`) is stored **server-side precisely so it converges**
across those clients and across processes. A `localStorage` unread flag would
diverge the moment a second client opens.

`packages/tui` is retained upstream coupling, **not an OpenFork product
surface** (see `docs/map/surfaces.md` and `FORK.md`). Scheduled-task product
work therefore does not add or maintain a TUI surface merely for parity.

## 10. Open UX questions for T0

1. Does the Scheduled pane live globally or per-project? The data model
   supports both (nullable `project_id`); the **navigation** does not
make
   the choice for free.
2. Do scheduled-run sessions appear in the normal session list, or only
in
   the Scheduled inbox? Mixing them in can drown interactive work under
   machine-generated sessions. Recommendation: tag them and filter them
out
   of the default list, with a toggle.
3. Is there a global \"pause all schedules\" kill switch? Strong
   recommendation **yes** — it is the first thing a user wants when
   something goes wrong at 3am, and implementing it later means
   retrofitting a check into every path.
