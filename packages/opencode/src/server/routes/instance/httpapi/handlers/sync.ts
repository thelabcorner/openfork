import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { inflateCompactedHistory } from "@opencode-ai/core/database/chunk-compaction"
import { and, eq, gt, lte, or, sql } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SemanticCompactionFeature, SessionPayload } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      // Pin the response frontier first, then fetch only the missing sequence
      // ranges through that frontier. The old NOT(OR(aggregate, seq <= known))
      // predicate scanned/returned rows for every aggregate and built one SQL
      // expression proportional to the full client frontier, including
      // aggregates whose histories were already current.
      const frontiers = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
      const pending = frontiers.flatMap((frontier) => {
        const after = ctx.payload[frontier.aggregate_id] ?? -1
        return frontier.seq > after ? [{ frontier, after }] : []
      })
      const rows: Array<typeof EventTable.$inferSelect> = []
      const compactionByAggregate = new Map<string, Uint8Array>()
      // Keep each OR predicate below SQLite's bind limit even when a workspace
      // knows many thousands of aggregate frontiers. The aggregate+sequence
      // unique index serves every requested range. Read compaction metadata in
      // the same bounded batches instead of issuing one extra query per
      // aggregate during reconnect.
      const QUERY_BATCH_SIZE = 100
      for (let offset = 0; offset < pending.length; offset += QUERY_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + QUERY_BATCH_SIZE)
        const page = yield* db
          .select()
          .from(EventTable)
          .where(
            or(
              ...batch.map(({ frontier, after }) =>
                and(
                  eq(EventTable.aggregate_id, frontier.aggregate_id),
                  gt(EventTable.seq, after),
                  lte(EventTable.seq, frontier.seq),
                ),
              ),
            )!,
          )
          .all()
          .pipe(Effect.orDie)
        rows.push(...page)
        const compacted = yield* db
          .all<{ aggregate_id: string; bitmap: Uint8Array }>(sql`
            SELECT aggregate_id, bitmap
            FROM event_compaction
            WHERE aggregate_id IN (${sql.join(
              batch.map(({ frontier }) => sql`${frontier.aggregate_id}`),
              sql`,`,
            )})
          `)
          .pipe(Effect.orDie)
        for (const item of compacted) compactionByAggregate.set(item.aggregate_id, item.bitmap)
      }
      type EventRow = (typeof rows)[number]
      const byAggregate = new Map<string, EventRow[]>()
      for (const row of rows) {
        const group = byAggregate.get(row.aggregate_id)
        if (group) group.push(row)
        else byAggregate.set(row.aggregate_id, [row])
      }
      const hydratedByAggregate = new Map<string, ReadonlyArray<EventRow>>()
      for (const [aggregateID, group] of byAggregate) {
        const hydrated = yield* EventV2.rehydrateEvents(db, aggregateID, group)
        hydratedByAggregate.set(aggregateID, hydrated)
      }
      const output: Array<(typeof rows)[number]> = []
      for (const { frontier, after } of pending) {
        const contiguous = inflateCompactedHistory({
          aggregateID: frontier.aggregate_id,
          rows: hydratedByAggregate.get(frontier.aggregate_id) ?? [],
          bitmap: compactionByAggregate.get(frontier.aggregate_id),
          after,
          through: frontier.seq,
        })
        output.push(...contiguous)
      }
      return output
    })

    return handlers
      .handle("start", start)
      .handle("replay", replay)
      .handle("steal", steal)
      .handle("history", history)
  }),
)
