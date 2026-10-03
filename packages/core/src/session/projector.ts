export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2, resolveProjectionRef } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { SessionTurnProvenance as SharedTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
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
import { SessionExecutionBoundaryTable } from "./execution-boundary.sql"
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

const legacyProvenance = (provenance: SessionMessage.Provenance): SessionV1.UserTurnProvenance =>
  provenance.owner === "user"
    ? { owner: "user", source: provenance.source }
    : {
        owner: "host",
        source: provenance.source,
        ...(provenance.sourceMessageID
          ? { sourceMessageID: SessionV1.MessageID.ascending(provenance.sourceMessageID) }
          : {}),
        ...(provenance.ref ? { ref: provenance.ref } : {}),
      }

const writeLegacyUserProjection = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: {
    readonly info: SessionV1.User
    readonly parts: readonly SessionV1.Part[]
    readonly label: string
  },
) {
  const data = messageData(input.info)
  const existingMessage = yield* db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.id, input.info.id))
    .get()
    .pipe(Effect.orDie)
  if (existingMessage) {
    if (
      existingMessage.session_id !== input.info.sessionID ||
      JSON.stringify(existingMessage.data) !== JSON.stringify(data)
    )
      return yield* Effect.die(`${input.label} V1 projection collision for ${input.info.id}`)
  } else {
    yield* db
      .insert(MessageTable)
      .values({
        id: input.info.id,
        session_id: input.info.sessionID,
        time_created: input.info.time.created,
        data,
      })
      .run()
      .pipe(Effect.orDie)
  }

  for (const part of input.parts) {
    const data = partData(part)
    const search = partSearchText(part)
    const existing = yield* db.select().from(PartTable).where(eq(PartTable.id, part.id)).get().pipe(Effect.orDie)
    if (existing) {
      if (
        existing.message_id !== part.messageID ||
        existing.session_id !== part.sessionID ||
        JSON.stringify(existing.data) !== JSON.stringify(data)
      )
        return yield* Effect.die(`${input.label} V1 part projection collision for ${part.id}`)
      continue
    }
    yield* db
      .insert(PartTable)
      .values({
        id: part.id,
        message_id: part.messageID,
        session_id: part.sessionID,
        time_created: input.info.time.created,
        data,
        search_text: search,
      })
      .run()
      .pipe(Effect.orDie)
  }
})

const projectLegacyPrompted = Effect.fnUntraced(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Prompted.Type,
) {
  // V1 prompt admission materializes the mature legacy transcript before it is
  // promoted from SessionInput. When that durable input is later drained, the
  // Prompted event owns the current semantic projection but must not attempt to
  // recreate the already-authoritative V1 row (whose richer fields may include
  // tools/system/format selections absent from the current Prompt contract).
  const existingLegacy = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.id, SessionV1.MessageID.ascending(event.data.messageID)),
        eq(MessageTable.session_id, event.data.sessionID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (existingLegacy) return

  const session = yield* db
    .select({ agent: SessionTable.agent, model: SessionTable.model })
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session?.agent || !session.model) return
  // Historical current events can predate mandatory provenance. The V1
  // execution adapter must not invent user/host authority for them from shape.
  // New SessionInput admissions always stamp provenance before promotion.
  if (!event.data.provenance) return

  const id = SessionV1.MessageID.ascending(event.data.messageID)
  const info: SessionV1.User = {
    id,
    sessionID: event.data.sessionID,
    role: "user",
    provenance: legacyProvenance(event.data.provenance),
    time: { created: DateTime.toEpochMillis(event.data.timestamp) },
    agent: session.agent,
    model: {
      providerID: ProviderV2.ID.make(session.model.providerID),
      modelID: ModelV2.ID.make(session.model.id),
      ...(session.model.variant ? { variant: session.model.variant } : {}),
    },
  }
  const parts: SessionV1.Part[] = [
    ...(event.data.prompt.text.length > 0
      ? ([
          {
            id: SessionV1.PartID.ascending(`prt_prompt_${String(id).slice(4)}_text`),
            messageID: id,
            sessionID: event.data.sessionID,
            type: "text",
            text: event.data.prompt.text,
          } satisfies SessionV1.TextPart,
        ] as const)
      : []),
    ...(event.data.prompt.files ?? []).map(
      (file, index): SessionV1.FilePart => ({
        id: SessionV1.PartID.ascending(`prt_prompt_${String(id).slice(4)}_file_${index}`),
        messageID: id,
        sessionID: event.data.sessionID,
        type: "file",
        mime: file.mime,
        ...(file.name ? { filename: file.name } : {}),
        url: file.uri,
      }),
    ),
    ...(event.data.prompt.agents ?? []).map(
      (agent, index): SessionV1.AgentPart => ({
        id: SessionV1.PartID.ascending(`prt_prompt_${String(id).slice(4)}_agent_${index}`),
        messageID: id,
        sessionID: event.data.sessionID,
        type: "agent",
        name: agent.name,
        ...(agent.source
          ? { source: { value: agent.source.text, start: agent.source.start, end: agent.source.end } }
          : {}),
      }),
    ),
  ]
  yield* writeLegacyUserProjection(db, { info, parts, label: "Prompted" })
})

/**
 * Compatibility lowering for the mature V1 execution runtime.
 *
 * The durable fact remains one current `SyntheticPromoted` event and one
 * current semantic `SessionMessage.Synthetic`. V1 still consumes its legacy
 * message/part projection, so SessionProjector lowers the same event into a
 * provider-user-shaped V1 turn here. Swarm and other producers never dual-write
 * transcript history themselves.
 */
const projectLegacySynthetic = Effect.fnUntraced(function* (
  db: DatabaseService,
  event: typeof SessionEvent.SyntheticPromoted.Type,
) {
  const session = yield* db
    .select({ agent: SessionTable.agent, model: SessionTable.model })
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.sessionID))
    .get()
    .pipe(Effect.orDie)

  // SyntheticExecution is the turn-owned execution identity for trusted
  // producers. Older producers predate that field and continue to inherit the
  // Session's current agent/model as a compatibility fallback.
  const execution =
    event.data.execution ??
    (session?.agent && session.model
      ? {
          agent: session.agent,
          model: {
            id: ModelV2.ID.make(session.model.id),
            providerID: ProviderV2.ID.make(session.model.providerID),
            ...(session.model.accountID ? { accountID: session.model.accountID } : {}),
            ...(session.model.variant && session.model.variant !== "default"
              ? { variant: session.model.variant as never }
              : {}),
          },
        }
      : undefined)
  // Current-only Sessions with neither explicit Synthetic execution identity
  // nor a V1-compatible Session selection need no legacy projection.
  if (!execution) return

  const item = SessionInput.SyntheticItem.make({
    type: "synthetic",
    content: event.data.content,
    origin: event.data.origin,
    ...(event.data.delegated === undefined ? {} : { delegated: event.data.delegated }),
    ...(event.data.execution === undefined ? {} : { execution: event.data.execution }),
  })
  const currentProvenance = SessionInput.provenanceForSynthetic(event.data.sessionID, item)
  if (currentProvenance.owner !== "host")
    return yield* Effect.die(`Synthetic projection unexpectedly resolved non-host provenance for ${event.data.messageID}`)
  const provenance = legacyProvenance(currentProvenance)
  const legacyMessageID = SessionV1.MessageID.ascending(event.data.messageID)
  const info: SessionV1.User = {
    id: legacyMessageID,
    sessionID: event.data.sessionID,
    role: "user",
    provenance,
    time: { created: DateTime.toEpochMillis(event.data.timestamp) },
    agent: execution.agent,
    model: {
      providerID: execution.model.providerID,
      modelID: execution.model.id,
      ...(execution.model.accountID ? { accountID: execution.model.accountID } : {}),
      ...(execution.model.variant ? { variant: execution.model.variant } : {}),
    },
  }
  const parts: SessionV1.Part[] = [
    {
      id: SessionV1.PartID.ascending(`prt_synthetic_${String(info.id).slice(4)}_text`),
      messageID: info.id,
      sessionID: info.sessionID,
      type: "text",
      text: event.data.content.text,
      synthetic: true,
    },
    ...(event.data.content.files ?? []).map(
      (file, index): SessionV1.FilePart => ({
        id: SessionV1.PartID.ascending(`prt_synthetic_${String(info.id).slice(4)}_file_${index}`),
        messageID: info.id,
        sessionID: info.sessionID,
        type: "file",
        mime: file.mime,
        ...(file.name ? { filename: file.name } : {}),
        url: file.uri,
      }),
    ),
  ]
  yield* writeLegacyUserProjection(db, { info, parts, label: "Synthetic" })
})

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
        .select({ id: SessionMessageTable.id, data: SessionMessageTable.data })
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

      // A prior OPCL rebuild may have collapsed the canonical assistant JSON to
      // an event_value reference. Lifecycle-only mutations must remain entirely
      // in the sidecar and therefore must not materialize/release that root.
      // Remember it here so the cold-reader overlay can decode the referenced
      // canonical payload without routing through updateMessage().
      const targetRef = projectionRefID(target.data)
      if (targetRef) projectionRefs.set(SessionMessage.ID.make(target.id), targetRef)

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

    // Tool call existence plus progress/settlement events already own the canonical tool payload in
    // the durable event log. Rewriting that same payload into the assistant row
    // duplicates large media while SQLite's one writer is held, and later tool
    // mutations repeatedly copy every earlier result in the assistant. Keep a
    // tiny event pointer instead. Cold readers overlay the pointed durable event;
    // the active runner already applies the event in memory through its
    // aggregate-local projection.
    const patchToolOverlay = Effect.fnUntraced(function* () {
      if (event.durable === undefined) return false
      if (
        event.type !== SessionEvent.Tool.Called.type &&
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

      if (event.type === SessionEvent.Tool.Called.type) {
        // Persist the unresolved call key immediately. A hard crash can happen
        // before the first progress event, and recovery must still discover that
        // outcome-uncertain call without scanning/decoding Session history.
        yield* db
          .insert(SessionMessageToolOverlayTable)
          .values({ message_id: messageID, call_id: event.data.callID })
          .onConflictDoNothing({
            target: [SessionMessageToolOverlayTable.message_id, SessionMessageToolOverlayTable.call_id],
          })
          .run()
          .pipe(Effect.orDie)
        return false
      }

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
    yield* events.project(SessionEvent.ExecutionBoundaryUpdated, (event) =>
      db
        .insert(SessionExecutionBoundaryTable)
        .values({
          session_id: event.data.sessionID,
          boundary: event.data.boundary,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .onConflictDoUpdate({
          target: SessionExecutionBoundaryTable.session_id,
          set: {
            boundary: event.data.boundary,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          },
        })
        .run()
        .pipe(Effect.orDie),
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
        if (
          event.durable !== undefined &&
          event.data.info.role === "user" &&
          event.data.info.provenance?.owner === "user" &&
          SharedTurnProvenance.policy(event.data.info.provenance.source)?.kind === "user"
        ) {
          yield* SessionInput.projectLegacyUserAdmission(db, {
            seq: event.durable.seq,
            id: SessionMessage.ID.make(event.data.info.id),
            sessionID: SessionSchema.ID.make(sessionID),
            provenance: {
              owner: "user",
              source: event.data.info.provenance.source,
            },
            timeCreated: time_created,
          })
        }
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
          provenance: event.data.provenance,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
        yield* projectLegacyPrompted(db, event)
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
          provenance: event.data.provenance,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.SyntheticAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectSyntheticAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          content: event.data.content,
          origin: event.data.origin,
          delegated: event.data.delegated,
          execution: event.data.execution,
          delivery: event.data.delivery,
          admissionClass: event.data.admissionClass,
          userPreemptible: event.data.userPreemptible,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.SyntheticPromoted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectSyntheticPromoted(db, {
          promotedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          content: event.data.content,
          origin: event.data.origin,
          delegated: event.data.delegated,
          execution: event.data.execution,
          delivery: event.data.delivery,
          admissionClass: event.data.admissionClass,
          userPreemptible: event.data.userPreemptible,
          timeCreated: event.data.timestamp,
        })
        yield* run(db, event)
        yield* projectLegacySynthetic(db, event)
      }),
    )
    yield* events.project(SessionEvent.SyntheticRevoked, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectSyntheticRevoked(db, {
          revokedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          reason: event.data.reason,
        })
      }),
    )
    yield* events.project(SessionEvent.InputCompleted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectInputCompleted(db, {
          completedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
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
