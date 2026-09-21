# T10 — First-class Scheduler workspace + Session continuity

**Depends on:** T3, T5, T6, T8, D15–D18  
**Blocks:** D19–D32 closeout  
**Read first:** `08-scheduler-workspace-session-continuity.md`, then 01/03/04/05, root/package `AGENTS.md`, and `docs/map/{architecture,surfaces,v1-v2}.md`

## Goal

Advance Scheduled Tasks from the existing catalog/inbox surface to a premium
first-class `/scheduled` workspace while preserving bottom-up ownership:

- custom 24h / 7d / 30d calendar;
- dense task rail and compact activity;
- comprehensive schedule editor;
- canonical model selection;
- Prompt Revisor integration;
- New / Reuse / Auto / Existing Session continuity.

This is **not** a presentation-only task. Session continuity changes producer
identity, run admission, PushV2 suppression, and durable operational state.

## Work order

### T10.1 — Schema contract

1. Add `ScheduledTask.SessionPolicy`:
   `new | reuse | auto | existing(sessionID)`.
2. Persist it on the task specification with `new` as migration/default
   compatibility.
3. Keep `Action.model` as the execution-model override.
4. Extend recurrence structurally before exposing friendly monthly/interval
   controls. Do not compile them to cron in the browser.
5. Preserve multi-time daily/weekly arrays exactly.

**Done when:** schemas round-trip, old rows decode to `new`, and no client
heuristic is required.

### T10.2 — Core Session binding owner

1. Add `scheduled_task_session_binding` as operational state separate from task
   specification and lease.
2. Implement read/install/clear/rotate methods with task-revision + generation
   CAS fencing.
3. Use `SessionInput.latestUserSeq` as Auto's human-interaction frontier.
4. Binding Session IDs are scalar external references, not Session foreign keys.
5. Task deletion removes binding only; Session survives.

**Do not:** scan messages/parts/transcripts or bump task revision on every run.

### T10.3 — Run admission / producer identity

1. Stop writing new `scheduledTaskRunID` aggregate metadata.
2. Task-owned Sessions may carry protected `scheduledTaskID`.
3. Existing/pinned Sessions receive no Scheduled aggregate metadata.
4. Authorize `scheduled-task.run` host admission from durable
   runID/taskID/sessionID/attempt correlation.
5. Extend the shared synthetic/host admission path with
   `expectedLatestUserSeq` for Auto's final TOCTOU fence.

**Done when:** generic host callers still cannot impersonate ScheduledTask and a
human race forces Auto rotation rather than stale admission.

### T10.4 — PushV2 ownership

Make generic Session done/failed suppression worker-root/run aware.

**Do not:** suppress all future outcomes merely because a reused Session is
task-owned.

### T10.5 — Executor continuity adapter

Implement exact policies:

- `new`: fresh task-owned root every run;
- `reuse`: durable task-owned anchor, replace only if missing/reset;
- `auto`: reuse while User frontier equals binding fence; rotate after User
  interaction;
- `existing`: revalidate exact pinned root, fail config if missing.

Every run still attaches to one Session before Goal/model work.

### T10.6 — Tier-0 projections and SDK

1. Bounded calendar agenda endpoint: one request per visible calendar window,
   <=32 days and bounded count.
2. Compact binding projection/event for current anchor/generation.
3. Existing Session picker reuses compact root Session census.
4. Regenerate the unified SDK through the canonical build once the concurrently
   dirty generator frontier is safe to reconcile.

**Do not:** ship hand-written fetches or leave generated SDK edits as the final
state.

### T10.7 — Prompt Revisor

1. Reuse the existing Prompt Revisor runtime/special-agent.
2. Add `scheduled_task` revision purpose or equivalent narrow semantic purpose.
3. Prompt text is the only mutable artifact.
4. Schedule/model/Session/target/safety policy is read-only context.
5. Default `includeSessionContext=false`.
6. Use canonical question clarification, stale-draft fence, abort, and Restore
   original behavior.

### T10.8 — Premium editor

Replace raw model fields with `ModelSelectorPopoverV2`.

Upgrade schedule editing to preserve multiple times and expose:

- Once;
- Daily + multiple times;
- Weekly + weekdays + multiple times;
- advanced cron;
- later structured interval/monthly/nth-weekday options only after Core supports
  them.

Add Conversation section with the four Session policies, compact Existing
Session picker, current anchor, and **Start fresh next run**.

### T10.9 — Premium `/scheduled` workspace

Custom UI only; no external calendar embed.

Desktop:
- dense toolbar with range navigation, Today, 24h/7d/30d, pause, New task;
- calendar main area;
- persistent task rail;
- compact/collapsible attention-first activity area.

Narrow:
- Calendar / Tasks / Activity presentation tabs over the same store.

Calendar consumes agenda occurrences, not run rows or per-task previews.

### T10.10 — Verification / performance

All D19–D32 must pass.

Add explicit budgets before closeout:

- one agenda request for one visible window;
- 0 Instance loads for page open, list, agenda, binding, Session picker;
- no provider-catalog request until model editor/picker opens;
- no message-history request until user actually enters a Session;
- bounded event rendering for 30d mode;
- no per-row timer/observer.

Record actual measurements in the closeout.

## Non-goals

- No Google Calendar embed or calendar dependency masquerading as product design.
- No Scheduled-specific transcript viewer.
- No Scheduled-specific model picker.
- No Scheduled-specific prompt-revision backend.
- No client-side cron/RRULE recurrence engine.
- No transcript heuristic for Auto.
- No implicit fallback from missing pinned Session to a new Session.
- No T7 loop-file work folded into this tranche.

