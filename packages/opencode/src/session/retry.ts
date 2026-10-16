import type { NamedError } from "@opencode-ai/core/util/error"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
import { retryAfterAt } from "./limit-recovery-reset"
import { isStaleReasoning } from "@opencode-ai/llm"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type RetryAction = {
  reason: RetryReason
  provider: string
  title: string
  message: string
  label: string
  link?: string
}

export type Retryable = {
  message: string
  action?: RetryAction
  /**
   * Report this failure once with its action, then stop instead of scheduling
   * another attempt. Used for quota exhaustion, where replaying the same
   * request against the same exhausted budget cannot succeed.
   */
  terminal?: boolean
}

export type ProviderFailureClass =
  | "account-auth"
  | "account-quota"
  | "account-rate-limit"
  | "public-quota"
  | "rate-limit"
  | "request-admission"
  | "provider-transient"
  | "request-invalid"
  | "cancelled"

export type ProviderFailureRouteEffect =
  | "none"
  | "account-auth-invalid"
  | "account-cooldown"
  | "account-quota-exhausted"
  | "public-quota-exhausted"

export type ProviderFailureDecision = {
  readonly class: ProviderFailureClass
  readonly retry: "none" | "same-route"
  readonly routeEffect: ProviderFailureRouteEffect
  readonly message: string
  /** Absolute trusted retry/reset deadline derived from Retry-After, when present. */
  readonly resetAt?: number
  readonly action?: RetryAction
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5
// A 504 issued only after the upstream provider has already waited for an
// entire idle-response window is substantially more expensive than an ordinary
// transient 5xx. Stop rather than silently replaying another multi-minute wait;
// the user can explicitly retry. Other gateway/network failures retain their budget.
export const RETRY_MAX_UPSTREAM_IDLE_RETRIES = 0

function upstreamIdleTimeout(error: Err) {
  const body = SessionV1.APIError.isInstance(error) ? error.data.responseBody ?? "" : ""
  const message = isRecord(error.data) && typeof error.data.message === "string" ? error.data.message : ""
  const combined = `${message}\n${body}`
  return /upstream idle timeout exceeded/i.test(combined) &&
    ((SessionV1.APIError.isInstance(error) && error.data.statusCode === 504) || /\[504\]/.test(combined))
}

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

const NON_RETRYABLE_MESSAGE_PATTERNS = [
  // An upstream stream may already have published text or executed tools.
  // EOF without a terminal disposition is not evidence that the request is
  // safe to replay; recovery must be a new owned turn, not a physical retry.
  /^Provider stream ended without a terminal finish event$/i,
  /^OpenAI-compatible stream ended without a recognized finish_reason$/i,
  /^OpenAI-compatible stream ended without a completed model step$/i,
  // This is a local *already exhausted* progress deadline, not an upstream
  // transient response. Replaying it up to five times would multiply the
  // watchdog into a 25-minute busy/requesting Session.
  /^Provider response timed out \((?:waiting for first content|provider stream idle), \d+ms\)/i,
  // Local consumer/DB/snapshot stalls cannot be fixed by replaying the
  // physical upstream request; doing so risks re-executing committed tools.
  /^Local provider event processing stalled \(.+, \d+ms\)/i,
  /no allowed providers are available/i,
  /provider\.only.*permits only/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random(), now = Date.now()) {
  if (error) {
    const resetAt = retryResetAt(error, now)
    if (resetAt !== undefined && resetAt >= now) return cap(resetAt - now)
    if (error.data.responseHeaders) return cap(exponential(attempt, random))
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}


/**
 * Parse only standardized Retry-After evidence into an absolute deadline.
 * This value is safe to hand to route health as bounded server-derived state;
 * generic exponential backoff is deliberately not a durable health fact.
 */
export function retryResetAt(error: SessionV1.APIError, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) return undefined
  return retryAfterAt(error.data.responseHeaders, now)
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    if (promptRenderingFailure(error)) return undefined
    if (isStaleReasoning([error.data.message, error.data.responseBody ?? ""].join("\n"))) return undefined
    // Client configuration errors like an invalid OpenRouter `provider.only`
    // must never be retried - the request will fail identically on every
    // attempt until the user clears the stale upstream-provider pin. The
    // provider returns a 404/400 with "No allowed providers are available"
    // even when the outer HTTP status is 500 from a gateway, so we check the
    // message body before the generic 5xx retry gate.
    if (
      matchesNonRetryableMessage(error.data.message) ||
      matchesNonRetryableMessage(error.data.responseBody)
    )
      return undefined
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        terminal: true,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const now = Date.now()
      const resetAt = retryResetAt(error, now)
      const retryAfter = resetAt === undefined ? undefined : Math.max(0, (resetAt - now) / 1000)
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  if (matchesNonRetryableMessage(message)) return undefined
  if (isStaleReasoning(message)) return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

/**
 * Classify one provider failure without conflating three independent choices:
 * what failed, whether this exact committed route may be retried immediately,
 * and whether future route eligibility may change.
 *
 * Route effects are descriptive at this boundary. Applying/persisting provider
 * health belongs to the route-health owner; retry policy consumes only
 * `retry`, so a failure can never silently switch Public/account identity.
 */
export function classify(
  error: Err,
  provider: string,
  route?: UsageRouteAttribution.Committed,
  now = Date.now(),
): ProviderFailureDecision {
  const message = isRecord(error.data) && typeof error.data.message === "string" ? error.data.message : "Request failed"
  const resetAt = SessionV1.APIError.isInstance(error) ? retryResetAt(error, now) : undefined
  const staleReasoningText = SessionV1.APIError.isInstance(error)
    ? [error.data.message, error.data.responseBody ?? ""].join("\n")
    : message

  if (isStaleReasoning(staleReasoningText)) {
    return {
      class: "request-invalid",
      retry: "none",
      routeEffect: "none",
      message,
    }
  }

  if (SessionV1.ContextOverflowError.isInstance(error)) {
    return {
      class: "request-invalid",
      retry: "none",
      routeEffect: "none",
      message,
    }
  }

  if (SessionV1.APIError.isInstance(error)) {
    const body = error.data.responseBody ?? ""
    const hasSignal = (signal: string) => error.data.message.includes(signal) || body.includes(signal)

    if (hasSignal("FreeUsageLimitError")) {
      const legacy = retryable(error, provider)
      if (route?.routeKind === "public") {
        return {
          class: "public-quota",
          retry: "none",
          routeEffect: "public-quota-exhausted",
          message: legacy?.message ?? GO_UPSELL_MESSAGE,
          ...(resetAt === undefined ? {} : { resetAt }),
          ...(legacy?.action ? { action: legacy.action } : {}),
        }
      }
      if (route?.routeKind === "account") {
        return {
          class: "request-admission",
          retry: "none",
          routeEffect: "none",
          message: error.data.message,
        }
      }
      // Legacy/no-route calls may retain the existing action card, but absence
      // of committed Public authority is not evidence for Public route health.
      return {
        class: "request-admission",
        retry: "none",
        routeEffect: "none",
        message: legacy?.message ?? GO_UPSELL_MESSAGE,
        ...(legacy?.action ? { action: legacy.action } : {}),
      }
    }

    if (hasSignal("FreeTierError") || hasSignal("MissingSessionID")) {
      return {
        class: "request-admission",
        retry: "none",
        routeEffect: "none",
        message: error.data.message,
      }
    }

    if (hasSignal("GoUsageLimitError")) {
      const legacy = retryable(error, provider)
      if (route?.routeKind === "public") {
        return {
          class: "request-admission",
          retry: "none",
          routeEffect: "none",
          message: error.data.message,
        }
      }
      return {
        class: "account-quota",
        retry: "none",
        routeEffect: route?.routeKind === "account" ? "account-quota-exhausted" : "none",
        message: legacy?.message ?? error.data.message,
        ...(route?.routeKind === "account" && resetAt !== undefined ? { resetAt } : {}),
        ...(legacy?.action ? { action: legacy.action } : {}),
      }
    }

    const status = error.data.statusCode
    if (route?.routeKind === "account" && (status === 401 || status === 403)) {
      return {
        class: "account-auth",
        retry: "none",
        routeEffect: "account-auth-invalid",
        message: error.data.message,
      }
    }
    if (route?.routeKind === "account" && status === 429) {
      return {
        class: "account-rate-limit",
        retry: "none",
        routeEffect: "account-cooldown",
        message: error.data.message,
        ...(resetAt === undefined ? {} : { resetAt }),
      }
    }

    // A standardized Retry-After on an otherwise un-attributed 429 is a
    // terminal, recoverable limit decision. It must settle this provider
    // request immediately; durable recovery is a separate continuation.
    if (status === 429 && resetAt !== undefined) {
      return {
        class: "rate-limit",
        retry: "none",
        routeEffect: "none",
        message: error.data.message,
        resetAt,
      }
    }
  }

  const legacy = retryable(error, provider)
  if (legacy) {
    return {
      class: "provider-transient",
      retry: "same-route",
      routeEffect: "none",
      message: legacy.message,
      ...(legacy.action ? { action: legacy.action } : {}),
    }
  }

  return {
    class: "request-invalid",
    retry: "none",
    routeEffect: "none",
    message,
  }
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function matchesNonRetryableMessage(value: unknown) {
  return typeof value === "string" && NON_RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

function promptRenderingFailure(error: SessionV1.APIError) {
  // Match the remote gateway's code, not an incidental mention of the token
  // in a body containing echoed user input. A 5xx wrapper is not retry evidence.
  if (/\[prompt_rendering_failed\]/i.test(error.data.message)) return true
  const body = parseJSON(error.data.responseBody)
  return body?.error?.code === "prompt_rendering_failed" || body?.code === "prompt_rendering_failed"
}

export function policy(opts: {
  provider: string
  route?: UsageRouteAttribution.Committed
  parse: (error: unknown) => Err
  observe?: (input: {
    readonly error: Err
    readonly decision: ProviderFailureDecision
  }) => Effect.Effect<void>
  set: (input: { attempt: number; message: string; action?: RetryAction; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const decision = classify(error, opts.provider, opts.route)
      const observe = opts.observe
        ? opts.observe({ error, decision })
        : Effect.void

      if (decision.retry === "none") {
        return Effect.gen(function* () {
          yield* observe
          if (decision.action) {
            // User-facing quota/admission actions are reported once, but the
            // original provider failure remains terminal for this logical request.
            const now = yield* Clock.currentTimeMillis
            yield* opts.set({
              attempt: meta.attempt,
              message: decision.message,
              action: decision.action,
              next: now,
            })
          }
          return yield* Cause.done(meta.attempt)
        })
      }

      const maxRetries = upstreamIdleTimeout(error) ? RETRY_MAX_UPSTREAM_IDLE_RETRIES : RETRY_MAX_RETRIES
      if (meta.attempt > maxRetries) {
        return Effect.gen(function* () {
          yield* observe
          return yield* Cause.done(meta.attempt)
        })
      }
      return Effect.gen(function* () {
        yield* observe
        const now = yield* Clock.currentTimeMillis
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined, Math.random(), now)
        yield* opts.set({
          attempt: meta.attempt,
          message: decision.message,
          action: decision.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
