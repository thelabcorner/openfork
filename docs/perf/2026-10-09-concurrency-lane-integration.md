# OpenFork Session concurrency: cross-lane integration contract

Date: 2026-10-09 (America/Chicago). Status: **source reconciliation, not a deployed runtime certification**.

## Shared optimization objective

Maximize **concurrently progressing, human-controllable Sessions**, not process count, session records, or synthetic requests per second alone. Measure useful work, admission-to-first-token latency, p95/p99 stalls, cancellation-to-release, fairness, renderer responsiveness, and recovery safety at **1 / 5 / 10 / 25 / 50 / 100** live Sessions.

The ownership boundary is normative: `AGENTS.md`, `packages/opencode/AGENTS.md`, `packages/core/AGENTS.md`, `docs/map/README.md`, `docs/map/{architecture,v1-v2}.md`, `docs/architecture/{tool-surface-parity,swarm-runtime-ownership}.md`. V1 remains OpenFork's production execution path; Core owns shared durable semantics; the V2/new-layout UI consumes authoritative projections. No implicit upstream local API migration or new one-process-per-Session topology.

## One pipeline; distinct capacities

```text
human / worker / task / swarm input
  -> durable Session/turn admission (provenance + permission + idempotency)
  -> V1 Session coordinator (one owning execution/recovery generation)
  -> selected provider/account route + quota/governor
  -> live provider stream [permit held until physical SSE EOF/cancellation]
  -> provider step: history + Core read-only WAL context projection
  -> native/lazy tool dispatch (same semantic owner across authorized surfaces)
  -> process admission: heavy | I/O | quick | background | monitor
  -> Core SQLite transaction/writer admission + durable terminal observation
  -> Session events/compact projections + bounded client transport
  -> V2 UI (virtualized rows, visibility-aware work, responsive controls)
```

**Invariants:** One expensive resource per physical requirement, not per logical Session. No shared heavy permit held by an indefinite monitor. No snapshot mutation barrier retained by a read-only infinite watcher. No retried already-exhausted local provider deadline. No active Session automatically replayed after uncertain external effects. No orphaned provider/account/process/tool permit after an authoritative terminal event. Any supported entry point must preserve real tool execution parity and caller authority.

### Shared state vocabulary for the V2 UI

`Waiting` and `Requesting` alone are insufficient to diagnose forward-progress failures. The underlying producers must retain these distinct states and their event times; an interface can group them visually but must not infer ownership from elapsed time:

| Domain | Authoritative state and owner | Required control/recovery semantics |
| --- | --- | --- |
| Input | `durably queued`, `admitted`, `rejected`; Session input/runner generation | Human submit is durable and must be visible. Pending input is not proof of a live runner. |
| Provider | `route/account admission`, `request sent`, `streaming`, `settled`; provider governor + physical stream | Show queue-vs-stream distinction; lease through actual stream end, not UI token arrival. |
| Tool | `call emitted`, `awaiting host admission`, `executing`, `settled`; Session tool owner | An emitted but never-started call must not suppress provider idle deadline. Cancel only the exact owned effect. |
| External request | `permission/question pending`, `resolved/rejected`; process-owned request handle | Resume by exact request ID without workspace bootstrap, preserving denial/revocation. |
| Resource queue | `queued local`, `queued machine`, `admitted`, `timed out/cancelled`; actual semaphore/Flock owner | Separate queue elapsed from execution elapsed; no fictitious unowned tool progress. |
| Recovery | `owner alive`, `dead-and-quiescent`, `effect-unknown`, `contained/released`; durable generation + containment owner | `effect-unknown` **cannot** auto-replay or auto-release. Provide truthful operator containment controls rather than an endless spinner. |
| Presentation | `visible/interested`, `hidden`, `up-to-date/stale`; event projection + client visibility | Hidden tabs do not own provider leases, history polling or recurring render work. |

The V1 runner must remain the source of lifecycle truth; this vocabulary is an integration/diagnostic target, **not** a proposal for an independent UI state machine or alternate persistence table.

## Reconciled lanes, evidence, and ownership

| Lane | Shared truth and latest source evidence | Remaining gate / disposition |
| --- | --- | --- |
| V1 context and per-step reader | `session/context/compiler.ts` uses Core `readDb`, projects needed columns only and shallow-copies the no-overlay case. `docs/perf/2026-10-09-session-concurrency-remediation.md`. Fresh 32-reader + conversation-control tests: **7/7, 74 assertions**. | **Integrate as implemented.** Do not add another reader, Session cache, or invalidation loop. Check 1/5/10/25/50/100 tail latency under writer load. |
| V1 environment and human route intent | `session/system.ts` bypasses the reference graph when no references exist; `session/prompt.ts` preserves producer route intent only for implicit interactive turns. These are recorded with tests in the V1 remediation ledger. | Protect explicit human model/account choices. Verify quota/account identity and cancellation at the actual provider stream owner. |
| Provider/runner hot path | Read-only execution audit identified repeated capability/catalog/schema materialization and tools manifest construction per step (`session/prompt.ts`, `session/tools.ts`, `tool/registry.ts`). | Profile exact step costs before caching; cache invalidation must respect plugin reload, permissions, account/route, MCP registry, and configuration generation. Do not invent a second manifest authority. |
| Provider silence/recovery | `session/first-content-deadline.ts`, `session/processor.ts` and `session/retry.ts` provide monotonic progress monitoring, a pending-vs-executing tool distinction and a non-retryable **local** exhausted watchdog. Fresh real-V1 silent-provider integration: **1/1**, single physical attempt, idle/error event. | Validate midstream silence, legitimate long tools, permission-wait wake, host cancellation and no external-effect replay together. Provider timeout is not a substitute for tool-specific deadlines. |
| Foreground process lanes | `util/machine-slot-budget.ts`, `tool/heavy-process-concurrency.ts`, `tool/shell-concurrency.ts`: bounded local+machine admission with one overall wait budget, cancellation, segregated classes, jittered lock polling and queue snapshots. `core/util/flock.ts` can refuse live-owner heartbeat eviction for process slots. | Verify multi-host fairness and saturation over 10/25/50/100 concurrent Sessions; do not raise heavy CPU process caps merely to admit more Sessions. Expose queue *reason* through its authoritative owner, not UI inference. |
| Background/monitor/snapshot | `background/process-concurrency.ts` separates finite shells from persistent monitors; `background/shell-job.ts` avoids retaining Snapshot mutation admission for monitors. | **Security gate:** read-only monitor intent must be enforced at the execution boundary, not just documented. Test monitor cancellation, registration race, foreground responsiveness, and snapshot mutation exclusion. |
| SQLite/OXP activity | `core/oxp-activity/activity.ts` implements atomic **initial** invocation-link admission and bounded `linkMany`; `opencode/oxp/activity-recorder.ts` retries transient busy writes and records safe operation-class diagnostics. Live OXP diagnostics have reported `SQLITE_BUSY` for process activity. | Terminal settlement + final links are not yet demonstrably atomic from the inspected `Interface`. An independent worker was investigating it; **reserve those files** until ownership is reconciled. Measure real writer hold/queue times and independent maintenance traffic; do not equate database and OXP-host failures without attribution. |
| Bootstrap and Tier-0/1 reads | Architecture prohibits `InstanceStore` or heavyweight workspace setup on global/durable reads. Memory read owner was decoupled from `AppRuntime` and measured in `docs/perf/2026-10-09-oxp-memory-latency.md`. | Measure cold service graph, selected-model initialization, and OXP transport-vs-server time separately; never move instance initialization to the UI as a workaround. |
| Swarm/worker ownership | `docs/architecture/swarm-runtime-ownership.md` documents a real HTTP host missing runner/dispatcher services: a durable active Swarm was inert until a later owner installed. One shared process-global runtime graph is the correction. | Independent HTTP-only host with isolated DB must materialize a ready worker/task and demonstrate generation fencing, no duplicate owner and no silent replay. Live user's Swarms must remain untouched. |
| Desktop/UI | Read-only renderer audit observed long-history frame gaps, unmeasured packaged cold rich-composer startup, bounded background catalog warming and N-request explicit bulk model apply. Existing projection/virtualizer and visibility guards already reduce per-Session amplification. | Pair 1/5/10/25/50/100 Session stress with interactive typing, scroll and control-lane measurements. Optimize measured frame owners; do not duplicate Session-history metrics in mounted UI components. |

## Cross-lane collision and integration rules

1. **OXP atomic-terminal work:** a separate delegated lane owns `packages/core/src/oxp-activity/activity.ts`, associated tests, and `packages/opencode/src/oxp/activity-recorder.ts`. Do not edit or reformat these concurrently. Review outcome + negative tests before integrating. Initial-link atomicity alone does not prove terminal atomicity.
2. **V1 concurrency work:** a separate worker owns the existing concurrency remediation campaign. Respect its writer/reader and Session route-intent changes. Any process-slot or provider-watchdog change must be regression-tested against its work, not hand-merged from an older snapshot.
3. **Core state remains authoritative:** preserve `SessionInput` ownership/generation, provider stream/account leases, SQLite writer ownership and event projection. No UI or OXP synthetic parallel lifecycle registry.
4. **Release is separate from source:** live OXP reports `runtime.refreshable=false`. Source tests cannot establish that running bundles were updated; use a **separate isolated host/database** for qualification, then coordinate any actual restart without killing the connected OXP or active user Sessions.
5. **Dirty-tree protection:** hundreds of unrelated paths are being edited across projects and lanes. No reset/stash/clean, no mass formatting, no all-files commit, no unreviewed bulk staging; verify exactly owned files and proofs.

## Prioritized adversarial verification

**P0 — forward progress and ownership:** Audit the V1 prompt suite's documented **95 pass / 11 fail / 14 skip** state, especially Goal preemption, orphan-owner takeover, queued shell cancellation, SPAD and tool-effect fencing. Any reproduced isolation failure blocks claims of full concurrency correctness. Cover paused human turn submission and permission/question response against one authoritative Session coordinator.

**Fresh P0 isolation finding:** `bun test test/session/prompt.test.ts -t "new user input repairs an orphaned unfinished assistant"` **fails** with `SessionBusyError` at `session/run-state.ts:210`. The fixture deliberately persists a `running` tool and acquires a durable Session owner without a live runner (`prompt.test.ts:3237-3304`). `SessionRunState.runner` refuses replacement when current/legacy execution hazards are unresolved (`run-state.ts:182-210`). This is a concrete **liveness-vs-safety conflict**, not permission to drop the fence: classify whether the orphan is provably dead and its effects durably interrupted before expecting a new human generation to proceed. The parallel test `-t "cancel interrupts loop queued behind shell"` is **skipped**; it supplies no passing cancellation evidence.

**Crucial counterexample:** `bun test test/session/prompt.test.ts -t "fresh activation resumes the current orphaned turn"` **passes (1 test, 10 assertions)** via the durable unknown-finish continuation. Therefore recovery is not universally broken. The failing case specifically asks for superseding *new input* despite an unresolved `running` tool. Core `session/recovery.ts:38-46,70-105` intentionally fences unknown external effects, while `session/operator-stop.ts:17-67` provides a separately authorized, contained operator acknowledgement. Keep these semantics distinct: automatic safe continuation when provable versus explicit containment and status surfaced to a human when not.

**P1 — streams and permits:** Exercise mixed accounts/models and 1/5/10/25/50/100 lightweight Sessions with an instrumented local provider; count live **physical** streams and actual account quota occupancy through SSE EOF. Cancel queued, streaming, permission-blocked, tool-running and post-result turns; assert one terminal event, zero leaked permits, no cross-account silent rerouting, no lost human input and no starvation.

**P1 — writer and external effects:** Isolated six-process WAL contention, 32 committed-state readers under held IMMEDIATE writer, OXP begin/final-link atomicity, crash/abort settlement, `BUSY` vs `BUSY_SNAPSHOT`, read-only background maintenance, and bounded retries without duplicate writes. Production activity records must not be altered for a smoke test.

**P2 — latency attribution:** Collect by-lane queue wait, admitted duration, model TTFT, p50/p95/p99 turnaround, busy retries, RSS/handles/CPU, event backlog and 99th-percentile UI frame stall with explicit test host and package revision. Distinguish 100 logical Sessions from 100 simultaneously streaming provider requests; fairness and real provider quotas constrain the latter.

**P2 — deployed parity:** Fresh local sidecar and independent HTTP-only Swarm host, OXP native-lazy-Code-ACP-OFXP/MCP supported-path parity and a controlled V2 UI. Test exact version/owner; no source-only completion claims.

## Current evidence / scope of claim

- This reconciliation freshly ran `bun test test/session/context-compiler-concurrency.test.ts test/session/conversation-control.test.ts` from `packages/opencode`: **7 passed, 74 assertions**, including 32 concurrent context compilers independent of an unrelated writer.
- Fresh `bun test test/session/processor-effect.test.ts -t "settles a silent provider"`: **1 passed, 6 assertions**, real V1 processor and terminal idle/error events.
- Previous same-checkout reliability campaign reports **154/154** focused tool/queue/OXP/retry tests and **13/13** Core Flock tests; these are source-level evidence, not the live host acceptance gate.
- The V1 remediation ledger explicitly records 11 failing full-prompt-suite cases; do not hide these behind green focused suites.
- Fresh isolated reproduction of the orphan-owner `SessionBusyError` confirms a P0 open release gate; the isolated queued-shell test is skipped rather than passed. No concurrent edits were made to the V1 recovery owner while its separate lane was running.
- Contrast gate: fresh durable unknown-finish continuation passes **1/1, 10 assertions**. The discrepancy is an ownership/semantics decision and recovery-UX integration problem, not proof that every orphaned Session is unrecoverable.
- Current full package TypeScript state can change under concurrent edits; prior unrelated errors are not equivalent to release readiness. Rerun in a stable integration snapshot and report every failure.

**Integration decision:** retain existing owners, finish lifecycle/fairness proofs before increasing concurrency settings, then optimize attributable per-step CPU and UI tails. The target is more **useful** Sessions and lower p95/p99 wait time with no authority, cancellation, or durable-recovery regression.

## October 9 continuation: amortize admission and remove launch polling

Source-owned improvements following this reconciliation:

- `packages/opencode/src/background/process-concurrency.ts`: persistent monitor and background shell lanes now have **process-global, lifetime-stable, local semaphore budgets** ahead of their existing cross-process Flock capacity. An operator changing an environment value while jobs are running cannot create a second simultaneous pool. Local and machine admission consume one overall timeout, not two independent budgets. A 50-waiter monitor regression proves only one executable monitor and **zero machine-slot waiters** while the other 50 are queued locally. This is a structural reduction in filesystem contenders, not a measured reduction in provider response time.
- `packages/opencode/src/util/machine-slot-budget.ts`, `tool/heavy-process-concurrency.ts`, `tool/shell-concurrency.ts`: the admission effects were restored to interruptible execution inside `Effect.acquireUseRelease`'s protected acquire phase. The pre-fix monitor cancellation regression timed out after 10 seconds; after correction it settled in approximately 36 ms on the measured test run. A cross-process queue cancellation test ensures the tool body is never admitted and the cancelled queue entry disappears immediately. **Cancellation must never depend on a long-running monitor releasing its permit.**
- `packages/opencode/src/background/shell-job.ts`: removed the 10 ms `jobs.get`/`background.get` polling loop (up to 200 iterations and 400 state reads per launch) and replaced it with a single `Deferred<boolean>` registration receipt. The receipt is completed after the live handle is registered and its removal finalizer installed, survives rapid process exit, returns false on pre-registration termination, and preserves the existing two-second `admitted:false` response if the job is still queued. The response does not claim the queued job completed or was already spawned.
- **Snapshot critical-section correction**: finite background shells now acquire their bounded process admission **before** `snapshot.withMutation(run)`, rather than wrapping the entire potentially minutes-long queue in a Snapshot mutation/read lease. Queued/unstarted jobs therefore do not preempt unrelated Snapshot captures or trigger beginning/ending invalidations. The barrier still covers the entire actually executing mutating shell process. Read-only monitor jobs remain on their separate barrier-free lane. This removes a hold-and-wait dependency between unadmitted background work and exclusive snapshot capture.
- **Queued monitor delivery cleanup:** `ShellJob` attached monitor delivery before admitting a process, but cancellation during local or machine admission never entered the spawned-process `run`. The outer `withShellJobLifecycle` now encloses the admission wrapper, settling the one-shot registered receipt to `false` when spawn was never reached, and calling `MonitorDelivery.detach` on both early cancellation and normal completion. The already-completed `true` receipt remains authoritative for an admitted short-lived process. A dedicated cancellation+short-lived lifecycle test proves one teardown per job and no false spawn claim.
- Verification: `bun test test/background/shell-job-registration.test.ts test/background/process-concurrency.test.ts test/util/machine-slot-budget.test.ts test/tool/shell-concurrency.test.ts test/background/job.test.ts` from `packages/opencode` **51 pass, 0 fail, 228 assertions**. Earlier isolated 50-monitor and two-permit background-shell runs passed. No active Sessions were restarted or cancelled.
- A separate Snapshot timeout + admission suite (`test/background/shell-job-registration.test.ts test/background/process-concurrency.test.ts test/snapshot/snapshot-capture-timeout.test.ts test/util/machine-slot-budget.test.ts`) passed **23/23, 66 assertions** after the critical-section reorder. This is a source-level regression gate; a concurrent real workspace Snapshot-vs-background-shell soak remains necessary.
- The final expanded six-file run (including lifecycle cancellation, startup failure cleanup, Snapshot capture timeout, process admission and shell-tool admission) passed **55/55 tests, 243 assertions, no failures**. The actual `ShellJob.Service.launch` execution with a real process and the full desktop/sidecar 1/5/10/25/50/100 Session load matrix are still outstanding.

### Integration interpretation

The performance model is now: O(1) machine contenders per **admitted local lane permit**, rather than O(number of pending Sessions) contenders; and O(1) producer-to-consumer registration signals per launch, rather than O(200) scheduled status poll iterations. Memory for pending Effect fibers remains O(number of waiters). Machine-level fairness across separate hosts is **not** strictly FIFO; bounded admission and aggregate forward progress are validated, but cross-host fairness/TTFT and packaged runtime soak remain unproven.

**Cross-lane reconciliation (Core indexed worker completion):** another concurrent lane has added `BackgroundJob.waitAny` in `packages/core/src/background-job.ts` and its V1 adapter in `packages/opencode/src/background/job.ts`. The V1 delegated-worker batch-waiter at `src/session/delegated-worker.ts` is moving from a one-fiber-per-worker `Effect.raceFirst` tree to a single completion `Deferred` indexed by target IDs, with generation fencing and interruptible unsubscribe. Independently reran its Core `test/background-job.test.ts`: **11/11 passed, 425 assertions**, including 100 workers, reused generation identity, and cancellation of indexed waiters. Do not duplicate these Core changes in the shell admission owner. A whole-package typecheck sampled *during* the other lane's Core/V1 edits saw temporarily mismatched `waitAny` declarations alongside unrelated repo errors; this is not reliable evidence that the finished cross-lane change remains broken. A stable, quiescent checkout typecheck remains a release gate.

Do **not** automatically raise caps based only on lower queue overhead. Adaptive resource-specific budgets (e.g. congestion-control-inspired latency feedback) should be evaluated with instrumented CPU/event-loop latency and provider/account quotas, and must retain fixed hard upper bounds and exact external-effect ownership. The OXP SQLite writer, active physical provider stream, and renderer remained under their existing distinct lane owners during this work.