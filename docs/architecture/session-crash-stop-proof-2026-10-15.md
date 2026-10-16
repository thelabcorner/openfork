# Session crash recovery, active-state proof, and Stop parity

Status: implemented core/client repair with focused receipts; live desktop build/restart and real multi-process failover remain unverified (2026-10-15). Follow root `AGENTS.md`, `docs/map/README.md`, V1/V2 architecture, swarm ownership and operator-stop contracts. Never bypass producer ownership merely to make a stopped worker look idle.

## The correctness problem

A Session is not running merely because `session_execution_owner.owner_id` is non-NULL, the OS reports a PID, the last telemetry phase is generating, a memory cache says busy, or a queued prompt was optimistically marked active. A restart, process crash, unexpected tool cancellation or backend graph retirement can preserve any of those facts after the actual worker disappears. Showing a generation spinner or a functional-looking Stop button based on stale evidence creates a *placebo active session*.

An unresolved tool might have mutated an external system even if its result was never committed. Replaying it automatically is unsafe. Durable ownership must remain fenced until a generation-exact recovery claim plus durable negative effect proof, or an explicit operator containment with unknown-effect acknowledgement.

## Normative state model and invariants

| Durable/execution evidence | UI | Admission/cancellation |
| --- | --- | --- |
| Exact process-shared active token matching owner ID and generation, or Core live-run coordinator | running | Stop targets exact generation; never replay tools |
| No exact activation but non-null owner/generation | interrupted | Preserve fence and uncertainty; operator recovery can attempt exact claim; no automatic false busy |
| Explicit durable pause | paused | Pause wins transient projection overlap; Resume performs recovery admission |
| Neither durable execution nor pause | idle | May admit new generation, only after tool-hazard inspection |
| Recovery owner claim held; tools pending/running/unknown | interrupted | Keep claim and fence; no provider/tool continuation without containment |
| Status/cache-only busy or retry | idle unless fresh proof | Evict stale client activity on authoritative repair |

Remote-process execution without process-local exact proof is deliberately **interrupted/unverified** rather than falsely claimed running by the local renderer. A future cross-process positive-proof protocol should use generation-scoped, executor-issued liveness with expiration and authorization—not merely a runtime heartbeat/PID check. This conservative behavior may produce false-negative running labels for a real remote worker, but it never releases that worker's durable fence.

## Bottom-up owning surfaces

1. **Core**: `packages/core/src/session/execution-owner.ts` projects `busy` only from exact process-local activation, otherwise `interrupted`. Projection requires one indexed owner query and O(number of owned Sessions) in-memory comparisons; no per-owner PID/snapshot probes. Raw `tryAcquireLocal` cannot release a same-process orphan and reacquire without checking effects. `SessionRecovery.recoverDeadOwnerIfQuiescent` remains the single automatic claim/negative tool-effect proof and generation-CAS release path.
2. **V1 Session control**: `packages/opencode/src/session/run-state.ts`, `operator-stop.ts`, `resume-recovery.ts` and `server/.../session-control.ts` own runtime cancellation, durable generation fence, job cancellation, swarm containment and manual unknown-effect acknowledgement. Cancellation must abort a physical provider transport before joining the runner. A rejected Stop must not advertise success.
3. **V2 server**: `packages/server/src/handlers/session.ts` and `session-activity-proof.ts` return actual Core coordinator activity and V1 exact-owner evidence. `SessionTelemetry.active` is deliberately NOT an input: non-idle telemetry can survive abandoned processing. `packages/protocol/src/groups/session.ts` includes explicit `interrupted` active-state output, distinct from `running` and `paused`.
4. **Client status**: `packages/app/src/context/session-activity-repair.ts` reconciles only from authoritative server active-state snapshots and never converts `interrupted` to idle/busy. `server-sync.tsx` coalesces SSE reconnection repair and a throttled foreground regain proof read using the same generation/stale-response fence. The legacy bridge preserves `interrupted` and never promotes it to `running`.
5. **Operator Stop entry points**: `packages/app/src/utils/session-stop.ts` is the shared client stop request owner (deduplicates same-session simultaneous clicks only). Composer Stop always calls this endpoint even after cancelling a local queued prompt; it does not erase durable TODOs or silently claim a rejected Stop. Tab action, context menu, group Stop, command palette, Undo and Revert use the same endpoint. No client control may release durable ownership directly.

   **Stop acknowledgment (follow-up)**: the shared client request rejects both thrown
   network errors and an explicit `false`/`{data:false}` response. The current/V2
   `/api/session/:sessionID/interrupt` handler now refuses NoContent success when
   the exact owner ID and generation observed before cancellation remain durably
   owned afterward. This does not claim that a stopped external tool effect was
   rolled back; nor does it revoke a different newly admitted generation.
   The V1 adapter already rejects a `false` CAS outcome, and the composer
   preserves durable TODOs instead of optimistically wiping history.
6. **Supervised children**: Ordinary sessions, subagents, delegated/swarm members and special-agent transcripts all have distinct Session IDs and participate in the same proof projection. Protected special-agent, scheduled-task, and delegated worker ownership still follows their producer-specific stop/cancel protocols; the public HTTP endpoint may reject generic mutation. This protection must NOT be bypassed for visual convenience. Group Stop is per-member, with failures surfaced; independent members are not implicitly stopped by another member's failure.

## Crash matrix

- **Provider mid-reasoning/generation**: no active token after crash → fenced/interrupted; reconnect must not resume a timer from a stale telemetry phase; Retry is not proof of execution.
- **Provider terminal step/transport hang**: SDK final `finish` and host physical EOF have separate semantics; bounded stream/flush/iterator cancellation. See `docs/perf/provider-stall-phase-verification-2026-10-15.md`.
- **Tool call executing**: pending/running durable tool overlays and indexed V1 tool parts are hazards. No auto-release, no mutation replay. Operator must establish containment, mark unknown interrupted, recheck both projections, then exact-CAS release.
- **Swarm/child process**: one generation per member. A parent crash is not proof that children have stopped or that external effects did not occur. Swarm retirement/containment contracts take precedence over generic Resume.
- **Special-agent/Goal auditor/scheduled task**: producer owns lifecycle; no generic public mutation and no fabricated Goal blocked/completed state after infrastructure failure.
- **Stop vs new generation race**: Stop targets the observed generation. An error/rejection on supersession is propagated. One UI request may not revoke a newer generation's tokens, job ownership or recovery chain.
- **Closed/offline UI/reconnect**: reconnect and foreground regain fetch the proof projection once per scope, then clear stale status/telemetry; late HTTP must not roll back fresher SSE events.

## Verification receipts

- Core Session execution-owner/recovery suite: **41 passed, 0 failed** after removing unsafe same-runtime orphan release.
- Previously failing same-runtime orphan Runner test now passes with an authentic simulated loss of the process-global exact activation marker; direct `tryAcquire` with intact activation remains protected as live.
- App `bun run typecheck` and Server and Protocol `bun run typecheck` passed in earlier scoped runs; repeat after last protocol/activity changes.
- Client Stop, interrupted status, reconnect and compatibility tests passed in focused runs; server activity proof tests **5 passed, 0 failed**.
- Last broad backend run initially reported one test failure due to an obsolete synthetic orphan assumption; retest with corrected crash model is required before declaring the entire suite clean.

### Final scoped verification update

- `packages/core` `bun run typecheck`: pass.
- `packages/server` `bun run typecheck`: pass.
- `packages/protocol` `bun run typecheck`: pass.
- `packages/app` `bun run typecheck`: pass (after interrupted-state wire/legacy bridge and swarm/context UI projection).
- Core owner + recovery regression suite: **41/41 pass**.
- V1 SessionRunState cancellation + server status projection: **19/19 pass** after a realistic crashed-activation regression.
- App Stop + status + reconnect + compatibility focused suite: **47/47 pass**.
- V2 server `session-activity-proof` tests: **5/5 pass**.
- These are focused source-level receipts; no full-tree or Windows desktop release certification is claimed.

### Generation-scoped abandoned-turn repair (continued implementation)

The original dead-owner path had two independent release mechanisms:
`SessionRecovery.recoverDeadOwnerIfQuiescent` on execution admission, and
`SessionExecutionOwner.reconcileDeadOwnersAtStartup` during background startup
maintenance. Both could release a generation after verifying no unresolved
tool-effect overlays, **without closing an unfinished reasoning/text-only
assistant**. A ghost assistant could therefore remain after ownership went
idle, depending on which code path ran first.

- `packages/core/src/session/recovery-turn.ts` is the one EventV2-backed
  transcript sealer for an **already claimed, proven-dead** execution
  generation. It uses `acquiredAt` from the durable recovery claim, indexed
  keyset pages of 32, and a safety ceiling of 512 messages per generation.
  It seals current/V2 steps with `Step.Failed` in the compact lifecycle
  sidecar (no canonical multi-MiB JSON rewrite) and V1 assistant turns with
  `MessageUpdated`. It preserves finished steps, pre-generation V1 turns,
  source text and original provenance, and is idempotent after partial repair.
  Its recovered completion timestamp is clamped to at least the durable
  acquisition and assistant creation times, avoiding an impossible negative
  duration when the system clock moves backward.
- **Order**: negative unresolved-tool-effect proof → transcript candidate
  validation (both V1 and V2) → durable failure publication → exact recovery
  claim CAS release. Opaque/unreadable V1 data, a missing acquisition clock, or
  an implausibly large candidate set returns `transcript-unverifiable`; the
  old owner remains fenced rather than silently erasing an uncertain result.
  Explicit containment also invokes the same sealer after tool-effect
  acknowledgement but before release.
- A pre-migration claim with no `acquiredAt` can still converge safely if
  **both** V1 and V2 message tables are empty. Any nonempty transcript with
  an unknown acquisition boundary remains fenced as unverifiable.
- Core local execution, the production V1 runner and Swarm retirement all
  provide the actual EventV2 publisher to the common recovery owner. No UI,
  frontend history scan or invented per-session service was added.
- **One-shot dormant Session healing**: the existing Core
  `SessionExecutionLocal` service performs a bounded, process-global
  opportunistic scan after normal startup admission (3-second deferral).
  `session/dormant-recovery.ts` selects at most 16 unverified generations
  from the existing indexed owner projection, rejects unresolved tool
  effects **before taking a recovery claim**, and delegates all mutations
  to the same canonical `SessionRecovery` claim/settlement path. It has no
  recurring timer, no separate owner, no Location/Instance hydration and no
  per-Session UI round trips. A crash-repair failure is logged/deferred
  without blocking startup. Excess candidates remain for later explicit
  admission or operator Stop.
- **Same-process concurrent recovery**: an exact recovery owner can be
  returned to multiple callers within the same runtime while its claim is
  held. A process-global (across refreshed module graphs), keyed
  `SessionRecovery.withSessionRecoveryLock` now serializes the complete
  claim → hazard proof → transcript settlement → CAS release path and
  shares that barrier with explicit containment. Different Sessions still
  recover independently; waiter entries are released after completion.
- Startup maintenance does **not** have an event publisher/claim: its old
  direct SQLite lease-reclamation shortcut may now clear a proven-dead
  generation only when **the entire Session has no V1 or current messages**,
  and no pending tool effect. `NOT EXISTS` for both message tables is
  rechecked **inside the exact-generation SQL UPDATE**, preventing a
  preflight/read-versus-release race. For any historical transcript, it
  leaves the owner fenced until the event-aware on-demand repair path is
  invoked. A message's timestamp alone is not considered positive proof that
  it belongs to an older, completed generation.
- A Swarm member's apparent runtime owner ID is not proof of executing work.
  If the member has a task lease, member-only containment returns
  `task-owned` and must leave task retirement in charge; even an apparently
  live PID must not authorize direct member containment.

Focused post-patch receipts: Core execution-owner/recovery and transcript
tests passed, including two-page V1+current keyset recovery, idempotence,
opaque-state fencing, and startup direct-release refusal. V1 SessionRunState
tests **15/15** passed and Swarm containment tests **18/18** passed after
correcting a fixture that confused a current PID label with proven execution.
Core TypeScript validation passed. These are source-level tests; the
running desktop app has not been hot-restarted or certified.

### Delayed Stop versus new background-job admission

`packages/core/src/background-job.ts` now exposes a cheap process-local
`captureSessionJobCancellationCutoff()` and permits the exact cutoff to be
passed into the existing indexed cancellation drain. The V1 Session-control
handler captures the epoch **before** awaiting SessionLimitRecovery/SQLite
owner state; a delayed HTTP Stop cannot silently sweep up process-local jobs
that were admitted after its own initial observation. Existing ordinary
runner teardown retains its original all-inflight draining semantics. The
background-job regression suite passes **13/13**, and Core typecheck passes.

The admission cutoff is **defense in depth, not a durable generation token**:
it does not prove that a late-spawned job belongs to the new execution rather
than an escaping old worker. True cross-process, generation-scoped job
cancellation still requires attaching the Session owner generation to producer
admission and job handles. Do not infer tool-effect safety from this cutoff.

Additional targeted Core runner tests confirmed partial text/reasoning/tool
input is durably failed on ordinary interruption (**6/6**). Combined owner,
transcript, and job tests **45/45** pass. OpenFork's broad typecheck still
reports unrelated failures in CLI, T3 account alias, and other older paths;
none of its printed 41 errors reference the new recovery/Stop modules.

Latest full focused crash suite after dormant self-healing and lock fixes:
`bun test test/session-execution-owner-recovery.test.ts
test/session-execution-owner.test.ts test/session-recovery.test.ts
test/session-recovery-turn.test.ts test/session-dormant-recovery.test.ts
test/background-job.test.ts`: **72 pass, 0 fail, 663 assertions**.
`bun test test/session/run-state-abort.test.ts
test/swarm/containment.test.ts` (V1): **33 pass, 0 fail**.
`packages/core` TypeScript: **pass**. These receipts cover the
actual EventV2-backed self-healing path with an in-memory SQLite fixture,
including a no-tool abandoned step, an uncertain external-tool hold,
idempotent repeat boot sweep and two concurrent recoveries. They do
not establish a live multi-process desktop crash certification.

## Known remaining gaps (do not conceal)

1. **Dormant Sessions after a crash**: the new one-time, bounded,
   EventV2-backed sweep proactively repairs up to 16 interrupted
   generations without opening tabs. Startup's lower-level, publisher-free
   housekeeping still retains nonempty histories rather than directly
   releasing them. Beyond the one-shot budget, or when death/effect/
   transcript proof is unavailable, users must use the operator recovery
   path; do not add an unbounded background polling subsystem.
2. **Cross-process liveness**: exact local process activation is positive proof. Foreign process heartbeats alone do not prove Session execution; true remote live sessions may conservatively show interrupted until authenticated remote generation proof exists.
3. **Producer-specific stop**: protected special agents, scheduled task jobs, and swarm supervisory actions require an owner-authorized control surface. Generic Session Abort must not be made to bypass that authorization. End-to-end parity needs explicit producer-owned integration tests.
4. **OS child effects**: a host process crash cannot prove a spawned external child died; unresolved tools must remain effect-unknown until bounded containment/acknowledgement.
5. **Deployed runtime**: source/type/test receipts are not proof that the running OpenFork desktop/server build has incorporated the changes. Avoid restarting live sessions without coordination. Real 1/3/6+ process-crash, WAL contention, network stall and multi-process owner tests remain required.
