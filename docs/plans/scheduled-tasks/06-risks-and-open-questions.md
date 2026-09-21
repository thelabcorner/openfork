# Risks, Confidence, and Open Questions

## 1. Confidence levels

| Claim | Confidence | Basis |
| --- | --- | --- |
| OpenChamber ships scheduled tasks (cron/daily/weekly, run-as-goal,
markdown loop files) | High | Its README and `scheduled-tasks` docs page |
| Codex/ChatGPT ships scheduled tasks with an inbox-style Scheduled view and
worktree isolation | High | OpenAI help centre and automations docs |
| Before this campaign the repo had no scheduled-task runtime and no cron dependency | High | Initial repo/lockfile survey; now superseded by the implementation described in this dossier |
| `goal/automation.ts` is the right lease precedent | High | Read
directly: reservation id   owner   claim/release |
| The executor can originate a session headlessly | **High** | Confirmed by the headless prompt-loop test plus scheduled executor E2E |
| Two app processes can share one data directory | **High** | Confirmed by WAL/Flock architecture and real two-process scheduled-task tests |
| The existing filesystem watcher can be subscribed to for file-authoritative loop files without keeping locations alive | **High — NO** | Verified: `Watcher.node` is location-scoped and its native subscription ends with that graph; T7 remains deferred |

Rows marked Medium or Low are **not design weaknesses to hide** — they are
the precise places where the plan could be wrong, and each is assigned to
a task that will find out early.

## 2. Top risks

1. **Duplicate unattended runs.** The worst outcome: two agents editing
one
   repository simultaneously at 3am. Mitigated by the lease   the
   `(task_id, fire_for)` unique index — **two independent mechanisms
on
   purpose**. Tested by C1/C3/C7.
2. **Catch-up storm after sleep.** Mitigated by an explicit catch-up
   policy
   with `skip` as the default and a max-age bound. Tested by C8
   manual QA 1.
3. **Unsupervised permission escalation.** Mitigated by `deny` default
and
   the `pause` mode. This is a *policy* mitigation, not a sandbox —
say
so
   plainly rather than implying stronger guarantees than exist.
4. **Silent cost growth.** Scheduled goals can burn tokens indefinitely.
   Mitigated by tighter unattended budgets, the circuit breaker, and
the
   inbox surface.
5. **Architectural rot.** The Tier 0 boundary is only real if it is
   enforced. Mitigated by the D1–D7 negative tests, especially the
static
   import assertion D7.
6. **DST correctness.** Mitigated by fixtures over intuition, and by
   storing the IANA zone rather than an offset.
7. **Lost cross-process wake.** A writer can commit runnable state and die before
   publishing EventV2. Mitigated by the transactionally advanced durable
   generation plus the runner's 60-second generation-only reconciliation floor.
   EventV2 improves latency; it is not a liveness dependency. Tested by C9.

## 3. Explicit non-goals for v1

- No delegation to `launchd` / `systemd` / `schtasks`.
- No second autonomy mechanism parallel to `Goal`.
- No natural-language schedule *storage*. Conversational creation may translate
  a human request into the same concrete structured schedule used by every other
  producer; natural language is never scheduler truth.
- No multi-target fan-out in v1. T0 decision 4 fixed one target per task.
- No silent defaults for catch-up, overrun, jitter, or retry.

## 4. Decision log

| # | Decision | Resolution | Rationale | Date |
| --- | --- | --- | --- | --- |
| 1 | Process ownership hook | `ScheduledTaskRunner.node = makeGlobalNode(...)` in `packages/opencode/src/scheduled-task/runner.ts`, installed in both process-global app graphs. Startup is single-flight: grace → `recoverStale()` → authoritative `wake()`. A started runner owns at most one recurrence/reconciliation timer. | Mirrors `GoalAutomation.node`/`Database.node`; both graphs already own process-global singletons and are built once per process, never per directory (01 § 6). | 2026-09-17 / refined 2026-09-18 |
| 2 | Multi-process shared data dir | **YES — supported topology.** The heartbeat-based lease recovery rule in 01 § 5 Layer 4 is mandatory; identity-only requeue is not legal. | `database.ts` states "Multiple ACP/Desktop hosts can share this exact DB, so elect one checkpoint owner per pass"; WAL + `Flock` election only exist because sharing is real. | 2026-09-17 |
| 3 | Recurrence dependency | `luxon` (already in catalog/store, added to `@opencode-ai/core` deps) for IANA zone arithmetic + a hand-rolled 5-field cron parser with an explicit DST policy adapter. No new cron library. | No cron lib exists in the lockfile; 02 § 3.2 Case D requires our gap policy to *override* library behavior anyway; 6-field seconds, `@reboot`, `L/W/#` are rejected (02 § 2.3). | 2026-09-17 |
| 4 | Fan-out in v1 | One target per task. Idempotency key stays `(task_id, fire_for)`. | 01 § 3.5 extension point noted; retrofitting `(task_id, target_id, fire_for)` is only needed when fan-out actually lands. | 2026-09-17 |
| 5 | Permission default | `deny`. Auto-reject `permission.asked` for the run's session via `Permission.reply({ reply: "reject" })`. `pause` parks the run as `waiting`; `inherit` is a no-op. | No sandbox exists here — permission is an allow/deny/ask policy layer only. Copying Codex's "never ask" without their sandbox would be strictly more dangerous (03 § 5.1). | 2026-09-17 |
| 6 | Unattended goal budgets | Yes, tighter. Scheduled goals default to `{ mode: "unattended", maxConsecutiveTurns: 16, maxNoProgressTurns: 2, maxDurationMs: 30m }`; explicit action policy overrides win. | Interactive defaults (32 turns / 2h) assume a human watching; a 3am goal with that budget is a token bill (03 § 4.1). | 2026-09-17 |
| 7 | Quota-aware retry | v1 uses bounded backoff only; `quota`/`provider` are retryable and excluded from the circuit breaker. | 03 § 6 recommends reset-time retry, but reset metadata is not exposed at this boundary; a blind-but-bounded retry is strictly better than no retry. | 2026-09-17 |
| 8 | Navigation placement | Global Scheduled pane. `scheduled_task.project_id` stays nullable and the list accepts an optional `projectID` filter. | The authoritative rows are global (Tier 0); making navigation project-scoped would hide global tasks (04 § 10.1). | 2026-09-17 |
| 9 | Global kill switch | Yes, in v1. Durable singleton `scheduled_task_control` row, consulted by `nextDueAt`/`due` and `runNow`; pausing removes recurrence eligibility while retaining the one cheap generation-reconciliation timer, and in-flight runs complete. | The control state is durable and cross-process; retaining reconciliation avoids making resume correctness depend on an in-memory event. | 2026-09-17 / refined 2026-09-18 |
| 10 | Cross-process wake/liveness | Durable monotonic `scheduled_task_control.generation`, advanced transactionally by SQLite triggers on task mutations, queued-run creation, and pause transitions. EventV2 is the same-process fast path; every process-global runner retains one 60s-clamped timer as a generation-only reconciliation floor when no recurrence cursor exists. | Safety (leases/idempotency) is insufficient without liveness: a writer can commit then die before publishing an in-memory wake. Polling the whole task table would violate the idle-cost invariant; one indexed singleton read bounds recovery to 60s while keeping recurrence parsing, due scans, and Instance materialization at zero when truth is unchanged. | 2026-09-18 |
| 11 | Notification ownership | Reuse process-global PushV2. Scheduled Session metadata suppresses generic Session outcome pushes; `scheduledTask.runSettled` drives policy-aware Scheduled outcome pushes. The durable inbox/run row is authoritative; push delivery is best-effort attention. | Avoids a parallel notifier and prevents duplicate generic + Scheduled pushes. Retry/stale-event decisions are revalidated from durable run/lease truth before delivery. | 2026-09-18 |
| 12 | TUI product scope | No Scheduled Tasks TUI product work. | Current `docs/map/surfaces.md` + `FORK.md` classify `packages/tui` as retained coupling, not an OpenFork product/compatibility surface. | 2026-09-18 |
| 13 | Loop-file watcher feasibility | Deferred until a process-global/project-catalog filesystem invalidation primitive exists. | The canonical watcher is location-scoped; keeping locations alive violates Tier-0 ownership and a second watcher violates shared-observer rules. | 2026-09-18 |
| 14 | Conversational lifecycle | One provider-visible `scheduled_task` tool delegates to process-global `ScheduledTaskAgent`. Omitted `action` preserves creation compatibility; explicit actions expose scoped inspection plus update/remove/toggle, runs/inbox/unread/acknowledge, run-now, preview, and agenda. Creation and durable mutations require the active worker root to be an authorized human Prompt/Command plus operation-specific intent/confirmation. Reads/mutations are confined to the durable parent Session's directory tree; mutating lifecycle calls use revision fences. Global pause and arbitrary Existing-Session binding remain outside the tool. | Reuses the existing scheduler writer/recurrence/runner instead of creating a prompt parser, lifecycle backend, or second scheduler. Separating actor provenance from domain intent prevents host/scheduled turns from borrowing stale consent. Revision fencing prevents stale model mutations; SQL-level inbox scoping prevents project leakage. Global pause is installation-wide authority, while Existing-Session binding crosses into user-owned Session authority, so neither belongs in a project-scoped convenience surface. | 2026-09-19 / expanded 2026-09-20 |

### 4.1 Contradictions resolved and reflected back into 01–04

- **`runNow` ownership corrected after implementation proof.** The earlier
  T6/04 split classified the endpoint by eventual agent execution rather than
  the work performed by the HTTP producer. The handler only validates and
  durably enqueues; it therefore lives in the Tier 0 `scheduledTask` group.
  EventV2 wakes the process-global runner and only `executor.ts` crosses Tier 3.
  The handler has no runner or Instance dependency.
- **Durable wake is separate from durable work.** Manual queued runs intentionally
  do not mutate `next_run_at`. A commit followed by process death could therefore
  strand work if liveness depended only on EventV2/`poke()`. A transactional
  generation trigger plus generation-only idle reconciliation now makes the
  database itself sufficient for eventual discovery.
- **`RunStatus` needs `waiting`.** 03 § 5.1's `pause` mode parks a run as
  `waiting`, but 01 § 3.3's status list omitted it. `waiting` is now part of the
  union; it is an unread inbox status.
- **Catch-up default naming.** 06 § 1 and 05 § 4 referred to a `latest` policy;
  the actual policy literals are `skip | run_once | run_all` and the default is
  `skip` (02 § 4). The stale `latest` references are corrected in place.
- **Creation provenance is not execution provenance.** A conversationally
  created task records the live human source turn once. Later firings use a new
  host-owned `scheduled-task.run` turn correlated by `runID`; they do not
  replay or inherit human/Goal-creation authority.
- **SessionRunState drain registration is service-scoped.** Integration testing
  exposed that the canonical provider-drain callback was being redundantly
  stored in `InstanceState`, making `SessionPrompt` service construction
  require an active `InstanceRef` and breaking Tier-0 HTTP startup. The
  callback is now registered once at SessionRunState service scope; only
  runners/tokens/cancel state remain per-directory.

## 5. Counter-arguments worth taking seriously

A fair review should weigh these against the plan:

- **\"Just shell out to the OS scheduler.\"** There is a community
plugin
  for this approach and it is dramatically less code. The case
against
it
  is ownership — no shared run history, no inbox, no cross-platform
  parity, and the scheduler lives outside the app's data model. But
if
  the goal were \"ship something this week\", that approach would win.
- **\"The lease table is over-engineering.\"** True *if* only one process
  ever runs. T0 decision 2 exists to test that assumption rather than
  assume it in either direction.
- **\"Run history should be per-attempt.\"** The plan collapses retries
into
  one row for inbox clarity. If forensics matter more than clarity,
add
a
  child table — do not relax the unique index.
