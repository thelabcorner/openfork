export * as SessionMessageProjection from "./message-projection"

import { inArray } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2, rehydrateEvents, resolveProjectionRef } from "../event"
import { EventTable } from "../event/sql"
import { MessageDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageLifecycleTable, SessionMessageTable, SessionMessageToolOverlayTable } from "./sql"

type DatabaseService = Pick<Database.Interface["db"], "select">
export type Row = typeof SessionMessageTable.$inferSelect
type LifecycleRow = typeof SessionMessageLifecycleTable.$inferSelect
type ToolOverlayRow = typeof SessionMessageToolOverlayTable.$inferSelect
type StoredEventRow = typeof EventTable.$inferSelect

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
const decodeProgress = Schema.decodeUnknownEffect(SessionEvent.Tool.Progress.data)
const decodeSuccess = Schema.decodeUnknownEffect(SessionEvent.Tool.Success.data)
const decodeFailed = Schema.decodeUnknownEffect(SessionEvent.Tool.Failed.data)

const progressType = EventV2.versionedType(SessionEvent.Tool.Progress.type, 1)
const successType = EventV2.versionedType(SessionEvent.Tool.Success.type, 1)
const failedType = EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)

function messageDecodeError(row: Row) {
  return new MessageDecodeError({
    sessionID: SessionSchema.ID.make(row.session_id),
    messageID: SessionMessage.ID.make(row.id),
  })
}

function overlayLifecycle(message: SessionMessage.Message, lifecycle: LifecycleRow | undefined): SessionMessage.Message {
  if (message.type !== "assistant") return message

  const streamedAt =
    lifecycle?.streamed_at == null ? message.time.streamedAt : DateTime.makeUnsafe(lifecycle.streamed_at)
  const settlement = lifecycle?.settlement
  if (!settlement) {
    if (streamedAt === message.time.streamedAt) return message
    return { ...message, time: { ...message.time, streamedAt } }
  }

  if (settlement.type === "failed") {
    return {
      ...message,
      finish: "error",
      error: settlement.error,
      time: {
        ...message.time,
        streamedAt,
        completed: DateTime.makeUnsafe(settlement.completed),
      },
    }
  }

  return {
    ...message,
    finish: settlement.finish,
    cost: settlement.cost,
    tokens: settlement.tokens,
    ...(settlement.snapshot === undefined
      ? {}
      : {
          snapshot: {
            ...message.snapshot,
            end: settlement.snapshot.end,
            files: settlement.snapshot.files,
          },
        }),
    time: {
      ...message.time,
      streamedAt,
      completed: DateTime.makeUnsafe(settlement.completed),
    },
  }
}

const decodeToolPayload = <A>(
  row: Row,
  event: StoredEventRow | undefined,
  expectedType: string,
  schema: (input: unknown) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    if (!event || event.type !== expectedType) return yield* Effect.fail(messageDecodeError(row))
    return yield* schema(event.data).pipe(Effect.mapError(() => messageDecodeError(row)))
  })

const overlayTools = Effect.fnUntraced(function* (
  row: Row,
  message: SessionMessage.Message,
  overlays: readonly ToolOverlayRow[],
  events: ReadonlyMap<string, StoredEventRow>,
) {
  if (message.type !== "assistant" || overlays.length === 0) return message
  const byCall = new Map(overlays.map((overlay) => [overlay.call_id, overlay] as const))
  let changed = false
  const content: Array<SessionMessage.Assistant["content"][number]> = []

  for (const part of message.content) {
    if (part.type !== "tool") {
      content.push(part)
      continue
    }
    const overlay = byCall.get(part.id)
    if (!overlay) {
      content.push(part)
      continue
    }

    let next = part
    if (overlay.progress_event_id && next.state.status === "running") {
      const progress = yield* decodeToolPayload(
        row,
        events.get(overlay.progress_event_id),
        progressType,
        decodeProgress,
      )
      next = {
        ...next,
        state: SessionMessage.ToolStateRunning.make({
          status: "running",
          input: next.state.input,
          structured: progress.structured,
          content: [...progress.content],
        }),
      }
      changed = true
    }

    if (overlay.settlement_event_id) {
      const settlementEvent = events.get(overlay.settlement_event_id)
      if (!settlementEvent) return yield* Effect.fail(messageDecodeError(row))
      if (settlementEvent.type === successType) {
        const success = yield* decodeSuccess(settlementEvent.data).pipe(Effect.mapError(() => messageDecodeError(row)))
        const input = typeof next.state.input === "string" ? {} : next.state.input
        next = {
          ...next,
          provider: {
            executed: success.provider.executed || next.provider?.executed === true,
            metadata: next.provider?.metadata,
            resultMetadata: success.provider.metadata,
          },
          time: { ...next.time, completed: success.timestamp },
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input,
            structured: success.structured,
            content: [...success.content],
            outputPaths: success.outputPaths ? [...success.outputPaths] : [],
            result: success.result,
          }),
        }
        changed = true
      } else if (settlementEvent.type === failedType) {
        const failed = yield* decodeFailed(settlementEvent.data).pipe(Effect.mapError(() => messageDecodeError(row)))
        const input = typeof next.state.input === "string" ? {} : next.state.input
        next = {
          ...next,
          provider: {
            executed: failed.provider.executed || next.provider?.executed === true,
            metadata: next.provider?.metadata,
            resultMetadata: failed.provider.metadata,
          },
          time: { ...next.time, completed: failed.timestamp },
          state: SessionMessage.ToolStateError.make({
            status: "error",
            error: failed.error,
            input,
            structured: next.state.status === "running" ? next.state.structured : {},
            content: next.state.status === "running" ? [...next.state.content] : [],
            result: failed.result,
          }),
        }
        changed = true
      } else {
        return yield* Effect.fail(messageDecodeError(row))
      }
    }
    content.push(next)
  }

  return changed ? { ...message, content } : message
})

const loadSidecars = Effect.fnUntraced(function* (db: DatabaseService, rows: readonly Row[]) {
  const lifecycleRows: LifecycleRow[] = []
  const toolRows: ToolOverlayRow[] = []
  const ids = rows.map((row) => row.id)
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500)
    const [lifecycle, tools] = yield* Effect.all(
      [
        db.select().from(SessionMessageLifecycleTable).where(inArray(SessionMessageLifecycleTable.message_id, chunk)).all(),
        db.select().from(SessionMessageToolOverlayTable).where(inArray(SessionMessageToolOverlayTable.message_id, chunk)).all(),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.orDie)
    lifecycleRows.push(...lifecycle)
    toolRows.push(...tools)
    if (offset + 500 < ids.length) yield* Effect.yieldNow
  }

  const eventIDs = Array.from(
    new Set(toolRows.flatMap((tool) => [tool.progress_event_id, tool.settlement_event_id]).filter((id): id is string => !!id)),
  )
  const stored: StoredEventRow[] = []
  for (let offset = 0; offset < eventIDs.length; offset += 500) {
    const chunk = eventIDs.slice(offset, offset + 500).map((id) => EventV2.ID.make(id))
    stored.push(...(yield* db.select().from(EventTable).where(inArray(EventTable.id, chunk)).all().pipe(Effect.orDie)))
    if (offset + 500 < eventIDs.length) yield* Effect.yieldNow
  }

  const byAggregate = new Map<string, StoredEventRow[]>()
  for (const event of stored) {
    const list = byAggregate.get(event.aggregate_id) ?? []
    list.push(event)
    byAggregate.set(event.aggregate_id, list)
  }
  const hydrated: StoredEventRow[] = []
  for (const [aggregateID, aggregateRows] of byAggregate) {
    hydrated.push(...(yield* rehydrateEvents(db, aggregateID, aggregateRows)))
  }

  return {
    lifecycle: new Map(lifecycleRows.map((lifecycle) => [lifecycle.message_id, lifecycle] as const)),
    tools: Map.groupBy(toolRows, (tool) => tool.message_id),
    events: new Map(hydrated.map((event) => [event.id, event] as const)),
  }
})

const decodeStored = Effect.fnUntraced(function* (
  db: DatabaseService,
  row: Row,
  lifecycle: LifecycleRow | undefined,
  toolOverlays: readonly ToolOverlayRow[],
  toolEvents: ReadonlyMap<string, StoredEventRow>,
) {
  const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", row.data)
  const message = yield* decode({ ...(data as Record<string, unknown>), id: row.id, type: row.type }).pipe(
    Effect.mapError(() => messageDecodeError(row)),
  )
  return overlayLifecycle(yield* overlayTools(row, message, toolOverlays, toolEvents), lifecycle)
})

const decodeBaseStored = Effect.fnUntraced(function* (db: DatabaseService, row: Row) {
  const data = yield* resolveProjectionRef(db, row.session_id, "session_message.data", row.data)
  return yield* decode({ ...(data as Record<string, unknown>), id: row.id, type: row.type }).pipe(
    Effect.mapError(() => messageDecodeError(row)),
  )
})

/**
 * Decode the mutable assistant base without materializing tool-output overlays.
 *
 * Projector mutations must use this view: otherwise starting a later tool would
 * copy every previous multi-MiB Tool.Success overlay back into
 * `session_message.data` and recreate the historical-amplification convoy. The
 * tiny lifecycle overlay is retained so a settled prior assistant is not
 * mistaken for the current incomplete assistant at the next Step.Started.
 */
export const decodeMutableRow = Effect.fn("SessionMessageProjection.decodeMutableRow")(function* (
  db: DatabaseService,
  row: Row,
) {
  const lifecycle = yield* db
    .select()
    .from(SessionMessageLifecycleTable)
    .where(inArray(SessionMessageLifecycleTable.message_id, [row.id]))
    .get()
    .pipe(Effect.orDie)
  return overlayLifecycle(yield* decodeBaseStored(db, row), lifecycle)
})

/** Decode one projected Session message, including OPCL and lifecycle/tool overlays. */
export const decodeRow = Effect.fn("SessionMessageProjection.decodeRow")(function* (db: DatabaseService, row: Row) {
  const sidecars = yield* loadSidecars(db, [row])
  return yield* decodeStored(
    db,
    row,
    sidecars.lifecycle.get(row.id),
    sidecars.tools.get(row.id) ?? [],
    sidecars.events,
  )
})

/** Batch decode without N+1 sidecar/event lookups for history/timeline reads. */
export const decodeRows = Effect.fn("SessionMessageProjection.decodeRows")(function* (
  db: DatabaseService,
  rows: readonly Row[],
) {
  if (rows.length === 0) return [] as SessionMessage.Message[]
  const sidecars = yield* loadSidecars(db, rows)
  const messages: SessionMessage.Message[] = []
  // Schema decode and optional ChunkDB rehydration are synchronous for ordinary
  // rows. A pathological history must not occupy one event-loop turn for
  // hundreds of milliseconds and prevent an unrelated session from reaching
  // its provider. Keep the read snapshot open, but cooperatively yield between
  // small decode slices. WAL readers do not block the writer while suspended.
  const decodeSlice = 64
  for (let offset = 0; offset < rows.length; offset += decodeSlice) {
    const end = Math.min(rows.length, offset + decodeSlice)
    for (let index = offset; index < end; index++) {
      const row = rows[index]!
      messages.push(
        yield* decodeStored(
          db,
          row,
          sidecars.lifecycle.get(row.id),
          sidecars.tools.get(row.id) ?? [],
          sidecars.events,
        ),
      )
    }
    if (end < rows.length) yield* Effect.yieldNow
  }
  return messages
})
