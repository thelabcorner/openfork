export * as BrowserHostBroker from "./host-broker"

import { Hash } from "../util/hash"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"

/**
 * BrowserHostBroker — the sidecar-side registry and dispatch for Desktop
 * browser hosts.
 *
 * Topology: the Desktop host (main process) runs a loopback HTTP listener and
 * registers OUT to the sidecar (`POST /api/browser/host/hello` handled by
 * `packages/server/src/handlers/browser.ts`). The sidecar forwards
 * `BrokerRequest` envelopes IN to the host's callback URL and receives a
 * synchronous `BrokerResponse` (HTTP 200 on both arms — operation errors are
 * payload tags, transport failures are broker-detected).
 *
 * This service owns the host registry (stickiness-keyed, last-hello-wins,
 * idempotent heartbeat), in-flight request tracking, request forwarding,
 * abort propagation (ctx.abort → host abort endpoint + BrowserControlInterrupted)
 * and host-event recording. It lives in core (not server) so BOTH the server
 * handlers and the opencode tool loop share one instance.
 *
 * Dependency note: this module must NOT import `@opencode-ai/protocol` (core
 * sits below protocol in the dependency order). The envelope shapes are
 * mirrored structurally; `packages/protocol/src/groups/browser.ts` is the wire
 * source of truth and the server handler decodes payloads into these plain
 * shapes. `packages/opencode/src/browser/broker-client.ts` maps the response
 * envelope error arm onto the typed `BrowserError` classes exported here.
 */

// --- wire mirror (protocol/src/groups/browser.ts) ---------------------------

export const BROWSER_PROTOCOL_VERSION = 1
export const BROKER_REQUEST_PATH = "/v1/browser/request"
export const BROKER_ABORT_PATH = "/v1/browser/request/:requestId/abort"

export type BrowserErrorTag =
  | "BrowserHostUnavailable"
  | "BrowserProtocolMismatch"
  | "BrowserTabNotFound"
  | "BrowserGuestCrashed"
  | "BrowserControlInterrupted"
  | "BrowserInvalidSelector"
  | "BrowserTargetNotFound"
  | "BrowserTimeout"
  | "BrowserResultTooLarge"
  | "BrowserDebuggerConflict"
  | "BrowserUnsupportedOperation"
  | "BrowserPermissionDenied"
  | "BrowserNotAttached"
  | "BrowserOperationFailed"
  | "BrowserStaleRefError"
  | "BrowserNotAReactAppError"

export interface BrokerError {
  readonly tag: BrowserErrorTag
  readonly message: string
  readonly retryable: boolean
  readonly details?: unknown
}

export interface HostCapabilities {
  readonly maxSnapshotBytes: number
  readonly maxResultBytes: number
  readonly supportedAppearances: readonly ("system" | "light" | "dark")[]
  readonly supportsRecording: boolean
  readonly cdp: boolean
}

export interface HostGuestState {
  readonly attached: boolean
  readonly activeTabId: string | null
  readonly url: string | null
}

export interface HostHello {
  readonly protocolVersion: number
  readonly hostId: string
  readonly hostEpoch: number
  readonly connectionId: string
  readonly windowId: string
  readonly capabilities: HostCapabilities
  readonly guest: HostGuestState
}

export interface HostRegistration extends HostHello {
  readonly sessionId: string
  readonly workspaceId?: string
  readonly directory?: string
  readonly callbackUrl: string
  readonly callbackToken: string
}

export interface HostRegistrationInfo extends Omit<HostRegistration, "callbackToken"> {
  readonly status: "live" | "superseded" | "dead"
  readonly registeredAt: number
  readonly lastSeenAt: number
}

export interface HostHelloReply {
  readonly data: {
    readonly accepted: boolean
    readonly brokerProtocolVersion: number
    readonly hostId: string
    readonly replacement?: boolean
  }
}

export type HostEvent =
  | { readonly type: "guest.crashed"; readonly tabId: string; readonly timestamp: string }
  | { readonly type: "guest.stateChanged"; readonly tab: { readonly tabId: string }; readonly timestamp: string }
  | { readonly type: "host.stopping"; readonly timestamp: string }
  | { readonly type: "request.aborted"; readonly requestId: string; readonly timestamp: string }

export interface BrokerOperation {
  readonly name: string
  readonly input: unknown
}

/** The broker fills `windowId` (resolved from the sticky connection); the caller
 * may supply `requestId`, otherwise the broker mints a uuid. */
export type BrokerRequestInput = Omit<BrokerRequest, "requestId" | "windowId"> & { readonly requestId?: string }

export interface BrokerRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly windowId: string
  readonly workspaceId?: string
  readonly directory?: string
  readonly messageId: string
  readonly toolCallId?: string
  readonly tabId?: string
  readonly operation: BrokerOperation
  readonly timeoutMs: number
}

export interface SnapshotRef {
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly readyState: string
}

export interface BrokerResponseOk {
  readonly ok: true
  readonly requestId: string
  readonly result: unknown
  readonly elapsedMs: number
  readonly snapshotAfter?: SnapshotRef
}

export interface BrokerResponseError {
  readonly ok: false
  readonly requestId: string
  readonly error: BrokerError
  readonly elapsedMs: number
}

export type BrokerResponse = BrokerResponseOk | BrokerResponseError

const BrokerErrorSchema = Schema.Struct({
  tag: Schema.Literals([
    "BrowserHostUnavailable",
    "BrowserProtocolMismatch",
    "BrowserTabNotFound",
    "BrowserGuestCrashed",
    "BrowserControlInterrupted",
    "BrowserInvalidSelector",
    "BrowserTargetNotFound",
    "BrowserTimeout",
    "BrowserResultTooLarge",
    "BrowserDebuggerConflict",
    "BrowserUnsupportedOperation",
    "BrowserPermissionDenied",
    "BrowserNotAttached",
    "BrowserOperationFailed",
    "BrowserStaleRefError",
    "BrowserNotAReactAppError",
  ]),
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
})

const BrokerResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    requestId: Schema.String,
    result: Schema.Unknown,
    elapsedMs: Schema.Number,
    snapshotAfter: Schema.optional(Schema.Struct({ tabId: Schema.String, url: Schema.String, title: Schema.String, readyState: Schema.String })),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestId: Schema.String,
    error: BrokerErrorSchema,
    elapsedMs: Schema.Number,
  }),
])

// --- typed error classes (payload tags → matchable Effect errors) -----------

const BrowserErrorFields = {
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
}

export class BrowserHostUnavailableError extends Schema.TaggedErrorClass<BrowserHostUnavailableError>()(
  "BrowserHostUnavailable",
  BrowserErrorFields,
) {}
export class BrowserProtocolMismatchError extends Schema.TaggedErrorClass<BrowserProtocolMismatchError>()(
  "BrowserProtocolMismatch",
  BrowserErrorFields,
) {}
export class BrowserTabNotFoundError extends Schema.TaggedErrorClass<BrowserTabNotFoundError>()(
  "BrowserTabNotFound",
  BrowserErrorFields,
) {}
export class BrowserGuestCrashedError extends Schema.TaggedErrorClass<BrowserGuestCrashedError>()(
  "BrowserGuestCrashed",
  BrowserErrorFields,
) {}
export class BrowserControlInterruptedError extends Schema.TaggedErrorClass<BrowserControlInterruptedError>()(
  "BrowserControlInterrupted",
  BrowserErrorFields,
) {}
export class BrowserInvalidSelectorError extends Schema.TaggedErrorClass<BrowserInvalidSelectorError>()(
  "BrowserInvalidSelector",
  BrowserErrorFields,
) {}
export class BrowserTargetNotFoundError extends Schema.TaggedErrorClass<BrowserTargetNotFoundError>()(
  "BrowserTargetNotFound",
  BrowserErrorFields,
) {}
export class BrowserTimeoutError extends Schema.TaggedErrorClass<BrowserTimeoutError>()(
  "BrowserTimeout",
  BrowserErrorFields,
) {}
export class BrowserResultTooLargeError extends Schema.TaggedErrorClass<BrowserResultTooLargeError>()(
  "BrowserResultTooLarge",
  BrowserErrorFields,
) {}
export class BrowserDebuggerConflictError extends Schema.TaggedErrorClass<BrowserDebuggerConflictError>()(
  "BrowserDebuggerConflict",
  BrowserErrorFields,
) {}
export class BrowserUnsupportedOperationError extends Schema.TaggedErrorClass<BrowserUnsupportedOperationError>()(
  "BrowserUnsupportedOperation",
  BrowserErrorFields,
) {}
export class BrowserPermissionDeniedError extends Schema.TaggedErrorClass<BrowserPermissionDeniedError>()(
  "BrowserPermissionDenied",
  BrowserErrorFields,
) {}
export class BrowserNotAttachedError extends Schema.TaggedErrorClass<BrowserNotAttachedError>()(
  "BrowserNotAttached",
  BrowserErrorFields,
) {}
export class BrowserOperationFailedError extends Schema.TaggedErrorClass<BrowserOperationFailedError>()(
  "BrowserOperationFailed",
  BrowserErrorFields,
) {}
export class BrowserStaleRefError extends Schema.TaggedErrorClass<BrowserStaleRefError>()(
  "BrowserStaleRefError",
  BrowserErrorFields,
) {}
export class BrowserNotAReactAppError extends Schema.TaggedErrorClass<BrowserNotAReactAppError>()(
  "BrowserNotAReactAppError",
  BrowserErrorFields,
) {}

export type BrowserErrorClass =
  | BrowserHostUnavailableError
  | BrowserProtocolMismatchError
  | BrowserTabNotFoundError
  | BrowserGuestCrashedError
  | BrowserControlInterruptedError
  | BrowserInvalidSelectorError
  | BrowserTargetNotFoundError
  | BrowserTimeoutError
  | BrowserResultTooLargeError
  | BrowserDebuggerConflictError
  | BrowserUnsupportedOperationError
  | BrowserPermissionDeniedError
  | BrowserNotAttachedError
  | BrowserOperationFailedError
  | BrowserStaleRefError
  | BrowserNotAReactAppError

const ErrorDefaults: Record<BrowserErrorTag, { readonly retryable: boolean; readonly message: string }> = {
  BrowserHostUnavailable: {
    retryable: true,
    message: "No live Desktop browser host is registered for this session. Call browser_status or browser_open to re-establish the browser.",
  },
  BrowserProtocolMismatch: {
    retryable: false,
    message: "The browser host speaks an incompatible broker protocol version and must be restarted.",
  },
  BrowserTabNotFound: { retryable: true, message: "The requested tab does not exist. Call browser_open first." },
  BrowserGuestCrashed: { retryable: true, message: "The browser guest crashed. Re-open it with browser_open." },
  BrowserControlInterrupted: {
    retryable: true,
    message: "Browser control was interrupted (user took control, the connection was superseded, or the operation was aborted). Re-snapshot and retry.",
  },
  BrowserInvalidSelector: { retryable: false, message: "The selector could not be parsed. Rewrite it and retry." },
  BrowserTargetNotFound: {
    retryable: true,
    message: "The target element was not found. Re-snapshot and retry with a fresh ref or locator.",
  },
  BrowserTimeout: { retryable: true, message: "The browser operation timed out. Retry." },
  BrowserResultTooLarge: {
    retryable: false,
    message: "The operation result exceeded the size cap. Narrow the request (maxDepth / smaller script).",
  },
  BrowserDebuggerConflict: {
    retryable: false,
    message: "The browser guest's debugger is unavailable (being inspected or already attached).",
  },
  BrowserUnsupportedOperation: { retryable: false, message: "The browser host does not support this operation." },
  BrowserPermissionDenied: {
    retryable: false,
    message: "Permission for this browser operation was denied.",
  },
  BrowserNotAttached: {
    retryable: true,
    message: "The guest exists but no page is attached. Call browser_open.",
  },
  BrowserOperationFailed: {
    retryable: true,
    message: "The browser operation failed in the host. Retry.",
  },
  BrowserStaleRefError: {
    retryable: true,
    message: "The element reference is stale (the page changed since the snapshot). Re-snapshot and retry with the new ref.",
  },
  BrowserNotAReactAppError: {
    retryable: false,
    message: "The page is not a React application; React profiling is unavailable.",
  },
}

export const BrowserError = {
  /** Build the typed error class for a payload tag with sane defaults. */
  make: (tag: BrowserErrorTag, input?: Partial<{ message: string; retryable: boolean; details: unknown }>): BrowserErrorClass => {
    const defaults = ErrorDefaults[tag]
    const fields = {
      message: input?.message ?? defaults.message,
      retryable: input?.retryable ?? defaults.retryable,
      details: input?.details,
    }
    switch (tag) {
      case "BrowserHostUnavailable": return new BrowserHostUnavailableError(fields)
      case "BrowserProtocolMismatch": return new BrowserProtocolMismatchError(fields)
      case "BrowserTabNotFound": return new BrowserTabNotFoundError(fields)
      case "BrowserGuestCrashed": return new BrowserGuestCrashedError(fields)
      case "BrowserControlInterrupted": return new BrowserControlInterruptedError(fields)
      case "BrowserInvalidSelector": return new BrowserInvalidSelectorError(fields)
      case "BrowserTargetNotFound": return new BrowserTargetNotFoundError(fields)
      case "BrowserTimeout": return new BrowserTimeoutError(fields)
      case "BrowserResultTooLarge": return new BrowserResultTooLargeError(fields)
      case "BrowserDebuggerConflict": return new BrowserDebuggerConflictError(fields)
      case "BrowserUnsupportedOperation": return new BrowserUnsupportedOperationError(fields)
      case "BrowserPermissionDenied": return new BrowserPermissionDeniedError(fields)
      case "BrowserNotAttached": return new BrowserNotAttachedError(fields)
      case "BrowserOperationFailed": return new BrowserOperationFailedError(fields)
      case "BrowserStaleRefError": return new BrowserStaleRefError(fields)
      case "BrowserNotAReactAppError": return new BrowserNotAReactAppError(fields)
    }
  },
  /** Map a decoded response-envelope error payload onto the typed class. */
  fromPayload: (payload: BrokerError): BrowserErrorClass => BrowserError.make(payload.tag, payload),
}

// --- registry ----------------------------------------------------------------

/** `${sessionID}@${workspaceID ?? sha1(directory)}#${windowID}` — the stickiness key. */
export const stickinessKey = (input: { sessionId: string; workspaceId?: string; directory?: string; windowId: string }) => {
  const workspace = input.workspaceId ?? (input.directory ? Hash.fast(input.directory) : "")
  return `${input.sessionId}@${workspace}#${input.windowId}`
}

const sessionKey = (input: { sessionId: string; workspaceId?: string; directory?: string }) => {
  const workspace = input.workspaceId ?? (input.directory ? Hash.fast(input.directory) : "")
  return `${input.sessionId}@${workspace}`
}

/** Seconds of slack added on top of the request's own timeoutMs for transport. */
const TRANSPORT_MARGIN_MS = 5_000
const MAX_EVENTS = 200

type InterruptCause = "abort" | "superseded" | "transport"

type Outcome =
  | { readonly kind: "ok"; readonly response: BrokerResponseOk }
  | { readonly kind: "error"; readonly response: BrokerResponseError }
  | { readonly kind: "interrupted"; readonly cause: InterruptCause; readonly message: string }

interface Connection {
  registration: HostRegistration
  status: "live" | "superseded" | "dead"
  registeredAt: number
  lastSeenAt: number
  inFlight: Map<string, Deferred.Deferred<Outcome>>
}

export interface Interface {
  /** Register or re-register a host connection (last hello wins per stickiness key). */
  readonly register: (registration: HostRegistration) => Effect.Effect<HostHelloReply>
  /** Forward a broker request to the most recent matching live host connection. */
  readonly dispatch: (request: BrokerRequestInput, options?: { readonly signal?: AbortSignal }) => Effect.Effect<BrokerResponse>
  /** Fail the in-flight request with that id and fire the host's abort endpoint. */
  readonly abort: (requestId: string) => Effect.Effect<void>
  /** Record a host event (guest crash / state change / stopping / abort ack). */
  readonly pushEvent: (event: HostEvent) => Effect.Effect<void>
  /** Debug listing of registered connections (callback token redacted). */
  readonly list: () => Effect.Effect<ReadonlyArray<HostRegistrationInfo>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/BrowserHostBroker") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    // Keyed by stickiness key. Last hello wins per key.
    const connections = new Map<string, Connection>()
    // Keyed by `${sessionID}@${workspaceKey}` → stickiness keys, most recent last.
    const bySession = new Map<string, string[]>()
    const events: HostEvent[] = []

    const pushSessionKey = (key: string, stickiness: string) => {
      const list = bySession.get(key) ?? []
      if (!list.includes(stickiness)) list.push(stickiness)
      bySession.set(key, list)
    }

    const errorResponse = (requestId: string, error: BrokerError, startedAt: number): BrokerResponseError => ({
      ok: false,
      requestId,
      error,
      elapsedMs: Date.now() - startedAt,
    })

    const unavailable = (requestId: string, startedAt: number, details?: unknown): BrokerResponseError =>
      errorResponse(
        requestId,
        {
          tag: "BrowserHostUnavailable",
          message: "No live Desktop browser host is registered for this session.",
          retryable: true,
          ...(details === undefined ? {} : { details }),
        },
        startedAt,
      )

    const interrupted = (cause: InterruptCause, message: string): Outcome => ({ kind: "interrupted", cause, message })

    const markDead = (registration: HostRegistration) => {
      const key = stickinessKey(registration)
      const connection = connections.get(key)
      if (connection) connection.status = "dead"
    }

    const register = Effect.fn("BrowserHostBroker.register")(function* (registration: HostRegistration) {
      if (registration.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
        return {
          data: {
            accepted: false,
            brokerProtocolVersion: BROWSER_PROTOCOL_VERSION,
            hostId: registration.hostId,
          },
        }
      }

      const stickiness = stickinessKey(registration)
      const existing = connections.get(stickiness)
      // Same hostId + same connectionId = heartbeat/re-register (idempotent, revives a dead connection).
      if (
        existing &&
        existing.registration.hostId === registration.hostId &&
        existing.registration.connectionId === registration.connectionId
      ) {
        existing.registration = registration
        existing.status = "live"
        existing.lastSeenAt = Date.now()
        return { data: { accepted: true, brokerProtocolVersion: BROWSER_PROTOCOL_VERSION, hostId: registration.hostId } }
      }

      // New connectionId (or new host) supersedes the old connection: fail its in-flight requests.
      if (existing) {
        existing.status = "superseded"
        for (const deferred of existing.inFlight.values()) {
          yield* Deferred.succeed(deferred, interrupted("superseded", "Browser control was taken over by a newer host connection."))
        }
        existing.inFlight.clear()
      }

      connections.set(stickiness, {
        registration,
        status: "live",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
        inFlight: new Map(),
      })
      pushSessionKey(sessionKey(registration), stickiness)
      return {
        data: {
          accepted: true,
          brokerProtocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: registration.hostId,
          ...(existing !== undefined ? { replacement: true } : {}),
        },
      }
    })

    const resolveConnection = (request: BrokerRequestInput): Connection | undefined => {
      const workspace = request.workspaceId ?? (request.directory ? Hash.fast(request.directory) : "")
      const list = bySession.get(`${request.sessionId}@${workspace}`)
      if (!list || list.length === 0) return undefined
      // Most recent registration wins; prefer a connection whose active tab matches the request.
      for (const stickiness of [...list].reverse()) {
        const connection = connections.get(stickiness)
        if (!connection || connection.status !== "live") continue
        if (!request.tabId) return connection
        if (connection.registration.guest.activeTabId === request.tabId) return connection
      }
      for (const stickiness of [...list].reverse()) {
        const connection = connections.get(stickiness)
        if (connection && connection.status === "live") return connection
      }
      return undefined
    }

    const fireAbort = (registration: HostRegistration, requestId: string) =>
      HttpClientRequest.post(`${registration.callbackUrl}${BROKER_ABORT_PATH.replace(":requestId", encodeURIComponent(requestId))}`).pipe(
        HttpClientRequest.bearerToken(registration.callbackToken),
        HttpClientRequest.bodyJson({ requestId }),
        Effect.flatMap((request) => http.execute(request)),
        Effect.timeoutOrElse({ duration: Duration.seconds(2), orElse: () => Effect.void }),
        Effect.catch(() => Effect.void),
      )

    const dispatch = Effect.fn("BrowserHostBroker.dispatch")(function* (
      request: BrokerRequestInput,
      options: { readonly signal?: AbortSignal } = {},
    ) {
      const startedAt = Date.now()
      const requestId = request.requestId ?? crypto.randomUUID()
      const connection = resolveConnection(request)
      if (!connection) return unavailable(requestId, startedAt)

      const { registration } = connection
      const envelope: BrokerRequest = { ...request, requestId, windowId: registration.windowId }
      const deferred = yield* Deferred.make<Outcome>()
      connection.inFlight.set(requestId, deferred)

      const forward = HttpClientRequest.post(`${registration.callbackUrl}${BROKER_REQUEST_PATH}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(registration.callbackToken),
        HttpClientRequest.bodyJson(envelope),
        Effect.flatMap((httpRequest) => http.execute(httpRequest)),
        Effect.flatMap((response) => HttpClientResponse.schemaBodyJson(BrokerResponseSchema)(response)),
        Effect.map(
          (response): Outcome =>
            response.ok ? { kind: "ok", response } : { kind: "error", response },
        ),
        Effect.catch((cause) => {
          markDead(registration)
          const detail = cause instanceof Error ? cause.message : String(cause)
          return Effect.succeed(interrupted("transport", `Host transport failure: ${detail}`))
        }),
        Effect.timeoutOrElse({
          duration: Duration.millis(request.timeoutMs + TRANSPORT_MARGIN_MS),
          orElse: (): Effect.Effect<Outcome> => {
            markDead(registration)
            return Effect.succeed(interrupted("transport", "Host did not respond within the transport timeout."))
          },
        }),
      )

      const waitAbort =
        options.signal === undefined
          ? Effect.never
          : Effect.callback<Outcome>((resume) => {
              const signal = options.signal!
              const complete = () => resume(Effect.succeed(interrupted("abort", "Browser operation aborted.")))
              if (signal.aborted) {
                complete()
                return
              }
              const onAbort = () => {
                signal.removeEventListener("abort", onAbort)
                complete()
              }
              signal.addEventListener("abort", onAbort, { once: true })
              return Effect.sync(() => signal.removeEventListener("abort", onAbort))
            })

      const outcome = yield* Effect.raceAll([forward, waitAbort, Deferred.await(deferred)]).pipe(
        Effect.ensuring(Effect.sync(() => connection.inFlight.delete(requestId))),
      )

      if (outcome.kind === "ok") return outcome.response
      if (outcome.kind === "error") return outcome.response
      if (outcome.cause === "abort") {
        yield* fireAbort(registration, requestId)
        return errorResponse(
          requestId,
          { tag: "BrowserControlInterrupted", message: outcome.message, retryable: true },
          startedAt,
        )
      }
      if (outcome.cause === "superseded") {
        return errorResponse(
          requestId,
          { tag: "BrowserControlInterrupted", message: outcome.message, retryable: true },
          startedAt,
        )
      }
      return unavailable(requestId, startedAt, outcome.message)
    })

    const abort = Effect.fn("BrowserHostBroker.abort")(function* (requestId: string) {
      for (const connection of connections.values()) {
        const deferred = connection.inFlight.get(requestId)
        if (!deferred) continue
        connection.inFlight.delete(requestId)
        yield* Deferred.succeed(deferred, interrupted("abort", "Browser operation aborted."))
        yield* fireAbort(connection.registration, requestId)
        return
      }
    })

    const pushEvent = Effect.fn("BrowserHostBroker.pushEvent")(function* (event: HostEvent) {
      events.push(event)
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
      // Host stopping = the whole Desktop host process is going away; all its connections are dead.
      if (event.type === "host.stopping") {
        for (const connection of connections.values()) connection.status = "dead"
      }
      // Abort acknowledgements already resolved their in-flight request via `abort`; nothing else to fan out in v1.
      return
    })

    const list = Effect.fn("BrowserHostBroker.list")(function* () {
      const rows: HostRegistrationInfo[] = []
      for (const connection of connections.values()) {
        const { callbackToken: _token, ...rest } = connection.registration
        rows.push({ ...rest, status: connection.status, registeredAt: connection.registeredAt, lastSeenAt: connection.lastSeenAt })
      }
      return rows
    })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const connection of connections.values()) {
          for (const deferred of connection.inFlight.values()) {
            yield* Deferred.succeed(deferred, interrupted("superseded", "Broker shutting down."))
          }
          connection.inFlight.clear()
        }
        connections.clear()
        bySession.clear()
      }),
    )

    return Service.of({ register, dispatch, abort, pushEvent, list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient] })
