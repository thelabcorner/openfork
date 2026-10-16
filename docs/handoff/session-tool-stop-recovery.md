# Tool execution settlement and Session lifecycle recovery

## Ownership path

V1 ToolPart producer (`SessionProcessor`) -> durable event transaction and
projector -> durable SessionExecutionOwner generation -> shared
SessionOperatorRecovery -> HTTP, OXP, runner Stop/Pause, and Resume entry points
-> client feedback. Swarm-owned runs additionally pass through
SwarmContainment, which settles an interrupted running task as
`contained_unknown` before releasing the Session generation.

The reverse demand path is Stop, Pause, or Resume on one Session. It checks the
durable owner generation and the process-global session/call interrupt handle.
A missing handle is not proof that the command finished. If the OS proves the
owner dead, shared recovery claims that exact generation, persists Pause, parks
Swarm task ownership if present, seals interrupted calls and abandoned assistant
messages with unknown external outcomes, then releases the generation. Resume
only clears Pause and drains after this recovery commits. Live or unproven owners
remain fenced. Recovery does not infer that external effects were undone and
does not replay an interrupted call. A Swarm run that never started is safely
superseded; a running one is parked for review.

## Invariants

- Executor admission persists a running call before invoking the tool. Native
  and MCP resource tools share one tracked cancellation/settlement boundary.
- Per-call admission, progress writes, terminal settlement, and cleanup serialize
  under one processor lock. Late provider events observe the same terminal part;
  they cannot recreate a pending call after executor settlement.
- The executor persists success/failure before releasing its interrupt handle.
  Provider result delivery is not the sole owner of durable completion.
- Turn cleanup settles tools and the assistant before snapshot enrichment.
  Snapshot cleanup has a 30-second deadline and cannot hold Stop indefinitely.
- Stop/Pause/Resume with no live tool handle reads durable state. A live owner receives an
  exact-generation durable interrupt. A proven-dead owner is recovered under an
  exact recovery claim; a recently emitted heartbeat does not delay the OS death
  check for an explicit Stop. Unknown/alive/PID-reused owners stay fenced.
- Explicit Stop/Pause/Resume recovery serializes per Session. It pauses before
  recording unfinished calls and assistant turns as interrupted with external
  effects unknown. It seals before releasing. A failed repair relinquishes a
  temporary ownerless repair reservation; runner admission independently
  rejects unresolved ownerless calls until recovery succeeds.
- Swarm run/task state is reconciled before a dead Session generation is
  released: running work becomes terminal unknown and review-pending; admitted
  work that never started is superseded. Ambiguous or mismatched leases remain
  fenced.
- Swarm ready-task selection excludes Sessions with an active or recovery
  owner. Task lease commit rechecks both fields inside its write transaction;
  the selection projection alone is not a concurrency boundary because a
  recovery claim can race between selection and claim.
- Ownership/event writes retry complete SQL-only transactions on recognized
  SQLite busy failures with a deadline. Process-local activation and runtime
  retention are outside the retryable transaction body.

## Incident evidence and verification scope

Session `ses_ef23e3d7fffe1x42Cz1qFqP51g` had a persisted running V1 bash call
`call_01a10e19cc51749cae783ca3`, execution generation 8, and a runtime owner
pointing to absent PID 189548. Operator interrupts had been recorded without a
live executor to consume them. The UI's missing-handle response incorrectly
claimed the command had already finished.

Sessions A (`ses_ef23e3d7fffe1x42Cz1qFqP51g`), B
(`ses_ef247eaafffeKDAOkYWRV90XR1`), and C
(`ses_swarm_swm_ef73fb81dffeTop92adin9a7Wi_1`) all pointed to dead runtime PID
189548 and each had an unfinished V1 bash call. C had no current Swarm task
lease, so it can use the same Session repair path without changing its completed
historical Swarm runs.

The OpenCode typecheck has unrelated pre-existing CLI, session-read, and test
fixture diagnostics. This document does not claim concurrency benchmark or
regression-suite coverage; representative 1/3/6-session and abrupt-runtime-death
checks remain needed for performance closure. The live desktop refresh must also
accept the latest bundle before these Session repairs are considered applied.
OXP runtime refresh swaps the HTTP/OXP backend module, but it does not dispose
or recreate the separately managed `AppRuntime`; its dispatcher can therefore
continue using the old `SwarmV2` implementation. Core runtime fixes are not
live until that process-owned graph is safely replaced or the sidecar restarts.

On 2026-10-05, Swarm `swr_ef73fcc92ffemcVFvY8cdoURBu` had 38 managed-worker
Sessions with dead execution generations and unresolved tool calls. Recovery
sealed those calls as unknown and released each exact Session fence. No pending
or running tool parts, incomplete assistant turns, execution owners, or task
leases remained across its 50 member Sessions. The Swarm was left paused with
18 tasks in `review_pending`; external effects were not replayed, and those
task outcomes require review before the Swarm is resumed.

The desktop process was not restarted to activate the new Core bundle: its
`AppRuntime` still owns three unrelated active Session executions. Restarting
that process would interrupt those Sessions and create new unknown effects.
The reported Swarm remains paused until a safe AppRuntime activation boundary is
available; the source fix is built and the OXP backend candidate was accepted,
but this does not prove the old dispatcher has been replaced.
