export * as PromptRevisor from "./prompt-revisor"

import {
  LLM,
  LLMClient,
  LLMResponse,
  Message,
  Tool,
  ToolDefinition,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type Model,
} from "@opencode-ai/llm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "./agent"
import { Catalog } from "./catalog"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { llmClient } from "./effect/app-node-platform"
import { FileSystem } from "./filesystem"
import { Location } from "./location"
import { ModelV2 } from "./model"
import { RelativePath } from "./schema"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { SessionMessage } from "./session/message"
import { SpecialAgentSessionContext } from "./special-agent-session-context"
import { QuestionV2 } from "./question"
import { QuestionTool } from "./tool/question"
import { Reference } from "./reference"
import { SkillV2 } from "./skill"
import {
  boundedMaxTokens,
  collectUntilTerminalTool,
  generateAdaptive,
  repairMissingCompletion,
  retryMaxTokens,
  runTerminalCompletion,
  TRUNCATION_DETAIL,
  terminalCompletionAccepted,
  withSpecialAgentTimeout,
  type TerminalAttempt,
  type TerminalFailure,
} from "./special-agent-completion"
import { type ToolChoiceCapabilityIdentity } from "./tool-choice-compatibility"
import { DEFAULT_PROMPT, PROTOCOL_PROMPT } from "./prompt-revisor-prompt"

export { DEFAULT_PROMPT, PROTOCOL_PROMPT } from "./prompt-revisor-prompt"

const MAX_RECON_ROUNDS = 2
const MAX_CLARIFICATION_ROUNDS = 2
const MAX_QUESTIONS_PER_INTERRUPT = 3
const MAX_OPTIONS_PER_QUESTION = 6
const MAX_CLARIFICATION_ANSWER_CHARS = 500
const MAX_CLARIFICATION_DETAIL_CHARS = 16_384
const READ_BYTES = 24 * 1024
const READ_LINES = 240
const GREP_RESULTS = 30
const GLOB_RESULTS = 50
const MAX_SESSION_CONTEXT_CHARS = 28_000
const MAX_COMPOSER_CONTEXT_RESULTS = 24
const MAX_REVISED_REFERENCES = 24
const MAX_REVISED_PROMPT_CHARS = 64_000
/**
 * Output budget for any round that may commit `revised_prompt`. This has to be
 * large enough for the artifact the host is willing to accept: a 4k-token
 * budget against a 64k-character cap truncated long revisions mid-tool-call,
 * which the terminal protocol then reported as "did not call revised_prompt".
 * Reasoning models spend part of the same budget before emitting any tool call,
 * so the floor is deliberately generous. Runtimes clamp this to the
 * provider/model maximum.
 */
const AUTHORING_MAX_TOKENS = 16_384
/** Ceiling for the truncation-escalated retry budget. */
const AUTHORING_MAX_TOKENS_CEILING = 48_000
const MAX_TERMINAL_REPAIRS = 2

export const ComposerContextKind = Schema.Literals(["agent", "skill", "reference", "resource"])
export type ComposerContextKind = typeof ComposerContextKind.Type

export const PromptSelection = Schema.Struct({
  startLine: Schema.Number,
  startChar: Schema.Number,
  endLine: Schema.Number,
  endChar: Schema.Number,
})
export type PromptSelection = typeof PromptSelection.Type

export const DraftMention = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("file"),
    token: Schema.String,
    path: Schema.String,
    selection: Schema.optional(PromptSelection),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("agent"), token: Schema.String, name: Schema.String }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("skill"), token: Schema.String, name: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("reference"),
    token: Schema.String,
    name: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("resource"),
    token: Schema.String,
    name: Schema.String,
    clientName: Schema.String,
    uri: Schema.String,
  }),
])
export type DraftMention = typeof DraftMention.Type

export const DraftAttachment = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("image"),
  filename: Schema.String,
  mime: Schema.String,
})
export type DraftAttachment = typeof DraftAttachment.Type

export const DraftContext = Schema.Struct({
  mentions: Schema.Array(DraftMention),
  attachments: Schema.Array(DraftAttachment),
})
export type DraftContext = typeof DraftContext.Type

export const RevisedPromptReferenceInput = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("file"),
    path: RelativePath,
    selection: Schema.optional(PromptSelection),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("agent"), name: Schema.String }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("skill"), name: Schema.String }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("reference"), name: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("resource"),
    name: Schema.String,
    clientName: Schema.String,
    uri: Schema.String,
  }),
])
export type RevisedPromptReferenceInput = typeof RevisedPromptReferenceInput.Type

export const RevisedPromptToolInput = Schema.Struct({
  content: Schema.String,
  references: Schema.Array(RevisedPromptReferenceInput),
})
export type RevisedPromptToolInput = typeof RevisedPromptToolInput.Type

export const RevisedPromptReference = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    content: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
    path: Schema.String,
    selection: Schema.optional(PromptSelection),
  }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    content: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
    name: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("skill"),
    content: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
    name: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("reference"),
    content: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
    name: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    content: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
    name: Schema.String,
    clientName: Schema.String,
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
  }),
])
export type RevisedPromptReference = typeof RevisedPromptReference.Type
type WithoutReferencePosition<T> = T extends unknown ? Omit<T, "content" | "start" | "end"> : never
type RevisedPromptReferenceMetadata = WithoutReferencePosition<RevisedPromptReference>

export const ComposerContextItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent"),
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("reference"),
    name: Schema.String,
    path: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("resource"),
    name: Schema.String,
    clientName: Schema.String,
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
])
export type ComposerContextItem = typeof ComposerContextItem.Type

export interface Clarification {
  readonly question: string
  readonly answers: readonly string[]
  readonly detail?: string
}

export interface Input {
  readonly prompt: string
  /** Sanitized semantic snapshot of rich Prompt Input V2 state. */
  readonly draft?: DraftContext
  /** Existing session whose recent conversation may help resolve references in the draft. */
  readonly sessionID?: SessionSchema.ID
  /** Optional user-supplied reason or direction for this particular rewrite. */
  readonly guidance?: string
  /** Dedicated revisor model selected by the user. */
  readonly model?: ModelV2.Ref
  /** Composer/session model to use when no dedicated revisor model is configured. */
  readonly fallbackModel?: ModelV2.Ref
  /** Answers collected from prior question interrupts in this same revision flow. */
  readonly clarifications?: readonly Clarification[]
  /** Number of question interrupts already completed for this revision flow. */
  readonly clarificationRound?: number
}

export interface RevisionResult {
  readonly type: "revision"
  readonly prompt: string
  readonly references: readonly RevisedPromptReference[]
  readonly tools: readonly string[]
  readonly rounds: number
}

export interface QuestionResult {
  readonly type: "question"
  readonly questions: readonly QuestionV2.Prompt[]
  readonly clarificationRound: number
  readonly tools: readonly string[]
  readonly rounds: number
}

export type Result = RevisionResult | QuestionResult

/**
 * Opaque model resolved by the runtime that actually executes prompt revision.
 * Core never inspects `value`; this lets the OpenCode server use its production
 * Provider.Model while the standalone core layer can continue using
 * @opencode-ai/llm Model.
 */
export interface ResolvedModel {
  readonly ref: ModelV2.Ref
  readonly value: unknown
}

export interface RuntimeGenerateInput {
  readonly model: ResolvedModel
  readonly sessionID?: SessionSchema.ID
  readonly system: string
  readonly messages: readonly Message[]
  readonly tools: readonly ToolDefinition[]
  readonly toolChoice: "auto" | "required" | "none"
  readonly generation: {
    readonly maxTokens?: number
    readonly temperature?: number
  }
}

export interface Runtime {
  readonly resolveModel: (input: {
    readonly candidates: readonly ModelV2.Ref[]
  }) => Effect.Effect<ResolvedModel, UnavailableError>
  readonly generate: (input: RuntimeGenerateInput) => Effect.Effect<LLMResponse, UnavailableError>
  /** Optional host-only entities not represented by core services (for example MCP resources). */
  readonly composerContext?: (input: {
    readonly query: string
    readonly kinds: readonly ComposerContextKind[]
    readonly limit: number
  }) => Effect.Effect<readonly ComposerContextItem[], UnavailableError>
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("PromptRevisor.UnavailableError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly revise: (input: Input) => Effect.Effect<Result, UnavailableError>
  /** Server/runtime override for using the host application's canonical provider stack. */
  readonly reviseWithRuntime: (input: Input, runtime: Runtime) => Effect.Effect<Result, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PromptRevisor") {}

export function assembleSessionContext(messages: readonly SessionMessage.Message[]) {
  return SpecialAgentSessionContext.assemble(messages, {
    maxChars: MAX_SESSION_CONTEXT_CHARS,
    maxBlockChars: 10_000,
    includeShell: true,
    pinOpeningUser: true,
    pinLatestCompaction: true,
  })
}

const sensitivePath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").toLowerCase()
  const name = normalized.split("/").at(-1) ?? normalized
  if (name === ".env.example" || name === ".env.sample") return false
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name.endsWith(".pem") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    normalized.includes("/.git/")
  )
}

const toolFailure = (message: string) => new ToolFailure({ message })

const lineSlice = (value: string) => {
  const lines = value.split(/\r?\n/)
  const selected = lines.slice(0, READ_LINES).join("\n")
  const encoded = new TextEncoder().encode(selected)
  if (encoded.byteLength <= READ_BYTES) return selected
  return new TextDecoder().decode(encoded.slice(0, READ_BYTES)) + "\n[truncated]"
}

const sanitize = (value: string) => {
  let result = value.trim()
  // Some reasoning-capable providers have historically leaked hidden-thinking
  // wrappers into ordinary text. These are never part of the revisor contract.
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  result = result.replace(/^\s*(?:revised|enhanced|improved) prompt\s*:\s*/i, "").trim()
  const fenced = result.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/i)
  if (fenced?.[1]) result = fenced[1].trim()
  return result
}

export const sanitizeQuestion = (question: QuestionV2.Prompt): QuestionV2.Prompt => {
  const labels = new Set<string>()
  const options = question.options
    .map((option) => ({
      label: option.label.trim().slice(0, 80),
      description: option.description.trim().slice(0, 240),
    }))
    .filter((option) => {
      if (!option.label || labels.has(option.label)) return false
      labels.add(option.label)
      return true
    })
    .slice(0, MAX_OPTIONS_PER_QUESTION)
  return {
    question: question.question.trim().slice(0, 500),
    header: question.header.trim().slice(0, 30),
    options,
    multiple: question.multiple,
    custom: options.length === 0 ? true : question.custom,
  }
}

export const normalizeClarificationRound = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

export const normalizeClarifications = (input: readonly Clarification[] | undefined) =>
  (input ?? []).slice(0, MAX_CLARIFICATION_ROUNDS * MAX_QUESTIONS_PER_INTERRUPT).map((item) => ({
    question: item.question.trim().slice(0, 500),
    answers: item.answers
      .map((answer) => answer.trim().slice(0, MAX_CLARIFICATION_ANSWER_CHARS))
      .filter((answer, index, answers) => answer.length > 0 && answers.indexOf(answer) === index)
      .slice(0, MAX_OPTIONS_PER_QUESTION),
    ...(item.detail?.trim() ? { detail: item.detail.trim().slice(0, MAX_CLARIFICATION_DETAIL_CHARS) } : {}),
  }))

const boundedString = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "")

/**
 * Reference/catalog data can originate from older config/plugin state that did
 * not pass through today's Effect schemas. Never coerce nullable paths with
 * String(value): String(null) === "null" is a syntactically valid relative path
 * and can otherwise escape all the way into FileSystem.stat().
 */
const usablePath = (value: unknown, max = 4_000) => {
  const path = boundedString(value, max)
  if (!path) return undefined
  const sentinel = path.toLowerCase()
  if (sentinel === "null" || sentinel === "undefined") return undefined
  return path
}

const normalizeDraftContext = (input: DraftContext | undefined): DraftContext => ({
  mentions: (input?.mentions ?? []).slice(0, 64).flatMap((item): DraftMention[] => {
    if (item.type === "file") {
      const path = usablePath((item as { path?: unknown }).path, 2_000)
      if (!path) return []
      return [
        {
          ...item,
          id: boundedString(item.id, 80),
          token: boundedString(item.token, 240),
          path,
        },
      ]
    }
    if (item.type === "resource") {
      return [
        {
          ...item,
          id: boundedString(item.id, 80),
          token: boundedString(item.token, 240),
          name: boundedString(item.name, 240),
          clientName: boundedString(item.clientName, 240),
          uri: boundedString(item.uri, 4_000),
        },
      ]
    }
    if (item.type === "reference") {
      const path = usablePath((item as { path?: unknown }).path, 2_000)
      if (!path) return []
      return [
        {
          ...item,
          id: boundedString(item.id, 80),
          token: boundedString(item.token, 240),
          name: boundedString(item.name, 240),
          path,
        },
      ]
    }
    return [
      {
        ...item,
        id: boundedString(item.id, 80),
        token: boundedString(item.token, 240),
        name: boundedString(item.name, 240),
      },
    ]
  }),
  attachments: (input?.attachments ?? []).slice(0, 24).map((item) => ({
    ...item,
    id: boundedString(item.id, 120),
    filename: boundedString(item.filename, 500),
    mime: boundedString(item.mime, 200),
  })),
})

const contextScore = (item: ComposerContextItem, query: string) => {
  if (!query) return 1
  const haystack = [
    item.name,
    "description" in item ? item.description : undefined,
    item.kind === "reference" ? item.path : undefined,
    item.kind === "resource" ? item.uri : undefined,
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase()
  if (item.name.toLowerCase() === query) return 100
  if (item.name.toLowerCase().startsWith(query)) return 50
  if (haystack.includes(query)) return 10
  return 0
}

const referencePlaceholder = (id: string) => `{{ref:${id}}}`

/** Every `{{ref:id}}` occurrence in a revised prompt, declared or not. */
const REFERENCE_PLACEHOLDER_PATTERN = /\{\{ref:([^}]{1,120})\}\}/g

/**
 * How one placeholder is materialized: as a canonical composer mention, or as
 * degraded plain text (possibly empty) when the host could not resolve the
 * declaration the model wrote.
 */
type ReferenceResolution =
  | { readonly kind: "rich"; readonly token: string; readonly metadata: RevisedPromptReferenceMetadata }
  | { readonly kind: "text"; readonly text: string }

const cleanReferenceID = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const skills = yield* SkillV2.Service
    const references = yield* Reference.Service
    const files = yield* FileSystem.Service
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const models = yield* SessionRunnerModel.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service

    const reconTools = {
      read: Tool.make({
        description:
          "Read a text file inside the current project. Use this only to verify codebase facts that improve the prompt rewrite.",
        parameters: Schema.Struct({ path: RelativePath }),
        success: Schema.String,
        execute: ({ path }) =>
          Effect.gen(function* () {
            const rawPath = usablePath(path, 2_000)
            if (!rawPath) return yield* toolFailure("Prompt revision received an invalid file path")
            const safePath = RelativePath.make(rawPath)
            if (sensitivePath(safePath))
              return yield* toolFailure("Sensitive files are not available to prompt revision")
            // FileSystem.read has a `never` error channel: a missing path, a
            // directory, and a path that escapes the location are all defects.
            // Only a Cause-level catch turns them into a tool error the Revisor
            // can react to - mapError here would let them kill the request.
            const result = yield* files
              .read({ path: safePath })
              .pipe(Effect.catchDefect(() => Effect.fail(toolFailure(`Unable to read ${safePath}`))))
            if (result.content.includes(0))
              return yield* toolFailure("Binary files are not available to prompt revision")
            return lineSlice(new TextDecoder().decode(result.content))
          }),
      }),
      grep: Tool.make({
        description:
          "Search project file contents with a regex. Use focused patterns to locate symbols, components, settings, or APIs relevant to the draft.",
        parameters: Schema.Struct({
          pattern: Schema.String,
          path: Schema.optional(RelativePath),
          include: Schema.optional(Schema.String),
        }),
        success: Schema.String,
        execute: ({ pattern, path, include }) =>
          Effect.gen(function* () {
            const safePath = path === undefined ? undefined : usablePath(path, 2_000)
            if (path !== undefined && !safePath)
              return yield* toolFailure("Prompt revision received an invalid search path")
            return yield* files
              .grep(
                new FileSystem.GrepInput({
                  pattern,
                  path: safePath === undefined ? undefined : RelativePath.make(safePath),
                  include,
                  limit: GREP_RESULTS,
                }),
              )
              .pipe(
                Effect.map((matches) =>
                  matches.length === 0
                    ? "No matches found"
                    : matches.map((match) => `${match.entry.path}:${match.line}: ${match.text.trimEnd()}`).join("\n"),
                ),
                Effect.catchDefect(() => Effect.fail(toolFailure("Search failed"))),
              )
          }),
      }),
      glob: Tool.make({
        description:
          "Find project files by glob pattern. Use this to verify likely paths before reading or referencing them in the revised prompt.",
        parameters: Schema.Struct({ pattern: Schema.String, path: Schema.optional(RelativePath) }),
        success: Schema.String,
        execute: ({ pattern, path }) =>
          Effect.gen(function* () {
            const safePath = path === undefined ? undefined : usablePath(path, 2_000)
            if (path !== undefined && !safePath)
              return yield* toolFailure("Prompt revision received an invalid glob path")
            return yield* files
              .glob(
                new FileSystem.GlobInput({
                  pattern,
                  path: safePath === undefined ? undefined : RelativePath.make(safePath),
                  limit: GLOB_RESULTS,
                }),
              )
              .pipe(
                Effect.map((entries) =>
                  entries.length === 0 ? "No files found" : entries.map((entry) => entry.path).join("\n"),
                ),
                Effect.catchDefect(() => Effect.fail(toolFailure("Glob failed"))),
              )
          }),
      }),
    } as const

    // Reuse the normal question tool's model-facing contract, but deliberately
    // do not execute QuestionV2.ask(). Prompt revision also runs before a real
    // session exists, so questions are returned as an HTTP interrupt and the
    // composer resumes with the answers on a subsequent stateless request.
    const questionTool = Tool.make({
      description: `${QuestionTool.description}\n\nPrompt revisor rule: only ask when the answer would materially change the rewrite. Use this as the only tool call in the response.`,
      parameters: QuestionTool.Input,
      success: Schema.Struct({}),
    })

    const revisedPromptTool = Tool.make({
      description:
        "Commit the finished Prompt Input V2 revision. This is the only valid successful completion. Put the user-facing draft in content. For rich mentions, place {{ref:ID}} in content and declare the matching semantic reference. Do not calculate offsets or fabricate editor metadata. Call exactly once and as the only tool call when the rewrite is ready. IMMEDIATELY END GENERATION after this tool call; do not reason, emit prose, or call another tool afterward.",
      parameters: RevisedPromptToolInput,
      success: Schema.String,
      execute: () => Effect.succeed(terminalCompletionAccepted("revised_prompt")),
    })

    const defaultRuntime: Runtime = {
      resolveModel: Effect.fn("PromptRevisor.defaultRuntime.resolveModel")(function* ({ candidates }) {
        const seen = new Set<string>()
        for (const candidate of candidates) {
          const key = `${candidate.providerID}/${candidate.id}/${candidate.variant ?? ""}`
          if (seen.has(key)) continue
          seen.add(key)
          const resolved = yield* models.resolveRef(candidate).pipe(Effect.option)
          if (resolved._tag === "Some") return { ref: candidate, value: resolved.value }
        }
        const fallback = yield* catalog.model.default()
        if (fallback) {
          const ref = ModelV2.Ref.make({ providerID: fallback.providerID, id: fallback.id })
          const resolved = yield* models.resolveRef(ref).pipe(Effect.option)
          if (resolved._tag === "Some") return { ref, value: resolved.value }
        }
        return yield* new UnavailableError({ message: "No model is available for prompt revision" })
      }),
      generate: Effect.fn("PromptRevisor.defaultRuntime.generate")(function* (request) {
        const model = request.model.value as Model
        // Providers reject a max-token request above the model ceiling, so the
        // caller's generous authoring budget is a request, not a demand.
        const maxTokens =
          request.generation.maxTokens === undefined
            ? undefined
            : boundedMaxTokens(model, request.generation.maxTokens)
        const base = LLM.request({
          model,
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          toolChoice: request.toolChoice,
          generation: { ...request.generation, ...(maxTokens === undefined ? {} : { maxTokens }) },
        })
        const run = (toolChoice: "required" | "auto" | "none") =>
          collectUntilTerminalTool(llm.stream(LLM.updateRequest(base, { toolChoice })), "revised_prompt").pipe(
            Effect.flatMap((response) =>
              response
                ? Effect.succeed(response)
                : Effect.fail(new Error("Prompt revision ended without a terminal response")),
            ),
          )

        if (request.toolChoice === "none") {
          return yield* run("none").pipe(
            Effect.mapError((error) => new UnavailableError({ message: `Prompt revision failed: ${error.message}` })),
          )
        }

        const capability: ToolChoiceCapabilityIdentity = {
          providerID: String(model.provider),
          modelID: String(model.id),
          apiURL: model.route.endpoint.baseURL,
          routeID: model.route.id,
          routeProtocol: String(model.route.protocol),
        }
        return yield* generateAdaptive({
          identity: capability,
          requested: request.toolChoice,
          generate: (toolChoice) => run(toolChoice),
        }).pipe(
          Effect.map((generated) => generated.response),
          Effect.mapError((error) => new UnavailableError({ message: `Prompt revision failed: ${error.message}` })),
        )
      }),
    }

    const reviseWithRuntime: Interface["reviseWithRuntime"] = Effect.fn("PromptRevisor.reviseWithRuntime")(function* (
      input: Input,
      runtime: Runtime,
    ) {
      const original = input.prompt.trim()
      if (!original) return yield* new UnavailableError({ message: "Prompt is empty" })
      const session = input.sessionID ? yield* sessions.get(input.sessionID) : undefined
      if (input.sessionID && !session) {
        return yield* new UnavailableError({ message: `Session not found: ${input.sessionID}` })
      }
      if (session && session.location.directory !== location.directory) {
        return yield* new UnavailableError({ message: "Session does not belong to the selected project location" })
      }
      // Draft-mode revisions still need one stable host session identity across
      // reconnaissance and protocol-correction retries. This ID is ephemeral and
      // is never persisted as a real Session; it only scopes provider/plugin telemetry.
      const runtimeSessionID = session?.id ?? SessionSchema.ID.create()
      // Conversation context sharpens a revision but is not required for one.
      // A store hiccup should degrade to a context-free rewrite rather than
      // refusing to revise the draft the user is looking at.
      const loadedContext = session
        ? yield* sessions.context(session.id).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("prompt revision continuing without session context", {
                sessionID: session.id,
                error: error.message,
              }),
            ),
            Effect.option,
          )
        : undefined
      const sessionContext =
        loadedContext && loadedContext._tag === "Some" ? assembleSessionContext(loadedContext.value) : ""
      const agent = yield* agents.get(AgentV2.ID.make("prompt-revisor"))
      const candidates = [input.model, agent?.model, input.fallbackModel, session?.model].filter(
        (item): item is ModelV2.Ref => item !== undefined,
      )
      const model = yield* runtime.resolveModel({ candidates })
      const entries = yield* config.entries()
      const policy = Config.latest(entries, "prompt_revisor_prompt")?.trim() || agent?.system || DEFAULT_PROMPT
      const system = `${policy}\n\n${PROTOCOL_PROMPT}`
      const currentClarificationRound = normalizeClarificationRound(input.clarificationRound)
      const canAsk = currentClarificationRound < MAX_CLARIFICATION_ROUNDS
      const clarifications = normalizeClarifications(input.clarifications)
      const draftContext = normalizeDraftContext(input.draft)

      const lookupComposerContext = Effect.fn("PromptRevisor.lookupComposerContext")(function* (request: {
        query: string
        kinds: readonly ComposerContextKind[]
        limit: number
      }) {
        const query = request.query.trim().toLowerCase().slice(0, 240)
        const kinds = new Set(request.kinds)
        const local: ComposerContextItem[] = []
        if (kinds.has("agent")) {
          for (const item of yield* agents.all()) {
            if (item.hidden || item.mode === "primary") continue
            local.push({
              kind: "agent",
              name: String(item.id),
              ...(item.description ? { description: item.description } : {}),
            })
          }
        }
        if (kinds.has("skill")) {
          for (const item of yield* skills.list()) {
            local.push({
              kind: "skill",
              name: item.name,
              ...(item.description ? { description: item.description } : {}),
            })
          }
        }
        if (kinds.has("reference")) {
          for (const item of yield* references.list()) {
            if (item.hidden) continue
            const path = usablePath((item as { path?: unknown }).path)
            if (!path) {
              yield* Effect.logWarning("Prompt Revisor skipped project reference with unusable path", {
                name: item.name,
              })
              continue
            }
            local.push({
              kind: "reference",
              name: item.name,
              path,
              ...(item.description ? { description: item.description } : {}),
            })
          }
        }
        const hosted = runtime.composerContext
          ? yield* runtime.composerContext({ query, kinds: [...kinds], limit: request.limit })
          : []
        const seen = new Set<string>()
        return [...local, ...hosted]
          .map((item) => ({ item, score: contextScore(item, query) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
          .flatMap(({ item }) => {
            const key =
              item.kind === "resource"
                ? `${item.kind}:${item.clientName}:${item.uri}`
                : item.kind === "reference"
                  ? `${item.kind}:${item.name}:${item.path}`
                  : `${item.kind}:${item.name}`
            if (seen.has(key)) return []
            seen.add(key)
            return [item]
          })
          .slice(0, Math.max(1, Math.min(MAX_COMPOSER_CONTEXT_RESULTS, request.limit)))
      })

      const composerContextTool = Tool.make({
        description:
          "Search entities that can be inserted as rich Prompt Input V2 mentions. Use this when a revised prompt would benefit from a known agent, skill, project reference, or connected resource. Results are bounded and only include entities actually available to the composer.",
        parameters: Schema.Struct({
          query: Schema.String,
          kinds: Schema.Array(ComposerContextKind),
          limit: Schema.optional(Schema.Number),
        }),
        success: Schema.String,
        execute: ({ query, kinds, limit }) =>
          lookupComposerContext({
            query,
            kinds: kinds.length ? kinds : (["agent", "skill", "reference", "resource"] as const),
            limit: limit ?? 12,
          }).pipe(
            Effect.map((items) => JSON.stringify(items)),
            Effect.mapError((error) => toolFailure(error.message)),
            Effect.catchDefect(() => Effect.fail(toolFailure("Composer context lookup failed"))),
          ),
      })

      /**
       * Terminal payload validation with reference auto-healing.
       *
       * The user-visible artifact is `content`. Rich-reference declarations are
       * auxiliary metadata the model reconstructs from memory, and it gets them
       * wrong in predictable ways: a missing `path`, a duplicate id, a file that
       * no longer exists, a placeholder it never declared.
       *
       * While a corrective retry is still available, those problems are reported
       * so the model gets the chance to declare the reference properly - a real
       * composer mention is better than a degraded one. On the final attempt the
       * host heals instead of failing: the declaration becomes the plain `@token`
       * text when one can be recovered and its placeholder is dropped when it
       * cannot, because a revision with an imperfect mention beats a 503 that
       * discards a finished rewrite. Problems with `content` itself - absent,
       * empty, or oversized - always fail; there is nothing to hand back.
       */
      const validateTerminal = Effect.fn("PromptRevisor.validateTerminal")(function* (raw: unknown, heal = true) {
        const record =
          raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
        if (!record || typeof record["content"] !== "string")
          return yield* new UnavailableError({
            message: "Prompt revisor produced invalid revised_prompt: content must be a string",
          })
        const content = record["content"].trim()
        if (!content) return yield* new UnavailableError({ message: "Prompt revisor produced an empty revised_prompt" })
        if (content.length > MAX_REVISED_PROMPT_CHARS)
          return yield* new UnavailableError({ message: "Prompt revisor produced an oversized revised_prompt" })

        const healed: string[] = []
        /**
         * Reference-level problems are only tolerated on the final attempt. Any
         * earlier attempt reports them so the model can declare the reference
         * correctly on its corrective turn.
         */
        const reject = (reason: string) =>
          new UnavailableError({ message: `Prompt revisor produced an invalid revised_prompt: ${reason}` })
        const note = (reason: string) =>
          heal ? Effect.sync(() => healed.push(reason)) : Effect.fail(reject(reason))
        /** Best-effort plain-text token for a declaration the host cannot resolve. */
        const fallbackText = (entry: unknown) => {
          if (!entry || typeof entry !== "object") return undefined
          const fields = entry as Record<string, unknown>
          const path = usablePath(fields["path"], 2_000)
          // A sensitive path is never re-emitted, not even as plain text.
          if (path) return sensitivePath(path) ? undefined : `@${path}`
          const name = boundedString(fields["name"], 200)
          return name ? `@${name}` : undefined
        }
        const degrade = (entry: unknown, reason: string) =>
          Effect.gen(function* () {
            if (!heal) return yield* reject(reason)
            const text = fallbackText(entry)
            healed.push(text ? `${reason}; kept as plain text ${text}` : `${reason}; placeholder removed`)
            return { kind: "text", text: text ?? "" } satisfies ReferenceResolution
          })

        // Placeholder occurrences are collected from the content first: the
        // content is authoritative about which references are actually used, and
        // one pass over it keeps rich-reference offsets correct no matter how
        // many declarations heal into plain text or disappear.
        const occurrences: Array<{ id: string; index: number; length: number }> = []
        for (const match of content.matchAll(REFERENCE_PLACEHOLDER_PATTERN)) {
          if (match.index === undefined) continue
          occurrences.push({ id: match[1]!, index: match.index, length: match[0]!.length })
        }
        const referenced = new Set(occurrences.map((occurrence) => occurrence.id))

        const entries = Array.isArray(record["references"]) ? record["references"] : []
        if (record["references"] !== undefined && !Array.isArray(record["references"]))
          yield* note("references must be an array")

        const resolutions = new Map<string, ReferenceResolution>()
        let richCount = 0
        for (const entry of entries) {
          const id =
            entry && typeof entry === "object"
              ? boundedString((entry as Record<string, unknown>)["id"], 120)
              : undefined
          if (!id) {
            yield* note("a reference declaration has no usable id")
            continue
          }
          // Models sometimes declare a reference they ultimately decide not to
          // use. The content is authoritative, so an unused declaration is
          // harmless and should not burn a repair retry or fail the revision.
          if (!referenced.has(id)) continue
          if (resolutions.has(id)) {
            yield* note(`a duplicate reference declaration: ${id}`)
            continue
          }
          if (cleanReferenceID(id) !== id) {
            resolutions.set(id, yield* degrade(entry, `an invalid reference id: ${id}`))
            continue
          }
          if (richCount >= MAX_REVISED_REFERENCES) {
            resolutions.set(id, yield* degrade(entry, `more than ${MAX_REVISED_REFERENCES} rich references`))
            continue
          }

          const decoded = yield* Schema.decodeUnknownEffect(RevisedPromptReferenceInput)(entry).pipe(Effect.option)
          if (decoded._tag === "None") {
            resolutions.set(id, yield* degrade(entry, `a malformed ${id} reference declaration`))
            continue
          }
          const source = decoded.value

          if (source.type === "file") {
            const rawPath = usablePath(source.path, 2_000)
            if (!rawPath) {
              resolutions.set(id, yield* degrade(entry, `an invalid file reference path: ${source.path}`))
              continue
            }
            const path = RelativePath.make(rawPath)
            if (sensitivePath(path)) {
              // Healing never re-emits the path, so this one is dropped outright
              // rather than degraded to text.
              yield* note(`a sensitive path reference: ${path}`)
              resolutions.set(id, { kind: "text", text: "" })
              continue
            }
            // Missing paths, directories, and location escapes all arrive as
            // defects from FileSystem.read, so this probe catches the Cause.
            const readable = yield* files.read({ path }).pipe(
              Effect.as(true),
              Effect.catchDefect(() => Effect.succeed(false)),
            )
            if (!readable) {
              resolutions.set(id, yield* degrade(entry, `an unavailable file reference: ${path}`))
              continue
            }
            richCount += 1
            resolutions.set(id, {
              kind: "rich",
              token: `@${path}`,
              metadata: {
                type: "file",
                path,
                ...(source.selection ? { selection: source.selection } : {}),
              },
            })
            continue
          }

          const candidates = yield* lookupComposerContext({ query: source.name, kinds: [source.type], limit: 24 })
          if (source.type === "resource") {
            const match = candidates.find(
              (item): item is Extract<ComposerContextItem, { kind: "resource" }> =>
                item.kind === "resource" && item.clientName === source.clientName && item.uri === source.uri,
            )
            if (!match) {
              resolutions.set(
                id,
                yield* degrade(entry, `an unavailable resource reference: ${source.clientName}/${source.uri}`),
              )
              continue
            }
            richCount += 1
            resolutions.set(id, {
              kind: "rich",
              token: `@${match.name}`,
              metadata: {
                type: "resource",
                name: match.name,
                clientName: match.clientName,
                uri: match.uri,
                ...(match.mimeType ? { mimeType: match.mimeType } : {}),
              },
            })
            continue
          }

          const match = candidates.find((item) => item.kind === source.type && item.name === source.name)
          if (!match || match.kind !== source.type) {
            resolutions.set(id, yield* degrade(entry, `an unavailable ${source.type} reference: ${source.name}`))
            continue
          }
          richCount += 1
          resolutions.set(id, {
            kind: "rich",
            token: `@${match.name}`,
            metadata:
              match.kind === "reference"
                ? { type: "reference", name: match.name, path: match.path }
                : match.kind === "agent"
                  ? { type: "agent", name: match.name }
                  : { type: "skill", name: match.name },
          })
        }

        let cursor = 0
        let prompt = ""
        const rich: RevisedPromptReference[] = []
        for (const occurrence of occurrences) {
          prompt += content.slice(cursor, occurrence.index)
          cursor = occurrence.index + occurrence.length
          const resolution = resolutions.get(occurrence.id)
          if (!resolution) yield* note(`an undeclared reference placeholder: ${occurrence.id}`)
          if (resolution?.kind === "rich") {
            const start = prompt.length
            prompt += resolution.token
            rich.push({
              ...resolution.metadata,
              content: resolution.token,
              start,
              end: prompt.length,
            } as RevisedPromptReference)
            continue
          }
          const text = resolution?.text ?? ""
          // Dropping a placeholder outright would otherwise leave a double space
          // where the mention used to sit.
          if (!text && prompt.endsWith(" ") && content[cursor] === " ") cursor += 1
          prompt += text
        }
        // Only the tail is trimmed: trimming the front would shift every
        // rich-reference offset already recorded above.
        prompt = (prompt + content.slice(cursor)).trimEnd()
        if (!prompt.trim())
          return yield* new UnavailableError({ message: "Prompt revisor produced an empty revised_prompt" })
        if (healed.length)
          yield* Effect.logWarning("prompt revision healed model reference declarations", { healed })
        return { prompt, references: rich }
      })

      // One place that turns a terminal-protocol failure into something a user
      // can act on. Truncation and budget exhaustion are host problems and must
      // not be reported as the model refusing to call the tool.
      const terminalFailureMessage = (failure: TerminalFailure) =>
        failure.reason === "truncated"
          ? "The prompt revisor's response hit the model output limit before it could commit the revision. Try again, shorten the draft, or pick a model with a larger output limit."
          : failure.reason === "invalid-payload"
            ? `Prompt revisor produced invalid revised_prompt after ${failure.repairs + 1} attempts: ${failure.detail ?? "invalid payload"}`
            : failure.reason === "multiple"
              ? "Prompt revisor emitted multiple revised_prompt calls in one round"
              : failure.reason === "missing"
                ? `Prompt revisor did not call revised_prompt after ${failure.repairs + 1} attempts`
                : "revised_prompt must be the only content-producing action in its response"

      const authoringGeneration = (attempt?: TerminalAttempt) => ({
        maxTokens: retryMaxTokens(AUTHORING_MAX_TOKENS, attempt, AUTHORING_MAX_TOKENS_CEILING),
        temperature: 0.2,
      })

      const user = [
        sessionContext
          ? `<conversation-context>\n${sessionContext}\n</conversation-context>\n<context-resolution-rule>Resolve contextual references in the current draft from this conversation before rewriting. Phrases such as "it", "this", "that", "the feature", "the issue", "continue", "proceed", "the approach above", and similar shorthand should become concrete in the revised prompt whenever the conversation supplies enough information. Prefer carrying the actual feature name, decisions, constraints, files, architecture, and acceptance criteria into revised_prompt. Do not emit vague meta-instructions like "use the existing chat context" when you can resolve the referent yourself.</context-resolution-rule>`
          : undefined,
        input.guidance?.trim() ? `<rewrite-guidance>\n${input.guidance.trim()}\n</rewrite-guidance>` : undefined,
        clarifications.length
          ? `<user-clarifications>\n${JSON.stringify(clarifications)}\n</user-clarifications>`
          : undefined,
        draftContext.mentions.length || draftContext.attachments.length
          ? `<existing-prompt-context>\n${JSON.stringify(draftContext)}\n</existing-prompt-context>`
          : undefined,
        `<draft>\n${original}\n</draft>`,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n")
      const messages = [Message.user(user)]
      const usedTools: string[] = []
      let rounds = 0

      while (rounds <= MAX_RECON_ROUNDS) {
        const finalRound = rounds === MAX_RECON_ROUNDS
        const authoringTools = canAsk
          ? {
              ...reconTools,
              composer_context: composerContextTool,
              question: questionTool,
              revised_prompt: revisedPromptTool,
            }
          : { ...reconTools, composer_context: composerContextTool, revised_prompt: revisedPromptTool }
        if (finalRound) {
          const terminal = yield* runTerminalCompletion({
            messages,
            toolName: "revised_prompt",
            agentLabel: "prompt revisor",
            maxRepairs: MAX_TERMINAL_REPAIRS,
            generate: (terminalMessages, attempt) =>
              runtime.generate({
                model,
                sessionID: runtimeSessionID,
                system,
                messages: terminalMessages,
                tools: toDefinitions({ revised_prompt: revisedPromptTool }),
                toolChoice: "required",
                generation: authoringGeneration(attempt),
              }),
            validate: (call, context) =>
              validateTerminal(call.input, context.final).pipe(Effect.mapError((error) => error.message)),
            invalid: (failure) => new UnavailableError({ message: terminalFailureMessage(failure) }),
          })
          const revised = terminal.artifact
          usedTools.push("revised_prompt")
          return {
            type: "revision",
            prompt: revised.prompt,
            references: revised.references,
            tools: usedTools,
            rounds: rounds + 1 + terminal.repairs,
          } satisfies RevisionResult
        }

        // Reconnaissance rounds may also commit revised_prompt, so they get the
        // same authoring budget rather than a tool-call-sized one.
        const response = yield* runtime.generate({
          model,
          sessionID: runtimeSessionID,
          system,
          messages,
          tools: toDefinitions(authoringTools),
          toolChoice: "required",
          generation: authoringGeneration(),
        })

        const calls = response.toolCalls.filter((call) => call.providerExecuted !== true)
        const repairTerminal = Effect.fn("PromptRevisor.repairTerminal")(function* (detail?: string) {
          const terminal = yield* repairMissingCompletion({
            messages,
            response,
            toolName: "revised_prompt",
            agentLabel: "Prompt Revisor",
            detail: detail ?? (response.finishReason === "length" ? TRUNCATION_DETAIL : undefined),
            maxRepairs: MAX_TERMINAL_REPAIRS,
            generate: (terminalMessages, attempt) =>
              runtime.generate({
                model,
                sessionID: runtimeSessionID,
                system,
                messages: terminalMessages,
                tools: toDefinitions({ revised_prompt: revisedPromptTool }),
                toolChoice: "required",
                // A round truncated before its tool call must not be retried on
                // the same budget; escalate immediately.
                generation: authoringGeneration(
                  response.finishReason === "length" ? { ...attempt, previous: "truncated" } : attempt,
                ),
              }),
            validate: (call, context) =>
              validateTerminal(call.input, context.final).pipe(Effect.mapError((error) => error.message)),
            invalid: (failure) => new UnavailableError({ message: terminalFailureMessage(failure) }),
          })
          usedTools.push("revised_prompt")
          return {
            type: "revision" as const,
            prompt: terminal.artifact.prompt,
            references: terminal.artifact.references,
            tools: usedTools,
            // This round, the corrective turn, plus any further repairs inside it.
            rounds: rounds + 2 + terminal.repairs,
          } satisfies RevisionResult
        })

        if (calls.length === 0) return yield* repairTerminal()

        const revisedCalls = calls.filter((call) => call.name === "revised_prompt")
        if (revisedCalls.length > 0) {
          if (revisedCalls.length !== 1 || calls.length !== 1)
            return yield* repairTerminal("revised_prompt must be the only tool call in its response")
          // A repair round is still available here, so reference problems are
          // reported rather than healed.
          const validated = yield* validateTerminal(revisedCalls[0]!.input, false).pipe(Effect.exit)
          if (validated._tag === "Failure") {
            const error = Cause.squash(validated.cause)
            return yield* repairTerminal(error instanceof Error ? error.message : String(error))
          }
          usedTools.push("revised_prompt")
          return {
            type: "revision",
            prompt: validated.value.prompt,
            references: validated.value.references,
            tools: usedTools,
            rounds: rounds + 1,
          } satisfies RevisionResult
        }

        // Every malformed clarification interrupt below is recoverable: the user
        // asked for a revision, so a bad `question` turn falls through to a
        // terminal repair that demands revised_prompt instead of failing the
        // request outright.
        const questionCalls = calls.filter((call) => call.name === "question")
        if (questionCalls.length > 1) {
          return yield* repairTerminal("only one question tool call is allowed per round")
        }
        if (questionCalls.length === 1) {
          if (calls.length !== 1) {
            return yield* repairTerminal("question must be the only tool call in its response")
          }
          if (!canAsk) {
            return yield* repairTerminal(
              "the clarification budget is exhausted; revise the draft from the information already available",
            )
          }
          const decodedQuestions = yield* Schema.decodeUnknownEffect(QuestionTool.Input)(
            questionCalls[0]!.input,
          ).pipe(Effect.exit)
          if (decodedQuestions._tag === "Failure") {
            const error = Cause.squash(decodedQuestions.cause)
            return yield* repairTerminal(
              `the question payload was invalid: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          const questions = decodedQuestions.value.questions
            .slice(0, MAX_QUESTIONS_PER_INTERRUPT)
            .map(sanitizeQuestion)
            .filter((question) => question.question.length > 0)
          if (questions.length === 0) {
            return yield* repairTerminal("the question payload contained no usable question text")
          }
          usedTools.push("question")
          return {
            type: "question",
            questions,
            clarificationRound: currentClarificationRound + 1,
            tools: usedTools,
            rounds,
          } satisfies QuestionResult
        }

        messages.push(response.message)
        for (const call of calls) {
          usedTools.push(call.name)
          const settlement = yield* ToolRuntime.dispatch({ ...reconTools, composer_context: composerContextTool }, call)
          messages.push(
            Message.tool({
              id: call.id,
              name: call.name,
              result: settlement.result.value,
              resultType: settlement.result.type,
            }),
          )
        }
        rounds += 1
      }

      return yield* new UnavailableError({ message: "Prompt revision exceeded its reconnaissance budget" })
    })

    const timedReviseWithRuntime: Interface["reviseWithRuntime"] = (input, runtime) =>
      withSpecialAgentTimeout(reviseWithRuntime(input, runtime), () =>
        Effect.fail(new UnavailableError({ message: "Prompt revision timed out after 5 minutes" })),
      ).pipe(
        // Prompt revision is a user-initiated composer action. A defect anywhere
        // beneath it (services here report missing paths and similar conditions
        // by dying) would otherwise surface as an opaque 500 with only an error
        // ref. Convert it into the typed failure the composer already renders,
        // and keep the real cause in the server log.
        Effect.catchDefect((defect) =>
          Effect.logError("prompt revision failed with a defect", { defect: String(defect) }).pipe(
            Effect.andThen(
              Effect.fail(new UnavailableError({ message: "Prompt revision failed unexpectedly. Please try again." })),
            ),
          ),
        ),
      )

    return Service.of({
      revise: (input) => timedReviseWithRuntime(input, defaultRuntime),
      reviseWithRuntime: timedReviseWithRuntime,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    llmClient,
    AgentV2.node,
    SkillV2.node,
    Reference.node,
    FileSystem.node,
    Catalog.node,
    Config.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
  ],
})
