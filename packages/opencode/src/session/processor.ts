import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import * as CodeInputAdmission from "@/code/input-admission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Context, Scope, Schema, Option } from "effect"
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
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionLimitRecovery } from "@opencode-ai/core/session/limit-recovery"
import { SessionLimitRecovery as SessionLimitRecoveryContract } from "@opencode-ai/schema/session-limit-recovery"
import { Quota } from "@/quota/quota"
import { selectRecoveryQuotaReset } from "./limit-recovery-quota"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { Goal } from "@opencode-ai/core/goal"
import { SessionError } from "@opencode-ai/schema/session-error"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { Usage, isStaleReasoningFailure, type LLMEvent } from "@opencode-ai/llm"
import { SessionStaleReasoning } from "./stale-reasoning"
import { SessionPromptRenderingRecovery } from "./prompt-rendering-recovery"
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
import { ProviderProgressTimeoutError, createProviderStreamProbe, withProviderProgressDeadline } from "./first-content-deadline"
import { StreamText } from "./stream-text"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { toolMayMutateWorkspace } from "@/tool/registry"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { NativeToolSettlement } from "./native-tool-settlement"
import { awaitOptionalStepEnrichment } from "./optional-step-enrichment"

const DOOM_LOOP_THRESHOLD = 3
// Snapshot capture/patch is optional step metadata. All enrichment phases
// share this budget; three serial 30-second timeouts must not consume the
// entire provider consumer watchdog before the terminal event is released.
const STEP_SNAPSHOT_BUDGET_MS = 30_000
export type Result = "compact" | "stop" | "continue"
type HaltSource = "interrupt" | "failure"

export interface Handle {
  readonly message: SessionV1.Assistant
  /** True when this provider turn emitted at least one host-executed tool call. */
  readonly hasNonProviderToolCalls: boolean
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  /** Exact durable ToolPart currently owned by a provider tool call, if admitted. */
  readonly toolPartID?: (toolCallID: string) => SessionV1.ToolPart["id"] | undefined
  /** Mark that a nested/delegated leaf attempted a workspace mutation this step. */
  readonly markWorkspaceMutation?: () => Effect.Effect<void>
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
  /** Settle at the executor boundary even if the provider drops its result. */
  readonly failToolCall?: (toolCallID: string, error: unknown) => Effect.Effect<boolean>
  readonly startToolCall?: (toolCallID: string, name: string, args: Record<string, unknown>) => Effect.Effect<void>
  readonly recovery?: { readonly prompt: string }
  /** Host watchdog exhausted after provider progress ceased (not user abort). */
  readonly providerTimedOut: boolean
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /** Already admitted Session project identity; direct callers may omit it. */
  projectID?: string
  /**
   * Exact durable V1 history the turn owner already held when this step's
   * provider request was built. Stale-reasoning recovery repairs caller-bound
   * replay handles from this snapshot instead of re-hydrating the transcript.
   */
  durableHistory?: readonly SessionV1.WithParts[]
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
  currentTextContent: StreamText | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  reasoningContent: Record<string, StreamText>
  /** Whether we have already recorded the first-token timestamp on the message. */
  firstTokenRecorded: boolean
  /** Buffered, not-yet-published text delta for the active text part. */
  pendingTextDelta: PendingDelta | undefined
  /** Buffered deltas keyed by provider reasoning id. */
  pendingReasoningDelta: Record<string, PendingDelta>
  /** Distinct physical provider accounts observed across this turn's steps. */
  routedAccountIDs: Set<string>
  recoveredStaleReasoning: boolean
  turnOutputStarted: boolean
  providerTimedOut: boolean
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
    const quota = yield* Quota.Service
    const goals = yield* Goal.Service

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
        currentTextContent: undefined,
        reasoningMap: {},
        reasoningContent: {},
        firstTokenRecorded: false,
        pendingTextDelta: undefined,
        pendingReasoningDelta: {},
        routedAccountIDs: new Set(),
        recoveredStaleReasoning: false,
        turnOutputStarted: false,
        providerTimedOut: false,
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
      // Keep only call identities after executor settlement. The provider may
      // deliver its result later; it must observe the same terminal Part rather
      // than recreate a pending call or lose result telemetry.
      const settledToolcalls = new Map<string, ToolCall>()
      const executingHostTools = new Set<string>()
      const toolAdmissionLocks = KeyedMutex.makeUnsafe<string>()
      let projectID = input.projectID
      const recordToolSettlement = Effect.fnUntraced(function* (
        part: SessionV1.ToolPart,
        status: NativeToolSettlement.Status,
      ) {
        // Provider-side tools did not execute in this host.
        if (part.metadata?.providerExecuted || part.state.status === "pending") return
        const startedAt = part.state.time.start
        const completedAt = "end" in part.state.time ? part.state.time.end : undefined
        if (completedAt === undefined) return
        const id = part.id
        const write = Effect.gen(function* () {
          projectID ??= (yield* session.get(ctx.sessionID)).projectID
          yield* NativeToolSettlement.record(database, {
            id,
            session_id: ctx.sessionID,
            project_id: projectID,
            provider_id: ctx.model.providerID,
            model_id: ctx.model.id,
            tool: part.tool,
            status,
            started_at: startedAt,
            completed_at: completedAt,
            duration_ms: Math.max(0, completedAt - startedAt),
          })
        })
        // Analytics failure cannot re-execute a tool or strand a terminal waiter.
        yield* write.pipe(Effect.catchCause(() =>
          Effect.logWarning("native tool settlement write failed", { sessionID: ctx.sessionID, partID: id }),
        ))
      })
      const livePartReleases = new Map<string, () => void>()
      const retainLivePart = (part: SessionV1.TextPart | SessionV1.ReasoningPart) => {
        const key = { sessionID: part.sessionID, messageID: part.messageID, partID: part.id }
        const content = part.type === "text" ? ctx.currentTextContent : ctx.reasoningContent[part.id]
        const token = currentParts.register({ ...key, snapshot: () => ({ ...part, text: content?.toString() ?? part.text }) })
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
      // A rejected hosted prompt can be safely projected once only when the
      // original request produced NO provider event. This is stricter than
      // turnOutputStarted: usage/step/tool events may precede visible text.
      let recoveredPromptRendering = false
      let providerEventsThisAttempt = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        executingHostTools.delete(toolCallID)
        const call = ctx.toolcalls[toolCallID]
        const done = call?.done
        if (call) settledToolcalls.set(toolCallID, call)
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID] ?? settledToolcalls.get(toolCallID)
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

      const updateToolCallUnlocked = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        if (match.part.state.status === "completed" || match.part.state.status === "error") return match.part
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })
      const updateToolCall = (...args: Parameters<typeof updateToolCallUnlocked>) =>
        toolAdmissionLocks.withLock(args[0])(updateToolCallUnlocked(...args))

      const completeToolCallUnlocked = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || (match.part.state.status !== "running" && match.part.state.status !== "pending")) return
        const normalized = yield* Effect.forEach(output.attachments ?? [], (attachment) =>
          attachment.mime.startsWith("image/")
            ? image.normalize(attachment).pipe(
                Effect.catchIf((error) => error instanceof Image.ResizerUnavailableError,
                  () => Effect.succeed(attachment)),
                Effect.exit,
              )
            : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
        )
        const omitted = normalized.filter(Exit.isFailure).length
        const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
        const part = yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: omitted === 0 ? output.output
              : `${output.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.status === "running" ? match.part.state.time.start : Date.now(), end: Date.now() },
            attachments: attachments.length ? attachments : undefined,
          },
        })
        yield* recordToolSettlement(part, "success")
        yield* settleToolCall(toolCallID)
      })
      const completeToolCall = (...args: Parameters<typeof completeToolCallUnlocked>) =>
        toolAdmissionLocks.withLock(args[0])(completeToolCallUnlocked(...args))

      const failToolCallUnlocked = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || (match.part.state.status !== "running" && match.part.state.status !== "pending")) return false
         // The tool-abort signal can race the runner's final sweep. The
         // provider/tool stream may settle a tool-error first, so the later
         // sweep sees status=error and correctly refuses to overwrite it.
         // Preserve the original AbortError classification at this seam;
         // otherwise the durable transcript loses interrupted=true even
         // though the host successfully aborted the tool before Goal auditing.
         const interrupted = error instanceof Error && error.name === "AbortError"
         const priorMetadata = match.part.state.status === "running" ? match.part.state.metadata : {}
          const part = yield* session.updatePart({
            ...match.part,
            state: {
              status: "error",
             input: match.part.state.input,
             error: errorMessage(error),
             // Keep streamed progress metadata on ordinary failures, but mark
             // genuine AbortErrors without relying on user-controlled strings.
             metadata: { ...priorMetadata, ...(interrupted ? { interrupted: true } : {}) },
              time: { start: match.part.state.status === "running" ? match.part.state.time.start : Date.now(), end: Date.now() },
            },
          })
          const denied = error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError
          yield* recordToolSettlement(part, denied ? "denied" : interrupted ? "abort" :
            error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error")
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })
      const failToolCall = (...args: Parameters<typeof failToolCallUnlocked>) =>
        toolAdmissionLocks.withLock(args[0])(failToolCallUnlocked(...args))

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
          offset: (ctx.currentTextContent?.length ?? 0) - pending.text.length,
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
          offset: (ctx.reasoningContent[part.id]?.length ?? 0) - pending.text.length,
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
        ctx.reasoningMap[reasoningID].text = ctx.reasoningContent[ctx.reasoningMap[reasoningID].id]?.toString() ?? ""
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        releaseLivePart(ctx.reasoningMap[reasoningID].id)
        delete ctx.reasoningContent[ctx.reasoningMap[reasoningID].id]
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCallUnlocked = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
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

      const ensureToolCall = (input: Parameters<typeof ensureToolCallUnlocked>[0]) =>
        toolAdmissionLocks.withLock(input.id)(ensureToolCallUnlocked(input))

      const startToolCall = Effect.fn("SessionProcessor.startToolCall")(function* (
        id: string, name: string, args: Record<string, unknown>,
      ) {
        yield* ensureToolCall({ id, name })
        yield* updateToolCall(id, (part) => part.state.status !== "pending" ? part : {
          ...part,
          state: { status: "running", input: args, time: { start: Date.now() } },
        })
        executingHostTools.add(id)
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

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent, markPhase: (phase: string) => void = () => {}) {
        // Flush coalesced deltas at block boundaries so text is visible before
        // tool execution starts and a stalled stream never holds the trailing
        // chunk indefinitely. Delta events themselves batch via the
        // time/size thresholds in bufferTextDelta/bufferReasoningDelta.
        if (value.type !== "text-delta" && value.type !== "reasoning-delta") yield* flushAllDeltas()
        if (
          value.type !== "provider-error" &&
          value.type !== "step-start" &&
          value.type !== "step-finish" &&
          value.type !== "finish"
        ) ctx.turnOutputStarted = true
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
            ctx.reasoningContent[ctx.reasoningMap[value.id]!.id] = new StreamText()
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
                  const content = ctx.reasoningContent[ctx.reasoningMap[value.id].id]!
                  content.append(value.text)
                  const full = content.toString()
                  const cut = action.noTruncate
                    ? full.length
                    : Math.max(0, Math.min(full.length, action.quarantineFrom))
                  content.replace(full.slice(0, cut))
                  ctx.reasoningMap[value.id].text = content.toString()
                  // A recovery rewrite supersedes buffered deltas; drop them so
                  // the full-part update below is the single source of truth.
                  delete ctx.pendingReasoningDelta[value.id]
                  yield* session.updatePart(ctx.reasoningMap[value.id])
                  ctx.needsRecovery = { prompt: action.recoveryPrompt }
                  return
                }
              }
            }
            ctx.reasoningContent[ctx.reasoningMap[value.id].id]!.append(value.text)
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
            const durableInput = value.name === "code" ? CodeInputAdmission.durableInput(input) : input
            if (toolMayMutateWorkspace(value.name, input)) {
              ctx.workspaceMutationObserved = true
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input: durableInput }
                  : {
                      status: "running",
                      input: durableInput,
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
            yield* completeToolCall(value.id, rawOutput)
            const settled = yield* readToolCall(value.id)
            const output = settled?.part.state.status === "completed" ? settled.part.state : rawOutput
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
            // Snapshot is auxiliary step enrichment, not a prerequisite for
            // consuming the provider's terminal event. A contended Git capture
            // must never strand the provider stream for the entire idle budget.
            const enrichmentDeadline = performance.now() + STEP_SNAPSHOT_BUDGET_MS
            const boundedSnapshot = <A, E, R>(
              phase: string,
              task: Effect.Effect<A, E, R>,
            ): Effect.Effect<A | undefined, E, R> =>
              Effect.gen(function* () {
                // Snapshot enrichment is explicitly optional. Failed Git
                // captures and filesystem errors must not turn successful
                // provider output into a failed assistant request. Preserve
                // cancellation, rather than swallowing interrupted fibers.
                const remainingMs = Math.max(0, Math.ceil(enrichmentDeadline - performance.now()))
                if (remainingMs === 0) {
                  yield* Effect.logWarning("step snapshot enrichment skipped (shared budget exhausted)", {
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                    phase,
                    budgetMs: STEP_SNAPSHOT_BUDGET_MS,
                  })
                  return undefined
                }
                const result = yield* awaitOptionalStepEnrichment(task, remainingMs).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning("step snapshot enrichment failed", {
                          sessionID: ctx.sessionID,
                          messageID: ctx.assistantMessage.id,
                          phase,
                          cause: Cause.pretty(cause),
                        }).pipe(Effect.as(Option.none<A>())),
                  ),
                )
                if (result._tag === "Some") return result.value
                yield* Effect.logWarning("step snapshot enrichment timed out", {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  phase,
                  timeoutMs: remainingMs,
                  budgetMs: STEP_SNAPSHOT_BUDGET_MS,
                })
                return undefined
              })
            // A guarded local mutation can only complete after baselineFiber's
            // Snapshot write lock is released. Therefore this join is instant
            // on mutating steps; read-only/text-only steps never wait on Git.
            markPhase("snapshot-baseline")
            const beforeSnapshot = ctx.workspaceMutationObserved
              ? (ctx.snapshot ?? (yield* boundedSnapshot("baseline", Fiber.join(ctx.baselineFiber))))
              : undefined
            markPhase("snapshot-post-step")
            const completedSnapshot = ctx.workspaceMutationObserved
              ? yield* boundedSnapshot("post-step", snapshot.track())
              : undefined
            markPhase("reasoning-settlement")
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
            markPhase("telemetry-settlement")
            yield* telemetry.settle({
              sessionID: ctx.sessionID,
              assistantMessageID: ctx.assistantMessage.id,
              completedAt,
              cost: ctx.assistantMessage.cost,
              tokens: usage.tokens,
            })
            markPhase("step-part-persistence")
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
            markPhase("assistant-persistence")
            yield* session.updateMessage(ctx.assistantMessage)
            if (beforeSnapshot && completedSnapshot) {
              // `completedSnapshot` is the exact post-step tree we just
              // captured. Compare the immutable trees directly instead of
              // forcing Snapshot.patch() to rescan and restage the worktree.
              markPhase("snapshot-patch")
              const patch = yield* boundedSnapshot("patch", snapshot.patch(beforeSnapshot, completedSnapshot))
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
            }
            ctx.snapshot = undefined
            ctx.workspaceMutationObserved = false
            // Arm the next provider step at the same pre-mutation boundary.
            // Snapshot is single-flight, so an unchanged project normally
            // reuses the just-completed materialization.
            markPhase("snapshot-rearm")
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
            ctx.currentTextContent = new StreamText()
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
              const content = ctx.currentTextContent ?? new StreamText()
              content.append(value.text)
              const full = content.toString()
              const cut = action.noTruncate ? full.length : Math.max(0, Math.min(full.length, action.quarantineFrom))
              content.replace(full.slice(0, cut))
              ctx.currentTextContent = content
              ctx.currentText.text = content.toString()
              // Recovery rewrite supersedes buffered deltas; drop them so the
              // full-part update below is the single source of truth.
              ctx.pendingTextDelta = undefined
              yield* session.updatePart(ctx.currentText)
              ctx.needsRecovery = { prompt: action.recoveryPrompt }
              return
            }
            ctx.currentTextContent?.append(value.text)
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* bufferTextDelta(value.text)
            return

          case "text-end":
            if (!ctx.currentText) return
            yield* flushTextDelta()
            ctx.currentText.text = ctx.currentTextContent?.toString() ?? ctx.currentText.text
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
            ctx.currentTextContent = undefined
            return

          case "finish":
            return
        }
      })

      const settleRemainingTools = Effect.fn("SessionProcessor.settleRemainingTools")(function* () {
        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: 8 },
        )
        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          yield* toolAdmissionLocks.withLock(toolCallID)(Effect.gen(function* () {
          const match = yield* readToolCall(toolCallID)
          if (!match) return
          if (match.part.state.status === "pending" || match.part.state.status === "running") {
            const part = match.part
            const end = Date.now()
            const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
            const settled = yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: "Tool execution aborted",
                metadata: { ...metadata, interrupted: true },
                time: { start: "time" in part.state ? part.state.time.start : end, end },
              },
            })
            yield* recordToolSettlement(settled, "abort")
          }
          yield* settleToolCall(toolCallID)
          }))
        }
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        ctx.assistantMessage.time.completed ??= Date.now()
        if (ctx.workspaceMutationObserved) {
          // Snapshot enrichment cannot indefinitely hold operator cancellation
          // after the tool/assistant boundary has already been settled.
          const patch = yield* Effect.gen(function* () {
            const beforeSnapshot = ctx.snapshot ?? (yield* Fiber.join(ctx.baselineFiber))
            return beforeSnapshot ? yield* snapshot.patch(beforeSnapshot) : undefined
          }).pipe(
            Effect.interruptible,
            Effect.timeout("30 seconds"),
            Effect.catch((error) => Effect.logWarning("Session snapshot cleanup did not complete", {
              sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id, error,
            }).pipe(Effect.as(undefined))),
          )
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

        // Cleanup owns the authoritative full-part writes immediately below.
        // Stream teardown has already attempted a bounded best-effort delta
        // publication. Retrying the SAME optional delta from cleanup would
        // recreate an unbounded SSE/SQLite wait after a watchdog cancellation.
        // The full text/reasoning content buffers are still intact and are
        // written as complete parts, so discarding only *unpublished UI deltas*
        // loses no canonical message data.
        ctx.pendingTextDelta = undefined
        ctx.pendingReasoningDelta = {}

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.text = ctx.currentTextContent?.toString() ?? ctx.currentText.text
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
          ctx.currentTextContent = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          part.text = ctx.reasoningContent[part.id]?.toString() ?? part.text
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}
        ctx.reasoningContent = {}
        ctx.pendingReasoningDelta = {}

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

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown, source: HaltSource = "failure") {
        if (source === "failure" && e instanceof ProviderProgressTimeoutError)
          ctx.providerTimedOut = true
        if (source === "interrupt") {
          yield* Effect.logInfo("process interrupted", {
            "session.id": input.sessionID,
            messageID: input.assistantMessage.id,
          })
        } else {
          yield* Effect.logError("process", {
            "session.id": input.sessionID,
            messageID: input.assistantMessage.id,
            error: errorMessage(e),
            errorDetails: SessionError.summary(e),
            stack: e instanceof Error ? e.stack : undefined,
          })
        }
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
        ctx.providerTimedOut = false
        ctx.spad?.markGeneration()
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          const runAttempt = Effect.fnUntraced(function* () {
            providerEventsThisAttempt = false
            ctx.currentText = undefined
            ctx.currentTextContent = undefined
            ctx.reasoningMap = {}
            ctx.reasoningContent = {}
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
              isCompaction: ctx.assistantMessage.summary === true,
              model: {
                providerID: ctx.model.providerID,
                modelID: splitAccountModelID(ctx.model.id).baseModelID,
                ...(ctx.routeAttribution?.routeKind === "account" && ctx.routeAttribution.accountID
                  ? { accountID: ctx.routeAttribution.accountID }
                  : splitAccountModelID(ctx.model.id).accountID
                    ? { accountID: splitAccountModelID(ctx.model.id).accountID }
                    : {}),
                name: ctx.model.name,
                ...(ctx.assistantMessage.variant === undefined ? {} : { variant: ctx.assistantMessage.variant }),
                contextLimit: ctx.model.limit.context,
              },
            })

            const probe = createProviderStreamProbe()
            const stream = llm.stream({
              ...streamInput,
              ...(ctx.routeAttribution ? { route: ctx.routeAttribution } : {}),
              progress: probe,
            })
            // 'finish' is the request's terminal protocol event. The SDK may
            // delay underlying iterable EOF after delivering it; completing a
            // logical request must not depend on that extra transport boundary.
            let providerFinished = false

            yield* withProviderProgressDeadline((observeResponse, consumer) => consumeWithFlushDeadline(stream, {
              delayMs: DELTA_FLUSH_MS,
              pending: () => ctx.pendingTextDelta !== undefined || Object.keys(ctx.pendingReasoningDelta).length > 0,
              // Flush alarms and final delta settlement also run inside the
              // serial event consumer. If publication/SQLite stalls here,
              // classify it as local work, never as provider silence.
              flush: Effect.sync(() => {
                consumer.begin("delta-flush")
                consumer.phase("delta-publication")
              }).pipe(
                Effect.andThen(flushAllDeltas()),
                Effect.ensuring(Effect.sync(() => consumer.end())),
              ),
              consume: (event) =>
                Effect.gen(function* () {
                  // Provider-event observation is the progress proof used by
                  // interactive preemption. Publish it before changing retry
                  // status or performing any event-specific side effect so a
                  // concurrent prompt can never abort an already-proven attempt.
                    // Count provider ingress BEFORE asynchronous telemetry. An
                    // overloaded telemetry observer must not falsely look like
                    // silence from the upstream provider.
                      // A lone terminal provider-error is a rejection, not
                      // progress. Native adapters can deliver a structured
                      // prompt compiler failure this way rather than throwing
                      // an SDK error. An earlier step/tool/text event still
                      // permanently closes the retry gate for this attempt.
                      if (event.type !== "provider-error") providerEventsThisAttempt = true
                      yield* observeResponse(event)
                     consumer.begin(event.type)
                     consumer.phase("telemetry-observe")
                     const accepted = yield* telemetry.observe({ sessionID: ctx.sessionID, event })
                    if (!accepted) return yield* Effect.interrupt
                   if (retryingWithoutProgress) {
                    retryingWithoutProgress = false
                    yield* status.set(ctx.sessionID, { type: "busy" })
                  }
                     consumer.phase("event-handler")
                     yield* handleEvent(event, consumer.phase)
                     if (event.type === "finish") providerFinished = true
                  }).pipe(Effect.ensuring(Effect.sync(() => consumer.end()))),
                stop: () => providerFinished || ctx.needsCompaction || ctx.needsRecovery !== undefined || ctx.needsSpadAbort !== undefined,
            }), undefined, (id) =>
              executingHostTools.has(id)
                ? "running"
                : ctx.toolcalls[id] !== undefined
                  ? "pending"
                   : "settled", undefined, probe, undefined, {
                   sessionID: ctx.sessionID,
                   messageID: ctx.assistantMessage.id,
                   providerID: ctx.model.providerID,
                   modelID: splitAccountModelID(ctx.model.id).baseModelID,
                   routeKind: ctx.routeAttribution?.routeKind,
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
          })

          const runWithRetry = () => runAttempt().pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"), "interrupt")
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
            Effect.catchIf(
              (error) =>
                !ctx.recoveredStaleReasoning &&
                !ctx.turnOutputStarted &&
                isStaleReasoningFailure(error),
              () =>
                Effect.gen(function* () {
                  ctx.recoveredStaleReasoning = true
                  SessionStaleReasoning.stripRequest(streamInput.messages)
                  // Repair durable replay handles from the exact history the
                  // turn owner already held for this request. Callers that did
                  // not supply a boundary only repair the in-flight request.
                  if (input.durableHistory) yield* SessionStaleReasoning.persist(session, input.durableHistory)
                  yield* Effect.logInfo("recovered stale encrypted reasoning", {
                    "session.id": ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                  })
                  // Retry exactly once with repaired history before ordinary
                  // transient retry classification. The turn-scoped latch and
                  // output guard prevent duplicate durable assistant output.
                  return yield* runAttempt()
                }),
            ),
            Effect.catchIf(
              (error) =>
                !recoveredPromptRendering &&
                !providerEventsThisAttempt &&
                !ctx.turnOutputStarted &&
                SessionPromptRenderingRecovery.isPromptRenderingRejection(error),
              (error) =>
                Effect.gen(function* () {
                  const repaired = SessionPromptRenderingRecovery.stripRejectedReasoning(
                    streamInput.messages,
                    ctx.model,
                  )
                  // The provider may have rejected a tool/role shape instead
                  // of reasoning. Do not replay an identical failed payload.
                  if (!repaired) return yield* Effect.fail(error)
                  recoveredPromptRendering = true
                  streamInput.messages = repaired.messages
                  yield* Effect.logInfo("retrying hosted prompt with portable reasoning-free history", {
                    "session.id": ctx.sessionID,
                    messageID: ctx.assistantMessage.id,
                    providerID: ctx.model.providerID,
                    modelID: ctx.model.id,
                    removedReasoningParts: repaired.removedReasoningParts,
                    removedReasoningOnlyMessages: repaired.removedReasoningOnlyMessages,
                  })
                  // No durable transcript rewrite, no route change, no tool
                  // replay, and no recurring physical retry on a second reject.
                  return yield* runAttempt()
                }),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                ...(ctx.routeAttribution ? { route: ctx.routeAttribution } : {}),
                parse,
                observe: ({ decision }) => {
                  const health =
                    !healthLease || decision.routeEffect === "none"
                      ? Effect.void
                      : routeHealth
                          .observeFailure({
                            lease: healthLease,
                            modelID: ctx.model.id,
                            effect: decision.routeEffect,
                            ...(decision.resetAt === undefined ? {} : { resetAt: decision.resetAt }),
                          })
                          .pipe(Effect.catch((error) => healthObservationWarning("failure", error)))
                  if (
                    !["account-quota", "public-quota", "account-rate-limit", "rate-limit"].includes(decision.class)
                  )
                    return health
                  const failureClass = decision.class as
                    | "account-quota"
                    | "public-quota"
                    | "account-rate-limit"
                    | "rate-limit"
                  const now = Date.now()
                  const accountID = ctx.routeAttribution?.routeKind === "account" ? ctx.routeAttribution.accountID : undefined
                  return Effect.gen(function* () {
                    yield* health
                    const latestUserSeq = yield* SessionInput.latestUserSeq(database.db, ctx.sessionID)
                    const recoveryPolicy = (yield* config.getGlobal()).usage_limit_recovery
                    // Goal execution is intrinsically autonomous while active or
                    // verifying. A trusted provider reset is a temporary,
                    // schedulable blocker, not a reason to make Goal progress
                    // depend on the ordinary-session auto-resume preference.
                    const focusedGoal = yield* goals.focusedLifecycle(ctx.sessionID)
                    const goalAutoResume =
                      focusedGoal?.status === "active" || focusedGoal?.status === "verifying"
                    const autoResume = goalAutoResume || recoveryPolicy?.auto_resume === true
                    const recovery = yield* SessionLimitRecovery.observeFailure(database.db, {
                      sessionID: ctx.sessionID,
                      sourceAssistantMessageID: ctx.assistantMessage.id,
                      ...(ctx.assistantMessage.parentID ? { sourceUserMessageID: ctx.assistantMessage.parentID } : {}),
                      providerID: ctx.model.providerID,
                      ...(accountID ? { accountID } : {}),
                      modelID: ctx.model.id,
                      failureClass,
                      failureCode: ctx.assistantMessage.error?.name,
                      ...(decision.resetAt === undefined ? {} : { resetAt: decision.resetAt, resetSource: "retry-after" as const }),
                      resetObservedAt: now,
                      expectedLatestUserSeq: latestUserSeq,
                      autoResume,
                      snoozeUntilReset: recoveryPolicy?.snooze_until_reset === true,
                      now,
                    })
                    if (recovery) {
                      yield* events.publish(SessionLimitRecoveryContract.Updated, { recovery })
                      if (decision.resetAt === undefined) {
                        yield* Effect.gen(function* () {
                          const observedAt = Date.now()
                          const agenda = yield* quota.resetsForProvider({
                            providerID: ctx.model.providerID,
                            from: observedAt + 1,
                            to: observedAt + 400 * 24 * 60 * 60 * 1000,
                            generatedAt: observedAt,
                          })
                          const candidate = selectRecoveryQuotaReset(agenda, {
                            ...(accountID ? { accountID } : {}),
                            modelID: ctx.model.id,
                            failureObservedAt: now,
                          })
                          if (!candidate) return
                          const enriched = yield* SessionLimitRecovery.enrichReset(database.db, {
                            sessionID: ctx.sessionID,
                            generation: recovery.generation,
                            resetAt: candidate.resetAt,
                            resetSource: candidate.resetSource,
                            resetObservedAt: candidate.resetObservedAt,
                            autoResume,
                            snoozeUntilReset: recoveryPolicy?.snooze_until_reset === true,
                            now: Date.now(),
                          })
                          if (enriched) {
                            yield* events.publish(SessionLimitRecoveryContract.Updated, { recovery: enriched })
                          }
                        }).pipe(
                          Effect.catchCause((cause) =>
                            Effect.logWarning("limit recovery quota enrichment failed", {
                              providerID: ctx.model.providerID,
                              cause: Cause.pretty(cause),
                            }),
                          ),
                          Effect.forkIn(scope),
                          Effect.asVoid,
                        )
                      }
                    }
                  }).pipe(
                    // Recovery bookkeeping is auxiliary to settling the provider
                    // failure. Database defects must be observable but must never
                    // defect-kill the Session drain from inside retry policy.
                    Effect.catchCause((cause) =>
                      Effect.logWarning("limit recovery failure observation failed", {
                        cause: Cause.pretty(cause),
                      }),
                    ),
                  )
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
          )
          yield* runWithRetry().pipe(
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
            Effect.ensuring(settleRemainingTools().pipe(
              Effect.andThen(cleanup()),
              Effect.ensuring(Effect.sync(releaseAllLiveParts)),
            )),
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
        toolPartID: (toolCallID) => ctx.toolcalls[toolCallID]?.partID,
        markWorkspaceMutation: () => Effect.sync(() => {
          ctx.workspaceMutationObserved = true
        }),
        completeToolCall,
        failToolCall,
        startToolCall,
        process,
        get recovery() {
          return ctx.needsRecovery
        },
        get providerTimedOut() {
          return ctx.providerTimedOut
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
    Quota.node,
    Goal.node,
  ],
})

export * as SessionProcessor from "./processor"
