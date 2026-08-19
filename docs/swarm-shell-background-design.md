# Background Shell — Design Spec

**Status:** Ready for implementation (draft v1, open questions flagged)
**Author:** designer (shell-background swarm)
**Consumers:** builder (implementation), verifier (QA), coordinator (sign-off)

---

## 1. Overview

The `bash` tool currently spawns a fresh `ChildProcess` per call, streams output
back synchronously, and returns when the process exits. This spec splits that
surface into **one-shot** (existing behavior, byte-identical) and
**in-background** execution, with two sub-pathways:

- **Pathway A — notify (async fire-and-forget).** `bash(command, background: true)`
  (notify defaults to `true`). The job runs; on a *terminal state the agent did
  not explicitly cause* (completed, error/crash, timeout), a synthetic message is
  injected into the launching session mid-turn (openswarm style) via
  `ctx.extra.promptOps`, and the agent continues.
- **Pathway B — managed (persistent).** `bash(command, background: true, notify: false)`.
  No auto-inject. The job lives in the process-local, instance-scoped
  `BackgroundJob` registry and is controlled through a new **`background`**
  manager tool (`list`, `status`, `kill`, `read`, `wait`, `send`).

Both pathways are the **same underlying job** — the `notify` flag only toggles
the injection fiber. A Pathway-A job can also be killed/managed mid-flight; a
Pathway-B job's output is equally streamed to a file and readable.

Key invariants:

1. One-shot `bash` is untouched — same params, same spawn, same output path,
   same permission ask, byte-identical result.
2. `background: true` launches are **opt-in per call** and the manager tool is
   inert without jobs → the feature ships **always-on, no runtime flag**.
   Reversibility comes free from the existing permission model (a user can deny
   the `background` tool and/or `bash` and both disappear via
   `Permission.visibleTools`/`disabled`).
3. Jobs are **process-local + instance-scoped, non-durable**. Process/instance
   restart kills live jobs; the manager `list` reports leftover jobs as
   `stale` (from on-disk meta files) so the agent can still read their logs.

---

## 2. Tool Surfaces

### 2.1 `bash` (launch surface) — extended, one-shot default

File: `packages/opencode/src/tool/shell.ts`, params in
`packages/opencode/src/tool/shell/prompt.ts` (`parameterSchema()`),
description template `packages/opencode/src/tool/shell/shell.txt`.

New params (all optional; one-shot path is *the absence of* `background: true`):

| param        | type    | default | meaning |
|--------------|---------|---------|---------|
| `command`    | string  | —       | unchanged |
| `timeout`    | int ≥ 0 | default | **one-shot:** unchanged default (see §7). **background:** no default; explicit value = kill-after. See §7. |
| `workdir`    | string  | cwd     | unchanged |
| `background` | boolean | `false` | `true` → in-background pathways. |
| `notify`     | boolean | `true`  | only meaningful when `background: true`. `true` → Pathway A (inject on terminal state). `false` → Pathway B (managed only). Ignored when `background: false`. |
| `id`         | string  | auto    | optional custom job id (short, human-friendly handle the agent types back into `background` calls). Auto-generated `job_<ulid>` when omitted. See §3. |

Exact JSON-schema shape (extended):

```jsonc
{
  "type": "object",
  "properties": {
    "command":  { "type": "string", "description": "The command to execute" },
    "timeout":  { "type": "integer", "minimum": 0, "description": "Optional timeout in milliseconds (background: kill-after; default: none)" },
    "workdir":  { "type": "string", "description": "The working directory to run the command in. Defaults to the current directory." },
    "background": { "type": "boolean", "description": "Run the command in the background. Returns immediately with a job id. Use the `background` tool to manage it." },
    "notify":   { "type": "boolean", "description": "When background=true, notify the agent automatically when the command finishes (default true). Set false for a long-running managed job (e.g. a dev server) you will control via the `background` tool." },
    "id":       { "type": "string", "pattern": "^[A-Za-z0-9_-]+$", "description": "Optional short job id, e.g. 'bg1'. Auto-generated if omitted." }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

**Launch result** (when `background: true`): returns immediately with
`metadata: { background: true, jobId, logPath, notify, timeout? }` and this
`output` (model-facing):

```xml
<background_shell job="job_xxx" state="running">
<summary>Background command started: <command></summary>
<command><command></command>
You will be notified when it finishes (unless notify=false).
Use the `background` tool with id `job_xxx` to: status, read, wait, send, kill.
Full output streams to: <logPath>
</background_shell>
```

The one-shot branch returns exactly what it returns today. No change.

### 2.2 `background` (manager tool) — NEW

**Tool id: `background`** (recommended; alternatives considered: `shell_task`
(user's literal invocation shape), `jobs` — rejected: `shell_task` collides
conceptually with the `task` tool and is verbose; `jobs` is too generic and
collides with `BackgroundJob` naming. `background` pairs naturally with the
launch param `background: true`. **Flagged for coordinator confirmation in the
handoff.**)

Params — single struct, `action` discriminates:

| param    | type    | required | valid when        | meaning |
|----------|---------|----------|-------------------|---------|
| `action` | enum    | yes      | always            | `list` \| `status` \| `kill` \| `read` \| `wait` \| `send` |
| `id`     | string  | no*      | all but `list`    | job id (auto or custom). *required for all actions except `list`. |
| `offset` | int ≥ 0 | no       | `read`            | byte/line offset into the job log (see §5). |
| `limit`  | int ≥ 1 | no       | `read`            | max bytes/lines to return for `read`. |
| `timeout`| int ≥ 0 | no       | `wait`            | max ms to wait. Omitted → wait indefinitely. `0` → poll once. |
| `input`  | string  | yes      | `send`            | text to write to the job's stdin. |

```jsonc
{
  "type": "object",
  "properties": {
    "action": { "enum": ["list", "status", "kill", "read", "wait", "send"] },
    "id": { "type": "string", "description": "Job id returned by bash background launch" },
    "offset": { "type": "integer", "minimum": 0 },
    "limit": { "type": "integer", "minimum": 1 },
    "timeout": { "type": "integer", "minimum": 0 },
    "input": { "type": "string" }
  },
  "required": ["action"],
  "additionalProperties": false
}
```

Per-action behavior:

| action   | permission ask | behavior |
|----------|----------------|----------|
| `list`   | none           | all jobs in the BackgroundJob registry + `stale` leftovers from disk (see §9). |
| `status` | none           | full `Info` for one job: status, exit code, started/completed times, command, logPath. |
| `read`   | none           | read job log from `offset`/`limit` — **line-based** offset/limit, aligned with the `read` tool UX the agent already knows (coordinator decision). Works live or settled. Returns `(no output yet)` when empty. |
| `wait`   | none           | `BackgroundJob.wait({id, timeout})`; returns status + exit code + tail preview on completion/timeout. |
| `kill`   | **`bash`** — pattern = job's original command | terminate process (`handle.kill({forceKillAfter: "3 seconds"})`), then `BackgroundJob.cancel(id)`. Result `status: cancelled`. **Never auto-injects** (the tool's own output informs the agent — see §8). |
| `send`   | **`bash`** — pattern = job's original command | write `input` to the job's stdin (spawned with `stdin: "pipe"`); appends `\n` if the input doesn't end with one. Errors if the job already exited. |

`list` output format (plain text; final formatting is the builder's call):

```
Job       Status                    Command        Started   Log
job_abc   running                   npm run dev    12:03:04  <path>/job_abc.log
job_def   completed (exit 0)        git push ...   11:58:02  <path>/job_def.log
job_ghi   error (exit 1)            bun test       11:40:11  <path>/job_ghi.log
job_jkl   stale                     pnpm watch     09:12:44  <path>/job_jkl.log
```

---

## 3. Job Ids, Registry, Handle Retention

### 3.1 Id scheme

- **Default:** `Identifier.ascending("job")` → `job_<ulid>` (BackgroundJob's own
  default). Uniqueness guaranteed; no collision across restarts.
- **Custom:** optional `id` param on `bash` (short handles like `bg1`). Rules:
  1. must match `^[A-Za-z0-9_-]+$`;
  2. **rejected at launch** if the id is already in the BackgroundJob registry
     (running or settled in this process) — error: `job id "bg1" is already in use`;
  3. **rejected** if a `job_<id>.log`/`job_<id>.json` already exists in the
     truncation dir (would clobber a stale job's log). Default `job_<ulid>` ids
     can never hit this.

### 3.2 BackgroundJob registry (reused, not forked)

`packages/core/src/background-job.ts` + instance wrapper
`packages/opencode/src/background/job.ts` (already a dependency of the tool
registry, `registry.ts:402`). Shell background uses it **unmodified**:

- `start({type: "shell", title: command, metadata, run})` — `run` is the
  process-watching effect; its return string becomes `Info.output` on settle.
- `Info.metadata` carries `{ background: true, jobId, logPath, notify, timeoutMs? }`
  → the manager tool gets logPath without a separate lookup.
- Status transitions handled by the registry: `running → completed | error | cancelled`.
- `wait({id, timeout})` returns `{info, timedOut}`; `cancel(id)` resolves the
  waiters with status `cancelled`.

**Job identity spans turns and sessions within the same instance** (the
registry is instance-scoped, not session-scoped). Notification always targets
the **session that started the job** (`ctx.sessionID` captured at launch). A job
launched from session X can be listed/read/killed from session Y via the manager
tool; only the inject (Pathway A) is pinned to session X.

### 3.3 ShellJobs — shared per-instance handle registry (NEW)

`BackgroundJob` stores `Info` (strings), **not** the live `ChildProcessHandle`.
The bash tool spawns the process; the manager tool needs the handle for
`kill`/`send`. New module: `packages/opencode/src/background/shell-jobs.ts`,
built on `InstanceState.make` (same pattern as `src/background/job.ts`).

```ts
type ShellJobEntry = {
  id: string
  handle: ChildProcessHandle        // pid, exitCode, kill, stdin Sink, all Stream
  command: string
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  metaPath: string
  notify: boolean
  timeoutMs?: number                // explicit kill-after, if any
}
```

API (builder's final shape; behavior contract):

- `register(entry)` / `remove(id)` / `get(id)` — the manager tool resolves
  handles here. `remove` runs as a finalizer when the job settles (process
  exited; `kill`/`send` then error with "job no longer running").
- **Instance dispose** (`Effect.addFinalizer` inside the `InstanceState.make`
  closure, per AGENTS.md): iterate entries and `handle.kill({forceKillAfter: "3 seconds"})`
  so no child processes leak when the instance closes (shell.ts spawns
  `detached: true` on non-Windows — orphans would otherwise survive).
- Lifetime note: the registry is keyed per-directory via `ScopedCache`; entries
  die with the instance. Same scoping as BackgroundJob → the two stay in sync.

The bash tool, the manager tool, and the notify fibers all read/write this one
registry — that is the only cross-tool handle-sharing mechanism.

---

## 4. Output Streaming

Every background job streams to a **per-job file** in the existing truncation
dir (`TRUNCATION_DIR = path.join(Global.Path.data, "tool-output")`,
`src/tool/truncation-dir.ts`):

- `job_<id>.log` — raw stdout+stderr (`handle.all`, `Stream.decodeText`), appended
  via `createWriteStream(path, { flags: "a" })`, closed on settle (mirror the
  `closeSink` finalizer in `shell.ts:450-473`). **Created up-front at launch**
  (coordinator decision) so `metadata.logPath` is stable immediately and the
  manager `read` has a well-defined `(no output yet)` state before the first
  chunk arrives.
- `job_<id>.json` — companion meta: `{id, command, shell, cwd, startedAt, notify, timeoutMs}`.
  Written at launch. Enables `stale` listing after restart (§9).

**Live progress:** the file *is* the live view — `background read {id}` reads
from disk with `offset`/`limit`, so the agent sees progress in real time without
any in-memory buffering. `offset`/`limit` are **line-based**, aligned with the
Read tool UX (coordinator decision) — document that in the `background` tool
description.

**Bounded tail in memory:** the run effect also keeps a rolling tail preview
(reuse the `tail()` helper from `shell.ts:225-255` with `trunc.limits()`
`maxLines`/`maxBytes`) for the completion injection and for `wait`. The run
effect **returns the tail preview as its output string** (BackgroundJob sets
`Info.output = run result` on settle) — so `status`/`wait`/injection all get the
preview for free without re-reading the file.

**Huge output:** the log file is intentionally unbounded (that's the point —
full output preserved for `read`/Grep). The *preview* is what gets bounded.
Protection knobs documented, not implemented: a future hard file cap (e.g. 100
MB) with a truncation note; out of scope for v1. The 7-day retention sweep
(`Truncate.cleanup`, `truncate.ts:53-66`) removes old logs.

**Retention integration:** extend `Truncate.cleanup`'s filter from
`name.startsWith("tool_")` to `name.startsWith("tool_") || name.startsWith("job_")`,
and **skip ids still held by ShellJobs** (a quiet long-running job could exceed
the 7-day mtime cutoff without writing). Pass a predicate or enumerate held ids
into cleanup (builder's call; behavior contract is: never delete a live job's
files).

**Per-chunk metadata:** the one-shot path streams `ctx.metadata({output: last})`
per chunk. The background path does **not** — no per-chunk churn; progress lives
in the file and is pulled on demand.

---

## 5. Permissions

| operation                          | permission ask |
|------------------------------------|----------------|
| `bash` launch (one-shot **and** background) | **unchanged** — existing `ask()` flow in `shell.ts:263-291` (tree-sitter scan → `external_directory` + `bash` patterns). `background: true` changes nothing here. |
| `background list / status / read / wait` | **none** — read-only observations of already-approved jobs, reading files the job itself wrote. Least noise; coordinator allows read-only ops to be lightweight. |
| `background kill` / `background send` | **`bash`** — `ctx.ask({ permission: ShellID.ToolID /* "bash" */, patterns: [<original command>], always: [<BashArity.prefix(tokens).join(" ") + " *">], metadata: { action: "kill"|"send", jobId, command } })` |

Rationale for reusing the `"bash"` key rather than introducing `"background"`:
existing user/agent permission rules keep working with zero config — an
"always" approval for `npm run dev *` covers `kill`/`send` of that exact job.
Killing or typing into a process is the same trust level as launching it. The
job's **original command string** (from the ShellJobs entry) is the pattern, not
the manager invocation.

---

## 6. Job Lifecycle State Machine

```
                       bash(background:true)
                              │
                    ┌─────────▼─────────┐        BackgroundJob.start forks run
                    │      running      │─────┐
                    └─────────┬─────────┘     │
                              │               │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
   process exits 0      process exits ≠0        explicit kill │ timeout
        │                     │                      │
        ▼                     ▼                      ▼
  completed             error                 cancelled
  (output = tail,       (Info.error =         (handle.kill + 
   exit code)            cause text)           BackgroundJob.cancel)
```

Transitions are owned by `BackgroundJob.settle`/`cancel`
(`background-job.ts:126-171, 337-358`). Shell-specific rules layered on top:

- `completed` / `error` → **inject** (Pathway A only).
- `cancelled` via manager `kill` → **never inject** (tool output informs the
  agent; an auto "cancelled" message would be noise).
- `cancelled` via **timeout** → **inject** with `reason="timeout"` (see §7, §8 —
  the timeout is a passive deadline the agent set and would otherwise never hear
  about).
- Stale (post-restart, from disk meta) → listed as `stale`; `read` still works;
  `kill`/`send`/`wait` error with "job no longer running (instance restarted)".

---

## 7. Timeout Semantics

- **One-shot:** unchanged — `params.timeout ?? defaultTimeoutMs` (default 2 min),
  kill-after + `expired` metadata.
- **Background:** **ignores the default tool timeout entirely.** No timeout →
  runs indefinitely. Explicit `timeout: N` → kill-after N ms. This is the
  difference between "the tool call has a deadline" (one-shot) and "the job has
  a leash" (background).
- Implementation: in the background run effect, race `handle.exitCode` against
  a timer **only when `timeoutMs` is set**. Timer wins → `handle.kill({forceKillAfter: "3 seconds"})`
  → inject `cancelled/reason=timeout` (only when `notify: true` — see §8) →
  `BackgroundJob.cancel(id)`.
- Messaging: the injection and `status` both surface `Killed after exceeding the
  explicit timeout of <N> ms.`; `Info.metadata.timeoutMs` records the value at
  launch.
- Known benign race: a job that completes in the same instant the timer fires —
  either outcome (completed with injection, or cancelled+timeout injection) is
  truthful; document, don't fix.

---

## 8. Notification (Pathway A injection)

**Mechanism (verified):** `ctx.extra.promptOps` is injected into every tool call
(`session/tools.ts:48,64`). Mirror `TaskTool.injectBackgroundResult`
(`task.ts:216-243`): fork a fiber (into the tool-init scope, same as TaskTool)
that `background.wait({id})`-s, then calls `ops.prompt(...)` with
`parts: [{ type: "text", synthetic: true, text }]`, wrapped in `Effect.ignore`
and `Effect.forkIn(scope, { startImmediately: true })`.

- `sessionID: ctx.sessionID` — captured at launch (the session that started the
  job). If that session no longer exists, `Effect.ignore` swallows the error.
- `agent: ctx.agent` — TaskTool resolves the *current parent* agent because
  subagents switch agents; shell never switches agents within a launch, so the
  launching agent is correct and we skip the `sessions.get` lookup.
- `variant`: **omit** (TaskTool passes it through but `prompt` accepts
  `undefined`; avoids the `MessageV2.get` lookup entirely).

**Injection decision table** (single notify fiber + a dedicated timeout path).
**ALL injection is gated on `notify: true` at launch** (coordinator refinement):
with `notify: false` (Pathway B) nothing ever auto-injects — including timeout;
the agent opted into managed-only control and must use the `background` tool.

| terminal state | inject? (when `notify: true`) | source |
|----------------|-------------------------------|--------|
| completed (exit 0) | yes | notify fiber (status === "completed") |
| error / crash (exit ≠ 0, failure) | yes | notify fiber (status === "error") |
| cancelled — explicit kill | **no** | status === "cancelled" → fiber no-ops |
| cancelled — timeout | yes | injected by the timeout handler *before* `cancel` (fiber no-ops on "cancelled") |

With `notify: false` the entire column becomes "no" — the notify fiber is not
forked and the timeout handler does not inject.

This design has no kill/notify race: the generic fiber only injects on
`completed`/`error`; the timeout path injects synchronously in the timer
handler; explicit kill sets `cancelled` which the fiber never injects.

### Templates (exact)

All are single text parts, `synthetic: true`. Escape `& < >` in the `<command>`
field only (shell commands commonly contain `<`/`>`; previews and errors stay
raw — matches TaskTool's unescaped pattern). Include `<logPath>` always.

**Completed:**

```
<background_shell job="job_xxx" state="completed" exit="0">
<summary>Background command completed: &lt;command&gt;</summary>
<command>&lt;command&gt;</command>
<preview>
<tail preview (bounded by trunc.limits)>
</preview>
Full output: <logPath>
</background_shell>
```

**Error:**

```
<background_shell job="job_xxx" state="error" exit="1">
<summary>Background command failed: &lt;command&gt;</summary>
<command>&lt;command&gt;</command>
<error><Info.error text — exit code + cause></error>
<preview>
<tail preview>
</preview>
Full output: <logPath>
</background_shell>
```

**Timeout (from the timer handler):**

```
<background_shell job="job_xxx" state="cancelled" reason="timeout">
<summary>Background command timed out after 60000 ms: &lt;command&gt;</summary>
<command>&lt;command&gt;</command>
<error>Killed after exceeding the explicit timeout of 60000 ms.</error>
<preview>
<tail preview>
</preview>
Full output: <logPath>
</background_shell>
```

Zero-output jobs: `<preview>(no output)</preview>`.

---

## 9. Non-Durable Jobs & Stale Status

Jobs are process-local + instance-scoped. **Process/instance restart kills live
jobs** (BackgroundJob registry is in-memory; ShellJobs' dispose finalizer kills
child handles). Left-behind artifacts in the truncation dir:

- `job_<id>.log` + `job_<id>.json` persist (until the 7-day sweep).

Graceful recovery: `background list` merges

1. live BackgroundJob entries (status `running|completed|error|cancelled`), and
2. **stale entries** — `job_*.json` meta files whose ids are **not** in the
   registry, rendered with `status: "stale"`, command/startedAt from meta,
   logPath. 

`read` on a stale job still works (file is on disk). `kill`/`send`/`wait` on a
stale job → clear error. This keeps the agent able to *see* and *read* what was
running before a restart, without pretending the process still exists.

---

## 10. Edge Cases

| # | case | handling |
|---|------|----------|
| 1 | zero-output job | log file may be empty/missing. `read` → `(no output yet)`; injection preview → `(no output)`; exit code still reported. |
| 2 | huge output | log file unbounded (intended). Preview bounded via `trunc.limits()`. `read` uses offset/limit. Future hard cap documented, not implemented. |
| 3 | kill-before-notify race | structurally impossible: notify fiber injects only `completed`/`error`; kill → `cancelled` → no-op; timeout injects in its own handler before `cancel`. |
| 4 | job started in session X, managed from session Y | registry is instance-scoped → manager works from any session in the instance. Injection only ever targets session X (captured `ctx.sessionID`). Document in tool descriptions. |
| 5 | starting session no longer exists | injection wrapped in `Effect.ignore` — silently dropped. |
| 6 | job id collisions | default `job_<ulid>` cannot collide. Custom `id` rejected if already registered **or** if `job_<id>.log/.json` exists on disk. |
| 7 | `send` to already-exited job | `handle.stdin` closed; `Sink.run` fails → error "job no longer running" (check status first for a friendly message). |
| 8 | `kill`/`send` on unknown id | clear error: `No such job: <id>`. |
| 9 | `wait` on unknown/stale id | `BackgroundJob.wait` returns `{timedOut:false, info:undefined}` → manager reports "No such job". |
| 10 | instance/process restart | §9: handles killed by ShellJobs finalizer; leftovers listed as `stale`; logs readable, retained 7 days. |
| 11 | shell command contains `<`/`>` | escaped in the `<command>` element of injected messages (§8). |
| 12 | `notify` set without `background` | ignored (documented in param description). |
| 13 | job outlives the tool call / session | independent by design — the job is owned by the instance, not the tool call; notification is the only session coupling. |

---

## 11. Implementation Checklist (ordered)

Phase 0 — plumbing (builder already started):

1. **`src/background/shell-jobs.ts`** — `InstanceState.make`-based handle registry
   per §3.3: `register/remove/get`, dispose finalizer that kills all retained
   handles, meta/log path helpers.
2. **Extend `Truncate.cleanup`** (`truncate.ts:53-66`) — filter `tool_|job_`
   prefixes; skip ids currently held by ShellJobs.

Phase 1 — launch surface:

3. **Extend `parameterSchema()`** (`shell/prompt.ts`) with `background`, `notify`,
   `id` per §2.1; update the description text (`shell.txt` + per-shell command
   sections) with a background usage paragraph.
4. **Add `runBackground`** in `shell.ts` (leave `run` untouched): spawn with
   `stdin: "pipe"`; no default timeout; optional kill-after timer (§7); create
   `job_<id>.log` **up-front at launch** (§4); stream `handle.all` → log + bounded
   tail preview; write `job_<id>.json`; finalizer removes the ShellJobs entry;
   return the tail preview string.
5. **Launch branch** in `ShellTool.execute`: after the existing `ask()`, if
   `params.background === true` → validate custom `id` (§3.1) → `background.start({type:"shell", title: command, metadata:{background, notify, jobId, logPath, timeoutMs}, run: runBackground(...)})` → return the running-message result (§2.1). One-shot branch is untouched.
6. **Notification** — notify fiber (if `notify`) per §8: `background.wait` →
   inject `completed`/`error` only; timeout handler injects `cancelled/timeout`
   then `cancel(id)`.

Phase 2 — manager tool:

7. **`src/tool/background.ts`** + `background.txt` DESCRIPTION (per-action
   instructions, id references, stale semantics, stdin note). Params per §2.2.
8. **Actions** — `list`/`status`/`read`/`wait` via BackgroundJob + file reads
   (no ask); `kill` and `send` via ShellJobs handle + `bash` ask (§5).
9. **Register** in `registry.ts` (import, yield in layer, `Tool.init` in the
   `Effect.all`, push into `builtin`). Deps already include `BackgroundJob.node`.

Phase 3 — hardening:

10. **Stale listing** in `list` (§9) — scan `job_*.json` not in the registry.
11. **Tests** — extend the `test/tool/archive.test.ts` harness pattern
    (`it.instance` + `LayerNode.compile(LayerNode.group([ToolRegistry.node]))` +
    recording `ctx.ask`): launch → list → status → read (live offset) → wait;
    kill suppresses injection; timeout injects; `send` reaches stdin; unknown-id
    errors; custom-id collision rejection.
12. **Description/UX pass** — make sure the bash description teaches
    `notify:false` for dev servers and the manager tool for everything else.

---

## 12. Open Questions — RESOLVED (coordinator sign-off)

1. **Manager tool id** — **`background` CONFIRMED** (pairs with `background: true`,
   avoids the `task` collision). Build against it.
2. **Timeout injection** — **CONFIRMED with refinement**: all injection is gated
   on `notify: true`; with `notify: false` nothing ever auto-injects, including
   timeout (§8 table). When `notify: true`, timeout injects
   `state="cancelled" reason="timeout"`.
3. **`read` offset semantics** — **DECIDED: line-based**, aligned with the `read`
   tool UX. Document in the `background` tool description.
4. **Custom-id disk collision check** — **ACCEPTED** (block reuse until the 7-day
   sweep; never clobber a stale job's log).

Implementation preference (relayed to builder): create `job_<id>.log`
**up-front at launch** so `metadata.logPath` is stable immediately.
