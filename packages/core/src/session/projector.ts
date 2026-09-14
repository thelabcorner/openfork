export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2, resolveProjectionRef } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageProjection } from "./message-projection"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageLifecycleTable,
  SessionMessageTable,
  SessionMessageToolOverlayTable,
  SessionTable,
  type SessionMessageSettlement,
} from "./sql"
import { SessionSearch } from "./search"
import { searchText, partSearchText } from "./search-text"
import type { DeepMutable } from "../schema"
import { EventValueTable } from "../event/sql"

type DatabaseService = Database.Interface["db"]

const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    // Null (not undefined) so unarchive actually clears the column — drizzle
    // skips undefined fields in `.set()`. Mirrors paused_at below.
    time_archived: info.time.archived ?? null,
    paused_at: info.pausedAt ?? null,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    // `search_text` is backed by an external-content FTS5 table. Most assistant
    // lifecycle events only mutate timing, snapshots, tool result/progress
    // state, or provider metadata; recomputing searchable text for those events
    // is wasted CPU and, more importantly, naming `search_text` in the UPDATE
    // wakes the FTS update trigger. Keep the searchable projection coupled only
    // to events that can actually change searchText(message).
    const refreshSearchText =
      event.type === SessionEvent.Shell.Ended.type ||
      event.type === SessionEvent.Text.Ended.type ||
      event.type === SessionEvent.Tool.Input.Ended.type ||
      event.type === SessionEvent.Reasoning.Ended.type
    const projectionRefs = new Map<SessionMessage.ID, string>()
    const projectionRefID = (value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 1) return undefined
      return typeof record.$cdbRef === "string" ? record.$cdbRef : undefined
    }
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      SessionMessageProjection.decodeMutableRow(db, row).pipe(
        Effect.map((message) => ({ message, ref: projectionRefID(row.data) })),
        Effect.orDie,
      )
    const releaseProjectionRef = (messageID: SessionMessage.ID) => {
      const valueID = projectionRefs.get(messageID)
      if (!valueID) return Effect.void
      projectionRefs.delete(messageID)
      return db
        .update(EventValueTable)
        .set({
          refs: sql`CASE WHEN ${EventValueTable.refs} > 0 THEN ${EventValueTable.refs} - 1 ELSE 0 END`,
        })
        .where(and(eq(EventValueTable.aggregate_id, event.data.sessionID), eq(EventValueTable.value_id, valueID)))
        .run()
        .pipe(Effect.orDie)
    }
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      const messageID = SessionMessage.ID.make(id)
      return Effect.gen(function* () {
        yield* db
          .update(SessionMessageTable)
          .set({
            type,
            time_created: DateTime.toEpochMillis(message.time.created),
            data,
            ...(refreshSearchText ? { search_text: searchText(message) } : {}),
          })
          .where(and(eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
        // OPCL rebuilds can replace projection JSON with an event_value
        // reference. A subsequent mutation materializes the canonical value
        // back inline, so release exactly that projection root in the same
        // durable transaction. GC can reclaim it later if no other direct or
        // transitive reference remains.
        yield* releaseProjectionRef(messageID)
      })
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)

    // Step lifecycle mutations are tiny but can target assistants whose
    // canonical JSON is many MiB. Keep them in a physically separate 1:1 table:
    // SQLite rewrites a table record even when only one column changes, so a
    // same-row metadata column still scales with `data` size. The sidecar keeps
    // these durable writes bounded and also leaves OPCL `$cdbRef` rows untouched.
    const patchAssistantLifecycle = Effect.fnUntraced(function* () {
      if (event.durable === undefined) return false
      if (
        event.type !== SessionEvent.Step.Streamed.type &&
        event.type !== SessionEvent.Step.Ended.type &&
        event.type !== SessionEvent.Step.Failed.type
      )
        return false

      const messageID = event.data.assistantMessageID
      const target = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.id, messageID),
            eq(SessionMessageTable.session_id, event.data.sessionID),
            eq(SessionMessageTable.type, "assistant"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!target) return true

      if (event.type === SessionEvent.Step.Streamed.type) {
        const streamedAt = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(SessionMessageLifecycleTable)
          .values({ message_id: messageID, streamed_at: streamedAt })
          .onConflictDoUpdate({
            target: SessionMessageLifecycleTable.message_id,
            set: { streamed_at: sql`coalesce(${SessionMessageLifecycleTable.streamed_at}, ${streamedAt})` },
          })
          .run()
          .pipe(Effect.orDie)
        return true
      }

      const settlement: SessionMessageSettlement =
        event.type === SessionEvent.Step.Failed.type
          ? {
              type: "failed",
              completed: DateTime.toEpochMillis(event.data.timestamp),
              error: event.data.error,
            }
          : {
              type: "ended",
              completed: DateTime.toEpochMillis(event.data.timestamp),
              finish: event.data.finish,
              cost: event.data.cost,
              tokens: event.data.tokens,
              ...(event.data.snapshot || event.data.files
                ? {
                    snapshot: {
                      end: event.data.snapshot,
                      files: event.data.files ? Array.from(event.data.files) : undefined,
                    },
                  }
                : {}),
            }
      yield* db
        .insert(SessionMessageLifecycleTable)
        .values({ message_id: messageID, settlement })
        .onConflictDoUpdate({ target: SessionMessageLifecycleTable.message_id, set: { settlement } })
        .run()
        .pipe(Effect.orDie)
      return true
    })

    if (yield* patchAssistantLifecycle()) return

    // Progress and settlement events already own the canonical tool payload in
    // the durable event log. Rewriting that same payload into the assistant row
    // duplicates large media while SQLite's one writer is held, and later tool
    // mutations repeatedly copy every earlier result in the assistant. Keep a
    // tiny event pointer instead. Cold readers overlay the pointed durable event;
    // the active runner already applies the event in memory through its
    // aggregate-local projection.
    const patchToolOverlay = Effect.fnUntraced(function* () {
      if (event.durable === undefined) return false
      if (
        event.type !== SessionEvent.Tool.Progress.type &&
        event.type !== SessionEvent.Tool.Success.type &&
        event.type !== SessionEvent.Tool.Failed.type
      )
        return false

      const messageID = event.data.assistantMessageID
      const target = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.id, messageID),
            eq(SessionMessageTable.session_id, event.data.sessionID),
            eq(SessionMessageTable.type, "assistant"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!target) return true

      if (event.type === SessionEvent.Tool.Progress.type) {
        yield* db
          .insert(SessionMessageToolOverlayTable)
          .values({ message_id: messageID, call_id: event.data.callID, progress_event_id: event.id })
          .onConflictDoUpdate({
            target: [SessionMessageToolOverlayTable.message_id, SessionMessageToolOverlayTable.call_id],
            set: { progress_event_id: event.id },
          })
          .run()
          .pipe(Effect.orDie)
        return true
      }

      yield* db
        .insert(SessionMessageToolOverlayTable)
        .values({
          message_id: messageID,
          call_id: event.data.callID,
          settlement_event_id: event.id,
        })
        .onConflictDoUpdate({
          target: [SessionMessageToolOverlayTable.message_id, SessionMessageToolOverlayTable.call_id],
          set: {
            settlement_event_id: event.id,
            // Success carries the final structured/content payload itself. The
            // prior progress event is no longer needed to reconstruct state.
            ...(event.type === SessionEvent.Tool.Success.type ? { progress_event_id: null } : {}),
          },
        })
        .run()
        .pipe(Effect.orDie)
      return true
    })

    if (yield* patchToolOverlay()) return
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const decoded = yield* decodeRow(row)
          if (decoded.ref) projectionRefs.set(SessionMessage.ID.make(row.id), decoded.ref)
          return decoded.message.type === "assistant" && !decoded.message.time.completed ? decoded.message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const decoded = yield* decodeRow(row)
          if (decoded.ref) projectionRefs.set(SessionMessage.ID.make(row.id), decoded.ref)
          return decoded.message.type === "assistant" ? decoded.message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          for (const row of rows) {
            const decoded = yield* decodeRow(row)
            const message = decoded.message
            if (message.type !== "shell" || message.callID !== callID) continue
            if (decoded.ref) projectionRefs.set(SessionMessage.ID.make(row.id), decoded.ref)
            return message
          }
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
      search_text: searchText(message),
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db, filename } = yield* Database.Service
    // Historical FTS backfill writes into the main SQLite file. Even on its
    // own connection it can contend with live app writes and consume enough
    // process time to make the server appear unhealthy, so keep it as an
    // explicit maintenance task instead of automatic startup work.
    if (SessionSearch.automaticBackfillEnabled()) {
      yield* SessionSearch.backfillPartsOnOwnConnection(filename).pipe(Effect.forkScoped, Effect.andThen(Effect.void))
    }
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            // projectID is present only on cross-project moves; drizzle skips
            // undefined fields so historical same-project moves keep the row.
            project_id: event.data.projectID,
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const data = yield* resolveProjectionRef(db, event.data.sessionID, "part.data", row.data)
          const previous = usage(data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(yield* resolveProjectionRef(db, event.data.sessionID, "part.data", row.data))
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const nextSearchText = partSearchText(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({
            id,
            message_id: messageID,
            session_id: sessionID,
            time_created: event.data.time,
            data,
            search_text: nextSearchText,
          })
          .onConflictDoUpdate({
            target: PartTable.id,
            // Avoid touching the FTS-backed column when only non-searchable
            // state changed (step metadata, tool output/result state, etc.).
            // `row.search_text` is authoritative even when OPCL has collapsed
            // `row.data` to a reference, so this comparison stays cheap and
            // does not require decoding the previous JSON payload.
            set: { data, ...(row?.search_text === nextSearchText ? {} : { search_text: nextSearchText }) },
          })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Streamed, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
