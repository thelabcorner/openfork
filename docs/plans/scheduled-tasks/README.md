# Scheduled Tasks — Planning Index

**Status:** IMPLEMENTED — T0–T9 spine + V2/new-layout client surface; T7 loop files and manual release QA remain deferred
**Started:** 2026-09-17  
**Contract:** repository-root `AGENTS.md`   `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md`

## What is implemented

A **scheduled task** is a user-owned, durable specification that causes OpenFork to
start agent work at a future time without a human present at the moment of
execution. The reference implementations we studied:

- **OpenChamber** (`openchamber/openchamber`) — per its `scheduled-tasks.mdx` doc,
a task runs a prompt on a `daily` / `weekly` / `once` / `cron` schedule, starts **a
new session** and sends the prompt itself, can run the prompt \"as a goal\", and
exposes a **run now** escape hatch. It also supports **loops**: portable cron-only
markdown files in `.agents/loops/*.md` (project scope, ancestor-walk to the git
worktree root) and `~/.agents/loops/*.md` (user scope), where **the file is
authoritative while it exists**, loops are **off by default**, runtime state (last
run, next run, status) is kept **out** of the markdown, and a temporarily
unparseable file keeps its **last good definition**. Their documented limitation:
\"Tasks only fire while the OpenChamber server is running.\"
- **OpenAI Codex / ChatGPT** — per `learn.chatgpt.com/docs/automations`, scheduled
tasks appear in a **Scheduled view that acts as an inbox** with an **unread
indicator** when a run needs attention. Standalone tasks **start a new chat per
run**; tasks **scheduled inside an existing chat** reuse that chat's context
instead. Advanced schedules are edited as **RFC 5545 RRULE** (their example:
`RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0`). For git repos each task
runs **either in the local project or on a dedicated background worktree**, and
the same task can run across **more than one project**. Runs are **unattended**
and use default sandbox settings with `approval_policy = \"never\"` when org
policy allows it. They explicitly warn that frequent worktree schedules
**accumulate worktrees over time**.

The implementation lives across `packages/core/src/scheduled-task/**`,
`packages/opencode/src/scheduled-task/**`, the root HTTP API, generated SDK, and
`packages/app` Scheduled surface. A provider-visible `scheduled_task` tool
adds conversational **creation plus scoped lifecycle management** through the
same Tier-0 owners (inspection, mutation, run history/inbox, acknowledgement,
run-now, preview/agenda); it is not a second scheduler or lifecycle-management
backend. Global pause and arbitrary Existing-Session binding remain outside this
project-scoped model surface. The current automated closeout is recorded in
`docs/handoff/CLOSEOUT-scheduled-tasks-2026-09-17.md`; this dossier remains the
architectural source of truth and is updated when implementation falsifies an
earlier planning assumption.

OpenFork's generation axes are intentionally asymmetric here. Durable scheduling
semantics and process-global projections live in shared Schema/Core; the mature
**V1/fork runtime and local HTTP surface** own actual execution; the
**V2/new-layout app** is the product presentation. The unified SDK's `v2`
namespace is a generator/client detail and does not imply that Scheduled Tasks
belong on the current Protocol/runtime. This follows `docs/map/v1-v2.md`,
`docs/map/surfaces.md`, and the package `AGENTS.md` contracts.

## The one-sentence architectural thesis

A scheduled task is **durable global domain state with a time-ordered due cursor**,
not a timer that lives next to a UI list. Each process-global runner owns at most
one timer: normally the earliest-due wake, or a cheap generation-reconciliation
wake when no cursor exists. SQLite owns truth and cross-process liveness; the
lease/idempotency protocol owns execution safety. Everything else — EventV2,
the sidebar badge, the inbox, the next-run countdown — is an accelerator or
projection of that durable state.

## Why this plan exists in this form

The repository-root `AGENTS.md` requires design **from the authoritative source of
truth outward** and names the exact failure pattern this feature invites:

+  Do not let a scheduler, queue, debounce, viewport gate, hover delay, lazy
+  import, or cache make a wrong producer look acceptable. First ask whether the
+  work should exist at that layer at all.

A scheduler is *literally* the artifact that rule warns about. So this plan spends
its first document on ownership and the due-cursor invariant before any route or
component is named.

## What the repo already has (and why it changes the design)

This is **not** a greenfield feature. OpenFork already ships durable Goal
continuation machinery that established several useful patterns, but later
multi-process analysis proved that its process-owner recovery assumption is not
itself reusable as a scheduler lease.

| Existing asset | Path | Why it matters here |
|---|---|---|
| `GoalAutomationTable` | `packages/core/src/goal/sql.ts` | Durable continuation correlation/cursor precedent. Its current `reservation_owner` is a historical single-owner mechanism and is **not** the target shared-process execution primitive. |
| `GoalAutomation` service | `packages/core/src/goal/automation.ts` | Useful precedents: revalidate-before-spend, correlation IDs, stale-result rejection, and durable continuation state. Its startup rule that treats every foreign owner as a dead predecessor is being retired under the shared Session-execution architecture. |
| Revalidate-before-claim | `automation.ts` `claim` | Re-reads policy/lifecycle/focus **immediately before** spending provider work, because the world may have changed since the reservation was written. A scheduler must do the same. |
| Compare-and-set claim | `automation.ts` `claim` | The general CAS pattern is reusable; the Goal-specific owner field/recovery policy is not. ScheduledTask correctly owns its own lease row, heartbeat, attempt, and stale-recovery semantics. |
| Goal domain | `packages/core/src/goal/**`, `packages/schema/src/goal.ts` | OpenChamber's \"Run as goal\" checkbox has a **native equivalent already built here** (`ContinuationPolicy`, `AutomationMode` = `manual` / `auto_continue` / `unattended`, `prepareForSession`). |
| Optimistic concurrency | `GoalTable.revision`   `StaleRevisionError` | Established repo pattern for \"user edited the spec while something else was acting on it\". |
| Migration convention | `packages/core/src/database/migration/*.ts`   `migration.gen.ts` | Timestamped file exporting `{ id, up(tx) }`, registered in the generated barrel. |
| Event convention | `packages/schema/src/goal.ts` (bottom) | Live non-durable protocol events next to durable tables, registered via `event-manifest.ts`. |
| Host-origin prompting | `SessionPrompt.hostPrompt` + shared `SessionTurnProvenance` policy | Scheduled execution stamps `owner=host`, `source=scheduled-task.run`, and `ref=runID` at the producer. It is a Synthetic worker root, not Goal authorization or privileged System merely because the host injected it; provider lowering may still encode it as role `user`. |
| Pause gate | `runLoop` / `promptInternal` | A paused session must not start provider work. Scheduled wakeups must respect the same gate. |
| PushV2 | `packages/core/src/push.ts` | One process-global notification owner. Scheduled Sessions suppress generic outcome pushes; durable run/task/lease truth decides `failure|always|never` after `RunSettled`. Push is best-effort attention; the Scheduled inbox is truth. |

**Consequence:** ScheduledTask reuses proven *techniques* from Goal (CAS,
revalidation, durable correlation), not Goal's process-owner policy. The
ScheduledTask lease remains a distinct domain lease because a schedule is
\"**no session exists yet** and one should be created at time T\", with its own
retry/expiry semantics. The newer shared `RuntimeOwner` architecture may
eventually supply one process-incarnation identity to both domains without
merging their lease rules. See the Swarm concurrency handoff protocol for that
cross-domain identity boundary.

## Hard problems this plan must answer

These are the questions that separate a real scheduler from a `setInterval` that
demos well:

1. **Exactly-once under concurrency.** Two server processes, or a desktop app plus
   a headless `opencode serve`, sharing one SQLite file. What stops two runs?
2. **Missed runs.** The machine was asleep from 02:00 to 10:00 and a `0 3 * * *`
   task was due. Catch up once, catch up N times, or skip? The answer is **not
   the same for every task** and it must be policy, not accident.
3. **Clock hazards.** DST transitions (a 02:30 daily task on the spring-forward
   day simply does not exist; on fall-back it happens twice), IANA timezone 
   database updates, manual clock changes, and suspend/resume jumps.
4. **Overrun.** The 09:00 run is still working at 10:00 when the next one is due.
5. **Unattended execution safety.** No human is present to answer a permission
   prompt. What happens when the agent asks for one? Codex's answer is
   `approval_policy = \"never\"` subject to admin policy; ours must be explicit too.
6. **Resource accretion.** Codex warns that frequent worktree runs accumulate
   worktrees. Sessions, worktrees, and run rows all grow without bound by
default.
7. **Instance cost.** Firing a task requires a **Tier 3 execution runtime** for one
   directory. Listing tasks in a sidebar must remain **Tier 0**. Conflating those
   two is the exact instance-bootstrap incident `AGENTS.md` postmortems.
8. **Timer fanout.** N tasks must not mean N timers, and a sidebar showing \"next
   run in 4m 12s\" for 20 tasks must not mean 20 per-row intervals.

## Documents

| # | Document | Purpose |
|---|---|---|
| 01 | [`01-architecture.md`](./01-architecture.md) | Authoritative bottom-up architecture: ownership tiers, data model, due-cursor invariant, lease protocol, firing path, transport, and the negative invariants. Read this first. |
| 02 | [`02-scheduling-semantics.md`](./02-scheduling-semantics.md) | The time model: recurrence representation, timezone and DST rules, catch-up policy, overrun policy, jitter, and the worked hazard cases. |
| 03 | [`03-execution-and-safety.md`](./03-execution-and-safety.md) | What actually happens on fire: target resolution (local vs worktree), unattended permission policy, goal composition, failure classification, retry, and resource reclamation. |
| 04 | [`04-surface-and-ux.md`](./04-surface-and-ux.md) | API group shape, SDK regeneration obligations, the Scheduled inbox projection, and the loop-file (markdown) source. |
| 05 | [`05-verification.md`](./05-verification.md) | Test strategy that makes **ownership mistakes fail**, not just the happy path pass. Includes the deterministic-clock harness and the concurrency proofs. |
| 06 | [`06-risks-and-open-questions.md`](./06-risks-and-open-questions.md) | Decision log, confidence levels, and the questions that must not be silently answered by implementation accident. |
| 07 | [`07-cross-process-liveness.md`](./07-cross-process-liveness.md) | Normative proof for lost-wake recovery, durable generation, timer ownership, dispatch coalescing, performance bounds, and future wake accelerators. |
| 08 | [`08-scheduler-workspace-session-continuity.md`](./08-scheduler-workspace-session-continuity.md) | Next-tranche architecture for the premium calendar workspace, execution-model picker, Prompt Revisor integration, and New/Reuse/Auto/Existing Session continuity. |

## Taskfiles

Executable work units live in [`tasks/`](./tasks/). They are ordered by dependency,
not by convenience. Each states its **Do**, **Do not**, and **Done when**.

| Task | Title | After |
|---|---|---|
| [T0](./tasks/T0-design-gate.md) | Design gate — resolve blocking decisions before any code | — |
| [T1](./tasks/T1-schema-and-migration.md) | Schema package contracts   SQLite tables   migration | T0 |
| [T2](./tasks/T2-recurrence-engine.md) | Pure recurrence engine and deterministic clock harness | T0 |
| [T3](./tasks/T3-core-service.md) | `ScheduledTask` core service — CRUD, due cursor, lease | T1 T2 |
| [T4](./tasks/T4-runner.md) | Process-global runner — single timer, claim, fire, settle | T3 |
| [T5](./tasks/T5-execution-adapter.md) | Execution adapter — tier-3 boundary, session creation, prompt | T4 |
| [T6](./tasks/T6-http-api.md) | Tier-0 HTTP API + SDK regeneration; execution crosses Tier 3 only in the runner/executor | T3 T5 |
| [T7](./tasks/T7-loop-files.md) | Markdown loop-file source (optional phase 2) | T3 |
| [T8](./tasks/T8-client-surface.md) | Client store   Scheduled inbox UI | T6 |
| [T9](./tasks/T9-verification-closeout.md) | Negative invariants, concurrency proofs, closeout | T4 T6 T8 |
| [T10](./tasks/T10-scheduler-workspace-session-continuity.md) | First-class Scheduler workspace + model/Revisor/Session continuity | T3 T5 T6 T8 D15–D18 |

## Non-goals / deferred scope

- Do not open with a UI dialog or a `setInterval` in a component.
- Do not ship a second autonomy mechanism that duplicates Goal continuation.
- Do not delegate scheduling to `launchd`/`systemd`/`schtasks`. That is a valid
  design (the community `opencode-scheduler` plugin takes that route per its 
  README snippet) but it puts the source of truth **outside the product**, which
  defeats the inbox, the cross-device view, and the audit trail. See
  `06-risks-and-open-questions.md` for the full argument and the case *for* it.
- Do not treat \"the server happened to be running\" as a durability strategy.
- Do not encode catch-up, jitter, overrun, or permission behavior as invisible
  defaults. Every one of them is a named, persisted policy field.
- Do not add Scheduled Tasks to `packages/tui` merely for parity. The current
  map classifies TUI as retained upstream coupling, not an OpenFork product
  surface.
- Do not implement T7 with a second watcher or by keeping every project Location
  graph alive. File-authoritative loops remain deferred until a process-global
  filesystem invalidation owner exists.
