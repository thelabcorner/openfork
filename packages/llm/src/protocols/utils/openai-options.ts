import { Schema } from "effect"
import type { CacheHint, LLMRequest, ReasoningEffort, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"

export const OpenAIReasoningEfforts = ReasoningEfforts.filter(
  (effort): effort is Exclude<ReasoningEffort, "max"> => effort !== "max",
)
export type OpenAIReasoningEffort = (typeof OpenAIReasoningEfforts)[number]

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]
export const OpenAIServiceTiers = ["auto", "default", "flex", "priority"] as const
export type OpenAIServiceTier = (typeof OpenAIServiceTiers)[number]
export const OpenAIPromptCacheMode = Schema.Literals(["implicit", "explicit"])
export type OpenAIPromptCacheMode = typeof OpenAIPromptCacheMode.Type
export const OpenAIPromptCacheOptions = Schema.Struct({
  mode: Schema.optional(OpenAIPromptCacheMode),
  ttl: Schema.optional(Schema.Literal("30m")),
})
export type OpenAIPromptCacheOptions = typeof OpenAIPromptCacheOptions.Type
export const OpenAIResponsesPromptCacheOptions = Schema.Struct({
  mode: Schema.optional(OpenAIPromptCacheMode),
  ttl: Schema.optional(Schema.Literal("30m")),
  comparison_response_id: Schema.optional(Schema.String),
})
export type OpenAIResponsesPromptCacheOptions = typeof OpenAIResponsesPromptCacheOptions.Type
export const OpenAIPromptCacheBreakpoint = Schema.Struct({ mode: Schema.Literal("explicit") })
export type OpenAIPromptCacheBreakpoint = typeof OpenAIPromptCacheBreakpoint.Type

const REASONING_EFFORTS = new Set<string>(ReasoningEfforts)
const OPENAI_REASONING_EFFORTS = new Set<string>(OpenAIReasoningEfforts)
const TEXT_VERBOSITY = new Set<string>(["low", "medium", "high"])
const INCLUDABLES = new Set<string>(OpenAIResponseIncludables)
const SERVICE_TIERS = new Set<string>(OpenAIServiceTiers)
const PROMPT_CACHE_MODES = new Set<string>(["implicit", "explicit"])

export const OpenAIReasoningEffort = Schema.Literals(OpenAIReasoningEfforts)
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)
export const OpenAIServiceTier = Schema.Literals(OpenAIServiceTiers)

const isAnyReasoningEffort = (effort: unknown): effort is ReasoningEffort =>
  typeof effort === "string" && REASONING_EFFORTS.has(effort)

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort =>
  typeof effort === "string" && OPENAI_REASONING_EFFORTS.has(effort)

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && TEXT_VERBOSITY.has(value)

const options = (request: LLMRequest) => request.providerOptions?.openai

export const store = (request: LLMRequest): boolean | undefined => {
  const value = options(request)?.store
  return typeof value === "boolean" ? value : undefined
}

export const reasoningEffort = (request: LLMRequest): ReasoningEffort | undefined => {
  const value = options(request)?.reasoningEffort
  return isAnyReasoningEffort(value) ? value : undefined
}

export const reasoningSummary = (request: LLMRequest): "auto" | undefined =>
  options(request)?.reasoningSummary === "auto" ? "auto" : undefined

// Resolve the OpenAI Responses `include` field. Filters out unknown
// includable values defensively so a typo in upstream config drops the
// invalid entry instead of poisoning the wire body. An empty array (either
// passed directly or produced by filtering) is treated as "no include" and
// returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is OpenAIResponseIncludable => INCLUDABLES.has(entry))
  return filtered.length > 0 ? filtered : undefined
}

export const promptCacheKey = (request: LLMRequest) => {
  const value = options(request)?.promptCacheKey
  return typeof value === "string" ? value : undefined
}

/**
 * Current explicit prompt-cache controls are an OpenAI GPT-5.6+ API contract.
 * Keep aliases/proxies/Azure fail-closed until their exact route documents the
 * same contract; sharing the Responses/Chat wire shape is not proof of support.
 */
export const supportsPromptCacheControls = (request: LLMRequest) => {
  if (String(request.model.provider) !== "openai") return false
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(String(request.model.id))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 6)
}

export const promptCacheOptions = (request: LLMRequest): OpenAIPromptCacheOptions | undefined => {
  const value = options(request)?.promptCacheOptions
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const mode = typeof record.mode === "string" && PROMPT_CACHE_MODES.has(record.mode) ? (record.mode as OpenAIPromptCacheMode) : undefined
  const ttl = record.ttl === "30m" ? "30m" as const : undefined
  return mode === undefined && ttl === undefined ? undefined : { mode, ttl }
}

/**
 * Responses-only diagnostic comparison cursor. It never loads prior
 * conversation state and must not be confused with previous_response_id or the
 * prompt cache isolation key.
 */
export const promptCacheComparisonResponseId = (request: LLMRequest): string | undefined => {
  const value = options(request)?.promptCacheOptions
  if (!value || typeof value !== "object") return undefined
  const comparisonResponseId = (value as Record<string, unknown>).comparisonResponseId
  return typeof comparisonResponseId === "string" && comparisonResponseId.length > 0 ? comparisonResponseId : undefined
}

/** A semantic CacheHint maps to one OpenAI explicit boundary on supported routes. */
export const promptCacheBreakpoint = (
  request: LLMRequest,
  cache: CacheHint | undefined,
): OpenAIPromptCacheBreakpoint | undefined =>
  supportsPromptCacheControls(request) && cache !== undefined ? { mode: "explicit" } : undefined

export const textVerbosity = (request: LLMRequest) => {
  const value = options(request)?.textVerbosity
  return isTextVerbosity(value) ? value : undefined
}

export const serviceTier = (request: LLMRequest) => {
  const value = options(request)?.serviceTier
  return typeof value === "string" && SERVICE_TIERS.has(value) ? (value as OpenAIServiceTier) : undefined
}

export const instructions = (request: LLMRequest) => {
  const value = options(request)?.instructions
  return typeof value === "string" ? value : undefined
}

export * as OpenAIOptions from "./openai-options"
