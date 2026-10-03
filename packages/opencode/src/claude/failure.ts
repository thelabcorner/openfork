/**
 * Claude Agent SDK terminal/error semantics.
 *
 * Adapted from openchamber/opencode-claude v1.3, but intentionally free of
 * proxy/HTTP assumptions. This module translates native Claude Code events
 * into stable failure kinds/text that OpenFork's rooted session owner can map
 * to its own retry, compaction, and UI semantics.
 */

export type ClaudeFailureKind =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "image"
  | "refusal"
  | "overloaded"
  | "billing"
  | "unknown"

const AUTH_FAILURE_PATTERN =
  /invalid_grant|refresh token (not found|invalid|expired)|invalid[_ -]?api[_ -]?key|authentication_error|authentication failed|unauthorized|not logged in|not authenticated|please (run )?\/?login|oauth token (is )?(expired|invalid|revoked)|access token (is )?(expired|invalid|revoked)|credentials (are )?(expired|invalid|revoked)|token (has )?expired|\b401\b/i

const RATE_LIMIT_PATTERN =
  /rate.?limit|session limit|usage limit|resets? \d|too many requests|\b429\b/i

const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|exceeds the context window|context[_ ]length[_ ]exceeded|exceeds (?:the )?(?:model'?s )?maximum context length|input is too long for requested model|model_context_window_exceeded/i

const BILLING_FAILURE_PATTERN =
  /draw from extra usage|extra usage (?:is )?(?:not enabled|disabled|required|exhausted|limit)|out of extra usage|credit balance is too low/i

const IMAGE_FAILURE_PATTERN =
  /could not process image|\bimage\b[^\n]*?\b(?:exceeds?|too large|could not be processed|is not valid|invalid|unsupported|not supported|dimensions)\b/i

const REFUSAL_PATTERN = /^Claude declined this request\b/
const OVERLOADED_PATTERN = /^Anthropic (?:is overloaded|returned 5\d\d)\b/

export function classifyClaudeFailure(text: string): ClaudeFailureKind {
  if (!text) return "unknown"
  if (REFUSAL_PATTERN.test(text)) return "refusal"
  if (OVERLOADED_PATTERN.test(text)) return "overloaded"
  if (RATE_LIMIT_PATTERN.test(text)) return "rate_limit"
  if (AUTH_FAILURE_PATTERN.test(text)) return "auth"
  if (BILLING_FAILURE_PATTERN.test(text)) return "billing"
  if (CONTEXT_OVERFLOW_PATTERN.test(text)) return "context_overflow"
  if (IMAGE_FAILURE_PATTERN.test(text)) return "image"
  return "unknown"
}

function isDiagnostic(line: string): boolean {
  return /^\[ede_diagnostic\]/i.test(line.trim())
}

export function withoutDiagnostics(text: string): string {
  return text
    .split(/;\s*(?=\[ede_diagnostic\])|\n/)
    .map((part) => part.trim())
    .filter((part) => part && !isDiagnostic(part))
    .join("\n")
    .replace(/;\s*$/, "")
    .trim()
}

function terminalReasonText(reason: unknown, subtype: unknown): string | undefined {
  switch (reason) {
    case "prompt_too_long":
    case "blocking_limit":
      return "Prompt is too long: the conversation exceeds the context window."
    case "rapid_refill_breaker":
      return "The conversation exceeds the context window: it refilled right after Claude Code compacted it."
    case "image_error":
      return "Claude could not process an image in the conversation (image error)."
    case "max_turns":
      return "Claude reached the turn limit for this request before finishing."
    case "budget_exhausted":
      return "Claude stopped: the turn's budget was exhausted."
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output."
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls."
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available."
    case "turn_setup_failed":
      return "Claude Code could not start the turn."
    case "model_error":
      return "Claude stopped: the model returned an error."
    case "api_error":
      return "Claude gave up after repeated Anthropic API errors."
    case "aborted_streaming":
    case "aborted_tools":
      return "The Claude turn was interrupted."
    case "hook_stopped":
    case "stop_hook_prevented":
      return "A Claude Code hook stopped the turn."
  }
  switch (subtype) {
    case "error_max_turns":
      return "Claude reached the turn limit for this request before finishing."
    case "error_max_budget_usd":
      return "Claude stopped: the turn's budget was exhausted."
    case "error_max_structured_output_retries":
      return "Claude could not produce the requested structured output."
  }
  return undefined
}

export function resultErrorText(event: {
  readonly errors?: readonly string[]
  readonly result?: string
  readonly error?: string
  readonly terminal_reason?: string
  readonly subtype?: string
}): string {
  const listed = (event.errors ?? []).map((line) => line.trim()).filter((line) => line && !isDiagnostic(line))
  if (listed.length > 0) return listed.join("; ")
  if (event.result?.trim()) return event.result.trim()
  if (event.error?.trim()) return event.error.trim()
  return terminalReasonText(event.terminal_reason, event.subtype) ?? "Claude turn failed"
}

/**
 * Claude Code can exhaust its own API retries and still emit a success-typed
 * result with only api_error_status. Treat an empty such result as a provider
 * failure so OpenFork can retry instead of accepting an empty answer.
 */
export function overloadedResultText(event: {
  readonly is_error?: boolean
  readonly api_error_status?: number
  readonly result?: string
}): string | undefined {
  if (event.is_error) return undefined
  const status = event.api_error_status
  if (typeof status !== "number" || status < 500) return undefined
  if (event.result?.trim()) return undefined
  return status === 529
    ? "Anthropic is overloaded (529) and Claude Code gave up after its own retries. Try again shortly."
    : `Anthropic returned ${status} and Claude Code gave up after its own retries. Try again shortly.`
}

export function failureHintFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return " Claude Code credentials are invalid or expired. Run `claude auth login --claudeai`."
    case "rate_limit":
      return " Claude subscription limit is active; wait for the reset instead of retrying."
    default:
      return ""
  }
}

/** SDK finish/stop reason -> OpenFork LLM finish reason. */
export function finishReasonForClaude(stopReason: string | undefined): "stop" | "length" | "content-filter" {
  if (stopReason === "max_tokens") return "length"
  if (stopReason === "refusal") return "content-filter"
  return "stop"
}

export function apiRetryDelayMs(event: { readonly retry_delay_ms?: number }): number {
  const value = Number(event.retry_delay_ms)
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function apiRetryNote(event: {
  readonly error_status?: number | null
  readonly retry_delay_ms?: number
  readonly attempt?: number
  readonly max_retries?: number
}): string {
  const status = typeof event.error_status === "number" ? event.error_status : undefined
  const what = status ? `Anthropic returned ${status}` : "Connection to Anthropic failed"
  const delay = Number(event.retry_delay_ms)
  const wait = Number.isFinite(delay) && delay >= 1000 ? ` in ${Math.round(delay / 1000)}s` : ""
  const attempt = Number(event.attempt)
  const max = Number(event.max_retries)
  const count = Number.isFinite(attempt) && Number.isFinite(max) && max > 0 ? ` (attempt ${attempt}/${max})` : ""
  return `${what}, retrying${wait}${count}`
}

export function refusalText(event: {
  readonly api_refusal_explanation?: string
  readonly api_refusal_category?: string
  readonly content?: string
}): string {
  const explanation = event.api_refusal_explanation?.trim() || event.content?.trim() || "The request was refused."
  const category = event.api_refusal_category?.trim()
  return `Claude declined this request${category ? ` (${category})` : ""}: ${explanation}`
}

export * as ClaudeFailure from "./failure"
