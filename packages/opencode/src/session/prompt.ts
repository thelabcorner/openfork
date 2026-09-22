import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import {
  ModelRef,
  PromptInput,
  type HostPromptProvenance,
  type SessionPromptOps,
  type UserActionPromptProvenance,
} from "./prompt-contract"
export {
  ModelRef,
  PromptInput,
  type HostPromptProvenance,
  type SessionPromptOps,
  type UserActionPromptProvenance,
} from "./prompt-contract"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { TurnCheckpoint } from "./checkpoint"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type ModelMessage, type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { ShellLaunch } from "@/tool/shell/launch"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { SessionIngress, formatMonitorEvents, interactionGate } from "./ingress"
import { Question } from "@/question"
import { decodeDataUrl } from "@/util/data-url"
import { Cause, DateTime, Duration, Effect, Exit, Fiber, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as SubagentDelegation from "./subagent-delegation"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { userChildEnvironment } from "@/util/javascript-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage as CurrentSessionMessage } from "@opencode-ai/core/session/message"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { LLMEvent, LLMResponse, type ToolResultValue } from "@opencode-ai/llm"
import { SpadSupervisor } from "./spad/supervisor"
import { makeTurnPolicy } from "./spad/intent"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { Goal } from "@opencode-ai/core/goal"
import { GoalProjection } from "@opencode-ai/core/goal/projection"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { GoalAuditor } from "@opencode-ai/core/goal/auditor"
import { makeRuntime as makeGoalAuditorRuntime } from "@/goal/auditor-runtime"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  collectUntilTerminalTool,
  generateAdaptive,
  runTerminalCompletionWithTranscript,
  terminalCompletionAccepted,
  withSpecialAgentTimeout,
} from "@opencode-ai/core/special-agent-completion"
import { type ToolChoiceCapabilityIdentity } from "@opencode-ai/core/tool-choice-compatibility"
import { appendModelCompletionRepair } from "@/special-agent/model-message-bridge"
import { Usage as UsageAnalytics } from "@/usage/usage"
import * as MaintenanceUsage from "@/usage/maintenance"
import { SpadAuditor } from "@opencode-ai/core/spad-auditor"
import { SpecialAgentSession } from "@opencode-ai/core/special-agent-session"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { ScheduledTaskProvenance } from "@opencode-ai/core/scheduled-task/provenance"
import { makeV1SpecialAgentAnchor } from "@/special-agent/v1-anchor"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024

const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

// Persisted as a host-owned synthetic turn when a generation is an automatic
// continuation of one that ended with finish "unknown" — the provider stream
// dropped before a stop reason. Without this the model is asked to produce
// another assistant turn with no new input, which it experiences as a
// blank/phantom user message.
const UNKNOWN_FINISH_CONTINUATION_PROMPT = `[AUTOMATIC CONTINUATION ΓÇö system, not the user] Your previous response was cut off mid-stream: the provider connection dropped before a completion signal arrived (finish reason "unknown"). Nothing new was asked and there is no new user request. Resume exactly where you stopped: continue the same task or sentence WITHOUT repeating output you already produced, without apologizing, and without asking the user anything. If you genuinely cannot continue, state in one short line what you were doing, then immediately proceed with the next concrete step.`

function goalTokenCount(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Goal reservation ids are globally unique durable cursors. Deriving V1 ids
// from that cursor gives continuation publication a stable identity across
// process crashes without pushing V1-specific identifiers into GoalAutomation.
function goalContinuationMessageID(reservationID: string, resetBoundaryID?: MessageID) {
  return MessageID.make(
    resetBoundaryID
      ? `msg_goal_continuation_${reservationID}_after_${resetBoundaryID}`
      : `msg_goal_continuation_${reservationID}`,
  )
}

function goalContinuationPartID(reservationID: string, resetBoundaryID?: MessageID) {
  return PartID.make(
    resetBoundaryID
      ? `prt_goal_continuation_${reservationID}_after_${resetBoundaryID}`
      : `prt_goal_continuation_${reservationID}`,
  )
}

function visibleWorkerPromptText(message: SessionV1.WithParts | undefined) {
  if (!message || !SessionTurnProvenance.isWorkerPromptTurn(message)) return ""
  return visiblePromptText(message)
}

function visiblePromptText(message: SessionV1.WithParts) {
  return message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n")
}

function truncateTitleContext(value: string, maxChars: number) {
  if (value.length <= maxChars) return value
  if (maxChars <= 64) return value.slice(0, maxChars)
  const marker = "\n...[truncated]...\n"
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(remaining * 0.55)
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`
}

/**
 * V1 adapter for the shared title-context semantics used by Core: compacted
 * history wins over raw replay, only semantic conversational content is
 * rendered, and the opening worker root is pinned only when no compaction
 * summary supersedes it. The provider receives this bounded transcript as data,
 * never the session's raw tool/protocol history.
 */
export function assembleV1TitleContext(messages: readonly SessionV1.WithParts[]) {
  const maxChars = SessionTitle.MAX_TITLE_CONTEXT_CHARS
  const maxBlockChars = maxChars
  const latestCompaction = messages.findLastIndex((message) =>
    message.parts.some((part) => part.type === "compaction"),
  )
  const floor = latestCompaction >= 0 ? latestCompaction : 0
  const blocks: Array<{ index: number; text: string }> = []

  for (let index = floor; index < messages.length; index++) {
    const message = messages[index]!
    let text = ""
    if (message.info.role === "assistant") {
      const body = message.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text" && part.text.trim().length > 0)
        .map((part) => part.text)
        .join("\n")
      if (body) text = `<assistant>\n${body}\n</assistant>`
    } else {
      const kind = SessionTurnProvenance.semanticKind(message)
      if (kind === "compaction") {
        text = "<conversation-summary>\nPrevious conversation compacted; the following assistant summary is authoritative.\n</conversation-summary>"
      } else if (kind === "user" || kind === "shell") {
        const body = message.parts
          .flatMap((part) => {
            if (part.type === "text" && part.ignored !== true && (kind === "shell" || part.synthetic !== true)) return [part.text]
            if (part.type === "subtask") return [part.prompt]
            return []
          })
          .filter((part) => part.trim().length > 0)
          .join("\n")
        if (body) text = `<${kind}>\n${body}\n</${kind}>`
      }
    }
    if (text) blocks.push({ index, text: truncateTitleContext(text, maxBlockChars) })
  }

  const selected = new Map<number, string>()
  let chars = 0
  const add = (block: { index: number; text: string } | undefined) => {
    if (!block || selected.has(block.index)) return
    const separator = selected.size > 0 ? 2 : 0
    const remaining = maxChars - chars - separator
    if (remaining <= 0) return
    const text = truncateTitleContext(block.text, remaining)
    if (!text) return
    selected.set(block.index, text)
    chars += text.length + separator
  }

  if (latestCompaction >= 0) add(blocks.find((block) => block.index === latestCompaction))
  else {
    const opening = messages.findIndex(SessionTurnProvenance.isWorkerPromptTurn)
    add(blocks.find((block) => block.index === opening))
  }
  for (let index = blocks.length - 1; index >= 0; index--) add(blocks[index])
  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("\n\n")
}

function goalAuditLatestWork(messages: readonly SessionV1.WithParts[]) {
  const blocks = messages.slice(-10).flatMap((message) => {
    const parts = message.parts.flatMap((part) => {
      if (part.type === "text" && !part.ignored) return [part.text]
      if (part.type === "tool" && part.state.status === "completed")
        return [`[tool ${part.tool}] ${part.state.title}\n${part.state.output}`]
      if (part.type === "tool" && part.state.status === "error")
        return [`[tool ${part.tool} error] ${part.state.error}`]
      return []
    })
    if (parts.length === 0) return []
    return [`<${message.info.role}>\n${parts.join("\n")}\n</${message.info.role}>`]
  })
  return blocks.join("\n\n").slice(-18_000)
}

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface Interface {
  /**
   * Explicit execution abort. Any autonomous Goal cursor is invalidated so an
   * operator stop cannot be resurrected by an unrelated later wake.
   */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Suspend execution while preserving Goal intent. The exact claimed
   * continuation is requeued after the runner reaches quiescence so resume can
   * reclaim it without inventing a new Goal cycle.
   */
  readonly pause: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * Synchronous public-user admission preflight. HTTP async prompt routes use
   * this before forking so producer-owned-but-user-drivable roots never return
   * a false 204 while opaque worker/special-agent Sessions remain fenced.
   */
  readonly assertUserPromptable: (sessionID: SessionID) => Effect.Effect<Session.Info, HostOwnedSessionError>
  /**
   * Run the focused Goal's independent auditor immediately without fabricating
   * another worker turn. Used by the user-facing "request verification" path
   * and by recovery from an orphaned verification state.
   */
  readonly auditGoal: (sessionID: SessionID) => Effect.Effect<void>
  /**
   * User-owned verification preemption. Durably records the audit request,
   * interrupts active worker/tool execution to a finalized idle state, then
   * launches the independent auditor immediately.
   */
  readonly requestGoalAudit: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error | HostOwnedSessionError>
  /**
   * Trusted first-party user action. Public clients cannot choose provenance;
   * domain handlers use this seam for durable user-owned actions whose semantic
   * source is more precise than an ordinary typed prompt.
   */
  readonly userActionPrompt: (
    input: PromptInput,
    provenance: UserActionPromptProvenance,
  ) => Effect.Effect<SessionV1.WithParts, Image.Error | HostOwnedSessionError>
  /**
   * Host-origin prompt used by host-driven runners (Goal continuation, scheduled
   * tasks). It is not a synthetic user keystroke: it must not supersede
   * autonomous reservations, and host-owned child Sessions are rejected.
   */
  readonly hostPrompt: (
    input: PromptInput,
    provenance?: HostPromptProvenance,
  ) => Effect.Effect<SessionV1.WithParts, Image.Error | HostOwnedSessionError>
  /**
   * Trusted current-model Synthetic ingress for first-party host producers.
   * This is deliberately not exposed through the public prompt payload: typed
   * origin/delegation remains host-owned and the durable SessionInput row is the
   * sole wake source consumed by the mature V1 runtime adapter.
   */
  readonly admitSynthetic: (
    input: SessionInput.SyntheticAdmission & { readonly resume?: boolean },
  ) => Effect.Effect<SessionInput.Entry, HostOwnedSessionError>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError | HostOwnedSessionError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error | HostOwnedSessionError>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  /** Generates a fresh title from the session's conversation; returns the title or undefined when nothing usable is produced. */
  readonly regenerateTitle: (input: {
    sessionID: SessionID
    model?: ModelV2.Ref
    prompt?: string
  }) => Effect.Effect<string | undefined>
}

export class HostOwnedSessionError extends Schema.TaggedErrorClass<HostOwnedSessionError>()(
  "SessionPrompt.HostOwnedSessionError",
  {
    sessionID: SessionID,
    parentID: SessionID,
    kind: Schema.Union([
      Schema.Literal("child"),
      Schema.Literal("scheduled_task"),
      Schema.Literal("delegated_worker"),
      Schema.Literal("special_agent"),
      SpecialAgentSession.Kind,
    ]),
  },
) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const turnCheckpoint = yield* TurnCheckpoint.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const usageAnalytics = yield* UsageAnalytics.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const ingress = yield* SessionIngress.Service
    const question = yield* Question.Service
    const goalContext = yield* GoalContext.Service
    const goals = yield* Goal.Service
    const goalAutomation = yield* GoalAutomation.Service
    const locations = yield* LocationServiceMap.Service
    const database = yield* Database.Service
    const subagentDelegation = yield* SubagentDelegation.make
    const specialAgents = yield* SpecialAgentSession.Service
    const goalAuditorRuntime = makeGoalAuditorRuntime(provider, llm)
    const { db } = database
    const titleLocks = KeyedMutex.makeUnsafe<SessionID>()
    // Throttle for the end-of-turn compaction.prune maintenance fork below.
    // prune re-scans the session's full message history on every turn; with
    // several concurrent sessions on long histories that is a repeated
    // synchronous-DB tax on the shared connection. prune is idempotent
    // maintenance (it only marks already-completed tool parts), so running it
    // at most once per minute per session loses nothing — the next turn's
    // prune observes whatever this one would have.
    const PRUNE_MIN_INTERVAL_MS = 60_000
    const lastPruneAt = new Map<string, number>()
    const maybePrune = (sessionID: SessionID) => {
      const now = Date.now()
      if (now - (lastPruneAt.get(sessionID) ?? 0) < PRUNE_MIN_INTERVAL_MS) return Effect.void
      lastPruneAt.set(sessionID, now)
      if (lastPruneAt.size > 1000) {
        for (const [key, at] of lastPruneAt) {
          if (now - at > PRUNE_MIN_INTERVAL_MS * 2) lastPruneAt.delete(key)
        }
      }
      return compaction.prune({ sessionID })
    }
    let dispatchFn: SessionPromptOps["dispatch"] | undefined
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        // Task/subagent dispatch is a trusted host capability. It may drive an
        // ordinary child Session, but the dedicated Goal Auditor runtime remains
        // the sole execution owner of goal_auditor children.
        prompt: ((input: PromptInput, provenance?: HostPromptProvenance) =>
          hostPrompt(input, provenance).pipe(Effect.catch(Effect.die))) as unknown as SessionPromptOps["prompt"],
        dispatch: ((input: PromptInput, options?: { wait?: boolean; provenance?: HostPromptProvenance }) =>
          dispatchFn
            ? dispatchFn(input, options)
            : Effect.die(new Error("dispatch not initialized"))) as SessionPromptOps["dispatch"],
      } satisfies SessionPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
      yield* goalAutomation.cancel(sessionID)
    })

    const pause = Effect.fn("SessionPrompt.pause")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("pause", { "session.id": sessionID })
      yield* state.cancel(sessionID)
      yield* goalAutomation.requeueClaim(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      const resolved = yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return []
          if (seen.has(name)) return []
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            return found ? [{ type: "agent" as const, name: found.name }] : []
          }
          const stat = info.value
          return [
            {
              type: "file" as const,
              url: pathToFileURL(filepath).href,
              filename: name,
              mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
            },
          ]
        }),
        // Prompt templates are user-controlled; a generated template can
        // reference hundreds of paths. Preserve template order while bounding
        // filesystem/agent lookups per prompt.
        { concurrency: 8 },
      )
      parts.push(...resolved.flat())
      return parts
    })

    // Shared title-generation body, used by auto-title (ensureTitle) and the V1
    // regenerateTitle endpoint. Title style comes from a user-editable policy;
    // the host-owned protocol and generated_title tool remain authoritative.
    // Returns `undefined` when no valid structured artifact is committed, so the
    // caller keeps the existing title untouched.
    const generateTitleUnlocked = Effect.fn("SessionPrompt.generateTitleUnlocked")(function* (input: {
      sessionID: SessionID
      firstUser: SessionV1.WithParts
      context: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
      accountID?: string
      model?: ModelV2.Ref
      previousTitle: string
      prompt?: string
      purpose: "initial" | "regenerate"
    }) {
      const firstInfo = input.firstUser.info
      if (firstInfo.role !== "user") return
      const ag = yield* agents.get("title")
      if (!ag) return
      const cfg = yield* config.get()
      const policySource =
        input.prompt?.trim() || cfg.title_prompt?.trim() || ag.prompt?.trim() || SessionTitle.DEFAULT_TITLE_PROMPT
      const toolChoiceIdentity = (model: Provider.Model): ToolChoiceCapabilityIdentity => ({
        providerID: model.providerID,
        modelID: model.id,
        apiNpm: model.api?.npm,
        apiURL: model.api?.url,
        apiID: model.api?.id,
      })
      // Candidate cascade: explicit picker choice ΓåÆ agent.title.model ΓåÆ
      // config/plugin small model ΓåÆ session/default model. Runtime failures on
      // one candidate should not make manual retitle fail while another usable
      // model is available.
      const resolve = (providerID: ProviderV2.ID, modelID: ModelV2.ID, accountID?: string) =>
        provider.getModel(providerID, modelID, accountID).pipe(
          Effect.option,
          Effect.map(Option.getOrElse(() => undefined)),
        )
      const candidates = [
        input.model ? yield* resolve(input.model.providerID, input.model.id, input.model.accountID) : undefined,
        ag.model ? yield* resolve(ag.model.providerID, ag.model.modelID, ag.model.accountID) : undefined,
        yield* provider.getSmallModel(input.providerID),
        yield* resolve(input.providerID, input.modelID, input.accountID),
      ].filter((item): item is Provider.Model => item !== undefined)
      const seen = new Set<string>()
      const uniqueCandidates = candidates.filter((item) => {
        const key = `${item.providerID}/${item.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const toolCandidates = uniqueCandidates.filter((item) => item.capabilities.toolcall)
      yield* Effect.logInfo("title generation candidates", {
        sessionID: input.sessionID,
        candidates: toolCandidates.map((item) => `${item.providerID}/${item.id}`),
        skippedWithoutToolCalls: uniqueCandidates
          .filter((item) => !item.capabilities.toolcall)
          .map((item) => `${item.providerID}/${item.id}`),
      })
      const titleTranscriptID =
        toolCandidates.length === 0
          ? undefined
          : yield* specialAgents
              .provision({
                ownerKind: SpecialAgentSession.OWNER_SESSION,
                ownerID: input.sessionID,
                agent: "session_title",
                parentSessionID: input.sessionID,
                title: `Title · ${input.previousTitle}`,
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("V1 title generation continuing without a durable transcript", {
                    sessionID: input.sessionID,
                    error: String(error),
                  }),
                ),
                Effect.catch(() => Effect.succeed(undefined)),
              )
      const conversation = assembleV1TitleContext(input.context)
      const titleRequestText = `<title-generation-context>\n${JSON.stringify({
        generationPurpose: input.purpose,
        currentTitle: input.previousTitle,
        sourceMessageID: firstInfo.id,
        conversation,
      })}\n</title-generation-context>`
      if (titleTranscriptID) {
        yield* specialAgents.publishPrompt({
          sessionID: titleTranscriptID,
          agent: "session_title",
          text: titleRequestText,
        })
      }
      for (const mdl of toolCandidates) {
        const title = yield* Effect.gen(function* () {
          yield* Effect.logInfo("title model candidate starting", {
            sessionID: input.sessionID,
            providerID: mdl.providerID,
            modelID: mdl.id,
          })
          const policy = SessionTitle.renderLegacyPolicy(policySource, {
            previousTitle: input.previousTitle,
            conversation,
          })
          const titleAgent: Agent.Info = {
            ...ag,
            prompt: `${policy}\n\n${SessionTitle.PROTOCOL_PROMPT}`,
            // The title runtime supplies exactly one host-owned terminal tool.
            // Do not inherit the built-in title agent's wildcard tool denial or
            // the structured completion tool would be filtered before dispatch.
            permission: [],
          }
          const generatedTitleTool = tool({
            description:
              "Commit the final session title. This is the only valid successful completion for title generation. Supply only the title artifact; do not put explanations or reasoning in the title field. IMMEDIATELY END GENERATION after this tool call; do not reason, emit prose, or call another tool afterward.",
            inputSchema: jsonSchema({
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            }),
          })
          const baseMessages: ModelMessage[] = [{ role: "user" as const, content: titleRequestText }]
          const titleUser = makeV1SpecialAgentAnchor({
            sessionID: input.sessionID,
            agent: "session_title",
            model: { providerID: mdl.providerID, modelID: mdl.id },
          })
          type TranscriptTurn = {
            readonly response: LLMResponse
            readonly publisher: ReturnType<SpecialAgentSession.Interface["publisher"]>
            readonly tokens: {
              readonly input: number
              readonly output: number
              readonly reasoning: number
              readonly cache: { readonly read: number; readonly write: number }
            }
          }
          const pendingTranscriptTurns = new Map<LLMResponse, TranscriptTurn>()
          const settleTranscriptTurn = Effect.fn("SessionPrompt.settleV1TitleTranscriptTurn")(function* (
            response: LLMResponse,
            toolResults: ReadonlyArray<{
              readonly id: string
              readonly name: string
              readonly result: ToolResultValue
            }> = [],
          ) {
            if (!titleTranscriptID) return
            const turn = pendingTranscriptTurns.get(response)
            if (!turn) return
            yield* specialAgents.settleTurn({
              sessionID: titleTranscriptID,
              publisher: turn.publisher,
              response,
              toolResults,
              tokens: turn.tokens,
            })
            pendingTranscriptTurns.delete(response)
          })
          const rejectPendingTranscriptTurns = Effect.fn("SessionPrompt.rejectV1TitleTranscriptTurns")(function* (
            reason: string,
          ) {
            for (const [response, turn] of pendingTranscriptTurns) {
              yield* specialAgents.rejectTurn({
                sessionID: titleTranscriptID!,
                publisher: turn.publisher,
                response,
                tokens: turn.tokens,
                reason,
              })
              pendingTranscriptTurns.delete(response)
            }
          })
          const settleAcceptedTerminal = (response: LLMResponse, call: LLMResponse["toolCalls"][number]) =>
            settleTranscriptTurn(
              response,
              response.toolCalls
                .filter((item) => item.providerExecuted !== true)
                .map((item) => ({
                  id: item.id,
                  name: item.name,
                  result:
                    item.id === call.id && item.name === call.name
                      ? ({
                          type: "text" as const,
                          value: terminalCompletionAccepted(SessionTitle.GENERATED_TITLE_TOOL),
                        } satisfies ToolResultValue)
                      : ({
                          type: "error" as const,
                          value: "Session title protocol rejected this extra tool call.",
                        } satisfies ToolResultValue),
                })),
            )
          const collect = (toolChoice: "required" | "auto", messages: ReadonlyArray<ModelMessage>) =>
            Effect.gen(function* () {
              yield* rejectPendingTranscriptTurns("Session title protocol rejected this provider turn.")
              const startedAt = Date.now()
              const request = {
                agentPrompt: titleAgent.prompt,
                messages,
                tool: SessionTitle.GENERATED_TITLE_TOOL,
                toolChoice,
              }
              const publisher = titleTranscriptID
                ? specialAgents.publisher({
                    sessionID: titleTranscriptID,
                    agent: "session_title",
                    model: ModelV2.Ref.make({ providerID: mdl.providerID, id: mdl.id }),
                  })
                : undefined
              if (publisher) publisher.setRequestSentAt(yield* DateTime.now)
              const stream = llm.stream({
                agent: titleAgent,
                user: titleUser,
                system: [],
                small: true,
                tools: { [SessionTitle.GENERATED_TITLE_TOOL]: generatedTitleTool },
                toolChoice,
                model: mdl,
                sessionID: input.sessionID,
                retries: 2,
                messages: [...messages],
              })
              const collected = collectUntilTerminalTool(
                publisher ? stream.pipe(Stream.tap((event) => publisher.publish(event))) : stream,
                SessionTitle.GENERATED_TITLE_TOOL,
              )
              const response = yield* (publisher
                ? specialAgents.guardProviderTurn({ publisher, label: "Session title", effect: collected })
                : collected)
              if (response) {
                yield* MaintenanceUsage.recordResponse({
                  usage: usageAnalytics,
                  agent: "title",
                  model: mdl,
                  response,
                  request,
                  sessionID: input.sessionID,
                  variant: firstInfo.model.variant,
                  startedAt,
                })
              }
              if (!publisher || !titleTranscriptID || !response) {
                if (publisher && !response)
                  yield* specialAgents.failTurn({
                    publisher,
                    message: "Title generation ended without a terminal response",
                  })
                return response
              }
              const reported = LLMResponse.usage(response)
              const cacheRead = Math.max(0, reported?.cacheReadInputTokens ?? 0)
              const cacheWrite = Math.max(0, reported?.cacheWriteInputTokens ?? 0)
              const reasoning = Math.max(0, reported?.reasoningTokens ?? 0)
              const tokens = {
                input: Math.max(0, (reported?.inputTokens ?? 0) - cacheRead - cacheWrite),
                output: Math.max(0, (reported?.outputTokens ?? 0) - reasoning),
                reasoning,
                cache: { read: cacheRead, write: cacheWrite },
              }
              pendingTranscriptTurns.set(response, { response, publisher, tokens })
              return response
            })
          const collectAdaptive = Effect.fn("SessionPrompt.collectTitle")(function* (
            messages: ReadonlyArray<ModelMessage>,
            preferred: "required" | "auto",
          ) {
            const capability = toolChoiceIdentity(mdl)
            const generated = yield* generateAdaptive({
              identity: capability,
              requested: preferred,
              generate: (toolChoice) =>
                collect(toolChoice, messages),
              onDowngrade: () =>
                Effect.logInfo("title tool-choice compatibility fallback", {
                  sessionID: input.sessionID,
                  providerID: mdl.providerID,
                  modelID: mdl.id,
                  from: "required",
                  to: "auto",
                }),
            })
            if (!generated.response)
              return yield* Effect.fail(new Error("Title generation ended without a terminal response"))
            return { response: generated.response, toolChoice: generated.toolChoice } as const
          })
          return yield* Effect.gen(function* () {
          let preferred: "required" | "auto" = "required"
          const terminal = yield* runTerminalCompletionWithTranscript<ModelMessage, string, unknown>({
            messages: baseMessages,
            toolName: SessionTitle.GENERATED_TITLE_TOOL,
            agentLabel: "session title generator",
            generate: (messages) =>
              collectAdaptive(messages, preferred).pipe(
                Effect.tap((attempt) => Effect.sync(() => (preferred = attempt.toolChoice))),
                Effect.map((attempt) => attempt.response),
              ),
            appendRepair: (messages, response, detail) =>
              appendModelCompletionRepair({
                messages,
                response,
                toolName: SessionTitle.GENERATED_TITLE_TOOL,
                agentLabel: "session title generator",
                detail,
              }),
            validate: (call) =>
              Schema.decodeUnknownEffect(SessionTitle.GeneratedTitleToolInput)(call.input).pipe(
                Effect.mapError((error) => `Invalid ${SessionTitle.GENERATED_TITLE_TOOL} payload: ${String(error)}`),
                Effect.flatMap((decoded) => {
                  const title = SessionTitle.sanitizeTitle(decoded.title)
                  return title
                    ? Effect.succeed(title)
                    : Effect.fail("The generated title is empty or unusable after normalization")
                }),
              ),
            invalid: (failure) =>
              new Error(
                failure.reason === "invalid-payload"
                  ? (failure.detail ?? `Invalid ${SessionTitle.GENERATED_TITLE_TOOL} payload`)
                  : failure.reason === "truncated"
                    ? `Title generation hit the model output limit before it could call ${SessionTitle.GENERATED_TITLE_TOOL}`
                    : `Title generation protocol failure (${failure.reason}): expected exactly one ${SessionTitle.GENERATED_TITLE_TOOL} tool call`,
              ),
          }).pipe(
            Effect.tapError(() => rejectPendingTranscriptTurns("Session title generation failed protocol validation.")),
          )
          yield* settleAcceptedTerminal(terminal.response, terminal.call)
          const title = terminal.artifact
          yield* Effect.logInfo("title model candidate succeeded", {
            sessionID: input.sessionID,
            providerID: mdl.providerID,
            modelID: mdl.id,
            title,
          })
          return title
          }).pipe(
            Effect.ensuring(
              rejectPendingTranscriptTurns("Session title operation ended before the provider turn was interpreted."),
            ),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("title model candidate failed", {
                sessionID: input.sessionID,
                providerID: mdl.providerID,
                modelID: mdl.id,
                error: String(Cause.squash(cause)),
                cause: Cause.pretty(cause),
              })
              return undefined
            }),
          ),
        )
        if (title) return title
      }
      yield* Effect.logWarning("all title model candidates failed", {
        sessionID: input.sessionID,
        candidates: toolCandidates.map((item) => `${item.providerID}/${item.id}`),
        skippedWithoutToolCalls: uniqueCandidates
          .filter((item) => !item.capabilities.toolcall)
          .map((item) => `${item.providerID}/${item.id}`),
      })
    })

    const generateTitle = Effect.fn("SessionPrompt.generateTitle")(function* (
      input: Parameters<typeof generateTitleUnlocked>[0],
    ) {
      return yield* titleLocks.withLock(input.sessionID)(
        Effect.gen(function* () {
          // A queued retitle whose baseline changed while it waited is stale.
          // Do not spend another provider request or append another operation to
          // the shared deterministic title transcript.
          const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (current.title !== input.previousTitle) return undefined
          return yield* generateTitleUnlocked(input)
        }),
      )
    })

    const auditSpadCases = Effect.fn("SessionPrompt.auditSpadCases")(function* (input: {
      sessionID: SessionID
      user: SessionV1.User
      intentExcerpt: string
      activeModel: Provider.Model
      variant?: string
      cases: ReturnType<SpadSupervisor["takeAuditCases"]>
    }) {
      if (input.cases.length === 0) return
      const cfg = yield* config.get()
      if (!SpadAuditor.enabled(cfg.experimental?.spad_auditor)) return

      const resolve = (ref: { providerID: ProviderV2.ID; modelID: ModelV2.ID }) =>
        provider.getModel(ref.providerID, ref.modelID).pipe(Effect.option, Effect.map(Option.getOrElse(() => undefined)))
      const explicit = cfg.experimental?.spad_auditor_model?.trim()
      const explicitModel = explicit ? yield* resolve(Provider.parseModel(explicit)) : undefined
      const smallModel = yield* provider.getSmallModel(input.activeModel.providerID)
      const models = [explicitModel, smallModel].filter((item): item is Provider.Model => item !== undefined)
      const seen = new Set<string>()
      const model = models.find((item) => {
        const key = `${item.providerID}/${item.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return item.capabilities.toolcall
      })
      if (!model) {
        yield* Effect.logInfo("spad auditor skipped: no tool-capable small model", {
          sessionID: input.sessionID,
          activeProviderID: input.activeModel.providerID,
          configuredModel: explicit ?? null,
        })
        return
      }

      const auditPrompt = `${SpadAuditor.DEFAULT_PROMPT}\n\n${SpadAuditor.PROTOCOL_PROMPT}`
      const auditAgent: Agent.Info = {
        name: "spad-auditor",
        description: "Hidden bounded repetition-quality auditor",
        mode: "primary",
        native: true,
        hidden: true,
        temperature: 0,
        permission: [],
        options: {},
        prompt: auditPrompt,
      }
      const verdictTool = tool({
        description:
          "Commit the repetition-quality audit verdict. This is the only valid completion. Use uncertain when evidence is insufficient. IMMEDIATELY END GENERATION after this tool call.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            decision: { type: "string", enum: [...SpadAuditor.DECISIONS] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", enum: [...SpadAuditor.REASONS] },
          },
          required: ["decision", "confidence", "reason"],
          additionalProperties: false,
        }),
      })
      const capability: ToolChoiceCapabilityIdentity = {
        providerID: model.providerID,
        modelID: model.id,
        apiNpm: model.api?.npm,
        apiURL: model.api?.url,
        apiID: model.api?.id,
      }

      const modelRef = ModelV2.Ref.make({ providerID: model.providerID, id: model.id })
      // One durable transcript per owner Session, reused across cases and
      // generations, matching every other host-owned special agent. A provision
      // failure degrades to a live-only audit rather than skipping the guard.
      const transcriptID = yield* specialAgents
        .provision({
          ownerKind: SpecialAgentSession.OWNER_SESSION,
          ownerID: input.sessionID,
          agent: "spad_auditor",
          parentSessionID: input.sessionID,
          title: "SPAD auditor",
          model: modelRef,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("spad auditor continuing without a durable transcript", {
              sessionID: input.sessionID,
              error: String(error),
            }),
          ),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      // Keep the auditor economically bounded even if several heuristic lanes
      // observe the same generation. Remaining cases are still represented by
      // deterministic SPAD telemetry and can be sampled offline.
      for (const candidate of input.cases) {
        const rendered = SpadAuditor.renderCase({
          intentExcerpt: input.intentExcerpt,
          ...candidate.intentIndependent,
        })
        if (transcriptID) {
          yield* specialAgents.publishPrompt({
            sessionID: transcriptID,
            agent: "spad_auditor",
            text: rendered,
          })
        }
        const auditUser = makeV1SpecialAgentAnchor({
          sessionID: input.sessionID,
          agent: "spad_auditor",
          model: {
            providerID: model.providerID,
            modelID: model.id,
            ...(input.variant ? { variant: input.variant } : {}),
          },
        })
        const baseMessages: ModelMessage[] = [{ role: "user", content: rendered }]
        const startedAt = Date.now()
        const run = Effect.gen(function* () {
          let preferred: "required" | "auto" = "required"
          type TranscriptTurn = {
            readonly response: LLMResponse
            readonly publisher: ReturnType<SpecialAgentSession.Interface["publisher"]>
            readonly tokens: {
              readonly input: number
              readonly output: number
              readonly reasoning: number
              readonly cache: { readonly read: number; readonly write: number }
            }
          }
          const pendingTranscriptTurns = new Map<LLMResponse, TranscriptTurn>()
          const settleTranscriptTurn = Effect.fn("SessionPrompt.settleSpadTranscriptTurn")(function* (
            response: LLMResponse,
            toolResults: ReadonlyArray<{
              readonly id: string
              readonly name: string
              readonly result: ToolResultValue
            }> = [],
          ) {
            if (!transcriptID) return
            const turn = pendingTranscriptTurns.get(response)
            if (!turn) return
            yield* specialAgents.settleTurn({
              sessionID: transcriptID,
              publisher: turn.publisher,
              response,
              toolResults,
              tokens: turn.tokens,
            })
            pendingTranscriptTurns.delete(response)
          })
          const rejectPendingTranscriptTurns = Effect.fn("SessionPrompt.rejectSpadTranscriptTurns")(function* (
            reason: string,
          ) {
            for (const [response, turn] of pendingTranscriptTurns) {
              yield* specialAgents.rejectTurn({
                sessionID: transcriptID!,
                publisher: turn.publisher,
                response,
                tokens: turn.tokens,
                reason,
              })
              pendingTranscriptTurns.delete(response)
            }
          })
          const settleAcceptedTerminal = (response: LLMResponse, call: LLMResponse["toolCalls"][number]) =>
            settleTranscriptTurn(
              response,
              response.toolCalls
                .filter((item) => item.providerExecuted !== true)
                .map((item) => ({
                  id: item.id,
                  name: item.name,
                  result:
                    item.id === call.id && item.name === call.name
                      ? ({
                          type: "text" as const,
                          value: terminalCompletionAccepted(SpadAuditor.VERDICT_TOOL),
                        } satisfies ToolResultValue)
                      : ({
                          type: "error" as const,
                          value: "SPAD auditor protocol rejected this extra tool call.",
                        } satisfies ToolResultValue),
                })),
            )
          const collect = (messages: ReadonlyArray<ModelMessage>, toolChoice: "required" | "auto") =>
            Effect.gen(function* () {
              yield* rejectPendingTranscriptTurns("SPAD auditor protocol rejected this provider turn.")
              // One publisher per physical provider request: terminal completion
              // can stop a stream early, and adaptive/repair retries are separate
              // turns that must each start and settle independently.
              const publisher = transcriptID
                ? specialAgents.publisher({ sessionID: transcriptID, agent: "spad_auditor", model: modelRef })
                : undefined
              if (publisher) publisher.setRequestSentAt(yield* DateTime.now)
              const attemptStartedAt = Date.now()
              const stream = llm.stream({
                agent: auditAgent,
                user: auditUser,
                system: [],
                small: true,
                tools: { [SpadAuditor.VERDICT_TOOL]: verdictTool },
                toolChoice,
                model,
                sessionID: input.sessionID,
                retries: 0,
                messages: [...messages],
                maxOutputTokens: 256,
              })
              const collected = collectUntilTerminalTool(
                publisher ? stream.pipe(Stream.tap((event) => publisher.publish(event))) : stream,
                SpadAuditor.VERDICT_TOOL,
              )
              const response = yield* (publisher
                ? specialAgents.guardProviderTurn({ publisher, label: "SPAD auditor", effect: collected })
                : collected)
              if (!publisher || !transcriptID) return response
              if (!response) {
                yield* specialAgents.failTurn({ publisher, message: "SPAD auditor ended without a terminal response" })
                return response
              }
              const reported = LLMResponse.usage(response)
              const cacheRead = Math.max(0, reported?.cacheReadInputTokens ?? 0)
              const cacheWrite = Math.max(0, reported?.cacheWriteInputTokens ?? 0)
              const reasoning = Math.max(0, reported?.reasoningTokens ?? 0)
              const tokens = {
                input: Math.max(0, (reported?.inputTokens ?? 0) - cacheRead - cacheWrite),
                output: Math.max(0, (reported?.outputTokens ?? 0) - reasoning),
                reasoning,
                cache: { read: cacheRead, write: cacheWrite },
              }
              pendingTranscriptTurns.set(response, { response, publisher, tokens })
              yield* specialAgents.recordMaintenance({
                agent: "spad_auditor",
                providerID: modelRef.providerID,
                modelID: modelRef.id,
                variant: input.variant,
                sessionID: input.sessionID,
                costEstimated: reported === undefined,
                tokens: {
                  input: tokens.input,
                  cacheRead,
                  cacheWrite,
                  output: tokens.output,
                  reasoning,
                },
                totalTokens: reported?.totalTokens ?? tokens.input + tokens.output + reasoning,
                startedAt: attemptStartedAt,
                completedAt: Date.now(),
              })
              return response
            })
          return yield* Effect.gen(function* () {
          const terminal = yield* runTerminalCompletionWithTranscript<ModelMessage, SpadAuditor.Verdict, Error>({
            messages: baseMessages,
            toolName: SpadAuditor.VERDICT_TOOL,
            agentLabel: "SPAD auditor",
            maxRepairs: 1,
            generate: (messages) =>
              generateAdaptive({
                identity: capability,
                requested: preferred,
                generate: (toolChoice) => collect(messages, toolChoice),
              }).pipe(
                Effect.tap((attempt) => Effect.sync(() => (preferred = attempt.toolChoice))),
                Effect.flatMap((attempt) =>
                  attempt.response
                    ? Effect.succeed(attempt.response)
                    : Effect.fail(new Error("SPAD auditor ended without a terminal response")),
                ),
                Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
              ),
            appendRepair: (messages, response, detail) =>
              appendModelCompletionRepair({
                messages,
                response,
                toolName: SpadAuditor.VERDICT_TOOL,
                agentLabel: "SPAD auditor",
                detail,
              }),
            validate: (call) => SpadAuditor.validateVerdict(call.input),
            invalid: (failure) =>
              new Error(
                failure.reason === "invalid-payload"
                  ? (failure.detail ?? `Invalid ${SpadAuditor.VERDICT_TOOL} payload`)
                  : `SPAD auditor protocol failure (${failure.reason})`,
              ),
          }).pipe(
            Effect.tapError(() => rejectPendingTranscriptTurns("SPAD auditor failed protocol validation.")),
          )
          yield* settleAcceptedTerminal(terminal.response, terminal.call)
          const disposition = SpadAuditor.disposition(terminal.artifact)
          yield* Effect.logInfo("spad.audit", {
            sessionID: input.sessionID,
            providerID: model.providerID,
            modelID: model.id,
            source: candidate.detection.source,
            lane: candidate.detection.lane,
            policyReason: candidate.policyReason,
            decision: terminal.artifact.decision,
            confidence: terminal.artifact.confidence,
            reason: terminal.artifact.reason,
            disposition,
            latencyMs: Date.now() - startedAt,
          })
          }).pipe(
            Effect.ensuring(
              rejectPendingTranscriptTurns("SPAD auditor operation ended before the provider turn was interpreted."),
            ),
          )
        })
        yield* withSpecialAgentTimeout(
          run,
          () =>
            Effect.logInfo("spad.audit", {
              sessionID: input.sessionID,
              source: candidate.detection.source,
              lane: candidate.detection.lane,
              disposition: "retain-observation",
              error: "timeout",
            }),
          Duration.seconds(4),
        ).pipe(
          Effect.catch((error) =>
            Effect.logInfo("spad.audit", {
              sessionID: input.sessionID,
              source: candidate.detection.source,
              lane: candidate.detection.lane,
              disposition: "retain-observation",
              error: String(error),
            }),
          ),
        )
      }
    })

    // One wall-clock budget for the entire title operation, including model
    // fallback candidates and protocol-repair retries. A per-candidate timeout
    // could otherwise multiply the intended five-minute ceiling.
    const timedGenerateTitle = (input: Parameters<typeof generateTitle>[0]) =>
      withSpecialAgentTimeout(generateTitle(input), () =>
        Effect.fail(new Error("Title generation timed out after 5 minutes")),
      )

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
      accountID?: string
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = SessionTurnProvenance.isWorkerPromptTurn
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return

      const t = yield* timedGenerateTitle({
        sessionID: input.session.id,
        firstUser,
        context,
        providerID: input.providerID,
        modelID: input.modelID,
        accountID: input.accountID,
        previousTitle: input.session.title,
        purpose: "initial",
      })
      if (!t) return
      // Manual rename wins (retitle ┬º6): only write when the title is still the
      // baseline captured at loop start ΓÇö a rename made while generation was in
      // flight discards the generated title.
      const current = yield* sessions.get(input.session.id).pipe(Effect.orDie)
      if (current.title !== input.session.title) return
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    // Manual regeneration (V1 httpapi `session.regenerateTitle`). Unlike
    // ensureTitle this works for any conversation (custom titles, many user
    // messages, forked sessions) and never admits a session_input row. The
    // caller owns the guarded write (baseline compare + session.updated).
    const regenerateTitle = Effect.fn("SessionPrompt.regenerateTitle")(function* (input: {
      sessionID: SessionID
      model?: ModelV2.Ref
      prompt?: string
    }) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      const history = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const real = SessionTurnProvenance.isWorkerPromptTurn
      const firstIdx = history.findIndex(real)
      if (firstIdx === -1) return
      const firstUser = history[firstIdx]
      if (!firstUser || firstUser.info.role !== "user") return
      // Prefer the opening message model, then the session row, then the
      // configured/default model. Legacy V1 sessions can be missing either
      // message or session model metadata; manual retitle should still work.
      const fallbackModel = yield* provider.defaultModel().pipe(Effect.option)
      const baseModel =
        firstUser.info.model ??
        (session.model
          ? {
              providerID: session.model.providerID,
              modelID: session.model.id,
              ...(session.model.accountID ? { accountID: session.model.accountID } : {}),
            }
          : undefined) ??
        Option.getOrUndefined(fallbackModel)
      if (!baseModel) {
        yield* Effect.logWarning("regenerate title has no model fallback", {
          sessionID: input.sessionID,
          hasMessageModel: firstUser.info.model !== undefined,
          hasSessionModel: session.model !== undefined,
        })
        return
      }
      yield* Effect.logInfo("regenerate title starting", {
        sessionID: input.sessionID,
        messageCount: history.length,
        firstUserIndex: firstIdx,
        hasMessageModel: firstUser.info.model !== undefined,
        hasSessionModel: session.model !== undefined,
        baseProviderID: baseModel.providerID,
        baseModelID: baseModel.modelID,
        explicitProviderID: input.model?.providerID,
        explicitModelID: input.model?.id,
      })
      // The first real user message stays pinned at the front of the context and
      // everything newer follows chronologically, so the opening intent always
      // reaches the title model (retitle ┬º3.5).
      const context = history.slice(firstIdx)
      return yield* timedGenerateTitle({
        sessionID: input.sessionID,
        firstUser,
        context,
        providerID: baseModel.providerID,
        modelID: baseModel.modelID,
        accountID: baseModel.accountID,
        model: input.model,
        previousTitle: session.title,
        prompt: input.prompt,
        purpose: "regenerate",
      })
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: SubagentDelegation.ID,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: SubagentDelegation.ID, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* subagentDelegation
        .execute(
          {
            prompt: task.prompt,
            description: task.description,
            subagentType: task.agent,
            command: task.command,
          },
          {
            parentAgent: task.agent,
            assistantMessageID: assistantMessage.id,
            parentSessionID: sessionID,
            abort: taskAbort.signal,
            authorizedAgentNames: new Set([task.agent]),
            promptOps,
            messages: msgs,
            metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
              Effect.gen(function* () {
                part = yield* sessions.updatePart({
                  ...part,
                  type: "tool",
                  state: { ...part.state, ...val },
                } satisfies SessionV1.ToolPart)
              }),
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              permission
                .ask({
                  ...req,
                  sessionID,
                  ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
                })
                .pipe(Effect.orDie),
          },
        )
        .pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: SubagentDelegation.ID, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.TaskSummary, lastUser),
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd, sh, invocation } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const cfg = yield* config.get()
            const sh = Shell.preferred(cfg.shell)
            // Validate/lower the transport before creating any durable shell
            // turn. Unsupported Windows inline forms must fail without leaving
            // a synthetic user message or a forever-"running" tool part.
            const invocation = Shell.invocation(sh, input.command, ctx.directory)
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Shell),
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory, sh, invocation }
          }).pipe(Effect.ensuring(markReady))
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              // Arbitrary shell.env plugin code runs only after the durable shell
              // turn exists and the Runner readiness barrier has opened. That
              // keeps cancellation from waiting behind a hung plugin. Compose,
              // sanitize, and validate one exact environment snapshot, then spawn
              // with extendEnv=false so the process cannot observe a later merge.
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const childEnv = Shell.withSourceEnvironment(
                userChildEnvironment(process.env, { ...shellEnv.env, TERM: "dumb" }),
                invocation.sourceEnvironment,
              )
              Shell.validateInvocationEnvironment(sh, input.command, childEnv)
              const cmd = ChildProcess.make(invocation.command ?? sh, invocation.args, {
                cwd,
                shell: invocation.shell,
                extendEnv: false,
                env: childEnv,
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
      accountID?: string,
    ) {
      const exit = yield* provider.getModel(providerID, modelID, accountID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.accountID ? { accountID: current.model.accountID } : {}),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(
          sessionID,
          (m) => SessionTurnProvenance.isWorkerPromptTurn(m) && m.info.role === "user" && !!m.info.model,
        )
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (
      input: PromptInput,
      provenance: SessionV1.UserTurnProvenance,
    ) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const accountID =
        "accountID" in model && typeof model.accountID === "string"
          ? model.accountID
          : undefined
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID, accountID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        provenance,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(accountID ? { accountID } : {}),
          variant,
          ...(input.subProvider ? { subProvider: input.subProvider } : {}),
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        current.model?.accountID !== info.model.accountID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            ...(info.model.accountID ? { accountID: info.model.accountID } : {}),
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(
                  info.model.providerID,
                  info.model.modelID,
                  info.model.accountID,
                ).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: 8 }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const requirePromptable = Effect.fn("SessionPrompt.requirePromptable")(function* (
      sessionID: SessionID,
      origin: "user" | "host",
    ) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const rawSpecialAgent = SessionMetadataOwnership.specialAgentKind(session.metadata ?? undefined)
      const specialAgent = rawSpecialAgent
        ? (Option.getOrUndefined(Schema.decodeUnknownOption(SpecialAgentSession.Kind)(rawSpecialAgent)) ?? "special_agent")
        : undefined
      // Aggregate producer identity is an execution boundary, not turn
      // authority. Any host-owned special-agent transcript is non-promptable by
      // the normal worker loop regardless of whether the caller is user- or
      // host-originated. Ordinary host-created child workers remain promptable.
      if (specialAgent) {
        return yield* new HostOwnedSessionError({
          sessionID,
          parentID: session.parentID ?? session.id,
          kind: specialAgent,
        })
      }
      // Presence of either Scheduled origin key is producer-owned fail-closed.
      // A genuine Scheduled run root is user-drivable, but a partial/corrupt
      // envelope must not silently downgrade into an ordinary public Session.
      if (
        SessionMetadataOwnership.hasScheduledTaskOrigin(session.metadata ?? undefined) &&
        !ScheduledTaskProvenance.parseSessionMetadata(session.metadata)
      ) {
        return yield* new HostOwnedSessionError({
          sessionID,
          parentID: session.parentID ?? session.id,
          kind: "scheduled_task",
        })
      }
      // Scheduled-task run Sessions are root worker chats, not opaque child
      // workers. Like Swarm member roots they remain directly user-drivable;
      // producer-owned metadata constrains trusted scheduler admission below,
      // not ordinary human interaction.
      // OXP-delegated workers are producer-owned root Sessions. Their durable
      // model/account/nested-delegation contract may only be driven through the
      // trusted host delegation seam; a public user prompt must not silently
      // convert the worker into an ordinary interactive Session.
      if (SessionMetadataOwnership.hasWorkerDelegationOrigin(session.metadata ?? undefined) && origin === "user") {
        return yield* new HostOwnedSessionError({
          sessionID,
          parentID: session.parentID ?? session.id,
          kind: "delegated_worker",
        })
      }
      if (!session.parentID) return session
      if (origin === "host") return session
      return yield* new HostOwnedSessionError({
        sessionID,
        parentID: session.parentID,
        kind: "child",
      })
    })

    const assertUserPromptable = Effect.fn("SessionPrompt.assertUserPromptable")((sessionID: SessionID) =>
      requirePromptable(sessionID, "user"),
    )

    const promptInternal = Effect.fn("SessionPrompt.promptInternal")(function* (
      input: PromptInput,
      origin: "user" | "host",
      provenance: SessionV1.UserTurnProvenance,
      hostPrincipalRef?: string,
    ) {
      const session = yield* requirePromptable(input.sessionID, origin)
      if (origin === "host" && SessionMetadataOwnership.hasScheduledTaskOrigin(session.metadata ?? undefined)) {
        const scheduled = ScheduledTaskProvenance.parseSessionMetadata(session.metadata)
        if (
          !scheduled ||
          provenance.owner !== "host" ||
          provenance.source !== SessionTurnProvenance.Source.ScheduledTaskRun ||
          provenance.ref !== scheduled.scheduledTaskRunID
        ) {
          return yield* new HostOwnedSessionError({
            sessionID: input.sessionID,
            parentID: input.sessionID,
            kind: "scheduled_task",
          })
        }
      }
      if (origin === "host" && SessionMetadataOwnership.hasWorkerDelegationOrigin(session.metadata ?? undefined)) {
        const delegation = SessionMetadataOwnership.workerDelegation(session.metadata ?? undefined)
        // Stable principal identity authorizes the producer; provenance.ref is
        // deliberately reserved for the individual OXP invocation/turn and may
        // therefore change on every continuation.
        if (
          !delegation ||
          provenance.owner !== "host" ||
          provenance.source !== SessionTurnProvenance.Source.OxpDelegation ||
          hostPrincipalRef !== delegation.principalRef
        ) {
          return yield* new HostOwnedSessionError({
            sessionID: input.sessionID,
            parentID: session.parentID ?? session.id,
            kind: "delegated_worker",
          })
        }
      }
      // A genuine user prompt always supersedes a reserved autonomous cycle.
      // If an automatic provider request is already in flight, its eventual
      // settlement observes the missing reservation and cannot resurrect it.
      if (origin === "user") yield* goalAutomation.cancel(input.sessionID)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input, provenance)
      if (origin === "user") yield* goals.reactivateBlockedForSession(input.sessionID)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      // Paused: admit the message durably but do not run (mirror V2 admit-only;
      // delivery is never overwritten). The admitted message drains on resume.
      if (session.pausedAt !== undefined) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const prompt = Effect.fn("SessionPrompt.prompt")((input: PromptInput) =>
      promptInternal(input, "user", SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt)),
    )
    const userActionPrompt = Effect.fn("SessionPrompt.userActionPrompt")(function* (
      input: PromptInput,
      provenance: UserActionPromptProvenance,
    ) {
      yield* requirePromptable(input.sessionID, "user")
      if (input.messageID) {
        const existing = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.option,
        )
        if (Option.isSome(existing)) {
          const message = existing.value
          if (
            message.info.role !== "user" ||
            message.info.provenance?.owner !== "user" ||
            message.info.provenance.source !== provenance.source
          ) {
            return yield* Effect.die(
              new Error(`Trusted user action id ${input.messageID} already exists with incompatible provenance`),
            )
          }
          const requestedText =
            input.parts.length === 1 && input.parts[0]?.type === "text" ? input.parts[0].text.trim() : undefined
          if (requestedText !== undefined && visiblePromptText(message).trim() !== requestedText) {
            return yield* Effect.die(
              new Error(`Trusted user action id ${input.messageID} already exists with incompatible content`),
            )
          }
          if (input.noReply === true) return message
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (session.pausedAt !== undefined) return message
          // Do not cancel/reactivate Goal state again on an idempotent retry.
          // The existing message is not a new human intervention and therefore
          // must not acquire fresh authority over newer Goal lifecycle state.
          return yield* loop({ sessionID: input.sessionID })
        }
      }
      return yield* promptInternal(input, "user", SessionTurnProvenance.user(provenance.source))
    })
    const hostPrompt = Effect.fn("SessionPrompt.hostPrompt")(function* (
      input: PromptInput,
      provenance?: HostPromptProvenance,
    ) {
      const source = provenance?.source ?? SessionTurnProvenance.Source.HostPrompt
      const derived = SessionTurnProvenance.requiresCausalRoot(source)
      if (derived) {
        const rootID = provenance?.sourceMessageID
        if (!rootID) return yield* Effect.die(new Error(`Host source ${source} requires a causal worker root`))
        const root = yield* MessageV2.get({ sessionID: input.sessionID, messageID: rootID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (!root || !SessionTurnProvenance.isWorkerPromptTurn(root)) {
          return yield* Effect.die(
            new Error(`Host source ${source} references an unavailable or invalid worker root ${rootID}`),
          )
        }
        const current = yield* sessions
          .findMessage(input.sessionID, SessionTurnProvenance.isWorkerPromptTurn)
          .pipe(Effect.orDie)
        if (Option.isNone(current) || current.value.info.id !== rootID) {
          return yield* Effect.die(new Error(`Host source ${source} references stale worker root ${rootID}`))
        }
      } else if (provenance?.sourceMessageID) {
        return yield* Effect.die(new Error(`Root host source ${source} cannot carry sourceMessageID`))
      }
      return yield* promptInternal(
        input,
        "host",
        SessionTurnProvenance.host(source, {
          ...(provenance?.sourceMessageID ? { sourceMessageID: provenance.sourceMessageID } : {}),
          ...(provenance?.ref ? { ref: provenance.ref } : {}),
        }),
        provenance?.principalRef,
      )
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const executeGoalAudit = Effect.fn("SessionPrompt.executeGoalAudit")(function* (input: {
      sessionID: SessionID
      origin: "user" | "automatic"
      reservationID?: string
      sourceMessageID: MessageID
      tokens?: number
      workerModel: ModelV2.Ref
      latestWork: string
    }) {
      const ctx = yield* InstanceState.context
      const audit = yield* Effect.gen(function* () {
        const goalAuditor = yield* GoalAuditor.Service
        return yield* goalAuditor.evaluateWithRuntime(
          {
            sessionID: input.sessionID,
            workerModel: input.workerModel,
            latestWork: input.latestWork,
            ...(input.reservationID ? { reservationID: input.reservationID } : {}),
          },
          goalAuditorRuntime,
        )
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))

      return yield* goalAutomation.afterTurn({
        sessionID: input.sessionID,
        origin: input.origin,
        ...(input.reservationID ? { reservationID: input.reservationID } : {}),
        sourceMessageID: input.sourceMessageID,
        tokens: input.tokens,
        audit,
      })
    })

    const isAfterV1 = (left: SessionV1.Info, right: SessionV1.Info) =>
      left.time.created !== right.time.created ? left.time.created > right.time.created : left.id > right.id

    const reconcileGoalState = Effect.fn("SessionPrompt.reconcileGoalState")(function* (
      sessionID: SessionID,
      messages: SessionV1.WithParts[],
    ) {
      // V1 already hydrates the effective transcript once per runner iteration.
      // Derive projection/reset state from those loaded rows; do not add another
      // history query or a projection ownership table merely for Goal state.
      const compaction = MessageV2.latestCompletedCompaction(messages)
      const current = new Map<string, SessionV1.WithParts>()
      for (const message of messages) {
        if (!SessionTurnProvenance.isStateProjectionTurn(message)) continue
        if (compaction && !isAfterV1(message.info, compaction.info)) continue
        if (message.info.role !== "user" || message.info.provenance?.owner !== "host") continue
        const source = message.info.provenance.source
        const previous = current.get(source)
        if (!previous || isAfterV1(message.info, previous.info)) current.set(source, message)
      }

      const focused = yield* goals.focused(sessionID)
      const desired = focused
        ? GoalProjection.sections(focused.detail)
        : (["spec", "progress"] as const).flatMap((kind) => {
            const source =
              kind === "spec"
                ? SessionTurnProvenance.Source.GoalSpecification
                : SessionTurnProvenance.Source.GoalProgress
            const existing = current.get(source)
            if (!existing || existing.info.role !== "user" || existing.info.provenance?.owner !== "host") return []
            const parsed = GoalProjection.parseRef(source, existing.info.provenance.ref)
            if (!parsed) throw new Error(`Malformed ${source} projection provenance: ${existing.info.id}`)
            return [GoalProjection.section(kind, parsed.goalID, GoalProjection.renderAbsent(kind, parsed.goalID))]
          })
      if (desired.length === 0) return 0

      // STATE is provider-user context but not a turn boundary. MessageV2.latest
      // deliberately skips state projections, so this anchor remains the actual
      // human/host/continuation/compaction turn whose model/agent contract V1
      // needs for provider lowering.
      const anchor = MessageV2.latest(messages).user
      if (!anchor) return yield* Effect.die("Goal state projection requires an active V1 user-role turn")

      let published = 0
      for (const value of desired) {
        const previous = current.get(value.source)
        const previousProvenance =
          previous?.info.role === "user" && previous.info.provenance?.owner === "host"
            ? previous.info.provenance
            : undefined
        if (previous) {
          if (!previousProvenance) return yield* Effect.die(`Malformed ${value.source} projection: ${previous.info.id}`)
          if (previousProvenance.ref === value.ref) {
            const exact =
              previous.parts.length === 1 &&
              previous.parts[0]?.type === "text" &&
              previous.parts[0].synthetic === true &&
              previous.parts[0].text === value.text
            if (exact) continue
            if (previous.parts.length === 0) {
              // V1 publication is a two-event commit. A host-owned same-digest
              // message with no parts is the precise crash boundary after
              // MessageUpdated and before PartUpdated; repair that row in place
              // rather than creating a successor state transition.
              yield* sessions.updatePart({
                id: PartID.make(`prt_goal_projection_${previous.info.id.slice("msg_goal_projection_".length)}`),
                messageID: previous.info.id,
                sessionID,
                type: "text",
                text: value.text,
                synthetic: true,
              } satisfies SessionV1.TextPart)
              published++
              continue
            }
            if (!exact)
              return yield* Effect.die(
                `Goal projection ${previous.info.id} claims the current semantic digest with different bytes`,
              )
          }
        }

        const messageID = MessageID.make(
          GoalProjection.publicationMessageID({
            sessionID: sessionID as never,
            section: value,
            ...(compaction ? { resetBoundary: compaction.info.id as never } : {}),
            ...(previous ? { predecessor: previous.info.id as never } : {}),
          }),
        )
        const partID = PartID.make(`prt_goal_projection_${messageID.slice("msg_goal_projection_".length)}`)
        const provenance = SessionTurnProvenance.host(value.source, { ref: value.ref })
        const existing = yield* MessageV2.get({ sessionID, messageID }).pipe(Effect.option)
        if (Option.isSome(existing)) {
          const stored = existing.value
          if (
            stored.info.role !== "user" ||
            !SessionTurnProvenance.hasHostCorrelation(stored, value.source, value.ref)
          )
            return yield* Effect.die(`Goal projection message ${messageID} conflicts with its deterministic identity`)
          const exact =
            stored.parts.length === 1 &&
            stored.parts[0]?.type === "text" &&
            stored.parts[0].synthetic === true &&
            stored.parts[0].text === value.text
          if (exact) continue
          if (stored.parts.length > 0)
            return yield* Effect.die(`Goal projection message ${messageID} has conflicting durable parts`)
          // Crash repair: message publication committed but its sole text part
          // did not. Stable message/part ids make the second half idempotent.
          yield* sessions.updatePart({
            id: partID,
            messageID,
            sessionID,
            type: "text",
            text: value.text,
            synthetic: true,
          } satisfies SessionV1.TextPart)
          published++
          continue
        }

        yield* sessions.updateMessage({
          id: messageID,
          role: "user",
          provenance,
          sessionID,
          time: { created: Date.now() },
          agent: anchor.agent,
          model: anchor.model,
        } satisfies SessionV1.User)
        yield* sessions.updatePart({
          id: partID,
          messageID,
          sessionID,
          type: "text",
          text: value.text,
          synthetic: true,
        } satisfies SessionV1.TextPart)
        published++
      }
      return published
    })

    const materializeGoalContinuation = Effect.fn("SessionPrompt.materializeGoalContinuation")(function* (
      reservation: GoalAutomation.Reservation,
      messages: SessionV1.WithParts[],
    ) {
      const sessionID = SessionID.make(reservation.sessionID)
      // A continuation reservation is one logical worker cycle, but compaction
      // is an execution-context reset inside that cycle. If the original
      // continuation turn fell behind the latest completed compaction boundary,
      // republish the same reservation after that boundary with deterministic
      // epoch-specific ids. This preserves the auditor's exact handoff across
      // compaction/restart without manufacturing a new Goal decision.
      const visible = messages.findLast((message) =>
        SessionTurnProvenance.hasGoalContinuationReservation(message, reservation.id),
      )
      const resetBoundary = visible ? undefined : MessageV2.latestCompletedCompaction(messages)
      const resetBoundaryID = resetBoundary?.info.id
      const stableMessageID = goalContinuationMessageID(reservation.id, resetBoundaryID)
      const stablePartID = goalContinuationPartID(reservation.id, resetBoundaryID)
      let sourceMessageID = reservation.sourceMessageID ? MessageID.make(reservation.sourceMessageID) : undefined

      // Modern reservations always have a causal source and therefore take only
      // direct indexed lookups. The transcript scan below is deliberately
      // quarantined to pre-migration reservations that could not persist it.
      let existing = visible
        ? Option.some(visible)
        : yield* MessageV2.get({ sessionID, messageID: stableMessageID }).pipe(Effect.option)
      if (Option.isNone(existing) && !sourceMessageID) {
        existing = yield* sessions
          .findMessage(sessionID, (message) =>
            SessionTurnProvenance.hasGoalContinuationReservation(message, reservation.id),
          )
          .pipe(Effect.orDie)
      }

      if (Option.isSome(existing)) {
        const turn = existing.value
        if (
          turn.info.role !== "user" ||
          !SessionTurnProvenance.hasGoalContinuationReservation(turn, reservation.id)
        ) {
          throw new Error(`Goal continuation identity collision for reservation ${reservation.id}`)
        }
        const persistedSource = SessionTurnProvenance.goalContinuationSourceMessageID(turn)
        if (sourceMessageID && persistedSource !== sourceMessageID) {
          throw new Error(`Goal continuation causal source mismatch for reservation ${reservation.id}`)
        }
        sourceMessageID ??= persistedSource
        const complete = turn.parts.some(
          (part) => part.type === "text" && part.synthetic === true && part.text === reservation.prompt,
        )
        if (complete) return false
        if (turn.parts.length > 0) {
          throw new Error(`Goal continuation content conflict for reservation ${reservation.id}`)
        }
        yield* sessions.updatePart({
          id: stablePartID,
          messageID: turn.info.id,
          sessionID,
          type: "text",
          text: reservation.prompt,
          synthetic: true,
        } satisfies SessionV1.TextPart)
        return true
      }

      let source: SessionV1.WithParts | undefined
      if (sourceMessageID) {
        source = Option.getOrUndefined(
          yield* MessageV2.get({ sessionID, messageID: sourceMessageID }).pipe(Effect.option),
        )
        if (!source) {
          throw new Error(
            `Goal continuation cannot start because causal worker turn ${sourceMessageID} is missing`,
          )
        }
      } else {
        // Compatibility only: old reservation rows predate durable causal
        // lineage. New reservations never reach this history-hydrating path.
        source = Option.getOrUndefined(
          yield* sessions.findMessage(sessionID, SessionTurnProvenance.isWorkerPromptTurn).pipe(Effect.orDie),
        )
        sourceMessageID = source?.info.id
      }
      if (!source || source.info.role !== "user" || !SessionTurnProvenance.isWorkerPromptTurn(source)) {
        throw new Error("Goal continuation cannot start because the Session has no worker prompt")
      }

      const continuationUser: SessionV1.User = {
        ...source.info,
        id: stableMessageID,
        provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.GoalContinuation, source.info, {
          ref: reservation.id,
        }),
        time: {
          created: resetBoundary
            ? Math.max(Date.now(), resetBoundary.info.time.created + 1)
            : reservation.createdAt,
        },
      }
      // These are intentionally two durable events. Stable ids make the pair
      // convergent: if the process dies after MessageUpdated, restart observes
      // that exact row and publishes only the missing PartUpdated.
      yield* sessions.updateMessage(continuationUser)
      yield* sessions.updatePart({
        id: stablePartID,
        messageID: continuationUser.id,
        sessionID,
        type: "text",
        text: reservation.prompt,
        synthetic: true,
      } satisfies SessionV1.TextPart)
      return true
    })

    const runLoop = Effect.fn("SessionPrompt.run")(function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      let structured: unknown
      let step = 0
      let spad: SpadSupervisor | undefined
      let spadStarted = false
      let spadAuditRemaining = 4
      let turn: TurnCheckpoint.Turn | undefined
      let titleStarted = false
      let goalReservation: GoalAutomation.Reservation | undefined
      let materializedGoalReservationID: string | undefined
      let goalCycleTokens = 0
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      // Hard pause gate (V1): a paused session must not start any provider
      // work. Prompt admission already gates, but direct loop callers (resume,
      // summarize, command) and in-flight wake races need the same check.
      if (session.pausedAt !== undefined) {
        yield* state.deferPending(sessionID)
        return yield* lastAssistant(sessionID)
      }

      while (true) {
        yield* status.set(sessionID, { type: "busy" })
        yield* Effect.logInfo("loop", { "session.id": sessionID, step })

        // Admission and execution are separate decisions. At each provider-cycle
        // boundary choose exactly one canonical SessionInput lane and snapshot
        // the aggregate sequence before promotion. The lane is homogeneous by
        // admission class; arrivals after the cutoff belong to the next cycle.
        //
        // Do this BEFORE Goal reservation claiming or history loading so a
        // genuine User/host arrival cannot be overtaken by autonomous work.
        let promotedClass: SessionInput.AdmissionClass | undefined
        while (true) {
          const lane = yield* SessionInput.nextPendingLane(db, sessionID)
          if (!lane) break
          const cutoff = yield* EventV2.latestSequence(db, sessionID)
          const result = yield* SessionInput.promoteLane(db, events, sessionID, lane, cutoff)
          if (result.promoted > 0) {
            promotedClass = lane.admissionClass
            break
          }
          // A selected row may lose the promote-vs-revoke CAS. Re-evaluate the
          // fixed priority lanes rather than manufacturing an empty provider
          // cycle or falling through to autonomous Goal work.
        }

        if (promotedClass === "user") {
          // Human input supersedes autonomous Goal continuation authority.
          yield* goalAutomation.cancel(sessionID)
          goalReservation = undefined
          materializedGoalReservationID = undefined
        } else if (promotedClass !== undefined && goalReservation) {
          // Host/automatic inbox work wins this cycle, but unlike genuine User
          // input it does not cancel the Goal. Release the claimed reservation so
          // it can be reclaimed after the higher-priority cycle settles.
          yield* goalAutomation.release({ sessionID, reservationID: goalReservation.id })
          goalReservation = undefined
          materializedGoalReservationID = undefined
        }
        if (promotedClass === undefined && !goalReservation) {
          goalReservation = yield* goalAutomation.claim(sessionID)
        }

        let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
          Effect.provideService(Database.Service, database),
        )
        if ((yield* reconcileGoalState(sessionID, msgs)) > 0) {
          msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
        }
        if (goalReservation && materializedGoalReservationID !== goalReservation.id) {
          const changed = yield* materializeGoalContinuation(goalReservation, msgs).pipe(
            Effect.onError(() => goalAutomation.release({ sessionID, reservationID: goalReservation!.id })),
          )
          if (changed) {
            msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
              Effect.provideService(Database.Service, database),
            )
          }
          materializedGoalReservationID = goalReservation.id
        }
        // ── Conversation Control: Effective Context Compiler ─────
        // Fork-owned seam (see FORK.md). Filters excluded/pinned/edits before
        // provider lowering. Best-effort — falls back to canonical on error.
        {
          const maybeCompiled = yield* Effect.gen(function* () {
            const { EffectiveContextCompiler } = yield* Effect.promise(() => import("./context/compiler"))
            const compiled = yield* (EffectiveContextCompiler.compileForSession as any)({
              messages: msgs,
              sessionID,
            }).pipe(Effect.provideService(Database.Service, database))
            const issues = EffectiveContextCompiler.validateEffectiveHistory(compiled.effective)
            if (issues.length > 0) {
              yield* Effect.logWarning("effective context validation warnings", {
                sessionID,
                issues,
              })
              return undefined
            }
            if (compiled.warnings.length > 0) {
              yield* Effect.logWarning("effective context compiler warnings", {
                sessionID,
                warnings: compiled.warnings,
              })
            }
            return compiled
          }).pipe(
            Effect.catch((e) =>
              Effect.logWarning("effective context compile failed — using canonical", {
                sessionID,
                error: String(e),
              }).pipe(Effect.as(undefined)),
            ),
            Effect.catchDefect((e) =>
              Effect.logWarning("effective context compile defect — using canonical", {
                sessionID,
                error: String(e),
              }).pipe(Effect.as(undefined)),
            ),
          )
          if (maybeCompiled) msgs = (maybeCompiled as any).effective as any
        }

        const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

        if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

        const lastUserMsg = msgs.findLast((msg) => msg.info.role === "user" && msg.info.id === lastUser.id)
        const causalRootID = SessionTurnProvenance.causalRootMessageID(lastUserMsg)
        let causalRootMsg =
          causalRootID === undefined ? undefined : msgs.findLast((message) => message.info.id === causalRootID)
        if (!causalRootMsg && causalRootID) {
          // Compaction may legitimately remove the original worker turn from the
          // provider history. Provenance still names it exactly, so recover that
          // one row by primary key instead of scanning/hydrating transcript pages.
          causalRootMsg = Option.getOrUndefined(
            yield* MessageV2.get({ sessionID, messageID: causalRootID }).pipe(Effect.option),
          )
        }
        const workerRootMsg =
          causalRootMsg && SessionTurnProvenance.isWorkerPromptTurn(causalRootMsg) ? causalRootMsg : undefined

        // A provider stream that ended without a terminal finish reason needs a
        // real host-owned turn boundary before another assistant generation.
        // Persist this as a V1 compatibility Synthetic turn instead of adding a
        // request-only provider message. The next loop iteration will parent the
        // assistant to this turn while inherited worker capabilities come from
        // the explicit causal root above.
        if (lastAssistant?.finish === "unknown" && lastAssistant.parentID === lastUser.id) {
          const continuation: SessionV1.User = {
            ...lastUser,
            id: MessageID.ascending(),
            provenance: SessionTurnProvenance.hostDerived(
              SessionTurnProvenance.Source.UnknownFinishContinuation,
              lastUser,
              { ref: lastAssistant.id },
            ),
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(continuation)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: continuation.id,
            sessionID,
            type: "text",
            text: UNKNOWN_FINISH_CONTINUATION_PROMPT,
            synthetic: true,
          } satisfies SessionV1.TextPart)
          continue
        }

        // Destructive SPAD-R recovery remains explicitly opt-in. The bounded
        // veto-only auditor is enabled by default, so an ordinary turn still
        // runs SPAD in observe-only mode to collect ambiguous evidence without
        // gaining authority to mutate or abort model output.
        if (!spadStarted && lastUserMsg) {
          const experimental = (yield* config.get()).experimental
          const recoveryEnabled = experimental?.spad_recovery === true
          const auditorEnabled = SpadAuditor.enabled(experimental?.spad_auditor)
          if (recoveryEnabled || auditorEnabled) {
            const userText = visibleWorkerPromptText(workerRootMsg)
            spad = new SpadSupervisor()
            const policy = makeTurnPolicy(userText, lastUser.format?.type === "json_schema")
            spad.beginTurn(
              experimental?.spad_observe_only || !recoveryEnabled ? { ...policy, observeOnly: true } : policy,
            )
            spadStarted = true
          }
        }

        const lastAssistantMsg = msgs.findLast(
          (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
        )
        // Some providers return "stop" even when the assistant message contains
        // tool calls. Keep the loop running so tool results can be sent back to
        // the model, but ignore cleanup-marked interrupted orphans.
        const hasToolCalls =
          lastAssistantMsg?.parts.some(
            (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
          ) ?? false

        if (
          lastAssistant?.finish &&
          !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
          !hasToolCalls &&
          lastAssistant.parentID === lastUser.id &&
          !goalReservation
        ) {
          const hasPendingIngress = yield* ingress.hasPending(sessionID).pipe(Effect.catch(() => Effect.succeed(false)))
          let gated = false
          if (hasPendingIngress) {
            gated = (
              yield* interactionGate({
                sessionID,
                questions: () => question.list(),
                permissions: () => permission.list(),
              })
            ).blocked
            if (!gated) {
              yield* Effect.logInfo("loop continuing for pending monitor ingress", { sessionID })
              // don't break — next iteration will drain ingress as system context
            } else {
              yield* Effect.logInfo("loop not continuing — ingress gated", { sessionID })
            }
          }
          if (!hasPendingIngress || gated) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }
          // else: pending ingress present, not gated → continue loop to process event
        }

        // Allocate a checkpoint only after proving this iteration will actually
        // execute work. A quiescent wake may exist solely to reconcile durable
        // state (for example after compaction or a terminal Goal audit);
        // allocating before the terminal-assistant gate creates a duplicate
        // checkpoint for the same canonical worker root.
        if (step === 0 && turn === undefined) {
          const checkpointUserMessageID = SessionTurnProvenance.checkpointRootMessageID(lastUserMsg) ?? lastUser.id
          turn = yield* turnCheckpoint.begin({ sessionID, userMessageID: checkpointUserMessageID }).pipe(
            Effect.catch((err) =>
              Effect.logWarning("turn checkpoint begin failed", {
                "session.id": sessionID,
                error: String(err),
              }).pipe(Effect.as(undefined)),
            ),
          )
        }

        step++
        if (step === 1 && !titleStarted) {
          titleStarted = true
          yield* title({
            session,
            modelID: lastUser.model.modelID,
            providerID: lastUser.model.providerID,
            accountID: lastUser.model.accountID,
            history: msgs,
          }).pipe(Effect.ignore, Effect.forkIn(scope))
        }

        const model = yield* getModel(
          lastUser.model.providerID,
          lastUser.model.modelID,
          sessionID,
          lastUser.model.accountID,
        )
        const task = tasks.pop()

        if (task?.type === "subtask") {
          yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
          continue
        }

        if (task?.type === "compaction") {
          const result = yield* compaction.process({
            messages: msgs,
            parentID: lastUser.id,
            sessionID,
            auto: task.auto,
            continueAfter: task.continueAfter,
            overflow: task.overflow,
          })
          // A prompt can be admitted while compaction is generating its
          // summary. Re-read after compaction: the original continuation
          // decision predates that prompt, so stopping here would leave the
          // newly admitted user message stranded until another wake.
          const afterCompaction = yield* MessageV2.stream(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )
          // Compaction is the state reset boundary. Reconcile from the history
          // this branch already re-read for concurrent-user detection, avoiding
          // another full transcript query while ensuring current Goal state is
          // durable even when compaction stops rather than auto-continues.
          yield* reconcileGoalState(sessionID, MessageV2.filterCompacted(afterCompaction))
          // Compaction is also an execution-context reset for an in-flight Goal
          // cycle. The reservation itself remains the same durable decision, but
          // its host continuation may now sit behind the compacted boundary.
          // Force the next iteration through the idempotent materializer so the
          // exact auditor handoff is visible in the post-compaction epoch.
          if (goalReservation) materializedGoalReservationID = undefined
          const newestUser = MessageV2.latest(afterCompaction).user
          const hasConcurrentUser =
            newestUser !== undefined &&
            (newestUser.time.created > lastUser.time.created ||
              (newestUser.time.created === lastUser.time.created && newestUser.id > lastUser.id))
          if (hasConcurrentUser) continue
          if (result === "stop") {
            // A failed compaction cannot safely retry the provider cycle, but it
            // also must not strand the Goal cursor as process-owned work. Requeue
            // the exact reservation for the next legitimate wake/recovery.
            if (goalReservation) {
              yield* goalAutomation.release({ sessionID, reservationID: goalReservation.id })
              goalReservation = undefined
              materializedGoalReservationID = undefined
            }
            break
          }
          // Manual compaction controls only ordinary chat autocontinue. If a
          // Goal reservation is already executing, Goal Mode's single server-
          // owned behavior remains authoritative and the same logical cycle must
          // resume after the maintenance boundary.
          if (!task.auto && !task.continueAfter && !goalReservation) break
          continue
        }

        if (
          lastFinished &&
          lastFinished.summary !== true &&
          (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
        ) {
          if (!workerRootMsg) throw new Error("Compaction cannot preserve causal provenance without a worker prompt root")
          yield* compaction.create({
            sessionID,
            agent: lastUser.agent,
            model: lastUser.model,
            sourceMessageID: workerRootMsg.info.id,
            auto: true,
          })
          continue
        }

        const agent = yield* agents.get(lastUser.agent)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
          yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }
        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps
        msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
          Effect.provideService(RuntimeFlags.Service, flags),
          Effect.provideService(FSUtil.Service, fsys),
          Effect.provideService(Session.Service, sessions),
        )

        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.model.variant,
          path: { cwd: ctx.directory, root: ctx.worktree },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          sessionID,
        }
        yield* sessions.updateMessage(msg)

        const finalizeInterruptedAssistant = Effect.gen(function* () {
          if (msg.time.completed) return
          msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
            providerID: msg.providerID,
            aborted: true,
          })
          msg.time.completed = Date.now()
          yield* sessions.updateMessage(msg)
        })

        // The durable TurnCheckpoint and SessionProcessor historically took
        // two independent pre-turn snapshots on step 1. Processor creation is
        // synchronous on its snapshot anyway, so joining the already-running
        // checkpoint capture cannot add latency and removes one complete Git
        // refresh/tree write. Later model steps still capture independently
        // because tools may have mutated files between generations.
        const initialSnapshot = step === 1 && turn ? yield* Fiber.join(turn.beforeFiber) : undefined
        const handle = yield* processor
          .create({
            assistantMessage: msg,
            sessionID,
            model,
            spad,
            initialSnapshot,
          })
          .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

        const outcome: "break" | "continue" | "goal-audit" = yield* Effect.gen(function* () {
          const canonicalWorkerInput = workerRootMsg
            ? yield* SessionInput.findEntry(db, CurrentSessionMessage.ID.make(workerRootMsg.info.id))
            : undefined
          const authorizedAgentNames = canonicalWorkerInput
            ? SessionInput.authorizedAgentNames(canonicalWorkerInput.item)
            : new Set((workerRootMsg?.parts ?? []).flatMap((part) => (part.type === "agent" ? [part.name] : [])))
          const promptOps = yield* ops()

          const tools = yield* SessionTools.resolve({
            agent,
            session,
            model,
            processor: handle,
            authorizedAgentNames,
            workerRootMessageID: workerRootMsg?.info.id,
            messages: msgs,
            promptOps,
          }).pipe(
            Effect.provideService(Plugin.Service, plugin),
            Effect.provideService(Permission.Service, permission),
            Effect.provideService(ToolRegistry.Service, registry),
            Effect.provideService(MCP.Service, mcp),
            Effect.provideService(Truncate.Service, truncate),
            Effect.provideService(RuntimeFlags.Service, flags),
          )

          if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = createStructuredOutputTool({
              schema: lastUser.format.schema,
              onSuccess(output) {
                structured = output
              },
            })
          }

          if (step === 1)
            yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

          // Plugin message transforms are provider-context extensions only.
          // Isolate them from authoritative history because later logic in this
          // same turn still consumes `msgs` for Goal reconciliation and
          // provenance-sensitive continuation decisions.
          const providerHistory = yield* plugin.transformChatMessages(msgs)

          // Drain monitor ingress at safe boundary — respecting Question/Permission gates (§48-49)
          let monitorContext: string | undefined
          {
            const gate = yield* interactionGate({
              sessionID,
              questions: () => question.list(),
              permissions: () => permission.list(),
            })
            if (!gate.blocked) {
              const evs = yield* ingress.drain(sessionID).pipe(Effect.catch(() => Effect.succeed([] as any[])))
              if (evs.length > 0) monitorContext = formatMonitorEvents(evs as any)
            } else {
              // keep queued — do not drain when gate active
              yield* Effect.logInfo("monitor ingress gated — retaining events", {
                sessionID,
                hasQuestion: gate.hasQuestion,
                hasPermission: gate.hasPermission,
              })
            }
          }

          const [skills, env, instructions, mcpInstructions, goalSystem, modelMsgs] = yield* Effect.all([
            sys.skills(agent),
            sys.environment(model),
            instruction.system().pipe(Effect.orDie),
            sys.mcp(agent, session.permission),
            goalContext.render(sessionID),
            MessageV2.toModelMessagesEffect(providerHistory, model),
          ])
          const explicitToolContext = yield* SessionTools.explicitLazyToolContext({
            agent,
            text: visibleWorkerPromptText(workerRootMsg),
            permission: session.permission,
          }).pipe(
            Effect.provideService(ToolRegistry.Service, registry),
            Effect.catch((error) =>
              Effect.logWarning("explicit lazy tool context failed", {
                sessionID,
                error: String(error),
              }).pipe(Effect.as(undefined)),
            ),
          )
          const system = [
            ...env,
            ...instructions,
            ...(mcpInstructions ? [mcpInstructions] : []),
            ...(skills ? [skills] : []),
            ...(goalSystem ? [goalSystem] : []),
            ...(monitorContext ? [monitorContext] : []),
          ]
          const format = lastUser.format ?? { type: "text" as const }
          if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
          const result = yield* handle
            .process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...modelMsgs,
                ...(explicitToolContext ? [{ role: "user" as const, content: explicitToolContext }] : []),
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })
            .pipe(
              Effect.onError(() =>
                goalReservation
                  ? goalAutomation.release({ sessionID, reservationID: goalReservation.id })
                  : Effect.void,
              ),
            )
          goalCycleTokens += goalTokenCount(handle.message.tokens)

          if (spad) {
            const selected = spad.takeAuditCases(Math.max(0, spadAuditRemaining))
            spadAuditRemaining -= selected.length
            if (selected.length > 0) {
              yield* auditSpadCases({
                sessionID,
                user: lastUser,
                intentExcerpt: visibleWorkerPromptText(workerRootMsg),
                activeModel: model,
                variant: lastUser.model.variant,
                cases: selected,
              }).pipe(Effect.forkIn(scope))
            }
          }

          if (structured !== undefined) {
            handle.message.structured = structured
            handle.message.finish = handle.message.finish ?? "stop"
            yield* sessions.updateMessage(handle.message)
            return "break" as const
          }

          if (handle.recovery) {
            const recoveryUser: SessionV1.User = {
              ...lastUser,
              id: MessageID.ascending(),
              provenance: SessionTurnProvenance.hostDerived(
                SessionTurnProvenance.Source.RecoveryContinuation,
                lastUser,
              ),
              time: { created: Date.now() },
            }
            yield* sessions.updateMessage(recoveryUser)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: recoveryUser.id,
              sessionID,
              type: "text",
              text: handle.recovery.prompt,
              synthetic: true,
            } satisfies SessionV1.TextPart)
            return "continue" as const
          }

          const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
          if (finished && !handle.message.error) {
            // Surface any content-filter finish (e.g. Anthropic stop_reason:
            // refusal) as an error. These turns may have produced no visible
            // output at all ΓÇö previously the session went idle silently ΓÇö or
            // partial text that was cut off by the provider's filter.
            if (handle.message.finish === "content-filter") {
              handle.message.error = new SessionV1.ContentFilterError({
                message: "The response was blocked by the provider's content filter",
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              return "break" as const
            }
            if (format.type === "json_schema") {
              handle.message.error = new SessionV1.StructuredOutputError({
                message: "Model did not produce structured output",
                retries: 0,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }
          }

          if (result === "compact") {
            if (!workerRootMsg) throw new Error("Compaction cannot preserve causal provenance without a worker prompt root")
            yield* compaction.create({
              sessionID,
              agent: lastUser.agent,
              model: lastUser.model,
              sourceMessageID: workerRootMsg.info.id,
              auto: true,
              overflow: !handle.message.finish,
            })
          }
          if (result === "stop") return "break" as const
          // SessionProcessor returns "continue" after an ordinary successful
          // model completion; "stop" is reserved for blocked/error/SPAD-abort
          // paths. Goal verification must therefore key off the authoritative
          // assistant terminal state, not the processor control-flow result.
          // Some providers also report `stop` while emitting host-executed tool
          // calls, so defer verification until those results have gone back
          // through the worker loop.
          if (
            result === "continue" &&
            goalSystem &&
            finished &&
            !handle.message.error &&
            !handle.hasNonProviderToolCalls &&
            (yield* goalAutomation.shouldAudit(sessionID))
          )
            return "goal-audit" as const
          return "continue" as const
        }).pipe(
          Effect.ensuring(instruction.clear(handle.message.id)),
          Effect.onInterrupt(() => finalizeInterruptedAssistant),
        )
        if (outcome === "goal-audit") {
          const completedReservation = goalReservation
          if (!workerRootMsg || workerRootMsg.info.role !== "user") {
            yield* goalAutomation.failAudit({
              sessionID,
              error: "Goal auditor cannot reserve a continuation because the causal worker prompt is unavailable.",
            })
            break
          }
          const auditHistory = yield* sessions.messages({ sessionID, limit: 10 }).pipe(Effect.orDie)
          const decision = yield* executeGoalAudit({
            sessionID,
            origin: completedReservation ? "automatic" : "user",
            ...(completedReservation ? { reservationID: completedReservation.id } : {}),
            sourceMessageID: workerRootMsg.info.id,
            tokens: goalCycleTokens,
            workerModel: {
              providerID: ProviderV2.ID.make(model.providerID),
              id: ModelV2.ID.make(model.id),
              ...(lastUser.model.variant ? { variant: ModelV2.VariantID.make(lastUser.model.variant) } : {}),
            },
            latestWork: goalAuditLatestWork(auditHistory),
          })
          // Auditor reconciliation mutates authoritative lifecycle/progress
          // state. Publish that complete state only after the worker/auditor
          // cycle has settled and before any new automatic continuation.
          yield* reconcileGoalState(sessionID, msgs)
          goalReservation = undefined
          if (decision.reservation) {
            goalReservation = yield* goalAutomation.claim(sessionID)
            if (goalReservation) {
              // A Goal continuation is a fresh bounded logical cycle. The
              // claimed reservation is materialized as a durable synthetic user
              // turn at the top of the next iteration; it never enters the
              // worker's system channel. Keep the existing TurnCheckpoint open
              // so one user-owned Goal run remains one rollback boundary.
              step = 0
              goalCycleTokens = 0
              continue
            }
          }
          break
        }
        if (outcome === "break") {
          if (goalReservation) {
            yield* goalAutomation.cancel(sessionID)
            goalReservation = undefined
          }
          break
        }
        continue
      }

      // Quiescence: the turn reached a terminal assistant completion. Capture
      // the post-turn tree, diff against the pre-turn tree, and finalize the
      // checkpoint row (best-effort; never breaks the turn result).
      yield* turnCheckpoint.finish(turn)
      turn = undefined

      yield* maybePrune(sessionID).pipe(Effect.ignore, Effect.forkIn(scope))
      return yield* lastAssistant(sessionID)
    })

    // SessionRunState owns process-local activation; SessionInput owns durable
    // work. Register the raw drain (not `loop`, which would reacquire ownership)
    // so releaseIfDrained can continue newly committed work under the SAME
    // generation and close the cross-process admission-vs-release race.
    yield* state.registerDrain(
      (sessionID) =>
        requirePromptable(sessionID, "host").pipe(
          Effect.catch(Effect.die),
          Effect.andThen(runLoop(sessionID)),
        ) as unknown as Effect.Effect<SessionV1.WithParts>,
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts, never, any> = Effect.fn("SessionPrompt.loop")(
      function* (input: LoopInput) {
        // Defense in depth: host-owned Goal Auditor children are never worker
        // Sessions. Public prompt entry points already reject them, but direct
        // internal loop callers must not be able to bypass that ownership
        // boundary and accidentally run coding/tool orchestration as the auditor.
        yield* requirePromptable(input.sessionID, "host").pipe(Effect.catch(Effect.die))
        return yield* (
          state.ensureRunning as unknown as (
            a: SessionID,
            b: Effect.Effect<SessionV1.WithParts, never, any>,
            c: Effect.Effect<SessionV1.WithParts, never, any>,
          ) => Effect.Effect<SessionV1.WithParts, never, any>
        )(
          input.sessionID,
          lastAssistant(input.sessionID) as unknown as Effect.Effect<SessionV1.WithParts, never, any>,
          runLoop(input.sessionID).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? turnCheckpoint.finishAborted(input.sessionID).pipe(
                    // A claimed Goal continuation is a durable cursor, not a
                    // property of this Effect fiber. Any abnormal loop exit must
                    // return the claim to pending so restart/resume/recovery can
                    // make forward progress instead of leaving a false owner.
                    Effect.ensuring(goalAutomation.requeueClaim(input.sessionID)),
                  )
                : Effect.void,
            ),
          ) as unknown as Effect.Effect<SessionV1.WithParts, never, any>,
        )
      },
    )

    const admitSynthetic = Effect.fn("SessionPrompt.admitSynthetic")(function* (
      input: SessionInput.SyntheticAdmission & { readonly resume?: boolean },
    ) {
      const session = yield* requirePromptable(input.sessionID, "host")
      const admitted = yield* SessionInput.admitSynthetic(db, events, input)
      if (input.resume === false || session.pausedAt !== undefined) return admitted

      // Admission is durable before activation. A different process may already
      // own execution; in that case its releaseIfDrained transaction observes
      // this row and continues. Local activation failures are logged but cannot
      // roll back or duplicate the admitted intent.
      yield* loop({ sessionID: input.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("trusted Synthetic wake did not acquire/run locally", {
            sessionID: input.sessionID,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined as unknown as SessionV1.WithParts)),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
      return admitted
    })

    const auditGoal = Effect.fn("SessionPrompt.auditGoal")(function* (sessionID: SessionID) {
      // Durable execution ownership is the admission authority. SessionStatus is
      // a process-local presentation projection and can lag the exact-release
      // boundary during cancellation, or appear idle while another process owns
      // the Session. Never launch an auditor from that projection alone.
      const quiescent = yield* state.assertNotBusy(sessionID).pipe(
        Effect.as(true),
        Effect.catchTag("SessionBusyError", () => Effect.succeed(false)),
      )
      if (!quiescent) return
      const runtime = yield* goalAutomation.runtime(sessionID)
      // A running auditor or an already-authorized continuation owns the Goal.
      // Never create a second independent auditor alongside it.
      if (runtime?.phase === "auditing" || runtime?.phase === "working" || runtime?.phase === "continuation_pending") return
      if (!(yield* goalAutomation.shouldAudit(sessionID))) return

      const lastUserMatch = yield* sessions
        .findMessage(sessionID, SessionTurnProvenance.isWorkerPromptTurn)
        .pipe(Effect.orDie)
      if (Option.isNone(lastUserMatch)) {
        yield* goalAutomation.failAudit({ sessionID, error: "Goal auditor cannot start because the Session has no worker prompt." })
        return
      }
      const lastUser = lastUserMatch.value
      if (lastUser.info.role !== "user") {
        yield* goalAutomation.failAudit({ sessionID, error: "Goal auditor cannot start because the Session has no worker prompt." })
        return
      }
      // Recent work context stays intentionally bounded; model provenance does
      // not. Long-running Goal sessions can contain many assistant/tool messages
      // since their last user-authored turn, so a bounded page must never be
      // used to decide whether a worker prompt exists.
      const history = yield* sessions.messages({ sessionID, limit: 10 }).pipe(Effect.orDie)

      const workerModel: ModelV2.Ref = {
        providerID: ProviderV2.ID.make(lastUser.info.model.providerID),
        id: ModelV2.ID.make(lastUser.info.model.modelID),
        ...(lastUser.info.model.variant ? { variant: ModelV2.VariantID.make(lastUser.info.model.variant) } : {}),
      }

      const decision = yield* executeGoalAudit({
        sessionID,
        origin: "user",
        sourceMessageID: lastUser.info.id,
        workerModel,
        latestWork: goalAuditLatestWork(history),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause)
            const message = error instanceof Error ? error.message : String(error)
            yield* goalAutomation.failAudit({ sessionID, error: message })
            yield* Effect.logError("Goal audit failed", { sessionID, cause: Cause.pretty(cause) })
            return undefined
          }),
        ),
      )
      if (!decision) return

      // Auditor reconciliation changes authoritative Goal state independently
      // of the worker transcript. Publish the resulting STATE directly here;
      // a terminal audit must not re-enter the worker loop merely to project it.
      const effective = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      yield* reconcileGoalState(sessionID, effective)

      // Only an actual continuation reservation authorizes another worker cycle.
      // The loop claims/materializes that reservation at its own admission seam.
      if (decision.reservation) {
        yield* loop({ sessionID }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (
              error instanceof Session.BusyError ||
              (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionBusyError")
            ) {
              // A concurrent genuine user turn may acquire the parent Session
              // after the independent audit settles. User admission cancels the
              // autonomous reservation, so a busy continuation wake is benign
              // contention, not an auditor failure.
              return Effect.logInfo("Goal continuation wake coalesced with existing Session owner", { sessionID })
            }
            return Effect.failCause(cause)
          }),
        )
      }
    })

    const requestGoalAudit = Effect.fn("SessionPrompt.requestGoalAudit")(function* (sessionID: SessionID) {
      const requested = yield* goalAutomation.requestAudit(sessionID)
      if (!requested) return
      if (requested.phase === "auditing") return

      // A user verification request is explicit preemption. SessionRunState owns
      // the worker/tool fiber and its interrupt cleanup finalizes partial text,
      // reasoning, and tool parts before publishing the parent Session idle.
      // Only after that teardown completes may the independent auditor inspect
      // the durable transcript/workspace.
      yield* state.cancel(sessionID)
      yield* auditGoal(sessionID)
    })

    // Register monitor ingress wake handler — enqueue first, wake second, coalesce if busy, gate on Question/Permission (§42-49)
    yield* ingress.registerWakeHandler(
      (sessionID: SessionID) =>
        Effect.gen(function* () {
          const gate = yield* interactionGate({
            sessionID,
            questions: () => question.list(),
            permissions: () => permission.list(),
          })
          if (gate.hasQuestion) {
            yield* Effect.logInfo("monitor wake gated by question", { sessionID })
            return
          }
          if (gate.hasPermission) {
            yield* Effect.logInfo("monitor wake gated by permission", { sessionID })
            return
          }
          const s = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined as any)))
          if (!s) return
          if (s.pausedAt !== undefined) {
            yield* Effect.logInfo("monitor wake gated by paused session", { sessionID })
            return
          }
          const st = yield* status.get(sessionID)
          if (st.type !== "idle") {
            yield* Effect.logInfo("monitor wake coalesced (busy)", { sessionID, status: st.type })
            return
          }
          yield* Effect.logInfo("monitor wake — starting loop for pending ingress", { sessionID })
          yield* loop({ sessionID }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.ignore)
        }) as Effect.Effect<void>,
    )

    dispatchFn = Effect.fn("SessionPrompt.dispatch")(function* (
      input: PromptInput,
      options?: { wait?: boolean; provenance?: HostPromptProvenance },
    ) {
      const admitted = yield* hostPrompt({ ...input, noReply: true }, options?.provenance)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (session.pausedAt !== undefined) {
        return { admitted, paused: true }
      }
      const run = loop({ sessionID: input.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("session tool dispatch failed", {
              "session.id": input.sessionID,
              cause: Cause.pretty(cause),
            })
            const error = Cause.squash(cause)
            const message = error instanceof Error ? error.message : String(error)
            yield* events
              .publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error: { name: "DispatchError", message } as any,
              })
              .pipe(Effect.ignore)
            return yield* Effect.failCause(cause)
          }),
        ),
      )
      const fiber = yield* run.pipe(Effect.forkIn(scope, { startImmediately: true }))
      if (options?.wait !== true) {
        return { admitted, paused: false }
      }
      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) {
        return { admitted, paused: false, result: exit.value }
      }
      return { admitted, paused: false }
    }) as unknown as SessionPromptOps["dispatch"]

    const shell: (
      input: ShellInput,
    ) => Effect.Effect<SessionV1.WithParts, Session.BusyError | HostOwnedSessionError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      yield* requirePromptable(input.sessionID, "user")
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      // Commands may expand and execute !`shell` substitutions before they
      // become a prompt, so reject host-owned children before any side effect.
      yield* requirePromptable(input.sessionID, "user")
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const instance = yield* InstanceState.context
        const results = yield* Effect.forEach(
          shellMatches,
          ([, command]) =>
            Effect.try({
              try: () => ShellLaunch.command(sh, command, instance.directory, process.env),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(
              // Preserve the historical custom-command behavior for process
              // launch/read failures and non-zero shell exits: substitution
              // contributes whatever stdout was produced (often empty). Host
              // transport validation above is deliberately NOT swallowed.
              Effect.flatMap((child) => spawner.string(child).pipe(Effect.catch(() => Effect.succeed("")))),
            ),
          { concurrency: 4 },
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* promptInternal(
        {
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
        },
        "user",
        SessionTurnProvenance.user(SessionTurnProvenance.Source.Command),
      )
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel: cancel as unknown as Interface["cancel"],
      pause: pause as unknown as Interface["pause"],
      assertUserPromptable: assertUserPromptable as unknown as Interface["assertUserPromptable"],
      auditGoal: auditGoal as unknown as Interface["auditGoal"],
      requestGoalAudit: requestGoalAudit as unknown as Interface["requestGoalAudit"],
      prompt: prompt as unknown as Interface["prompt"],
      userActionPrompt: userActionPrompt as unknown as Interface["userActionPrompt"],
      hostPrompt: hostPrompt as unknown as Interface["hostPrompt"],
      admitSynthetic: admitSynthetic as unknown as Interface["admitSynthetic"],
      loop: loop as unknown as Interface["loop"],
      shell: shell as unknown as Interface["shell"],
      command: command as unknown as Interface["command"],
      resolvePromptParts: resolvePromptParts as unknown as Interface["resolvePromptParts"],
      regenerateTitle: regenerateTitle as unknown as Interface["regenerateTitle"],
    } as unknown as Interface)
  }),
)

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output ΓÇö the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    BackgroundJob.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    TurnCheckpoint.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    UsageAnalytics.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    SessionIngress.node,
    Question.node,
    GoalContext.node,
    Goal.node,
    GoalAutomation.node,
    SpecialAgentSession.node,
    locationServiceMapNode,
  ],
})

export * as SessionPrompt from "./prompt"
