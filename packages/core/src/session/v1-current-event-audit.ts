export * as V1CurrentEventAudit from "./v1-current-event-audit"

import { createHash } from "node:crypto"
import { and, asc, eq, gt } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable, EventSequenceTable } from "../event/sql"
import { SessionV1 } from "../v1/session"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"

/**
 * Event-level lowering audit for the next migration phase. The latest V1
 * message/part projections only contain FINAL state: they do not preserve
 * historical pending→running→settled transitions. This inventory scans the
 * canonical append-only event metadata without decoding large payloads.
 *
 * Durable V1 updates require a *versioned event-lowering reducer*, not a
 * cast to current SessionEvent, and neither aggregate completion nor native
 * co-occurrence is ever treated as authority to cut over.
 */
const legacyDefinitions = SessionV1.Event.Definitions.filter((d) => d.durable)
const nativeDefinitions = SessionEvent.DurableDefinitions
const legacy = new Map(legacyDefinitions.map((d) => [
  EventV2.versionedType(d.type, d.durable!.version),
  d.type,
] as const))
const native = new Map(nativeDefinitions.map((d) => [
  EventV2.versionedType(d.type, d.durable!.version),
  d.type,
] as const))

export function classify(storedType: string) {
  const old = legacy.get(storedType)
  if (old) return {
    source: "legacy" as const,
    type: old,
    // V1 session metadata still needs V2 Session/Execution parity, while
    // message and part mutations need a full event-lowering state machine.
    category: old.startsWith("message.") ? "transcript-mutation" as const : "session-lifecycle" as const,
    requiresReplay: true,
  }
  const current = native.get(storedType)
  if (current) return {
    source: "current" as const,
    type: current,
    category: "native-event" as const,
    requiresReplay: false,
  }
  return {
    source: "unknown" as const,
    type: storedType,
    category: "unknown-version-or-event" as const,
    requiresReplay: true,
  }
}

type Reader = Pick<Database.Interface["db"], "select">
export const page = Effect.fn("V1CurrentEventAudit.page")(function* (
  db: Reader, input: {
    readonly sessionID: SessionSchema.ID
    readonly afterSeq?: number
    readonly limit?: number
  },
) {
  const limit = input.limit ?? 128
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    return yield* Effect.die(new Error("Event audit requires 1–256 rows"))
  const rows = yield* db.select({
    id: EventTable.id, seq: EventTable.seq, type: EventTable.type,
  }).from(EventTable)
    .where(and(
      eq(EventTable.aggregate_id, input.sessionID),
      input.afterSeq === undefined ? undefined : gt(EventTable.seq, input.afterSeq),
    ))
    .orderBy(asc(EventTable.seq))
    .limit(limit + 1).all().pipe(Effect.orDie)
  const head = (yield* db.select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
    .get().pipe(Effect.orDie))?.seq ?? 0
  const more = rows.length > limit
  const batch = rows.slice(0, limit)
  const items = batch.map((row) => ({
    id: row.id, seq: row.seq, ...classify(row.type),
  }))
  const fingerprint = createHash("sha256").update(JSON.stringify(
    items.map((item) => [item.id, item.seq, item.source, item.type]),
  )).digest("hex")
  return {
    items, eventSequenceHead: head,
    more,
    afterSeq: more ? batch.at(-1)?.seq : undefined,
    fingerprint,
    counts: {
      legacy: items.filter((row) => row.source === "legacy").length,
      current: items.filter((row) => row.source === "current").length,
      unknown: items.filter((row) => row.source === "unknown").length,
      legacyTranscriptMutations: items.filter((row) => row.category === "transcript-mutation").length,
    },
    // A historical event may have been compacted. Gaps cannot safely be
    // inferred as "no event" or treated as replay-completeness evidence.
    cutoverSafe: false as const,
  }
})
