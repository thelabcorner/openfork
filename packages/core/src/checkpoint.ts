export * as Checkpoint from "./checkpoint"

import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { Context, Clock, Effect, Layer, Schema, Schedule, Duration } from "effect"
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm"
import { randomUUID } from "crypto"
import { Database } from "./database/database"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { Snapshot } from "./snapshot"
import { SessionSchema } from "./session/schema"
import { SessionCheckpointSearchTable, SessionCheckpointTable, SessionTable } from "./session/sql"
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

export type SnapshotSlot = "before" | "after"
export const SNAPSHOT_RETENTION_PREFIX = "checkpoint/"

/**
 * Durable retention ownership for one checkpoint tree. The tree hash is part of
 * the key so replacement can pin the new tree before retiring the prior ref.
 */
export function snapshotRetentionKey(checkpointID: ID | string, slot: SnapshotSlot, tree: string) {
  return `${SNAPSHOT_RETENTION_PREFIX}${checkpointID}/${slot}/${tree}`
}

export function parseSnapshotRetentionKey(key: string) {
  if (!key.startsWith(SNAPSHOT_RETENTION_PREFIX)) return undefined
  const parts = key.slice(SNAPSHOT_RETENTION_PREFIX.length).split("/")
  if (parts.length !== 3) return undefined
  const [checkpointID, slot, tree] = parts
  if (!checkpointID || !tree || (slot !== "before" && slot !== "after")) return undefined
  return { checkpointID, slot, tree } as const
}

export interface SnapshotRetentionOwner {
  readonly id: string
  readonly status: string
  readonly beforeSnapshot: string | null
  readonly afterSnapshot: string | null
  readonly epoch: string
}

/**
 * Pure retention policy shared by Current and V1. Capturing rows preserve any
 * well-formed ref under their checkpoint id because finalize pins before CAS.
 */
export function ownsSnapshotRetention(
  owner: SnapshotRetentionOwner | undefined,
  key: string,
  currentEpoch: string,
) {
  const parsed = parseSnapshotRetentionKey(key)
  if (!parsed || !owner || parsed.checkpointID !== owner.id || owner.epoch !== currentEpoch) return false
  if (owner.status === "capturing") return true
  const expected = parsed.slot === "before" ? owner.beforeSnapshot : owner.afterSnapshot
  return expected === parsed.tree
}

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
  /** Bounded physical-ref reconciliation against durable checkpoint ownership. */
  readonly reconcileRetention: () => Effect.Effect<
    { readonly scanned: number; readonly released: number },
    Snapshot.Error
  >
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
      // Pin trees by durable checkpoint ownership, not by hash. Identical trees
      // referenced by different rows therefore remain independently releasable.
      const beforeKey = before ? snapshotRetentionKey(input.checkpointID, "before", before) : undefined
      const afterKey = snapshotRetentionKey(input.checkpointID, "after", after)
      yield* Effect.all(
        [
          before
            ? snapshot.retain(
                Snapshot.ID.make(before),
                beforeKey!,
              )
            : Effect.void,
          snapshot.retain(after, afterKey),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.tapError(() =>
          row.after_snapshot === after ? Effect.void : snapshot.release(afterKey).pipe(Effect.ignore),
        ),
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
      if (!updated) {
        const current = yield* db
          .select({
            before: SessionCheckpointTable.before_snapshot,
            after: SessionCheckpointTable.after_snapshot,
          })
          .from(SessionCheckpointTable)
          .where(eq(SessionCheckpointTable.id, input.checkpointID))
          .get()
          .pipe(Effect.orDie)
        yield* Effect.all(
          [
            beforeKey && current?.before !== before ? snapshot.release(beforeKey).pipe(Effect.ignore) : Effect.void,
            current?.after !== after ? snapshot.release(afterKey).pipe(Effect.ignore) : Effect.void,
          ],
          { concurrency: 2 },
        )
        return undefined
      }
      if (row.after_snapshot && row.after_snapshot !== after) {
        yield* snapshot
          .release(snapshotRetentionKey(input.checkpointID, "after", row.after_snapshot))
          .pipe(Effect.ignore)
      }
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
          row.before_snapshot
            ? snapshot.release(snapshotRetentionKey(row.id, "before", row.before_snapshot))
            : Effect.void,
          row.after_snapshot
            ? snapshot.release(snapshotRetentionKey(row.id, "after", row.after_snapshot))
            : Effect.void,
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
      yield* db
        .delete(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, input.checkpointID))
        .run()
        .pipe(Effect.orDie)
      // Durable ownership is removed first. A crash here may leave an orphaned
      // pin (safe/leaky); releasing first could make a still-durable checkpoint
      // unrecoverable. Normal completion retires the owner refs immediately.
      if (row) yield* releaseRefs(row)
    })

    const removeAfter = Effect.fn("Checkpoint.removeAfter")(
      function* (input: { sessionID: SessionSchema.ID; ordinal: number }) {
        const rows = yield* db
          .select()
          .from(SessionCheckpointTable)
          .where(and(eq(SessionCheckpointTable.session_id, input.sessionID), gt(SessionCheckpointTable.ordinal, input.ordinal)))
          .all()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionCheckpointTable)
          .where(and(eq(SessionCheckpointTable.session_id, input.sessionID), gt(SessionCheckpointTable.ordinal, input.ordinal)))
          .run()
          .pipe(Effect.orDie)
        yield* Effect.forEach(rows, (row) => releaseRefs(row), { concurrency: 4, discard: true })
      },
    )

    const reconcileRetention = Effect.fn("Checkpoint.reconcileRetention")(function* () {
      const currentEpoch = yield* snapshot.epoch()
      let after: string | undefined
      let scanned = 0
      let released = 0
      while (true) {
        const page = yield* snapshot.retained({
          prefix: SNAPSHOT_RETENTION_PREFIX,
          ...(after ? { after } : {}),
          limit: 128,
        })
        if (page.keys.length === 0) break
        scanned += page.keys.length
        const parsed = page.keys.map((key) => ({ key, parsed: parseSnapshotRetentionKey(key) }))
        const ids = Array.from(
          new Set(parsed.flatMap((item) => (item.parsed ? [item.parsed.checkpointID] : []))),
        )
        const rows =
          ids.length === 0
            ? []
            : yield* db
                .select({
                  id: SessionCheckpointTable.id,
                  status: SessionCheckpointTable.status,
                  beforeSnapshot: SessionCheckpointTable.before_snapshot,
                  afterSnapshot: SessionCheckpointTable.after_snapshot,
                  epoch: SessionCheckpointTable.epoch,
                })
                .from(SessionCheckpointTable)
                .where(inArray(SessionCheckpointTable.id, ids))
                .all()
                .pipe(Effect.orDie)
        const byID = new Map(rows.map((row) => [row.id, row]))
        const stale = parsed.flatMap(({ key, parsed }) => {
          if (!parsed) return [key]
          return ownsSnapshotRetention(byID.get(parsed.checkpointID), key, currentEpoch) ? [] : [key]
        })
        yield* Effect.forEach(
          stale,
          (key) =>
            snapshot.release(key).pipe(
              Effect.tap(() => Effect.sync(() => released++)),
              Effect.ignore,
            ),
          { concurrency: 4, discard: true },
        )
        if (!page.next) break
        after = page.next
      }
      return { scanned, released }
    })

    yield* reconcileRetention().pipe(
      Effect.catchCause((cause) => Effect.logWarning("checkpoint retention reconciliation failed", { cause })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )

    return Service.of({
      create,
      reconcile,
      finalize,
      markError,
      transition,
      list,
      get,
      recoverStuck,
      diff,
      remove,
      removeAfter,
      reconcileRetention,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Snapshot.node, Location.node],
})

// ── Global read projection ---------------------------------------------------
//
// Checkpoint inspection is durable-history access, not location runtime work.
// Keep it on Database.readDb and expose narrow projections so V1/current
// consumers never hydrate cached patch bodies to render timelines or search.

export interface ReadTarget {
  readonly id: string
  readonly sessionID: string
  readonly ordinal: number
  readonly kind: Kind
  readonly status: Status
  readonly beforeSnapshot: string | null
  readonly afterSnapshot: string | null
  readonly userMessageID: string | null
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly epoch: string
  readonly createdAt: number
}

export interface ReadSummary {
  readonly id: string
  readonly sessionID: string
  readonly ordinal: number
  readonly kind: Kind
  readonly status: Status
  readonly userMessageID: string | null
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly createdAt: number
  readonly paths: readonly string[]
  readonly sessionTitle: string | null
  readonly sessionAgent: string | null
}

export interface ReadView extends ReadTarget {
  readonly paths: readonly string[]
  readonly excluded: readonly Excluded[]
  readonly error: CheckpointError | null
  readonly sessionTitle: string | null
  readonly sessionAgent: string | null
}

export type ReadScope =
  | { readonly sessionID: string; readonly epoch?: never }
  | { readonly epoch: string; readonly sessionID?: never }

export interface ReadListInput {
  readonly scope: ReadScope
  readonly status?: Status
  readonly kind?: Kind
  readonly limit: number
}

export interface ReadSearchInput extends ReadListInput {
  readonly query?: string
  readonly touchedPath?: string
}

export interface ReadPage {
  readonly rows: readonly ReadSummary[]
  readonly total: number
}

export interface ReadInterface {
  readonly resolveSession: (prefix: string) => Effect.Effect<readonly string[]>
  readonly resolveCheckpoint: (prefix: string) => Effect.Effect<readonly ReadTarget[]>
  readonly targetByOrdinal: (sessionID: string, ordinal: number) => Effect.Effect<ReadTarget | undefined>
  readonly ordinals: (sessionID: string) => Effect.Effect<readonly number[]>
  readonly list: (input: ReadListInput) => Effect.Effect<ReadPage>
  readonly search: (input: ReadSearchInput) => Effect.Effect<ReadPage>
  readonly exists: (scope: ReadScope) => Effect.Effect<boolean>
  readonly view: (checkpointID: string) => Effect.Effect<ReadView | undefined>
  readonly metadata: (
    sessionID: string,
  ) => Effect.Effect<{ readonly title: string; readonly agent: string | null } | undefined>
  readonly firstSnapshots: (
    sessionID: string,
  ) => Effect.Effect<{ readonly beforeSnapshot: string | null; readonly afterSnapshot: string | null } | undefined>
  readonly worktreeStats: (
    epoch: string,
    mine: string,
  ) => Effect.Effect<{ readonly checkpoints: number; readonly sessions: number }>
  readonly siblingSessionIDs: (epoch: string, excluded: readonly string[]) => Effect.Effect<readonly string[]>
}

export class ReadService extends Context.Service<ReadService, ReadInterface>()("@opencode/core/checkpoint/read") {}

const targetColumns = {
  id: SessionCheckpointTable.id,
  session_id: SessionCheckpointTable.session_id,
  ordinal: SessionCheckpointTable.ordinal,
  kind: SessionCheckpointTable.kind,
  status: SessionCheckpointTable.status,
  before_snapshot: SessionCheckpointTable.before_snapshot,
  after_snapshot: SessionCheckpointTable.after_snapshot,
  user_message_id: SessionCheckpointTable.user_message_id,
  additions: SessionCheckpointTable.additions,
  deletions: SessionCheckpointTable.deletions,
  files: SessionCheckpointTable.files,
  epoch: SessionCheckpointTable.epoch,
  created_at: SessionCheckpointTable.created_at,
} as const

type TargetRow = {
  readonly id: string
  readonly session_id: string
  readonly ordinal: number
  readonly kind: string
  readonly status: string
  readonly before_snapshot: string | null
  readonly after_snapshot: string | null
  readonly user_message_id: string | null
  readonly additions: number
  readonly deletions: number
  readonly files: number
  readonly epoch: string
  readonly created_at: number
}

const readTarget = (row: TargetRow): ReadTarget => ({
  id: row.id,
  sessionID: row.session_id,
  ordinal: row.ordinal,
  kind: row.kind as Kind,
  status: row.status as Status,
  beforeSnapshot: row.before_snapshot,
  afterSnapshot: row.after_snapshot,
  userMessageID: row.user_message_id,
  additions: row.additions,
  deletions: row.deletions,
  files: row.files,
  epoch: row.epoch,
  createdAt: row.created_at,
})

const checkpointReadLayer = Layer.effect(
  ReadService,
  Effect.gen(function* () {
    const { readDb: db } = yield* Database.Service

    const scopeWhere = (scope: ReadScope): SQL => {
      if (scope.epoch !== undefined) return eq(SessionCheckpointTable.epoch, scope.epoch)
      return eq(SessionCheckpointTable.session_id, SessionSchema.ID.make(scope.sessionID))
    }

    const filters = (input: ReadListInput): SQL[] => {
      const result = [scopeWhere(input.scope)]
      if (input.status) result.push(eq(SessionCheckpointTable.status, input.status))
      if (input.kind) result.push(eq(SessionCheckpointTable.kind, input.kind))
      return result
    }

    const summaryColumns = {
      id: SessionCheckpointTable.id,
      session_id: SessionCheckpointTable.session_id,
      ordinal: SessionCheckpointTable.ordinal,
      kind: SessionCheckpointTable.kind,
      status: SessionCheckpointTable.status,
      user_message_id: SessionCheckpointTable.user_message_id,
      additions: SessionCheckpointTable.additions,
      deletions: SessionCheckpointTable.deletions,
      files: SessionCheckpointTable.files,
      created_at: SessionCheckpointTable.created_at,
      path0: sql<string | null>`json_extract(${SessionCheckpointTable.diff}, '$[0].path')`,
      path1: sql<string | null>`json_extract(${SessionCheckpointTable.diff}, '$[1].path')`,
      path2: sql<string | null>`json_extract(${SessionCheckpointTable.diff}, '$[2].path')`,
      session_title: SessionTable.title,
      session_agent: SessionTable.agent,
    } as const

    const toSummary = (row: {
      id: string
      session_id: string
      ordinal: number
      kind: string
      status: string
      user_message_id: string | null
      additions: number
      deletions: number
      files: number
      created_at: number
      path0: string | null
      path1: string | null
      path2: string | null
      session_title: string | null
      session_agent: string | null
    }): ReadSummary => ({
      id: row.id,
      sessionID: row.session_id,
      ordinal: row.ordinal,
      kind: row.kind as Kind,
      status: row.status as Status,
      userMessageID: row.user_message_id,
      additions: row.additions,
      deletions: row.deletions,
      files: row.files,
      createdAt: row.created_at,
      paths: [row.path0, row.path1, row.path2].filter((path): path is string => path !== null),
      sessionTitle: row.session_title,
      sessionAgent: row.session_agent,
    })

    type TouchedSummaryRow = {
      readonly id: string
      readonly session_id: string
      readonly ordinal: number
      readonly kind: string
      readonly status: string
      readonly user_message_id: string | null
      readonly additions: number
      readonly deletions: number
      readonly files: number
      readonly created_at: number
      readonly search_paths: string
      readonly session_title: string | null
      readonly session_agent: string | null
    }

    const firstPaths = (paths: string) => {
      const result: string[] = []
      let start = 0
      for (let i = 0; i < 3 && start < paths.length; i++) {
        const end = paths.indexOf("\n", start)
        if (end === -1) {
          result.push(paths.slice(start))
          break
        }
        result.push(paths.slice(start, end))
        start = end + 1
      }
      return result
    }

    const toTouchedSummary = (row: TouchedSummaryRow): ReadSummary => ({
      id: row.id,
      sessionID: row.session_id,
      ordinal: row.ordinal,
      kind: row.kind as Kind,
      status: row.status as Status,
      userMessageID: row.user_message_id,
      additions: row.additions,
      deletions: row.deletions,
      files: row.files,
      createdAt: row.created_at,
      paths: firstPaths(row.search_paths),
      sessionTitle: row.session_title,
      sessionAgent: row.session_agent,
    })

    const page = Effect.fnUntraced(function* (
      where: SQL[],
      input: ReadListInput,
      newestFirst: boolean,
      countNeedsSessionJoin = false,
    ) {
      const rows = yield* db
        .select(summaryColumns)
        .from(SessionCheckpointTable)
        .leftJoin(SessionTable, eq(SessionTable.id, SessionCheckpointTable.session_id))
        .where(and(...where))
        .orderBy(
          newestFirst
            ? input.scope.epoch !== undefined
              ? desc(SessionCheckpointTable.created_at)
              : desc(SessionCheckpointTable.ordinal)
            : asc(SessionCheckpointTable.ordinal),
        )
        .limit(input.limit + 1)
        .all()
        .pipe(Effect.orDie)
      if (rows.length <= input.limit) return { rows: rows.map(toSummary), total: rows.length } satisfies ReadPage
      rows.length = input.limit
      const counted = countNeedsSessionJoin
        ? yield* db
            .select({ count: sql<number>`count(*)` })
            .from(SessionCheckpointTable)
            .leftJoin(SessionTable, eq(SessionTable.id, SessionCheckpointTable.session_id))
            .where(and(...where))
            .get()
            .pipe(Effect.orDie)
        : yield* db
            .select({ count: sql<number>`count(*)` })
            .from(SessionCheckpointTable)
            .where(and(...where))
            .get()
            .pipe(Effect.orDie)
      return { rows: rows.map(toSummary), total: counted?.count ?? rows.length } satisfies ReadPage
    })

    const resolveSession = Effect.fn("Checkpoint.Read.resolveSession")(function* (prefix: string) {
      const exact = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(prefix)))
        .get()
        .pipe(Effect.orDie)
      if (exact) return [exact.id as string]
      const hits = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(gte(SessionTable.id, SessionSchema.ID.make(prefix)), lt(SessionTable.id, SessionSchema.ID.make(prefix + "\uffff"))))
        .orderBy(asc(SessionTable.id))
        .limit(9)
        .all()
        .pipe(Effect.orDie)
      return hits.map((item) => item.id as string)
    })

    const resolveCheckpoint = Effect.fn("Checkpoint.Read.resolveCheckpoint")(function* (prefix: string) {
      const exact = yield* db
        .select(targetColumns)
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.id, prefix))
        .get()
        .pipe(Effect.orDie)
      if (exact) return [readTarget(exact)]
      const hits = yield* db
        .select(targetColumns)
        .from(SessionCheckpointTable)
        .where(and(gte(SessionCheckpointTable.id, prefix), lt(SessionCheckpointTable.id, prefix + "\uffff")))
        .orderBy(asc(SessionCheckpointTable.id))
        .limit(6)
        .all()
        .pipe(Effect.orDie)
      return hits.map(readTarget)
    })

    const targetByOrdinal = Effect.fn("Checkpoint.Read.targetByOrdinal")(function* (sessionID: string, ordinal: number) {
      const row = yield* db
        .select(targetColumns)
        .from(SessionCheckpointTable)
        .where(
          and(
            eq(SessionCheckpointTable.session_id, SessionSchema.ID.make(sessionID)),
            eq(SessionCheckpointTable.ordinal, ordinal),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? readTarget(row) : undefined
    })

    const ordinals = Effect.fn("Checkpoint.Read.ordinals")(function* (sessionID: string) {
      const rows = yield* db
        .select({ ordinal: SessionCheckpointTable.ordinal })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, SessionSchema.ID.make(sessionID)))
        .orderBy(asc(SessionCheckpointTable.ordinal))
        .all()
        .pipe(Effect.orDie)
      return rows.map((item) => item.ordinal)
    })

    const list = Effect.fn("Checkpoint.Read.list")(function* (input: ReadListInput) {
      // Session timelines preserve chronological order; cross-worktree list
      // preserves the tool's existing recency-first ordering.
      return yield* page(filters(input), input, input.scope.epoch !== undefined)
    })

    const ftsPhrase = (value: string) => '"' + value.replaceAll('"', '""') + '"'

    const searchTouched = Effect.fn("Checkpoint.Read.searchTouched")(function* (input: ReadSearchInput & {
      readonly touchedPath: string
    }) {
      const normalized = input.touchedPath.replaceAll("\\", "/")
      const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
      const candidateFrom =
        basename.length >= 3
          ? sql`session_checkpoint_search_fts
              CROSS JOIN session_checkpoint_search search
                ON search.rowid = session_checkpoint_search_fts.rowid`
          : sql`session_checkpoint_search search`
      const where: SQL[] = [
        basename.length >= 3
          ? sql`session_checkpoint_search_fts MATCH ${ftsPhrase(basename)}`
          : sql`instr(search.paths, ${basename}) > 0`,
        input.scope.epoch !== undefined
          ? sql`cp.epoch = ${input.scope.epoch}`
          : sql`cp.session_id = ${SessionSchema.ID.make(input.scope.sessionID)}`,
        sql`EXISTS (
          SELECT 1
          FROM json_each(COALESCE(cp.diff, '[]')) AS j
          WHERE json_type(j.value, '$.path') = 'text'
            AND (
              replace(json_extract(j.value, '$.path'), char(92), '/') = ${normalized}
              OR substr(replace(json_extract(j.value, '$.path'), char(92), '/'), -(length(${normalized}) + 1)) = '/' || ${normalized}
              OR substr(${normalized}, -(length(replace(json_extract(j.value, '$.path'), char(92), '/')) + 1)) = '/' || replace(json_extract(j.value, '$.path'), char(92), '/')
            )
        )`,
      ]
      if (input.status) where.push(sql`cp.status = ${input.status}`)
      if (input.kind) where.push(sql`cp.kind = ${input.kind}`)
      if (input.query) {
        const lowered = input.query.toLowerCase()
        where.push(
          sql`(
            instr(lower(search.paths), ${lowered}) > 0
            OR instr(lower(COALESCE(cp.user_message_id, '')), ${lowered}) > 0
            OR instr(lower(cp.kind), ${lowered}) > 0
            OR instr(lower(cp.status), ${lowered}) > 0
            OR instr(CAST(cp.ordinal AS TEXT), ${lowered}) > 0
            OR instr(lower(cp.session_id), ${lowered}) > 0
            OR instr(lower(COALESCE(s.title, '')), ${lowered}) > 0
            OR instr(lower(COALESCE(s.agent, '')), ${lowered}) > 0
          )`,
        )
      }
      const predicate = and(...where)!
      const order = input.scope.epoch !== undefined ? sql`cp.created_at DESC` : sql`cp.ordinal DESC`
      const rows = yield* db
        .all<TouchedSummaryRow>(sql`
          SELECT
            cp.id,
            cp.session_id,
            cp.ordinal,
            cp.kind,
            cp.status,
            cp.user_message_id,
            cp.additions,
            cp.deletions,
            cp.files,
            cp.created_at,
            search.paths AS search_paths,
            s.title AS session_title,
            s.agent AS session_agent
          FROM ${candidateFrom}
          CROSS JOIN session_checkpoint cp
            ON cp.id = search.checkpoint_id
          LEFT JOIN session s
            ON s.id = cp.session_id
          WHERE ${predicate}
          ORDER BY ${order}
          LIMIT ${input.limit + 1}
        `)
        .pipe(Effect.orDie)
      if (rows.length <= input.limit) {
        return { rows: rows.map(toTouchedSummary), total: rows.length } satisfies ReadPage
      }
      rows.length = input.limit
      const counted = yield* db
        .get<{ count: number }>(sql`
          SELECT count(*) AS count
          FROM ${candidateFrom}
          CROSS JOIN session_checkpoint cp
            ON cp.id = search.checkpoint_id
          LEFT JOIN session s
            ON s.id = cp.session_id
          WHERE ${predicate}
        `)
        .pipe(Effect.orDie)
      return { rows: rows.map(toTouchedSummary), total: counted?.count ?? rows.length } satisfies ReadPage
    })

    const queryCondition = (value: string): SQL => {
      const lowered = value.toLowerCase()
      const scalar = or(
        sql`instr(lower(COALESCE(${SessionCheckpointTable.user_message_id}, '')), ${lowered}) > 0`,
        sql`instr(lower(${SessionCheckpointTable.kind}), ${lowered}) > 0`,
        sql`instr(lower(${SessionCheckpointTable.status}), ${lowered}) > 0`,
        sql`instr(CAST(${SessionCheckpointTable.ordinal} AS TEXT), ${lowered}) > 0`,
        sql`instr(lower(${SessionCheckpointTable.session_id}), ${lowered}) > 0`,
        sql`instr(lower(COALESCE(${SessionTable.title}, '')), ${lowered}) > 0`,
        sql`instr(lower(COALESCE(${SessionTable.agent}, '')), ${lowered}) > 0`,
      )!
      const paths =
        lowered.length >= 3
          ? sql`${SessionCheckpointTable.id} IN (
              SELECT search.checkpoint_id
              FROM session_checkpoint_search_fts
              JOIN session_checkpoint_search search ON search.rowid = session_checkpoint_search_fts.rowid
              WHERE session_checkpoint_search_fts MATCH ${ftsPhrase(lowered)}
            )`
          : sql`${SessionCheckpointTable.id} IN (
              SELECT search.checkpoint_id
              FROM session_checkpoint_search search
              WHERE instr(lower(search.paths), ${lowered}) > 0
            )`
      return or(paths, scalar)!
    }

    const search = Effect.fn("Checkpoint.Read.search")(function* (input: ReadSearchInput) {
      if (input.touchedPath) return yield* searchTouched({ ...input, touchedPath: input.touchedPath })
      const where = filters(input)
      if (input.query) where.push(queryCondition(input.query))
      return yield* page(where, input, true, input.query !== undefined)
    })

    const exists = Effect.fn("Checkpoint.Read.exists")(function* (scope: ReadScope) {
      const row = yield* db
        .select({ id: SessionCheckpointTable.id })
        .from(SessionCheckpointTable)
        .where(scopeWhere(scope))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    const metadata = Effect.fn("Checkpoint.Read.metadata")(function* (sessionID: string) {
      return yield* db
        .select({ title: SessionTable.title, agent: SessionTable.agent })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
        .get()
        .pipe(Effect.orDie)
    })

    const view = Effect.fn("Checkpoint.Read.view")(function* (checkpointID: string) {
      const row = yield* db
        .select({
          ...targetColumns,
          excluded: SessionCheckpointTable.excluded,
          error: SessionCheckpointTable.error,
          session_title: SessionTable.title,
          session_agent: SessionTable.agent,
        })
        .from(SessionCheckpointTable)
        .leftJoin(SessionTable, eq(SessionTable.id, SessionCheckpointTable.session_id))
        .where(eq(SessionCheckpointTable.id, checkpointID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const paths = yield* db
        .all<{ path: string }>(sql`
          SELECT json_extract(j.value, '$.path') AS path
          FROM session_checkpoint cp, json_each(COALESCE(cp.diff, '[]')) AS j
          WHERE cp.id = ${checkpointID}
            AND json_type(j.value, '$.path') = 'text'
          ORDER BY CAST(j.key AS INTEGER)
        `)
        .pipe(Effect.orDie)
      return {
        ...readTarget(row),
        paths: paths.map((item) => item.path),
        excluded: (row.excluded as readonly Excluded[] | null) ?? [],
        error: (row.error as CheckpointError | null) ?? null,
        sessionTitle: row.session_title,
        sessionAgent: row.session_agent,
      } satisfies ReadView
    })

    const firstSnapshots = Effect.fn("Checkpoint.Read.firstSnapshots")(function* (sessionID: string) {
      const row = yield* db
        .select({
          beforeSnapshot: SessionCheckpointTable.before_snapshot,
          afterSnapshot: SessionCheckpointTable.after_snapshot,
        })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.session_id, SessionSchema.ID.make(sessionID)))
        .orderBy(asc(SessionCheckpointTable.ordinal))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row
    })

    const worktreeStats = Effect.fn("Checkpoint.Read.worktreeStats")(function* (epoch: string, mine: string) {
      const where = and(
        eq(SessionCheckpointTable.epoch, epoch),
        ne(SessionCheckpointTable.session_id, SessionSchema.ID.make(mine)),
      )
      const counted = yield* db
        .select({ count: sql<number>`count(*)` })
        .from(SessionCheckpointTable)
        .where(where)
        .get()
        .pipe(Effect.orDie)
      const sessions = yield* db
        .selectDistinct({ id: SessionCheckpointTable.session_id })
        .from(SessionCheckpointTable)
        .where(where)
        .all()
        .pipe(Effect.orDie)
      return { checkpoints: counted?.count ?? 0, sessions: sessions.length }
    })

    const siblingSessionIDs = Effect.fn("Checkpoint.Read.siblingSessionIDs")(function* (
      epoch: string,
      excluded: readonly string[],
    ) {
      const rows = yield* db
        .selectDistinct({ id: SessionCheckpointTable.session_id })
        .from(SessionCheckpointTable)
        .where(eq(SessionCheckpointTable.epoch, epoch))
        .all()
        .pipe(Effect.orDie)
      const blocked = new Set(excluded)
      return rows.map((item) => item.id as string).filter((id) => !blocked.has(id))
    })

    return ReadService.of({
      resolveSession,
      resolveCheckpoint,
      targetByOrdinal,
      ordinals,
      list,
      search,
      exists,
      view,
      metadata,
      firstSnapshots,
      worktreeStats,
      siblingSessionIDs,
    })
  }),
)

export const readNode = makeGlobalNode({ service: ReadService, layer: checkpointReadLayer, deps: [Database.node] })
