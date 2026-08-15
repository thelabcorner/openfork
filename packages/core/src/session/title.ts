export * as SessionTitle from "./title"

import { LLM, LLMClient, Message, SystemPart } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Ref, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { PROMPT_TITLE } from "../plugin/agent"
import { ProviderV2 } from "../provider"
import { SessionMessage } from "./message"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionStore } from "./store"

/** The task section of `PROMPT_TITLE` (packages/core/src/plugin/agent.ts), extracted so settings can display it. */
export const DEFAULT_TITLE_PROMPT = `Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations`

export const MAX_TITLE_LENGTH = 60
export const MAX_TITLE_CONTEXT_CHARS = 8_000

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
 * code fences, inline quotes, and blockquote markers; keeps the first non-empty
 * line; caps at {@link MAX_TITLE_LENGTH} (58 + ellipsis). Returns `undefined`
 * when nothing usable remains — treated as failure, never written.
 */
export function sanitizeTitle(raw: string): string | undefined {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`/g, "")
    .replace(/^\s*>\s?/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (cleaned === undefined) return undefined
  if (cleaned.length > MAX_TITLE_LENGTH) return cleaned.slice(0, MAX_TITLE_LENGTH - 2) + "…"
  return cleaned
}

const renderBlock = (message: SessionMessage.Message): string | undefined => {
  switch (message.type) {
    case "user":
      return `<user>\n${message.text}\n</user>`
    case "assistant": {
      const text = message.content
        .filter((content): content is SessionMessage.AssistantText => content.type === "text")
        .map((content) => content.text)
        .join("\n")
      return text.length > 0 ? `<assistant>\n${text}\n</assistant>` : undefined
    }
    case "shell":
      return message.output.length > 0 ? `<shell>\n${message.output}\n</shell>` : undefined
    default:
      return undefined
  }
}

/**
 * Builds the title-generation conversation block. Walks messages newest-first
 * and stops near {@link MAX_TITLE_CONTEXT_CHARS}; if that truncation dropped
 * the first real user message, it is pinned at the front so the model always
 * sees the opening intent.
 */
export function assembleContext(messages: readonly SessionMessage.Message[]): string {
  let oldestUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user") oldestUser = i
  }
  const blocks: string[] = []
  let chars = 0
  let pinned = oldestUser >= 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = renderBlock(messages[i])
    if (block === undefined) continue
    if (chars + block.length > MAX_TITLE_CONTEXT_CHARS) break
    blocks.push(block)
    chars += block.length
    if (i === oldestUser) pinned = false
  }
  blocks.reverse()
  if (pinned && oldestUser >= 0) {
    const firstUser = messages[oldestUser]
    if (firstUser.type === "user") blocks.unshift(`<user>\n${firstUser.text}\n</user>`)
  }
  return blocks.join("\n\n")
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("SessionTitle.UnavailableError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

type PendingEntry = { readonly requestID: string; readonly baselineTitle: string }

export interface Interface {
  /**
   * Generate a title for a session in the background and apply it through the
   * shared race guards. Replaces any pending generation for the session
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
    const db = (yield* Database.Service).db
    const scope = yield* Scope.Scope
    const pending = yield* Ref.make(new Map<SessionSchema.ID, PendingEntry>())

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
      if (model === undefined || !SessionRunnerModel.supported(model)) return undefined
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
      yield* db
        .update(SessionTable)
        .set({ title: input.title, time_updated: DateTime.toEpochMillis(yield* DateTime.now) })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
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
      const messages = input.messages ?? (yield* store.context(session.id))
      // Nothing to title without at least one real user message (edge #5).
      if (messages.filter((message) => message.type === "user").length === 0) return false
      const context = assembleContext(messages)
      const entries = yield* config.entries()
      const configured = Config.latest(entries, "title_prompt")
      const taskPrompt =
        input.prompt !== undefined && input.prompt.trim().length > 0 ? input.prompt : (configured ?? DEFAULT_TITLE_PROMPT)
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
      const request = LLM.request({
        model,
        system: [SystemPart.make(titleAgent?.system ?? PROMPT_TITLE)],
        messages: [
          Message.user(
            `${taskPrompt.replaceAll("{previousTitle}", session.title)}\n\n<conversation>\n${context}\n</conversation>`,
          ),
        ],
      })
      const response = yield* llm.generate(request).pipe(
        Effect.mapError(
          (error) =>
            new UnavailableError({
              sessionID: session.id,
              message: `Title generation failed: ${error.message}`,
            }),
        ),
      )
      const title = sanitizeTitle(response.text)
      if (title === undefined)
        return yield* new UnavailableError({
          sessionID: session.id,
          message: "Title generation produced no usable title",
        })
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
        yield* runGeneration({
          session: input.session,
          requestID,
          baselineTitle: input.session.title,
          prompt: input.prompt,
          model: input.model,
          defaultOnly: false,
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("Failed to regenerate session title", { sessionID: input.session.id, error }),
          ),
          Effect.ensuring(clearPending(input.session.id, requestID)),
          Effect.forkIn(scope, { startImmediately: true }),
        )
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
        yield* runGeneration({
          session,
          requestID,
          baselineTitle: session.title,
          defaultOnly: true,
          messages: input.messages,
        }).pipe(
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
