# Session/Swarm concurrency handoff protocol

**Status:** architecture-closure companion — 2026-09-18  
**Authority:** subordinate to `00-first-party-overhaul-2026-09-18.md`  
**Scope:** pending Synthetic revocation, cross-process Session execution
ownership/observation, and safe Swarm task handoff under human focus, expiry,
rebind, cancellation, or recovery.

---

## 1. Why these are one problem

Three apparently separate requirements converge on the same boundary:

```text
durable SessionInput lifecycle
        x
Session execution ownership
        x
Swarm task/run fencing
```

The safety property is:

> Once collaboration work loses authority, no future scheduler path may cause
> its **unstarted** effects to execute. Once effects have started, stale
> generations may finish bounded cleanup but can never regain domain authority,
> and replacement work must not run in parallel until the old executor reaches a
> proven quiescent boundary.

This implies three distinct operations:

1. **revoke before promotion** — work never enters conversation/execution;
2. **retire after promotion** — stop future continuation and wait for current
   Session execution to quiesce;
3. **fence after handoff** — stale domain writers cannot settle after a newer
   generation owns the task/member.

Do not call all three "cancel".

---

## 2. Pending Synthetic revocation

### 2.1 Lifecycle

Generalized SessionInput has exactly three durable states:

```text
                 promote
Admitted/Pending ---------> Promoted
      |
      | revoke
      v
   Revoked
```

There is no transition out of Promoted or Revoked.

For a row:

```text
pending   = promoted_seq IS NULL AND revoked_seq IS NULL
promoted  = promoted_seq IS NOT NULL AND revoked_seq IS NULL
revoked   = promoted_seq IS NULL AND revoked_seq IS NOT NULL
```

Add a DB CHECK that both terminal sequence columns can never be non-null.

User input is not host-revocable. The foundational revoke operation applies only
to `kind='synthetic'`.

### 2.2 Physical projection

```text
session_input
  id
  session_id
  kind                 user | synthetic
  admission_class      user | host | automatic
  user_preemptible     bool; indexed execution-policy projection
  input                tagged SessionInput.Item JSON
  delivery             steer | queue
  admitted_seq
  promoted_seq?
  revoked_seq?
  revoked_reason?      cancelled | superseded | expired | policy
  time_created
```

Recommended indexes:

```sql
-- hot pending arbitration
(session_id, admission_class, delivery, admitted_seq)
WHERE promoted_seq IS NULL AND revoked_seq IS NULL

-- exact latest human admission
(session_id, admitted_seq DESC, time_created)
WHERE kind = 'user'

-- one User event can retire every older pending input that promised to yield
(session_id, admitted_seq)
WHERE user_preemptible = 1
  AND promoted_seq IS NULL
  AND revoked_seq IS NULL

UNIQUE(session_id, admitted_seq)
UNIQUE(session_id, promoted_seq)
```

`admission_class` is execution policy, not semantic ownership:

```text
kind=user       -> admission_class=user
kind=synthetic  -> admission_class=host | automatic
```

For the initial protocol, automatic work is queue-only. It cannot invent an
urgent lane that outranks host or human work.

`user_preemptible` means exactly one thing:

> If a newer semantic User admission commits before this input is promoted,
> this pending input becomes terminally revoked in the same User transaction.

Rules:

```text
User input                         -> false
automatic Synthetic               -> true, always
host Synthetic                    -> explicit trusted producer policy
Swarm assignment/continuation     -> true while direct-human focus should win
```

Do not derive this flag from prompt text.

`revoked_seq` is intentionally **not unique**. It names the aggregate event
that caused revocation, and one User admission may causally revoke multiple
older pending user-preemptible inputs at the same sequence.

### 2.3 Events

Keep user event meanings unchanged:

```text
session.next.prompt.admitted
session.next.prompted
```

Add Synthetic lifecycle events:

```text
session.next.synthetic.admitted
session.next.synthetic.promoted
session.next.synthetic.revoked
```

The revoke event carries:

```text
sessionID
messageID / inputID
reason
timestamp
```

The input's persisted `origin` remains the producer/correlation truth; the
revocation event does not duplicate it.

### 2.4 Promote-vs-revoke race

Promotion and revocation are competing CAS transitions on the **same**
SessionInput row.

Promotion projector:

```sql
UPDATE session_input
SET promoted_seq = :seq
WHERE id = :id
  AND session_id = :session
  AND promoted_seq IS NULL
  AND revoked_seq IS NULL
RETURNING ...
```

Revocation projector:

```sql
UPDATE session_input
SET revoked_seq = :seq,
    revoked_reason = :reason
WHERE id = :id
  AND session_id = :session
  AND kind = 'synthetic'
  AND promoted_seq IS NULL
  AND revoked_seq IS NULL
RETURNING ...
```

Both projectors execute inside the Session aggregate's EventV2 durable
transaction. Therefore exactly one transition wins.

If a stale promotion selected the row before revocation committed, its projector
must observe the CAS miss and classify the row as already revoked. It skips that
row without killing the whole Session drain.

If promotion wins first, revoke returns `tooLate: "promoted"`; callers move to
the retirement protocol below.

Never append a durable "revoked" event whose projector did not actually win the
CAS. An invalid transition aborts the EventV2 transaction.

The runner must also distinguish **selection count** from **committed promotion
count**. Current SessionInput returns the number of rows selected for
publication. That becomes incorrect once a selected row may legitimately lose
the projector CAS to revocation.

Target promotion result:

```ts
type PromoteResult = {
  selected: number
  promoted: number
  staleRevoked: number
}
```

Only `promoted` may:

- reset provider-step state;
- count as runnable work;
- cause the runner to enter a provider cycle.

A stale selected row whose durable state is already revoked is a normal
zero-promotion outcome, not a fatal Session error and not a fake success.

### 2.5 Idempotent API result

Conceptually:

```ts
type RevokeResult =
  | { state: "revoked"; revokedSeq: number; reason: RevocationReason }
  | { state: "already-revoked"; revokedSeq: number; reason: RevocationReason }
  | { state: "too-late"; promotedSeq: number }
  | { state: "not-found" }
  | { state: "not-revocable" } // User input
```

First terminal writer wins. A retry with a different reason does not rewrite
history.

### 2.6 User supersession is one aggregate transaction

`automatic` always yields to newer User admission. Some host work, notably
pending Swarm member work, must make the same promise. Encode that property in
SessionInput itself rather than asking Goal, Swarm, or another producer to race
a second cancellation transaction.

When a User admission commits at aggregate sequence `U`, its projector also
updates every older pending user-preemptible input for that Session:

```sql
UPDATE session_input
SET revoked_seq = :U,
    revoked_reason = 'user_superseded'
WHERE session_id = :session
  AND user_preemptible = 1
  AND promoted_seq IS NULL
  AND revoked_seq IS NULL
  AND admitted_seq < :U
```

This update is inside the same EventV2 transaction as the User admission.

Therefore there are only two legal orderings:

```text
automatic promotion commits first
  -> it is historical/running work
  -> later User is pending and wins the next safe cycle

User admission commits first
  -> pending user-preemptible input is revoked at User seq U
  -> later promotion CAS cannot succeed
```

No cross-service notification is part of the safety proof.

An explicit `session.next.synthetic.revoked` event is still used for
producer/operator/domain revocation that is not already represented by another
causal Session event. User supersession does not need N synthetic revoke events:
the one durable User admission is the cause, and replay runs the same projector.

### 2.7 What revocation guarantees

A revoked Synthetic input:

- is never promoted;
- never materializes a `SessionMessage.Synthetic`;
- never enters provider context;
- never wakes a provider cycle;
- remains durable/auditable as an admitted-but-revoked input.

Revocation is therefore stronger and cheaper than compensating prompt text.

### 2.8 Measured hot-path cost

Phase-0 Bun/SQLite prototype with **1,000,000** mixed input rows:

```text
pending lookup (bounded 64)
  median ~9.8 us
  p95    ~19.4 us

revoke CAS by input PK
  median ~3.3 us
  p95    ~4.3 us
```

The pending query used the partial pending index; revoke used the input PK.

A second Phase-0 prototype used the normalized automatic class over
**1,000,000** mixed input rows:

```text
revoke pending automatic inputs for one Session
  median ~3.2 us
  p95    ~4.1 us
```

The update used the partial pending index. The ordering prototype also proved:

```text
automatic-first -> automatic promoted, later User remains pending
User-first      -> automatic revoked, later promotion returns no row
```

After generalizing the same mechanism to indexed `user_preemptible` host +
automatic work over **1,000,000** rows:

```text
revoke older pending user-preemptible inputs for one Session
  median ~2.4 us
  p95    ~3.0 us
```

The query plan used only the partial
`(session_id, admitted_seq) WHERE user_preemptible=1 AND pending` index.

---

## 3. Session execution ownership needs a durable cross-process fence

### 3.1 Current split

Today:

- V1 uses filesystem `Flock("session-run:<id>")` for cross-process exclusion;
- current/V2 `SessionRunCoordinator` serializes only inside one process;
- V1 status/EventV2 live wakes are process-local;
- SessionTelemetry intentionally persists settled metrics, not live ownership.

Swarm makes this split observable and therefore no longer acceptable as the
long-term truth.

### 3.2 Shared process incarnation + Session owner projection

A third domain-local process token beside ScheduledTask and Goal would reproduce
the same liveness problem under a different prefix. Standardize process
incarnation identity first:

```text
runtime_owner
  id                     PRIMARY KEY; random process-incarnation identity
  pid                    local liveness/diagnostic hint
  started_at
  heartbeat_at           process-liveness signal only
  control_epoch          monotonic interrupt/nudge generation

session_execution_owner
  session_id             PRIMARY KEY / FK -> session
  generation             monotonic; increment on every successful acquisition
  owner_id?              FK -> runtime_owner.id
  acquired_at?
  interrupt_generation?
  interrupt_reason?
  interrupt_requested_at?
  recovery_owner_id?     FK -> runtime_owner.id
  recovery_started_at?
```

An idle Session retains the row/generation but clears owner/timestamps.

Do **not** persist provider phase, current tool, model, or Swarm/task identity in
this table. Those facts have other owners.

The shared runtime owner is identity/liveness infrastructure, **not** a generic
lease policy. ScheduledTask, Goal, Session, and future remote workers may reuse
the same process incarnation identity while retaining their own domain-specific
claim/retry semantics.

This also removes duplicated module-local process identities already visible in
current Core:

- ScheduledTask has `scheduled-owner:<pid>:<uuid>`;
- Goal automation has `goal-owner:<pid>:<uuid>`;
- Session execution would otherwise introduce a third token.

Converge the identity/liveness primitive, not the domain lease tables.

Do not add a hostname/node abstraction before remote placement exists. The
initial supported truth is one local SQLite realm with multiple local OpenCode
processes. Future placement may extend RuntimeOwner with a node/placement
identity without changing Session ownership semantics.

### 3.3 Semantics

```text
owner_id = NULL
  -> execution ownership is available

owner_id != NULL
  -> exactly that owner/generation may drive the Session

runtime_owner heartbeat old
  -> SUSPECT, not FREE
```

The last rule is critical. This object is deliberately called an **owner**, not
a lease: elapsed time can make ownership suspect, but time alone cannot transfer
execution authority.

Heartbeat staleness is a liveness observation, not a proof that arbitrary external
effects from the old executor cannot resume.

### 3.4 Acquire

Acquisition is one SQLite CAS transaction:

```text
new Session row:
  insert generation=1 + owner

existing idle row:
  generation = generation + 1
  set owner/acquired

existing owned row:
  no claim
```

The returned token is:

```ts
type SessionExecutionToken = {
  sessionID: SessionID
  generation: number
  ownerID: string
}
```

Every Session ownership release requires the exact owner + generation.

### 3.5 One process-global heartbeat, not N timers

Do not create one heartbeat fiber or heartbeat write per active Session.

One process-global RuntimeOwner service owns the process-incarnation heartbeat.
It is active only while the process owns durable runtime work; zero owned work
means zero heartbeat timer.

```sql
UPDATE runtime_owner
SET heartbeat_at = :now
WHERE id = :thisProcessOwner
```

Session execution rows then need no `heartbeat_at` column and observation is one
PK join.

Phase-0 prototype with 10k Session ownership rows and one process owner:

```text
inspect Session owner + runtime liveness join
  median ~1.0 us
  p95    ~1.9 us

one process heartbeat
  median ~1.6 us
  p95    ~1.9 us

claim + release pair
  median ~9.8 us
  p95    ~17.7 us
```

These are mechanism microbenchmarks, not disk-latency promises, but they show
the normalized heartbeat cost is O(active processes), not O(active Sessions) or
O(all Sessions).

### 3.6 Heartbeat expiry must not steal correctness

Do not implement:

```text
heartbeat older than TTL
  -> set owner=NULL
  -> run replacement immediately
```

That is unsafe for an executor paused longer than the TTL.

Instead:

```text
fresh heartbeat
  -> active

stale heartbeat
  -> suspect

confirmed owner death + owned-resource cleanup
  -> recover/release exact observed owner+generation

explicit cancellation barrier completed
  -> release exact owner+generation
```

For the initial local-host implementation, RuntimeOwner liveness may
conservatively prove **dead** from the stored local PID. A PID that appears alive is
`alive-or-unknown`, never proof that a stale owner can be stolen; PID reuse
therefore causes conservative blocking rather than unsafe takeover.

Future remote placement replaces this liveness adapter without changing the
Session ownership contract.

### 3.7 Why this is not the ScheduledTask lease

The mechanics are similar enough to share test helpers/CAS idioms, but the
failure semantics differ:

- ScheduledTask execution may use timeout-based retry policy;
- arbitrary Session execution can own shell/filesystem/remote side effects and
  therefore must not be concurrently stolen solely by clock expiry.

Do not force both through one generic lease table or one reclaim policy.

### 3.8 Exact RuntimeOwner lifecycle

RuntimeOwner should be a small global Core service, not another feature-local
module constant.

OpenFork already has the correct construction mechanism: Core global nodes are
built through the shared process-level Effect `memoMap` used by AppRuntime,
HTTP routes, BootstrapRuntime, and `makeRuntime`. Implement RuntimeOwner and
SessionExecutionOwner as `makeGlobalNode` services and prove service identity
across the V1/current/server runtime graphs. Do not introduce a parallel
module-global timer/refcount registry unless that identity test disproves the
existing memoization contract.

Conceptually:

```ts
type RuntimeOwnerID = string

interface RuntimeOwner {
  readonly id: RuntimeOwnerID

  // Keeps the process-liveness heartbeat active while a strong owner depends on
  // it. First retain starts the one process timer; final release stops it.
  retain(): Effect.Scope

  snapshot(id: RuntimeOwnerID): Effect<RuntimeOwnerSnapshot | undefined>

  // Local proof only. "alive-or-unknown" is deliberately conservative.
  proveLocalDeath(
    id: RuntimeOwnerID,
  ): Effect<"dead" | "alive-or-unknown" | "not-local-or-unknown">
}
```

Lifecycle:

```text
first strong ownership in process
  -> ensure runtime_owner row
  -> retain count 0 -> 1
  -> start one heartbeat fiber

additional strong ownership
  -> increment local retain count only

last strong ownership released
  -> retain count 1 -> 0
  -> stop heartbeat fiber

clean process shutdown
  -> release owned domain resources first
  -> delete/prune runtime_owner row only when unreferenced

hard crash
  -> row remains as recovery evidence
```

ScheduledTask may reuse `RuntimeOwner.id` as its owner identity while retaining
its existing **per-run lease heartbeat**. It does not become a Session-style
non-expiring owner merely because identity is shared.

### 3.9 Exact SessionExecutionOwner API

Conceptually:

```ts
type SessionExecutionToken = {
  sessionID: SessionID
  ownerID: RuntimeOwnerID
  generation: number
}

interface SessionExecutionOwner {
  tryAcquire(sessionID: SessionID):
    Effect<{ state: "acquired"; token: SessionExecutionToken } |
           { state: "busy"; snapshot: SessionExecutionSnapshot }>

  releaseIfDrained(token: SessionExecutionToken):
    Effect<"released" | "continue">

  snapshot(sessionID: SessionID):
    Effect<SessionExecutionSnapshot>

  requestInterrupt(sessionID: SessionID, reason: InterruptReason):
    Effect<{ state: "requested"; token: SessionExecutionToken } |
           { state: "idle" }>
}
```

The durable owner row is only the cross-process arbiter. One process still needs
one **local activation registry** keyed by Session ID so two callers inside the
same process cannot both create execution stacks merely because they share the
same `RuntimeOwner.id`.

That activation registry belongs inside the same process-global
`SessionExecutionOwner` service. V1/current callers must not each keep an
independent authoritative map after cutover.

Therefore:

```text
process-local activation registry
  -> joins/coalesces same-process wake/run/interrupt

session_execution_owner
  -> rejects every second cross-process activation
```

V1's private `Flock("session-run:<id>")` and current/V2's process-local
`SessionRunCoordinator` converge beneath this shared activation boundary.

---

## 4. Cross-process lost-wakeup closure

Durable SessionInput removes the need for process-to-process wake delivery **if
execution release is conditional on the durable queue being empty**.

### 4.1 Owner-release protocol

The Session execution owner finishes its local drain, then performs:

```text
TX:
  revalidate owner_id + generation

  if eligible durable Session work exists:
    KEEP ownership
    return "continue"

  else:
    clear owner_id/acquired_at
    return "released"
COMMIT
```

The owner loops again on `continue`.

The **target** release predicate is intentionally domain-agnostic:

```text
eligible pending SessionInput exists?
```

Goal automatic continuation must migrate into SessionInput rather than forcing
generic Session ownership to query Goal tables. During migration only, the
compatibility bridge may additionally recognize legacy Goal reservation rows.
That bridge is removed after legacy rows are reconciled.

### 4.2 Race proof

Case A:

```text
Process B admits input
Process A tries release

release TX sees pending input
-> A keeps ownership and drains it
```

Case B:

```text
Process A releases
Process B admits input

B's wake/acquire sees owner=NULL
-> B acquires next generation and drains it
```

There is no ordering in which input commits and every executor goes idle while
believing somebody else owns the work.

A Phase-0 two-order SQLite prototype reproduced both outcomes:

```text
admit-before-release -> release refused; owner A retained
release-before-admit -> release succeeded; owner B acquired generation+1
```

### 4.3 Process-local wake is only a latency optimization

EventV2 local listeners and `SessionRunCoordinator.wake()` remain useful.

But correctness no longer depends on a live wake crossing process boundaries.

This distinction is important:

```text
durable DB state      = correctness
local EventV2 wake    = latency
adaptive observation  = cross-process waiting
```

### 4.4 Goal automatic continuation becomes mailbox work

The previous architecture treated Goal automatic continuation as a fifth
execution source outside SessionInput:

```text
user steer > user queue > synthetic steer > synthetic queue > Goal automatic
```

That ordering was directionally right but the ownership boundary was wrong.

The normalized target is:

```text
SessionInput semantic kind:
  User
  Synthetic

SessionInput admission class:
  user
  host
  automatic

fixed arbitration:
  user/steer
  user/queue
  host/steer
  host/queue
  automatic/queue
```

Goal continuation is:

```text
kind = synthetic
admission_class = automatic
delivery = queue
origin = goal.continuation
ref = <goal continuation correlation id>
```

This preserves the provider-cycle source:

```text
user | host | automatic
```

without creating a second runnable-work queue.

Consequences:

- `GoalAutomation.reservation_owner` is no longer needed for worker
  continuation execution;
- Goal no longer needs `claim()/release()/pendingSessions()` as a process
  ownership protocol;
- generic Session release no longer imports Goal state;
- pending automatic Goal work gets the same revocation, replay, pause, and
  cross-process handoff semantics as every other SessionInput;
- the Goal domain still owns continuation policy, budgets, auditor verdict,
  causal source, and the correlation between Goal state and the admitted input.

GoalAutomation may retain a durable `continuation_input_id` / correlation ID,
but that is **domain correlation**, not execution ownership.

### 4.5 Automatic continuation admission fence

An automatic chain must not manufacture a new autonomous turn after a User
arrived during the cycle that just finished.

The runner captures the latest semantic User admission sequence at the beginning
of an automatic cycle. When Goal wants to admit the next automatic input, it
passes that value as an optimistic fence:

```text
expectedLatestUserSeq = U
```

The SessionInput admission transaction verifies the latest User sequence is
still `U`.

```text
unchanged
  -> admit next automatic Synthetic input

newer User exists
  -> no automatic admission
  -> automation chain is superseded
```

This handles the race in both directions:

```text
automatic admission commits first
  -> later User atomically revokes it while still pending

User commits first
  -> expectedLatestUserSeq CAS rejects the automatic admission
```

No text inspection, process-local cancellation map, or Goal process owner is
required.

### 4.6 Goal worker migration

Target GoalAutomation operational state:

```text
goal_automation
  session_id
  goal_id
  budgets / counters / auditor state
  continuation_id?
  continuation_input_id?
  continuation_source_message_id?
  ...

  -- legacy migration-only:
  reservation_id?
  reservation_owner?
  reservation_created_at?
```

Migration rules are fail-closed:

1. new code never writes a new `reservation_owner`;
2. an unowned legacy pending reservation may be converted idempotently into one
   automatic SessionInput;
3. a legacy row with a non-null foreign owner is **not** cleared merely because
   another process started;
4. if the legacy PID/process can be proven dead, reconcile the corresponding
   turn first; do not blindly auto-replay a potentially started cycle;
5. retain the legacy columns through a compatibility window, then drop them only
   after no supported runtime writes them.

The existing deterministic Goal continuation correlation/message identities are
still useful for migration and idempotency; what disappears is their use as a
process lease.

### 4.7 Goal Auditor owns the auditor child Session

The independent Goal Auditor is intentionally different from a worker
continuation.

Today it runs provider/tool work directly against a stable host-owned auditor
child Session. Therefore removing the parent Goal `reservation_owner` must not
remove mutual exclusion for the auditor transcript.

The correct owner is the **auditor child Session itself**:

```text
parent worker Session
  -> Goal state / audit request

auditor child Session
  -> SessionExecutionOwner token
  -> direct auditor provider/tool execution
```

Recommended handoff:

```text
acquire auditor child Session execution generation G
  -> GoalAutomation.beginAudit CAS
       writes audit_id
       auditor_session_id
       auditor_execution_generation = G
  -> run bounded auditor
  -> settle transcript/tools
  -> GoalAutomation.endAudit(audit_id, G) CAS
  -> release auditor child Session execution owner
```

Add an `audit_id` (attempt/correlation ID) and snapshot the auditor execution
generation. A stale auditor's finalizer must not clear or overwrite a newer
audit merely because both use the same stable child Session ID.

Startup must therefore stop doing:

```text
backend constructed
  -> clear every auditing_at / auditor_session_id marker
```

Instead:

- live child Session owner -> audit is still active elsewhere;
- stale heartbeat -> audit is suspect, not free;
- proven-dead child owner -> run the same Session recovery barrier;
- only the exact `audit_id + auditor_execution_generation` may settle the Goal
  audit state.

The parent worker Session does not need to be held merely because the independent
auditor is executing. The Goal domain coordinates whether worker continuation is
eligible; the auditor child Session owns only its own execution/transcript.

---

## 5. Shared Session wait/observation

### 5.1 API

Conceptually:

```ts
type SessionWaitCondition =
  | { type: "execution-idle" }
  | { type: "input-terminal"; inputID: SessionMessage.ID }
  | { type: "next-assistant"; afterSeq: number }
  | { type: "drained" }

type SessionExecutionSnapshot =
  | { state: "idle"; generation: number }
  | {
      state: "active"
      generation: number
      ownerID: string
      heartbeatAt: number
    }
  | {
      state: "suspect"
      generation: number
      ownerID: string
      heartbeatAt: number
    }
```

`drained` is stronger than `execution-idle`: no execution owner and no
eligible pending durable Session work.

### 5.2 Lost-wakeup-safe local wait

For same-process events:

```text
read condition
subscribe exact/narrow local event
read condition again
wait for event or cross-process probe deadline
```

This closes check-before-subscribe races.

### 5.3 Cross-process fallback

EventV2's live PubSub is intentionally process-local. Do not pretend otherwise.

While an explicit waiter exists:

- use local events for immediate wakeups;
- recheck the compact durable condition on an adaptive schedule;
- stop all timers/subscriptions immediately when the waiter resolves/aborts.

There is no always-on polling loop and no per-Session idle timer.

The fallback can start aggressively for interactive waits and back off to a
small bounded ceiling. Exact values are implementation/benchmark decisions, not
domain semantics.

### 5.4 Suspect owner

A stale heartbeat does **not** satisfy `execution-idle`.

Wait returns/continues with `suspect` observability until:

- the owner releases;
- recovery proves the owner dead and clears the exact generation;
- the caller times out/aborts.

### 5.5 Migration targets

- replace `session.messages(wait:true)` 200 ms SessionStatus polling;
- keep BackgroundJob attachment semantics for TaskTool, but use common Session
  observation wherever the Task adapter needs target-Session truth;
- Swarm handoff uses `execution-idle/drained` as the retirement barrier;
- future scheduled/recovery producers reuse the same waiter rather than adding
  feature-specific polling.

### 5.6 Interrupt request is not ownership transfer

Operator Stop, Swarm retirement, and other control paths should be able to
accelerate a remote/local-owner teardown without acquiring that Session.

Persist the request against the **currently observed execution generation**:

```text
session_execution_owner
  interrupt_generation?
  interrupt_reason?
  interrupt_requested_at?
```

Request transaction:

```text
UPDATE session_execution_owner
SET interrupt_generation = generation,
    interrupt_reason = :reason,
    interrupt_requested_at = :now
WHERE session_id = :session
  AND owner_id IS NOT NULL
  AND interrupt_generation IS NULL
RETURNING owner_id, generation

if a row returned:
  UPDATE runtime_owner
  SET control_epoch = control_epoch + 1
  WHERE id = :owner
```

The request does **not** clear `owner_id`.

The owner observes requests through one process-level control path:

1. same-process caller: signal the local activation immediately;
2. cross-process best-effort nudge may use the existing verified loopback
   instance/service-discovery path;
3. durable fallback: the RuntimeOwner heartbeat/control probe returns
   `control_epoch`; a changed epoch causes one indexed scan for interrupt rows
   owned by this process.

Correctness depends only on the durable row. The local/loopback paths reduce
latency.

The generation fence closes the release race:

```text
interrupt request commits first
  -> bound to generation G
  -> owner G interrupts and finalizes
  -> exact release clears request

release commits first
  -> interrupt CAS sees owner=NULL
  -> request is not recorded
  -> future generation G+1 cannot inherit it
```

Phase-0 prototype with 10k owned Session rows:

```text
interrupt request + clear
  median ~8.5 us
  p95    ~14.1 us
```

The owner's interrupt scan used a partial
`(owner_id, interrupt_generation)` index.

Most importantly:

> **Interrupt is acceleration, never authority transfer.**

Swarm/operator/domain state first requests retirement/revocation. Interrupt may
help the current owner reach quiescence sooner. Reassignment still waits for the
normal retirement/recovery barrier.

---

## 6. Swarm task retirement is the universal handoff protocol

Human focus is one reason to retire a task run, not a unique state machine.

Retirement reasons include:

```text
human_focus
lease_owner_lost
member_rebind
operator_release
member_stop
swarm_freeze
recovery
```

### 6.1 Lease state

Extend the Swarm task lease with policy state:

```text
swarm_task_lease
  ...
  state                    active | human_hold | retiring
  hold_user_seq?
  hold_started_at?
  hold_deadline?
  retire_reason?
  retire_requested_at?
```

These fields do not duplicate Session activity:

- SessionInput owns the fact that User seq N arrived at time T;
- the task lease owns the decision to preserve/retire task ownership because of
  that fact.

Task `status` remains `working` while a safety-fence lease exists. UI can
render `human_hold` / `retiring` as a relationship overlay.

### 6.2 Human focus detection

For an active run, human focus is exact when:

```text
latest User admitted_seq > assignment/continuation input admitted_seq
```

and policy says the interaction is still within its lull/focus window.

No message text, role heuristic, or `humanChatAt` mirror participates.

### 6.3 New Synthetic admission fence

Any Swarm Synthetic delivery that policy says must yield to fresh human input
uses an optimistic Session fence:

1. read latest User `admitted_seq = U`;
2. decide policy;
3. attempt Synthetic admission with `expectedLatestUserSeq=U`;
4. inside the Session EventV2 transaction, verify latest User seq is still U;
5. mismatch -> abort admission, leave domain delivery/run pending.

If Synthetic commits first and the human arrives afterward, the already-started
cycle keeps its original source; User wins the next safe cycle. This preserves
the homogeneous-cycle rule.

### 6.4 Human focus state machine

```text
ACTIVE TASK
    |
    | User input after task input
    v
HUMAN_HOLD
    | \
    |  \ focus clears before deadline
    |   -> same owner/generation may resume
    |
    | hold deadline reached / explicit release
    v
RETIRING
    |
    | suppress all new task continuations
    | revoke any still-pending task Synthetic input
    | wait for Session execution quiescence
    v
SUPERSEDE OLD RUN + RELEASE LEASE
    |
    +-> requeue / block according to Swarm policy
```

The hold deadline begins **retirement**. It does not authorize unsafe parallel
execution.

### 6.5 Pending assignment branch

If the task run is still `admitted` and its SessionInput has not promoted:

- Swarm assignment/continuation inputs that yield to direct human focus are
  admitted with `user_preemptible=true`;
- the User-admission transaction revokes the still-pending input immediately;
- **do not** leave a logically-held host input pending in the generic Session
  queue — after the User cycle, generic arbitration would otherwise execute it;
- keep the task lease in `human_hold`; revoking the input does not release task
  ownership;
- if focus clears before the bounded hold deadline, admit a fresh task-run/input
  correlation for the same task owner/generation. This is an admission attempt,
  not a semantic task retry;
- if retirement wins instead, settle the unstarted run `superseded` and follow
  the ordinary release path;
- if promotion beat User admission, the input is historical/running and the
  running branch below applies.

This deliberately trades a tiny re-admission for a much stronger invariant:

> Every row that remains SessionInput-pending is actually eligible under generic
> Session policy; no hidden Swarm-only hold state is required inside the runner.

### 6.6 Running assignment branch

Once the assignment/continuation is promoted:

- it is durable conversation history;
- do not delete or relabel it;
- mark the task lease `retiring`;
- no new `swarm.continuation` may be admitted for that run;
- wait for the Session execution owner to release at its quiescent boundary;
- only then supersede the old run / release / increment task generation.

A later Session turn may still contain the old assignment in history. That is
audit/context, not current task authority. Swarm task tools validate the current
member/binding/task generation, and autonomous Swarm machinery never wakes the
superseded run again.

### 6.7 Why the retiring lease continues renewing

While `retiring`, the lease is no longer permission to start more work. It is a
**safety fence** preventing another member from receiving the same task until the
old executor is quiescent.

Therefore it may continue to renew beyond the human-focus deadline.

This is not an unbounded "work hold"; it is an explicit blocked retirement
condition. Surface it as such.

### 6.8 All handoffs use this protocol

Do not let ordinary lease expiry bypass retirement.

```text
expired scheduler claim
  -> request retirement
  -> suppress continuation
  -> revoke pending input OR wait active execution quiescence
  -> supersede/release old generation
  -> only then make task claimable again
```

The same applies to member rebind/self-heal.

The existing pair:

```text
(binding_generation, task_lease_generation)
```

still rejects stale domain settlement. Retirement additionally prevents two
authorized generations from performing the same autonomous effects
concurrently.

---

## 7. Quiescence is stronger than "model stopped streaming"

The retirement barrier must include:

- provider stream ended/interrupted;
- synchronous tool fibers settled or were cancelled and finalized;
- Session-owned non-detached subprocess/resource finalizers completed;
- no queued continuation for the retiring task remains eligible;
- Session execution ownership is released conditionally on durable work.

If a tool intentionally creates an independently detached durable job/process,
that object needs its own ownership/settlement semantics. It cannot be silently
treated as quiescent merely because the parent assistant step ended.

This is a general harness rule, not Swarm-specific.

### 7.1 Separate executor quiescence from effect certainty

Two questions must never be collapsed:

```text
Q1: Can the old OpenCode executor resume issuing new effects?
Q2: Do we know whether every effect it already initiated happened?
```

A proven-dead process can answer **Q1=yes, it cannot resume** while leaving
**Q2=unknown**.

For example, the process may die after sending an HTTP mutation but before
recording its response. No local fencing generation can make the remote service
un-send that request.

Default recovery taxonomy:

```text
settled
  observed durable success/failure

interrupted_known_no_effect
  execution was cancelled before the effect boundary was crossed

interrupted_effect_unknown
  effect may have happened; do not replay automatically

detached_durable
  effect intentionally transferred to another durable owner
```

The safe default for an interrupted mutating tool is
`interrupted_effect_unknown`.

OpenFork already has the beginnings of the correct behavior:

- current/V2 recovery marks persisted pending/running tool calls failed as
  interrupted rather than replaying them;
- V1 cleanup stamps unfinished tool parts as interrupted/error;
- provider history lowers those interrupted calls to tool errors so the
  transcript remains structurally valid.

Preserve that non-replay invariant.

Future tool metadata may classify operations as read-only/idempotent and enable
smarter recovery, but correctness must not require every tool author to classify
effects perfectly.

### 7.2 Foreground child-process containment is an execution invariant

Cooperative Effect finalizers are necessary but insufficient: a hard process
death never runs JavaScript finalizers.

Therefore a foreground/session-scoped subprocess must either:

1. be protected by an OS/process guardian that proves it dies with the owning
   runtime; or
2. remain an unresolved recovery hazard that blocks automatic Session takeover.

Platform evidence:

- Windows Job Objects provide process-tree ownership and
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
- Linux `PR_SET_PDEATHSIG` can signal a direct child when its creating parent
  thread dies, but its documented thread/credential/fork caveats make it
  insufficient as the only arbitrary-process-tree primitive;
- process groups remain valuable for cooperative teardown, but are not by
  themselves proof that a hard-dead parent left no descendants.

A Phase-0 Win32 hard-kill micro-prototype confirmed the distinction:

```text
non-detached child
  parent hard-killed -> child absent in this environment

detached child
  parent hard-killed -> child remained alive
```

The second result is the important one: hard-death cleanup cannot be inferred
from parent PID death.

Preferred architecture is one lower-level `ProcessContainment` primitive in
the shared spawner, not feature-specific cleanup:

```text
foreground Session-owned process
  -> containment-bound

explicit BackgroundJob / durable detached process
  -> ownership transfer
  -> excluded from parent Session containment
```

Windows should investigate Job Objects first. Linux/macOS need an equally
testable containment/guardian strategy before automatic dead-owner takeover is
enabled there.

This is exactly the same ownership distinction already present conceptually in
V1: stopping a parent Session cancels its owned foreground work but intentionally
does not kill independent detached child work.

---

## 8. Crash/recovery semantics

### 8.1 Session executor crash

```text
heartbeat becomes stale
  -> execution state = suspect
  -> do NOT auto-start competing execution

recovery proves owner dead
  -> CAS claim recovery of exact owner+generation
  -> reconcile owned resources
  -> seal unfinished tool outcomes as interrupted/uncertain
  -> CAS clear exact owner+generation only after containment proof
  -> pending durable input remains
  -> next wake acquires generation+1
```

Recovery itself needs one owner. Use the existing row:

```text
session_execution_owner
  owner_id               old/dead execution owner
  generation             G
  recovery_owner_id?     process performing reconciliation
  recovery_started_at?
```

`recovery_owner_id` is acquired only when the observed RuntimeOwner is proven
dead and the `session_id + owner_id + generation` tuple still matches.

While recovery is active:

- the old owner remains recorded for evidence;
- no normal executor may acquire the Session;
- another recovery process cannot perform the same cleanup concurrently.

Successful reconciliation atomically clears both owner and recovery fields.

If foreground resource containment cannot be proven, recovery remains visibly
blocked instead of manufacturing an idle Session. An explicit operator
"acknowledge unknown external effects and release" can be designed later as a
separate high-consequence action; it is not automatic recovery.

### 8.2 Swarm lease owner crash

The Swarm scheduler/process lease and member Session execution ownership are
different facts.

Losing the scheduler owner does not prove the member Session stopped executing.

Recovery therefore:

1. observes the active task/member/run;
2. enters retirement/recovery state;
3. checks pending input revocation or Session execution quiescence;
4. only then increments/reassigns task ownership.

### 8.3 Process timeout is not a fencing token

Monotonic task/binding/session generations protect OpenFork-owned mutations.
They cannot force arbitrary external systems to reject effects from a paused
process.

That is why timeout alone never authorizes overlapping Session execution.

### 8.4 Hard crash is not permission to replay a tool

After dead-owner recovery, transcript repair and execution scheduling are
separate decisions.

```text
dead owner
  -> prove local execution can no longer continue
  -> settle dangling tool representation as interrupted_effect_unknown
  -> release Session execution owner

next Session cycle
  -> sees durable interrupted result
  -> does NOT silently invoke that tool again
```

A domain may later choose a semantic retry only when its own idempotency contract
makes that safe. Swarm task retry, ScheduledTask retry, and provider retry are
therefore independent policies, not consequences of Session recovery.

---

## 9. Model/UI behavior

Human-facing Session remains unchanged:

- user can type normally;
- User input has semantic User provenance;
- task ownership is retained/retired by backend policy;
- no takeover mode.

Relationship UI can derive:

```text
working
chatting / task held
retiring / waiting for safe boundary
suspect execution owner
idle
```

from Session admission + execution ownership + Swarm lease/read models.

Do not infer these states from transcript text.

---

## 10. Negative invariants

Production implementation is not accepted until tests prove:

1. revoked Synthetic input never becomes a Session message;
2. promotion-vs-revoke race has exactly one winner;
3. a revoke losing to promotion returns `too-late`, not false success;
4. a cross-process admission racing owner release cannot strand durable work;
5. only one Session execution generation owns a Session at a time;
6. heartbeat timeout alone never authorizes a second executor;
7. a human input arriving during Swarm work prevents new Swarm continuation at
   the next boundary;
8. human-focus deadline never causes parallel reassignment before quiescence;
9. task lease expiry uses the same retirement barrier;
10. member rebind uses the same retirement barrier;
11. stale binding/task generations cannot settle;
12. explicit wait creates no permanent timer/listener after completion/abort;
13. idle OpenCode has zero Session-execution heartbeat timer activity;
14. N active Sessions in one process use one heartbeat owner, not N timers;
15. Session list/sidebar reads never bootstrap execution merely to render these
    states;
16. one User admission can revoke every older pending `user_preemptible` input
    transactionally without emitting N synthetic revoke events;
17. automatic-first vs User-first races converge to exactly the two legal
    histories described in §2.6;
18. Goal worker continuation has no process-local/domain-local execution owner
    after SessionInput cutover;
19. a foreign live legacy Goal reservation is never cleared merely because a
    second OpenCode process starts;
20. Goal Auditor execution owns the auditor child Session and stale audit
    finalization cannot clear a newer `audit_id` / execution generation;
21. an interrupt request is fenced to the observed Session execution generation
    and never transfers ownership;
22. release-before-interrupt cannot leak the interrupt into the next generation;
23. dead-owner recovery has exactly one recovery owner;
24. dead process detection alone cannot release a Session when foreground
    subprocess containment is unproven;
25. interrupted mutating tool calls are never silently auto-replayed;
26. explicitly detached durable jobs are not killed merely because their parent
    Session reaches quiescence.

---

## 11. Implementation order

### A. SessionInput lifecycle

1. tagged User/Synthetic item;
2. `kind` + `admission_class` + `user_preemptible` projection;
3. `revoked_seq/reason`;
4. Synthetic admitted/promoted/revoked events;
5. CAS promotion/revocation;
6. transactional User -> pending-user-preemptible supersession;
7. automatic `expectedLatestUserSeq` admission fence;
8. pending + latest-User indexes;
9. replay/property tests.

### B. Runtime/process identity

1. `runtime_owner` schema/service;
2. one random process-incarnation ID;
3. scoped retain count;
4. one heartbeat/control fiber only while strong ownership exists;
5. local `dead | alive-or-unknown` proof adapter;
6. ScheduledTask reuses the identity when convenient but keeps its domain lease
   heartbeat/retry semantics.

### C. Session execution ownership

1. `session_execution_owner` schema/service;
2. process-local activation registry;
3. atomic acquire/release exact generation;
4. conditional release-if-no-work;
5. fenced durable interrupt request + RuntimeOwner `control_epoch`;
6. current/V2 `SessionExecutionLocal` runs beneath the shared owner;
7. V1 migrates from private raw `Flock` ownership to the same owner;
8. recovery-owner CAS;
9. foreground `ProcessContainment` proof;
10. conservative dead-owner recovery.

### D. Goal cutover

1. admit Goal continuation as Synthetic / `automatic` SessionInput;
2. replace Goal process claim/release with `continuation_input_id` correlation;
3. preserve legacy reservation columns read-only through the compatibility
   window;
4. migrate unowned legacy pending reservations idempotently;
5. fail closed on legacy foreign-owned rows until owner death is proven;
6. acquire Session execution ownership on the auditor child Session;
7. add `audit_id` + auditor execution-generation fencing;
8. delete Goal startup-wide foreign-owner/auditor clearing;
9. remove the legacy reservation owner fields after the support window.

### E. Shared wait

1. compact execution snapshot;
2. local exact event;
3. adaptive cross-process durable recheck;
4. migrate Session tool wait;
5. reuse in Task/Swarm adapters.

### F. Swarm retirement

1. lease state + hold correlation;
2. optimistic latest-User admission fence;
3. pending revoke branch;
4. running quiescence branch;
5. expiry/rebind/operator recovery through same retirement API;
6. adversarial process-kill/race tests.

Only after A-E are stable should Swarm depend on the protocol.

---

## 12. Research/frontier implication

The resulting architecture is a useful general agent-runtime primitive:

```text
durable mailbox
  + explicit user/host/automatic admission classes
  + revocable not-yet-executed inputs
  + strongly owned Session activation
  + shared process-incarnation identity
  + human-priority admission
  + domain-specific leases
  + quiescent retirement
  + conservative unknown-effect recovery
```

This separates **intent cancellation** from **execution interruption** and
**authority revocation**.

Most agent harnesses collapse those concepts into "cancel the task" or "stop the
agent". OpenFork can model them independently while still exposing one ordinary
human-interactable Session.

The closest systems analogy is a strongly owned actor activation directory, but
OpenFork adds a durable typed mailbox whose human, host, and automatic work are
ordered under one conversational identity. The Session is the actor; SessionInput
is the mailbox; RuntimeOwner identifies the process incarnation; Goal/Swarm/
ScheduledTask remain protocols around that actor rather than parallel execution
engines.

That is the architectural property worth preserving as this moves from Swarm
into scheduled execution, recovery, remote workers, and future multi-host
placement.

