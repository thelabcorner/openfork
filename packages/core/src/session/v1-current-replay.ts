export * as V1CurrentReplay from "./v1-current-replay"

import { and, asc, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2, rehydrateEvents } from "../event"
import { EventTable, EventSequenceTable } from "../event/sql"
import { SessionV1 } from "../v1/session"
import type { MessageID, PartID } from "../v1/session"
import { V1CurrentBridge } from "./v1-current-bridge"
import type { SessionSchema } from "./schema"
import { V1CurrentShadow } from "./v1-current-shadow"

/**
 * BOUNDED, read-only real-event replay for ONE V1 message. It derives each
 * intermediate message/part update from canonical EventTable payloads,
 * including true pending→running→settled tool transitions. A final projection
 * match is diagnostic ONLY: event compaction, non-event imports and missing
 * owner fences can all make replay incomplete. No V2 writes are produced.
 */
const tracked = {
  messageUpdated: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
  messageRemoved: EventV2.versionedType(SessionV1.Event.MessageRemoved.type, 1),
  partUpdated: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
  partRemoved: EventV2.versionedType(SessionV1.Event.PartRemoved.type, 1),
}
const types = new Set(Object.values(tracked))
const validMessage = Schema.is(SessionV1.Info)
const validPart = Schema.is(SessionV1.Part)

type Data = Record<string, unknown>
type ReplayMessage = {
  info?: SessionV1.Info
  parts: Map<PartID, SessionV1.Part>
}
export type Transition = {
  partID: PartID
  callID: string
  status: string
  seq: number
}

function apply(state: ReplayMessage, event: { seq: number; type: string; data: Data },
  sessionID: SessionSchema.ID, messageID: MessageID,
  transitions: Transition[], anomalies: string[]) {
  const data = event.data
  if (data.sessionID !== sessionID) {
    anomalies.push("foreign-event-session")
    return
  }
  if (event.type === tracked.messageUpdated) {
    const info = data.info as SessionV1.Info | undefined
    if (!info || !validMessage(info)) {
      anomalies.push("malformed-message-event")
      return
    }
    if (info.id === messageID) {
      if (info.sessionID !== sessionID) anomalies.push("foreign-message-owner")
      else state.info = info
    }
  } else if (event.type === tracked.messageRemoved) {
    if (typeof data.messageID !== "string") {
      anomalies.push("malformed-message-removal")
      return
    }
    if (data.messageID === messageID) {
      state.info = undefined
      state.parts.clear()
    }
  } else if (event.type === tracked.partUpdated) {
    const part = data.part as SessionV1.Part | undefined
    if (!part || !validPart(part)) {
      anomalies.push("malformed-part-event")
      return
    }
    if (part.messageID !== messageID) return
    if (part.sessionID !== sessionID) {
      anomalies.push("foreign-part-owner")
      return
    }
    const previous = state.parts.get(part.id)
    if (previous?.type === "tool" && part.type === "tool") {
      if (previous.callID !== part.callID) anomalies.push("tool-call-identity-mutated")
      const oldSettled = previous.state.status === "completed" || previous.state.status === "error"
      if (oldSettled && (part.state.status === "pending" || part.state.status === "running"))
        anomalies.push("tool-resumed-after-settlement")
    } else if (previous && previous.type !== part.type) {
      anomalies.push("part-type-changed")
    }
    state.parts.set(part.id, part)
    if (part.type === "tool")
      transitions.push({ seq: event.seq, partID: part.id, callID: part.callID, status: part.state.status })
  } else if (event.type === tracked.partRemoved) {
    if (typeof data.messageID !== "string" || typeof data.partID !== "string") {
      anomalies.push("malformed-part-removal")
      return
    }
    if (data.messageID === messageID) state.parts.delete(data.partID as PartID)
  }
}

export const probe = Effect.fn("V1CurrentReplay.probe")(function* (
  db: Database.Interface["db"],
  input: { sessionID: SessionSchema.ID; messageID: MessageID; maxEvents?: number },
) {
  const maxEvents = input.maxEvents ?? 128
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 256)
    return yield* Effect.die(new Error("V1 replay probe limit must be 1–256 events"))
  // One snapshot covers event metadata, rehydrated history and final
  // canonical V1 projection; independent reads would be a torn comparison.
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const events = yield* tx.select({
      id: EventTable.id, seq: EventTable.seq, type: EventTable.type,
    }).from(EventTable)
      .where(eq(EventTable.aggregate_id, input.sessionID))
      .orderBy(asc(EventTable.seq)).limit(maxEvents + 1).all().pipe(Effect.orDie)
    const truncated = events.length > maxEvents
    const span = events.slice(0, maxEvents)
    const head = (yield* tx.select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
      .get().pipe(Effect.orDie))?.seq ?? 0
    const selected = span.filter((row) => types.has(row.type))
    const payloadRows = selected.length ? yield* tx.select().from(EventTable)
      .where(inArray(EventTable.id, selected.map((row) => row.id)))
      .orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie) : []
    const rehydrated = yield* rehydrateEvents(tx, input.sessionID, payloadRows)
    const state: ReplayMessage = { parts: new Map() }
    const transitions: Transition[] = []
    const anomalies: string[] = []
    // Unknown versioned transcript events might mutate V1 semantics. They
    // cannot be safely classified as inert just because this reducer does not
    // yet know their schema (even if the final snapshot happens to match).
    if (span.some((row) =>
      row.type.startsWith("message.") && !types.has(row.type)))
      anomalies.push("unknown-transcript-event-version")
    for (const row of rehydrated)
      apply(state, row, input.sessionID, input.messageID, transitions, anomalies)

    const discontinuous = (span.at(0)?.seq ?? 1) !== 1 ||
      span.some((row, i) => i > 0 && row.seq !== span[i - 1]!.seq + 1) ||
      (!truncated && (span.at(-1)?.seq ?? 0) !== head)
    const partial = truncated || discontinuous || span.length === 0
    const source = yield* V1CurrentShadow.currentSource(tx, input)
    const replay = state.info ? {
      info: state.info,
      // Match SQLite BINARY collation, not localeCompare()'s language-aware
      // case ordering. Mixed-case base62 PartIDs otherwise produce false
      // source-digest mismatches even when all events faithfully replay.
      parts: [...state.parts.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    } satisfies SessionV1.WithParts : undefined
    const replayHash = replay
      ? yield* Effect.sync(() => V1CurrentBridge.digest(replay))
      : undefined
    const matches = (replayHash !== undefined && source.status === "present" &&
      replayHash === source.sourceHash) ||
      (!replay && source.status === "missing")
    return {
      status: anomalies.length ? "anomaly" as const
        : partial ? "partial" as const
        : matches ? "matches" as const : "mismatch" as const,
      processedEvents: span.length,
      relevantEvents: selected.length,
      eventSequenceHead: head,
      partial, anomalies, transitions,
      currentSourceHash: source.status === "present" ? source.sourceHash : undefined,
      replayHash,
      cutoverSafe: false as const,
    }
  })).pipe(Effect.orDie)
})
