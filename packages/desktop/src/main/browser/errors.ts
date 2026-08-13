import type { BrowserErrorTag, BrokerResponseErrorBody } from "./types"

// Typed host-side operation errors. Every operation failure becomes a payload
// tag in BrokerResponseError (HTTP stays 200) so transport failures are
// distinguishable from operation failures.

export class BrowserError extends Error {
  readonly tag: BrowserErrorTag
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(tag: BrowserErrorTag, message: string, retryable: boolean, details?: Record<string, unknown>) {
    super(message)
    this.name = tag
    this.tag = tag
    this.retryable = retryable
    this.details = details
  }
}

export class BrowserControlInterruptedError extends BrowserError {
  constructor(message = "Browser control was taken over by newer input") {
    super("BrowserControlInterrupted", message, true)
  }
}

export class BrowserStaleRefError extends BrowserError {
  constructor(ref: string, expected: number, actual: number) {
    super(
      "BrowserStaleRefError",
      `Snapshot ref "${ref}" is stale (bound to snapshot ${actual}, current snapshot ${expected}). Re-run browser_snapshot and use the new ref.`,
      false,
      { ref, expectedSnapshot: expected, actualSnapshot: actual },
    )
  }
}

export class BrowserNotAReactAppError extends BrowserError {
  constructor(message = "The page does not expose a React renderer to profile") {
    super("BrowserNotAReactAppError", message, false)
  }
}

export class BrowserTabNotFoundError extends BrowserError {
  constructor(tabId?: string) {
    super("BrowserTabNotFound", tabId ? `No browser tab "${tabId}"` : "No active browser tab — call browser_open first", true)
  }
}

export class BrowserGuestCrashedError extends BrowserError {
  constructor(tabId: string) {
    super("BrowserGuestCrashed", `The browser tab "${tabId}" crashed; reopen it with browser_open`, true, { tabId })
  }
}

export class BrowserDebuggerConflictError extends BrowserError {
  constructor(message = "The guest debugger is unavailable (DevTools open or debugger already attached)") {
    super("BrowserDebuggerConflict", message, false)
  }
}

export class BrowserTimeoutError extends BrowserError {
  constructor(operation: string, timeoutMs: number) {
    super("BrowserTimeout", `Operation ${operation} exceeded ${timeoutMs}ms`, true, { operation, timeoutMs })
  }
}

export class BrowserResultTooLargeError extends BrowserError {
  constructor(kind: string, limit: number) {
    super("BrowserResultTooLarge", `${kind} exceeded the ${limit}-byte result cap; narrow the request`, false, {
      kind,
      limit,
    })
  }
}

export class BrowserTargetNotFoundError extends BrowserError {
  constructor(message = "Element target matched nothing on the page") {
    super("BrowserTargetNotFound", message, true)
  }
}

export class BrowserInvalidSelectorError extends BrowserError {
  constructor(message: string) {
    super("BrowserInvalidSelector", message, false)
  }
}

export class BrowserNotAttachedError extends BrowserError {
  constructor(message = "The browser guest is not attached to a live page") {
    super("BrowserNotAttached", message, true)
  }
}

export class BrowserOperationFailedError extends BrowserError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("BrowserOperationFailed", message, true, details)
  }
}

export class BrowserUnsupportedOperationError extends BrowserError {
  constructor(message = "This host capability is not supported") {
    super("BrowserUnsupportedOperation", message, false)
  }
}

// Map an arbitrary thrown value to a broker error body. Falls back to a
// generic retryable operation failure so the host never crashes the request.
export function toBrokerErrorBody(error: unknown): BrokerResponseErrorBody {
  if (error instanceof BrowserError) {
    return { tag: error.tag, message: error.message, retryable: error.retryable, details: error.details }
  }
  if (error instanceof Error) {
    return {
      tag: "BrowserOperationFailed",
      message: error.message,
      retryable: true,
      details: { stack: error.stack },
    }
  }
  return { tag: "BrowserOperationFailed", message: String(error), retryable: true }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")
}
