import { Schema } from "effect"

export class BridgeError extends Schema.TaggedErrorClass<BridgeError>()("ClaudeBridgeError", {
  code: Schema.Literals(["denied", "timeout", "cancelled", "disposed", "scope_mismatch", "duplicate_continuation", "not_found", "invalid_tool", "untrusted_boundary", "overflow"]),
  message: Schema.String,
  callID: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {}

export class SessionBindingError extends Schema.TaggedErrorClass<SessionBindingError>()("ClaudeSessionBindingError", {
  code: Schema.Literals([
    "project_mismatch",
    "worktree_mismatch",
    "cwd_mismatch",
    "model_mismatch",
    "digest_mismatch",
    "transcript_missing",
    "stale",
    "not_found",
  ]),
  message: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

// Redaction: never include prompt bodies, tokens, Authorization headers, full paths, or raw tool args.
// Use stable hashes for correlation where needed.
export function redact(value: string): string {
  if (!value) return ""
  // Keep first 8 chars of a hash-like ID for correlation, drop rest
  if (value.length > 16) return value.slice(0, 8) + "…redacted"
  return "…redacted"
}

export function boundedString(input: string, max = 2000): string {
  if (input.length <= max) return input
  return input.slice(0, max) + ` …truncated(${input.length - max} omitted)`
}

// ── Runtime/auth error categories (stable, user-safe) ──
// Each maps to one recovery path; messages never contain credentials,
// prompt bodies, tool arguments, or full paths.

export class ClaudeCliMissingError extends Schema.TaggedErrorClass<ClaudeCliMissingError>()("ClaudeCliMissingError", {
  message: Schema.String,
}) {}

export class ClaudeSdkUnavailableError extends Schema.TaggedErrorClass<ClaudeSdkUnavailableError>()("ClaudeSdkUnavailableError", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class ClaudeAuthRequiredError extends Schema.TaggedErrorClass<ClaudeAuthRequiredError>()("ClaudeAuthRequiredError", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class ClaudeLoginFailedError extends Schema.TaggedErrorClass<ClaudeLoginFailedError>()("ClaudeLoginFailedError", {
  message: Schema.String,
}) {}

export class ClaudeTimeoutError extends Schema.TaggedErrorClass<ClaudeTimeoutError>()("ClaudeTimeoutError", {
  message: Schema.String,
  timeoutMs: Schema.Finite,
}) {}

export class ClaudeStalledError extends Schema.TaggedErrorClass<ClaudeStalledError>()("ClaudeStalledError", {
  message: Schema.String,
  stallMs: Schema.Finite,
}) {}

export class ClaudeDisposedError extends Schema.TaggedErrorClass<ClaudeDisposedError>()("ClaudeDisposedError", {
  message: Schema.optional(Schema.String),
}) {}

export class ClaudeProtocolError extends Schema.TaggedErrorClass<ClaudeProtocolError>()("ClaudeProtocolError", {
  message: Schema.String,
}) {}

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g
function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "")
}
/** Credential-shaped substrings are dropped before any detail is surfaced. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/gi,
  /(?:api[_-]?key|token|authorization)["']?\s*[:=]\s*\S+/gi,
]

/**
 * Sanitize an untrusted detail string (CLI stderr, SDK error text) for user
 * surfaces and diagnostics: strip ANSI escapes, redact credential-shaped
 * substrings, and bound the length.
 */
export function sanitizeDetail(input: string, max = 500): string {
  let text = stripAnsi(String(input ?? "")).replace(/\s+/g, " ").trim()
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]")
  }
  if (text.length > max) return text.slice(0, max) + ` …truncated(${text.length - max} omitted)`
  return text
}

export * as ClaudeErrors from "./errors"
