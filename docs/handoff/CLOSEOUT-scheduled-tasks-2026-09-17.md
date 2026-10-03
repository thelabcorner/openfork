# Scheduled Tasks feature: implementation and verification closeout

Date: 2026-09-17
Branch: main (branch-fork)

> **Continuation note — 2026-09-18:** this file preserves the 2026-09-17
> verification baseline, but the architecture was subsequently hardened for a
> cross-process lost-wake failure. Sections below marked as baseline retain their
> dated measurements; the 2026-09-18 addendum at the end is the current evidence
> for generation-based liveness, timer ownership, dispatch coalescing, and the
> verification work temporarily blocked by an unrelated session/context
> module-initialization regression.

## Verdict

The scheduled-tasks feature is implemented end-to-end for the non-optional
taskfiles T0–T9, with T7 (markdown loop files) deliberately deferred exactly as
its taskfile allows. Server persistence, the pure recurrence engine, the Tier 0
service, the process-global runner, the Tier 3 executor, the HTTP API + SDK, and
the negative architecture tests are in place and green.

The load-bearing invariants hold and are enforced by tests:

- materialized `next_run_at` recomputed only at mutation/settlement, read as an
  index range scan;
- **one** process-global timer, clamped to 60s; when no recurrence cursor exists it becomes a generation-only cross-process reconciliation timer rather than disappearing;
- database-adjudicated leases plus `UNIQUE(task_id, fire_for)` idempotency,
  proven with two real OS processes against one SQLite file;
- Tier 0 scheduling surface with **no** `InstanceStore` import anywhere except
  `executor.ts` (D7).

The T8 client store/UI is implemented by a parallel workstream (see
`CLOSEOUT` addendum below) and is not part of this ledger's measured tests.

## Workstream safety

This campaign mutated only files belonging to the scheduled-tasks feature. The
worktree is shared and was concurrently modified by an unrelated prompt-revisor
campaign (`packages/core/src/prompt-revisor*.ts`, `packages/opencode/test/session/prompt.test.ts`,
`packages/opencode/test/prompt-revisor/runtime.test.ts`, and others); those
changes were treated as foreign and left untouched.

## Deliverables and files

Core (`packages/core`):

- `src/scheduled-task.ts` (namespace barrel)
- `src/scheduled-task/sql.ts` — `scheduled_task`, `scheduled_task_lease`,
  `scheduled_task_run`, `scheduled_task_control`
- `src/scheduled-task/schema.ts` — tagged errors
- `src/scheduled-task/recurrence.ts` — pure engine (Luxon zone math + hand-rolled
  5-field cron, explicit DST policy, bounded search)
- `src/scheduled-task/policy.ts` — named defaults, catch-up decisions, cap
- `src/scheduled-task/lease.ts` — `ScheduledTaskLease.Service`
- `src/scheduled-task/index.ts` — `ScheduledTask.Service`
- migrations `20260917052635_goofy_black_crow` (tables),
  `20260917060928_silky_cardiac` (global inbox index), and
  `20260918224000_scheduled_task_generation` (durable liveness epoch + reconciled triggers)

Schema (`packages/schema`):

- `src/scheduled-task.ts`, `src/scheduled-task-id.ts`, event-manifest + index
  registration (`scheduledTask.created/updated/removed/runStarted/runSettled/runUpdated/controlChanged`)

OpenCode (`packages/opencode`):

- `src/scheduled-task/runner.ts` — one-timer runner, epoch-fenced timer ownership, generation reconciliation, globally bounded/coalesced dispatch, scoped heartbeats, recovery, kill switch
- `src/scheduled-task/executor.ts` — the only Tier 3 component
- `src/server/routes/instance/httpapi/groups/scheduled-task.ts` and `handlers/scheduled-task.ts` — one Tier-0 ScheduledTask HTTP group, including durable `runNow` enqueue
- `src/session/prompt.ts` — exposed `hostPrompt` on the public interface
  (host-origin prompt; previously module-private)
- runner/executor installed in both process-global graphs (`server.ts` `app`
  group and `effect/app-runtime.ts` `AppLayer`)

Generated SDK: `packages/sdk/js/src/v2/gen/*` regenerated with
`bun run build` (`ScheduledTask` client and `ScheduledTask*` types).

Tests: `packages/core/test/scheduled-task/*`, `packages/opencode/test/scheduled-task/*`,
plus the two-process fixture `fixtures/two-process.ts` and the measurement tool
`bench-scheduler.ts`.

Docs: T0 decision log appended to `docs/plans/scheduled-tasks/06-risks-and-open-questions.md`;
contradictions resolved back into 01/05/06 (runNow group, `waiting` status,
`skip` catch-up default); `.gitkeep` removed.

## T0 decisions — how they actually resolved

1. Process ownership hook: `ScheduledTaskRunner.node` (`makeGlobalNode`) in both
   global graphs; startup is single-flight (grace → recovery → authoritative
   `wake()`), then the runner owns at most one recurrence/reconciliation timer.
2. Multi-process shared data dir: confirmed yes (Database WAL/Flock architecture
   plus real two-process scheduler tests). Lease recovery is heartbeat-TTL based;
   `includeOwn: true` is startup-only, while periodic recovery cannot steal a
   healthy peer's live lease.
3. Recurrence dependency: `luxon` (already catalogued) + hand-rolled 5-field
   cron. No new cron library. Seconds, `@reboot`, `L/W/#` are rejected.
4. Fan-out: one target per task; `(task_id, fire_for)` is the key.
5. Permission default: `deny`, implemented as auto-rejecting
   `permission.asked` for the run's session; `pause` parks the run as `waiting`;
   `inherit` is a no-op.
6. ~~Unattended Goal budgets~~ **Superseded 2026-10-02.** Goal Mode has one
   intrinsic behavior: continue autonomously until independently complete or
   genuinely blocked. ScheduledTask run timeout/retry/permission policy remains scheduler
   state and is not written into the Goal.
7. Quota-aware retry: bounded backoff only; `quota`/`provider` retryable and
   excluded from the circuit breaker.
8. Navigation: global pane; `projectID` filter optional.
9. Kill switch: durable `scheduled_task_control` row + `controlChanged` event; pause removes recurrence eligibility but retains the cheap reconciliation timer.
10. Cross-process liveness (2026-09-18): durable monotonic scheduler generation advanced by SQLite triggers; EventV2 is an accelerator, not a correctness dependency.

## Verification ledger — 2026-09-17 baseline

### Commands and results

| Command (working dir)                                                                                     | Result                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `bun test test/scheduled-task/` (packages/core)                                                           | **41 pass / 0 fail**                              |
| `bun test test/scheduled-task/ --timeout 120000` (packages/opencode)                                      | **27 pass / 0 fail**                              |
| `bun test test/session/prompt.test.ts --timeout 120000 -t "loop calls LLM and returns assistant message"` | **1 pass** (headless session origination)         |
| `bun test test/database-migration.test.ts` (packages/core)                                                | **19 pass / 0 fail**                              |
| `bun run build` (packages/sdk/js)                                                                         | generated SDK contains `/scheduled-task*`; exit 0 |
| scoped `tsgo --noEmit` on all new/changed scheduled-task sources and tests                                | no errors attributable to this feature            |

### Tier A — 02 §8 acceptance fixtures (engine)

E1 09:00 local; E2 spring-forward gap fires at the 03:00 boundary with a
`dst_shifted` warning; E3 fall-back fires exactly once and the exclusive bound
skips the second 01:30; E4 min-over-set two-times daily; E8 `once` fires then
returns null; E9 past `once` rejected at validation; E10 Feb 30 never spins and
is rejected; E11 leap-day cron returns 2028-02-29; E14 zone interpreted per
computation. Plus the "easy to omit" cases: month-end 31st skips February,
DOM/DOW OR-rule, malformed input returns undefined, explicit rejections, bounded
four-year horizon, deterministic jitter, property check
`next(after) > after` strictly.

E5/E6/E7/E12/E13 are covered at the service level (Tier B) with a virtual clock.

### Tier C — 2026-09-17 concurrency/recovery baseline

| ID  | Evidence                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Two **real OS processes** (`bun` children) racing one due task → exactly one claim, one run row (`concurrency.test.ts`)            |
| C2  | A killed runner's lease recovered by a second process with an advanced clock; run becomes `abandoned`; reacquisition `attempt = 2` |
| C3  | Same `(task_id, fire_for)` inserted twice → unique index rejects; also two-process race                                            |
| C4  | Disabled/deleted between claim and fire → `skipSettled` advances, no execution (runner revalidation; E12 service fixture)          |
| C5  | Edit mid-run completes on the old spec and recomputes from the new schedule (E13)                                                  |
| C6  | 100 simultaneously-due tasks → observed peak in-flight dispatch exactly 2                                                          |
| C7  | Backward clock jump / stale cursor cannot duplicate a fired instant; unique index is the backstop                                  |
| C8  | 14-day catch-up with `run_all` collapses to the cap and fires one lease-serialized run at a time (E7)                              |

### Tier D — 2026-09-17 negative-ownership baseline (D3/D4 superseded by 2026-09-18 liveness hardening)

| ID    | Evidence                                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1/D2 | Tier 0 endpoints (`list/get/create/update/enabled/delete/preview/inbox/count/ack/control`) answered over HTTP **without any directory context**; group placement statically asserted on `RootHttpApi`                 |
| D3    | Historical 2026-09-17 behavior: idle runner armed no timer. **Superseded:** current runner keeps one generation-reconciliation timer and performs only a scalar generation read when unchanged.                       |
| D4/N2 | Historical 2026-09-17: 200 future tasks armed exactly **1** timer. **Current invariant:** any task count, including zero, owns at most one runner timer.                                                              |
| D5    | Static scan: no scheduled-task source reads `process.cwd()`; executor stats the target before `store.provide`; missing target skips with **zero** instance loads (unit test with a dying `InstanceStore.provide` spy) |
| D6    | Deleting a task deletes its own run rows only; session ids are scalar                                                                                                                                                 |
| D7    | Static import-graph assertion: only `executor.ts` imports `InstanceStore`; core never references the execution runtime                                                                                                |
| N8    | Sub-minute schedules rejected (no seconds cron), bounding the event rate                                                                                                                                              |
| N9    | Static assertion that the on-time grace fast path returns before any recurrence call                                                                                                                                  |

### Performance — 2026-09-17 baseline (`bench-scheduler.ts`)

| Scenario                           | Budget                       | Measured                                                                                                            |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| List 500 tasks                     | one indexed query, <10ms     | **6.47 ms**, 500 rows                                                                                               |
| Timer re-arm `nextDueAt`           | one `MIN(next_run_at)` query | **1.72 ms**                                                                                                         |
| Inbox newest 50 across 50,000 runs | indexed, <20ms               | **1.19 ms**                                                                                                         |
| Unread count across 50,000 runs    | indexed                      | **0.57 ms**                                                                                                         |
| Idle runner, 0 due tasks           | historical target: 0 queries | **Superseded 2026-09-18:** correctness now requires one scalar generation read / 60s while truly idle; see addendum |

One budget was initially **missed**: the global inbox scan measured 29.36 ms
because the only run index was `(acknowledged_at, started_at)` and the unfiltered
newest-first scan could not use it. Fix: added
`scheduled_task_run_started_idx (started_at, id)` (migration
`20260917060928_silky_cardiac`), which took the same query to 1.19 ms. This is
recorded rather than silently re-baselined.

Test-environment tzdata pin: ICU 73.2 (Bun exposes no `process.versions.tz`);
the exact-epoch fixture assertions are the real pin (see
`support/clock.ts` `tzPin()`).

## Deviations from the plan (explicit)

1. **`runNow` group placement was corrected on 2026-09-18.** The route performs
   only a Tier 0 durable enqueue and now lives on `RootHttpApi`; the
   process-global runner reacts asynchronously and `executor.ts` remains the
   only Tier 3 boundary. The former `scheduledTaskRuntime` group was removed.
2. **Automatic `recomputeAll` on process start was dropped.** Recomputing every
   enabled cursor from `now` before the first scan erases overdue instants and
   defeats catch-up (E5–E7). `recomputeAll` remains as an explicit maintenance
   operation and self-heal test surface; Case C tzdata one-time drift is accepted
   per 02 §3.2.
3. **`RunStatus` includes `waiting`** (03 §5.1) and a `runUpdated` event was
   added for non-terminal projection changes (manual enqueue, permission pause)
   so the inbox converges across clients. Additive to the five events in 01 §7.
4. **Additive columns/objects beyond 01 §3:** `scheduled_task.target` JSON
   (isolation mode/baseRef/reuse required by 03 §2), `scheduled_task_control`
   (T0 decision 9), `scheduled_task_run.attempt`, and the inbox `started_at`
   index. `target_directory` remains `NOT NULL` and authoritative.
5. **Per-run worktrees (`reuse: false`) are rejected in v1** ("per-run worktrees
   are not supported in v1") rather than shipped with an unbounded accretion
   bug. `reuse: true` uses one stable worktree per task, reset with
   `git reset --hard <baseRef> && git clean -fd`.
6. **Lease recovery refinement**: periodic sweeps reclaim by heartbeat TTL only;
   the own-owner clause is startup-only (see T0 decision 2).
7. **Catch-up ceiling semantics**: eligibility is evaluated per instant within
   `catchUpMaxAgeMs`; `run_once`/`run_all` fire from the earliest eligible instant.
8. **Cross-process lost-wake liveness**: the old zero-idle-query invariant was
   intentionally replaced by a durable generation epoch + bounded scalar reconciliation.

## Medium/Low confidence claims from 06

- "The executor can originate a session headlessly" — **confirmed** by the
  existing full prompt-loop test with no interactive client, plus the executor
  unit path (create session → `hostPrompt`) and the newly exposed `hostPrompt`
  interface. No design amendment was needed.
- "Two app processes can share one data directory" — **confirmed** by repository
  evidence (WAL + Flock comments) and directly exercised by the two-process
  fixture.
- "The existing filesystem watcher can be subscribed to for loop files" —
  **not investigated**, because T7 is optional and was deferred.

## Manual QA status (05 §4)

Manual QA 1–5 (lid-close sleep/wake, two desktop instances, crossing a real DST
boundary, permission-pause round trip, and physically tapping a mobile Scheduled
push/deep link) were **not performed** in this environment; there is no
interactive desktop/mobile release session or real clock control. Automated
substitutes exist and are green: virtual-clock catch-up, two real processes, DST
fixtures, permission policy wiring, and the real Database + EventV2 +
ScheduledTask + PushV2 integration suite (with only the external web-push
transport mocked) covering Session deep links and the no-Session root fallback.
These automated proofs materially reduce risk but do not satisfy the five
physical/manual release checks themselves.

## Deferred

- T7 markdown loop files (optional), blocked on a safe subscription to the
  existing watcher.
- TUI scheduled surface (read-only list + manual run) beyond the API.
- Multi-target fan-out, per-run worktrees with a retention sweeper, and
  quota-reset-aware retry.

## Addendum — T8 client surface (implemented in a parallel workstream)

Files (all additive):

- `packages/app/src/context/scheduled-tasks.ts` — the single store/provider
- `packages/app/src/components/scheduled-task-editor.tsx` — editor dialog
- `packages/app/src/pages/scheduled-page.tsx` — Scheduled pane (TASKS + RUNS)
- `packages/app/src/app.tsx`, `packages/app/src/i18n/en.ts` — registration and
  i18n keys only

04 § 4.1 compliance:

- one `event.listen` subscription per server (`scheduledTask.*`), patching rows
  by id; the list query is not re-fetched per event;
- one refcounted 1-second `setInterval` in the store drives every countdown;
  the page retains it on mount, so N rows share one clock and no row owns a
  timer;
- `ensureLoaded()` calls only Tier 0 endpoints (`list`, `inbox`, `getControl`,
  `unreadCount`) when the pane opens; `runNow` is also Tier 0 but fires only on an
  explicit user action and returns after durable enqueue, before agent execution.
- acknowledgement goes through `acknowledge`; no `localStorage` and no
  client-side cron parsing anywhere (`preview` supplies next times + warnings).

Review correction applied after the parallel pass: the inbox badge is now
server-authoritative. The store consumes the server `unreadCount` aggregate and
re-reads it after `runSettled`/`runUpdated` and after `acknowledge`, instead of
counting a bounded inbox window with a different status set. The local attention
set was aligned to the server definition (`failed`, `waiting`).

Verification: `packages/app` `bun run typecheck` reports a pre-existing error set
byte-identical to baseline (no errors in the new files); `oxlint` on the new
files reports no errors. The desktop UI was not launched for manual QA (see
Manual QA status above); no browser/visual verification was performed.

## Continuation — 2026-09-18 cross-process liveness hardening

This continuation supersedes the 2026-09-17 idle-runner and `runNow` ownership
assumptions while preserving their dated measurements above.

### Why the architecture changed

Two implementation proofs exposed gaps that were independent of the original
lease/idempotency safety model:

1. **Durable queued work could be stranded after a lost wake.** A manual
   `runNow` row is durable and intentionally independent of `next_run_at`.
   If its writer committed and died before publishing EventV2, another healthy
   process with no recurrence cursor had no reason to inspect the database.
2. **Dispatch concurrency was bounded per batch, not per runner.** A timer wake
   could fork one concurrency-2 batch and an overlapping manual/event wake could
   fork a second concurrency-2 batch, producing an observed peak of 4.

Both were corrected at the authoritative layer rather than hidden with
additional UI/runtime polling.

### Current ownership model

- Every scheduled-task HTTP operation, including `runNow`, is Tier 0 on
  `RootHttpApi`.
- The `runNow` handler validates and durably enqueues only. It has no
  `InstanceStore`, `InstanceHttpApi`, or imperative
  `ScheduledTaskRunner.poke()` dependency.
- `executor.ts` remains the sole Tier-3 boundary.
- EventV2 is the immediate same-process wake accelerator.
- SQLite durable state plus generation reconciliation is the cross-process
  liveness authority.

### Durable scheduler generation

Migration `20260918224000_scheduled_task_generation` adds the internal
`scheduled_task_control.generation` epoch.

SQLite triggers increment it transactionally for scheduler-relevant mutations,
including queued-run creation. The migration uses both `up()` and
`reconcile()` because fresh databases are built from `schema.gen.ts` and
pre-journal migrations; trigger DDL that lives only in `up()` would therefore
be absent on fresh databases.

The singleton control row is now reconciled into existence on every database
birth path.

### Runner state-machine hardening

The runner now has:

- single-flight/idempotent startup after the startup grace;
- startup `wake()`, so already-durable queued manual work is scanned even if
  the enqueue notification was lost before restart;
- one timer while started, representing either recurrence or idle generation
  reconciliation;
- epoch-fenced timer ownership plus an installation gate, preventing stale
  callbacks and zero-delay installation races;
- callback-before-rearm ownership consumption, so a timer never relies on
  self-interruption behavior;
- one scalar generation read every 60 seconds while no recurrence cursor exists;
- no task/run scan, recurrence evaluation, Instance load, or dispatch when that
  generation is unchanged;
- runner-global dispatch serialization;
- a single `wakePending` bit that coalesces any number of wakes received while
  the active dispatch batch is draining.

The durable/source-of-truth flow is therefore:

```text
SQLite commit + generation
        │
        ├── EventV2 ───────────────► immediate same-process wake
        │
        └── idle generation timer ─► bounded cross-process recovery
                                      │
                                      ▼
                                  planDue()
                                      │
                                      ▼
                                lease + unique key
                                      │
                                      ▼
                                 Tier-3 executor
```

### C9 liveness proof

C9 is intentionally decomposed.

**C9-storage** uses the existing two-real-process SQLite fixture. A peer process
queues a manual run and exits; a separately opened database service must observe
the incremented generation. This proves durable cross-process visibility rather
than connection-local notification.

**C9-runner** uses TestClock. It inserts a queued run directly through SQL so no
EventV2 wake is emitted, advances one reconciliation interval, and requires the
idle runner to discover, execute, and settle the run.

The focused C9-runner proof passed after the migration was corrected to install
triggers through `reconcile()`.

### Concurrency proof exposed by the new timer model

The strengthened timer semantics made the C6 test observe a peak of 4 in-flight
dispatches. That was a genuine runner-level concurrency defect, not a flaky test:
two separately bounded batches could overlap.

After `wakePending` coalescing was added, the focused C6 test passed with a
peak equal to the configured runner cap of 2.

### Verification evidence obtained before unrelated worktree interference

The following evidence was obtained during the 2026-09-18 continuation:

- original Core scheduled-task suite before liveness edits: **41/41**;
- original OpenCode scheduled-task suite after the Tier-0 `runNow`/startup
  recovery work: **30/30**, 129 expectations across 5 files;
- scheduled real E2E after graph/config repair: **2/2**;
- regenerated V2 SDK typecheck: **0 diagnostics**;
- database migration suite after adding generation reconciliation:
  **19/19**;
- schema-only scheduled tests after reconciling the singleton/triggers:
  **green**;
- focused idle reconciliation (D3): **green**;
- focused global dispatch cap (C6): **green**, peak = 2;
- focused lost-wake generation reconciliation (C9-runner): **green**;
- focused runner tests also passed D4, ordinary due execution, C7, C2, manual
  enqueue execution, and startup recovery before the unrelated failure below
  appeared.

A complete post-generation aggregate rerun was then prevented by a concurrent
foreign change in `packages/core/src/session/context-epoch.ts`:

```text
Schema.decodeUnknownOption(SystemContext.LegacySnapshot)
TypeError: undefined is not an object (evaluating 'schema.ast')
```

The exception occurs during module initialization before scheduler tests run and
is outside this campaign's ownership. It was deliberately left untouched in the
shared dirty worktree.

Consequently, this continuation does **not** claim a fresh all-green aggregate
after the newest generation/timer changes until that unrelated module
initialization is repaired and the matrix is rerun.

### Performance status

The latest successful pre-generation benchmark measured approximately:

| Scenario                      | Measured |
| ----------------------------- | -------: |
| List 500 tasks                |  5.92 ms |
| `nextDueAt` over 500 tasks    |  1.38 ms |
| Inbox newest 50 over 50k runs |  1.17 ms |
| Unread count over 50k runs    |  0.56 ms |

`bench-scheduler.ts` now additionally measures 1,000 sequential
`generation()` reads and reports both total milliseconds and average
microseconds/read.

That updated benchmark is presently blocked by the same foreign
`context-epoch.ts` module-initialization exception. No generation-probe number
is invented here.

The intended idle budget is now explicit:

```text
per started process, while no due cursor exists:
  1 timer
  1 primary-key scalar generation read / 60s
  0 task-table scans if unchanged
  0 run-table scans if unchanged
  0 recurrence evaluation if unchanged
  0 Instance loads
  0 session/provider/tool work
```

### Documentation source of truth

The current normative documents are:

- `01-architecture.md` — domain ownership and negative invariants;
- `05-verification.md` — current C9/D3/performance proof contract;
- `06-risks-and-open-questions.md` — decisions and refinements;
- `07-cross-process-liveness.md` — full lost-wake, timer-ownership, migration,
  proof, performance, and future-IPC architecture.

The 2026-09-17 measurements above remain useful historical evidence but do not
override those normative documents.

## 2026-09-18 continuation — SQLite writer ownership and provenance durability

The post-closeout performance rerun exposed a reproducible failure near
`bench-96` only while ChunkDB semantic pruning was enabled. A raw two-connection
WAL prototype identified the native error as `SQLITE_BUSY_SNAPSHOT` (extended
code 517): a foreground DEFERRED transaction established a read snapshot, the
maintenance connection committed, and the foreground transaction could no
longer upgrade that stale snapshot to a writer. `busy_timeout=5000` is
irrelevant to that failure class.

Scheduler read-modify-write transactions now begin IMMEDIATE, acquiring the
writer reservation before their first read. Goal mutation transactions use the
same rule because scheduled `action.goal` execution delegates directly to the
Goal domain. Semantic pruning remains enabled; it was the concurrent writer that
made the latent transaction-mode bug deterministic, not the architectural fault.

The semantic-prune-enabled benchmark now completes. Final 2026-09-18 values
below are the median of three isolated runs:

| Scenario                      |                       Measured |
| ----------------------------- | -----------------------------: |
| List 500 tasks                |                        7.37 ms |
| `nextDueAt`                   |                        1.76 ms |
| 1,000 generation reads        | 98.31 ms total / 98.31 µs each |
| Inbox newest 50 over 50k runs |                        1.31 ms |
| Unread count                  |                        0.56 ms |

Run/session provenance was also tightened: a scheduled run binds its current
attempt's Session to `scheduled_task_run.session_id` immediately after Session
creation and before Goal/model work. The binding is fenced by `runID + attempt +
active status`; retry start clears the previous attempt's Session pointer, and
a stale executor cannot overwrite the newer attempt. The scheduled worker turn
independently carries `owner=host`, `source=scheduled-task.run`, and
`ref=runID`.

The attempt fence now covers the full executor mutation lifecycle: Session
binding, permission waiting/running transitions, and terminal settlement all
require the current `runID + attempt`. A stale attempt receives
`ScheduledTask.RunAttemptConflictError` on settlement and cannot overwrite the
newer attempt's durable state.

Stale-lease recovery was tightened under the same rule: stale candidate
selection now occurs inside the IMMEDIATE recovery transaction, lease clearing
is compare-and-set against the exact observed lease id/owner/heartbeat, and run
abandonment additionally matches the recovered lease attempt. This removes the
TOCTOU window where a heartbeat could land after an out-of-transaction stale
scan but before recovery writes.

Final automated scheduled-task matrices after these changes:

- Core Scheduled Tasks: **45 passed / 0 failed / 206 assertions**.
- OpenCode Scheduled Tasks: **34 passed / 0 failed / 153 assertions**.
- Goal: **27 passed / 0 failed / 145 assertions**.
- ChunkDB semantic prune: **13 passed / 0 failed / 75 assertions**.
- Native SQLite snapshot proof: **2 passed / 0 failed / 10 assertions**.
- C10 live semantic-prune contention was additionally repeated three times in
  isolation, all green.

## 2026-09-19 continuation — conversational creation and provenance admission

Scheduled Tasks now have a first-party model-facing creation surface without
introducing a second scheduler. The provider-visible `scheduled_task` tool is a
thin OpenCode adapter over process-global Core `ScheduledTaskAgent`, which
derives project/directory ownership from the durable root Session and delegates
the write to the existing Tier-0 `ScheduledTask.Service`. The admission path
does not import `InstanceStore`, `InstanceState`, the runner, or the executor;
the executor remains the sole Tier-3 boundary.

The Goal-era provenance fence was generalized into
`durableUserActionAuthorization`. Prompt/Command human roots carry that
capability; host/scheduled/historical roots do not. Goal retains its old
classifier as a compatibility alias. Both Goal and Scheduled Task tools now use
one active-worker-root adapter rather than searching backward for any old human
turn. Consequently a scheduled run, host continuation, or subagent root cannot
borrow stale scheduling consent.

Scheduling adds a second, domain-specific policy after the actor/provenance
check. It accepts explicit scheduling/reminder/recurrence requests and immediate
confirmation of an assistant scheduling proposal, while rejecting informational
questions, negation, bare affirmation without a proposal, unsolicited creation,
and child-Session ownership. Daily/weekly/cron conversational schedules require
an explicit IANA timezone; the producer never interprets a human wall-clock time
through the server's ambient timezone. A `once` schedule is already an absolute
instant and does not require a zone.

Creation provenance is durable and independent from execution provenance:

- task definition: `source=agent` + scalar `source_message_id=<human root>`;
- execution turn: `owner=host`, `source=scheduled-task.run`, `ref=<run id>`.

`source_message_id` intentionally has no foreign key, so transcript pruning
cannot erase the audit fact. Migration
`20260919081704_scheduled_task_agent_source` adds only that nullable column;
the canonical migration checker reports no remaining schema delta. Public HTTP
creation cannot forge the trusted `agent` source/correlation.

Provider replay is idempotent without penalizing the normal hot path. A new
creation performs one durable Session PK read and then enters the canonical
IMMEDIATE create transaction directly; there is no idempotency preflight query.
Only a duplicate-name result performs one indexed recovery lookup. The exact
same source turn + exact persisted specification returns the existing task;
same-name but different authorization/specification fails closed rather than
mutating it.

Verification added by this continuation:

- Core conversational-agent integration: **6/6**, including durable ownership,
  inheritance/defaults, exact replay, conflicting authorization, explicit
  disabled creation, ambiguous-timezone rejection, unsolicited creation, and
  child-Session rejection;
- OpenCode `scheduled_task` adapter: **2/2**, including stale-consent
  rejection;
- provider registry proof: `scheduled_task` is directly provider-visible;
- scheduled architecture regression suite: **15/15, 60 assertions**, including
  Tier-0 admission, non-forgeable HTTP provenance, and current shared
  prompt-contract ownership;
- Core Scheduled aggregate after this work: **62/62, 259 assertions**;
- V2 SDK typecheck: **exit 0**; generated Scheduled types contain
  `ScheduledTaskSource = "api" | "agent" | "loop_file"` and
  `sourceMessageID?: string`;
- canonical migration check: **clean**.
- Goal + Scheduled tool + full registry aggregate: **34/34, 136 assertions**;
- Core provenance + scheduling-intent aggregate: **22/22, 121 assertions**;
- browser-safe Schema provenance: **6/6, 38 assertions**.

The semantic-prune-enabled scheduler benchmark was also extended to measure the
new hot path. On 2026-09-19, 100 sequential uncontended conversational creates
took **277.46 ms total / 2.775 ms average**. In that same run: list-500 was
4.60 ms, `nextDueAt` 1.37 ms, generation reads 103.90 µs/read, inbox-50 over
50k runs 1.32 ms, and unread count 0.53 ms. The create measurement includes the
durable Session ownership read and canonical IMMEDIATE create transaction; it
does not materialize an Instance.

During the first aggregate OpenCode rerun, five tests transiently failed while a
concurrent Session runtime campaign was modifying `SessionRunState` /
`SessionPrompt` ownership. Focused HTTP and real scheduled E2E reruns
immediately afterward were **3/3** and **2/2** green respectively. A stale static
architecture assertion was then updated to follow the new extracted
`prompt-contract.ts` ownership boundary rather than matching the former inline
type declaration. No Session-runtime implementation was changed by this
Scheduled Tasks continuation.

After that concurrent seam settled, the complete OpenCode Scheduled aggregate
was rerun and is **37/37 green, 169 assertions across 5 files**. This supersedes
the transient failure note as the current automated result while retaining the
note above as an explanation of the shared-worktree interruption.

## 2026-09-18 continuation — notification ownership and product-surface convergence

The V1/V2 maps and package contracts were re-read before the final notification
work. The resulting architecture is explicit:

- Schema/Core own durable scheduling semantics and process-global projections.
- The mature V1/fork runtime + unified local HTTP API remain the production
  execution surface.
- The V2/new-layout app remains the product presentation direction.
- The generated SDK's `v2` path does not redefine runtime/API ownership.
- `packages/tui` is retained coupling rather than an OpenFork product surface.

### Notification policy

`policy.notify` had been persisted and presented in the editor but generic
Session PushV2 notifications could bypass it. That is now corrected at the
process-global producer:

- Scheduled Sessions carry immutable `scheduledTaskID + scheduledTaskRunID`
  metadata from creation.
- Generic Session completed/failed pushes suppress scheduler-owned Sessions.
- `scheduledTask.runSettled` is the one Scheduled outcome wake signal.
- PushV2 re-reads current run/task/lease truth before delivery, so delayed
  previous-attempt events cannot notify after a retry took over.
- Retryable failed attempts remain quiet while the attempt+1 lease is pending.
- `notify=never` suppresses all Scheduled outcome pushes.
- `notify=failure` sends only terminal failed/abandoned outcomes.
- `notify=always` includes succeeded/skipped outcomes as well.
- Permission/question pushes remain tied to actionable `permission=pause`
  interactions rather than the run-outcome notification mode.

Push is deliberately **best-effort attention**, not a second durable queue. The
SQLite Scheduled inbox/run row remains authoritative. `RunSettled` is live-only
and the existing Web Push transport may discard transport failures according to
its normal policy.

Current PushV2 subscriptions are mobile-owned. A scheduled outcome with a
Session uses `/session/:id`, which the mobile service worker already
canonicalizes to `/?session=...`. Runs that fail before Session creation use
`/` rather than an unsupported mobile `/scheduled` route. Semantic task/run
identity remains in the notification payload.

The real PushV2 integration suite uses real Database + EventV2 + ScheduledTask +
PushV2 and mocks only the external `web-push` transport. It proves generic
failure suppression, generic completion suppression, `never` vs `failure`,
retry suppression, Session deep-link navigation, and the no-Session root
fallback: **4 passed / 0 failed / 16 assertions**.

### Session producer-metadata ownership

The notification classifier exposed a broader V1 invariant: root Session
`metadata` is an extensibility bag, but some keys are host-owned producer
identity. Treating the entire object as caller-replaceable allowed a later
`setMetadata` to erase Scheduled origin (or existing special-agent identity),
and public creation could forge those classifiers.

The common Session boundary now owns this explicitly through
`SessionMetadataOwnership`:

- the reserved set is deliberately narrow: special-agent identity and Scheduled
  task/run identity;
- public HTTP Session creation strips attempted producer identity;
- caller metadata updates retain replacement semantics for ordinary keys while
  preserving existing producer identity and rejecting attempted spoofing;
- Session forks carry ordinary compatibility metadata but strip producer origin,
  because a fork is a new aggregate;
- special-agent provisioning composes its identity after caller extras, so
  producer truth wins by construction.

This is intentionally separate from **turn provenance**. Session producer
metadata may classify an aggregate for grouping/notification; it never grants a
prompt System authority or substitutes for typed turn provenance.

Verification added:

- Core metadata-ownership + Scheduled provenance unit tests:
  **8 passed / 0 failed / 11 assertions**.
- V1 HTTP boundary proof for public-create spoof rejection, replacement
  preservation, special-agent relation preservation, and fork stripping:
  **1 passed / 0 failed / 5 assertions**.
- Full V1 Session HTTP regression after the ownership change:
  **31 passed / 0 failed / 174 assertions**.
- Session-group special-agent regression: **7 passed / 0 failed**.
- Scheduled PushV2 integration remained **4 passed / 0 failed / 16 assertions**.

### T7 and TUI decisions

T7 loop files remain deferred after proving the canonical filesystem watcher is
location-scoped and finalizer-owned by that graph. File-authoritative schedules
would miss inactive-project edits; keeping locations alive would violate the
Tier-0 scheduler boundary, while adding another process-global watcher violates
the shared-observer rule.

No TUI Scheduled surface is required. Current `docs/map/surfaces.md` and
`FORK.md` classify `packages/tui` as retained upstream coupling, not an
OpenFork product/compatibility surface.

### Latest automated evidence

- Core Scheduled Tasks: **51 passed / 0 failed / 227 assertions**.
- OpenCode Scheduled Tasks: **34 passed / 0 failed / 154 assertions**.
- Scheduled PushV2 integration: **4 passed / 0 failed / 16 assertions**.
- Unified SDK regeneration: completed successfully.
- The temporary `scheduled_task_run(session_id)` reverse index experiment was
  removed after immutable Session metadata proved the stronger retry-safe
  classifier; the canonical migration checker passed immediately after that
  removal.

A later aggregate migration/Goal rerun became blocked by concurrent unrelated
`session_checkpoint_search` work: its table/migration was present in the dirty
worktree while the migration registry/test database was temporarily
inconsistent, causing `no such table: main.session_checkpoint_search`. This is
outside Scheduled Tasks and was intentionally left untouched. The Scheduled
Task and PushV2 matrices above remained green during the same worktree state.

## 2026-09-18 continuation — Session aggregate metadata ownership

The notification work exposed a broader V1 Session ownership defect: root
`metadata` is a replacement-style compatibility bag, but Scheduled Tasks and
special-agent transcripts use part of that same bag for producer-owned aggregate
identity. A generic metadata replacement could erase the classifier; public
Session creation could spoof it; and V1 fork cloned it into a new aggregate.

This is now handled at the common Session boundary rather than patched in
PushV2/Scheduled Tasks:

- `packages/core/src/session/metadata-ownership.ts` owns the immutable
  producer-origin registry and transformation rules.
- Public V1 Session creation strips producer-origin keys before trusted Session
  creation.
- The V1 Session aggregate mutation path preserves existing producer origin
  across metadata replacement while ordinary caller metadata remains
  replacement-semantics.
- V1 fork deliberately strips producer origin from the new aggregate while
  preserving/deep-cloning ordinary metadata.
- `SpecialAgentSession.provision` composes extras first and reserved identity
  last, so extras cannot overwrite host-owned identity.
- Scheduled provenance and special-agent constants now use the shared key
  registry rather than independent string literals.

No SQL migration, reverse lookup index, history scan, or extra database read was
added. The existing Session mutation already reads the current row, and the
ownership transform is bounded by the small metadata object.

Latest focused proof after this convergence:

- Session metadata ownership policy: **6 passed / 0 failed / 8 assertions**.
- V1 public create/PATCH/fork ownership: **1 passed / 0 failed / 5 assertions**.
- Special-agent grouping: **7 passed / 0 failed / 37 assertions**.
- Strict `localMcp` recursive policy checks: **2 focused tests passed**.
- Core Scheduled Tasks: **51 passed / 0 failed / 227 assertions**.
- OpenCode Scheduled Tasks: **34 passed / 0 failed / 154 assertions**.

The broader `test/tool/task.test.ts` file remains red in unrelated tests because
the concurrent turn-provenance campaign now intentionally refuses historical
role-only test fixtures that are not provenance-qualified worker prompts. Its
strict `localMcp` tests pass, which is the adjacent behavior relevant to this
metadata-ownership change.

## 2026-09-19 continuation — conversational Scheduled Task creation

Users can now ask the primary agent to create/schedule durable work in ordinary
language, analogous to conversational Goal creation. This is implemented as a
first-party `scheduled_task` tool plus a Core `ScheduledTaskAgent` admission
service, not as a second scheduler.

Architecture:

- the provider-facing tool only collects a concrete structured schedule/action;
- a shared tool-boundary extractor first requires that the **latest active
  worker root** itself is a provenance-qualified human Prompt/Command; Goal and
  Scheduled Task creation both consume that common durable-user-action fence;
- `ScheduledTaskAgent` owns schedule-specific intent authorization and derives
  project/directory ownership from the durable parent Session;
- the existing process-global `ScheduledTask.Service.create` remains the only
  durable writer and recurrence/cursor authority;
- public model execution cannot create schedules opportunistically: the current
  human turn must explicitly request scheduling, or immediately confirm the
  agent's scheduling proposal;
- a later host/scheduled/subagent root cannot borrow an older human scheduling
  request;
- child/subagent Sessions are denied durable scheduling authority;
- agent-created schedules persist `source=agent + sourceMessageID`; public HTTP
  creation cannot forge either field;
- `once` schedules are absolute instants; daily/weekly/cron wall-clock
  schedules require a concrete IANA timezone. The model may use authoritative
  user context, but ambiguous timezone intent fails closed and is clarified
  rather than guessed from the server host;
- exact same-origin/spec provider retries return the existing task with
  `created=false`; a conflicting same-name request fails closed;
- no new database table, timer, watcher, polling loop, Instance load, recurrence
  implementation, or client transport was introduced.

The creation hot path was tightened during concurrent review: it does **not**
preflight with `findByName`. It performs the durable Session lookup and enters
the canonical IMMEDIATE create transaction directly. Only a duplicate/replay
result pays the indexed name recovery read, preserving idempotency without
adding an uncontended round trip.

The provenance addition uses migration
`20260919081704_scheduled_task_agent_source`, which adds only nullable scalar
`scheduled_task.source_message_id`. It is intentionally not a foreign key so
conversation pruning cannot erase creation attribution. The canonical migration
checker was clean immediately before the change, emitted exactly that one
incremental migration, and is clean again afterward.

During the first full OpenCode rerun, five pre-existing Scheduled HTTP/E2E tests
exposed a concurrent Session execution-ownership lifetime bug:
`SessionPrompt` registered its canonical drain callback while
`SessionRunState.registerDrain` eagerly dereferenced `InstanceState`, so
process service construction died with `InstanceRef not provided`. The fix
moved only the invariant drain callback to SessionRunState service scope; runner
maps, durable-owner tokens, cancellation sets, and scopes remain per-directory.
This restored Tier-0 server construction without injecting fake Instance
context.

Current focused regression proof:

- creation authorization policy: **5 passed / 0 failed / 17 assertions**;
- `ScheduledTaskAgent`: **7 passed / 0 failed / 18 assertions**. This includes
  canonical `once` replay behavior: timezone is semantically irrelevant to an
  absolute instant and is normalized away before persistence/idempotency
  comparison;
- provider tool provenance/metadata adapter, including stale-consent rejection:
  **2 passed / 0 failed / 3 assertions**;
- real ToolRegistry/provider-manifest exposure of the direct `scheduled_task`
  capability: **1 passed / 0 failed / 2 assertions**;
- Scheduled architecture negative invariants: **16 passed / 0 failed /
  62 assertions**;
- SessionRunState ownership regression: **5 passed / 0 failed / 9 assertions**;
- Scheduled HTTP API after the lifetime fix: **3 passed / 0 failed /
  35 assertions**;
- real Scheduled end-to-end path after the lifetime fix: **2 passed / 0 failed /
  19 assertions**.

Final aggregate rerun from the same live dirty worktree:

- Core Scheduled Tasks: **63 passed / 0 failed / 262 assertions** across 8 files;
- OpenCode Scheduled Tasks: **38 passed / 0 failed / 171 assertions** across 5 files;
- canonical Core migration check: **clean** (`No schema changes, nothing to migrate`);
- Schema scheduled/provenance **source-only** scoped typecheck: **0 diagnostics**.
  Including Bun test files adds only the environment-level unresolved
  `bun:test` declaration diagnostic; the same tests pass under Bun.

The canonical V2 SDK was regenerated from live OpenAPI after the schema change;
its generated contract now includes
`ScheduledTaskSource = "api" | "agent" | "loop_file"` and
`ScheduledTaskInfo.sourceMessageID?: string`. The canonical SDK build,
including its generated-code hardening patches and TypeScript compilation,
exited 0.

Final semantic-prune-enabled benchmark rerun:

- 100 sequential uncontended conversational creates:
  **242.94 ms total / 2.429 ms each**;
- list 500 tasks: **5.30 ms**;
- `nextDueAt` over 500 tasks: **1.41 ms**;
- 1,000 idle generation reads: **106.63 µs/read** average;
- newest 50 inbox rows over 50k runs: **1.39 ms**;
- unread count over 50k runs: **0.53 ms**.

The model-facing creation path therefore remains a Tier-0 millisecond operation:
one durable Session PK read plus the canonical IMMEDIATE create transaction on
the uncontended path, zero Instance loads, and zero idempotency preflight reads.

### Final provider-permission and SDK-generator closure

The direct provider-facing tool was exercised under an explicit
`scheduled_task=deny` rule. The registry intentionally keeps the tool in the
provider manifest so the tool prefix remains cache-stable, but the returned
execute closure rejects the call before `ScheduledTaskAgent` can run. Combined
with the direct-exposure proof, the focused registry slice is now
**2 passed / 0 failed / 4 assertions**. This is the intended split: manifest
shape is cache policy; execution authority is permission policy.

The canonical SDK build was also re-run from its real package entrypoint on the
Windows development host. That exposed a generator-owner portability bug:
`script/build.ts` relied on shell redirection to materialize `openapi.json`.
The producer process could complete while no file appeared, causing the next
generation step to fail with `ENOENT`. The build script now captures the
canonical OpenCode generator stdout and writes `openapi.json` explicitly with
`Bun.write`, removing host-shell redirection from the contract.

After that correction, `bun run build` completed end-to-end with exit code
**0**, including OpenAPI generation, Hey API regeneration, generator hardening
patches, formatting, and TypeScript compilation. The generated Scheduled
contract still contains `ScheduledTaskSource = "api" | "agent" | "loop_file"`
and `sourceMessageID?: string`, and the temporary `openapi.json` is removed
by the normal build cleanup.

`packages/sdk/js/script/build.ts` had an isolated local
`assume-unchanged` index bit while adjacent SDK/generated files did not. That
single flag was cleared so the verified portability fix is visible to ordinary
Git review/commit. No content was staged and no unrelated index state was
changed.

### Final dossier consistency pass

The post-build audit also removed two stale planning-era statements that had
survived after their decisions were already implemented: 01 § 3.5 no longer
describes multi-project fan-out as awaiting T0 (decision 4 fixed one target per
task in v1), and 06 no longer describes natural-language schedule generation as
a future phase now that conversational creation exists. Natural language remains
strictly an admission/input surface; the durable scheduler still stores only the
canonical structured schedule.

The full provider registry regression was then run, not just the two focused
Scheduled assertions: **32 passed / 0 failed / 134 assertions**. It proves the
direct `scheduled_task` provider manifest and explicit-deny behavior coexist with
the rest of the compressed/direct tool registry. A campaign-scoped
`git diff --check` is clean; repository-wide `git diff --check` still reports
whitespace in unrelated concurrent dirty-worktree files and those files were not
normalized by this campaign.

The ACP registry expectation now names `scheduled_task` explicitly alongside
the other fork-owned conversational tools, preventing a client-specific registry
refactor from dropping scheduling while leaving the default provider path green.

### 2026-09-19 — Session inspection convergence

Scheduled run inspection now converges on the same first-party Session-entry
architecture used by Task subagents and Goal Auditor rather than owning a
Scheduled-specific transcript/navigation path.

The durable ownership model remains intentionally different: every executing
Scheduled run owns a producer-owned **root Session**, not a child/subagent
Session. The executor creates that Session and atomically binds
`{ sessionID, directory }` to the attempt via `attachRunSession` before Goal
preparation or prompting. That binding publishes `scheduledTask.runUpdated`, so
the global Scheduled inbox can expose the Session while the worker is still
running. Terminal run history retains the same Session reference; deleting the
Scheduled Task catalog/history does not delete the Session.

Presentation now follows one shared contract:

- `@opencode-ai/session-ui` owns the context-free click/modifier/keyboard
  Session-entry behavior through `createSessionNavigation`;
- directory-scoped Task/Goal surfaces consume the `useSessionNavigation`
  wrapper over their existing `DataProvider`;
- the global Scheduled pane supplies the canonical App
  `legacySessionHref(directory, sessionID)` address plus the App router to that
  same shared behavior;
- once entered, the ordinary Session route, history hydration, SSE stream, and
  timeline own all transcript rendering. There is no Scheduled-specific Session
  viewer.

Focused proof from the live dirty worktree:

- shared Session navigation unit contract: **3 passed / 0 failed / 6 assertions**;
- full `packages/session-ui` suite after convergence:
  **216 passed / 0 failed / 1,653 assertions**;
- Scheduled live/durable Session-navigation browser regression:
  **1 passed / 0 failed** — no affordance before binding, live
  `runUpdated` exposes the running Session, ordinary Session navigation
  succeeds, and a fresh terminal inbox load still opens the same Session;
- Goal Auditor live Session-entry regression after the shared-core refactor:
  **1 passed / 0 failed**, proving the second consumer retained behavior;
- Core attempt-fenced durable run→Session binding:
  **1 passed / 0 failed / 14 assertions**;
- executor Session creation/reference proof:
  **1 passed / 0 failed / 7 assertions**;
- executor ordering proof:
  **1 passed / 0 failed / 5 assertions**, with the required order
  `session → attach → goal → prompt`;
- shared Session-navigation source/typecheck: **0 diagnostics**;
- Scheduled page scoped typecheck: **0 P0/P1 diagnostics** (only existing
  App/environment diagnostics outside this change).

Repository search found one Scheduled production open-Session affordance and no
Scheduled-specific transcript implementation in `packages/session-ui`. Shared
enterability is now an explicit architecture invariant; shared enterability does
not imply shared Session topology.

## 2026-09-19 continuation — Chats projection and user-drivable Scheduled roots

The Session-inspection convergence above is now complete in the V2 Chats
projection as well. Scheduled Task state is **not** a Chats data source.
Executing Scheduled runs remain producer-owned root Sessions and are enumerated,
updated, removed, navigated, hydrated, and prompted through the ordinary Session
architecture.

### Project-wide Tier-0 root census

The existing bootstrap-free `GET /global/session/roots` compact projection now
accepts optional `projectID`. When present, project identity is authoritative
for enumeration; `directory` remains the caller's canonical cache location.
`Session.Service.listGlobal` performs the durable query directly and does not
materialize an Instance/workspace runtime.

The canonical project worktree child store is therefore the bounded project-wide
root Session index. Sandbox/detail stores remain physical-directory slices.
This matters for Scheduled runs because their explicit/generated/reused
execution directory may differ from the project's worktree while their durable
`Session.projectID` still belongs to that project.

Startup may begin from persisted layout state that knows only a worktree. Session
cache scope is now explicit: a directory-only root snapshot cannot satisfy a
later project-wide snapshot merely because its retained row limit is warm.
Arrival of the authoritative project catalog upgrades an already-started or
already-loaded worktree census to `projectID` scope. The TanStack query key and
the Session high-water metadata both include that scope, preventing a stale
directory bootstrap from suppressing the canonical project census.

Live convergence remains entirely Session-owned. For root Session
`created|updated|deleted` events, the sync layer mirrors a foreign physical
directory event into the already-materialized canonical project index and, when
present, the physical detail store. Child Sessions stay physical-directory
scoped, preserving Task/subagent/Goal structural grouping. No per-row fetch,
message-history classification, fake parent edge, Scheduled cache, or
`scheduledTask.runSettled` sidebar projection was introduced.

The project-wide hot path has a dedicated partial SQLite index:

```text
session_project_root_updated_id_idx
  (project_id, time_updated, id)
  WHERE parent_id IS NULL
```

Migration: `20260919185713_session_project_root_sidebar_index`.

### Human driving vs producer authority

Scheduled run Sessions are now explicitly Swarm-like in **drivability**, while
remaining per-firing audit roots. Producer-owned
`scheduledTaskID + scheduledTaskRunID` metadata classifies the aggregate; it
does not make the root an opaque/subagent-style host-only Session.

- trusted scheduler admission still requires the registered
  `scheduled-task.run` host provenance;
- an arbitrary generic `hostPrompt` takeover remains rejected;
- an ordinary human follow-up is admitted through the canonical Session prompt
  path with `owner=user / source=prompt`;
- the normal Session composer is visible from a live Scheduled run and its real
  Send control uses the ordinary V1 `/session/:id/prompt_async` transport;
- producer-owned aggregate/control mutation remains fenced even though the
  conversation is user-drivable; malformed/partial Scheduled origin fails
  closed before async acknowledgement;
- if human input arrives during an active Scheduled provider cycle, it becomes
  the shared `SessionInput` User frontier and owns the next safe provider cycle
  rather than introducing a scheduler-specific immediate-interrupt protocol;
- future firings still create separate root Sessions rather than collapsing a
  task's entire history into one permanent transcript.

There is deliberately no `/scheduled-task/:id/prompt` endpoint.

### Focused proof from the live dirty worktree

- pure client project-index/root-loader contract:
  **5 passed / 0 failed / 10 assertions**;
- Scheduled root prompt authority:
  focused service proofs **3 passed / 0 failed / 19 assertions** — trusted
  scheduled admission succeeds, generic host takeover fails, ordinary human
  follow-up succeeds, malformed producer identity fails closed, and active-run
  human focus becomes the next provider-cycle root;
- Session HTTP ownership/transport:
  focused Scheduled proof **1 passed / 0 failed / 21 assertions** — normal V1
  `prompt_async` admits the human turn, malformed origin is rejected before
  204, and update/fork/abort/pause/resume/share/revert/transcript mutation/delete
  remain producer-owned and blocked. The legacy missing-Session abort contract
  remains idempotent (200) while an existing producer-owned Scheduled root is
  still fenced;
- full V1 Session HTTP regression with a realistic 30-second integration-test
  ceiling: **35 passed / 0 failed / 249 assertions**. The file's historical
  5-second default is below observed Windows integration startup cost for several
  otherwise-green tests (for example persisted-directory prompting takes
  ~16 seconds), so the widened verification ceiling is test-harness timing only,
  not a production timeout or relaxed behavioral assertion;
- project-scoped durable roots:
  **1 passed / 0 failed / 6 assertions** — the old directory census excludes a
  foreign-directory root and the project census includes it;
- Tier-0 ownership:
  **4 passed / 0 failed / 8 assertions**, including the project-scoped root
  census with no workspace runtime available;
- Chats browser regression on a fresh isolated Vite server:
  **1 passed / 0 failed** — persisted directory-only state upgrades after the
  durable project catalog arrives, foreign-directory Scheduled root appears in
  Recent/project groups exactly once per intended projection, live
  create/update/delete converge without root refetch, settlement does not remove
  the Session, and opening Chats performs no Scheduled task/run catalog reads;
- Scheduled run navigation/browser composer:
  **1 passed / 0 failed** on a fresh isolated server — live binding opens the
  ordinary Session, the normal contenteditable composer accepts a human draft,
  the real Send control emits the canonical V1 `prompt_async` payload, and the
  same Session remains enterable after terminal settlement;
- cross-surface browser certification:
  **2 passed / 0 failed** serially on a fresh isolated Vite server — Chats
  Session projection convergence and Scheduled Session navigation/send coexist
  without mock/backend-port interference;
- generalized SessionInput lifecycle:
  **13 passed / 0 failed / 43 assertions**, including User-over-autonomous
  priority, user-preemptible Synthetic revocation, fixed lane ordering, and
  homogeneous promotion;
- Swarm thin executor regression:
  **7 passed / 0 failed / 36 assertions**, including human-focus deferral;
- executor ordering:
  **1 passed / 0 failed / 5 assertions** with
  `session → attach → goal → prompt`;
- attempt-fenced durable run→Session binding:
  **1 passed / 0 failed / 14 assertions**;
- V2 generated SDK typecheck: **exit 0**;
- canonical Core migration/schema check:
  **clean** (`No schema changes, nothing to migrate`).

The browser proof was intentionally rerun on fresh isolated Playwright app ports
rather than the local default reusable dev server, preventing stale Vite module
state from masquerading as a product regression.

The migration result immediately above is the result from that Scheduled
projection checkpoint. During the active-run human-focus tranche, a transient
re-check became red because unrelated concurrent Swarm schema/migration work had
advanced the shared dirty worktree faster than its generated migration state.
That foreign frontier subsequently converged: the latest live
`packages/core` canonical migration check again exits **0** with
`No schema changes, nothing to migrate`. This promptability tranche itself
changes no database schema and did not generate, modify, or absorb the concurrent
Swarm migrations.

### Latest live certification after active-run human-focus closure

Re-run against the current dirty worktree after the migration frontier
reconverged:

- Core Scheduled Tasks: **63 passed / 0 failed / 262 assertions**;
- OpenCode Scheduled Tasks: **38 passed / 0 failed / 171 assertions**;
- Scheduled PushV2 integration: **4 passed / 0 failed / 16 assertions**;
- Scheduled promptability/malformed-origin/active-focus slice:
  **3 passed / 0 failed / 19 assertions**;
- generalized `SessionInput` lifecycle:
  **13 passed / 0 failed / 43 assertions**;
- full V1 Session HTTP regression with a 30-second integration-test ceiling:
  **35 passed / 0 failed / 249 assertions**;
- fresh isolated browser certification for Chats convergence + normal composer
  Send: **2 passed / 0 failed**;
- App E2E typecheck: **exit 0**;
- canonical Core migration/schema check: **exit 0 / clean**.

Fresh scheduler benchmark from the same live closeout state:

- list 500 tasks: **7.97 ms** (<10 ms budget);
- `nextDueAt` over 500 tasks: **2.71 ms**;
- 1,000 idle generation probes: **123.10 µs/read** average;
- newest 50 inbox rows over 50k runs: **1.32 ms** (<20 ms budget);
- unread count over 50k runs: **0.54 ms**;
- 100 sequential uncontended conversational creates:
  **302.17 ms total / 3.022 ms each**.

The package-wide OpenCode TypeScript program remains red with 21 diagnostics
from unrelated baseline type debt plus separate dirty/concurrent work (workspace
warp typing, SessionGroup/sync handlers, compaction/current-message bridging,
SPAD, wasm/module declarations, older test typing, and an MCP mock). Most
diagnostic-bearing files are clean in Git; the dirty ones are
`session/prompt.ts`, `tool/shell.ts`, and the two Session test files. The
diagnostics inside
`src/session/prompt.ts` are in the older compaction/current-message bridge near
lines 3080/3109, not the Scheduled promptability boundary near 2160–2260. This is
therefore recorded as a repository-wide typecheck condition, not a Scheduled
Tasks correctness failure.
