import { DateTime, Effect, Schema } from "effect"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { Question } from "@/question"
import { SubagentSupervisionMetadata } from "@/session/subagent-supervision-metadata"
import {
  classifyWorker,
  type RuntimeOwnership,
  type WorkerRuntime,
  type WorkerState,
} from "@/session/subagent-supervision"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Project } from "@/project/project"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { ExchangeSessionSearch } from "@/exchange/session-search"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { OxpInvocationTable, OxpParentActivityTable } from "@opencode-ai/core/oxp-activity/sql"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { SessionTurnProvenance as CurrentTurnProvenance } from "@opencode-ai/core/session/turn-provenance"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "search", "get", "status", "messages", "children", "oxp", "delete"]).annotate({
    description: "Action to perform",
  }),
  sessionId: Schema.optional(Schema.String).annotate({ description: "Target session ID for get/status/messages/delete" }),
  scope: Schema.optional(Schema.Literals(["current", "project", "global"])).annotate({
    description: "list/search: current (default), project, or global",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max items to return (default 10, max 100)",
  }),
  search: Schema.optional(Schema.String).annotate({ description: "list: title search substring" }),
  query: Schema.optional(Schema.String).annotate({
    description: "search: full-text query across Session titles and indexed conversation content",
  }),
  tool: Schema.optional(Schema.String).annotate({
    description:
      "search: exact tool name; reads producer-projected exact tool-call evidence without hydrating message/part payloads (may be combined with query)",
  }),
  repairIndex: Schema.optional(Schema.Boolean).annotate({
    description:
      "search: process one bounded historical-index repair chunk before searching. Use when coverage.complete is false; normal search does not perform maintenance.",
  }),
  ranking: Schema.optional(Schema.Literals(["recent", "relevance"])).annotate({
    description:
      "search: recent (default) prioritizes newest matching conversation evidence; relevance preserves corroboration-first historical search",
  }),
  roots: Schema.optional(Schema.Boolean).annotate({ description: "list/search: only root sessions (parentID null)" }),
  parentId: Schema.optional(Schema.String).annotate({
    description:
      "list/search/children: only sessions with this parent — finds subagent/task child sessions (e.g. to recover a failed task). children defaults to the current session (the calling supervisor) when omitted.",
  }),
  groupId: Schema.optional(Schema.String).annotate({
    description:
      "children: only supervised workers in this supervision cohort (assistant-turn-derived group id)",
  }),
  includeArchived: Schema.optional(Schema.Boolean).annotate({ description: "list/search: include archived sessions" }),
  withStatus: Schema.optional(Schema.Boolean).annotate({ description: "list: attach live status per session" }),
  role: Schema.optional(Schema.Literals(["all", "user", "assistant"])).annotate({
    description: "messages: filter by role (default all)",
  }),
  last: Schema.optional(Schema.Boolean).annotate({ description: "messages: return only the last matching message" }),
  includeSynthetic: Schema.optional(Schema.Boolean).annotate({
    description: "messages: include host-owned synthetic turns and synthetic text parts",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "messages: wait for the target Session to become idle before reading",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "messages wait timeout in seconds (default 600, max 86400)",
  }),
  oxpActivityId: Schema.optional(Schema.String).annotate({
    description: "oxp: inspect one OXP parent activity by id (returns its recent invocations instead of a list)",
  }),
  oxpLimit: Schema.optional(Schema.Number).annotate({ description: "oxp: max activities to return (default 10, max 100)" }),
  oxpIncludeArchived: Schema.optional(Schema.Boolean).annotate({ description: "oxp: include archived activities" }),
})

type Metadata = {
  action: string
  count?: number
  scope?: string
  sessionId?: string
  activityId?: string
  paused?: boolean
  truncated?: boolean
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback
  const n = Math.floor(limit)
  if (n < 1) return 1
  if (n > 100) return 100
  return n
}

function normalizeTimeout(timeout: number | undefined): number {
  const fallback = 600
  if (timeout === undefined) return fallback
  const n = Math.floor(timeout)
  if (n < 1) return 1
  if (n > 86400) return 86400
  return n
}

type AgentSessionSummary = {
  id: string
  title: string
  projectID: string
  directory: string
  parentID?: string
  workspaceID?: string
  agent?: string
  model?: string
  variant?: string
  status?: string
  paused: boolean
  archived: boolean
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  createdAt: number
  createdAtIso: string
  updatedAt: number
  updatedAtIso: string
  updatedAtBasis: "session_record"
  updatedAgeMs: number
}

function projectSession(session: Session.Info, status: string | undefined, retrievedAt: number): AgentSessionSummary {
  const model = session.model ? `${session.model.providerID}/${session.model.id}` : undefined
  const variant = session.model?.variant && session.model.variant !== "default" ? session.model.variant : undefined
  const summary: AgentSessionSummary = {
    id: session.id,
    title: session.title,
    projectID: session.projectID,
    directory: session.directory,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    ...(status ? { status } : {}),
    paused: session.pausedAt !== undefined,
    archived: session.time.archived !== undefined && session.time.archived !== null,
    cost: session.cost ?? 0,
    tokens: {
      input: session.tokens?.input ?? 0,
      output: session.tokens?.output ?? 0,
      reasoning: session.tokens?.reasoning ?? 0,
      cacheRead: session.tokens?.cache?.read ?? 0,
      cacheWrite: session.tokens?.cache?.write ?? 0,
    },
    createdAt: session.time.created,
    createdAtIso: new Date(session.time.created).toISOString(),
    updatedAt: session.time.updated,
    updatedAtIso: new Date(session.time.updated).toISOString(),
    updatedAtBasis: "session_record",
    updatedAgeMs: Math.max(0, retrievedAt - session.time.updated),
  }
  return summary
}

type AgentSessionMessage = {
  id: string
  role: "user" | "assistant"
  kind: SessionTurnProvenance.SemanticKind
  owner?: "user" | "host"
  source?: string
  createdAt: number
  completedAt?: number
  agent?: string
  model?: string
  variant?: string
  synthetic?: boolean
  text: string
}

// Role/kind filtering can skip large runs of host Synthetic traffic. Never
// answer a small agent-facing request by hydrating an arbitrarily large Session
// history: one larger bounded retry is enough, and the result reports when the
// scan ceiling prevented proving completeness.
export const MESSAGE_SCAN_LIMIT = 2_000

// Historical transcripts are untrusted, often extremely long, and Dreamer
// cannot take follow-up actions beyond inspection. Bound *bytes presented to
// its model* separately from the existing message-count/DB scan limits.
// The original message IDs/times remain attached to explicit excerpts so an
// excerpt is never misrepresented as the complete underlying evidence.
export const DREAMER_MESSAGE_TEXT_LIMIT = 6_000
export const DREAMER_MESSAGE_TOTAL_TEXT_LIMIT = 24_000
export const DREAMER_MESSAGE_COUNT_LIMIT = 12
export const DREAMER_MESSAGE_SCAN_LIMIT = 200
export const DREAMER_DISCOVERY_RESULT_LIMIT = 20

// JSON quoting can expand control characters 6x, and Unicode text is multibyte.
// Count serialized UTF-8 bytes, not JS string length, before the outer Tool
// truncation layer can turn a structured history result into an invalid JSON
// preview. The 24 KiB text budget leaves room for bounded message metadata.
const serializedTextBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") - 2

export function boundDreamerMessages<T extends { readonly text: string }>(messages: readonly T[]) {
  let remaining = DREAMER_MESSAGE_TOTAL_TEXT_LIMIT
  const selected: Array<T & { textTruncated?: boolean; omittedCharacters?: number }> = []
  let omittedMessages = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (remaining < 512) {
      omittedMessages++
      continue
    }
    const text = message.text
    const budget = Math.min(remaining, DREAMER_MESSAGE_TEXT_LIMIT)
    const fullBytes = serializedTextBytes(text)
    if (fullBytes <= budget) {
      selected.push(message)
      remaining -= fullBytes
      continue
    }
    // Both the beginning and ending matter in historical reasoning: preserve
    // the question/claim and its conclusion rather than silently tail-trimming.
    // The omission is explicit and costs *within* the per-message budget.
    const marker = "\n[... historical message excerpt omitted ...]\n"
    let lower = 0
    let upper = Math.min(text.length, budget)
    let excerpt = marker
    let retained = 0
    // Monotonic in the number of preserved UTF-16 units, even when quoting
    // expands a character. Binary search avoids repeatedly scanning an
    // arbitrarily large original transcript for every proposed cut.
    while (lower <= upper) {
      const mid = Math.floor((lower + upper) / 2)
      const head = Math.ceil(mid / 2)
      const tail = mid - head
      const candidate = text.slice(0, head) + marker + (tail ? text.slice(-tail) : "")
      if (serializedTextBytes(candidate) <= budget) {
        excerpt = candidate
        retained = mid
        lower = mid + 1
      } else upper = mid - 1
    }
    selected.push({
      ...message,
      text: excerpt,
      textTruncated: true,
      omittedCharacters: text.length - retained,
    })
    remaining -= serializedTextBytes(excerpt)
  }
  return {
    messages: selected.reverse(),
    truncated: omittedMessages > 0 || selected.some((message) => message.textTruncated === true),
    omittedMessages,
    textBudget: DREAMER_MESSAGE_TOTAL_TEXT_LIMIT,
  }
}

// ---------------------------------------------------------------------------
// Aggregated child/worker inspection (`action: "children"`)
//
// A supervisor must be able to audit 4+ supervised workers in ONE tool call
// instead of issuing N status + N messages calls. The projection below is
// deliberately bounded and evidence-oriented: it never returns transcripts, it
// hydrates at most one tiny message window per worker, and every worker row is
// capped. Full history remains available through `messages`.
// ---------------------------------------------------------------------------

/** Hard bound on the number of worker rows returned in one snapshot. */
export const CHILDREN_MAX_WORKERS = 50
/** Default bound when the caller does not pass `limit`. */
export const CHILDREN_DEFAULT_WORKERS = 25
/** Upper bound for the compact `latestActivity` excerpt. */
export const CHILDREN_ACTIVITY_LIMIT = 600
/** Bounded history window inspected per worker to derive latest activity/tool. */
export const CHILDREN_MESSAGE_WINDOW = 6

export type WorkerMode = "foreground" | "background" | "supervisor" | "unknown"

export type WorkerBlocked = WorkerState

export type WorkerSnapshot = {
  sessionId: string
  mode: WorkerMode
  agent?: string
  description?: string
  status: string
  blocked: WorkerBlocked
  latestActivity?: string
  lastTool?: string
  pendingPermission?: string
  pendingQuestion?: string
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  cost: number
  updatedAt: number
  updatedAtIso: string
  updatedAgeMs: number
  updatedAtBasis: "session_record"
  terminal?: {
    state: "completed" | "failed" | "cancelled"
    summary?: string
    error?: string
  }
}

export type ChildrenOutput = {
  parentId: string
  groupId?: string
  temporal: {
    retrievedAt: number
    retrievedAtIso: string
    order: "session_record_updated_desc"
    note: string
  }
  workers: WorkerSnapshot[]
  truncated?: boolean
}

function truncateActivity(text: string): string {
  const clean = text.trim()
  if (clean.length <= CHILDREN_ACTIVITY_LIMIT) return clean
  return `${clean.slice(0, CHILDREN_ACTIVITY_LIMIT)}… [truncated]`
}

/** Best-effort short textual argument for a tool call, e.g. "read src/x.ts". */
function describeToolInput(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return tool
  const candidate =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.command === "string" && input.command) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.query === "string" && input.query) ||
    (typeof input.description === "string" && input.description) ||
    (typeof input.glob === "string" && input.glob) ||
    (typeof input.sessionId === "string" && input.sessionId) ||
    (typeof input.action === "string" && input.action) ||
    ""
  const shortened = candidate.length > 120 ? `${candidate.slice(0, 120)}…` : candidate
  return shortened ? `${tool} ${shortened}` : tool
}

/** Latest meaningful assistant text part, bounded, skipping synthetic-only text. */
function latestMeaningfulText(message: SessionV1.WithParts | undefined): string | undefined {
  if (!message || message.info.role !== "assistant") return undefined
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part?.type !== "text") continue
    if ((part as any).synthetic === true) continue
    const text = typeof (part as any).text === "string" ? (part as any).text : ""
    if (text.trim() === "") continue
    return text
  }
  return undefined
}

function lastToolActivity(message: SessionV1.WithParts | undefined): string | undefined {
  if (!message) return undefined
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part?.type !== "tool") continue
    const toolPart = part as SessionV1.ToolPart
    const input = toolPart.state.status === "pending" ? undefined : toolPart.state.input
    const label = describeToolInput(toolPart.tool, input)
    if (toolPart.state.status === "error") return `${label} (error)`
    return label
  }
  return undefined
}

function assistantTerminal(message: SessionV1.WithParts | undefined): { error?: string } | undefined {
  if (!message || message.info.role !== "assistant") return undefined
  const info = message.info as SessionV1.Assistant
  if (!info.error) return undefined
  const data: any = info.error.data
  if (data && typeof data.message === "string") return { error: data.message }
  return { error: info.error.name }
}

function activityFromMessages(messages: ReadonlyArray<SessionV1.WithParts>) {
  const recent: string[] = []
  let consecutiveToolFailures = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part?.type !== "tool") continue
      const toolPart = part as SessionV1.ToolPart
      recent.push(toolPart.tool)
      consecutiveToolFailures = toolPart.state.status === "error" ? consecutiveToolFailures + 1 : 0
    }
  }
  if (recent.length === 0) return undefined
  return { recent, consecutiveToolFailures }
}

/** Latest assistant message in an ascending current/V2 window. */
function currentAssistant(messages: readonly SessionMessage.Message[]): SessionMessage.Assistant | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "assistant") return message
  }
  return undefined
}

/** Mirrors latestMeaningfulText: last non-empty text part of the latest assistant. */
function latestCurrentAssistantText(message: SessionMessage.Assistant | undefined): string | undefined {
  if (!message) return undefined
  for (let index = message.content.length - 1; index >= 0; index--) {
    const part = message.content[index]!
    if (part.type !== "text") continue
    if (part.text.trim() === "") continue
    return part.text
  }
  return undefined
}

/** Mirrors lastToolActivity: last tool part of the latest assistant, with error status. */
function lastCurrentToolActivity(message: SessionMessage.Assistant | undefined): string | undefined {
  if (!message) return undefined
  for (let index = message.content.length - 1; index >= 0; index--) {
    const part = message.content[index]!
    if (part.type !== "tool") continue
    const input = part.state.status === "pending" ? undefined : part.state.input
    const label = describeToolInput(part.name, input)
    if (part.state.status === "error") return `${label} (error)`
    return label
  }
  return undefined
}

/** Terminal error only from an explicit assistant settlement; host text never fabricates one. */
function currentAssistantTerminal(message: SessionMessage.Assistant | undefined): { error?: string } | undefined {
  if (!message?.error) return undefined
  return { error: message.error.message }
}

/** V2 mirror of activityFromMessages: only assistant tool parts are evidence. */
function activityFromCurrentMessages(messages: readonly SessionMessage.Message[]) {
  const recent: string[] = []
  let consecutiveToolFailures = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      recent.push(part.name)
      consecutiveToolFailures = part.state.status === "error" ? consecutiveToolFailures + 1 : 0
    }
  }
  if (recent.length === 0) return undefined
  return { recent, consecutiveToolFailures }
}

function resolveWorkerMode(input: {
  taskDelegation: SubagentSupervisionMetadata.TaskDelegation | undefined
  job: BackgroundJob.Info | undefined
  sessionMetadata: Record<string, unknown> | undefined
}): WorkerMode {
  if (input.taskDelegation) return "supervisor"
  if (input.job?.metadata?.background === true) return "background"
  if (input.sessionMetadata?.background === true) return "background"
  if (input.job) return "foreground"
  return "unknown"
}

function extractAgentMessage(message: SessionV1.WithParts, includeSynthetic: boolean): AgentSessionMessage | undefined {
  const info = message.info as any
  if (info.role !== "user" && info.role !== "assistant") return undefined
  const provenance = SessionTurnProvenance.resolve(message)
  const kind = SessionTurnProvenance.semanticKind(message)
  if (!includeSynthetic && kind === "synthetic") return undefined
  const textParts: Array<{ text: string; synthetic?: boolean }> = []
  for (const part of message.parts) {
    if (part.type !== "text") continue
    const synthetic = (part as any).synthetic === true
    if (!includeSynthetic && synthetic) continue
    const text = (part as any).text ?? ""
    if (text === "") continue
    textParts.push({ text, synthetic })
  }
  if (textParts.length === 0) return undefined
  const text = textParts.map((p) => p.text).join("\n")
  if (text.trim() === "") return undefined
  const hasSynthetic = textParts.some((p) => p.synthetic)
  const allSynthetic = textParts.every((p) => p.synthetic)
  let agent: string | undefined
  let model: string | undefined
  let variant: string | undefined
  if (info.role === "user") {
    agent = info.agent
    if (info.model) {
      model = `${info.model.providerID}/${info.model.modelID}`
      variant = info.model.variant && info.model.variant !== "default" ? info.model.variant : undefined
    }
  } else {
    agent = info.agent
    if (info.providerID && info.modelID) {
      model = `${info.providerID}/${info.modelID}`
      variant = info.variant && info.variant !== "default" ? info.variant : undefined
    }
  }
  const result: AgentSessionMessage = {
    id: info.id,
    role: info.role,
    kind,
    ...(provenance ? { owner: provenance.owner, source: provenance.source } : {}),
    createdAt: info.time?.created ?? 0,
    ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    text,
  }
  if (includeSynthetic) {
    if (allSynthetic) (result as any).synthetic = true
    else if (hasSynthetic) (result as any).containsSynthetic = true
  }
  return result
}

// Durable current/V2 transcript rows that carry conversational text. `system`
// rows are host-owned instructions and follow the same synthetic filter as
// `synthetic` turns; `agent-switched`/`model-switched` control rows carry no
// text and are deliberately excluded here.
const CURRENT_TRANSCRIPT_TYPES = ["user", "synthetic", "system", "assistant"] as const

function extractCurrentAgentMessage(
  message: SessionMessage.Message,
  includeSynthetic: boolean,
): AgentSessionMessage | undefined {
  if (message.type === "assistant") {
    const textParts: string[] = []
    for (const part of message.content) {
      if (part.type !== "text") continue
      if (part.text.trim() === "") continue
      textParts.push(part.text)
    }
    if (textParts.length === 0) return undefined
    return {
      id: message.id,
      role: "assistant",
      kind: "assistant",
      createdAt: DateTime.toEpochMillis(message.time.created),
      ...(message.time.completed ? { completedAt: DateTime.toEpochMillis(message.time.completed) } : {}),
      agent: message.agent,
      model: `${message.model.providerID}/${message.model.id}`,
      ...(message.model.variant && message.model.variant !== "default" ? { variant: message.model.variant } : {}),
      text: textParts.join("\n"),
    }
  }
  if (message.type !== "user" && message.type !== "synthetic" && message.type !== "system") return undefined
  if (message.text.trim() === "") return undefined
  const semantic = message.type === "system" ? "system" : CurrentTurnProvenance.semanticKind(message)
  const kind: SessionTurnProvenance.SemanticKind = semantic === "system" ? "synthetic" : semantic
  if (!includeSynthetic && kind === "synthetic") return undefined
  const provenance = CurrentTurnProvenance.resolve(message)
  return {
    id: message.id,
    role: "user",
    kind,
    ...(provenance ? { owner: provenance.owner, source: provenance.source } : {}),
    createdAt: DateTime.toEpochMillis(message.time.created),
    ...(includeSynthetic && kind === "synthetic" ? { synthetic: true } : {}),
    text: message.text,
  }
}

function titleFor(action: string): string {
  switch (action) {
    case "list":
      return "List sessions"
    case "search":
      return "Search sessions"
    case "get":
      return "View session"
    case "status":
      return "Check session status"
    case "messages":
      return "Read session messages"
    case "children":
      return "Inspect supervised workers"
    case "oxp":
      return "Inspect OXP activity"
    case "delete":
      return "Delete session"
    default:
      return "Session"
  }
}

const validateActionParams = Effect.fn("SessionTool.validateActionParams")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const action = params.action
  if (action === "get" || action === "status" || action === "messages" || action === "delete") {
    if (!params.sessionId) return yield* Effect.fail(new Error(`sessionId is required for ${action}`))
  }
  if (params.last === true && params.limit !== undefined) {
    return yield* Effect.fail(new Error("last cannot be combined with limit"))
  }
  if (params.timeout !== undefined && params.wait !== true) {
    return yield* Effect.fail(new Error("timeout requires wait"))
  }
  if (params.scope !== undefined && action !== "list" && action !== "search") {
    return yield* Effect.fail(new Error("scope is only valid for list or search"))
  }
  if (params.withStatus !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("withStatus is only valid for list"))
  }
  if (params.limit !== undefined && action === "delete") {
    return yield* Effect.fail(new Error("limit is not valid for delete"))
  }
  if (params.last !== undefined && action === "delete") {
    return yield* Effect.fail(new Error("last is only valid for messages"))
  }
  if (params.search !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("search is only valid for list; use query for full session search"))
  }
  if (params.query !== undefined && action !== "search") {
    return yield* Effect.fail(new Error("query is only valid for search"))
  }
  if (params.tool !== undefined && action !== "search") {
    return yield* Effect.fail(new Error("tool is only valid for search"))
  }
  if (params.repairIndex !== undefined && action !== "search") {
    return yield* Effect.fail(new Error("repairIndex is only valid for search"))
  }
  if (action === "search" && !(params.query?.trim() || params.tool?.trim())) {
    return yield* Effect.fail(new Error("search requires query or tool"))
  }
  if (params.roots !== undefined && action !== "list" && action !== "search") {
    return yield* Effect.fail(new Error("roots is only valid for list or search"))
  }
  if (params.includeArchived !== undefined && action !== "list" && action !== "search") {
    return yield* Effect.fail(new Error("includeArchived is only valid for list or search"))
  }
  if (params.parentId !== undefined && action !== "list" && action !== "search" && action !== "children") {
    return yield* Effect.fail(new Error("parentId is only valid for list, search, or children"))
  }
  if (params.parentId !== undefined && (action === "list" || action === "search") && params.roots === true) {
    return yield* Effect.fail(new Error("parentId cannot be combined with roots"))
  }
  if (params.groupId !== undefined && action !== "children") {
    return yield* Effect.fail(new Error("groupId is only valid for children"))
  }
  if (params.role !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("role is only valid for messages"))
  }
  if (params.includeSynthetic !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("includeSynthetic is only valid for messages"))
  }
  if (params.wait === true) {
    if (action !== "messages") return yield* Effect.fail(new Error("wait is only valid for messages"))
    const t = normalizeTimeout(params.timeout)
    if (t > 86400) return yield* Effect.fail(new Error("timeout must be <= 86400"))
  }
  if (params.oxpActivityId !== undefined && action !== "oxp") {
    return yield* Effect.fail(new Error("oxpActivityId is only valid for oxp"))
  }
  if (params.oxpLimit !== undefined && action !== "oxp") {
    return yield* Effect.fail(new Error("oxpLimit is only valid for oxp"))
  }
  if (params.oxpIncludeArchived !== undefined && action !== "oxp") {
    return yield* Effect.fail(new Error("oxpIncludeArchived is only valid for oxp"))
  }
  if (action === "oxp") {
    if (params.scope !== undefined) return yield* Effect.fail(new Error("scope cannot be combined with oxp"))
    if (params.sessionId !== undefined) return yield* Effect.fail(new Error("sessionId cannot be combined with oxp"))
  }
})

export const SessionTool = Tool.define<
  typeof Parameters,
  Metadata,
  Session.Service | SessionStatus.Service | Project.Service | BackgroundJob.Service | Question.Service | Database.Service
>("session", Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const projects = yield* Project.Service
    const background = yield* BackgroundJob.Service
    const questions = yield* Question.Service
    const { readDb, filename } = yield* Database.Service

    const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const current = yield* InstanceState.context
        if (current.directory === directory) return yield* effect
        const resolved = yield* projects.fromDirectory(directory)
        const target = {
          directory,
          worktree: resolved.sandbox,
          project: resolved.project,
        }
        return yield* effect.pipe(Effect.provideService(InstanceRef, target))
      })

    // Bounded read of one durable current/V2 transcript window. Host-owned
    // special-agent Sessions never write V1 message/part rows, so their only
    // durable history is the `session_message` projection; reuse the same
    // authoritative decoder the current transcript readers use.
    const readCurrentTranscriptWindow = Effect.fnUntraced(function* (sessionID: SessionID, windowLimit: number) {
      const rows = yield* readDb
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            inArray(SessionMessageTable.type, [...CURRENT_TRANSCRIPT_TYPES]),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(windowLimit)
        .all()
        .pipe(Effect.orDie)
      return yield* SessionMessageProjection.decodeRows(readDb, rows.toReversed()).pipe(Effect.orDie)
    })

    const list = Effect.fn("SessionTool.list")(function* (
      params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>,
    ) {
      const current = yield* InstanceState.context
      const scopeVal = params.scope ?? "current"
      const requestedLimit = normalizeLimit(params.limit, 10)
      const limit = Math.min(requestedLimit,
        ctx.agent === "dreamer" ? DREAMER_DISCOVERY_RESULT_LIMIT : 100)
      const retrievedAt = Date.now()
      const temporal = {
        retrievedAt,
        retrievedAtIso: new Date(retrievedAt).toISOString(),
        order: "session_record_updated_desc" as const,
        updatedAtBasis: "session_record" as const,
        note: "updatedAt reflects Session-record mutation time, not guaranteed conversation activity. Use search.latestAt for matching conversation recency and live status/runtime state for current truth.",
      }
      const parentID = params.parentId !== undefined ? SessionID.make(params.parentId) : undefined
      let rows: Session.Info[] = []
      if (scopeVal === "global") {
        const globalRows = yield* sessions
          .listGlobal({
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
            archived: params.includeArchived === true,
          })
          .pipe(Effect.orDie)
        rows = globalRows.map((r: any) => ({
          id: r.id,
          slug: r.slug,
          projectID: r.projectID,
          workspaceID: r.workspaceID,
          directory: r.directory,
          path: r.path,
          parentID: r.parentID,
          title: r.title,
          agent: r.agent,
          model: r.model,
          version: r.version,
          cost: r.cost,
          tokens: r.tokens,
          time: r.time,
          pausedAt: r.pausedAt,
          metadata: r.metadata,
          permission: r.permission,
          share: r.share,
          summary: r.summary,
          revert: r.revert,
        }))
      } else if (scopeVal === "project") {
        rows = yield* sessions
          .list({
            scope: "project",
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
          })
          .pipe(Effect.orDie)
        if (!params.includeArchived) rows = rows.filter((s) => !s.time.archived)
      } else {
        rows = yield* sessions
          .list({
            directory: current.directory,
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
          })
          .pipe(Effect.orDie)
        if (!params.includeArchived) rows = rows.filter((s) => !s.time.archived)
      }

      if (!params.withStatus) {
        const sessionsOut = rows.map((s) => projectSession(s, undefined, retrievedAt))
        return {
          title: "List sessions",
          output: JSON.stringify({ scope: scopeVal, temporal, sessions: sessionsOut,
            ...(requestedLimit > limit ? { limitCapped: true, effectiveLimit: limit } : {}) }),
          metadata: { action: "list", count: sessionsOut.length, scope: scopeVal,
            ...(requestedLimit > limit ? { limitCapped: true } : {}) },
        }
      }

      const groups = new Map<string, Session.Info[]>()
      for (const s of rows) {
        const arr = groups.get(s.directory)
        if (arr) arr.push(s)
        else groups.set(s.directory, [s])
      }
      const uniqueDirs = [...groups.keys()]
      const statusByDirectory = new Map<string, Map<SessionID, SessionStatus.Info> | null>()
      yield* Effect.forEach(
        uniqueDirs,
        (dir) =>
          inDirectory(dir, statuses.list())
            .pipe(
              Effect.map((mp) => {
                statusByDirectory.set(dir, mp)
              }),
              Effect.catch(() =>
                Effect.sync(() => {
                  statusByDirectory.set(dir, null)
                }),
              ),
            ),
        { concurrency: 4 },
      )
      const sessionsOut = rows.map((s) => {
        const mp = statusByDirectory.get(s.directory)
        let st: string | undefined
        if (mp === null) st = "unknown"
        else if (mp) {
          const v = mp.get(s.id as SessionID)
          st = v ? (v.type as string) : "idle"
        } else st = "unknown"
        return projectSession(s, st, retrievedAt)
      })
      return {
        title: "List sessions",
        output: JSON.stringify({ scope: scopeVal, temporal, sessions: sessionsOut }),
        metadata: { action: "list", count: sessionsOut.length, scope: scopeVal },
      }
    })

    const searchSessions = Effect.fn("SessionTool.search")(function* (
      params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>,
    ) {
      const current = yield* InstanceState.context
      const scopeVal = params.scope ?? "current"
      const parentID = params.parentId !== undefined ? SessionID.make(params.parentId) : undefined
      const requestedLimit = normalizeLimit(params.limit, 20)
      const limit = Math.min(requestedLimit,
        ctx.agent === "dreamer" ? DREAMER_DISCOVERY_RESULT_LIMIT : 100)
      const result = yield* ExchangeSessionSearch.execute(readDb, {
        ...(params.query?.trim() ? { query: params.query.trim() } : {}),
        ...(params.tool?.trim() ? { tool: params.tool.trim() } : {}),
        ...(scopeVal === "current"
          ? { directory: current.directory }
          : scopeVal === "project"
            ? { project: current.project.id }
            : {}),
        ...(parentID ? { parentID } : {}),
        ...(params.roots !== undefined ? { roots: params.roots } : {}),
        includeArchived: params.includeArchived === true,
        ranking: params.ranking ?? "recent",
        limit,
        scopeLabel: scopeVal,
        ...(params.repairIndex === true ? { repairIndex: true } : {}),
      }, {
        repairIndex: () => SessionSearch.repairOnOwnConnection(filename, { maxRows: 128, timeoutMs: 2_000 }),
      }).pipe(Effect.mapError((error) => new Error(error instanceof Error ? error.message : String(error))))

      return {
        title: result.title,
        output: requestedLimit > limit
          ? JSON.stringify({ ...result.structured, limitCapped: true, effectiveLimit: limit })
          : result.output,
        metadata: {
          action: "search",
          count: result.metadata.count,
          scope: scopeVal,
          ...(requestedLimit > limit ? { limitCapped: true } : {}),
          ...(result.metadata.truncated ? { truncated: true } : {}),
        } as Metadata,
      }
    })

    const status = Effect.fn("SessionTool.status")(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const id = SessionID.make(params.sessionId!)
      const session = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )
      const st = yield* inDirectory(
        session.directory,
        statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "unknown" as const }))),
      ).pipe(Effect.orDie)
      const paused = session.pausedAt !== undefined
      const retrievedAt = Date.now()
      return {
        title: "Check session status",
        output: JSON.stringify({
          sessionId: session.id,
          directory: session.directory,
          status: st,
          paused,
          temporal: {
            retrievedAt,
            retrievedAtIso: new Date(retrievedAt).toISOString(),
            recordUpdatedAt: session.time.updated,
            recordUpdatedAtIso: new Date(session.time.updated).toISOString(),
            recordUpdatedAgeMs: Math.max(0, retrievedAt - session.time.updated),
            note: "status is live as observed at retrievedAt; recordUpdatedAt is Session-record mutation time and is not the status observation time.",
          },
        }),
        metadata: { action: "status", sessionId: session.id, paused },
      }
    })

    const messages = Effect.fn("SessionTool.messages")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = SessionID.make(params.sessionId!)
      const session = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )

      if (params.wait === true) {
        const timeoutSec = normalizeTimeout(params.timeout)
        const start = Date.now()
        while (true) {
          const st = yield* inDirectory(
            session.directory,
            statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "idle" as const }))),
          ).pipe(Effect.orDie)
          if (st.type === "idle") break
          if (Date.now() - start > timeoutSec * 1000) {
            return yield* Effect.fail(new Error(`Timeout waiting for session ${params.sessionId} to become idle`))
          }
          if (ctx.abort.aborted) {
            return yield* Effect.fail(new Error("Cancelled while waiting for session"))
          }
          yield* Effect.sleep("200 millis")
        }
      }

      const requestedLimit = normalizeLimit(params.limit, 10)
      const limit = Math.min(requestedLimit,
        ctx.agent === "dreamer" ? DREAMER_MESSAGE_COUNT_LIMIT : 100)
      const limitCapped = requestedLimit > limit
      const role = params.role ?? "all"
      const includeSynthetic = params.includeSynthetic ?? false
      const fetchLimit = role === "all" ? limit : Math.max(100, limit * 4)

      const matchesRole = (message: AgentSessionMessage) => {
        if (role === "all") return true
        if (role === "user") return message.kind === "user"
        return message.kind === "assistant"
      }

      const toAgent = (msgs: SessionV1.WithParts[]) =>
        msgs
          .map((m) => extractAgentMessage(m, includeSynthetic))
          .filter((m): m is AgentSessionMessage => m !== undefined)
          .filter(matchesRole)

      // Host-owned special-agent transcripts execute their own provider turns
      // and are durable only in the `session_message` projection: they never
      // write V1 `message`/`part` rows, so the V1 reader would always be empty.
      // Read the same authoritative current projection those sessions use.
      const specialAgent = SessionMetadataOwnership.isSpecialAgent(session.metadata)
      const toCurrentAgent = (msgs: readonly SessionMessage.Message[]) =>
        msgs
          .map((m) => extractCurrentAgentMessage(m, includeSynthetic))
          .filter((m): m is AgentSessionMessage => m !== undefined)
          .filter(matchesRole)

      type MessageWindow = { readonly size: number; readonly messages: AgentSessionMessage[] }
      const readWindow = (windowLimit: number): Effect.Effect<MessageWindow> =>
        specialAgent
          ? readCurrentTranscriptWindow(id, windowLimit).pipe(
              Effect.map((msgs) => ({ size: msgs.length, messages: toCurrentAgent(msgs) })),
            )
          : sessions.messages({ sessionID: id, limit: windowLimit }).pipe(
              Effect.map((msgs) => ({ size: msgs.length, messages: toAgent(msgs) })),
              Effect.orDie,
            )

      let window = yield* readWindow(fetchLimit)
      let truncated = false
      if (window.messages.length < limit && window.size >= fetchLimit) {
        const scanLimit = Math.max(fetchLimit, ctx.agent === "dreamer" ? DREAMER_MESSAGE_SCAN_LIMIT : MESSAGE_SCAN_LIMIT)
        window = yield* readWindow(scanLimit)
        truncated = window.messages.length < limit && window.size >= scanLimit
      }

      const result = params.last === true ? window.messages.slice(-1) : window.messages.slice(-limit)

      // Dreamer reconstructs *historical* evidence. Looking up the live status
      // can bootstrap a different worktree's Instance solely to decorate a
      // transcript, violating the Tier 0/1 history-read architecture.
      const st = ctx.agent === "dreamer"
        ? { type: "unobserved" as const }
        : yield* inDirectory(
            session.directory,
            statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "idle" as const }))),
          ).pipe(Effect.orDie)
      const retrievedAt = Date.now()
      const projection = ctx.agent === "dreamer" ? boundDreamerMessages(result) : undefined
      const dated = (projection?.messages ?? result).map((message) => ({
        ...message,
        createdAtIso: new Date(message.createdAt).toISOString(),
        ageMs: Math.max(0, retrievedAt - message.createdAt),
        ...(message.completedAt === undefined
          ? {}
          : { completedAtIso: new Date(message.completedAt).toISOString() }),
      }))
      const oldest = dated[0]
      const newest = dated.at(-1)

      return {
        title: "Read session messages",
        output: JSON.stringify({
          sessionId: session.id,
          status: st,
          temporal: {
            retrievedAt,
            retrievedAtIso: new Date(retrievedAt).toISOString(),
            order: "oldest_to_newest",
            window: params.last === true ? "last_matching_message" : "latest_matching_messages",
            ...(oldest ? { oldestAt: oldest.createdAt, oldestAtIso: oldest.createdAtIso } : {}),
            ...(newest ? { newestAt: newest.createdAt, newestAtIso: newest.createdAtIso } : {}),
            note: "Message createdAt is conversation event time. Newer messages normally supersede older mutable-state claims unless the user asks for history; live repository/runtime state remains authoritative.",
          },
          messages: dated,
          ...((truncated || projection?.truncated) ? { truncated: true } : {}),
          ...(limitCapped ? { limitCapped: true, requestedMessageLimit: requestedLimit,
            effectiveMessageLimit: limit } : {}),
          ...(projection ? { excerpted: projection.truncated, omittedMessages: projection.omittedMessages,
            textBudget: projection.textBudget } : {}),
        }),
        metadata: { action: "messages", sessionId: session.id, count: dated.length,
          ...(limitCapped ? { limitCapped: true } : {}),
          ...((truncated || projection?.truncated) ? { truncated: true } : {}) },
      }
    })

    const children = Effect.fn("SessionTool.children")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const parentId = params.parentId !== undefined ? SessionID.make(params.parentId) : ctx.sessionID
      const groupId = params.groupId?.trim() || undefined
      const limit = Math.max(1, Math.min(CHILDREN_MAX_WORKERS, Math.floor(params.limit ?? CHILDREN_DEFAULT_WORKERS)))
      const retrievedAt = Date.now()

      // Tier 1 durable location read: children rows come straight from the
      // Session table. We do not materialize child instances; live status and
      // binding-request sets are resolved per-directory below.
      const rows = yield* sessions.children(parentId).pipe(Effect.orDie)

      // Supervision envelope is the authoritative supervised/cohort signal.
      const decorated = rows.map((session) => ({
        session,
        delegation: SubagentSupervisionMetadata.taskDelegation(session.metadata),
      }))
      const scoped = groupId
        ? decorated.filter((entry) => entry.delegation?.supervisionGroupID === groupId)
        : decorated

      // Stable order for a supervisor: most recently updated first, bounded.
      const ordered = scoped
        .slice()
        .sort((a, b) =>
          (b.session.time.updated ?? 0) - (a.session.time.updated ?? 0) ||
          String(b.session.id).localeCompare(String(a.session.id)),
        )
      const truncated = ordered.length > limit
      const selected = ordered.slice(0, limit)

      // Live BackgroundJob registry is single-instance scoped; the Session tool
      // runs in the caller's instance, which is also where its children run.
      const jobs = yield* background.list().pipe(Effect.catch(() => Effect.succeed([] as BackgroundJob.Info[])))
      const jobById = new Map(jobs.map((job) => [job.id, job]))

      // Pending binding requests are in-memory/instance-local. The Question
      // service exposes the open question set for this instance, so index it
      // per session once rather than probing per worker.
      //
      // Pending *permission* state is NOT cheaply reachable from this tool: the
      // Permission service is not part of the Session tool's layer context, and
      // materializing an instance just to read an in-memory request set would
      // violate the instance-routing rules. We therefore surface
      // `pendingPermission` only from the live BackgroundJob metadata when the
      // owning runtime stamped it, and otherwise deliberately omit it rather
      // than inventing a blocker. The authoritative permission blocker snapshot
      // remains available through the delegated-worker/task result surface.
      const questionRows = yield* questions
        .list()
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<any>)))
      const questionBySession = new Map<string, number>()
      for (const request of questionRows) {
        const key = String(request.sessionID)
        questionBySession.set(key, (questionBySession.get(key) ?? 0) + 1)
      }

      const workers: WorkerSnapshot[] = []
      for (const { session, delegation } of selected) {
        const id = session.id as SessionID
        const job = jobById.get(String(id))

        // One bounded history window per worker. Never a transcript. Host-owned
        // special-agent children are durable only in the current/V2 projection,
        // so read that projection instead of the always-empty V1 history.
        let latestText: string | undefined
        let tool: string | undefined
        let terminalError: { error?: string } | undefined
        let activity: ReturnType<typeof activityFromMessages>
        if (SessionMetadataOwnership.isSpecialAgent(session.metadata)) {
          const window = yield* readCurrentTranscriptWindow(id, CHILDREN_MESSAGE_WINDOW).pipe(
            Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          const latestAssistant = currentAssistant(window)
          latestText = latestCurrentAssistantText(latestAssistant)
          tool = lastCurrentToolActivity(latestAssistant)
          terminalError = currentAssistantTerminal(latestAssistant)
          activity = activityFromCurrentMessages(window)
        } else {
          const window = yield* sessions
            .messages({ sessionID: id, limit: CHILDREN_MESSAGE_WINDOW })
            .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
          const orderedMessages = window
            .slice()
            .sort((a, b) => (a.info.time.created ?? 0) - (b.info.time.created ?? 0))
          const latestAssistant = [...orderedMessages].reverse().find((m) => m.info.role === "assistant")
          latestText = latestMeaningfulText(latestAssistant)
          tool = lastToolActivity(latestAssistant)
          terminalError = assistantTerminal(latestAssistant)
          activity = activityFromMessages(window)
        }

        const statusInfo = yield* inDirectory(
          session.directory,
          statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "unknown" as const }))),
        ).pipe(Effect.catch(() => Effect.succeed({ type: "unknown" as const })))
        const statusType = statusInfo.type as string

        const pendingPermission =
          typeof job?.metadata?.pendingPermission === "string" ? job.metadata.pendingPermission : undefined
        const questionCount = questionBySession.get(String(id))
        const pendingQuestion = questionCount ? `${questionCount} pending` : undefined

        const runtime: RuntimeOwnership = job?.status === "running" ? "live" : "unknown_runtime"
        const sessionStatus: WorkerRuntime =
          statusInfo.type === "unknown"
            ? { type: "none" }
            : statusInfo.type === "retry"
              ? { type: "retry", attempt: statusInfo.attempt }
              : statusInfo.type === "busy"
                ? { type: "busy" }
                : { type: "idle" }
        const classified = classifyWorker({
          runtime,
          sessionStatus,
          backgroundStatus: job?.status,
          hasPermission: pendingPermission !== undefined,
          hasQuestion: pendingQuestion !== undefined,
          activity,
        })
        const blocked = classified.state

        const mode = resolveWorkerMode({
          taskDelegation: delegation,
          job,
          sessionMetadata: session.metadata,
        })

        // Terminal envelope is only emitted when the conservative
        // classification actually reached a terminal state. A busy worker whose
        // last visible assistant text carried an error is not "failed" yet.
        const terminalState =
          blocked === "completed"
            ? ("completed" as const)
            : blocked === "failed"
              ? ("failed" as const)
              : blocked === "cancelled"
                ? ("cancelled" as const)
                : undefined

        const summarySource = job?.output ?? latestText
        const snapshot: WorkerSnapshot = {
          sessionId: String(id),
          mode,
          ...(session.agent ? { agent: session.agent } : {}),
          ...(delegation?.description
            ? { description: delegation.description }
            : job?.title
              ? { description: job.title }
              : session.title
                ? { description: session.title }
                : {}),
          status: statusType,
          blocked,
          ...(latestText ? { latestActivity: truncateActivity(latestText) } : {}),
          ...(tool ? { lastTool: truncateActivity(tool) } : {}),
          ...(pendingPermission ? { pendingPermission } : {}),
          ...(pendingQuestion ? { pendingQuestion } : {}),
          tokens: {
            input: session.tokens?.input ?? 0,
            output: session.tokens?.output ?? 0,
            reasoning: session.tokens?.reasoning ?? 0,
            cacheRead: session.tokens?.cache?.read ?? 0,
            cacheWrite: session.tokens?.cache?.write ?? 0,
          },
          cost: session.cost ?? 0,
          updatedAt: session.time.updated,
          updatedAtIso: new Date(session.time.updated).toISOString(),
          updatedAgeMs: Math.max(0, retrievedAt - session.time.updated),
          updatedAtBasis: "session_record",
          ...(terminalState
            ? {
                terminal: {
                  state: terminalState,
                  ...(summarySource ? { summary: truncateActivity(summarySource) } : {}),
                  ...(terminalError?.error ? { error: truncateActivity(terminalError.error) } : {}),
                },
              }
            : {}),
        }
        workers.push(snapshot)
      }

      const output: ChildrenOutput = {
        parentId: String(parentId),
        ...(groupId ? { groupId } : {}),
        temporal: {
          retrievedAt,
          retrievedAtIso: new Date(retrievedAt).toISOString(),
          order: "session_record_updated_desc",
          note: "Worker rows are ordered by Session-record update time. Live status/blocked fields are observed at retrievedAt; updatedAt alone never proves runtime liveness or current task authority.",
        },
        workers,
        ...(truncated ? { truncated: true } : {}),
      }

      return {
        title: "Inspect supervised workers",
        output: JSON.stringify(output),
        metadata: {
          action: "children",
          sessionId: String(parentId),
          count: workers.length,
          ...(truncated ? { truncated: true } : {}),
        } as Metadata,
      }
    })

// ---------------------------------------------------------------------------
// OXP parent-activity inspection (`action: "oxp"`). Rows are ChatGPT
// conversations keyed by an opaque id; `title` is display metadata only, never
// identity. Durable SQLite read through the tool's existing Database handle:
// no workspace instance, no directory resolution.
// ---------------------------------------------------------------------------

/** Bound on recent invocations returned for one parent activity. */
const OXP_INVOCATIONS_WINDOW = 20

type OxpActivitySummary = {
  id: string
  title: string
  firstSeenAt: number
  firstSeenAtIso: string
  lastSeenAt: number
  lastSeenAtIso: string
  lastSeenAgeMs: number
  timeBasis: "oxp_activity_observed"
  callCount: number
  failureCount: number
  planeMix: {
    augmentation: number
    supervision: number
    delegation: number
  }
  observedEpochCount: number
  lastTool?: string
  lastRootAlias?: string
  archived: boolean
}

type OxpInvocationSummary = {
  id: string
  tool: string
  action?: string
  status: string
  rootAlias?: string
  startedAt: number
  startedAtIso: string
  startedAgeMs: number
  completedAt?: number
  completedAtIso?: string
  timeBasis: "oxp_invocation_event"
}

type OxpTemporal = {
  retrievedAt: number
  retrievedAtIso: string
  order: "last_seen_desc" | "started_desc"
  note: string
}

type OxpListOutput = {
  temporal: OxpTemporal
  activities: OxpActivitySummary[]
  truncated: boolean
}

type OxpDetailOutput = {
  temporal: OxpTemporal
  activity: OxpActivitySummary
  invocations: OxpInvocationSummary[]
  truncated?: boolean
}

function projectOxpActivity(
  row: typeof OxpParentActivityTable.$inferSelect,
  retrievedAt: number,
): OxpActivitySummary {
  return {
    id: row.id,
    title: row.title ?? row.last_root_alias ?? "untitled",
    firstSeenAt: row.first_seen_at,
    firstSeenAtIso: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: row.last_seen_at,
    lastSeenAtIso: new Date(row.last_seen_at).toISOString(),
    lastSeenAgeMs: Math.max(0, retrievedAt - row.last_seen_at),
    timeBasis: "oxp_activity_observed",
    callCount: row.call_count,
    failureCount: row.failure_count,
    planeMix: {
      augmentation: row.augmentation_calls,
      supervision: row.supervision_calls,
      delegation: row.delegation_calls,
    },
    observedEpochCount: row.observed_epoch_count,
    ...(row.last_tool ? { lastTool: row.last_tool } : {}),
    ...(row.last_root_alias ? { lastRootAlias: row.last_root_alias } : {}),
    archived: row.time_archived !== null && row.time_archived !== undefined,
  }
}

function projectOxpInvocation(
  row: typeof OxpInvocationTable.$inferSelect,
  retrievedAt: number,
): OxpInvocationSummary {
  return {
    id: row.id,
    tool: row.tool,
    ...(row.action ? { action: row.action } : {}),
    status: row.status,
    ...(row.root_alias ? { rootAlias: row.root_alias } : {}),
    startedAt: row.time_started,
    startedAtIso: new Date(row.time_started).toISOString(),
    startedAgeMs: Math.max(0, retrievedAt - row.time_started),
    ...(row.time_completed === null || row.time_completed === undefined
      ? {}
      : {
          completedAt: row.time_completed,
          completedAtIso: new Date(row.time_completed).toISOString(),
        }),
    timeBasis: "oxp_invocation_event",
  }
}

const oxpActivities = Effect.fn("SessionTool.oxpActivities")(function* (params: Schema.Schema.Type<typeof Parameters>) {
  const retrievedAt = Date.now()
  if (params.oxpActivityId !== undefined) {
    const activityId = params.oxpActivityId as OxpActivitySchema.ActivityID
    const row = yield* readDb
      .select()
      .from(OxpParentActivityTable)
      .where(eq(OxpParentActivityTable.id, activityId))
      .get()
      .pipe(Effect.orDie)
    if (!row) {
      return {
        title: "OXP activity not found",
        output: JSON.stringify({ activityId, found: false }),
        metadata: { action: "oxp", activityId } as Metadata,
      }
    }
    const window = OXP_INVOCATIONS_WINDOW
    const rows = yield* readDb
      .select()
      .from(OxpInvocationTable)
      .where(eq(OxpInvocationTable.activity_id, activityId))
      .orderBy(desc(OxpInvocationTable.time_started), desc(OxpInvocationTable.id))
      .limit(window + 1)
      .all()
      .pipe(Effect.orDie)
    const truncated = rows.length > window
    const output: OxpDetailOutput = {
      temporal: {
        retrievedAt,
        retrievedAtIso: new Date(retrievedAt).toISOString(),
        order: "started_desc",
        note: "Invocation timestamps are OXP event times. Newer invocations normally supersede older mutable-state observations; parent lastSeenAt records OXP activity observation, not repository/runtime truth.",
      },
      activity: projectOxpActivity(row, retrievedAt),
      invocations: rows.slice(0, window).map((invocation) => projectOxpInvocation(invocation, retrievedAt)),
      ...(truncated ? { truncated: true } : {}),
    }
    return {
      title: "Inspect OXP activity",
      output: JSON.stringify(output),
      metadata: {
        action: "oxp",
        activityId,
        count: output.invocations.length,
        ...(truncated ? { truncated: true } : {}),
      } as Metadata,
    }
  }

  const limit = normalizeLimit(params.oxpLimit, 10)
  const rows = yield* readDb
    .select()
    .from(OxpParentActivityTable)
    .where(params.oxpIncludeArchived === true ? undefined : isNull(OxpParentActivityTable.time_archived))
    .orderBy(desc(OxpParentActivityTable.last_seen_at), desc(OxpParentActivityTable.id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const truncated = rows.length > limit
  const output: OxpListOutput = {
    temporal: {
      retrievedAt,
      retrievedAtIso: new Date(retrievedAt).toISOString(),
      order: "last_seen_desc",
      note: "lastSeenAt is the latest observed OXP activity for this parent conversation, not proof that any worker/runtime is still live. Prefer newer activity unless historical state was requested.",
    },
    activities: rows.slice(0, limit).map((activity) => projectOxpActivity(activity, retrievedAt)),
    truncated,
  }
  return {
    title: "Inspect OXP activity",
    output: JSON.stringify(output),
    metadata: {
      action: "oxp",
      count: output.activities.length,
      ...(truncated ? { truncated: true } : {}),
    } as Metadata,
  }
})

    const removeSession = Effect.fn("SessionTool.delete")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = SessionID.make(params.sessionId!)
      if (String(ctx.sessionID) === String(id)) {
        return yield* Effect.fail(new Error("Refusing to delete the calling session"))
      }
      const target = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )
      if (SessionMetadataOwnership.isProducerOwned(target.metadata ?? undefined)) {
        return yield* Effect.fail(new Error(`Session ${params.sessionId} is producer-owned and cannot be deleted through this tool`))
      }
      const kids = yield* sessions.children(id).pipe(Effect.orDie)
      yield* sessions.remove(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )
      return {
        title: "Delete session",
        output: JSON.stringify({ deleted: true, sessionId: target.id, title: target.title, deletedChildren: kids.length }),
        metadata: { action: "delete", sessionId: target.id, count: kids.length } as Metadata,
      }
    })

    const execute = Effect.fn("SessionTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      if (ctx.agent === "dreamer") {
        if (!["list", "search", "get", "messages"].includes(params.action) ||
            params.scope === "global" || params.repairIndex === true ||
            params.withStatus === true || params.wait === true) {
          return yield* Effect.fail(new Error("Dreamer may only inspect project-scoped Sessions without index repair, bulk live-status fanout, waiting, or mutation."))
        }
        if (params.sessionId) {
          const caller = yield* sessions.get(ctx.sessionID)
          const target = yield* sessions.get(SessionID.make(params.sessionId))
          if (target.projectID !== caller.projectID) {
            return yield* Effect.fail(new Error("Dreamer cannot read a Session outside its owning project."))
          }
        }
      }
      yield* validateActionParams(params)
      yield* ctx.metadata({ title: titleFor(params.action), metadata: { action: params.action, sessionId: params.sessionId } })

      switch (params.action) {
        case "list":
          return yield* list(params, ctx)
        case "search":
          return yield* searchSessions(params, ctx)
        case "get": {
          const id = SessionID.make(params.sessionId!)
          const sess = yield* sessions.get(id).pipe(
            Effect.catch((err: unknown) => {
              const m = err instanceof Error ? err.message : String(err)
              const tag = (err as any)?._tag
              if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
                return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
              }
              return Effect.fail(err as Error)
            }),
          )
          const st = ctx.agent === "dreamer"
            ? "unobserved"
            : yield* inDirectory(
                sess.directory,
                statuses.list().pipe(
                  Effect.map((mp) => {
                    const v = mp.get(id)
                    return v ? (v.type as string) : "idle"
                  }),
                  Effect.catch(() => Effect.succeed("unknown")),
                ),
              ).pipe(Effect.orDie)
          const retrievedAt = Date.now()
          const summary = projectSession(sess, st, retrievedAt)
          return {
            title: "View session",
            output: JSON.stringify({
              temporal: {
                retrievedAt,
                retrievedAtIso: new Date(retrievedAt).toISOString(),
                updatedAtBasis: "session_record",
                note: "updatedAt is Session-record mutation time; inspect messages/search evidence and live runtime state before treating it as conversation currentness.",
              },
              session: summary,
            }),
            metadata: { action: "get", sessionId: summary.id } as Metadata,
          }
        }
        case "status":
          return yield* status(params)
        case "messages":
          return yield* messages(params, ctx)
        case "children":
          return yield* children(params, ctx)
        case "oxp":
          return yield* oxpActivities(params)
        case "delete":
          return yield* removeSession(params, ctx)
        default:
          return yield* Effect.fail(new Error(`Unknown action: ${(params as any).action}`))
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
