import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Storage } from "@/storage/storage"
import { ClaudeBindingPersistence } from "@/claude/binding-persistence"
import { ClaudeToolBridge } from "@/claude/tool-bridge"
import { ClaudeSessions } from "@/claude/sessions"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { abortableProviderIterable } from "./llm/abortable-provider-iterable"
import { registerProviderTransport } from "./llm/provider-transport"
import { needsNativeReasoningTransport } from "./llm/reasoning-runtime-selection"
import { requireTerminalFinish } from "./llm/terminal-stream"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { laceObservePolicy, laceObserveScope } from "./llm/lace-observation-policy"
import { createLaceAISdkObserver, laceObserveAIEnabled } from "./llm/lace-ai-sdk-observer"
import { bindPermission } from "./llm/permission-binding"
import { healLegacyFindCall } from "./llm/tool-call-heal"
import { restoreMuseToolEvent } from "./llm/muse-tool-names"
import { Identifier } from "@/id/id"
import { requiresAccountBackedHostedRoute } from "@/special-agent/hosted-route-policy"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

// Defense in depth: host-owned special agents must not send hosted Public/free
// requests through the V1 streaming path, even if a caller forgets to disable
// Public during model resolution. Ordinary user turns retain their own route.

// SDK-level observations are deliberately separate from native compiled-body
// witnesses. This captures post-transform V3 inputs, NOT final provider bytes.
const laceAISdkObserver = createLaceAISdkObserver()

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  /** Attempt-local, payload-free stage witnesses; not sent to providers or persisted. */
  progress?: { sdk: (type: string) => void; normalized: (type: string) => void }
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  /**
   * External-provider conversation continuity. Ordinary Session turns are
   * bound to the Session; maintenance/derived generations must be isolated so
   * they cannot resume, invalidate, or fork the Session's provider transcript.
   */
  continuity?: "session" | "isolated"
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  /** Optional caller-specific cap, clamped against the provider/model maximum. */
  maxOutputTokens?: number
  /**
   * Secret-free committed route authority for this dispatch. When present,
   * Provider already materialized the exact account/Public transport; legacy
   * Auth.Service must not independently select or inject another credential.
   */
  route?: UsageRouteAttribution.Committed
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
  | Storage.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const claudeBindings = yield* ClaudeBindingPersistence.bindingStorageFromService

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      if (
        requiresAccountBackedHostedRoute({
          hostedProvider: Provider.isHostedZenProvider(input.model.providerID),
          agent: input.agent.name,
          sessionAgent: input.user.agent,
        }) &&
        input.route?.routeKind !== "account"
      ) {
        return yield* Effect.fail(new Error(
          "Hosted OpenCode Public free tier cannot execute OpenFork special agents. Select an authenticated account-backed model.",
        ))
      }
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID, input.model),
          input.route ? Effect.succeed(undefined) : auth.get(input.model.providerID),
        ],
        { concurrency: 4 },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const healed = healLegacyFindCall(toolName, argsJson, prepared.tools)
          const resolvedName = healed.name
          const t = prepared.tools[resolvedName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const args = typeof healed.input === "string" ? JSON.parse(healed.input) : healed.input
            // The workflow service may omit the request/tool-call ID. Mint a
            // durable, process-unique identity instead of executing unowned.
            const callID = _requestID && _requestID.length > 0
              ? _requestID
              : Identifier.create("call", "ascending")
            const result = await t.execute!(args, {
              toolCallId: callID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listenType(Permission.Event.Replied, (event) => {
                const data = event.data
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // First-party Claude runtime seam: claude models execute through the
      // Agent SDK adapter instead of HTTP provider routes. The adapter keeps the
      // SDK lazy and honors the shouldEnableClaudeFirstParty rollback gate;
      // RuntimeFlags provides the same env signal for an early skip.
      if (input.model.providerID === "claude" && !flags.disableClaudeCodeFirstParty) {
        const { ClaudeRuntimeAdapter } = yield* Effect.promise(() => import("./llm/claude-runtime"))
        const claude = ClaudeRuntimeAdapter.status({ providerID: input.model.providerID })
        if (claude.type === "supported") {
          const context = yield* InstanceState.context
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "claude-agent-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: ClaudeRuntimeAdapter.stream({
              sessionID: input.sessionID,
              system: prepared.system,
              messages: prepared.messages,
              tools: prepared.tools,
              modelID: input.model.id,
              providerID: input.model.providerID,
              effort: input.user.model.variant,
              // Small generations are maintenance by contract. Callers that
              // use the parent Session ID for telemetry must not implicitly
              // inherit its external Claude transcript.
              continuity: input.continuity ?? (input.small ? "isolated" : "session"),
              abort: input.abort,
              permission: bindPermission(perm, bridge),
              ruleset: Permission.merge(input.agent.permission ?? [], input.permission ?? []),
              bindings: claudeBindings,
              store: ClaudeToolBridge.getOrCreateStore(context.directory),
              context: {
                projectID: context.project.id,
                worktree: context.worktree,
                directory: context.directory,
              },
              transcriptExists: (claudeSessionID, cwd) => ClaudeSessions.transcriptExists(claudeSessionID, { cwd }),
              transcriptHasEntry: (claudeSessionID, uuid, cwd) =>
                ClaudeSessions.transcriptHasEntry(claudeSessionID, uuid, { cwd }),
            }),
          }
        }
      }

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
       // OpenAI-compatible SDK providers do not provide a uniform media input
       // protocol. Route audio/video turns through our native Chat adapter.
       // Do not switch unrelated requests or providers that own other formats.
       const nativeMedia =
         input.model.api.npm === "@ai-sdk/openai-compatible" &&
         prepared.messages.some(
           (msg) =>
             msg.role === "user" &&
             Array.isArray(msg.content) &&
             msg.content.some((part) =>
               part.type === "file" &&
               ((part.mediaType.startsWith("video/") && input.model.capabilities.input.video) ||
                 (part.mediaType.startsWith("audio/") && input.model.capabilities.input.audio)),
             ),
         )
        const nativeReasoning = needsNativeReasoningTransport(input.model)
        if (flags.experimentalNativeLlm || nativeMedia || nativeReasoning) {
        const laceEnabled = laceObservePolicy(input.sessionID, process.env)
        const laceContext = laceEnabled && input.route ? yield* InstanceState.context : undefined
        const lace = laceContext && input.route
          ? laceObserveScope({
              projectID: laceContext.project.id,
              directory: laceContext.directory,
              worktree: laceContext.worktree,
              sessionID: input.sessionID,
              routeKind: input.route.routeKind,
              ...(input.route.routeKind === "account" ? { accountID: input.route.accountID } : {}),
              continuity: input.continuity ?? (input.small ? "isolated" : "session"),
              requestID: input.user.id,
            })
          : undefined
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          ...(lace ? { lace } : {}),
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream.pipe(Stream.map((event) => restoreMuseToolEvent(event, prepared.canonicalByAlias))),
          }
        }
        if (nativeMedia) {
          throw new Error(`The selected model advertises audio/video input, but its configured provider route cannot deliver it: ${native.reason}. Use a supported route or a local media extraction fallback.`)
        }
        if (nativeReasoning) {
          // The installed AI SDK silently discards reasoning_text chunks. Do
          // not fall back to a provider adapter known to lose model output.
          throw new Error(`This model requires native reasoning_text decoding, but the native provider route is unavailable: ${native.reason}`)
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      const laceAIEnabled = input.route && laceObserveAIEnabled(input.sessionID, process.env)
      const laceAIContext = laceAIEnabled ? yield* InstanceState.context : undefined
      const laceAIScope = laceAIContext && input.route
        ? laceObserveScope({
            projectID: laceAIContext.project.id,
            directory: laceAIContext.directory,
            worktree: laceAIContext.worktree,
            sessionID: input.sessionID,
            routeKind: input.route.routeKind,
            ...(input.route.routeKind === "account" ? { accountID: input.route.accountID } : {}),
            continuity: input.continuity ?? (input.small ? "isolated" : "session"),
            requestID: input.user.id,
          })
        : undefined
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const healed = healLegacyFindCall(failed.toolCall.toolName, failed.toolCall.input, prepared.tools)
            if (healed.healed) {
              return {
                ...failed.toolCall,
                toolName: healed.name,
                input: healed.input as string,
              }
            }
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                    // Read-only, post-transform AI SDK V3 witness (not HTTP bytes).
                    // Observation is never allowed to fail the provider call.
                    if (laceAIScope) {
                      try {
                        const observation = laceAISdkObserver.observe({
                          owner: laceAIScope.owner,
                          session: laceAIScope.session,
                          provider: input.model.providerID,
                          model: input.model.id,
                          route: input.model.api.npm,
                          prompt: args.params.prompt,
                          tools: args.params.tools,
                          options: {
                            toolChoice: args.params.toolChoice,
                            providerOptions: args.params.providerOptions,
                            responseFormat: args.params.responseFormat,
                            temperature: args.params.temperature,
                            topP: args.params.topP,
                            topK: args.params.topK,
                          },
                        })
                        if (observation.status !== "observed" || observation.kind !== "identical") {
                          bridge.fork(Effect.logDebug("LACE AI SDK pre-wire observation", {
                            status: observation.status,
                            ...(observation.status === "observed"
                              ? { change: observation.kind, messages: observation.messageCount }
                              : {}),
                          }))
                        }
                      } catch {
                        // Optional telemetry is never a dependency of inference.
                      }
                    }
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
        canonicalByAlias: prepared.canonicalByAlias,
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const transport = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const controller = new AbortController()
                return { controller, release: registerProviderTransport(input.sessionID, controller) }
              }),
              ({ controller, release }) => Effect.sync(() => {
                controller.abort()
                release()
              }),
            )

            const result = yield* run({ ...input, abort: transport.controller.signal })

            if (result.type === "native") return requireTerminalFinish(result.stream, transport.controller.signal).pipe(
              Stream.tap((event) => Effect.sync(() => input.progress?.normalized(event.type))),
            )

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState({
              requireChatFinishReason: input.model.api.npm === "@ai-sdk/openai-compatible",
            })
            return requireTerminalFinish(
              Stream.fromAsyncIterable(abortableProviderIterable(result.result.fullStream, transport.controller), (e) =>
                e instanceof Error ? e : new Error(String(e)),
              ).pipe(
                Stream.tap((event) => Effect.sync(() => input.progress?.sdk(event.type))),
                Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                Stream.flatMap((events) => Stream.fromIterable(events)),
                Stream.map((event) => restoreMuseToolEvent(event, result.canonicalByAlias)),
              ),
              transport.controller.signal,
            ).pipe(Stream.tap((event) => Effect.sync(() => input.progress?.normalized(event.type))))
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
    Storage.node,
  ],
})

export * as LLM from "./llm"
