export * as Checkpoint from "./checkpoint"

import { makeLocationNode } from "./effect/app-node"
import { Context, Clock, Effect, Layer, Schema } from "effect"
import { and, asc, eq, gt } from "drizzle-orm"
import { randomUUID } from "crypto"
import { Database } from "./database/database"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { Snapshot } from "./snapshot"
import { SessionSchema } from "./session/schema"
import { SessionCheckpointTable } from "./session/sql"
import { File } from "./file"

export const ID = Schema.String.pipe(Schema.brand("SessionCheckpoint.ID"))
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["baseline", "turn", "manual", "pre-revert"])
export type Kind = typeof Kind.Type

export const Status = Schema.Literals(["capturing", "ready", "partial", "error", "aborted"])
export type Status = typeof Status.Type

export const Excluded = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  size: Schema.optional(Schema.Number),
})
export type Excluded = typeof Excluded.Type

export const CheckpointError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
})
export type CheckpointError = typeof CheckpointError.Type

/** Durable, reviewable filesystem transition for one logical turn (or a manual / pre-revert point). */
export interface SessionCheckpoint {
  readonly id: ID
  readonly sessionID: SessionSchema.ID
  /** Monotonic within a session; never reused across retries or forks. */
  readonly ordinal: number
  readonly kind: Kind
  readonly status: Status
  /** Explicit pre-turn tree, captured at the turn boundary (not derived from a prior checkpoint). */
  readonly beforeSnapshot: string | null
  /** Post-quiescence tree. Null while status === "capturing". */
  readonly afterSnapshot: string | null
  readonly userMessageID: string | null
  readonly assistantMessageID: string | null
  /** Cached structured diff (before → after). Recomputable via `diff`. */
  readonly diff: ReadonlyArray<File.Diff> | null
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly excluded: ReadonlyArray<Excluded>
  readonly error: CheckpointError | null
  /** Snapshot-store epoch (project + worktree identity) at creation. */
  readonly epoch: string
  readonly epochMismatch: boolean
  readonly createdAt: number
  readonly finalizedAt: number | null
}

type Row = typeof SessionCheckpointTable.$inferSelect

function fromRow(row: Row): SessionCheckpoint {
  return {
    id: ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    ordinal: row.ordinal,
    kind: row.kind as Kind,
    status: row.status as Status,
    beforeSnapshot: row.before_snapshot,
    afterSnapshot: row.after_snapshot,
    userMessageID: row.user_message_id,
    assistantMessageID: row.assistant_message_id,
    diff: (row.diff as unknown as ReadonlyArray<File.Diff> | null) ?? null,
    additions: row.additions,
    deletions: row.deletions,
    files: row.files,
    excluded: (row.excluded as unknown as ReadonlyArray<Excluded> | null) ?? [],
    error: (row.error as unknown as CheckpointError | null) ?? null,
    epoch: row.epoch,
    epochMismatch: row.epoch_mismatch === 1,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
  }
}

export class EpochMismatch extends Schema.TaggedErrorClass<EpochMismatch>()("SessionCheckpoint.EpochMismatch", {
  checkpointID: ID,
  expected: Schema.String,
  actual: Schema.String,
}) {}
export type Error = EpochMismatch | Snapshot.Error

export interface CreateInput {
  readonly sessionID: SessionSchema.ID
  readonly ordinal: number
  readonly kind: Kind
  readonly beforeSnapshot: Snapshot.ID | null
  readonly afterSnapshot?: Snapshot.ID | null
  readonly userMessageID?: string | null
  readonly assistantMessageID?: string | null
  readonly epoch?: string
}

export interface ReconcileInput {
  readonly sessionID: SessionSchema.ID
  readonly userMessageID: string
  readonly ordinal: number
  readonly kind: Kind
  readonly beforeSnapshot: Snapshot.ID | null
  readonly assistantMessageID?: string | null
  readonly epoch?: string
}

export interface FinalizeInput {
  readonly checkpointID: ID
  readonly afterSnapshot: Snapshot.ID
  readonly assistantMessageID?: string | null
  /** Force a status; otherwise derived (partial when exclusions exist, else ready). */
  readonly status?: Status
  readonly excluded?: ReadonlyArray<Excluded>
  /** Precomputed diff; otherwise recomputed from before/after snapshots. */
  readonly diff?: ReadonlyArray<File.Diff>
}

export interface MarkErrorInput {
  readonly checkpointID: ID
  readonly error: CheckpointError
}

export interface TransitionInput {
  readonly id: ID
  readonly from: Status
  readonly to: Status
}

export interface DiffInput {
  readonly sessionID: SessionSchema.ID
  readonly checkpointID: ID
  /** "turn" = before → after of this checkpoint; "session" = baseline → this checkpoint. */
  readonly mode?: "turn" | "session"
}

export interface Interface {
  /** Insert a `capturing` checkpoint. `afterSnapshot` may be supplied for one-shot kinds. */
  readonly create: (input: CreateInput) => Effect.Effect<SessionCheckpoint, Error>
  /** Get-or-create: reuse an existing `capturing` checkpoint for (sessionID, userMessageID). */
  readonly reconcile: (input: ReconcileInput) => Effect.Effect<SessionCheckpoint, Error>
  /** CAS finalize: `capturing → ready | partial | error`. Returns undefined if the row was not capturing. */
  readonly finalize: (input: FinalizeInput) => Effect.Effect<SessionCheckpoint | undefined, Error>
  /** Mark a stuck/failed `capturing` checkpoint as `error`. */
  readonly markError: (input: MarkErrorInput) => Effect.Effect<SessionCheckpoint | undefined, Error>
  /** Conditional status transition. Returns whether the row mutated. */
  readonly transition: (input: TransitionInput) => Effect.Effect<boolean>
  readonly list: (input: { sessionID: SessionSchema.ID }) => Effect.Effect<readonly SessionCheckpoint[]>
  readonly get: (input: { sessionID: SessionSchema.ID; checkpointID: ID }) => Effect.Effect<SessionCheckpoint | undefined>
  /** Finalize checkpoints stuck in `capturing` past the threshold (crash recovery). */
  readonly recoverStuck: (input: {
    sessionID: SessionSchema.ID
    olderThanMs?: number
  }) => Effect.Effect<readonly SessionCheckpoint[]>
  /** Recompute the structured diff for a checkpoint (rejects cross-epoch targets). */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>
  /** Delete a checkpoint and release its pinned snapshot refs. */
  readonly remove: (input: { checkpointID: ID }) => Effect.Effect<void, Error>
  /** Truncate every checkpoint after the given ordinal (revert timeline collapse). */
  readonly removeAfter: (input: { sessionID: SessionSchema.ID; ordinal: number }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/checkpoint") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const snapshot = yield* Snapshot.Service

    const get = Effect.fn("Checkpoint.get")(function* (input: { sessionID: SessionSchema.ID; checkpointID: ID }) {
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(and(eq(SessionCheckpointTable.id, input.checkpointID), eq(SessionCheckpointTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const list = Effect.fn("Checkpoint.list")(function* (input: { sessionID: SessionSchema.ID }) {
      const rows = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, input.sessionID))
        .orderBy(asc(SessionCheckpointTable.ordinal))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const create = Effect.fn("Checkpoint.create")(function* (input: CreateInput) {
      const id = ID.make(randomUUID())
      const epoch = yield* snapshot.epoch()
      const createdAt = yield* Clock.currentTimeMillis
      yield* db
        .insert(SessionCheckpointTable)
        .values({
          id,
          session_id: input.sessionID,
          ordinal: input.ordinal,
          kind: input.kind,
          status: "capturing",
          before_snapshot: input.beforeSnapshot,
          after_snapshot: input.afterSnapshot ?? null,
          user_message_id: input.userMessageID ?? null,
          assistant_message_id: input.assistantMessageID ?? null,
          diff: null,
          additions: 0,
          deletions: 0,
          files: 0,
          excluded: null,
          error: null,
          epoch,
          epoch_mismatch: 0,
          created_at: createdAt,
          finalized_at: null,
        })
        .run()
        .pipe(Effect.orDie)
      return (yield* get({ sessionID: input.sessionID, checkpointID: id }))!
    })

    const reconcile = Effect.fn("Checkpoint.reconcile")(function* (input: ReconcileInput) {
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
      if (existing) return fromRow(existing)
      return yield* create({
        sessionID: input.sessionID,
        ordinal: input.ordinal,
        kind: input.kind,
        beforeSnapshot: input.beforeSnapshot,
        userMessageID: input.userMessageID,
        assistantMessageID: input.assistantMessageID,
        epoch: input.epoch,
      })
    })

    const finalize = Effect.fn("Checkpoint.finalize")(function* (input: FinalizeInput) {
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, input.checkpointID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const before = row.before_snapshot
      const after = input.afterSnapshot
      const diff =
        input.diff ?? (before ? yield* snapshot.diff({ from: Snapshot.ID.make(before), to: after }) : [])
      const additions = diff.reduce((sum, file) => sum + (file.additions ?? 0), 0)
      const deletions = diff.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
      const excluded = input.excluded ?? []
      const status = input.status ?? (excluded.length > 0 ? "partial" : "ready")
      const finalizedAt = yield* Clock.currentTimeMillis
      // Pin trees concurrently — retention is I/O-bound (2× commit-tree+update-ref) and independent.
      yield* Effect.all(
        [
          before ? snapshot.retain(Snapshot.ID.make(before)) : Effect.void,
          snapshot.retain(after),
        ],
        { concurrency: 2 },
      )
      const updated = yield* db
        .update(SessionCheckpointTable)
        .set({
          after_snapshot: after,
          diff: Array.from(diff) as any,
          additions,
          deletions,
          files: diff.length,
          excluded: excluded.length ? Array.from(excluded) : null,
          status,
          finalized_at: finalizedAt,
          assistant_message_id: input.assistantMessageID ?? row.assistant_message_id,
        })
        .where(and(eq(SessionCheckpointTable.id, input.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .returning({ id: SessionCheckpointTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return undefined
      return (yield* get({ sessionID: SessionSchema.ID.make(row.session_id), checkpointID: input.checkpointID }))!
    })

    const markError = Effect.fn("Checkpoint.markError")(function* (input: MarkErrorInput) {
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, input.checkpointID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const updated = yield* db
        .update(SessionCheckpointTable)
        .set({ status: "error", error: input.error })
        .where(and(eq(SessionCheckpointTable.id, input.checkpointID), eq(SessionCheckpointTable.status, "capturing")))
        .returning({ id: SessionCheckpointTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return undefined
      return (yield* get({ sessionID: SessionSchema.ID.make(row.session_id), checkpointID: input.checkpointID }))!
    })

    const transition = Effect.fn("Checkpoint.transition")(function* (input: TransitionInput) {
      const updated = yield* db
        .update(SessionCheckpointTable)
        .set({ status: input.to })
        .where(and(eq(SessionCheckpointTable.id, input.id), eq(SessionCheckpointTable.status, input.from)))
        .returning({ id: SessionCheckpointTable.id })
        .get()
        .pipe(Effect.orDie)
      return updated !== undefined
    })

    const recoverStuck = Effect.fn("Checkpoint.recoverStuck")(
      function* (input: { sessionID: SessionSchema.ID; olderThanMs?: number }) {
        const threshold = input.olderThanMs ?? 60 * 60 * 1000
        const cutoff = yield* Clock.currentTimeMillis
        const stuck = yield* db
          .select()
          .from(SessionCheckpointTable)
          .where(and(eq(SessionCheckpointTable.session_id, input.sessionID), eq(SessionCheckpointTable.status, "capturing")))
          .all()
          .pipe(Effect.orDie)
        const result: SessionCheckpoint[] = []
        for (const row of stuck) {
          if (row.created_at > cutoff - threshold) continue
          const updated = yield* db
            .update(SessionCheckpointTable)
            .set({ status: "error", error: { code: "stuck", message: "checkpoint never finalized" } })
            .where(and(eq(SessionCheckpointTable.id, row.id), eq(SessionCheckpointTable.status, "capturing")))
            .returning({ id: SessionCheckpointTable.id })
            .get()
            .pipe(Effect.orDie)
          if (updated) result.push(fromRow(row))
        }
        return result
      },
    )

    // §50: tree hashes are content-addressed, so a structured diff between two
    // trees is immutable once both exist — a perfect cache boundary. Bounded
    // LRU keeps memory flat across long sessions.
    const diffCache = new Map<string, readonly File.Diff[]>()
    const DIFF_CACHE_MAX = 128
    const cachedDiff = (key: string, compute: Effect.Effect<readonly File.Diff[], Error>) =>
      Effect.gen(function* () {
        const hit = diffCache.get(key)
        if (hit) {
          diffCache.delete(key)
          diffCache.set(key, hit)
          return hit
        }
        const value = yield* compute
        diffCache.set(key, value)
        if (diffCache.size > DIFF_CACHE_MAX) {
          const oldest = diffCache.keys().next().value
          if (oldest !== undefined) diffCache.delete(oldest)
        }
        return value
      })

    const diff = Effect.fn("Checkpoint.diff")(function* (input: DiffInput) {
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(and(eq(SessionCheckpointTable.id, input.checkpointID), eq(SessionCheckpointTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return []
      const currentEpoch = yield* snapshot.epoch()
      if (row.epoch !== currentEpoch) {
        yield* db
          .update(SessionCheckpointTable)
          .set({ epoch_mismatch: 1 })
          .where(eq(SessionCheckpointTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        return yield* Effect.fail(
          new EpochMismatch({ checkpointID: ID.make(row.id), expected: row.epoch, actual: currentEpoch }),
        )
      }
      const mode = input.mode ?? "turn"
      if (mode === "turn") {
        if (!row.before_snapshot || !row.after_snapshot) return []
        return yield* cachedDiff(
          `t:${row.before_snapshot}:${row.after_snapshot}`,
          snapshot.diff({ from: Snapshot.ID.make(row.before_snapshot), to: Snapshot.ID.make(row.after_snapshot) }),
        )
      }
      const first = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, input.sessionID))
        .orderBy(asc(SessionCheckpointTable.ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!first) return []
      const fromTree = first.after_snapshot ?? first.before_snapshot
      if (!fromTree || !row.after_snapshot) return []
      return yield* cachedDiff(
        `s:${fromTree}:${row.after_snapshot}`,
        snapshot.diff({ from: Snapshot.ID.make(fromTree), to: Snapshot.ID.make(row.after_snapshot) }),
      )
    })

    const releaseRefs = (row: Row) =>
      Effect.all(
        [
          row.before_snapshot ? snapshot.release(Snapshot.ID.make(row.before_snapshot)) : Effect.void,
          row.after_snapshot ? snapshot.release(Snapshot.ID.make(row.after_snapshot)) : Effect.void,
        ],
        { concurrency: 2 },
      )

    const remove = Effect.fn("Checkpoint.remove")(function* (input: { checkpointID: ID }) {
      const row = yield* db
        .select()
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, input.checkpointID))
        .get()
        .pipe(Effect.orDie)
      if (row) yield* releaseRefs(row)
      yield* db
        .delete(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, input.checkpointID))
        .run()
        .pipe(Effect.orDie)
    })

    const removeAfter = Effect.fn("Checkpoint.removeAfter")(
      function* (input: { sessionID: SessionSchema.ID; ordinal: number }) {
        const rows = yield* db
          .select()
          .from(SessionCheckpointTable)
          .where(and(eq(SessionCheckpointTable.session_id, input.sessionID), gt(SessionCheckpointTable.ordinal, input.ordinal)))
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(rows, (row) => releaseRefs(row), { concurrency: 4, discard: true })
        yield* db
          .delete(SessionCheckpointTable)
          .where(and(eq(SessionCheckpointTable.session_id, input.sessionID), gt(SessionCheckpointTable.ordinal, input.ordinal)))
          .run()
          .pipe(Effect.orDie)
      },
    )

    return Service.of({ create, reconcile, finalize, markError, transition, list, get, recoverStuck, diff, remove, removeAfter })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Snapshot.node, Location.node],
})
