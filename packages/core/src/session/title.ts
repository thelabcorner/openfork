export * as SessionTitle from "./title"

import { LLM, LLMClient, Message, SystemPart, Tool, toDefinitions } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Ref, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { type ToolChoiceCapabilityIdentity } from "../tool-choice-compatibility"
import {
  collectUntilTerminalTool,
  generateAdaptive,
  boundedMaxTokens,
  retryMaxTokens,
  runTerminalCompletion,
  terminalCompletionAccepted,
  withSpecialAgentTimeout,
} from "../special-agent-completion"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SpecialAgentSessionContext } from "../special-agent-session-context"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionStore } from "./store"
import { DEFAULT_PROMPT, GENERATED_TITLE_TOOL, PROTOCOL_PROMPT } from "./title-prompt"

/** Back-compatible export used by settings and V1 title generation. */
export const DEFAULT_TITLE_PROMPT = DEFAULT_PROMPT
export { DEFAULT_PROMPT, GENERATED_TITLE_TOOL, PROTOCOL_PROMPT } from "./title-prompt"
export const GeneratedTitleToolInput = Schema.Struct({ title: Schema.String })
export type GeneratedTitleToolInput = typeof GeneratedTitleToolInput.Type

export const MAX_TITLE_LENGTH = 60
export const MAX_TITLE_CONTEXT_CHARS = 8_000

/**
 * A committed title is a few dozen tokens, but the same budget also has to cover
 * whatever reasoning the model emits before the tool call. Too small a budget
 * truncates the turn and looks like the model refusing the protocol.
 */
const TITLE_MAX_TOKENS = 1_024
const TITLE_MAX_TOKENS_CEILING = 8_192
const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "
const defaultTitlePattern = new RegExp(
  `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
)

/** Whether a title is the mechanical placeholder created with the session (shared by V1 and V2). */
export function isDefaultTitle(title: string) {
  return defaultTitlePattern.test(title)
}

/**
 * Normalizes raw model output into a single-line title. Strips think blocks,
 * code-fence markers, inline quotes, and blockquote markers; keeps the first
 * non-empty line; caps at {@link MAX_TITLE_LENGTH} (59 + ellipsis). Returns `undefined`
 * when nothing usable remains — treated as failure, never written.
 */
export function sanitizeTitle(raw: string): string | undefined {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/```(?:[a-zA-Z0-9_-]+)?/g, "")
    .replace(/`/g, "")
    .replace(/^\s*>\s?/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (cleaned === undefined) return undefined
  if (cleaned.length > MAX_TITLE_LENGTH) return cleaned.slice(0, MAX_TITLE_LENGTH - 1) + "…"
  return cleaned
}

/**
 * Legacy compatibility for title_prompt values authored before runtime context
 * was host-injected. New policies do not need either placeholder.
 */
export function renderLegacyPolicy(
  policy: string,
  input: { readonly previousTitle: string; readonly conversation: string },
) {
  return policy.replaceAll("{previousTitle}", input.previousTitle).replaceAll("{conversation}", input.conversation)
}

/**
 * Builds the title-generation conversation block. Walks messages newest-first
 * and stops near {@link MAX_TITLE_CONTEXT_CHARS}; if that truncation dropped
 * the first real user message, it is pinned at the front so the model always
 * sees the opening intent.
 */
export function assembleContext(messages: readonly SessionMessage.Message[]): string {
  return SpecialAgentSessionContext.assemble(messages, {
    maxChars: MAX_TITLE_CONTEXT_CHARS,
    maxBlockChars: MAX_TITLE_CONTEXT_CHARS,
    includeShell: true,
    pinOpeningUser: true,
    pinLatestCompaction: true,
  })
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("SessionTitle.UnavailableError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

type PendingEntry = { readonly requestID: string; readonly baselineTitle: string }

export interface Interface {
  /**
   * Generate and apply a title through the shared race guards. The caller owns
   * background lifetime so the Location-scoped service stays alive for the
   * entire model request. Replaces any pending generation for the session
   * (supersede). The current title is the baseline — a manual rename while
   * generation is in flight discards the generated title. Never routes through
   * the Session runner, never admits session inputs, and works while paused.
   */
  readonly regenerate: (input: {
    readonly session: SessionSchema.Info
    readonly prompt?: string
    readonly model?: ModelV2.Ref
  }) => Effect.Effect<void, UnavailableError>
  /**
   * First-prompt auto-title for the V2 runner's post-run maintenance. Guards:
   * forked sessions skip, only default titles are overwritten, and exactly one
   * real user message must exist. Takes a turn through the same per-session
   * pending registry as manual regeneration. Failures are logged, never crash
   * the drain.
   */
  readonly autoTitle: (input: {
    readonly session: SessionSchema.Info
    readonly messages: SessionMessage.Message[]
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTitle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const store = yield* SessionStore.Service
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const models = yield* SessionRunnerModel.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const scope = yield* Scope.Scope
    const pending = yield* Ref.make(new Map<SessionSchema.ID, PendingEntry>())
    const generatedTitleTool = Tool.make({
      description:
        "Commit the final session title. This is the only valid successful completion for title generation. Supply only the title artifact; do not put explanations or reasoning in the title field. IMMEDIATELY END GENERATION after this tool call; do not reason, emit prose, or call another tool afterward.",
      parameters: GeneratedTitleToolInput,
      success: Schema.String,
      execute: () => Effect.succeed(terminalCompletionAccepted(GENERATED_TITLE_TOOL)),
    })

    const clearPending = (sessionID: SessionSchema.ID, requestID: string) =>
      Ref.update(pending, (map) => {
        if (map.get(sessionID)?.requestID === requestID) map.delete(sessionID)
        return map
      })

    const resolveFromCatalog = Effect.fn("SessionTitle.resolveFromCatalog")(function* (ref: {
      readonly providerID: ProviderV2.ID
      readonly id: ModelV2.ID
    }) {
      const model = yield* catalog.model.get(ref.providerID, ref.id)
      // Structured title completion is a hard transport requirement now. A
      // prose-only model can never satisfy generated_title, so do not select it
      // and then fail the request with a misleading 503. Let the cascade move
      // on to the next usable model instead.
      if (model === undefined || !model.capabilities.tools || !SessionRunnerModel.supported(model)) return undefined
      const provider = yield* catalog.provider.get(ref.providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(ref.providerID),
      )
      return yield* SessionRunnerModel.fromCatalogModel(
        model,
        connection ? yield* integrations.connection.resolve(connection) : undefined,
      ).pipe(Effect.catchTag("SessionRunnerModel.UnsupportedApiError", () => Effect.succeed(undefined)))
    })

    const resolveModel = Effect.fn("SessionTitle.resolveModel")(function* (
      session: SessionSchema.Info,
      requestModel: ModelV2.Ref | undefined,
    ) {
      if (requestModel) {
        const resolved = yield* resolveFromCatalog({ providerID: requestModel.providerID, id: requestModel.id })
        if (resolved) return resolved
      }
      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      if (titleAgent?.model) {
        const resolved = yield* resolveFromCatalog({ providerID: titleAgent.model.providerID, id: titleAgent.model.id })
        if (resolved) return resolved
      }
      const smallModel = Config.latest(yield* config.entries(), "small_model")
      if (smallModel) {
        const [providerID, ...rest] = smallModel.split("/")
        if (providerID !== undefined && rest.length > 0) {
          const resolved = yield* resolveFromCatalog({
            providerID: ProviderV2.ID.make(providerID),
            id: ModelV2.ID.make(rest.join("/")),
          })
          if (resolved) return resolved
        }
      }
      if (session.model) {
        const small = yield* catalog.model.small(session.model.providerID)
        if (small) {
          const resolved = yield* resolveFromCatalog({ providerID: small.providerID, id: small.id })
          if (resolved) return resolved
        }
      }
      return yield* models.resolve(session)
    })

    const applyTitle = Effect.fn("SessionTitle.applyTitle")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly requestID: string
      readonly baselineTitle: string
      readonly title: string
      readonly defaultOnly: boolean
    }) {
      if ((yield* Ref.get(pending)).get(input.sessionID)?.requestID !== input.requestID) return false
      const current = yield* store.get(input.sessionID)
      if (current === undefined) return false
      if (current.title !== input.baselineTitle) {
        yield* clearPending(input.sessionID, input.requestID)
        return false
      }
      if (input.defaultOnly && !isDefaultTitle(current.title)) {
        yield* clearPending(input.sessionID, input.requestID)
        return false
      }
      const timestamp = yield* DateTime.now
      yield* events.publish(
        SessionEvent.Renamed,
        {
          sessionID: input.sessionID,
          timestamp,
          title: input.title,
        },
        {
          commit: () =>
            db
              .update(SessionTable)
              .set({ title: input.title, time_updated: DateTime.toEpochMillis(timestamp) })
              .where(eq(SessionTable.id, input.sessionID))
              .run()
              .pipe(Effect.orDie),
        },
      )
      yield* clearPending(input.sessionID, input.requestID)
      return true
    })

    const runGeneration = Effect.fn("SessionTitle.runGeneration")(function* (input: {
      readonly session: SessionSchema.Info
      readonly requestID: string
      readonly baselineTitle: string
      readonly prompt?: string
      readonly model?: ModelV2.Ref
      readonly defaultOnly: boolean
      readonly messages?: SessionMessage.Message[]
    }) {
      const session = input.session
      const messages =
        input.messages ??
        (yield* store.context(session.id).pipe(
          Effect.mapError(
            (error) =>
              new UnavailableError({
                sessionID: session.id,
                message: `Unable to load conversation context for title generation: ${error.message}`,
              }),
          ),
        ))
      // Nothing to title without at least one real user message (edge #5).
      if (messages.filter((message) => message.type === "user").length === 0) return false
      const context = assembleContext(messages)
      const entries = yield* config.entries()
      const configured = Config.latest(entries, "title_prompt")
      const model = yield* resolveModel(session, input.model).pipe(
        Effect.catch(
          (error) =>
            new UnavailableError({
              sessionID: session.id,
              message: `No model is available for title generation: ${error instanceof Error ? error.message : String(error)}`,
            }),
        ),
      )
      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      const policySource =
        input.prompt?.trim() || configured?.trim() || titleAgent?.system?.trim() || DEFAULT_TITLE_PROMPT
      const policy = renderLegacyPolicy(policySource, { previousTitle: session.title, conversation: context })
      const system = `${policy}\n\n${PROTOCOL_PROMPT}`
      const capability: ToolChoiceCapabilityIdentity = {
        providerID: String(model.provider),
        modelID: String(model.id),
        apiURL: model.route.endpoint.baseURL,
        routeID: model.route.id,
        routeProtocol: String(model.route.protocol),
      }
      const request = LLM.request({
        model,
        system: [SystemPart.make(system)],
        messages: [
          Message.user(
            `<title-generation-context>\n${JSON.stringify({
              generationPurpose: input.defaultOnly ? "initial" : "regenerate",
              currentTitle: session.title,
              conversation: context,
            })}\n</title-generation-context>`,
          ),
        ],
        tools: toDefinitions({ [GENERATED_TITLE_TOOL]: generatedTitleTool }),
        // There is exactly one available tool. `required` is semantically the
        // same as a named forced choice here, but is supported by more provider
        // adapters (and mirrors Prompt Revisor's terminal-tool contract).
        toolChoice: "required",
        generation: { maxTokens: boundedMaxTokens(model, TITLE_MAX_TOKENS), temperature: 0.2 },
      })
      const generate = (current: typeof request, preferred: "required" | "auto") =>
        generateAdaptive({
          identity: capability,
          requested: preferred,
          generate: (toolChoice) =>
            collectUntilTerminalTool(llm.stream(LLM.updateRequest(current, { toolChoice })), GENERATED_TITLE_TOOL).pipe(
              Effect.flatMap((response) =>
                response
                  ? Effect.succeed(response)
                  : Effect.fail(new Error("Title generation ended without a terminal response")),
              ),
            ),
        }).pipe(
          Effect.mapError(
            (error) =>
              new UnavailableError({
                sessionID: session.id,
                message: `Title generation failed: ${error.message}`,
              }),
          ),
        )

      let preferred: "required" | "auto" = "required"
      const terminal = yield* runTerminalCompletion({
        messages: request.messages,
        toolName: GENERATED_TITLE_TOOL,
        agentLabel: "session title generator",
        generate: (messages, attempt) =>
          generate(
            LLM.updateRequest(request, {
              messages,
              // A title is tiny, but a reasoning model spends the same budget
              // before it emits any tool call. Retry a truncated attempt with
              // more room instead of repeating an impossible request.
              generation: {
                maxTokens: boundedMaxTokens(model, retryMaxTokens(TITLE_MAX_TOKENS, attempt, TITLE_MAX_TOKENS_CEILING)),
                temperature: 0.2,
              },
            }),
            preferred,
          ).pipe(
            Effect.tap((attempt) => Effect.sync(() => (preferred = attempt.toolChoice))),
            Effect.map((attempt) => attempt.response),
          ),
        validate: (call) =>
          Schema.decodeUnknownEffect(GeneratedTitleToolInput)(call.input).pipe(
            Effect.mapError((error) => `Invalid ${GENERATED_TITLE_TOOL} payload: ${error.message}`),
            Effect.flatMap((committed) => {
              const title = sanitizeTitle(committed.title)
              return title === undefined
                ? Effect.fail("The generated title is empty or unusable after normalization")
                : Effect.succeed(title)
            }),
          ),
        invalid: (failure) =>
          new UnavailableError({
            sessionID: session.id,
            message:
              failure.reason === "truncated"
                ? `Title generation hit the model output limit before it could call ${GENERATED_TITLE_TOOL}`
                : failure.reason === "missing"
                  ? `Title generation did not call ${GENERATED_TITLE_TOOL} after its repair retry`
                : failure.reason === "multiple"
                  ? `Title generation emitted multiple ${GENERATED_TITLE_TOOL} calls`
                  : failure.reason === "invalid-payload"
                    ? `Title generation produced invalid ${GENERATED_TITLE_TOOL}: ${failure.detail ?? "invalid payload"}`
                    : `${GENERATED_TITLE_TOOL} must be the only content-producing action in the response`,
          }),
      })
      const title = terminal.artifact
      return yield* applyTitle({
        sessionID: session.id,
        requestID: input.requestID,
        baselineTitle: input.baselineTitle,
        title,
        defaultOnly: input.defaultOnly,
      })
    })

    return Service.of({
      regenerate: Effect.fn("SessionTitle.regenerate")(function* (input: {
        readonly session: SessionSchema.Info
        readonly prompt?: string
        readonly model?: ModelV2.Ref
      }) {
        const requestID = crypto.randomUUID()
        yield* Ref.update(pending, (map) => {
          map.set(input.session.id, { requestID, baselineTitle: input.session.title })
          return map
        })
        yield* withSpecialAgentTimeout(
          runGeneration({
            session: input.session,
            requestID,
            baselineTitle: input.session.title,
            prompt: input.prompt,
            model: input.model,
            defaultOnly: false,
          }),
          () =>
            Effect.fail(
              new UnavailableError({
                sessionID: input.session.id,
                message: "Title generation timed out after 5 minutes",
              }),
            ),
        ).pipe(Effect.asVoid, Effect.ensuring(clearPending(input.session.id, requestID)))
      }),
      autoTitle: Effect.fn("SessionTitle.autoTitle")(function* (input) {
        const session = input.session
        if (session.parentID !== undefined) return
        if (!isDefaultTitle(session.title)) return
        if (input.messages.filter((message) => message.type === "user").length !== 1) return
        const requestID = crypto.randomUUID()
        yield* Ref.update(pending, (map) => {
          map.set(session.id, { requestID, baselineTitle: session.title })
          return map
        })
        yield* withSpecialAgentTimeout(
          runGeneration({
            session,
            requestID,
            baselineTitle: session.title,
            defaultOnly: true,
            messages: input.messages,
          }),
          () =>
            Effect.fail(
              new UnavailableError({ sessionID: session.id, message: "Title generation timed out after 5 minutes" }),
            ),
        ).pipe(
          Effect.catch((error) => Effect.logError("Failed to auto-title session", { sessionID: session.id, error })),
          Effect.ensuring(clearPending(session.id, requestID)),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    llmClient,
    AgentV2.node,
    SessionStore.node,
    Config.node,
    Catalog.node,
    Integration.node,
    SessionRunnerModel.node,
    Database.node,
    EventV2.node,
  ],
})

/** Test seam: no-op title generation (also used by runner tests that never title). */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    regenerate: () => Effect.void,
    autoTitle: () => Effect.void,
  }),
)
