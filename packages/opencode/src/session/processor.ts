import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { SessionError } from "@opencode-ai/schema/session-error"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { ForkCredentials } from "@/fork/credentials"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { resolveRoutedAccount, routedAccountMismatch } from "@/provider/routing-metadata"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { SpadSupervisor } from "./spad/supervisor"
import type { SpadAction } from "./spad/types"
import { isSpadMutatingTool, toolResourceKey } from "./spad/thrash"
import { consumeWithFlushDeadline } from "./stream-flush-deadline"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { toolMayMutateWorkspace } from "@/tool/registry"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  /** True when this provider turn emitted at least one host-executed tool call. */
  readonly hasNonProviderToolCalls: boolean
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  readonly recovery?: { readonly prompt: string }
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /** Secret-free settlement projection of the committed route. */
  routeAttribution?: UsageRouteAttribution.Committed
  /**
   * Exact ephemeral lease that materialized transport. May contain an opaque
   * credential handle/revision; never persist or log this object.
   */
  routeLease?: ProviderRouteResolution.ProviderRouteLease
  spad?: SpadSupervisor
  /**
   * Optional pre-stream tree capture already STARTED by the turn owner.
   *
   * Do not join this before opening the provider stream. Snapshot's mutation
   * barrier guarantees that a guarded local mutation cannot complete until
   * this pre-turn capture has released its write lock, so the processor can
   * overlap Git materialization with model latency and only await the baseline
   * for a step that actually mutated the workspace.
   */
  initialSnapshotFiber?: Fiber.Fiber<string | undefined>
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

/**
 * Streaming delta coalescing. Each provider chunk used to publish one
 * `message.part.delta` event, which fans out to every SSE listener and every
 * GlobalBus subscriber. With N concurrent sessions the event rate is
 * N x tokens/sec, which saturates the single-threaded notify loop and starves
 * the 10s SSE heartbeat past the frontend's 15s liveness window (red blip).
 * Buffering deltas per part and flushing on a time/size threshold cuts publish
 * volume ~10x with no visible change (the frontend already coalesces at
 * 16ms/100ms/2KB).
 */
const DELTA_FLUSH_MS = 32
const DELTA_FLUSH_BYTES = 2048

interface PendingDelta {
  text: string
  since: number
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  nonProviderToolCallIDs: Set<string>
  shouldBreak: boolean
  baselineFiber: Fiber.Fiber<string | undefined>
  workspaceMutationObserved: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  needsRecovery: { readonly prompt: string } | undefined
  needsSpadAbort: string | undefined
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  /** Whether we have already recorded the first-token timestamp on the message. */
  firstTokenRecorded: boolean
  /** Buffered, not-yet-published text delta for the active text part. */
  pendingTextDelta: PendingDelta | undefined
  /** Buffered deltas keyed by provider reasoning id. */
  pendingReasoningDelta: Record<string, PendingDelta>
  /** Distinct physical provider accounts observed across this turn's steps. */
  routedAccountIDs: Set<string>
}

type StreamEvent = LLMEvent

type ClaudeModelFallback = {
  readonly originalModelID: string
  readonly fallbackModelID: string
  readonly scope: string
}

function claudeModelFallback(event: StreamEvent): ClaudeModelFallback | undefined {
  if (event.type !== "reasoning-start") return
  const claude = event.providerMetadata?.claude
  if (!isRecord(claude) || claude.event !== "model_refusal_fallback") return
  if (claude.scope === "local") return
  if (typeof claude.originalModelID !== "string" || typeof claude.fallbackModelID !== "string") return
  return {
    originalModelID: claude.originalModelID,
    fallbackModelID: claude.fallbackModelID,
    scope: typeof claude.scope === "string" ? claude.scope : "session",
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service
    const telemetry = yield* SessionTelemetry.Service
    const currentParts = yield* CurrentParts.Service
    const usageRecord = yield* UsageRecord.Service
    const routeHealth = yield* ProviderRouteHealth.Service
    const forkCredentials = yield* ForkCredentials.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Start (or reuse) the pre-turn capture before the LLM stream, but never
      // put Git materialization on provider first-token latency. Mutating tools
      // are fenced by Snapshot.withMutation(), so a mutation cannot complete
      // ahead of this capture even while provider generation proceeds.
      const baselineFiber = input.initialSnapshotFiber ?? (yield* snapshot.track().pipe(Effect.forkIn(scope)))
      const ctx: ProcessorContext = {
        needsSpadAbort: undefined,
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        routeAttribution: input.routeAttribution,
        routeLease: input.routeLease,
        spad: input.spad,
        toolcalls: {},
        nonProviderToolCallIDs: new Set(),
        shouldBreak: false,
        baselineFiber,
        workspaceMutationObserved: false,
        snapshot: undefined,
        blocked: false,
        needsCompaction: false,
        needsRecovery: undefined,
        currentText: undefined,
        reasoningMap: {},
        firstTokenRecorded: false,
        pendingTextDelta: undefined,
        pendingReasoningDelta: {},
        routedAccountIDs: new Set(),
      }

      const healthLease =
        input.routeLease &&
        input.routeAttribution &&
        input.routeLease.sessionID === input.sessionID &&
        input.routeLease.route.providerID === input.model.providerID &&
        input.routeLease.route.kind === input.routeAttribution.routeKind &&
        (input.routeLease.route.kind === "public" ||
          input.routeLease.route.accountID === input.routeAttribution.accountID)
          ? input.routeLease
          : undefined
      if (input.routeLease && !healthLease) {
        yield* Effect.logWarning("committed route lease/attribution mismatch; route health observation disabled", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          providerID: input.model.providerID,
          routeKind: input.routeAttribution?.routeKind ?? "missing",
          ...(input.routeAttribution?.accountID ? { accountID: input.routeAttribution.accountID } : {}),
        })
      }

      const healthObservationWarning = (operation: "failure" | "success", error: unknown) =>
        Effect.logWarning("provider route health observation failed", {
          operation,
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          providerID: input.model.providerID,
          routeKind: input.routeAttribution?.routeKind ?? "unknown",
          ...(input.routeAttribution?.accountID ? { accountID: input.routeAttribution.accountID } : {}),
          error: error instanceof Error ? error.message : String(error),
        })

      const followClaudeModelFallback = Effect.fnUntraced(function* (fallback: ClaudeModelFallback) {
        if (ctx.model.providerID !== "claude") return
        const current = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
        const selected = current.model
        if (!selected || selected.providerID !== "claude") return

        // A turn admitted under model A must never overwrite a newer user/host
        // selection that already moved the Session elsewhere while A was
        // streaming. The runtime event is authoritative only for this physical
        // turn, not for later Session state.
        if (selected.id !== ctx.model.id) {
          yield* Effect.logInfo("ignored stale Claude refusal fallback after Session model changed", {
            sessionID: ctx.sessionID,
            turnModelID: ctx.model.id,
            currentModelID: selected.id,
            fallbackModelID: fallback.fallbackModelID,
          })
          return
        }
        if (selected.id === fallback.fallbackModelID) return

        // Delegated-worker model identity is producer-owned user authorization.
        // Claude Code may internally fall back for the current run, but that
        // provider event is not authority to rewrite the protected recursive
        // delegation policy. Keep the visible note and fail closed on durable
        // selection mutation.
        if (SessionMetadataOwnership.hasWorkerDelegationOrigin(current.metadata)) {
          yield* Effect.logWarning("Claude refusal fallback not persisted for protected delegated worker", {
            sessionID: ctx.sessionID,
            originalModelID: fallback.originalModelID,
            fallbackModelID: fallback.fallbackModelID,
            scope: fallback.scope,
          })
          return
        }

        yield* session.setAgentModel({
          sessionID: ctx.sessionID,
          agent: current.agent ?? ctx.assistantMessage.agent,
          model: {
            ...selected,
            id: ModelV2.ID.make(fallback.fallbackModelID),
          },
          time: Date.now(),
        })
      })

      let aborted = false
      const livePartReleases = new Map<string, () => void>()
      const retainLivePart = (part: SessionV1.TextPart | SessionV1.ReasoningPart) => {
        const key = { sessionID: part.sessionID, messageID: part.messageID, partID: part.id }
        const token = currentParts.register({ ...key, snapshot: () => part })
        livePartReleases.set(part.id, () => currentParts.release(key, token))
      }
      const releaseLivePart = (partID: string) => {
        livePartReleases.get(partID)?.()
        livePartReleases.delete(partID)
      }
      const releaseAllLiveParts = () => {
        for (const release of livePartReleases.values()) release()
        livePartReleases.clear()
      }
      // Once a provider failure has entered SessionRetry, keep the Session in
      // retry state until the replacement physical attempt proves forward
      // progress by emitting an LLM event. A newly admitted user/host steer can
      // then distinguish an unproven recovery attempt from an ordinary healthy
      // busy turn and preempt only the former.
      let retryingWithoutProgress = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const flushTextDelta = Effect.fnUntraced(function* () {
        const pending = ctx.pendingTextDelta
        if (!pending || !ctx.currentText) {
          ctx.pendingTextDelta = undefined
          return
        }
        ctx.pendingTextDelta = undefined
        yield* session.updatePartDelta({
          sessionID: ctx.currentText.sessionID,
          messageID: ctx.currentText.messageID,
          partID: ctx.currentText.id,
          field: "text",
          delta: pending.text,
          offset: ctx.currentText.text.length - pending.text.length,
        })
      })

      const flushReasoningDelta = Effect.fnUntraced(function* (reasoningID: string) {
        const pending = ctx.pendingReasoningDelta[reasoningID]
        const part = ctx.reasoningMap[reasoningID]
        if (!pending || !part) {
          delete ctx.pendingReasoningDelta[reasoningID]
          return
        }
        delete ctx.pendingReasoningDelta[reasoningID]
        yield* session.updatePartDelta({
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          field: "text",
          delta: pending.text,
          offset: part.text.length - pending.text.length,
        })
      })

      const flushAllDeltas = Effect.fnUntraced(function* () {
        yield* flushTextDelta()
        for (const id of Object.keys(ctx.pendingReasoningDelta)) yield* flushReasoningDelta(id)
      })

      const bufferTextDelta = Effect.fnUntraced(function* (text: string) {
        if (!ctx.currentText) return
        const now = Date.now()
        const pending = ctx.pendingTextDelta
        if (!pending) {
          ctx.pendingTextDelta = { text, since: now }
          return
        }
        pending.text += text
        if (pending.text.length >= DELTA_FLUSH_BYTES || now - pending.since >= DELTA_FLUSH_MS) yield* flushTextDelta()
      })

      const bufferReasoningDelta = Effect.fnUntraced(function* (reasoningID: string, text: string) {
        const now = Date.now()
        const pending = ctx.pendingReasoningDelta[reasoningID]
        if (!pending) {
          ctx.pendingReasoningDelta[reasoningID] = { text, since: now }
          return
        }
        pending.text += text
        if (pending.text.length >= DELTA_FLUSH_BYTES || now - pending.since >= DELTA_FLUSH_MS)
          yield* flushReasoningDelta(reasoningID)
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        yield* flushReasoningDelta(reasoningID)
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        releaseLivePart(ctx.reasoningMap[reasoningID].id)
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) {
            if (existing.part.metadata?.providerExecuted) ctx.nonProviderToolCallIDs.delete(input.id)
            else ctx.nonProviderToolCallIDs.add(input.id)
            return existing
          }
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.nonProviderToolCallIDs.delete(input.id)
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        if (input.providerExecuted) ctx.nonProviderToolCallIDs.delete(input.id)
        else ctx.nonProviderToolCallIDs.add(input.id)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const isSignedReasoningMetadata = (metadata: unknown): boolean => {
        if (!isRecord(metadata)) return false
        const rec = metadata as Record<string, unknown>
        const anthropic = rec.anthropic
        if (isRecord(anthropic) && "signature" in anthropic) return true
        const bedrock = rec.bedrock
        if (isRecord(bedrock) && "signature" in bedrock) return true
        return false
      }

      // Telemetry for SPAD-R intervention rate measurement: every observe,
      // recover, and abort action is logged with its detection stats so real
      // traffic can be calibrated before broad auto-recovery enablement.
      const spadTelemetry = (action: SpadAction | undefined) =>
        action
          ? Effect.logInfo("spad.action", {
              "session.id": ctx.sessionID,
              "spad.type": action.type,
              "spad.lane": action.detection.lane,
              "spad.source": action.detection.source,
              "spad.channel": action.detection.channel,
              "spad.policyReason": action.policyReason,
              "spad.period": action.detection.period,
              "spad.runLength": action.detection.runLength,
              "spad.exponent": action.detection.exponent,
              ...("attempt" in action ? { "spad.attempt": action.attempt } : {}),
              ...("reason" in action ? { "spad.reason": action.reason } : {}),
            })
          : Effect.void

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        // Flush coalesced deltas at block boundaries so text is visible before
        // tool execution starts and a stalled stream never holds the trailing
        // chunk indefinitely. Delta events themselves batch via the
        // time/size thresholds in bufferTextDelta/bufferReasoningDelta.
        if (value.type !== "text-delta" && value.type !== "reasoning-delta") yield* flushAllDeltas()
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            {
              const fallback = claudeModelFallback(value)
              if (fallback) yield* followClaudeModelFallback(fallback)
            }
            // Record first-token timestamp on the assistant message for upstream
            // TTFT metrics. Only set once per message; reasoning-start that
            // arrives after text-start is not the "first" token.
            if (!ctx.firstTokenRecorded) {
              ctx.firstTokenRecorded = true
              ctx.assistantMessage.time.firstTokenAt = Date.now()
              yield* session.updateMessage(ctx.assistantMessage)
            }
            // Reasoning is observation-only. Rewriting/cancelling hidden
            // reasoning is substantially riskier than truncating visible text
            // and has not cleared the SPAD precision/replay-safety gym.
            ctx.spad?.startPart("reasoning", false, true)
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            retainLivePart(ctx.reasoningMap[value.id])
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            {
              const action = ctx.spad?.push(value.text)
              yield* spadTelemetry(action)
              if (action?.type === "abort") {
                // Throwing here would mix the SPAD abort with the provider
                // stream-teardown error and trigger provider retries; the
                // abort is finalized via halt() after the stream stops.
                ctx.needsSpadAbort = `Repetitive reasoning continued after recovery (${action.reason})`
                return
              }
              if (action?.type === "recover") {
                const signed =
                  isSignedReasoningMetadata(ctx.reasoningMap[value.id].metadata) ||
                  isSignedReasoningMetadata(value.providerMetadata)
                if (signed) {
                  // Signed thinking must remain observe-only for replay safety.
                } else {
                  const full = ctx.reasoningMap[value.id].text + value.text
                  const cut = action.noTruncate
                    ? full.length
                    : Math.max(0, Math.min(full.length, action.quarantineFrom))
                  ctx.reasoningMap[value.id].text = full.slice(0, cut)
                  // A recovery rewrite supersedes buffered deltas; drop them so
                  // the full-part update below is the single source of truth.
                  delete ctx.pendingReasoningDelta[value.id]
                  yield* session.updatePart(ctx.reasoningMap[value.id])
                  ctx.needsRecovery = { prompt: action.recoveryPrompt }
                  return
                }
              }
            }
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* bufferReasoningDelta(value.id, value.text)
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            if (toolMayMutateWorkspace(value.name, input)) {
              ctx.workspaceMutationObserved = true
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length === DOOM_LOOP_THRESHOLD &&
              recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              const agent = yield* agents.get(ctx.assistantMessage.agent)
              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.name],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.name, input },
                always: [value.name],
                ruleset: agent.permission,
              })
            }

            {
              const isMutating = isSpadMutatingTool(value.name)
              const resource = toolResourceKey(value.name, input)
              const toolAction = ctx.spad?.pushTool(value.name, isMutating, resource)
              yield* spadTelemetry(toolAction)
              if (toolAction?.type === "abort") {
                ctx.needsSpadAbort = `Repetitive tool calls continued after recovery (${toolAction.reason})`
                return
              }
              if (toolAction?.type === "recover") {
                ctx.needsRecovery = { prompt: toolAction.recoveryPrompt }
                return
              }
            }
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            if (toolCall) {
              const resource = toolResourceKey(toolCall.part.tool, toolCall.part.state.input)
              const resultAction = ctx.spad?.pushToolResult(
                resource,
                output.output,
                isSpadMutatingTool(toolCall.part.tool),
              )
              yield* spadTelemetry(resultAction)
              if (resultAction?.type === "abort") {
                ctx.needsSpadAbort = `Repetitive tool calls continued after recovery (${resultAction.reason})`
                return
              }
              if (resultAction?.type === "recover") {
                ctx.needsRecovery = { prompt: resultAction.recoveryPrompt }
                return
              }
            }
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.id)
            const error = value.error ?? new Error(value.message)
            yield* failToolCall(value.id, error)
            if (toolCall) {
              const resource = toolResourceKey(toolCall.part.tool, toolCall.part.state.input)
              const resultAction = ctx.spad?.pushToolResult(
                resource,
                `[tool-error] ${errorMessage(error)}`,
                isSpadMutatingTool(toolCall.part.tool),
              )
              yield* spadTelemetry(resultAction)
              if (resultAction?.type === "abort")
                ctx.needsSpadAbort = `Repetitive tool calls continued after recovery (${resultAction.reason})`
              else if (resultAction?.type === "recover") ctx.needsRecovery = { prompt: resultAction.recoveryPrompt }
            }
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "step-start",
            })
            return

          case "step-finish": {
            // A guarded local mutation can only complete after baselineFiber's
            // Snapshot write lock is released. Therefore this join is instant
            // on mutating steps; read-only/text-only steps never wait on Git.
            const beforeSnapshot = ctx.workspaceMutationObserved
              ? (ctx.snapshot ?? (yield* Fiber.join(ctx.baselineFiber)))
              : undefined
            const completedSnapshot = ctx.workspaceMutationObserved ? yield* snapshot.track() : undefined
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // Anthropic reports thinking blocks it removed before the model saw the
            // prompt. Prefix mismatches mean opencode changed history behind a signed
            // block; log them so the churn can be tracked down.
            const dropped = isRecord(value.providerMetadata?.anthropic)
              ? value.providerMetadata.anthropic.inputTransformations
              : undefined
            if (Array.isArray(dropped) && dropped.length > 0) {
              yield* Effect.logWarning("thinking blocks dropped by provider", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                model: ctx.model.id,
                transformations: JSON.stringify(dropped),
              })
            }
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            const openforkMetadata = isRecord(value.providerMetadata?.openfork)
              ? value.providerMetadata.openfork
              : undefined
            const routedAccountID =
              openforkMetadata && typeof openforkMetadata.accountID === "string"
                ? openforkMetadata.accountID
                : undefined
            if (routedAccountID) ctx.routedAccountIDs.add(routedAccountID)
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            if (value.servedModel) ctx.assistantMessage.servedModel = value.servedModel
            const completedAt = Date.now()
            yield* telemetry.settle({
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              completedAt,
              cost: ctx.assistantMessage.cost,
              tokens: usage.tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              ...(completedSnapshot ? { snapshot: completedSnapshot } : {}),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (beforeSnapshot && completedSnapshot) {
              // `completedSnapshot` is the exact post-step tree we just
              // captured. Compare the immutable trees directly instead of
              // forcing Snapshot.patch() to rescan and restage the worktree.
              const patch = yield* snapshot.patch(beforeSnapshot, completedSnapshot)
              if (patch.files.length) {
                ctx.spad?.markProgress()
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
            }
            ctx.snapshot = undefined
            ctx.workspaceMutationObserved = false
            // Arm the next provider step at the same pre-mutation boundary.
            // Snapshot is single-flight, so an unchanged project normally
            // reuses the just-completed materialization.
            ctx.baselineFiber = yield* snapshot.track().pipe(Effect.forkIn(scope))
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            // Record first-token timestamp on the assistant message for upstream
            // TTFT metrics. Only set once per message.
            if (!ctx.firstTokenRecorded) {
              ctx.firstTokenRecorded = true
              ctx.assistantMessage.time.firstTokenAt = Date.now()
              yield* session.updateMessage(ctx.assistantMessage)
            }
            ctx.spad?.startPart("text")
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            retainLivePart(ctx.currentText)
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            const action = ctx.spad?.push(value.text)
            yield* spadTelemetry(action)
            if (action?.type === "abort") {
              ctx.needsSpadAbort = `Repetitive model output continued after recovery (${action.reason})`
              return
            }
            if (action?.type === "recover") {
              const full = ctx.currentText.text + value.text
              const cut = action.noTruncate ? full.length : Math.max(0, Math.min(full.length, action.quarantineFrom))
              ctx.currentText.text = full.slice(0, cut)
              // Recovery rewrite supersedes buffered deltas; drop them so the
              // full-part update below is the single source of truth.
              ctx.pendingTextDelta = undefined
              yield* session.updatePart(ctx.currentText)
              ctx.needsRecovery = { prompt: action.recoveryPrompt }
              return
            }
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* bufferTextDelta(value.text)
            return

          case "text-end":
            if (!ctx.currentText) return
            yield* flushTextDelta()
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            releaseLivePart(ctx.currentText.id)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.workspaceMutationObserved) {
          const beforeSnapshot = ctx.snapshot ?? (yield* Fiber.join(ctx.baselineFiber))
          const patch = beforeSnapshot ? yield* snapshot.patch(beforeSnapshot) : undefined
          if (patch?.files.length) {
            ctx.spad?.markProgress()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
          ctx.workspaceMutationObserved = false
        }

        // Flush coalesced deltas before the full-part writes below so an
        // interrupted stream still delivers its trailing text as deltas; the
        // full updates then supersede them via the barrier path.
        yield* flushAllDeltas()

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}
        ctx.pendingReasoningDelta = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: 8 },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)

        const qualifiedAccountID =
          typeof ctx.model.id === "string" ? splitAccountModelID(ctx.model.id).accountID : undefined
        // Response metadata is validation-only once a committed ProviderRoute
        // exists. Missing metadata cannot erase authority; contradictory
        // metadata is diagnosed but never becomes settlement identity.
        if (ctx.routeAttribution) {
          const mismatch = routedAccountMismatch(ctx.routedAccountIDs, ctx.routeAttribution)
          if (mismatch) {
            yield* Effect.logWarning("provider route attribution mismatch", {
              sessionID: ctx.sessionID,
              messageID: ctx.assistantMessage.id,
              providerID: ctx.model.providerID,
              modelID: ctx.model.id,
              committedRouteKind: ctx.routeAttribution.routeKind,
              ...(ctx.routeAttribution.accountID ? { committedAccountID: ctx.routeAttribution.accountID } : {}),
              mismatchKind: mismatch.kind,
              observedAccountIDs: [...mismatch.observedAccountIDs],
            })
          }
        }

        // A legacy/no-route message may still derive account attribution from a
        // unanimous provider observation or the old model-ID suffix. A committed
        // route never consults either as settlement authority.
        const observedAccountID = ctx.routeAttribution
          ? resolveRoutedAccount(ctx.routedAccountIDs)
          : resolveRoutedAccount(ctx.routedAccountIDs, qualifiedAccountID)
        const accountID = ctx.routeAttribution
          ? ctx.routeAttribution.routeKind === "account"
            ? ctx.routeAttribution.accountID
            : undefined
          : observedAccountID

        if ((ctx.model.providerID === "opencode" || ctx.model.providerID === "opencode-go") && accountID) {
          // The fork store read is observability-only: a missing vault/unknown
          // account skips attribution, and storage faults must not fail cleanup.
          yield* Effect.gen(function* () {
            const credentials = yield* forkCredentials.list()
            const match = credentials.find((credential) => stableZenIdentity(credential.key) === accountID)
            if (match)
              yield* forkCredentials.recordUsage({
                messageID: ctx.assistantMessage.id,
                credentialID: match.id,
              })
          }).pipe(Effect.ignore)
        }

        yield* usageRecord.record({
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.sessionID,
          providerID: ctx.model.providerID,
          modelID: ctx.model.id,
          ...(ctx.routeAttribution ? { route: ctx.routeAttribution } : {}),
          accountID,
          variant: ctx.assistantMessage.variant,
          agent: ctx.assistantMessage.agent,
          mode: ctx.assistantMessage.mode,
          createdAt: ctx.assistantMessage.time.created,
          requestSentAt: ctx.assistantMessage.time.requestSentAt,
          firstTokenAt: ctx.assistantMessage.time.firstTokenAt,
          streamedAt: ctx.assistantMessage.time.streamedAt,
          completedAt: ctx.assistantMessage.time.completed,
          cost: ctx.assistantMessage.cost,
          tokens: {
            input: ctx.assistantMessage.tokens.input,
            cacheRead: ctx.assistantMessage.tokens.cache.read,
            cacheWrite: ctx.assistantMessage.tokens.cache.write,
            output: ctx.assistantMessage.tokens.output,
            reasoning: ctx.assistantMessage.tokens.reasoning,
          },
        })
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          errorDetails: SessionError.summary(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.needsRecovery = undefined
        ctx.needsSpadAbort = undefined
        ctx.spad?.markGeneration()
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            if (!retryingWithoutProgress) yield* status.set(ctx.sessionID, { type: "busy" })

            // Per-attempt dispatch origin, captured before the provider stream
            // is consumed. Physical retries reset all three stamps so failed
            // attempts and backoff never enter the successful attempt's
            // throughput window. The stream starts producing events only
            // after the HTTP request is sent, so this timestamp is a close
            // approximation of the actual wire send.
            ctx.firstTokenRecorded = false
            ctx.assistantMessage.time.requestSentAt = Date.now()
            ctx.assistantMessage.time.firstTokenAt = undefined
            ctx.assistantMessage.time.streamedAt = undefined
            yield* session.updateMessage(ctx.assistantMessage)
            yield* telemetry.begin({
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              requestSentAt: ctx.assistantMessage.time.requestSentAt,
              model: {
                providerID: ctx.model.providerID,
                modelID: ctx.model.id,
                name: ctx.model.name,
                ...(ctx.assistantMessage.variant === undefined ? {} : { variant: ctx.assistantMessage.variant }),
                contextLimit: ctx.model.limit.context,
              },
            })

            const stream = llm.stream({
              ...streamInput,
              ...(ctx.routeAttribution ? { route: ctx.routeAttribution } : {}),
            })

            yield* consumeWithFlushDeadline(stream, {
              delayMs: DELTA_FLUSH_MS,
              pending: () => ctx.pendingTextDelta !== undefined || Object.keys(ctx.pendingReasoningDelta).length > 0,
              flush: flushAllDeltas(),
              consume: (event) =>
                Effect.gen(function* () {
                  // Provider-event observation is the progress proof used by
                  // interactive preemption. Publish it before changing retry
                  // status or performing any event-specific side effect so a
                  // concurrent prompt can never abort an already-proven attempt.
                  const accepted = yield* telemetry.observe({ sessionID: ctx.sessionID, event })
                  if (!accepted) return yield* Effect.interrupt
                  if (retryingWithoutProgress) {
                    retryingWithoutProgress = false
                    yield* status.set(ctx.sessionID, { type: "busy" })
                  }
                  yield* handleEvent(event)
                }),
              stop: () => ctx.needsCompaction || ctx.needsRecovery !== undefined || ctx.needsSpadAbort !== undefined,
            })

            // Response-body boundary for the throughput denominator: the
            // provider stream is exhausted here, before local tool settlement
            // in cleanup(). Only stamped for a step that actually streamed;
            // aborted turns stay unstamped and render no rate.
            if (ctx.firstTokenRecorded && ctx.assistantMessage.time.streamedAt === undefined) {
              ctx.assistantMessage.time.streamedAt = Date.now()
              yield* session.updateMessage(ctx.assistantMessage)
              yield* telemetry.streamed(ctx.sessionID, ctx.assistantMessage.time.streamedAt)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            // A SPAD recovery stop aborts the provider stream mid-response; the
            // resulting teardown error (e.g. "connection terminated") must not
            // fail the generation or trigger provider retries — the loop
            // continues via ctx.needsRecovery instead.
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause) && ctx.needsRecovery !== undefined,
              () => Effect.void,
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                ...(ctx.routeAttribution ? { route: ctx.routeAttribution } : {}),
                parse,
                observe: ({ decision }) => {
                  if (!healthLease || decision.routeEffect === "none") return Effect.void
                  return routeHealth
                    .observeFailure({
                      lease: healthLease,
                      modelID: ctx.model.id,
                      effect: decision.routeEffect,
                      ...(decision.resetAt === undefined ? {} : { resetAt: decision.resetAt }),
                    })
                    .pipe(Effect.catch((error) => healthObservationWarning("failure", error)))
                },
                set: (info) =>
                  Effect.sync(() => {
                    retryingWithoutProgress = true
                  }).pipe(
                    Effect.andThen(
                      status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        action: info.action,
                        next: info.next,
                      }),
                    ),
                  ),
              }),
            ),
            Effect.tap(() =>
              healthLease
                ? routeHealth
                    .observeSuccess({
                      lease: healthLease,
                      modelID: ctx.model.id,
                    })
                    .pipe(Effect.catch((error) => healthObservationWarning("success", error)))
                : Effect.void,
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup().pipe(Effect.ensuring(Effect.sync(releaseAllLiveParts)))),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.needsSpadAbort) {
            yield* halt(new Error(ctx.needsSpadAbort))
            // cleanup() already ran inside the stream pipeline above, so the
            // error set by halt() must be persisted explicitly.
            yield* session.updateMessage(ctx.assistantMessage)
            return "stop"
          }
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get hasNonProviderToolCalls() {
          return ctx.nonProviderToolCallIDs.size > 0
        },
        updateToolCall,
        completeToolCall,
        process,
        get recovery() {
          return ctx.needsRecovery
        },
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
    SessionTelemetry.node,
    CurrentParts.node,
    UsageRecord.node,
    ProviderRouteHealth.node,
    ForkCredentials.node,
  ],
})

export * as SessionProcessor from "./processor"
