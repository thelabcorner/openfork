# Checkpoint Lifecycle — Turn Capture Orchestration Design

**Lane:** `checkpoint-lifecycle` (Turn lifecycle & capture orchestrator)
**Swarm:** `checkpoint-arch`
**Source of truth:** `../handoff/t3code-handoff.md` (§81–§93, esp. §92 handoff prompt, §82 acceptance, §90 Q3)
**Scope:** Where/when to capture, quiescence barrier, exactly-once finalization, CAS, empty/failed/cancelled turns, retry dedup, subagent same-worktree attribution, crash recovery.

This document is the **contract + orchestration design** for the capture lifecycle. It defines the interface `checkpoint-core` must implement (persistence + durability) and the events `checkpoint-api` exposes. Implementation lives in a new `CheckpointLifecycle` service wired into `SessionPrompt.runLoop`.

---

## 1. Processor lifecycle trace (where `Snapshot.track` is called today)

`packages/opencode/src/snapshot/index.ts` — `Snapshot.Service`:
- `track()` (line 318): stages worktree into the **shadow git** (`add()`), then `write-tree` → returns a **tree hash**. This is the only primitive we use for before/after capture. It is serialized per worktree via `lock(state.gitdir)` (line 165).
- `patch(hash)` (line 349): diffs `hash → current index`, returns changed file list (used for the live `patch` part).
- `diffFull(from, to)` (line 546): returns `FileDiff[]` (status/additions/deletions/patch text) between two tree hashes. **This is the turn-diff primitive.**
- `restore` / `revert`: used by `SessionRevert` for rollback (do not touch user's real git).

`packages/opencode/src/session/processor.ts` — `SessionProcessor`:
- `create()` line 111: `const initialSnapshot = yield* snapshot.track()` — **pre-capture before the LLM stream**. Stored in `ctx.snapshot`.
- `step-start` line 484: re-tracks if `ctx.snapshot` was cleared (per-step baseline for the `patch` part).
- `step-finish` line 495: `completedSnapshot = snapshot.track()`, emits a `patch` part (line 528) for the **live UI incremental diff**.
- `cleanup()` line 626: final patch emission + awaits all tool `Deferred`s (250ms timeout) + marks abandoned tools `error` + sets `time.completed`.

`packages/opencode/src/session/prompt.ts` — `SessionPrompt.runLoop` (line 1266):
- `while (true)` (line 1279): each iteration is one **step** = one assistant message.
- Per iteration: `msg` created (line 1388) → `processor.create({ assistantMessage: msg, ... })` (line 1415) → `handle.process(...)` (line 1475) → on `break` the loop exits (line 1555).
- `Effect.ensuring(cleanup())` (processor line 774) runs cleanup after every `process()`.

**Key finding:** today's capture is **per-step** and finalizes on `step-finish`/`cleanup` (the `patch` part). That is exactly the anti-pattern the handoff forbids (§81: "checkpoint on first streaming diff event"; §92: "Do not use streaming patch/diff events as finalization signals"). The durable checkpoint must be **per logical turn**, captured at quiescence.

---

## 2. Authoritative turn-boundary seam (answers handoff §90 Q3)

**The logical turn = one top-level user message → terminal completion of the primary assistant run.** In code this is the entire `runLoop` `while` loop driven by a single `lastUser` (one user message). Each `while` iteration is a *step*; the loop exits (`break`, line 1555) when the assistant finishes with a non-`tool-calls` finish.

- **Pre-turn baseline (`beforeSnapshot`):** captured **once**, at the start of the logical turn, before the first `processor.create()`. Equivalent to the first processor's `initialSnapshot`, but hoisted to `runLoop` so it spans all steps.
- **Post-turn final capture (`afterSnapshot`):** captured **once**, **after the loop exits** — i.e. after the terminal step's `process()` returned and its `cleanup()` (tool Deferreds settled, `time.completed` set) completed. This is the **only** finalization signal.
- **Quiescence barrier:** the terminal step's `cleanup()` (processor.ts:626) — it awaits all tool `Deferred`s, finalizes abandoned tool parts, and writes `time.completed`. The runLoop `break` happens only after that `cleanup` ran (via `Effect.ensuring`). Therefore "loop exited" ⇒ "all file-mutating tool calls, hooks, and subtasks included in the parent turn have settled" (handoff §92).

The existing per-step `patch` part is **kept** as a live-UI artifact but is explicitly **not** the durable checkpoint.

---

## 3. `CheckpointLifecycle` service (new file: `packages/opencode/src/session/checkpoint-lifecycle.ts`)

Owns: capture orchestration, diff computation, CAS finalization, dedup, subagent/worktree policy, crash recovery, event publication. Depends on `Snapshot.Service`, `SessionCheckpoint.Service` (provided by `checkpoint-core`), `SessionRunState.Service`, `Session.Service`, `EventV2Bridge.Service`.

### 3.1 Per-worktree capture lock (concurrency policy — handoff §81 "two sessions checkpoint the same mutable worktree concurrently without policy" is an anti-pattern)
Module-level `Map<worktree, Semaphore>` (1 permit), created lazily. Acquired at logical-turn start, released at turn end via `Effect.ensuring`. Serializes checkpoint capture cycles **per worktree** so a `before → after` pair is never interleaved by another session's `track()`. Normal file edits / revert snapshots are unaffected (they use the Snapshot per-gitdir lock, not this one).

**Shared with revert:** the revert orchestration (`SessionRevert`, owned by `checkpoint-api`) must acquire the *same* per-worktree capture lock around its `snap.restore` / `snap.revert` critical section, so a revert cannot race a live `before → after` capture in another session sharing the worktree. The lock is exposed for reuse via `CheckpointLifecycle.withCaptureLock(worktree, effect)` (see §11) — it is single-sourced in the lifecycle service and never duplicated in `revert.ts`.

Defense-in-depth: record a **worktree epoch** (monotonic counter incremented on every `snapshot.track()` within the shadow repo, or compare the gitdir's pre/post tree hash) at `before`-capture; at `after`-capture, if the epoch changed due to another session, mark the checkpoint `partial` with `epochMismatch = true` rather than producing a falsely-attributed diff (handoff enhanced criterion "worktree epoch mismatch is rejected").

### 3.2 Turn flow (pseudocode for `runLoop` integration)

```ts
// --- before the while loop: resolve the turn's triggering user message ---
const turnUser = yield* resolveTurnUser(sessionID) // lastUser at loop entry
const worktree = ctx.worktree
const lock = yield* captureLockFor(worktree)

yield* lock.withPermits(1)(
  Effect.gen(function* () {
    // 1. PRE-TURN BASELINE
    const before = yield* snapshot.track()
    const epoch = yield* snapshot.epoch() // contract: monotonic, see §6

    // 2. DEDUP / CREATE (exactly-once create)
    const existing = yield* Checkpoint.reconcile({ sessionID, userMessageID: turnUser.id })
    const checkpoint = existing ?? (yield* Checkpoint.create({
      sessionID,
      userMessageID: turnUser.id,
      beforeSnapshot: before,
      status: "capturing",
    }))
    yield* events.publish(Checkpoint.Event.Created, {
      sessionID, checkpointID: checkpoint.id, userMessageID: turnUser.id, beforeSnapshot: before,
    })

    // 3. RUN THE TURN (existing while loop, unchanged capture semantics for patch parts)
    //    ... existing steps ...

    // 4. POST-TURN FINAL CAPTURE (quiescence: loop has exited, terminal cleanup done)
    const after = yield* snapshot.track()
    const diff = yield* snapshot.diffFull(before, after) // FileDiff[]
    const excluded = yield* snapshot.excludedFiles(before, after) // contract: large-file exclusions
    const epochChanged = (yield* snapshot.epoch()) !== epoch
    const terminal = yield* lastAssistant(sessionID) // terminal assistant message

    const status: Checkpoint.Status =
      msg.error || interrupted
        ? "error"                                   // failed/aborted turn — still inspectable
        : excluded.length > 0 || epochChanged
          ? "partial"                               // incomplete / uncertain attribution
          : "ready"

    // 5. CAS FINALIZE (exactly-once finalize)
    yield* Checkpoint.finalize({
      id: checkpoint.id,
      afterSnapshot: after,
      assistantMessageID: terminal.id,
      diff,
      excluded: excluded.length > 0,
      epochMismatch: epochChanged,
      status,
    }) // internal CAS capturing -> status; no-op if already transitioned

    yield* events.publish(Checkpoint.Event.Finalized, {
      sessionID, checkpointID: checkpoint.id, status,
      additions: diff.reduce((s, d) => s + d.additions, 0),
      deletions: diff.reduce((s, d) => s + d.deletions, 0),
      files: diff.length,
    })
  }),
).pipe(Effect.ensuring(lock.release)) // release even on interrupt/crash of THIS fiber
```

Notes:
- `before`/`after` are plain `snapshot.track()` calls; the extra `track()` at turn start is cheap (a `write-tree`) and decoupled from the processor's per-step snapshot.
- The `patch` parts emitted by the processor are untouched — they remain the live incremental UI.
- `lastAssistant(sessionID)` already exists (prompt.ts:1258) and returns the terminal assistant message.

---

## 4. CAS transition: `capturing → ready | partial | error`

Implemented by `checkpoint-core` as a **conditional DB update** (`UPDATE session_checkpoint SET status=?, ... WHERE id=? AND status='capturing'`), returning whether the row was mutated. This gives atomic, race-safe, exactly-once finalization.

| From | To | Trigger |
|------|----|---------|
| `capturing` | `ready` | turn completed, diff computed, no exclusions, epoch stable, 0+ files |
| `capturing` | `partial` | turn completed but large-file exclusions present **or** worktree epoch changed during capture |
| `capturing` | `error` | capture/diff failed, **or** turn failed/aborted (msg.error set / interrupted) — checkpoint still emitted so aborted turns stay inspectable (handoff enhanced criterion) |

- **Empty diff still emits a checkpoint.** `diff.length === 0` ⇒ status `ready` with `files: 0`. Satisfies handoff §82 #6 ("Empty turns remain aligned with conversation turns") and the assignment's "empty diff still emits checkpoint". The checkpoint is the durable record "turn N happened and changed 0 files".
- **Failed/aborted turns:** we still capture `after` and emit the checkpoint with status `error` and the diff of whatever was mutated, so the user can inspect a crashed turn's partial filesystem effect. We do **not** silently drop it.
- A second `finalize`/`markError` on an already-transitioned checkpoint is a **no-op** (CAS fails) → exactly-once.

---

## 5. Retry dedup (exactly-once create + finalize)

- **Dedup key = `(sessionID, userMessageID)`.** `Checkpoint.reconcile({ sessionID, userMessageID })` returns an existing checkpoint (any status) for that user message; if present, we reuse it instead of creating a new one.
- `SessionRetry.policy` retries the LLM stream **inside** one `processor.create()`/`process()`; the checkpoint is created **once at `runLoop` level**, so stream retries never duplicate it.
- `state.ensureRunning` already prevents two concurrent `runLoop`s for the same session, so re-entry for the same user message is defensive-only.
- **Crash-then-restart re-processing:** if the runLoop re-runs for the same user message (e.g. after a crash), `reconcile` finds the `capturing` checkpoint and reuses it; the recovery/finalize path re-captures `after` and finalizes via CAS. One record, finalized once.
- A genuinely new attempt creates a **new user message** (new ID) ⇒ new checkpoint. Reverts do not change `userMessageID`, so a revert+re-prompt still yields a distinct user message.

---

## 6. Subagent same-worktree attribution

- **Default (subagent shares parent worktree):** subtasks run synchronously inside the parent `runLoop` via `handleSubtask` (prompt.ts:1346) in the **same worktree**. Their file mutations occur *during* the parent turn, so the parent's `before → after` capture **folds them into the parent turn's checkpoint**. No separate checkpoint is created for the subagent (handoff §92: "subtasks included in the parent turn").
- **Subagent in its own worktree (forked session):** it is a distinct session with its own `runLoop` and its own checkpoints. Attribution follows the **worktree/session boundary**, not the parent. The per-worktree capture lock (§3.1) serializes capture if the forked session happens to share a worktree.
- **Policy statement:** checkpoint attribution is keyed by worktree. Subagents sharing the parent worktree are part of the parent turn; subagents in their own worktree get their own checkpoints via their own session lifecycle.

---

## 7. Crash recovery for stuck `capturing`

A checkpoint stuck in `capturing` means the turn died before `finalize` (process crash, fiber interrupt, or `finalize` interrupted).

- **Startup scan (`CheckpointLifecycle.init()` / project bootstrap):** for each session, find checkpoints with `status = 'capturing'` whose session is **not currently running** (no active `SessionRunState` runner, session status idle). For each:
  1. If a **newer terminal-state** checkpoint exists for the same `userMessageID` → mark the stuck one `error` (superseded), do not finalize (avoids a wrong/duplicate finalization).
  2. Otherwise re-acquire the worktree lock, capture `after = snapshot.track()`, compute `diffFull`, and `finalize` via CAS (`capturing → ready/partial/error`). Publish `Checkpoint.Event.Recovered`.
- **Live race safety:** recovery and a late normal `finalize` both go through the CAS; only one wins, the other is a no-op. Exactly-once preserved.
- **Lock release on crash:** the per-worktree capture lock is in-memory; process death releases it automatically, so recovery can re-acquire. No persistent lock needed.
- **Stuck-but-running guard:** never recover a `capturing` checkpoint for a session that is actively running — its own turn will finalize it. Recovery only targets idle/superseded sessions.
- **Grace window:** only recover `capturing` checkpoints older than a small threshold (e.g. session last-activity + grace) to avoid racing a turn that is merely slow.

---

## 8. Persistence schema (contract for `checkpoint-core`)

Table `session_checkpoint` (Drizzle, `packages/core/src/session/sql.ts`), snake_case fields:

```ts
session_checkpoint = sqliteTable("session_checkpoint", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  user_message_id: text().notNull(),
  assistant_message_id: text(),               // terminal assistant msg, set at finalize
  before_snapshot: text().notNull(),          // shadow-git tree hash
  after_snapshot: text(),                     // null while capturing
  status: text().notNull(),                   // capturing | ready | partial | error
  diff: text(),                               // JSON(FileDiff[]) content-addressed cache
  additions: integer().notNull().default(0),
  deletions: integer().notNull().default(0),
  files: integer().notNull().default(0),
  excluded: integer().notNull().default(0),   // bool: large-file exclusions present
  epoch_mismatch: integer().notNull().default(0), // bool: worktree epoch changed mid-capture
  created_at: integer().notNull(),
  finalized_at: integer(),
})
```

`SessionCheckpoint.Service` interface (implemented by `checkpoint-core`):

```ts
interface Interface {
  create(input: { sessionID; userMessageID; beforeSnapshot; status: "capturing" }): Effect<Checkpoint>
  reconcile(input: { sessionID; userMessageID }): Effect<Option<Checkpoint>>
  finalize(input: {
    id; afterSnapshot; assistantMessageID; diff: FileDiff[];
    excluded: boolean; epochMismatch: boolean; status: "ready" | "partial" | "error"
  }): Effect<void>                                   // CAS capturing -> status
  markError(input: { id; error: string }): Effect<void> // CAS capturing -> error
  transition(input: { id; from; to }): Effect<boolean> // generic CAS, returns mutated?
  list(sessionID): Effect<Checkpoint[]>
  get(id): Effect<Option<Checkpoint>>
  recoverStuck(sessionID): Effect<void>              // crash-recovery scan (§7)
}
```

---

## 9. Snapshot durability / GC contract (for `checkpoint-core` + `Snapshot`)

- `Snapshot.cleanup()` prunes shadow-git objects older than 7 days (snapshot/index.ts:23,761). Raw tree hashes referenced by a checkpoint **must survive** that prune, or `diffFull(before, after)` and `restore(before)` break.
- **Contract:** `CheckpointLifecycle` requests durability for `before`/`after` hashes via a new `Snapshot.retain(hash)` (and `Snapshot.release(hash)` on checkpoint deletion). `checkpoint-core` ensures these tree objects are pinned — by creating **shadow-only refs/commits inside the Snapshot shadow git repo** (never the user's source repo), per handoff §92 ("pin checkpoint objects using refs/commits inside the Snapshot shadow Git repo"). This is the GC/durability result the handoff §90 Q2 asks for.
- **Contract:** `Snapshot` gains `epoch(): Effect<number>` (monotonic per worktree, bumped on each `track()`) for the epoch-mismatch guard (§3.1), and `excludedFiles(from, to): Effect<string[]>` reporting files blocked by the 2 MiB size limit so `partial`/incompleteness can be surfaced (handoff §82 #8, enhanced "large-file exclusions are visible").

---

## 10. Events (contract for `checkpoint-api`)

Published via `EventV2Bridge` from `CheckpointLifecycle`; `checkpoint-api` defines the typed event schemas and the V1 HTTP surface:

- `Checkpoint.Event.Created` `{ sessionID, checkpointID, userMessageID, beforeSnapshot }`
- `Checkpoint.Event.Finalized` `{ sessionID, checkpointID, status, additions, deletions, files, excluded?, epochMismatch? }` — `excluded` / `epochMismatch` are **additive optional booleans** (agreed with `checkpoint-api`) so the 2 MiB / epoch warning can be driven from the event stream without a refetch. The lifecycle service already computes both values (§3.2 step 4, §8 schema) and will populate them; older consumers ignoring them remain compatible.
- `Checkpoint.Event.Error` `{ sessionID, checkpointID, error }`
- `Checkpoint.Event.Recovered` `{ sessionID, checkpointID }` — owned by lifecycle (crash recovery, §7).

**5th event owned by `checkpoint-api` (revert lane, not capture):** `session.checkpoint.reverted` `{ sessionID, checkpointID, targetSnapshot, preRevertCheckpointID?, truncatedCheckpoints }`. Lifecycle does not publish it; the revert orchestration does.

These are the "explicit checkpoint lifecycle receipts/events" the handoff §D.8 calls for.

---

## 11. Files to edit (implementation plan)

| File | Change |
|------|--------|
| `packages/opencode/src/session/checkpoint-lifecycle.ts` | **NEW** — `CheckpointLifecycle` service: lock, capture, diff, CAS finalize, dedup, recovery, events. |
| `packages/opencode/src/session/prompt.ts` | `runLoop`: acquire worktree lock + `before` capture + `Checkpoint.create`/`reconcile` before the `while`; `after` capture + `diffFull` + `Checkpoint.finalize` + events after loop exit; `Effect.ensuring(release)`. |
| `packages/opencode/src/session/processor.ts` | **No finalization change.** Keep per-step `patch` parts as live UI. Optionally expose `initialSnapshot` (not required). |
| `packages/core/src/session/sql.ts` | **NEW** `session_checkpoint` table (§8). (`checkpoint-core`) |
| `packages/opencode/src/snapshot/index.ts` | Add `retain`/`release`/`epoch`/`excludedFiles` (§9). (`checkpoint-core` coordinates) |
| `packages/opencode/src/session/revert.ts` | Extend revert to roll back to a checkpoint (`restore(beforeSnapshot)`); **acquire `CheckpointLifecycle.withCaptureLock(worktree, …)`** around the `snap.restore`/`snap.revert` critical section so it cannot race a live `before→after` capture (lock owned by lifecycle, §3.1). Coordinate with `checkpoint-core`/`checkpoint-api`. |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | List / per-turn / cumulative diff endpoints + `debug checkpoints` command. (`checkmark-api`) |

---

## 12. Acceptance mapping (handoff §82)

1. Stable before snapshot per top-level turn → §3.2 step 1.
2. Stable after snapshot per terminal outcome → §3.2 step 4.
3. Finalization after file-mutating work quiescent → §2 quiescence barrier.
4. Exact turn diff for T3 #1434 (18 writes in turn 1, 0 in no-op turn 2) → `diffFull(before, after)` per logical turn, not per step.
5. Manual pre-turn changes not attributed to AI → diff is `before→after` of the turn window only; manual edits between turns land in the next turn's `before`.
6. Empty turns aligned → §4 empty-diff emits checkpoint.
7. History survives restart → durable `session_checkpoint` + §7 recovery.
8. Snapshot objects survive cleanup → §9 `retain`/pin.
9/10/11. User branch / staging / ignored files untouched → shadow-git only, `restore`/`revert` unchanged semantics.
12/13. Existing revert still works → §11 revert extension.
14. Unrevert path retained → unchanged.
15. Cross-platform tests → `Snapshot` already per-platform; add lifecycle tests.

---

## 13. Open coordination points (for `checkpoint-core` / `checkpoint-api`)

- **`checkpoint-core`** builds `SessionCheckpoint.Service` (§8) + `session_checkpoint` table + `Snapshot.retain/release/epoch/excludedFiles` (§9). Lifecycle depends only on that interface.
- **`checkpoint-api`** defines the four events (§10) and the V1 list/per-turn/cumulative-diff + debug endpoints (§11), regenerates SDK.
- **Durability proof:** confirm `retain()` pins tree objects such that a 30-day-old checkpoint's `before`/`after` still resolve after weekly `Snapshot.cleanup()` — this is the §90 Q2 answer and must be verified by a test before UI work.
