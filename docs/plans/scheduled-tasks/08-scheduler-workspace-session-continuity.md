# Scheduled Tasks — Scheduler Workspace, Model/Prompt Revision, and Session Continuity

**Status:** approved architecture direction for the next Scheduled Tasks tranche; implementation is incomplete until the verification gates below pass  
**Read after:** `01-architecture.md`, `03-execution-and-safety.md`, `04-surface-and-ux.md`, repository/package `AGENTS.md`, and `docs/map/{architecture,surfaces,v1-v2}.md`  
**Owns:** the first-class `/scheduled` workspace, calendar projection, execution-model UX, task-prompt revision, and reusable Session semantics

## 1. Product thesis

The `/scheduled` route is a first-class OpenFork workspace, analogous in product
weight to Settings and Usage. It is not a popover, not a sidebar-owned list, and
not a copy of Google Calendar.

The UI is a custom New York / shadcn-zinc scheduling surface with:

- a dense 24h / 7d / 30d calendar;
- scheduled tasks rendered as calendar events;
- a persistent task list / rail;
- compact recent-run attention/history;
- a comprehensive task editor;
- canonical model selection;
- Prompt Revisor-backed task-prompt revision;
- explicit Session continuity policy.

Presentation remains V2/new-layout. Durable state and recurrence remain
Schema/Core-owned. Actual model execution remains on the mature V1 runtime.

## 2. Bottom-up supply path

The new UI does **not** change the ownership direction:

```text
scheduled_task spec row
  + scheduled_task_session_binding operational row
  + scheduled_task_run audit rows
  + Session / SessionInput durable state
        |
        v
ScheduledTask.Service + Session continuity coordinator       Tier 0
        |
        +--> bounded agenda recurrence projection            Tier 0
        +--> compact task/binding projection                 Tier 0
        |
        v
Root HTTP API / generated SDK
        |
        v
one ScheduledTasks client store + one calendar-window request
        |
        v
/scheduled presentation
```

The execution path remains:

```text
due/claimed run
  -> choose/rotate Session from durable continuity policy
  -> attach run -> Session
  -> Tier 3 Instance materialization for the explicit target
  -> admit scheduled-task.run host turn
  -> normal Session execution
```

No Session transcript scan is permitted to decide continuity, draw the calendar,
resolve the task list, or classify whether the user has interacted.

## 3. Durable Session continuity policy

Session continuity is **user-owned specification state** and belongs on the task
row/schema, not in component state and not in the run row.

Recommended browser-safe contract:

```ts
export const SessionPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({ kind: Schema.Literal("reuse") }),
  Schema.Struct({ kind: Schema.Literal("auto") }),
  Schema.Struct({
    kind: Schema.Literal("existing"),
    sessionID: SessionID,
  }),
])
```

Existing tasks migrate/default to `{ kind: "new" }`, preserving historical
one-fresh-Session-per-run behavior.

### 3.1 `new` — new Session every run

- Every logical run creates a fresh root Session.
- Run history points at that run's Session.
- Human interaction never affects the next run's Session choice.
- This is the compatibility/default mode and maximizes per-run isolation.

### 3.2 `reuse` — one task-owned Session

- The task owns one current anchor Session.
- Every run reuses it until the Session disappears or the user explicitly resets
  the task thread.
- Human messages do **not** rotate it.
- Human input retains priority through the shared `SessionInput` ordering; the
  scheduler is never allowed to become a privileged/System lane merely because
  it is automatic.

### 3.3 `auto` — reuse until the human enters the conversation

`auto` is the recommended premium choice for users who want continuity without
the scheduler repeatedly writing into a conversation they have started using.

Semantics:

1. The task starts with one task-owned anchor Session.
2. Runs reuse that Session while no new semantic User input has appeared.
3. If the user messages that Session, the **next** scheduled run creates a fresh
   task-owned Session and atomically replaces the task's current binding.
4. The old Session is never deleted or rewritten; it remains the user's durable
   conversation/history.
5. Human input arriving during a scheduled provider cycle wins the next safe
   provider cycle through the existing `SessionInput` User frontier. It does not
   blindly terminate an already-started provider stream.

UI copy should explain this directly:

> **Auto** keeps one clean task thread. If you chat in it, the next scheduled run
> starts a fresh task thread and leaves your conversation untouched.

### 3.4 `existing` — explicitly pin a user-selected Session

- The task stores the exact selected `sessionID` in its specification.
- The selected Session stays user-owned. **Do not stamp Scheduled producer
  ownership onto an existing ordinary Session.**
- Scheduled runs are guest host turns correlated by the durable run binding.
- User interaction never rotates the Session.
- If the pinned Session is deleted/missing, the run fails `config`; it must not
  silently create a replacement because that would violate the explicit user
  choice.
- The Session picker may show only user-drivable root Sessions. Exclude child
  workers, special-agent transcripts, delegated workers, and Sessions owned by
  another Scheduled Task. The task's own current task-owned Session may be shown
  while editing.
### 3.5 Session continuity constrains execution location

A reusable Session has a durable directory. Session continuity therefore cannot be
combined with an execution target that changes directories between runs.

Rules:

- `reuse` / `auto` are valid with `target.kind=directory`;
- `reuse` / `auto` are valid with a scheduler-managed worktree only when that
  worktree itself is stable/reused;
- a worktree-per-run target is incompatible with `reuse` / `auto` because the
  next run would execute in a different directory than the bound Session;
- `existing` derives and locks the effective target directory from the selected
  Session. The task persists that explicit directory for Tier-0 ownership checks,
  but the editor disables independent isolation/worktree controls;
- at fire time, the pinned Session's durable project/directory must still equal
  the task's explicit project/target. Mismatch is `failed/config`, never a cwd or
  newly-created-Session fallback.

For a stable scheduler worktree, **conversation continuity does not imply
filesystem continuity**. Existing worktree reset/base-ref semantics remain in
force. The editor should state that a Reuse/Auto conversation can remember prior
runs even when the isolated worktree is reset between runs.


## 4. Runner-owned Session binding state

`reuse` and `auto` require operational state, but that state must not mutate the
user specification or bump its optimistic-concurrency revision on every run.

Add a separate operational table, analogous to the existing spec-vs-lease split:

```text
scheduled_task_session_binding {
  task_id            PRIMARY KEY -> scheduled_task.id ON DELETE CASCADE
  session_id         TEXT NOT NULL          // scalar external reference
  task_revision      INTEGER NOT NULL       // spec revision that installed it
  user_seq_fence     INTEGER NULL           // semantic User frontier at bind
  generation         INTEGER NOT NULL       // monotonic binding generation
  time_updated       INTEGER NOT NULL
}
```

Rules:

- `session_id` is intentionally not a Session foreign key. Session pruning must
  not delete the task.
- The Session itself survives task deletion; the binding row does not.
- `task_revision` prevents an old in-flight run from installing an anchor after a
  user has changed target/session policy.
- Editing prompt/model/schedule does not inherently rotate the binding.
- Editing target/isolation/session policy invalidates the current task-owned
  binding transactionally.
- A user-visible **Start fresh next run** action clears/rotates the binding
  through a Tier-0 domain method; it does not delete the Session.

The task list projection may expose compact current `sessionID`/binding-generation
scalars, but the binding table remains the writer-owned source of truth.

## 5. `auto` uses the durable User frontier, never transcript heuristics

The repository already owns the exact scalar needed:

`SessionInput.latestUserSeq(sessionID)`.

Do **not**:

- fetch messages and search for `role=user`;
- scan parts/text;
- infer from Session `time_updated`;
- use whether the user currently has the Session open;
- use a client-local "touched" flag.

For `auto`, the binding row stores the `user_seq_fence` observed when the
anchor was installed.

Before reusing the anchor:

```text
latestUserSeq(sessionID) == binding.user_seq_fence
```

must still hold.

The final scheduled host admission also needs an optimistic User-focus fence in
the same durable Session-input admission transaction. If a human turn lands after
the pre-read but before admission, the fence fails; `auto` creates a replacement
Session and retries once against the fresh binding. This closes the TOCTOU race.

The implementation should extend the shared host/Synthetic admission seam with an
`expectedLatestUserSeq` fence rather than invent a Scheduled-only message queue.

## 6. Per-run identity moves out of immutable Session ownership

The current implementation stamps both `scheduledTaskID` and
`scheduledTaskRunID` into Session metadata. That only works while one Session
equals one run.

Reusable Sessions require a stricter separation:

- `scheduledTaskID` may classify a **task-owned** Session (`new`, `reuse`,
  `auto` Session creation);
- `scheduledTaskRunID` becomes legacy compatibility data and is no longer written
  for new Sessions;
- `scheduled_task_run.session_id` remains the durable run -> Session pointer;
- each scheduled model-facing turn carries
  `owner=host / source=scheduled-task.run / ref=runID`;
- `existing` pinned Sessions receive no Scheduled aggregate-ownership metadata.

Trusted scheduler admission must therefore be authorized from durable run
correlation, not from one immutable run id stored on the Session:

```text
run.id == provenance.ref
run.task_id == task.id
run.session_id == target Session
run.attempt == current attempt fence
```

Only after that durable check may a `scheduled-task.run` host turn be admitted.
Generic `hostPrompt` cannot impersonate the scheduler.

This is more truthful and more general than the current
`session.metadata.scheduledTaskRunID === provenance.ref` rule.

## 7. Notification ownership becomes turn/run-aware

The old one-run-per-Session world could suppress generic Session completion
notifications merely because the aggregate carried Scheduled metadata.

That is no longer sufficient:

- a reusable task-owned Session may later contain a genuine human turn;
- an `existing` pinned Session remains an ordinary user-owned Session.

Therefore generic done/failed push suppression must correlate the **executing
worker root/run**, not treat every future completion in a task-owned Session as
Scheduled forever.

The authoritative evidence is the scheduled run binding plus the worker-root
turn provenance. Do not add history scans to PushV2. The Session execution
producer should expose/project enough current worker-root correlation for PushV2
to suppress only the Scheduled-owned outcome.

Scheduled outcome notification continues to come from durable run/task/lease
truth.

## 8. Execution model semantics

`ScheduledTask.Action.model` already belongs at the correct durable owner. The new
UI replaces raw provider/model text inputs with the canonical
`ModelSelectorPopoverV2`.

Semantics:

- **Explicit model selected:** every scheduled turn passes that exact
  provider/model/account/variant override. A reused Session may change its
  displayed current model accordingly through the existing Session model-update
  path.
- **No explicit model:** inherit normal runtime behavior:
  - `new`: agent model, then target-workspace/provider default;
  - `reuse`/`auto`/`existing`: agent model, then the Session's current model,
    then provider default.
- An explicit model that is unavailable at fire time is `failed/config`. Never
  silently substitute another model.
- The task list/calendar reads the persisted model reference only. It must not
  load the provider catalog merely to render rows.
- Tier-2 provider/model catalog work is paid only while the editor/model picker
  is explicitly open.

The model picker should support the same variant/account semantics as the normal
Prompt Input V2 selector. Do not build a scheduler-specific provider picker.
### 8.1 Run as Goal under reusable Sessions

Goal focus is Session-scoped: `goal_focus.session_id` is the primary key. A
Scheduled run must therefore never call `prepareForSession` repeatedly and let it
accidentally reuse stale Goal state, nor may it replace an unrelated human Goal.

Normative behavior:

- each logical Scheduled run with `action.goal` owns a **fresh Goal**;
- persist the resulting `goalID` as scalar run correlation (for example on
  `scheduled_task_run`) so run history can prove which Goal belonged to which
  firing;
- `new` naturally prepares the fresh Goal in the fresh Session;
- before `reuse` / `auto` / `existing` focuses the new run Goal, inspect the
  Session's current focus;
- no focus is safe;
- a terminal focus proven to belong to a previous run of the **same Scheduled
  Task** may be unfocused/replaced through the canonical Goal service;
- an unrelated or still-active Goal is never stolen. The Scheduled run fails
  `config` (or parks only if a future explicit interaction policy says so);
- the scheduler does not invent a second Goal state machine. It composes
  `Goal.create/prepare/focus/unfocus` with durable run correlation.

This keeps recurring Goal executions independently auditable while preserving the
one-focused-Goal-per-Session invariant.


## 9. Scheduled Task Prompt Revisor

Task prompt revision reuses the existing Prompt Revisor engine; it does not add a
second LLM revision backend.

Extend the revision purpose contract with `scheduled_task` (or an equivalent
first-class semantic purpose) while continuing to use the existing
`prompt_revisor` special-agent runtime.

The Revisor receives:

- the current task prompt as the only editable artifact;
- schedule summary, target, Session mode, and selected execution model as
  read-only context;
- the explicit target directory as location so its bounded read-only tools can
  inspect the workspace;
- `includeSessionContext=false` by default so the durable automation prompt stays
  self-contained rather than accidentally depending on transient conversation
  history;
- optional one-shot user guidance ("make this focus on security regressions").

The Revisor **must not** mutate schedule/model/session/safety policy. Its terminal
artifact is revised prompt text only.

Model selection for revision remains independent:

1. configured Prompt Revisor model;
2. explicit task execution model as fallback when available;
3. normal runtime default.

Clarification uses the canonical Session Question surface. Do not create a
Scheduler-specific clarification state machine.

Premium interaction:

- `Revise` / pencil-sparkles action inside the Prompt section;
- busy state owns the draft and blocks duplicate revision;
- if the user edits while revision is in flight, stale output does not apply;
- applying a revision keeps an immediate **Restore original** action, matching
  Prompt Input V2;
- editor close aborts the revision operation.

## 10. First-class `/scheduled` workspace

The route already exists. The redesign should follow the visual architecture of
Settings/Usage: one elevated V2 surface inside the application shell.

### 10.1 Desktop layout

```text
┌ Scheduled ─────────────────────────────────────────────────────────────┐
│ ‹  Sep 19–25  ›     Today       [24h] [7d] [30d]   Pause   + New task │
├──────────────────────────────────────────────────────┬─────────────────┤
│                                                      │ Tasks       12 │
│              CUSTOM CALENDAR                         │                 │
│                                                      │ ● Nightly audit│
│   24h timeline / 7d week / 30d month                 │   daily 02:00   │
│   events are compact task occurrences                │   Auto · Sonnet│
│   current-time indicator                             │                 │
│   no external calendar embed                         │ ○ PR triage     │
│                                                      │   paused        │
│                                                      │                 │
│                                                      │ Search / filter │
├──────────────────────────────────────────────────────┴─────────────────┤
│ Activity / runs (compact, attention-first, collapsible)                │
└────────────────────────────────────────────────────────────────────────┘
```

The task rail is useful **with** the calendar, not an alternative CRUD page. On
narrow screens it may collapse into Calendar / Tasks / Activity tabs.

### 10.2 Calendar views

All three views consume one bounded Tier-0 agenda projection for the visible
window. No per-task `preview()` fanout.

- **24h:** vertical minute/time grid, current-time line, occurrences positioned
  by effective fire time.
- **7d:** seven day columns sharing the same time axis.
- **30d:** dense month-style 7-column grid with compact event chips and `+N`
  overflow affordances.

Calendar events are projections, not run rows. A future occurrence contains only
compact task identity + scheduled/effective instant. Task styling/label comes
from the already-loaded task catalog.

Deterministic jitter is reflected by `effectiveAt`; hover/detail may show the
logical `scheduledAt` separately.

The agenda endpoint is bounded by window (<=32 days) and count and remains
Tier 0 / Instance-free.

### 10.3 Task rail

Each dense row shows:

- enabled state;
- task name;
- human schedule summary;
- next run;
- execution model badge (or Auto);
- Session mode badge (`New`, `Reuse`, `Auto`, `Pinned`);
- last status / attention state.

Clicking a row selects/highlights its calendar events and opens task detail/edit.
No provider fetch, Session history hydration, or run-history fetch is required to
draw the row.

## 11. Premium task editor

The current 560px stacked form should become a dense, wider V2 dialog/drawer
(roughly 900–1040px desktop) with a main form and compact summary/preview rail.

Recommended section order:

1. **Task**
   - Name
   - Target/project/directory
   - Worktree isolation
2. **Schedule**
   - Once / Repeat segmented control
   - repeat builder
   - explicit timezone
   - server-owned live next-occurrence preview
3. **Conversation**
   - Session policy: New / Reuse / Auto / Existing
   - Existing Session picker when applicable
   - current anchor link / Start fresh next run for Reuse/Auto
4. **Execution**
   - Agent
   - canonical model picker
   - Run as Goal
5. **Prompt**
   - multiline task prompt
   - Prompt Revisor action
6. **Safety / Advanced**
   - permission
   - catch-up
   - overrun
   - jitter
   - retries
   - max duration
   - retention
   - notifications

Dense New York spacing means hairline section separation, 28–32px controls,
compact labels, no nested-card explosion, no gradients.

## 12. Recurrence UX: comprehensive without client-side scheduling logic

The UI must never lower or parse recurrence independently of the server.

The current domain supports once/daily/weekly/5-field cron. The existing editor
also incorrectly edits only `times[0]`; preserving multiple times per day/week is
a required correctness fix.

The immediate editor must support:

- Once;
- Daily with one or many times;
- Weekly with selected weekdays and one or many times;
- Advanced cron.

To reach the requested comprehensive repeat builder, extend the shared Schedule
schema/recurrence engine **before** exposing friendly controls for:

- every N minutes/hours/days/weeks;
- monthly by day-of-month;
- monthly by nth weekday (for example first Monday);
- last day / last weekday patterns;
- optional yearly patterns if product demand warrants them.

Prefer explicit structured schedule variants over compiling UI state to cron in
the browser. An RFC 5545 RRULE import/export escape hatch is reasonable later,
but the repo currently has no RRULE dependency; do not add a client-side RRULE
parser merely to make the editor look complete.

## 13. Existing Session picker

The picker consumes the existing compact root Session projection, not message
history.

Eligibility:

- root Session;
- user-drivable;
- belongs to the explicit project/location scope;
- not a special-agent transcript;
- not a child/subagent;
- not an OXP/delegated worker;
- not task-owned by a different Scheduled Task.

Search/filter is entirely over already-materialized Session metadata. Selecting a
Session stores its durable ID; the executor revalidates that the Session still
exists at fire time.

## 14. Failure and mutation semantics

| Situation | Required behavior |
| --- | --- |
| Reuse/Auto anchor Session deleted | create a replacement on next run |
| Existing pinned Session deleted | fail `config`; do not substitute |
| Existing pinned Session directory/project no longer matches task target | fail `config`; never silently move execution |
| Target/isolation changes | invalidate task-owned binding for next run |
| Reuse/Auto with per-run worktree target | reject validation; reusable Session requires stable directory |
| Prompt/model/schedule changes | keep binding unless user explicitly resets it |
| Explicit model unavailable | fail `config` |
| Human messages Auto anchor | next run rotates |
| Human messages Reuse/Pinned anchor | stay on same Session; human lane has priority |
| Task deleted | Sessions survive; binding row is removed |
| In-flight old task revision tries to install binding | CAS/task-revision fence rejects stale install |
| Auto human-input race during admission | User-seq fence fails; rotate/retry once |
| Reusable/pinned Session has unrelated or active focused Goal when run-as-Goal fires | fail `config`; never steal Goal focus |

## 15. Events and client convergence

Do not re-fetch the task list on every binding change.

Add one compact binding projection event (name TBD, for example
`scheduledTask.sessionBound`) carrying:

```ts
{ taskID, sessionID?, generation }
```

or include equivalent binding scalars in a canonical `scheduledTask.updated`
projection without bumping user spec revision.

The client Scheduled store patches the binding projection by task id. The Chats
sidebar remains sourced exclusively from the ordinary Session projection.

## 16. Negative invariants for implementation

The tranche is not complete unless tests prove:

1. Calendar 24h/7d/30d performs one bounded agenda request per visible window,
   not N task previews.
2. Agenda/list/session-binding reads create **0 Instances**.
3. `auto` rotation uses `SessionInput.latestUserSeq`; no message/part/history scan
   exists in Scheduled code.
4. A human turn racing Auto admission cannot be overwritten by a stale scheduled
   admission.
5. Reuse/Auto binding writes are task-revision/CAS fenced.
6. Pinned existing Sessions remain user-owned; Scheduled metadata is not stamped
   onto them.
7. Trusted Scheduled host admission is authorized by durable run -> Session
   binding, not by a mutable/guessed metadata run id.
8. Generic Session completion push is suppressed only for the Scheduled-owned
   worker turn, not forever for every future human turn in a reused Session.
9. Explicit task model is honored on every run; unavailable explicit models do
   not silently fall back.
10. Prompt revision can change only task prompt text; schedule/model/session
    policy remains byte-for-byte unchanged.
11. Multi-time daily/weekly schedules round-trip through the editor without
    losing any time entries.
12. Existing Session picker performs no history hydration or per-row requests.
13. Reuse/Auto cannot bind across changing execution directories; Existing Session target/project/directory compatibility is revalidated and never falls back.
14. Run-as-Goal creates one auditable Goal per logical run and never replaces an unrelated/active Goal focus in a reused or pinned Session.

## 17. Migration order

Implement bottom-up:

1. Schema contract: `SessionPolicy`; deprecate new `scheduledTaskRunID` metadata
   writes.
2. Core binding table + service/CAS/user-seq semantics.
3. Run/session admission authorization from durable run binding.
4. PushV2 worker-root correlation update.
5. V1 executor adapter for `new/reuse/auto/existing`.
6. Tier-0 compact binding + agenda transport and regenerated unified SDK.
7. Client store projection.
8. Canonical model picker + Session picker.
9. Prompt Revisor purpose/helper.
10. Premium calendar/editor presentation.
11. Negative regression matrix and performance closeout.

Do not start at step 10 and backfill ownership afterward.

