export * as TurnCheckpoint from "./checkpoint"

import fs from "node:fs/promises"
import path from "path"
import { Effect, Fiber, Layer, Context, Clock, Scope, Schema, Semaphore } from "effect"
import { and, eq, lt, desc } from "drizzle-orm"
import { randomUUID } from "crypto"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionCheckpointTable } from "@opencode-ai/core/session/sql"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { define } from "@opencode-ai/schema/event"
import { Snapshot } from "@/snapshot"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionID } from "./schema"

/**
 * V1-runtime turn checkpoint wiring.
 *
 * The production turn loop lives in `packages/opencode` (SessionPrompt.runLoop)
 * and uses the V1-local `@/snapshot` service, whose shadow-repo layout is
 * identical to core's `Snapshot.Service` (same `Global.Path.data/snapshot/<project>/<worktree>`
 * gitdir and the same tree-hash space). This module bridges the V1 loop into the
 * durable `session_checkpoint` table owned by core, so the V2 HTTP API can read
 * per-turn checkpoints captured during real V1 execution.
 *
 * PERFORMANCE CONTRACT — the turn loop never waits on git:
 * - `begin()` performs only indexed SQLite reads/writes and FORKS the pre-turn
 *   tree capture (started before any tool executes, overlapping LLM streaming).
 * - `finish()` forks all heavy work (post-turn capture, diff, ref retention,
 *   final UPDATE) into a background fiber and returns immediately.
 * - `finishAborted()` implements t3 §47: a hard-interrupted turn still captures
 *   its after-state and finalizes with status `aborted` — a checkpoint is a
 *   record of reality, not an assertion that the model succeeded.
 * - A crashed finalize leaves a `capturing` row that self-heals to `error` on
 *   the session's next begin (once per process, not per turn).
 *
 * Events are defined LOCALLY (not in the schema package) so they stay out of
 * the Protocol/SDK surface — V1-only events per the schema package rules.
 */

/** Small additive payloads only — never diffs (t3 §38). */
const CheckpointEventSummary = {
  sessionID: Schema.String,
  checkpointID: Schema.String,
  ordinal: Schema.Number,
  kind: Schema.String,
  status: Schema.String,
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
}

export const Event = {
  Created: define({ type: "session.checkpoint.created", schema: CheckpointEventSummary }),
  Finalized: define({ type: "session.checkpoint.finalized", schema: CheckpointEventSummary }),
  Errored: define({ type: "session.checkpoint.errored", schema: CheckpointEventSummary }),
}

/**
 * Turn checkpoint handle. The pre-turn tree capture is FORKED at begin() —
 * before any tool can execute — and JOINED at finalize. The git work overlaps
 * LLM streaming instead of blocking turn start or turn completion.
 */
export interface Turn {
  readonly checkpointID: Checkpoint.ID
  readonly sessionID: SessionID
  readonly ordinal: number
  readonly beforeFiber: Fiber.Fiber<string | undefined>
}

interface Interface {
  /** Insert a `capturing` row (SQLite-only, no blocking git). Returns undefined when snapshots are disabled. */
  readonly begin: (input: { sessionID: SessionID; userMessageID: string }) => Effect.Effect<Turn | undefined>
  /** Fork background finalize (status ready/partial); returns immediately. No-op for undefined turns. */
  readonly finish: (turn: Turn | undefined) => Effect.Effect<void>
  /** Finalize the session's active turn with status `aborted`, capturing after-state (t3 §47). */
  readonly finishAborted: (sessionID: SessionID) => Effect.Effect<void>
  /** CAS-mark a capturing row as error. No-op for undefined turns. */
  readonly fail: (turn: Turn | undefined, error: Checkpoint.CheckpointError) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TurnCheckpoint") {}

const STALE_MS = 60 * 60 * 1000
// Keep durable metadata bounded. Full patches are regenerated from the two
// content-addressed trees by the diff endpoint when needed.
const MAX_CACHED_PATCH_BYTES = 256 * 1024
// Mirrors the V1 snapshot large-file rule (packages/opencode/src/snapshot: 2 MiB).
const SNAPSHOT_SIZE_LIMIT = 2 * 1024 * 1024
// Bounds the untracked-file scan for exclusion detection (background fiber only).
const MAX_EXCLUDED_REPORTED = 50
const MAX_EXCLUDED_SCANNED = 500

// Per-process bookkeeping (cheap, bounded by open sessions):
// - healed: sessions whose stale-row sweep already ran this process
// - locks: per-session mutex serializing ordinal allocation + insert
// - active: sessionID → in-flight turn (for finishAborted on hard interrupts)
// - worktreeOwners: worktree key → owning session (contention detection, t3 §46.3)
const healed = new Set<string>()
const locks = new Map<string, Semaphore.Semaphore>()
const active = new Map<string, Turn>()
const worktreeOwners = new Map<string, string>()

const lock = (key: string) => {
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const { db } = database

    const worktreeKey = Effect.fn("TurnCheckpoint.worktreeKey")(function* () {
      const ctx = yield* InstanceState.context
      return `${ctx.project.id}:${ctx.worktree}`
    })

    const epoch = Effect.fn("TurnCheckpoint.epoch")(function* () {
      const ctx = yield* InstanceState.context
      return Hash.fast(`${ctx.project.id}:${ctx.worktree}`)
    })

    const gitdir = Effect.fn("TurnCheckpoint.gitdir")(function* () {
      const ctx = yield* InstanceState.context
      return path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
    })

    const publish = (event: (typeof Event)[keyof typeof Event], summary: {
      sessionID: string
      checkpointID: string
      ordinal: number
      kind: string
      status: string
      files: number
      additions: number
      deletions: number
    }) =>
      events.publish(event, summary).pipe(
        Effect.catch((err) => Effect.logWarning("checkpoint event publish failed", { error: String(err) })),
      )

    // Serialized per session: ordinal read + insert must be atomic against a
    // concurrent begin for a queued follow-up turn.
    const allocate = Effect.fn("TurnCheckpoint.allocate")(function* (input: {
      sessionID: SessionID
      userMessageID: string
      beforeFiber: Fiber.Fiber<string | undefined>
    }) {
      const existing = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(
          and(
            eq(SessionCheckpointTable.session_id, input.sessionID),
            eq(SessionCheckpointTable.user_message_id, input.userMessageID),
            eq(SessionCheckpointTable.status, "capturing"),
          ),
        )
        .get()
        .pipe(Effect.orDie)

      // Resume of an interrupted turn: reuse the original row. Its pre-turn
      // tree may be unrecoverable; the fresh capture is the best-available
      // baseline and is written at finalize.
      if (existing) {
        return {
          checkpointID: Checkpoint.ID.make(existing.id),
          sessionID: input.sessionID,
          ordinal: existing.ordinal,
          beforeFiber: input.beforeFiber,
        } as Turn
      }

      const last = yield* db
        .select({ ordinal: SessionCheckpointTable.ordinal })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, input.sessionID))
        .orderBy(desc(SessionCheckpointTable.ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)

      const id = Checkpoint.ID.make(randomUUID())
      const now = yield* Clock.currentTimeMillis
      const ep = yield* epoch()
      const ordinal = (last?.ordinal ?? 0) + 1
      yield* db
        .insert(SessionCheckpointTable)
        .values({
          id,
          session_id: input.sessionID,
          ordinal,
          kind: "turn",
          status: "capturing",
          // Deliberately NULL until the forked baseline capture lands (written
          // at finalize — performance contract, no blocking git on turn start).
          before_snapshot: null,
          after_snapshot: null,
          user_message_id: input.userMessageID,
          assistant_message_id: null,
          diff: null,
          additions: 0,
          deletions: 0,
          files: 0,
          excluded: null,
          error: null,
          epoch: ep,
          epoch_mismatch: 0,
          created_at: now,
          finalized_at: null,
        })
        .run()
        .pipe(Effect.orDie)

      // Fire-and-forget: created event never delays turn start.
      yield* publish(Event.Created, {
        sessionID: input.sessionID,
        checkpointID: id,
        ordinal,
        kind: "turn",
        status: "capturing",
        files: 0,
        additions: 0,
        deletions: 0,
      }).pipe(Effect.forkIn(scope))

      return { checkpointID: id, sessionID: input.sessionID, ordinal, beforeFiber: input.beforeFiber } as Turn
    })

    const begin = Effect.fn("TurnCheckpoint.begin")(function* (input: {
      sessionID: SessionID
      userMessageID: string
    }) {
      if ((yield* config.get()).snapshot === false) return undefined

      // Contention detection (t3 §46.3): v1 policy is detect-and-warn —
      // checkpoint accuracy is guaranteed only with one active mutating run
      // per worktree.
      const key = yield* worktreeKey()
      const owner = worktreeOwners.get(key)
      if (owner && owner !== input.sessionID) {
        yield* Effect.logWarning("concurrent checkpointed turns share one worktree; attribution may be imprecise", {
          worktree: key,
          ownerSession: owner,
          sessionID: input.sessionID,
        })
      }
      worktreeOwners.set(key, input.sessionID)

      // Stale-row sweep: once per session per process (crash recovery), never
      // per turn. Only rows older than STALE_MS are touched (t3 §36: never
      // clobber a legitimately in-flight capture).
      if (!healed.has(input.sessionID)) {
        healed.add(input.sessionID)
        const cutoff = (yield* Clock.currentTimeMillis) - STALE_MS
        yield* db
          .update(SessionCheckpointTable)
          .set({ status: "error", error: { code: "stuck", message: "turn never finalized" } })
          .where(
            and(
              eq(SessionCheckpointTable.session_id, input.sessionID),
              eq(SessionCheckpointTable.status, "capturing"),
              // Strictly older than the threshold.
              lt(SessionCheckpointTable.created_at, cutoff),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }

      // Fork the pre-turn capture NOW — before any tool executes — but do not
      // wait for it. The write-tree overlaps LLM streaming; finalize joins it.
      const beforeFiber = yield* snapshot.track().pipe(Effect.forkIn(scope))

      // Serialize ordinal allocation + insert per session (in-memory mutex;
      // uncontended fast path is a Map lookup).
      const turn = yield* lock(input.sessionID).withPermits(1)(allocate({ ...input, beforeFiber }))
      active.set(input.sessionID, turn)
      return turn
    })

    /**
     * Oversized new untracked files absent from the captured tree (t3 §53).
     * Worktree-based and approximate; runs only on the background finalize
     * fiber. Read-only against the source repo — never touches the shadow index.
     */
    const detectExcluded = Effect.fn("TurnCheckpoint.detectExcluded")(function* (after: string) {
      const ctx = yield* InstanceState.context
      const dir = yield* gitdir()
      const others = yield* Effect.tryPromise(() =>
        Bun.$`git ls-files --others --exclude-standard -z`.cwd(ctx.worktree).text(),
      ).pipe(Effect.catch(() => Effect.succeed("")))
      const candidates = others.split("\0").filter(Boolean)
      if (candidates.length === 0) return [] as Checkpoint.Excluded[]
      const listed = yield* Effect.tryPromise(() =>
        Bun.$`git --git-dir ${dir} ls-tree -r --name-only -z ${after}`.text(),
      ).pipe(Effect.catch(() => Effect.succeed("")))
      const inTree = new Set(listed.split("\0").filter(Boolean))
      const result: Checkpoint.Excluded[] = []
      const scanned = Math.min(candidates.length, MAX_EXCLUDED_SCANNED)
      for (let i = 0; i < scanned && result.length < MAX_EXCLUDED_REPORTED; i++) {
        const rel = candidates[i]!
        if (inTree.has(rel.replaceAll("\\", "/"))) continue
        const size = yield* Effect.tryPromise(async () => (await fs.stat(path.join(ctx.worktree, rel))).size).pipe(
          Effect.catch(() => Effect.succeed(0)),
        )
        if (size > SNAPSHOT_SIZE_LIMIT) {
          result.push({ path: rel, reason: "exceeds snapshot size limit", size })
        }
      }
      return result
    })

    const finalize = Effect.fn("TurnCheckpoint.finalize")(function* (turn: Turn, forced?: Checkpoint.Status) {
      // Join the pre-turn capture forked at begin. By quiescence it has long
      // completed, so this is instant; if the turn was very short we simply
      // wait out the remaining write-tree.
      const before = yield* Fiber.join(turn.beforeFiber)
      const after = yield* snapshot.track()

      if (!after) {
        yield* db
          .update(SessionCheckpointTable)
          .set({
            status: "error",
            error: { code: "capture", message: "post-turn snapshot failed" },
            before_snapshot: before ?? null,
          })
          .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
          .run()
          .pipe(Effect.orDie)
        yield* publish(Event.Errored, {
          sessionID: turn.sessionID,
          checkpointID: turn.checkpointID,
          ordinal: turn.ordinal,
          kind: "turn",
          status: "error",
          files: 0,
          additions: 0,
          deletions: 0,
        })
        return
      }

      const diff = before
        ? yield* snapshot.diffFull(before, after).pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        : []

      const additions = diff.reduce((sum, f) => sum + (f.additions ?? 0), 0)
      const deletions = diff.reduce((sum, f) => sum + (f.deletions ?? 0), 0)
      const mapped = diff.map((f) => ({
        path: f.file ?? "",
        status: f.status ?? "modified",
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch:
          (f.patch ?? "").length > MAX_CACHED_PATCH_BYTES
            ? `${(f.patch ?? "").slice(0, MAX_CACHED_PATCH_BYTES)}\n[patch truncated; fetch checkpoint diff for full content]`
            : f.patch ?? "",
      }))

      const excluded = yield* detectExcluded(after).pipe(Effect.catch(() => Effect.succeed([] as Checkpoint.Excluded[])))
      // Forced status (aborted) wins; otherwise exclusions degrade to partial.
      const status = forced ?? (excluded.length > 0 ? "partial" : "ready")

      // Pin both trees against GC pruning (git gc --prune=7.days). Concurrent,
      // best-effort: a failed pin only shortens how long this checkpoint stays
      // restorable, it never breaks the row.
      yield* Effect.all([retainTree(before), retainTree(after)], { concurrency: 2 }).pipe(Effect.ignore)

      const finalizedAt = yield* Clock.currentTimeMillis
      // CAS: only the capturing owner finalizes; a fail()/reconcile race loses.
      yield* db
        .update(SessionCheckpointTable)
        .set({
          before_snapshot: before ?? null,
          after_snapshot: after,
          diff: mapped as any,
          additions,
          deletions,
          files: diff.length,
          excluded: excluded.length ? (excluded as any) : null,
          status,
          finalized_at: finalizedAt,
        })
        .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .run()
        .pipe(Effect.orDie)

      yield* publish(Event.Finalized, {
        sessionID: turn.sessionID,
        checkpointID: turn.checkpointID,
        ordinal: turn.ordinal,
        kind: "turn",
        status,
        files: diff.length,
        additions,
        deletions,
      })
    })

    const releaseWorktree = (sessionID: SessionID, key: string) => {
      if (worktreeOwners.get(key) === sessionID) worktreeOwners.delete(key)
    }

    const finish = Effect.fn("TurnCheckpoint.finish")(function* (turn: Turn | undefined) {
      if (!turn) return
      active.delete(turn.sessionID)
      releaseWorktree(turn.sessionID, yield* worktreeKey())
      // Performance contract: heavy work runs in a background fiber. The turn
      // result returns to the user immediately.
      yield* finalize(turn).pipe(
        Effect.catch((err) =>
          Effect.logWarning("turn checkpoint finalize failed", {
            "session.id": turn.sessionID,
            checkpointID: turn.checkpointID,
            error: String(err),
          }),
        ),
        Effect.forkIn(scope),
      )
    })

    const finishAborted = Effect.fn("TurnCheckpoint.finishAborted")(function* (sessionID: SessionID) {
      const turn = active.get(sessionID)
      if (!turn) return
      active.delete(sessionID)
      releaseWorktree(sessionID, yield* worktreeKey())
      // t3 §47: aborted turn + filesystem changed ⇒ capture after state,
      // status=aborted, diff remains reviewable/revertible. Forked so interrupt
      // teardown is never blocked.
      yield* finalize(turn, "aborted").pipe(
        Effect.catch((err) =>
          Effect.logWarning("turn checkpoint aborted-finalize failed", {
            "session.id": sessionID,
            checkpointID: turn.checkpointID,
            error: String(err),
          }),
        ),
        Effect.forkIn(scope),
      )
    })

    const fail = Effect.fn("TurnCheckpoint.fail")(function* (turn: Turn | undefined, error: Checkpoint.CheckpointError) {
      if (!turn) return
      active.delete(turn.sessionID)
      releaseWorktree(turn.sessionID, yield* worktreeKey())
      yield* Fiber.interrupt(turn.beforeFiber).pipe(Effect.ignore)
      yield* db
        .update(SessionCheckpointTable)
        .set({ status: "error", error })
        .where(and(eq(SessionCheckpointTable.id, turn.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .run()
        .pipe(Effect.orDie)
      yield* publish(Event.Errored, {
        sessionID: turn.sessionID,
        checkpointID: turn.checkpointID,
        ordinal: turn.ordinal,
        kind: "turn",
        status: "error",
        files: 0,
        additions: 0,
        deletions: 0,
      })
    })

    return Service.of({ begin, finish, finishAborted, fail })
  }),
)

/**
 * Pin a tree object in the shared shadow repo under refs/opencode/retained/<hash>.
 * Mirrors core Snapshot.retain using the V1 shadow-repo layout. Runs only on the
 * background finalize fiber.
 */
const retainTree = Effect.fn("TurnCheckpoint.retainTree")(function* (tree: string | undefined) {
  if (!tree) return
  const ctx = yield* InstanceState.context
  const dir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
  const ref = `refs/opencode/retained/${tree}`
  // commit-tree needs an identity; set inline to avoid relying on repo config.
  const commit = yield* Effect.tryPromise(() =>
    Bun.$`git -c user.name=opencode -c user.email=opencode@localhost --git-dir ${dir} commit-tree ${tree} -m checkpoint-retain`.text(),
  ).pipe(Effect.catch(() => Effect.succeed("")))
  if (!commit.trim()) return
  yield* Effect.tryPromise(() => Bun.$`git --git-dir ${dir} update-ref ${ref} ${commit.trim()}`.quiet()).pipe(
    Effect.ignore,
  )
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Snapshot.node, Config.node, Database.node, EventV2Bridge.node],
})
