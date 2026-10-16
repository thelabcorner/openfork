import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow, isStaleReasoning } from "@opencode-ai/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    // Upstream Go/Zen sometimes wraps a useful provider validation error
    // behind a generic "invalid parameters" SDK message. Prefer a structured
    // nested detail when present; never expose the entire request/response
    // payload (which can include user prompts and credentials).
    if (providerID === "opencode" || providerID === "opencode-go") {
      const parsed = json(e.responseBody)
      const detail = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined
      if (detail && detail !== msg && /invalid parameters|invalid request|bad request/i.test(msg)) {
        const parameter =
          typeof parsed?.error?.param === "string" && /^[a-zA-Z0-9_.\[\]-]{1,96}$/.test(parsed.error.param)
            ? parsed.error.param
            : undefined
        return parameter ? `${msg} (${parameter}): ${detail}` : `${msg}: ${detail}`
      }
    }
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error?.message || body.error
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

// Hosted Go/Zen can reject a request at its model-specific prompt compiler,
// sometimes through a gateway 5xx. That is a deterministic request/model
// incompatibility, not an overloaded provider or a reason to replay the same
// transcript. Inspect only the structured error code or the gateway's own
// bracketed failure code; never scan user prompt/request-body content.
function isPromptRenderingFailure(message: unknown, response: unknown) {
  if (typeof message === "string" && /\[prompt_rendering_failed\]/i.test(message)) return true
  const body = json(response)
  return body?.error?.code === "prompt_rendering_failed" || body?.code === "prompt_rendering_failed"
}

const promptRenderingGuidance =
  "This model could not render the conversation in its supported prompt format. " +
  "Choose another model to continue with the existing history; repeating the same request will not fix this model's prompt renderer."

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "stale_reasoning"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "invalid_encrypted_content":
      return {
        type: "stale_reasoning",
        message: typeof body?.error?.message === "string" ? body.error.message : "Encrypted reasoning is no longer valid",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }

  if (isPromptRenderingFailure(body?.error?.message, body)) {
    return {
      type: "api_error",
      message: `Prompt rendering failed [prompt_rendering_failed]. ${promptRenderingGuidance}`,
      isRetryable: false,
      responseBody,
    }
  }

  // Hosted Responses streams may report validation failures over SSE without
  // an HTTP status. Recognize these only AFTER special context/reasoning/quota
  // codes above, so stale encrypted state still takes its recovery path.
  const errorType = body?.error?.type
  const errorCode = body?.error?.code
  const invalid =
    ["invalid_request_error", "invalid_parameters", "validation_error"].includes(errorType) ||
    ["invalid_request_error", "invalid_parameters", "invalid_tool_schema", "unsupported_parameter"].includes(errorCode)
  return {
    type: "api_error",
    message: typeof body?.error?.message === "string" ? body.error.message : "Server error.",
    isRetryable: !invalid,
    responseBody,
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "stale_reasoning"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const body = json(input.error.responseBody)
  if (isPromptRenderingFailure(input.error.message, body)) {
    return {
      type: "api_error",
      // A gateway response body is not trusted display text: it may contain
      // request fragments. The stable error code is sufficient for guidance.
      message: `Prompt rendering failed [prompt_rendering_failed]. ${promptRenderingGuidance}`,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      ...(input.error.url ? { metadata: { url: input.error.url } } : {}),
    }
  }
  const m = message(input.providerID, input.error)
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }
  if (isStaleReasoning(m) || body?.error?.code === "invalid_encrypted_content") {
    return {
      type: "stale_reasoning",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  // Invalid OpenRouter `provider.only` / stale upstream pin is a client
  // configuration error, not a transient provider failure. The upstream
  // returns 404 with "No allowed providers are available" even when the
  // outer gateway status is 500, so we force non-retryable here.
  const rawBody = input.error.responseBody ?? ""
  const rawMessage = input.error.message ?? ""
  const isInvalidProviderPin =
    /no allowed providers are available/i.test(rawBody) ||
    /no allowed providers are available/i.test(rawMessage) ||
    /no allowed providers are available/i.test(m) ||
    /provider\.only.*permits only/i.test(rawBody) ||
    /provider\.only.*permits only/i.test(m)
  if (isInvalidProviderPin) {
    const metadata = input.error.url ? { url: input.error.url } : undefined
    // Append user-actionable guidance: the persisted `provider.only` pin is
    // stale (e.g. `tencent` for `xiaomi/mimo-v2.5-20260422`). The frontend
    // auto-clears it when endpoints are next fetched, but this message helps
    // users who see the error before that happens.
    const guidance =
      " Your pinned upstream provider no longer serves this model. Open the model picker, choose Auto (clear the provider pin), and retry. The app will also clear a stale `tencent` pin for this model automatically."
    const helpfulMessage = m.includes("No allowed providers") ? `${m}${guidance}` : m
    return {
      type: "api_error",
      message: helpfulMessage,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
