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
 8.  Create session (title from task name   fire instant)
     |
      -- if action.goal: Goal.prepareForSession({ ..., start: true })
     |
 9.  SessionPrompt.hostPrompt({ sessionID, parts, agent, model })   heartbeat 30s
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
