export * as SessionContextEpoch from "./context-epoch"

import type { EffectiveSystemMessageCapability } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { SystemProjection } from "../system-projection"
import { SystemSurface } from "../system-surface"
import { SessionContextEpochState } from "./context-epoch-state"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type DatabaseWriter = Pick<DatabaseService, "update">

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
}

export function initialize(
  db: DatabaseService,
  surface: Effect.Effect<SystemSurface.ReconcileInput>,
  sessionID: SessionSchema.ID,
  readDb: DatabaseService = db,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return initializeOnce(db, readDb, surface, sessionID).pipe(Effect.withSpan("SessionContextEpoch.initialize"))
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  surface: Effect.Effect<SystemSurface.ReconcileInput>,
  sessionID: SessionSchema.ID,
  capability: EffectiveSystemMessageCapability,
  readDb: DatabaseService = db,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError> {
  return prepareOnce(db, readDb, events, surface, sessionID, capability).pipe(
    Effect.withSpan("SessionContextEpoch.prepare"),
  )
}

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  readDb: DatabaseService,
  events: EventV2.Interface,
  surface: Effect.Effect<SystemSurface.ReconcileInput>,
  sessionID: SessionSchema.ID,
  capability: EffectiveSystemMessageCapability,
) {
  const [observed, stored, compaction] = yield* Effect.all(
    [surface, find(readDb, sessionID), SessionHistory.latestCompaction(readDb, sessionID)],
    { concurrency: "unbounded" },
  )
  if (!stored) {
    const ready = yield* requireReady(SystemSurface.reconcile(observed))
    return yield* insertInitial(db, sessionID, ready.snapshot)
  }

  const decoded = yield* decodeStored(sessionID, stored.snapshot)
  if (decoded._tag === "Legacy") {
    // Legacy snapshots persisted typed domain values and source-authored
    // delta/removal strings, not exact admitted section bytes. Translate by
    // observing the current complete surface once and rebasing, never by
    // reverse-engineering provider semantics from those historical values.
    const ready = yield* requireReady(SystemSurface.reconcile(observed))
    return yield* rebaseline(db, sessionID, ready.snapshot)
  }

  const previous = decoded.checkpoint
  const ready = yield* requireReady(SystemSurface.reconcile(observed, previous.surface))
  const completedCompaction = compaction !== undefined && compaction.seq > stored.baseline_seq
  const historyCapabilityChanged =
    previous.projection.historyActive && previous.projection.history !== capability.history

  // `baseline_seq` is the chronological-System floor, not the ordinary
  // conversation floor. Rebaseline to the complete current surface whenever a
  // retained System suffix would otherwise be interpreted under different
  // semantics, or after conversation compaction.
  if (completedCompaction || historyCapabilityChanged) return yield* rebaseline(db, sessionID, ready.snapshot)

  const witness = SystemProjection.seal({ result: ready, capability, previous: previous.surface })
  if (witness.plan.type === "none") {
    if (ready.checkpointChanged) yield* advance(db, sessionID, { ...previous, surface: ready.snapshot })
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
  }

  if (witness.plan.type === "head") return yield* rebaseline(db, sessionID, ready.snapshot)

  if (capability.history === "head-only")
    return yield* Effect.die("Head-only System capability produced a chronological projection")
  const checkpoint = SessionContextEpochState.active(ready.snapshot, capability.history)

  yield* events.publish(
    SessionEvent.ContextUpdated,
    {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: yield* DateTime.now,
      text: SystemProjection.historyText(witness)!,
    },
    { commit: () => advance(db, sessionID, checkpoint).pipe(Effect.orDie) },
  )
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  readDb: DatabaseService,
  surface: Effect.Effect<SystemSurface.ReconcileInput>,
  sessionID: SessionSchema.ID,
) {
  if (yield* exists(readDb, sessionID)) return
  const ready = yield* surface.pipe(Effect.map(SystemSurface.reconcile), Effect.flatMap(requireReady))
  return yield* insertInitial(db, sessionID, ready.snapshot)
})

const requireReady = (result: SystemSurface.Result): Effect.Effect<SystemSurface.Ready, SystemContext.InitializationBlocked> =>
  result._tag === "Ready"
    ? Effect.succeed(result)
    : Effect.fail(
        new SystemContext.InitializationBlocked({
          keys: result.keys.map((key) => SystemContext.Key.make(String(key))),
        }),
      )

const decodeCheckpoint = Schema.decodeUnknownOption(SessionContextEpochState.Checkpoint)
const decodeLegacy = Schema.decodeUnknownOption(SystemContext.LegacySnapshot)

const decodeStored = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, value: unknown) {
  const checkpoint = Option.getOrUndefined(decodeCheckpoint(value))
  if (checkpoint) return { _tag: "Current" as const, checkpoint }
  const legacy = Option.getOrUndefined(decodeLegacy(value))
  if (legacy) return { _tag: "Legacy" as const }
  return yield* Schema.decodeUnknownEffect(SessionContextEpochState.Checkpoint)(value).pipe(
    Effect.map((checkpoint) => ({ _tag: "Current" as const, checkpoint })),
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const insertInitial = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  snapshot: SystemSurface.Snapshot,
) {
  const baselineSeq = yield* EventV2.latestSequence(db, sessionID)
  const baseline = SystemSurface.render(snapshot)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sessionID,
      baseline,
      snapshot: SessionContextEpochState.inactive(snapshot),
      baseline_seq: baselineSeq,
    })
    .run()
    .pipe(Effect.orDie)
  return { baseline, baselineSeq }
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseWriter,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  snapshot: SystemSurface.Snapshot,
) {
  const baseline = SystemSurface.render(snapshot)
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({
      baseline,
      snapshot: SessionContextEpochState.inactive(snapshot),
      baseline_seq: baselineSeq,
    })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
  return { baseline, baselineSeq }
})

const rebaseline = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  snapshot: SystemSurface.Snapshot,
) {
  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const baselineSeq = yield* EventV2.latestSequence(tx, sessionID)
          return yield* replace(tx, sessionID, baselineSeq, snapshot)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  snapshot: SessionContextEpochState.Checkpoint,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})
