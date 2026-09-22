import { SessionID, MessageID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
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
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
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

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export function latestCompletedCompaction(msgs: readonly WithParts[]) {
  const completed = new Set<string>()
  for (const msg of msgs) {
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) completed.add(msg.info.parentID)
  }
  let result: WithParts | undefined
  for (const msg of msgs) {
    if (msg.info.role !== "user" || !completed.has(msg.info.id)) continue
    if (SessionTurnProvenance.isHistoricalInfo(msg.info)) continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
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
  if (states.size === 0) return ordinary
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
  if (!activeUser) return [...projected, ...ordinary]
  const index = ordinary.findIndex((message) => message.info.id === activeUser!.id)
  if (index < 0) return [...projected, ...ordinary]
  return [...ordinary.slice(0, index), ...projected, ...ordinary.slice(index)]
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
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
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
            if (part.text.trim().length > 0)
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

export const currentAll = Effect.fn("MessageV2.currentAll")(function* (input: {
  sessionID: SessionID
  execution?: CurrentV1Execution
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
  const decoded = yield* SessionMessageProjection.decodeRows(db, rows).pipe(Effect.orDie)
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
    return { items: [] as SessionV1.WithParts[], more: false, cursor: undefined }
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

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
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

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

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
