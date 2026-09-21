# Execution and Safety

**Read after:** `01-architecture.md`, `02-scheduling-semantics.md`  
**Owns:** everything that happens after a lease is claimed

## 1. The Tier 3 boundary

This document describes the **only** component in the feature allowed to touch
the execution runtime: `packages/opencode/src/scheduled-task/executor.ts`.

Its contract is deliberately narrow:

```ts
export interface Interface {
  readonly execute: (input: {
    readonly task: ScheduledTask.Info
    readonly runID: ScheduledTask.RunID
     readonly attempt: number
    readonly fireFor: number
    readonly leaseID: string
  }) => Effect.Effect<ExecutionOutcome>  // never fails — encodes failure
}
```

`Effect<ExecutionOutcome>` with no error channel is intentional. An executor
that can fail the effect can **strand a lease** and leave the run row in
`running` forever. Every failure mode must be encoded into the return value so
the settle step is unconditional.

## 2. Target resolution

### 2.1 The two target modes

Codex's model: for git repositories each scheduled task runs **either in the
local project or on a dedicated background worktree**; worktrees isolate
scheduled changes from unfinished local work, while local mode \"can change files
you are actively editing\". In non-version-controlled projects, runs happen
\"directly in the project directory\". We adopt that model.

```ts
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(\"directory\"), directory: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal(\"worktree\"),
    directory: Schema.String,      // the *source* repo
    baseRef: optional(Schema.String),  // default: current HEAD
    reuse: Schema.Boolean,        // one stable worktree vs one per run
  }),
])
```

### 2.2 The worktree accretion problem

Codex explicitly warns that with worktrees, \"frequent schedules can create many
worktrees over time\" and advises archiving runs you no longer need. That
warning is them describing a design consequence they live with. We should not
copy the consequence along with the feature.

**Decision: `reuse: true` is the default.** One stable worktree per task,
reset to `baseRef` at the start of each run. Rationale:

- A daily task running for a year produces **1** worktree, not 365.
- Disk growth is bounded by task count, which is user-visible and small.
- The cost — losing filesystem state of prior runs — is acceptable because
the
  **session transcript and any commits survive** independently.

If `reuse: false` is ever offered, it **requires** a retention sweeper shipping
in the same change. Do not ship worktree-per-run with a TODO for cleanup.

### 2.3 The `process.cwd()` prohibition

This is worth its own section because it is the single easiest way to break
`AGENTS.md` in this feature.

+ \"Missing directory/workspace input must be considered toxic until proven
+ harmless. If the path can fall back to `process.cwd()`, the implementation
+ has not established ownership.\"

**A scheduled task fires with no user, no request, and no ambient directory
context.** It is structurally the most likely caller in the whole system to
hit a cwd fallback — and the consequence is severe: an agent with write
access running against **an arbitrary directory**, unattended.

Rules:

1. `target_directory` is required at create time. Validation rejects absence.
2. Before loading the Instance, stat the directory. Missing ⇒ `skipped /
   target_missing`, run settled, **no Instance loaded**.
3. The executor **never reads `process.cwd()`**. T9 asserts this directly.
4. If the target is `worktree` and worktree creation fails, that is a
failure,
   **not** a silent demotion to `directory` mode. Demoting would let a
task
   the user believed was isolated silently mutate their working tree.

## 3. Firing sequence

### 3.0 SQLite writer ownership

The scheduler shares a WAL database with a low-priority ChunkDB maintenance
writer. Every scheduler transaction that reads durable state and may then mutate
it begins with `BEGIN IMMEDIATE` (`{ behavior: "immediate" }` in the Effect
Drizzle API). This reserves the single SQLite writer before the transaction
establishes its read snapshot.

This is correctness, not tuning. Under DEFERRED mode a maintenance commit between
the scheduler's read and first write makes that read snapshot unwritable and
SQLite returns `SQLITE_BUSY_SNAPSHOT` (517) immediately; a five-second
`busy_timeout` cannot repair an obsolete snapshot. Read-only snapshot
transactions remain DEFERRED, while ChunkDB maintenance retains its dedicated
connection and short backoff so foreground domain work owns writer priority.

```text
 1. LEASE ACQUIRED (runner, Tier 0)
     |
 2.  Revalidate — re-read task, check enabled/deleted/revision  -> abort = skipped
 3.  Stat target directory                            -> abort = target_missing
     |
 4.  INSERT run row (status=running)              -> conflict = already fired
 5.  emit scheduledTask.runStarted
     |
      -- if target.kind === \"worktree\": ensure / reset worktree
     |
 6.  >> TIER 3 BEGINS <<  InstanceStore.load({ directory })
     |
 7.  Resolve agent   model                 -> unavailable = failed/config
 8.  Resolve Session continuity policy:
       new      -> create fresh task-owned root
       reuse    -> reuse/create task-owned binding
       auto     -> reuse only if durable User frontier is unchanged, else rotate
       existing -> revalidate exact user-selected root
     -> bind runID + attempt -> sessionID before any Goal/model work
     |
      -- if action.goal: Goal.prepareForSession({ ..., start: true })
     |
 9.  SessionPrompt.hostPrompt(
       { sessionID, parts, agent, model },
       { source: scheduled-task.run, ref: runID }
     )                                                   heartbeat 30s
10.  Await completion (or goal terminal state, or timeout)
     |
11.  SETTLE — update run row, denormalize onto task, release lease,
              recompute next_run_at, emit runSettled, re-arm timer
```

**Steps 1–5 and 11 must be unconditional.** If the process dies between 6 and
10, the lease heartbeat goes stale and 02 § lease recovery reclaims it; the
run row is marked `abandoned` on the next startup sweep rather than remaining
`running` forever. A perpetual `running` row would **permanently block the
task** under the `skip` overrun policy — a silent death that is very hard to
diagnose from the UI.

### 3.1 Scheduled prompt semantics

Creation authorization is consumed **before** this execution lifecycle begins.
For conversational creation, the live human Prompt/Command worker root
authorizes one durable task definition and the task stores
`source=agent + sourceMessageID`. That human turn is not replayed later as the
authority of each scheduled execution.

`hostPrompt` is an admission/ownership boundary, not a request for privileged System authority.

The scheduled action prompt is:

```text
owner         = host
semantic kind = Synthetic / trusted host-admitted conversational input
producer      = scheduled-task.run
correlation   = provenance.ref = scheduled_task_run.id (logical run)
lineage       = root (no sourceMessageID)
authority     = conversational/user lane
provider      = normally role=user
```

This preserves the distinction between “the human is not currently typing” and “the host may override the user's policy.” A scheduled run is user-authorized automation, but its task body must not become System simply because OpenFork injected it. Stable unattended-execution/safety doctrine remains host-privileged System policy and is projected separately according to the exact provider/model/runtime capability.

The two provenance planes answer different questions:

- task `source=agent + sourceMessageID`: **why does this durable schedule exist?**
- run-turn `source=scheduled-task.run + ref=runID`: **why is this model-facing
  execution turn occurring now?**

The latter is host-owned Synthetic root-lineage input and does **not** gain
durable-user/Goal-creation authority merely because provider lowering may encode
it as `role=user`.

ScheduledTask now uses the shared typed provenance registry at the trusted
`hostPrompt` admission boundary. The executor chooses only the registered
`scheduled-task.run` source plus the durable run correlation; SessionPrompt
constructs `owner=host`. Public `PromptInput` cannot submit provenance. This
is the same producer-owned rule used by Goal continuation and the planned Swarm
admission surface: **the producer stamps provenance once; downstream consumers
classify it, never infer it from role/text/session metadata.**

That rule concerns **turn provenance/authority**. Session continuity requires
aggregate identity and run identity to remain separate: task-owned Sessions may
carry protected `scheduledTaskID`, while per-run correlation belongs to the run
row and the `scheduled-task.run / ref=runID` turn. An explicitly pinned existing
Session remains user-owned and receives no Scheduled aggregate identity. The
binding/CAS/User-frontier contract is normative in
`08-scheduler-workspace-session-continuity.md`.

#### User-driving a scheduled run Session

Scheduled execution creates a **root worker Session**, not a host-owned child
Session. After the scheduler's trusted `hostPrompt` admission, the human may
open that run Session and submit ordinary prompts through the canonical Session
prompt API. Those follow-ups carry normal `owner=user / source=prompt`
provenance and are governed by the same busy/queue/interrupt behavior as any
other root chat.

The inverse remains fenced: arbitrary `hostPrompt` callers may not take over a
Scheduled root merely because its aggregate metadata identifies a task/run. Only
the registered `scheduled-task.run` producer may perform trusted Scheduled
admission. This is the same separation Swarm relies on conceptually: a worker
root can be human-drivable without making producer admission forgeable.

Do **not** collapse task identity, run identity, and conversation identity into
one concept. They remain independently inspectable even when a policy reuses one
conversation across runs: each logical firing still has its own durable run row
and its own correlated host turn. `new` creates a root per run; `reuse`,
`auto`, and `existing` intentionally permit Session reuse under the rules in
08.

Retries remain attempts of the same logical run, so they may create a new
Session while retaining the same `provenance.ref = runID`. Attempt identity is
an execution-safety fence, not a second causal origin: Session binding,
permission-state transitions, and settlement are all conditional on the current
`runID + attempt`. A stale attempt is unable to mutate a newer attempt's run
state.

Lease recovery follows the same ownership discipline. Candidate discovery and
reclamation execute inside one `BEGIN IMMEDIATE` transaction; recovery
revalidates the exact lease id, owner, and heartbeat it observed before clearing
ownership, and only abandons a run whose `attempt` matches that recovered
lease. A heartbeat or retry transition therefore cannot race a pre-transaction
stale scan into abandoning newer work.

## 4. Goal composition

OpenChamber offers a \"Run as goal\" checkbox so a run \"pursue[s] its prompt to
completion instead of stopping after one reply\". This repo already has that
machinery natively and it is **more** developed than a checkbox — `Goal` has
criteria, steps, an independent auditor, evidence, and a state machine.

**Design rule: do not reimplement any of it.** The action carries an optional
goal specification and delegates:

```ts
export const Action = Schema.Struct({
  prompt: Schema.String,            // may be a slash command, e.g. \"/review src/\"
  agent: optional(Schema.String),
  model: optional(ModelRef),         // \"provider/model\"
  goal: optional(Schema.Struct({
    title: Schema.String,
    objective: Schema.String,
    criteria: optional(Schema.Array(Schema.String)),
    continuationPolicy: Goal.ContinuationPolicy,  // reuse existing type
  })),
})
```

On fire, if `action.goal` is present, the executor calls the existing
goal preparation entry point — the same one any other caller uses. The
scheduler contributes **intent and identity**; the Goal subsystem owns
continuation, auditing, and termination.

### 4.1 The budget interaction (important)

`Goal.ContinuationPolicy` already carries bounds — the `goal_automation` state
tracks `consecutive_turns`, `no_progress_turns`, and `consumed_tokens`, and
`automation.ts` reads `maxTurns` / `maxNoProgress` / `maxDurationMs` /
`tokenBudget` defaults. **Unattended scheduled goals must not inherit the
interactive defaults silently.**

A human-supervised goal can afford a generous turn budget because a person is
watching. A 3am unattended goal with the same budget is a token bill and a
repository diff nobody asked for. T0 must decide whether scheduled goals get
**their own tighter default bounds**. Recommendation: yes, and surface them in
the editor.

## 5. Unattended safety

This is the section most likely to be underweighted, so state it bluntly:

+ **Scheduling turns every agent capability into an unsupervised capability.**
+ A permission prompt a human would have denied at 2pm is, at 3am, just a
+ blocked fiber — or worse, if configured carelessly, an auto-approval.

### 5.1 The permission question

When a scheduled run hits a permission prompt there are only three coherent
behaviors, and **the user must choose per task**:

```ts
export const PermissionMode = Schema.Literals([
  \"deny\",    // DEFAULT. Auto-deny; the agent sees the denial and adapts or stops.
  \"pause\",   // Park the run as `waiting`. Surfaces in the inbox for a human.
  \"inherit\", // Use the workspace's configured permission policy as-is.
])
```

Codex's position is instructive: scheduled tasks use `approval_policy = \"never\"`
**when organization policy allows it**, falling back to the selected
permission mode otherwise, and their docs advise starting \"with the narrowest
access that lets the task succeed\". Note carefully that `approval_policy =
\"never\"` in their model means *do not ask* — **combined with a sandbox**
that constrains what can happen without asking. This repo does not
necessarily have an equivalent sandbox guarantee, so **copying \"never ask\"
without copying the sandbox would be strictly more dangerous than the
system we are borrowing from.**

Hence `deny` — not `allow` — as the default. T0 must confirm this against
whatever sandboxing actually exists here. The `pause` mode is the most
*useful* in practice and is what makes the inbox meaningful: a run that
stopped to ask a question is exactly the \"needs your attention\" state that
Codex's unread indicator represents.

### 5.2 Hard ceilings independent of policy

Regardless of configuration:

- **Wall-clock timeout per run** (`policy.maxDurationMs`; suggest 30m default
  for non-goal, longer for goal). On expiry: abort the session, settle as
  `failed / timeout`.
- **Consecutive failure circuit breaker.** `consecutive_failures >= N`
  (suggest 5) ⇒ auto-disable the task and surface it loudly. A broken task
  that fails every hour forever is both noise and cost.
- **Never auto-push.** If the action configuration ever grows a \"push branch\"
  affordance, it is opt-in per task and never to a default branch.

## 6. Failure taxonomy and retry

A flat `failed` status is useless for deciding whether to retry. Classify:

| `error_kind` | Meaning | Retry? | Counts toward circuit breaker? |
| --- | --- | --- | --- |
| `target_missing` | Directory gone | no (skip) | no |
| `config` | Agent/model unavailable | no | yes |
| `auth` | Credential expired | no | yes |
| `quota` | Provider quota exhausted | **yes, backoff** | no |
| `provider` | Transient 5xx / network | **yes, backoff** | no |
| `timeout` | Wall-clock ceiling hit | no | yes |
| `aborted` | User abort | no | no |
| `internal` | Bug | no | yes |

The `quota` row deserves attention. This repo already has a quota subsystem
with known reset windows. A scheduled run that fails on quota should retry
**at the known reset time** rather than on a blind exponential curve, and it
should **not** trip the circuit breaker — it is not a broken task, it is a
busy account. T0 decides whether v1 integrates quota reset timing or just
does backoff.

Retry is bounded: `policy.maxAttempts` (default 2, i.e. one retry) and retries
**must land before the next scheduled instant**. A retry that would overlap
the next fire is abandoned instead — otherwise a 5-minute task with 10-minute
retries accumulates a queue it can never drain.

## 7. Resource reclamation (the unglamorous part)

Every fire can leak something. Enumerate and assign an owner:

| Resource | Leak mode | Reclamation |
| --- | --- | --- |
| Lease row | Process killed mid-run | Heartbeat staleness sweep (T4) |
| Run row in `running` | Same | Startup sweep marks `abandoned` (T4) |
| Instance handle | Executor throws past load | `Effect.acquireRelease` (T5) |
| Session | Run fails after création | Keep it — it is the evidence |
| Worktree | Task deleted | Delete hook on task removal (T5) |
| Heartbeat fiber | Executor returns early | Scoped to the run fiber (T4) |
| Run history rows | Unbounded growth | Retention prune (T1   T4) |

The session row is deliberately **not** reclaimed. A failed scheduled run
whose transcript was deleted is undebuggable. Retention is the user's call.

### 7.1 Run history retention

Unbounded `scheduled_task_run` growth is a real problem: a 5-minute task
produces +105k rows/year. Policy: keep the last `N` runs per task (default
200) plus anything unacknowledged, prune on settle. Prune in the same
transaction as settle so there is no separate sweeper to forget to schedule.

## 8. What this document deliberately does *not* allow

- No `child_process` spawn of a CLI to run the task. In-process only.
- No writing to `launchd` / `systemd` / `schtasks`. See 01 § rejected
alternatives.
- No silent degradation of isolation (worktree → directory).
- No execution path that can skip step 11.
