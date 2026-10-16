# Goal Mode: long-running execution and audit handoff hardening
**Date:** 2026-10-10 (America/Chicago)  
**Scope:** OpenFork V1/V2 worker/auditor/continuation lifecycles and process-start recovery.  
**Status:** critical crash-gap and retry-supervision repairs implemented locally; see verification and open blockers.  
**Execution safety:** all tests use temporary SQLite databases/local fake providers; **no live production DB writes, commits, user Session restarts or provider calls**.

## User's actual design contract

There is exactly **one Goal Mode**, not a collection of "automatic", "manual", or "unattended" Goal variants. Once a user focuses/starts a Goal, the worker performs concrete work; an independent, read-only auditor checks the worker result and its criteria; when incomplete but runnable, the auditor authors the next host-wrapped continuation. The loop can keep working indefinitely—days, weeks, or longer—until independently verified complete, a genuine external/user blocker, or explicit user pause/stop/steer. No arbitrary accumulated cycle count, token quota, elapsed Goal lifetime, or "no progress" heuristic may secretly end it. A **single auditor inspection** has a bounded execution budget; that bound is not the Goal lifetime. Host infrastructure failures must not manufacture domain blockers, replay irreversible worker tools, delete causal source identity, or silently abandon recoverable work.

### Invariants

- Only a positive, exact execution-owner generation may execute or interrupt a particular worker. A stale heartbeat is not proof of death.
- A worker's claimed reservation carries its immutable reservation ID, source turn, expected latest-user sequence and continuation prompt. Recovery must **not** interpret an interrupted independent auditor as permission to rerun the already-completed worker cycle.
- An auditor child Session may be reused, but each audit attempt has a different authoritative lease generation (durable `auditing_at`). A late result from an earlier generation cannot settle or clear a later one.
- A successful model tool call of `audit_verdict` **is not** a durable Goal reconciliation. The host must commit its verdict, criteria/evidence and subsequent continuation (or terminal outcome) before clearing its live audit authority.
- Explicit user verification can cancel/supersede an older worker continuation; startup recovery cannot silently perform that destructive operation.
- Recovery services are independent supervisors; a correct, indefinitely running Goal must not pin or exhaust a two-slot discovery/activation loop.
- Paused sessions stay paused. Retryable infrastructure errors remain separate from real domain blockers.

## Confirmed failures and applied changes

### 1. Audit succeeded but its durable cursor was cleared before host settlement

**Old behavior:** `packages/core/src/goal/auditor.ts` called `GoalAutomation.endAudit` on every successful `evaluateWithRuntime` Effect exit. The returned verdict did not yet pass `GoalAutomation.afterTurn`. Crash/interruption could leave neither an `AUDITING` cursor nor a scheduled audit/continuation. This is fatal in a long-running Goal.

**Correction:** preserve the durable lease on successful evaluation until host settlement. Exception/interruption calls `deferAudit` as before, now fenced by exact `auditorSessionID` and `auditStartedAt`. The auditor result carries `auditStartedAt`; `afterTurn(requireAuditCursor=true)` verifies actual live cursor, exact child Session, and exact start epoch. `beginAudit` assigns a monotonically increasing time even if rapid consecutive attempts reuse the child within the same millisecond.

**Guarantee:** a stale auditor result cannot authorize the wrong Goal revision or usurp a subsequent audit generation merely because its child Session ID matches. A crash before settlement leaves a cursor to reconcile on restart instead of falsely appearing settled.

### 2. Worker interruption destroyed an unsettled audit's recovery source

**Old behavior:** `GoalAutomation.requeueClaim` cleared `auditing_at` and `auditor_session_id` while releasing a claimed autonomous continuation, but did not latch `audit_requested_at`. The completed worker cycle was preserved as a reservation but its audit was no longer recoverable; an idle system could stall forever.

**Correction:** its exact-owner/id CAS uses an atomic SQL `CASE` over the pre-update auditor columns: if any auditor cursor was present, set `audit_requested_at` durably while releasing the claim, without changing reservation ID, prompt, source message, or user fence. Missing/unowned claims still short-circuit with indexed read. This does not authorize another worker execution. A targeted regression verifies `working → auditing → interrupted/requeue → audit_requested → claimAuditRecovery → auditing`, preserving exact reservation/source identity.

### 3. Parent runners could die between evaluator response and host settlement

**Old behavior:** Core V2 `SessionRunner` and OpenFork V1 `SessionPrompt` awaited evaluation and separate host reconciliation without a scoped recovery obligation for the result that had already been returned.

**Correction:** both runtimes retain the exact audit lease as `unsettledAudit` between the returned evaluation and successful `afterTurn` result. Their scoped finalizer atomically defers that exact lease on failure/interruption; a success marks it settled. This includes a direct user cycle with **no** claimed automatic reservation. A restart can re-audit the worker instead of replaying tools.

### 4. Crash recovery invoked the destructive user verification operation

**Old behavior:** `GoalAuditRecovery` called `SessionPrompt.requestGoalAudit`; by contract this first invoked `GoalAutomation.requestAudit`, wiping any claimed continuation and its causal worker turn/fence. It was appropriate for user-directed supersession and categorically wrong for recovery.

**Correction:** dedicated **internal** `SessionPrompt.recoverGoalAudit` preserves existing `audit_requested` rows, performs no preemptive worker cancellation, and only creates a request for a legacy verifying Goal with genuinely absent runtime. The user-facing mode and explicit `requestGoalAudit` semantics are unchanged. The recovery service now uses the internal entry point.

**End-to-end proof:** a local fake-provider integration test created a real worker result, persisted/claimed an exact continuation, began and deferred its audit, then called `recoverGoalAudit` with the auditor response deliberately held. Before the auditor returned, the DB still retained **exactly the same reservation ID and owned claim**. After release, the independent auditor completed the Goal and no worker turn was replayed (only original worker + auditor requests).

### 5. Recovery work was one-shot, permanently blacklisted, or blocked by live workers

**Old behavior:** `GoalContinuationRecovery` exited after one scan without deferred items, permanently suppressed any Session in a `failedSessions` Set after a transient error, and awaited the entire `prompt.loop` under `Effect.forEach(...concurrency:2)`. A genuinely long-running worker could occupy a recovery slot for days, preventing other Goals from recovering.

**Correction:** maintain a scope-owned recovery supervisor with repeated paginated scans. A detached, child-scoped Session wake never blocks recovery discovery for the worker's lifetime. At most two new cold launches per pass, independent of the number of active working Goals. Failed launches are logged and reattempted using per-Session exponential backoff (5 seconds to 10 minutes; **no maximum number of retries**). Concurrently active sessions are deduplicated by ID. Retry state for no-longer-pending completed Sessions is pruned. Missing/paused sessions are not activated as if user intent had changed. The persistent reservation remains the sole execution authority.

**Audit recovery:** its prior startup-only sweep is now a scoped periodic supervisor with bounded parallel auditor admissions and retryable scan errors. It checks the Session's pause state before admitting any audit. `GoalAuditor` itself retains its bounded **per-inspection** execution budget; no unbounded Goal worker is awaited in the recovery dispatcher.

### 6. Auditor-authorized continuation held the audit command open for the entire next worker lifetime

**Old behavior:** after auditing a worker, V1 `SessionPrompt.auditGoal` synchronously awaited `loop({sessionID})` on a continuation. An explicit verification command or recovery task could effectively run forever.

**Correction:** only when the host has persisted an actual continuation reservation, fork its execution in the owning SessionPrompt service Scope. Returning from audit no longer means waiting until the Goal itself finishes. A busy worker activation coalesces safely; startup failures are logged, with the reservation retained for recovery. Forked children are scoped to application teardown (not fire-and-forget promises).

## Verification evidence

| Gate | Measured outcome |
| --- | --- |
| Core Goal + independent auditor suites | **73 passed / 0 failed**, 435 assertions, approximately 51 s (latest completed combined run) |
| New Core interruption/reservation regression | Passed; exact claimed reservation survives requeue and re-audit |
| New Core reused-auditor/late-verdict regression | Passed; stale generation cannot settle or defer current audit |
| New V1 end-to-end exact-reservation recovery regression | **1 passed**, 8 assertions; held audit still retains same DB reservation and two total provider calls |
| Existing V1 worker→auditor→continuation→complete test | Passed in Goal-mode subset |
| Existing V1 compaction/recovery/verification tests | Passed in Goal-mode subset, except one separately tracked tool-abort/history-read case |
| Core TypeScript | Pass (after Core changes) |
| OpenFork TypeScript | Existing **25 unrelated errors** in CLI/HTTP/test files; no errors in newly edited Goal/recovery files in checked run |

One existing V1 test, `Goal Mode: a user verification request aborts an in-flight worker tool before the auditor starts`, still failed after ~22 seconds when run alone and in the Goal subset. A temporary probe established: the read tool's abort signal **was delivered**; parent worker status was **idle**; durable execution owner was **released**; `GoalAutomation.runtime` was **auditing**; fake provider received **both** worker and auditor requests. The test stalled later while fetching parent transcript history (`Session.messages`). This remains a **separate red test**; there is insufficient evidence to certify full history-read quiescence or call the entire Goal suite green. Temporary debug instrumentation was removed. An actual running production backend was **not restarted** to load the changes.

## Not yet resolved; do not assert overall perfection

1. **Infrastructure audit failures can still strand Goal Mode.** `GoalAutomation.afterTurn` currently treats `audit.ok=false` as `failAudit`, records `runtime_error`, and stops without a durable scheduled automatic re-audit; a five-minute per-audit timeout should not impose a lifetime ceiling on the overall Goal. The next iteration should add a persisted exponential retry schedule, preserve the worker's exact causal reservation, enforce quota/provider throttling, and surface `audit_retry_at` clearly in the UI. Do **not** blindly retry provider calls on every 30/60-second maintenance scan.
2. **Multi-process audit lease ownership is under-specified.** `GoalAutomation.layer`'s startup reconciliation assumes any persisted `AUDITING` lease belongs to a dead predecessor and clears all of them, as well as foreign reservation owners, without linking an audit to positive local process-death proof. Two simultaneous backend/desktop/OXP processes can invalidate one another's live leases. The correct repair requires durable owner-runtime identity, a live-owner probe, exact generation CAS, and no reclaim based on stale time alone.
3. **Verdict reconciliation and continuation reservation are not atomic as one durable transaction.** `Goal.reconcileAuditorVerdict` commits its own transaction before `GoalAutomation.afterTurn` writes the next reservation. A crash between them can require re-audit and may duplicate the nonsemantic auditor-run metric or audited event. Design an idempotent `audit_cycle_id` and single database transaction (or a durable outbox with unique cycle CAS) before claiming exactly-once *settlement*.
4. **Long transcript reads and interrupted-tool durability remain red.** The isolated V1 test above confirmed the interruption and auditor admission, then hung at `Session.messages`. Instrument read-connection ownership and canonical `MessageV2.pageOn`/part hydration separately; never fix the test by simply weakening the assertion or claiming the transcript is finalized without proof.
5. **Periodic rescan performance and fairness:** Benchmark against realistic numbers of pending/paused Goals; ensure queries are indexed by runnable state/due time, avoid always materializing all orphaned audit Sessions, and cap new cold workspace activations without capping the number of legitimately running Goals.
6. **Foreground user stop/preempt and stream shutdown:** Retain process-wide exact-generation actor fencing. Never declare stop successful until mutating tools quiesce and their side effects are reconciled. Avoid an arbitrary deadline that just discards unresolved execution authority.

## Relevant source files

- Core: `src/goal/auditor.ts`, `src/goal/automation.ts`, `src/session/runner/llm.ts`, `test/goal/goal.test.ts`, `test/goal/auditor.test.ts`.
- V1 desktop/server: `packages/opencode/src/session/prompt.ts`, `goal-continuation-recovery.ts`, `goal-audit-recovery.ts`, `test/session/prompt.test.ts`.

**Completion criterion for this candidate:** The early-cleared auditor lease, lost automatic audit on worker finalization, destructive recovery ingress, and indefinite recovery-dispatch occupation are closed in the local implementation and targeted tests. This is not yet certification that all autonomous Goal campaigns survive arbitrary crashes, permanently invalid credentials, all concurrent processes, or the red interrupted-history test.
