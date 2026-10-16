import { SessionID, MessageID, PartID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { isUnavailableReasoningSentinel } from "@opencode-ai/core/reasoning-sentinel"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@opencode-ai/core/v1/session"

import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import {
  legacyPartKind,
  legacyPartStatus,
  legacyPartSigned,
  legacyPartOpaque,
} from "@opencode-ai/core/session/legacy-part-query"
import { SessionMessage as CurrentSessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { SessionTurnProvenance as SharedTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { hasUsableCompactionCheckpoint } from "./compaction-checkpoint"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrateRows(rows: (typeof MessageTable.$inferSelect)[], partRows: (typeof PartTable.$inferSelect)[]) {
  const partByMessage = new Map<string, Part[]>()
  for (const row of partRows) {
    const next = part(row)
    const list = partByMessage.get(row.message_id)
    if (list) list.push(next)
    else partByMessage.set(row.message_id, [next])
  }
  return rows.map((row) => ({
    info: info(row),
    parts: partByMessage.get(row.id) ?? [],
  }))
}

function hydrate(db: Pick<Database.Interface["db"], "select">, rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  return Effect.gen(function* () {
    if (!ids.length) return []
    const partRows = yield* db
      .select()
      .from(PartTable)
      .where(inArray(PartTable.message_id, ids))
      .orderBy(PartTable.message_id, PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return hydrateRows(rows, partRows)
  })
}

function hydrateSession(db: Pick<Database.Interface["db"], "select">, sessionID: SessionID, rows: (typeof MessageTable.$inferSelect)[]) {
  return Effect.gen(function* () {
    if (!rows.length) return []
    // The session predicate keeps SQLite bind count independent of transcript
    // length. PartTable.session_id is indexed for this snapshot query.
    const partRows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, sessionID))
      .orderBy(PartTable.message_id, PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return hydrateRows(rows, partRows)
  })
}

/**
 * A V1 prompt drain owns one legacy history projection. The legacy Message and
 * Part tables remain authoritative for V1 execution; durable V1 events update
 * this in-memory view after the initial consistent SQLite snapshot. This
 * avoids paging and hydrating the full transcript on every provider/tool step.
 */
export const makeDrainHistory = Effect.fn("MessageV2.makeDrainHistory")(function* (input: {
  readonly sessionID: SessionID
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
}) {
  let messages: WithParts[] | undefined
  const indexByID = new Map<MessageID, number>()
  let frontier = -1
  let loading = true
  let stale = false
  let overflowed = false
  let historyRevision = 0
  let compactedRevision = -1
  let compactedHistory: WithParts[] | undefined
  const buffered: EventV2.Payload[] = []
  const pendingBySeq = new Map<number, EventV2.Payload>()
  const buffer = (event: EventV2.Payload) => {
    if (buffered.length >= 2048) {
      buffered.length = 0
      overflowed = true
      stale = true
      return
    }
    buffered.push(event)
  }

  const compare = (left: WithParts, right: WithParts) => {
    const time = right.info.time.created - left.info.time.created
    if (time !== 0) return time
    return left.info.id === right.info.id ? 0 : left.info.id > right.info.id ? -1 : 1
  }
  const insert = (message: WithParts) => {
    let low = 0
    let high = messages!.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (compare(messages![middle]!, message) <= 0) low = middle + 1
      else high = middle
    }
    messages!.splice(low, 0, message)
    for (let index = low; index < messages!.length; index++) indexByID.set(messages![index]!.info.id, index)
  }

  const applyOne = (event: EventV2.Payload) => {
    const seq = event.durable?.seq
    if (seq === undefined || seq !== frontier + 1) return
    frontier = seq
    if (stale || !messages) return
    const data = event.data as { readonly sessionID?: string }
    if (data.sessionID !== input.sessionID) return
    // `filterCompacted` scans and allocates across the full transcript. The
    // prompt loop may ask for history several times at the same safe boundary
    // (for example after reconciliation reports no changes), so memoize this
    // derived order until the durable projection actually changes.
    historyRevision++
    compactedHistory = undefined

    switch (event.type) {
      case SessionV1.Event.MessageUpdated.type: {
        const value = event.data as typeof SessionV1.Event.MessageUpdated.Type["data"]
        const currentIndex = indexByID.get(value.info.id)
        const current = currentIndex === undefined ? undefined : messages[currentIndex]
        const next = { info: value.info as unknown as Info, parts: current?.parts ?? [] } satisfies WithParts
        if (!current) insert(next)
        else if (current.info.time.created !== next.info.time.created) {
          const index = indexByID.get(value.info.id)
          if (index !== undefined) {
            messages.splice(index, 1)
            indexByID.delete(value.info.id)
            for (let cursor = index; cursor < messages.length; cursor++) indexByID.set(messages[cursor]!.info.id, cursor)
          }
          insert(next)
        } else {
          const index = indexByID.get(value.info.id)
          if (index === undefined) {
            stale = true
            return
          }
          messages[index] = next
        }
        return
      }
      case SessionV1.Event.PartUpdated.type: {
        const value = event.data as typeof SessionV1.Event.PartUpdated.Type["data"]
        const messageIndex = indexByID.get(value.part.messageID)
        const message = messageIndex === undefined ? undefined : messages[messageIndex]
        if (!message) {
          stale = true
          return
        }
        const index = message.parts.findIndex((item) => item.id === value.part.id)
        const next = value.part as unknown as Part
        if (index < 0) message.parts.push(next)
        else message.parts[index] = next
        message.parts.sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
        return
      }
      case SessionV1.Event.PartRemoved.type: {
        const value = event.data as typeof SessionV1.Event.PartRemoved.Type["data"]
        const messageIndex = indexByID.get(value.messageID)
        const message = messageIndex === undefined ? undefined : messages[messageIndex]
        if (!message) return
        message.parts = message.parts.filter((item) => item.id !== value.partID)
        return
      }
      case SessionV1.Event.MessageRemoved.type: {
        const value = event.data as typeof SessionV1.Event.MessageRemoved.Type["data"]
        const index = indexByID.get(value.messageID)
        if (index !== undefined) {
          messages.splice(index, 1)
          indexByID.delete(value.messageID)
          for (let cursor = index; cursor < messages.length; cursor++) indexByID.set(messages[cursor]!.info.id, cursor)
        }
        return
      }
      case SessionEvent.Prompted.type:
      case SessionEvent.SyntheticPromoted.type:
      case SessionEvent.RevertEvent.Committed.type:
        // These producers materialize legacy rows in their projector without
        // publishing the corresponding V1 message/part events.
        stale = true
        return
    }
  }

  const apply = (event: EventV2.Payload) => {
    const seq = event.durable?.seq
    if (seq === undefined || seq <= frontier) return
    if (seq > frontier + 1) {
      pendingBySeq.set(seq, event)
      if (pendingBySeq.size > 2048) {
        pendingBySeq.clear()
        stale = true
      }
      return
    }
    applyOne(event)
    while (!stale) {
      const next = pendingBySeq.get(frontier + 1)
      if (!next) break
      pendingBySeq.delete(frontier + 1)
      applyOne(next)
    }
  }

  const onEvent = (event: EventV2.Payload) => {
    if (loading || stale || !messages) {
      buffer(event)
      return Effect.void
    }
    return Effect.sync(() => apply(event))
  }

  const close = yield* input.events.listenAggregate(input.sessionID, onEvent)

  const reload = Effect.fnUntraced(function* () {
    loading = true
    // Events buffered before this snapshot are represented by the database
    // state at its first read. Reset first so only events racing this snapshot
    // need to be replayed or trigger another bounded reload.
    buffered.length = 0
    pendingBySeq.clear()
    overflowed = false
    const snapshot = yield* input.db.transaction((tx) =>
      Effect.gen(function* () {
        // Pair the legacy rows with the durable event frontier from one WAL
        // snapshot so listener events can be replayed without a race.
        const seq = yield* EventV2.latestSequence(tx, input.sessionID)
        const rows = yield* tx
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, input.sessionID))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .all()
          .pipe(Effect.orDie)
        const hydrated = yield* hydrateSession(tx, input.sessionID, rows)
        return { seq, messages: hydrated }
      }),
    )
    messages = snapshot.messages
    historyRevision++
    compactedHistory = undefined
    indexByID.clear()
    for (const [index, message] of messages.entries()) indexByID.set(message.info.id, index)
    frontier = snapshot.seq
    stale = false
    while (buffered.length > 0) {
      const pendingEvents = buffered.splice(0).sort((left, right) => (left.durable?.seq ?? -1) - (right.durable?.seq ?? -1))
      for (const event of pendingEvents) apply(event)
      if (stale) break
    }
    if (pendingBySeq.size > 0 && !pendingBySeq.has(frontier + 1)) stale = true
    if (overflowed) stale = true
    loading = false
  })

  const history = Effect.fn("MessageV2.drainHistory")(function* () {
    if (pendingBySeq.size > 0 && !pendingBySeq.has(frontier + 1)) stale = true
    if (!messages || stale) yield* reload()
    if (stale) yield* reload()
    if (!compactedHistory || compactedRevision !== historyRevision) {
      compactedHistory = filterCompacted(messages!)
      compactedRevision = historyRevision
    }
    return compactedHistory
  })

  return { history, close } as const
})

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function latestCompletedCompaction(msgs: readonly WithParts[]) {
  const completed = new Map<string, Set<string>>()
  for (const msg of msgs) {
    if (msg.info.role !== "assistant" || !hasUsableCompactionCheckpoint(msg)) continue
    const ids = completed.get(msg.info.parentID) ?? new Set<string>()
    ids.add(msg.info.id)
    completed.set(msg.info.parentID, ids)
  }
  let result: WithParts | undefined
  for (const msg of msgs) {
    if (msg.info.role !== "user") continue
    if (SessionTurnProvenance.isHistoricalInfo(msg.info)) continue
    const marker = msg.parts.find((part): part is CompactionPart => part.type === "compaction")
    if (!marker || marker.pending === true) continue
    const candidates = completed.get(msg.info.id)
    if (!candidates || (marker.checkpoint_message_id && !candidates.has(marker.checkpoint_message_id))) continue
    if (!result || isAfter(msg.info, result.info)) result = msg
  }
  return result
}

/**
 * STATE projections are durable append-only records, but model consumption is
 * a materialized view rather than raw event chronology. Collapse each state
 * source to its latest effective snapshot and place those snapshots immediately
 * before the active non-state user-role turn. This preserves user/host turn
 * precedence in V1 even though legacy prompt admission persists a real human
 * steer before the runner reaches its next safe reconciliation boundary.
 */
export function projectStateForModel(input: WithParts[]) {
  const reset = latestCompletedCompaction(input)
  const states = new Map<string, WithParts>()
  const ordinary: WithParts[] = []
  let activeUser: User | undefined
  for (const msg of input) {
    if (SessionTurnProvenance.hasStateSemanticsTurn(msg)) {
      // Historical/imported STATE keeps its semantic identity for replay but
      // must stay transparent to the live provider projection. Only current
      // STATE participates in the replaceable source-index below.
      if (!SessionTurnProvenance.isStateProjectionTurn(msg)) continue
      if (reset && !isAfter(msg.info, reset.info)) continue
      const provenance = msg.info.role === "user" ? msg.info.provenance : undefined
      if (provenance?.owner !== "host") continue
      const previous = states.get(provenance.source)
      if (!previous || isAfter(msg.info, previous.info)) states.set(provenance.source, msg)
      continue
    }
    ordinary.push(msg)
    if (
      msg.info.role === "user" &&
      !SessionTurnProvenance.isHistoricalInfo(msg.info) &&
      !SessionTurnProvenance.hasStateSemanticsInfo(msg.info) &&
      isAfter(msg.info, activeUser)
    )
      activeUser = msg.info
  }
  // A completed usage-limit continuation can be physically newer than user
  // messages that were already queued when the provider stopped. Once that
  // continuation is retired to historical lifetime it is no longer the active
  // structural turn, but raw timestamp order would still put its provider
  // exchange *after* the queued user on the wire. Move only those inverted,
  // historical recovery exchanges immediately before the active user. Older
  // historical rows keep their original position.
  let providerOrdinary = ordinary
  if (activeUser) {
    // Keep the overwhelmingly common no-recovery path allocation-free: only
    // allocate the Set and split arrays after an inverted recovery row exists.
    let invertedRecoveryIDs: Set<MessageID> | undefined
    for (const message of ordinary) {
      if (message.info.role !== "user" || !isAfter(message.info, activeUser)) continue
      const provenance = message.info.provenance
      if (
        provenance?.owner === "host" &&
        provenance.source === SessionTurnProvenance.Source.RecoveryContinuation &&
        provenance.lifetime === "historical"
      ) {
        ;(invertedRecoveryIDs ??= new Set()).add(message.info.id)
      }
    }
    if (invertedRecoveryIDs?.size) {
      const recoveryHistory: WithParts[] = []
      const rest: WithParts[] = []
      for (const message of ordinary) {
        const belongs =
          invertedRecoveryIDs.has(message.info.id) ||
          (message.info.role === "assistant" && invertedRecoveryIDs.has(message.info.parentID))
        ;(belongs ? recoveryHistory : rest).push(message)
      }
      const activeIndex = rest.findIndex((message) => message.info.id === activeUser!.id)
      if (activeIndex >= 0) {
        providerOrdinary = [
          ...rest.slice(0, activeIndex),
          ...recoveryHistory,
          ...rest.slice(activeIndex),
        ]
      }
    }
  }

  if (states.size === 0) return providerOrdinary
  const projected = [...states.values()].sort((a, b) => {
    const pa = a.info.role === "user" && a.info.provenance?.owner === "host" ? a.info.provenance.source : ""
    const pb = b.info.role === "user" && b.info.provenance?.owner === "host" ? b.info.provenance.source : ""
    const rank = (source: string) =>
      source === SessionTurnProvenance.Source.GoalSpecification
        ? 0
        : source === SessionTurnProvenance.Source.GoalProgress
          ? 1
          : 2
    return rank(pa) - rank(pb) || pa.localeCompare(pb)
  })
  if (!activeUser) return [...projected, ...providerOrdinary]
  const index = providerOrdinary.findIndex((message) => message.info.id === activeUser!.id)
  if (index < 0) return [...projected, ...providerOrdinary]
  return [...providerOrdinary.slice(0, index), ...projected, ...providerOrdinary.slice(index)]
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Never embed a tool attachment that the model cannot consume: the user-only
  // modality guard does not inspect nested tool results. Extract unsupported
  // media so ProviderTransform can replace it with an actionable text error,
  // preventing persistent 400 errors on every replay of a tool-bearing turn.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    const mime = attachment.mime.toLowerCase()
    if (mime.startsWith("image/") && !model.capabilities.input.image) return false
    if (mime.startsWith("video/") && !model.capabilities.input.video) return false
    if (mime.startsWith("audio/") && !model.capabilities.input.audio) return false
    if (mime === "application/pdf" && !model.capabilities.input.pdf) return false
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") {
      if (!attachment.mime.startsWith("image/")) return false
      const id = model.api.id.toLowerCase()
      return id.includes("anthropic.") || id.includes("nova") || id.includes("llama4") || id.includes("llama-4")
    }
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of projectStateForModel(input)) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            // A missing-reasoning notice is not assistant prose. Do not inject
            // provider-only placeholders into another model's conversation.
            // Same-model replay retains its provider continuation structures.
            if (part.text.trim().length > 0 && !isUnavailableReasoningSentinel(part.text))
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

/**
 * Narrow current -> V1 presentation adapter for host-owned special-agent
 * transcripts.
 *
 * Special agents persist one authoritative current Session transcript, but the
 * OpenFork desktop intentionally hydrates detail Sessions through the mature V1
 * local message contract. Do not dual-write token-rate V1 rows from the producer;
 * lower the durable current projection only when this compatibility endpoint is
 * read.
 */
export type CurrentV1Execution = {
  readonly agent?: string
  readonly model?: {
    readonly providerID: SessionV1.User["model"]["providerID"]
    readonly modelID: SessionV1.User["model"]["modelID"]
    readonly variant?: string
  }
}

const currentVisibleTypes = ["user", "synthetic", "assistant"] as const
const currentEmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function currentPartID(messageID: string, kind: string, ordinal: number) {
  return SessionV1.PartID.ascending(`prt_current_${messageID.replace(/^msg_?/, "")}_${kind}_${ordinal}`)
}

function currentMessageID(id: string) {
  return SessionV1.MessageID.ascending(id)
}

function currentEpoch(value: DateTime.Utc | undefined, fallback: number) {
  return value ? DateTime.toEpochMillis(value) : fallback
}

function currentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function currentPendingInput(raw: string) {
  try {
    return currentRecord(JSON.parse(raw))
  } catch {
    return {}
  }
}

function currentProvenance(
  provenance: CurrentSessionMessage.Provenance | undefined,
): SessionV1.UserTurnProvenance | undefined {
  if (!provenance) return
  return provenance.owner === "user"
    ? {
        owner: "user",
        source: provenance.source,
        ...(provenance.lifetime ? { lifetime: provenance.lifetime } : {}),
      }
    : {
        owner: "host",
        source: provenance.source,
        ...(provenance.sourceMessageID ? { sourceMessageID: currentMessageID(provenance.sourceMessageID) } : {}),
        ...(provenance.ref ? { ref: provenance.ref } : {}),
        ...(provenance.lifetime ? { lifetime: provenance.lifetime } : {}),
      }
}

function currentToolPart(
  sessionID: SessionID,
  messageID: SessionV1.MessageID,
  ordinal: number,
  tool: CurrentSessionMessage.AssistantTool,
): SessionV1.ToolPart {
  const start = currentEpoch(tool.time.ran, DateTime.toEpochMillis(tool.time.created))
  const end = currentEpoch(tool.time.completed, start)
  const metadata = {
    providerState: tool.provider?.metadata,
    providerResultState: tool.provider?.resultMetadata,
    providerExecuted: tool.provider?.executed,
  }
  const state: SessionV1.ToolState = (() => {
    if (tool.state.status === "pending") {
      return {
        status: "pending",
        input: currentPendingInput(tool.state.input),
        raw: tool.state.input,
      }
    }
    if (tool.state.status === "running") {
      return {
        status: "running",
        input: tool.state.input,
        title: tool.name,
        metadata: tool.state.structured,
        time: { start },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error",
        input: tool.state.input,
        error: tool.state.error.message,
        metadata: tool.state.structured,
        time: { start, end },
      }
    }
    const attachments = tool.state.content.flatMap((item, index): SessionV1.FilePart[] =>
      item.type === "file"
        ? [
            {
              id: currentPartID(messageID, `tool_${ordinal}_file`, index),
              sessionID,
              messageID,
              type: "file",
              mime: item.mime,
              filename: item.name,
              url: item.uri,
            },
          ]
        : [],
    )
    return {
      status: "completed",
      input: tool.state.input,
      output: tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
      title: tool.name,
      metadata: tool.state.structured,
      time: { start, end },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: currentPartID(messageID, "tool", ordinal),
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata,
  }
}

function currentAssistantParts(
  sessionID: SessionID,
  messageID: SessionV1.MessageID,
  message: CurrentSessionMessage.Assistant,
): SessionV1.Part[] {
  let textOrdinal = 0
  let reasoningOrdinal = 0
  let toolOrdinal = 0
  return message.content.flatMap((content): SessionV1.Part[] => {
    if (content.type === "text") {
      const ordinal = textOrdinal++
      if (!content.text.trim()) return []
      return [
        {
          id: currentPartID(messageID, "text", ordinal),
          sessionID,
          messageID,
          type: "text",
          text: content.text,
        },
      ]
    }
    if (content.type === "reasoning") {
      const ordinal = reasoningOrdinal++
      if (!content.text.trim()) return []
      const created = currentEpoch(content.time?.created, DateTime.toEpochMillis(message.time.created))
      return [
        {
          id: currentPartID(messageID, "reasoning", ordinal),
          sessionID,
          messageID,
          type: "reasoning",
          text: content.text,
          metadata: content.providerMetadata,
          time: {
            start: created,
            end: content.time?.completed ? DateTime.toEpochMillis(content.time.completed) : undefined,
          },
        },
      ]
    }
    return [currentToolPart(sessionID, messageID, toolOrdinal++, content)]
  })
}

function currentUserParts(
  sessionID: SessionID,
  messageID: SessionV1.MessageID,
  message: CurrentSessionMessage.User | CurrentSessionMessage.Synthetic,
): SessionV1.Part[] {
  const text = message.text.trim()
  const files = message.files ?? []
  return [
    ...(text
      ? [
          {
            id: currentPartID(messageID, "text", 0),
            sessionID,
            messageID,
            type: "text" as const,
            text: message.text,
            synthetic: message.type === "synthetic" ? true : undefined,
          },
        ]
      : []),
    ...files.map(
      (file, index): SessionV1.FilePart => ({
        id: currentPartID(messageID, "file", index),
        sessionID,
        messageID,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      }),
    ),
  ]
}

function executionFromAssistant(message: CurrentSessionMessage.Assistant): CurrentV1Execution {
  return {
    agent: message.agent,
    model: {
      providerID: message.model.providerID,
      modelID: message.model.id,
      ...(message.model.variant ? { variant: message.model.variant } : {}),
    },
  }
}

export function projectCurrentToV1(
  sessionID: SessionID,
  messages: readonly CurrentSessionMessage.Message[],
  options?: {
    readonly execution?: CurrentV1Execution
    readonly parentBefore?: SessionV1.MessageID
  },
): SessionV1.WithParts[] {
  let execution: CurrentV1Execution = options?.execution ?? {}
  let parentID = options?.parentBefore
  let parentInPage: SessionV1.WithParts | undefined
  const result: SessionV1.WithParts[] = []

  for (const message of messages) {
    if (message.type === "agent-switched") {
      execution = { ...execution, agent: message.agent }
      continue
    }
    if (message.type === "model-switched") {
      execution = {
        ...execution,
        model: {
          providerID: message.model.providerID,
          modelID: message.model.id,
          ...(message.model.variant ? { variant: message.model.variant } : {}),
        },
      }
      continue
    }
    if (message.type === "user" || message.type === "synthetic") {
      const id = currentMessageID(message.id)
      const info: SessionV1.User = {
        id,
        sessionID,
        role: "user",
        provenance: currentProvenance(message.provenance),
        time: { created: DateTime.toEpochMillis(message.time.created) },
        agent: execution.agent ?? "",
        model: {
          providerID: ProviderV2.ID.make(execution.model?.providerID ?? ""),
          modelID: ModelV2.ID.make(execution.model?.modelID ?? ""),
          ...(execution.model?.variant ? { variant: execution.model.variant } : {}),
        },
      }
      const current = { info, parts: currentUserParts(sessionID, id, message) } satisfies SessionV1.WithParts
      result.push(current)
      parentID = id
      parentInPage = current
      continue
    }
    if (message.type !== "assistant" || !parentID) continue

    execution = executionFromAssistant(message)
    if (parentInPage?.info.role === "user" && parentInPage.info.id === parentID) {
      parentInPage.info.agent = execution.agent ?? parentInPage.info.agent
      if (execution.model) {
        parentInPage.info.model = {
          providerID: ProviderV2.ID.make(execution.model.providerID),
          modelID: ModelV2.ID.make(execution.model.modelID),
          ...(execution.model.variant ? { variant: execution.model.variant } : {}),
        }
      }
    }

    const id = currentMessageID(message.id)
    const created = DateTime.toEpochMillis(message.time.created)
    const info: SessionV1.Assistant = {
      id,
      sessionID,
      role: "assistant",
      time: {
        created,
        ...(message.time.completed ? { completed: DateTime.toEpochMillis(message.time.completed) } : {}),
        ...(message.time.requestSentAt ? { requestSentAt: DateTime.toEpochMillis(message.time.requestSentAt) } : {}),
        ...(message.time.firstTokenAt ? { firstTokenAt: DateTime.toEpochMillis(message.time.firstTokenAt) } : {}),
        ...(message.time.streamedAt ? { streamedAt: DateTime.toEpochMillis(message.time.streamedAt) } : {}),
      },
      ...(message.error
        ? {
            error: {
              name: "UnknownError" as const,
              data: { message: message.error.message },
            },
          }
        : {}),
      parentID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      mode: message.agent,
      agent: message.agent,
      path: { cwd: "", root: "" },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? currentEmptyTokens,
      ...(message.model.variant ? { variant: message.model.variant } : {}),
      ...(message.finish ? { finish: message.finish } : {}),
    }
    result.push({ info, parts: currentAssistantParts(sessionID, id, message) })
  }

  return result
}

const currentParentBefore = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionID,
  seq: number,
) {
  const row = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        lt(SessionMessageTable.seq, seq),
        inArray(SessionMessageTable.type, ["user", "synthetic"]),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row ? currentMessageID(row.id) : undefined
})

/**
 * Decode the authoritative current/V2 transcript without lowering it through
 * V1 parent/turn semantics. Host-owned special agents may legitimately contain
 * assistant-only turns, so observability/read-only consumers must not lose
 * those rows merely because there is no conversational user parent.
 */
export const currentMessages = Effect.fn("MessageV2.currentMessages")(function* (input: {
  sessionID: SessionID
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        inArray(SessionMessageTable.type, [...currentVisibleTypes]),
      ),
    )
    .orderBy(SessionMessageTable.seq)
    .all()
    .pipe(Effect.orDie)
  return yield* SessionMessageProjection.decodeRows(db, rows).pipe(Effect.orDie)
})

export const currentAll = Effect.fn("MessageV2.currentAll")(function* (input: {
  sessionID: SessionID
  execution?: CurrentV1Execution
}) {
  const decoded = yield* currentMessages({ sessionID: input.sessionID })
  return projectCurrentToV1(input.sessionID, decoded, { execution: input.execution })
})

export const currentPage = Effect.fn("MessageV2.currentPage")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
  execution?: CurrentV1Execution
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const anchor = before
    ? yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            eq(SessionMessageTable.id, CurrentSessionMessage.ID.make(before.id)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (before && !anchor) {
    return { items: [] as SessionV1.WithParts[], more: false, cursor: undefined, windowed: [] as { messageID: string; omittedParts: number }[] }
  }

  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        inArray(SessionMessageTable.type, [...currentVisibleTypes]),
        anchor ? lt(SessionMessageTable.seq, anchor.seq) : undefined,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const oldest = slice.at(-1)
  const parentBefore = oldest ? yield* currentParentBefore(db, input.sessionID, oldest.seq) : undefined
  const decoded = yield* SessionMessageProjection.decodeRows(db, slice.toReversed()).pipe(Effect.orDie)
  const items = projectCurrentToV1(input.sessionID, decoded, { execution: input.execution, parentBefore })
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: MessageID.ascending(tail.id), time: tail.time_created }) : undefined,
    windowed: [] as { messageID: string; omittedParts: number }[],
  }
})

export const currentGet = Effect.fn("MessageV2.currentGet")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  execution?: CurrentV1Execution
}) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.id, CurrentSessionMessage.ID.make(input.messageID)),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row || !currentVisibleTypes.includes(row.type as (typeof currentVisibleTypes)[number])) {
    return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  }
  const parentBefore = yield* currentParentBefore(db, input.sessionID, row.seq)
  const [decoded] = yield* SessionMessageProjection.decodeRows(db, [row]).pipe(Effect.orDie)
  if (!decoded) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  const projected = projectCurrentToV1(input.sessionID, [decoded], { execution: input.execution, parentBefore })
  const item = projected.find((entry) => entry.info.id === input.messageID)
  if (!item) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return item
})

export function pageOn(input: {
  sessionID: SessionID
  limit: number
  before?: string
}, db: Pick<Database.DatabaseShape, "select">) {
  return Effect.gen(function* () {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
  })
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  return yield* pageOn(input, db)
})

/**
 * Versioned scalar-only part view for ordinary Context ledger pages. The
 * message headers still come from the canonical V1 message projection, but
 * all Part.data bodies—including multi-megabyte tool outputs—remain in SQLite.
 *
 * If ANY selected part predates the projection, is opaque, or has invalid
 * facts, return undefined: callers MUST use the exact canonical pageOn() path
 * instead of silently inventing missing token/signature values.
 */
export function pageContextFactsOn(
  input: { sessionID: SessionID; limit: number; before?: string },
  db: Pick<Database.DatabaseShape, "select">,
) {
  return Effect.gen(function* () {
    const before = input.before ? cursor.decode(input.before) : undefined
    const predicate = before
      ? and(eq(MessageTable.session_id, input.sessionID), older(before))
      : eq(MessageTable.session_id, input.sessionID)
    // Context ledger rows need only the durable identity, presentation role,
    // creation time, and ownership semantics. Never read full Message.data
    // into JS when producer-written Part facts already eliminate part bodies.
    // Large embedded provider metadata may otherwise dominate a 50-row page.
    const rows = yield* db.select({
      id: MessageTable.id,
      sessionID: MessageTable.session_id,
      timeCreated: sql<number | null>`json_extract(${MessageTable.data}, '$.time.created')`,
      role: sql<string | null>`json_extract(${MessageTable.data}, '$.role')`,
      provenance: sql<string | null>`json_extract(${MessageTable.data}, '$.provenance')`,
      opaque: MessageTable.context_opaque,
      physicalTime: MessageTable.time_created,
    }).from(MessageTable)
      .where(predicate)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > input.limit
    const slice = more ? rows.slice(0, input.limit) : rows
    if (slice.some((row) => row.opaque)) return undefined
    const ids = slice.map((row) => row.id)
    const parts = ids.length
      ? yield* db.select({
          id: PartTable.id,
          messageID: PartTable.message_id,
          version: PartTable.context_projection_version,
          kind: PartTable.context_kind,
          tokens: PartTable.context_tokens,
          preview: PartTable.context_preview,
          signed: PartTable.context_signed,
          status: PartTable.context_status,
          synthetic: PartTable.context_synthetic,
          ignored: PartTable.context_ignored,
          opaque: PartTable.context_opaque,
        })
          .from(PartTable)
          .where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id)
          .all()
          .pipe(Effect.orDie)
      : []
    if (parts.some((part) =>
       part.version !== 1 || !part.kind ||
      !Number.isSafeInteger(part.tokens) || part.tokens < 0 ||
      ((part.kind === "text" || part.kind === "reasoning" || part.kind === "tool") && part.preview === null)
    )) return undefined

    const byMessage = new Map<string, Part[]>()
    const facts = new Map<string, { tokens: number; signed: boolean }>()
    for (const row of parts) {
      // Minimal temporary adapter for the exact shared ledger classifier.
      // It is confined to this projector: no synthetic Part is returned by
      // the public MessageV2 history APIs or accepted by execution code.
      const item = row.kind === "tool"
        ? { id: row.id, type: "tool", tool: row.preview!, state: { status: row.status ?? "pending", output: "", error: "" } }
        : row.kind === "text" || row.kind === "reasoning"
          ? { id: row.id, type: row.kind, text: row.preview!, synthetic: row.synthetic, ignored: row.ignored }
          : { id: row.id, type: row.kind }
      const list = byMessage.get(row.messageID)
      if (list) list.push(item as Part)
      else byMessage.set(row.messageID, [item as Part])
      facts.set(row.id, { tokens: row.tokens, signed: row.signed })
    }
    const items = slice.map((row) => ({
      info: {
        id: row.id,
        sessionID: row.sessionID,
        role: row.role,
        time: { created: row.timeCreated },
        ...(row.provenance ? { provenance: JSON.parse(row.provenance) } : {}),
      } as Info,
      parts: byMessage.get(row.id) ?? [],
    }))
    items.reverse()
    const tail = slice.at(-1)
    return {
      items,
      facts,
      more,
      cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.physicalTime }) : undefined,
    }
  })
}

const TIMELINE_PARTS_PER_MESSAGE = 64
const TIMELINE_PART_PAGE_BYTES = 384 * 1024
export const TIMELINE_MESSAGE_PAGE_LIMIT = 100

// Explicit detail inspection is a separate, user-opened surface. Each wire
// page contains at most 16 bounded JSON slices; oversized individual parts
// continue by character offset instead of being materialized into the session
// store or timeline.
export const INSPECTION_PART_PAGE_SIZE = 16
export const INSPECTION_PART_SLICE_CHARS = 1024

// Timeline recovery pages restore complete structured parts into the shared
// timeline store. The page is bounded by both item count and encoded bytes;
// one oversized part is admitted alone so no content can become unreachable.
export const TIMELINE_RECOVERY_PART_PAGE_SIZE = 512
export const TIMELINE_RECOVERY_PART_PAGE_BYTES = 2 * 1024 * 1024
export const TIMELINE_RECOVERY_MESSAGE_LIMIT = 200

export type TimelineRecoveryCursor = PartID

export function decodeTimelineRecoveryCursor(input: string): TimelineRecoveryCursor {
  if (!input.startsWith("prt")) throw new Error("Invalid timeline recovery cursor")
  return PartID.make(input)
}

export const timelinePartsPage = Effect.fn("MessageV2.timelinePartsPage")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  cursor?: TimelineRecoveryCursor
}) {
  const { db } = yield* Database.Service
  const message = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!message) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })

  const candidates = yield* db
    .select({
      id: PartTable.id,
      bytes: sql<number>`length(cast(${PartTable.data} as blob))`,
    })
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, input.sessionID),
        eq(PartTable.message_id, input.messageID),
        input.cursor ? lt(PartTable.id, input.cursor) : undefined,
      ),
    )
    .orderBy(desc(PartTable.id))
    .limit(TIMELINE_RECOVERY_PART_PAGE_SIZE + 1)
    .all()
    .pipe(Effect.orDie)

  const selected: typeof candidates = []
  let bytes = 0
  for (const row of candidates) {
    if (selected.length >= TIMELINE_RECOVERY_PART_PAGE_SIZE) break
    // Always make progress, including when one stored part exceeds the page
    // budget. Large parts are still delivered whole and handled by the
    // renderer's worker/virtualized content paths.
    if (selected.length > 0 && bytes + row.bytes > TIMELINE_RECOVERY_PART_PAGE_BYTES) break
    selected.push(row)
    bytes += row.bytes
  }

  const ids = selected.map((row) => row.id)
  const rows = ids.length
    ? yield* db
        .select()
        .from(PartTable)
        .where(and(eq(PartTable.session_id, input.sessionID), inArray(PartTable.id, ids)))
        .orderBy(asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
    : []
  const hasMore = candidates.length > selected.length
  const next = selected.at(-1)
  return {
    data: rows.map(part),
    nextCursor: hasMore && next ? next.id : undefined,
  }
})

export type TimelineRecoveryBatchCursor = { partID: PartID; messageIDs: MessageID[] }

export function encodeTimelineRecoveryBatchCursor(cursor: TimelineRecoveryBatchCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

export function decodeTimelineRecoveryBatchCursor(input: string, messageIDs: readonly MessageID[]): TimelineRecoveryBatchCursor {
  const value = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Record<string, unknown>
  if (
    typeof value.partID !== "string" ||
    !value.partID.startsWith("prt") ||
    !Array.isArray(value.messageIDs) ||
    value.messageIDs.some((id) => typeof id !== "string")
  ) throw new Error("Invalid timeline recovery batch cursor")
  const expected = [...messageIDs].sort()
  const actual = (value.messageIDs as string[]).sort()
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index]))
    throw new Error("Timeline recovery cursor does not match requested messages")
  return { partID: PartID.make(value.partID), messageIDs: actual.map((id) => MessageID.make(id)) }
}

// One session-page request restores parts for all windowed messages in the
// currently loaded page. PartID is globally ordered, so one cursor traverses
// the requested owner set without issuing one request per message.
export const timelinePartsBatchPage = Effect.fn("MessageV2.timelinePartsBatchPage")(function* (input: {
  sessionID: SessionID
  messageIDs: readonly MessageID[]
  cursor?: TimelineRecoveryBatchCursor
}) {
  const { db } = yield* Database.Service
  const messageIDs = [...new Set(input.messageIDs)].sort()
  if (messageIDs.length > TIMELINE_RECOVERY_MESSAGE_LIMIT)
    return yield* new NotFoundError({ message: "Timeline recovery message page exceeds its bound" })
  if (input.cursor && (input.cursor.messageIDs.length !== messageIDs.length || input.cursor.messageIDs.some((id, i) => id !== messageIDs[i])))
    return yield* new NotFoundError({ message: "Timeline recovery cursor owner set changed" })

  const owners = messageIDs.length
    ? yield* db.select({ id: MessageTable.id }).from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), inArray(MessageTable.id, messageIDs)))
        .all().pipe(Effect.orDie)
    : []
  if (owners.length !== messageIDs.length)
    return yield* new NotFoundError({ message: "One or more timeline recovery messages do not belong to this session" })

  const candidates = messageIDs.length
    ? yield* db.select({ id: PartTable.id, messageID: PartTable.message_id, bytes: sql<number>`length(cast(${PartTable.data} as blob))` })
        .from(PartTable)
        .where(and(
          eq(PartTable.session_id, input.sessionID),
          inArray(PartTable.message_id, messageIDs),
          input.cursor ? lt(PartTable.id, input.cursor.partID) : undefined,
        ))
        .orderBy(desc(PartTable.id))
        .limit(TIMELINE_RECOVERY_PART_PAGE_SIZE + 1)
        .all().pipe(Effect.orDie)
    : []

  const selected: typeof candidates = []
  let bytes = 0
  for (const row of candidates) {
    if (selected.length >= TIMELINE_RECOVERY_PART_PAGE_SIZE) break
    if (selected.length > 0 && bytes + row.bytes > TIMELINE_RECOVERY_PART_PAGE_BYTES) break
    selected.push(row)
    bytes += row.bytes
  }
  const ids = selected.map((row) => row.id)
  const rows = ids.length
    ? yield* db.select().from(PartTable)
        .where(and(eq(PartTable.session_id, input.sessionID), inArray(PartTable.id, ids)))
        .orderBy(asc(PartTable.id)).all().pipe(Effect.orDie)
    : []
  const hasMore = candidates.length > selected.length
  const nextRow = selected.at(-1)
  return {
    data: rows.map((row) => ({ messageID: MessageID.make(row.message_id), part: part(row) })),
    nextCursor: hasMore && nextRow
      ? encodeTimelineRecoveryBatchCursor({ partID: nextRow.id, messageIDs })
      : undefined,
    completeMessageIDs: hasMore ? [] : messageIDs,
  }
})

export type InspectionPartCursor = { partID: PartID; offset: number }

export function encodeInspectionPartCursor(cursor: InspectionPartCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

export function decodeInspectionPartCursor(input: string): InspectionPartCursor {
  const value = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Record<string, unknown>
  if (
    typeof value.partID !== "string" ||
    !value.partID.startsWith("prt") ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0
  )
    throw new Error("Invalid part cursor")
  return { partID: PartID.make(value.partID), offset: value.offset as number }
}

export const inspectionPartsPage = Effect.fn("MessageV2.inspectionPartsPage")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  cursor?: InspectionPartCursor
}) {
  const { db } = yield* Database.Service
  const message = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!message) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })

  const cursor = input.cursor
  const firstOffset = cursor?.offset ?? 0
  if (cursor) {
    const anchor = yield* db
      .select({ totalChars: sql<number>`length(${PartTable.data})` })
      .from(PartTable)
      .where(
        and(
          eq(PartTable.session_id, input.sessionID),
          eq(PartTable.message_id, input.messageID),
          eq(PartTable.id, cursor.partID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!anchor || firstOffset > anchor.totalChars)
      return yield* new NotFoundError({ message: `Invalid part cursor for ${input.messageID}` })
  }
  const where = and(
    eq(PartTable.session_id, input.sessionID),
    eq(PartTable.message_id, input.messageID),
    cursor
      ? firstOffset > 0
        ? gte(PartTable.id, cursor.partID)
        : gt(PartTable.id, cursor.partID)
      : undefined,
  )
  const rows = yield* db
    .select({
      id: PartTable.id,
      type: sql<string>`${legacyPartKind}`,
      totalChars: sql<number>`length(${PartTable.data})`,
      text: sql<string>`substr(
        ${PartTable.data},
        case when ${PartTable.id} = ${cursor?.partID ?? ""} then ${firstOffset + 1} else 1 end,
        ${INSPECTION_PART_SLICE_CHARS}
      )`,
    })
    .from(PartTable)
    .where(where)
    .orderBy(asc(PartTable.id))
    .limit(INSPECTION_PART_PAGE_SIZE + 1)
    .all()
    .pipe(Effect.orDie)

  if (cursor && firstOffset > 0 && rows[0]?.id !== cursor.partID)
    return yield* new NotFoundError({ message: `Part not found: ${cursor.partID}` })

  const selected = rows.slice(0, INSPECTION_PART_PAGE_SIZE)
  const data: {
    partID: PartID
    type: string
    offset: number
    totalChars: number
    text: string
  }[] = []
  let nextCursor: InspectionPartCursor | undefined
  for (const [index, row] of selected.entries()) {
    const offset = cursor && index === 0 && row.id === cursor.partID ? firstOffset : 0
    data.push({ partID: PartID.make(row.id), type: row.type, offset, totalChars: row.totalChars, text: row.text })
    // SQLite TEXT length/substr count Unicode code points, while JS
    // String.length counts UTF-16 code units. Keep the opaque cursor in the
    // same unit as the database to avoid duplicate/skipped emoji content.
    const nextOffset = offset + [...row.text].length
    if (nextOffset < row.totalChars) {
      nextCursor = { partID: PartID.make(row.id), offset: nextOffset }
      break
    }
  }
  if (!nextCursor && rows.length > selected.length) {
    const last = selected.at(-1)
    if (last) nextCursor = { partID: PartID.make(last.id), offset: 0 }
  }
  return {
    data,
    nextCursor: nextCursor ? encodeInspectionPartCursor(nextCursor) : undefined,
  }
})

export const timelinePage = Effect.fn("MessageV2.timelinePage")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const limit = Math.max(1, Math.min(input.limit, TIMELINE_MESSAGE_PAGE_LIMIT))
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
      cursor: undefined,
      windowed: [] as { messageID: string; omittedParts: number }[],
    }
  }

  const more = rows.length > limit
  const slice = more ? rows.slice(0, limit) : rows
  const ids = slice.map((row) => row.id)
  const perMessageBytes = Math.max(1024, Math.floor(TIMELINE_PART_PAGE_BYTES / Math.max(1, slice.length)))
  const ranked = db
    .select({
      id: PartTable.id,
      message_id: PartTable.message_id,
      session_id: PartTable.session_id,
      data: PartTable.data,
      rank: sql<number>`row_number() over (partition by ${PartTable.message_id} order by ${PartTable.id} desc)`.as(
        "rank",
      ),
      // SQLite length(TEXT) counts Unicode code points, not encoded bytes.
      // The timeline budget is a transport/heap bound, so count the UTF-8
      // bytes stored in the JSON column instead.
      bytes: sql<number>`sum(length(cast(${PartTable.data} as blob))) over (
        partition by ${PartTable.message_id} order by ${PartTable.id} desc
        rows between unbounded preceding and current row
      )`.as("bytes"),
    })
    .from(PartTable)
    .where(
      and(
        inArray(PartTable.message_id, ids),
        lte(sql<number>`length(cast(${PartTable.data} as blob))`, perMessageBytes),
      ),
    )
    .as("timeline_part_window")
  const [partRows, counts] = yield* Effect.all([
    db
      .select({ id: ranked.id, message_id: ranked.message_id, session_id: ranked.session_id, data: ranked.data })
      .from(ranked)
      .where(and(lte(ranked.rank, TIMELINE_PARTS_PER_MESSAGE), lte(ranked.bytes, perMessageBytes)))
      .orderBy(asc(ranked.message_id), asc(ranked.id))
      .all()
      .pipe(Effect.orDie),
    db
      .select({ messageID: PartTable.message_id, count: sql<number>`count(*)` })
      .from(PartTable)
      .where(inArray(PartTable.message_id, ids))
      .groupBy(PartTable.message_id)
      .all()
      .pipe(Effect.orDie),
  ])
  const items = hydrateRows(slice, partRows as (typeof PartTable.$inferSelect)[])
  const selected = new Map<string, number>()
  for (const row of partRows) selected.set(row.message_id, (selected.get(row.message_id) ?? 0) + 1)
  const total = new Map(counts.map((row) => [row.messageID, row.count]))
  const windowed = ids.flatMap((messageID) => {
    const omittedParts = (total.get(messageID) ?? 0) - (selected.get(messageID) ?? 0)
    return omittedParts > 0 ? [{ messageID, omittedParts }] : []
  })
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    windowed,
  }
})

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (item) result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

/**
 * Content-free admission facts for Context mutations.
 *
 * The admission guard needs message provenance, the presence of signed
 * reasoning and ownership of explicitly targeted part IDs. It does NOT need
 * text, file, tool input, or tool output. Query these small facts from the
 * durable V1 producer without decoding every part body into JavaScript.
 *
 * Producer-certified scalar facts avoid parsing current V1 part JSON.
 * Unversioned/unknown parts still use authoritative JSON and fail closed
 * rather than accidentally treating malformed historical data as unsigned.
 */
export const probeContextTargetsFrom = Effect.fn("MessageV2.probeContextTargetsFrom")(function* (input: {
  sessionID: SessionID
  messageIDs: readonly MessageID[]
  signatureMessageIDs: readonly MessageID[]
  partIDs: readonly PartID[]
}, tx: Pick<Database.DatabaseShape, "select">) {
  const result = new Map<MessageID, {
    info: SharedTurnProvenance.InfoLike
    signedReasoning: boolean
    hasEditablePart: boolean
    opaqueParts: boolean
  }>()
  const partOwners = new Map<PartID, MessageID>()
  const partFacts = new Map<PartID, { type: string; status?: string }>()
  const batchSize = 128

  const messageIDs = [...new Set(input.messageIDs)]
  for (let offset = 0; offset < messageIDs.length; offset += batchSize) {
    const ids = messageIDs.slice(offset, offset + batchSize)
    const rows = yield* tx
      .select({
        id: MessageTable.id,
        role: sql<string | null>`json_extract(${MessageTable.data}, '$.role')`,
        owner: sql<string | null>`json_extract(${MessageTable.data}, '$.provenance.owner')`,
        source: sql<string | null>`json_extract(${MessageTable.data}, '$.provenance.source')`,
        lifetime: sql<string | null>`json_extract(${MessageTable.data}, '$.provenance.lifetime')`,
      })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), inArray(MessageTable.id, ids)))
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      // Admission needs ONLY provenance semantics, not message body, system
      // prompt, or arbitrary metadata. SQLite extracts four tiny scalars even
      // when the V1 message JSON itself is very large.
      const provenance: SharedTurnProvenance.ProvenanceLike | undefined =
        row.owner === "host" && row.source !== null
          ? {
              owner: "host",
              source: row.source,
              ...(row.lifetime === "historical" ? { lifetime: "historical" as const } : {}),
            }
          : row.owner === "user" && row.source !== null
            ? {
                owner: "user",
                source: row.source,
                ...(row.lifetime === "historical" ? { lifetime: "historical" as const } : {}),
              }
            : undefined
      result.set(row.id, {
        info: { role: row.role ?? undefined, provenance },
        signedReasoning: false,
        hasEditablePart: false,
        opaqueParts: false,
      })
    }
  }

  // Only exclusions/edits need the signature check. Pin, restore and include
  // operations without a part ID incur zero part-table reads.
  const signatureIDs = [...new Set(input.signatureMessageIDs)]
  for (let offset = 0; offset < signatureIDs.length; offset += batchSize) {
    const ids = signatureIDs.slice(offset, offset + batchSize)
    const rows = yield* tx
      .select({
        messageID: PartTable.message_id,
        signed: sql<number>`MAX(${legacyPartSigned})`,
        editable: sql<number>`MAX(CASE WHEN ${legacyPartKind}
          IN ('text', 'reasoning') THEN 1 ELSE 0 END)`,
        opaque: sql<number>`MAX(${legacyPartOpaque})`,
      })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, input.sessionID), inArray(PartTable.message_id, ids)))
      .groupBy(PartTable.message_id)
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      const item = result.get(row.messageID)
      if (item) {
        item.signedReasoning = row.signed === 1
        item.hasEditablePart = row.editable === 1
        // An OPCL-externalized V1 part has no inline signature/type. Never
        // infer unsigned or editable from its opaque reference; the mutation
        // admission layer refuses destructive operations until a genuine
        // producer-owned part projection can prove the guard.
        item.opaqueParts = row.opaque === 1
      }
    }
  }

  // Ownership validation uses the globally indexed Part primary key and
  // session predicate. No part JSON needs to cross the SQLite/JS boundary.
  const partIDs = [...new Set(input.partIDs)]
  for (let offset = 0; offset < partIDs.length; offset += batchSize) {
    const ids = partIDs.slice(offset, offset + batchSize)
    const rows = yield* tx
      .select({
        id: PartTable.id,
        messageID: PartTable.message_id,
        type: legacyPartKind,
        status: legacyPartStatus,
      })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, input.sessionID), inArray(PartTable.id, ids)))
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      // Unknown/opaque historical part kinds cannot authorize a Context edit.
      // Preserve fail-closed behavior rather than projecting a null type into
      // the structurally verified part-fact map.
      if (row.type === null) continue
      partOwners.set(row.id, row.messageID)
      partFacts.set(row.id, { type: row.type, status: row.status ?? undefined })
    }
  }
  return { messages: result, partOwners, partFacts }
})

export const probeContextTargets = Effect.fn("MessageV2.probeContextTargets")(function* (
  input: Parameters<typeof probeContextTargetsFrom>[0],
) {
  const { readDb } = yield* Database.Service
  // Public inspector uses one coherent committed read snapshot; durable
  // mutation admission uses probeContextTargetsFrom with the writer instead.
  return yield* readDb.transaction((tx) => probeContextTargetsFrom(input, tx), { behavior: "deferred" })
})

/**
 * Canonical newest-to-oldest V1 compaction collector. Both array filtering and
 * the paged SQLite reader use this exact state machine; the latter can stop
 * fetching once the effective-history boundary is proven.
 */
function compactionCollector() {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  const candidateIDs = new Set<string>()
  let retain: MessageID | undefined
  const push = (msg: WithParts): boolean => {
    result.push(msg)
    if (retain) {
      return msg.info.id === retain
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) return false
      // A completed assistant response is only a candidate until the durable
      // marker is explicitly promoted. Old markers lacking pending keep the
      // historical behavior; interrupted new compactions retain full history.
      if (part.pending === true) return false
      if (part.checkpoint_message_id && !candidateIDs.has(part.checkpoint_message_id)) return false
      if (!part.tail_start_id) return true
      retain = part.tail_start_id
      return msg.info.id === retain
    }
    if (msg.info.role === "assistant" && hasUsableCompactionCheckpoint(msg)) {
      completed.add(msg.info.parentID)
      candidateIDs.add(msg.info.id)
    }
    return false
  }
  const finish = () => {
    result.reverse()
    const promoted = result.findLast((msg) =>
      msg.info.role === "user" && msg.parts.some(
        (part) => part.type === "compaction" && part.pending !== true && Boolean(part.checkpoint_message_id),
      ),
    )
    const promotedID = promoted?.parts.find(
      (part): part is CompactionPart => part.type === "compaction",
    )?.checkpoint_message_id
    // Multiple complete assistant candidates can share one parent after crash
    // and retry. Never replay or select an abandoned candidate in place of the
    // exact assistant promoted by the marker's atomic update.
    const visible = promotedID
      ? result.filter((msg) =>
          msg.info.role !== "assistant" ||
          msg.info.parentID !== promoted!.info.id ||
          !msg.info.summary ||
          msg.info.id === promotedID,
        )
      : result
    const compactionIndex = visible.findLastIndex(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some(
          (item): item is CompactionPart =>
            item.type === "compaction" && item.pending !== true && item.tail_start_id !== undefined,
        ),
    )
    const compaction = visible[compactionIndex]
    const part = compaction?.parts.find(
      (item): item is CompactionPart =>
        item.type === "compaction" && item.pending !== true && item.tail_start_id !== undefined,
    )
    const summaryIndex = compaction
      ? visible.findIndex(
          (msg, index) =>
            index > compactionIndex &&
            msg.info.role === "assistant" &&
            hasUsableCompactionCheckpoint(msg) &&
            msg.info.parentID === compaction.info.id &&
            (!part?.checkpoint_message_id || msg.info.id === part.checkpoint_message_id),
        )
      : -1
    const tailIndex = part?.tail_start_id ? visible.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
    if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
      return [
        ...visible.slice(compactionIndex, summaryIndex + 1),
        ...visible.slice(tailIndex, compactionIndex),
        ...visible.slice(summaryIndex + 1),
      ]
    }
    return visible
  }
  return { push, finish }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const collector = compactionCollector()
  for (const msg of msgs) if (collector.push(msg)) break
  return collector.finish()
}

/** Internal signal to retry large history reads on the dedicated scan lane. */
export class ContextHistoryScanRequired extends Error {
  constructor() {
    super("Context effective history exceeded the interactive read budget")
    this.name = "ContextHistoryScanRequired"
  }
}

/**
 * Inspect compaction-aware V1 history inside an already-pinned transaction.
 * Context's ledger+overlay snapshot can share this with its own SQL queries;
 * the public streamCompacted convenience path creates that transaction.
 * A limited reader must fail instead of returning a partial ledger: its owner
 * can retry on a separate WAL reader using a fresh, internally consistent
 * snapshot, rather than monopolizing latency-sensitive SQLite read admission.
 */
export function readCompactedFrom(
  sessionID: SessionID,
  reader: Pick<Database.DatabaseShape, "select">,
  options?: { maxPages?: number },
) {
  return Effect.gen(function* () {
      const collector = compactionCollector()
      let before: string | undefined
      let pages = 0
      while (true) {
        const next = yield* pageOn({ sessionID, limit: 50, before }, reader).pipe(
          Effect.catchIf(NotFoundError.isInstance, () =>
            Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
          ),
        )
        pages++
        if (next.items.length === 0) break
        let reachedBoundary = false
        for (let i = next.items.length - 1; i >= 0; i--) {
          if (collector.push(next.items[i]!)) {
            reachedBoundary = true
            break
          }
        }
        if (reachedBoundary || !next.more || !next.cursor) break
        if (options?.maxPages !== undefined && pages >= options.maxPages)
          return yield* Effect.fail(new ContextHistoryScanRequired())
        before = next.cursor
      }
      return collector.finish()
  })
}

export const streamCompacted = Effect.fnUntraced(function* (sessionID: SessionID) {
  // DEFERRED WAL snapshot is consistent across cursor pages without taking
  // ownership of the primary writer's connection.
  const { readDb } = yield* Database.Service
  return yield* readDb.transaction(
    (tx) => readCompactedFrom(sessionID, tx),
    { behavior: "deferred" },
  )
})

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. IDs are only a deterministic tie-breaker
// because imported messages do not necessarily have monotonic IDs.
export function latest(msgs: WithParts[]) {
  // Structural/provider turn selection: host-owned continuations/compaction are
  // still real V1 provider-user turn boundaries. Replaceable STATE projections
  // are not: they are transparent context and must never steal assistant
  // parenting, checkpoint roots, or active-turn selection.
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (
      info.role === "user" &&
      !SessionTurnProvenance.isHistoricalInfo(info) &&
      !SessionTurnProvenance.hasStateSemanticsInfo(info) &&
      isAfter(info, user)
    )
      user = info
    if (info.role === "assistant" && isAfter(info, assistant)) assistant = info
    if (info.role === "assistant" && info.finish && isAfter(info, finished)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && !isAfter(m.info, finished)
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

function isAfter(info: Info, other?: Info) {
  if (!other) return true
  if (info.time.created !== other.time.created) return info.time.created > other.time.created
  return info.id > other.id
}

function isInterruptError(e: unknown) {
  if (!e || typeof e !== "object") return false
  const name = "name" in e ? String(e.name) : ""
  if (name === "InterruptError") return true
  const message = "message" in e && typeof e.message === "string" ? e.message : ""
  return message.startsWith("All fibers interrupted without error")
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
    case isInterruptError(e):
      return new AbortedError(
        { message: e instanceof Error && e.name === "AbortError" ? e.message : "Aborted" },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }
      if (parsed.type === "stale_reasoning") {
        return new APIError(
          {
            message: parsed.message,
            isRetryable: false,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          if (parsed.type === "stale_reasoning") {
            return new APIError(
              {
                message: parsed.message,
                isRetryable: false,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
export const node = LayerNode.group([Database.node])
