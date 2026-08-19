export * as BrowserHostBroker from "./host-broker"

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
 * This service owns the host registry (window-keyed, last-hello-wins,
 * idempotent heartbeat), the per-tab ownership mirror, in-flight request
 * tracking, request forwarding, abort propagation (ctx.abort → host abort
 * endpoint + BrowserControlInterrupted), host-event recording, and the
 * user-initiated `assign`/session-delete `orphanSession` paths. It lives in
 * core (not server) so BOTH the server handlers and the opencode tool loop
 * share one instance.
 *
 * Dependency note: this module must NOT import `@opencode-ai/protocol` (core
 * sits below protocol in the dependency order). The envelope shapes are
 * mirrored structurally; `packages/protocol/src/groups/browser.ts` is the wire
 * source of truth and the server handler decodes payloads into these plain
 * shapes. `packages/opencode/src/browser/broker-client.ts` maps the response
 * envelope error arm onto the typed `BrowserError` classes exported here.
 */

// --- wire mirror (protocol/src/groups/browser.ts) ---------------------------

export const BROWSER_PROTOCOL_VERSION = 2
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

/** A tab's owner — exactly one of `user` or `agent(<sessionId>)`. Two agents
 * never share a tab; the user may always reassign (see `assign`). */
export type HostOwner = { readonly kind: "user" } | { readonly kind: "agent"; readonly sessionId: string }

export interface HostHello {
  readonly protocolVersion: number
  readonly hostId: string
  readonly hostEpoch: number
  readonly connectionId: string
  readonly windowId: string
  readonly capabilities: HostCapabilities
  readonly guest: HostGuestState
}

/** Registration is session-agnostic: the browser is ONE shared instance owned
 * by the app window, never by a session. Registry keyed by window/hostId. */
export interface HostRegistration extends HostHello {
  readonly callbackUrl: string
  readonly callbackToken: string
}

export interface HostRegistrationInfo {
  readonly protocolVersion: number
  readonly hostId: string
  readonly hostEpoch: number
  readonly connectionId: string
  readonly windowId: string
  readonly capabilities: HostCapabilities
  readonly guest: HostGuestState
  readonly callbackUrl: string
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
  | { readonly type: "guest.stateChanged"; readonly tab: GuestTabState; readonly timestamp: string }
  | { readonly type: "host.stopping"; readonly timestamp: string }
  | { readonly type: "request.aborted"; readonly requestId: string; readonly timestamp: string }
  | { readonly type: "tab.closed"; readonly tabId: string; readonly timestamp: string }

/** Full wire tab state carried by `guest.stateChanged` events. */
export interface GuestTabState {
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  readonly controller: "human" | "agent" | "none"
  readonly zoomFactor: number
  readonly attached: boolean
  readonly owner: HostOwner
  readonly active: boolean
  readonly muted: boolean
}

/** One row of the FULL shared-host tab list (read is broad; control is scoped). */
export interface SessionTabInfo {
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly active: boolean
  readonly owner: HostOwner
  readonly muted: boolean
}

export interface ClaimInput {
  readonly tabId: string
  readonly timeoutMs?: number
}
export interface ClaimOutput {
  readonly claimed: { readonly tabId: string; readonly owner: HostOwner }
}
/** Broker-minted control op (from user-initiated `assign`); never an agent tool. */
export interface SetTabOwnerInput {
  readonly tabId: string
  readonly owner: HostOwner
}
export interface SetTabOwnerOutput {
  readonly assigned: { readonly tabId: string; readonly owner: HostOwner }
}
export interface AssignResult {
  readonly tabId: string
  readonly owner: HostOwner
}

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

// --- error prose (shared by the typed defaults and dispatch fast-fails) -------

export const TAB_NOT_FOUND_MESSAGE = "This session has no browser tab. Call browser_open to create a tab for this session."
export const PERMISSION_DENIED_MESSAGE =
  "This browser tab belongs to another session (or to the user). You may not control it. Claim a user tab with browser_claim, or open your own."
export const PERMISSION_DENIED_USER_MESSAGE =
  "This browser tab belongs to the user. Claim it with browser_open { tabId, claim: true } or browser_claim."
export const PERMISSION_DENIED_OTHER_MESSAGE = "This browser tab belongs to another session."
export const HOST_UNAVAILABLE_MESSAGE = "No live Desktop browser host is registered. Call browser_open to re-establish the browser."

const ErrorDefaults: Record<BrowserErrorTag, { readonly retryable: boolean; readonly message: string }> = {
  BrowserHostUnavailable: {
    retryable: true,
    message: HOST_UNAVAILABLE_MESSAGE,
  },
  BrowserProtocolMismatch: {
    retryable: false,
    message: "The browser host speaks an incompatible broker protocol version and must be restarted.",
  },
  BrowserTabNotFound: { retryable: true, message: TAB_NOT_FOUND_MESSAGE },
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
    message: PERMISSION_DENIED_MESSAGE,
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

/** Mirrored tab state for routing/enforcement. Keyed `${windowId}#${tabId}`.
 * The host is the source of truth (events + open responses); this mirror is the
 * routing + ownership cache. `lastActiveAt` drives the multi-tab default
 * (most-recently-active owned tab). */
export interface TabRecord {
  readonly windowId: string
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  readonly controller: "human" | "agent" | "none"
  readonly zoomFactor: number
  readonly attached: boolean
  readonly active: boolean
  readonly muted: boolean
  readonly owner: HostOwner
  readonly lastActiveAt: number
}

const tabKey = (windowId: string, tabId: string) => `${windowId}#${tabId}`

// --- pure ownership helpers (unit-tested; shared with the desktop engine) -----

/** Can this session dispatch to a tab with this owner? (O1/O2/O3) */
export const canDispatch = (owner: HostOwner, sessionId: string): "ok" | "other-agent" | "user-owned" => {
  if (owner.kind === "user") return "user-owned"
  return owner.sessionId === sessionId ? "ok" : "other-agent"
}

/** Can this session claim a tab with this owner? (O4/O5/O6) */
export const canClaim = (owner: HostOwner, sessionId: string): "ok" | "idempotent" | "denied" => {
  if (owner.kind === "user") return "ok"
  return owner.sessionId === sessionId ? "idempotent" : "denied"
}

/** Release every tab owned by `sessionId` to the user (session-delete orphan, O10). */
export const orphanOwnedTabs = (tabs: readonly TabRecord[], sessionId: string): readonly TabRecord[] =>
  tabs.map((tab) =>
    tab.owner.kind === "agent" && tab.owner.sessionId === sessionId
      ? { ...tab, owner: { kind: "user" } as const }
      : tab,
  )

/** This session's owned tabs in the window, most-recently-active first. */
export const sessionTabs = (
  tabs: readonly TabRecord[],
  windowId: string,
  sessionId: string,
): readonly TabRecord[] =>
  [...tabs]
    .filter((tab) => tab.windowId === windowId && tab.owner.kind === "agent" && tab.owner.sessionId === sessionId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

// --- pure dispatch resolution (design §4; unit-tested without HTTP) -----------

export type ResolveDispatchInput = {
  readonly request: BrokerRequestInput
  readonly windowId: string | undefined
  readonly tabs: readonly TabRecord[]
}

export type ResolveDispatchResult =
  | { readonly kind: "forward"; readonly windowId: string; readonly tabId?: string; readonly rewrite?: BrokerOperation }
  | { readonly kind: "error"; readonly tag: BrowserErrorTag; readonly message: string }

const errorResult = (tag: BrowserErrorTag, message: string): ResolveDispatchResult => ({ kind: "error", tag, message })

/** Window → tab → ownership resolution for an AGENT dispatch. `assign` is a
 * separate user-initiated path (`assign` below). */
export const resolveDispatch = (input: ResolveDispatchInput): ResolveDispatchResult => {
  const { request, windowId, tabs } = input
  if (windowId === undefined) return errorResult("BrowserHostUnavailable", HOST_UNAVAILABLE_MESSAGE)
  const windowTabs = tabs.filter((tab) => tab.windowId === windowId)

  // (1) open: claim-and-navigate, or reuse-or-create (D5/D6)
  if (request.operation.name === "open") {
    const openInput = request.operation.input as { tabId?: string; claim?: boolean; newTab?: boolean; url: string; waitUntil?: string }
    if (openInput.tabId !== undefined) {
      const tab = windowTabs.find((t) => t.tabId === openInput.tabId)
      if (!tab) return errorResult("BrowserTabNotFound", TAB_NOT_FOUND_MESSAGE)
      const gate = canDispatch(tab.owner, request.sessionId)
      if (gate === "other-agent") return errorResult("BrowserPermissionDenied", PERMISSION_DENIED_OTHER_MESSAGE)
      if (gate === "user-owned" && openInput.claim !== true) return errorResult("BrowserPermissionDenied", PERMISSION_DENIED_USER_MESSAGE)
      // own agent tab, or user tab with claim → host flips owner (claim) then navigates
      return { kind: "forward", windowId, tabId: tab.tabId }
    }
    if (!openInput.newTab) {
      const owned = sessionTabs(tabs, windowId, request.sessionId)
      if (owned.length > 0) {
        const target = owned[0]!
        const rewrite: BrokerOperation = {
          name: "navigate",
          input: openInput.waitUntil ? { url: openInput.url, waitUntil: openInput.waitUntil } : { url: openInput.url },
        }
        return { kind: "forward", windowId, tabId: target.tabId, rewrite }
      }
    }
    // create: forward open as-is; host sets owner = agent(sessionId) on the new tab
    return { kind: "forward", windowId }
  }

  // (2) claim: explicit, first-come-wins (D6)
  if (request.operation.name === "claim") {
    const claimInput = request.operation.input as { tabId: string }
    const tab = windowTabs.find((t) => t.tabId === claimInput.tabId)
    if (!tab) return errorResult("BrowserTabNotFound", TAB_NOT_FOUND_MESSAGE)
    const gate = canClaim(tab.owner, request.sessionId)
    if (gate === "denied") return errorResult("BrowserPermissionDenied", PERMISSION_DENIED_OTHER_MESSAGE)
    // own agent tab → idempotent; user/unowned → host flips (first-come-wins)
    return { kind: "forward", windowId, tabId: tab.tabId }
  }

  // (3) status: host-level forward; broker enriches the full tab list after
  if (request.operation.name === "status") {
    return { kind: "forward", windowId }
  }

  // (4) tab-resolving ops: explicit tabId verified to belong to the session,
  //     else default to the session's most-recently-active owned tab (O7/D10)
  return resolveOwnedTab(request, windowId, windowTabs)
}

export const resolveOwnedTab = (
  request: BrokerRequestInput,
  windowId: string,
  windowTabs: readonly TabRecord[],
): ResolveDispatchResult => {
  if (request.tabId !== undefined) {
    const tab = windowTabs.find((t) => t.tabId === request.tabId)
    if (!tab) return errorResult("BrowserTabNotFound", TAB_NOT_FOUND_MESSAGE)
    const gate = canDispatch(tab.owner, request.sessionId)
    if (gate === "other-agent") return errorResult("BrowserPermissionDenied", PERMISSION_DENIED_OTHER_MESSAGE)
    if (gate === "user-owned") return errorResult("BrowserPermissionDenied", PERMISSION_DENIED_USER_MESSAGE)
    return { kind: "forward", windowId, tabId: tab.tabId }
  }
  const owned = sessionTabs([...windowTabs], windowId, request.sessionId)
  if (owned.length === 0) return errorResult("BrowserTabNotFound", TAB_NOT_FOUND_MESSAGE)
  return { kind: "forward", windowId, tabId: owned[0]!.tabId }
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
  /** Register or re-register a host connection (last hello wins per windowId). */
  readonly register: (registration: HostRegistration) => Effect.Effect<HostHelloReply>
  /** Forward a broker request to the host: resolve window → tab → ownership (design §4). */
  readonly dispatch: (request: BrokerRequestInput, options?: { readonly signal?: AbortSignal }) => Effect.Effect<BrokerResponse>
  /** Fail the in-flight request with that id and fire the host's abort endpoint. */
  readonly abort: (requestId: string) => Effect.Effect<void>
  /** Record a host event (guest crash / state change / stopping / abort ack / tab closed). */
  readonly pushEvent: (event: HostEvent) => Effect.Effect<void>
  /** Debug listing of registered connections (callback token redacted). */
  readonly list: () => Effect.Effect<ReadonlyArray<HostRegistrationInfo>>
  /** The FULL shared-host tab list (D5) — every window's tabs with owner. */
  readonly listTabs: () => Effect.Effect<ReadonlyArray<SessionTabInfo>>
  /** User-initiated ownership change (D7): set a tab's owner to ANY value (user
   * or any agent session) and mint a `set_tab_owner` control op to the host. */
  readonly assign: (tabId: string, owner: HostOwner) => Effect.Effect<AssignResult, BrowserErrorClass>
  /** Session-delete orphan (D10): flip every `agent(sessionId)` tab to user. */
  readonly orphanSession: (sessionId: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/BrowserHostBroker") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    // Keyed by windowId (D1 — one shared host per window, session-agnostic).
    const connections = new Map<string, Connection>()
    // Tab mirror: keyed `${windowId}#${tabId}` — routing + ownership cache.
    const tabs = new Map<string, TabRecord>()
    const events: HostEvent[] = []

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
          message: HOST_UNAVAILABLE_MESSAGE,
          retryable: true,
          ...(details === undefined ? {} : { details }),
        },
        startedAt,
      )

    const interrupted = (cause: InterruptCause, message: string): Outcome => ({ kind: "interrupted", cause, message })

    const markDead = (registration: HostRegistration) => {
      const connection = connections.get(registration.windowId)
      if (connection) connection.status = "dead"
    }

    const liveWindowId = (): string | undefined => {
      for (const connection of connections.values()) if (connection.status === "live") return connection.registration.windowId
      return undefined
    }

    // --- tab mirror helpers ----------------------------------------------------

    const upsertTab = (windowId: string, state: GuestTabState, lastActiveAt?: number) => {
      const existing = tabs.get(tabKey(windowId, state.tabId))
      tabs.set(tabKey(windowId, state.tabId), {
        windowId,
        tabId: state.tabId,
        url: state.url,
        title: state.title,
        readyState: state.readyState,
        controller: state.controller,
        zoomFactor: state.zoomFactor,
        attached: state.attached,
        active: state.active,
        muted: state.muted,
        owner: state.owner,
        lastActiveAt: state.active ? Date.now() : existing?.lastActiveAt ?? lastActiveAt ?? Date.now(),
      })
    }

    const findTabByTabId = (tabId: string): TabRecord | undefined => {
      for (const record of tabs.values()) if (record.tabId === tabId) return record
      return undefined
    }

    /** register()'s `guest.activeTabId` marks the active tab in the mirror. */
    const syncGuestSnapshot = (registration: HostRegistration) => {
      const activeTabId = registration.guest.activeTabId
      for (const record of [...tabs.values()]) {
        if (record.windowId !== registration.windowId) continue
        const active = record.tabId === activeTabId
        if (active !== record.active) {
          tabs.set(tabKey(record.windowId, record.tabId), { ...record, active, lastActiveAt: active ? Date.now() : record.lastActiveAt })
        }
      }
    }

    /** Optimistic mirror of a freshly created tab (open response; events refine). */
    const mirrorOpenTab = (opened: Record<string, unknown>, sessionId: string, windowId: string) => {
      const tabId = typeof opened["tabId"] === "string" ? opened["tabId"] : ""
      if (!tabId) return
      upsertTab(
        windowId,
        {
          tabId,
          url: typeof opened["url"] === "string" ? opened["url"] : "",
          title: typeof opened["title"] === "string" ? opened["title"] : "",
          readyState: "Success",
          controller: "none",
          zoomFactor: 1,
          attached: true,
          active: true,
          muted: false,
          owner: { kind: "agent", sessionId },
        },
        Date.now(),
      )
    }

    const sessionTabInfosForWindow = (windowId: string): SessionTabInfo[] =>
      [...tabs.values()]
        .filter((record) => record.windowId === windowId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((record) => ({
          tabId: record.tabId,
          url: record.url,
          title: record.title,
          active: record.active,
          owner: record.owner,
          muted: record.muted,
        }))

    const isHostOwner = (value: unknown): value is HostOwner => {
      if (typeof value !== "object" || value === null) return false
      const kind = (value as { kind?: unknown }).kind
      if (kind === "user") return true
      return kind === "agent" && typeof (value as { sessionId?: unknown }).sessionId === "string"
    }

    /** The open-reuse rewrite: a navigate response normalized into OpenOutput shape. */
    const normalizeOpenFromNavigate = (navResult: unknown, tabId: string, sessionId: string): unknown => {
      const navigated = (((navResult ?? {}) as Record<string, unknown>)["navigated"] as Record<string, unknown> | undefined) ?? {}
      return {
        opened: {
          tabId: typeof navigated["tabId"] === "string" ? navigated["tabId"] : tabId,
          url: typeof navigated["url"] === "string" ? navigated["url"] : "",
          title: typeof navigated["title"] === "string" ? navigated["title"] : "",
          readyState: typeof navigated["readyState"] === "string" ? navigated["readyState"] : "Success",
          viewport: navigated["viewport"],
          owner: { kind: "agent", sessionId },
        },
      }
    }

    // --- register (window-keyed; last hello wins per windowId) -----------------

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

      const existing = connections.get(registration.windowId)
      // Same hostId + same connectionId = heartbeat/re-register (idempotent, revives a dead connection).
      if (
        existing &&
        existing.registration.hostId === registration.hostId &&
        existing.registration.connectionId === registration.connectionId
      ) {
        existing.registration = registration
        existing.status = "live"
        existing.lastSeenAt = Date.now()
        syncGuestSnapshot(registration)
        return { data: { accepted: true, brokerProtocolVersion: BROWSER_PROTOCOL_VERSION, hostId: registration.hostId } }
      }

      // New connectionId (or new host) for this window supersedes the old connection.
      if (existing) {
        existing.status = "superseded"
        for (const deferred of existing.inFlight.values()) {
          yield* Deferred.succeed(deferred, interrupted("superseded", "Browser control was taken over by a newer host connection."))
        }
        existing.inFlight.clear()
      }

      connections.set(registration.windowId, {
        registration,
        status: "live",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
        inFlight: new Map(),
      })
      syncGuestSnapshot(registration)
      return {
        data: {
          accepted: true,
          brokerProtocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: registration.hostId,
          ...(existing !== undefined ? { replacement: true } : {}),
        },
      }
    })

    /** v1: the single live window (prefer the window of the session's
     * most-recently-active owned tab; else the most recent live registration). */
    const resolveWindow = (request: BrokerRequestInput): Connection | undefined => {
      const live = [...connections.values()].filter((connection) => connection.status === "live")
      if (live.length === 0) return undefined
      const sessionOwned = [...tabs.values()]
        .filter((record) => record.owner.kind === "agent" && record.owner.sessionId === request.sessionId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      if (sessionOwned.length > 0) {
        const connection = connections.get(sessionOwned[0]!.windowId)
        if (connection && connection.status === "live") return connection
      }
      return live[live.length - 1]!
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
      const connection = resolveWindow(request)
      if (!connection) return unavailable(requestId, startedAt)

      const windowId = connection.registration.windowId
      const resolution = resolveDispatch({ request, windowId, tabs: [...tabs.values()] })
      if (resolution.kind === "error") {
        return errorResponse(
          requestId,
          { tag: resolution.tag, message: resolution.message, retryable: resolution.tag === "BrowserTabNotFound" },
          startedAt,
        )
      }

      const { registration } = connection
      const envelope: BrokerRequest = {
        ...request,
        requestId,
        windowId,
        ...(resolution.tabId !== undefined ? { tabId: resolution.tabId } : {}),
        ...(resolution.rewrite !== undefined ? { operation: resolution.rewrite } : {}),
      }
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

      if (outcome.kind === "ok") {
        // Post-processing: status tab-list enrichment, open reuse/create mirroring, claim mirror sync.
        const response = outcome.response
        const result = (response.result ?? {}) as Record<string, unknown>
        if (request.operation.name === "status") {
          return { ...response, result: { ...result, tabs: sessionTabInfosForWindow(windowId) } }
        }
        if (request.operation.name === "open") {
          if (resolution.rewrite !== undefined && resolution.tabId !== undefined) {
            return { ...response, result: normalizeOpenFromNavigate(response.result, resolution.tabId, request.sessionId) }
          }
          const opened = result["opened"] as Record<string, unknown> | undefined
          if (opened !== undefined) mirrorOpenTab(opened, request.sessionId, windowId)
        }
        if (request.operation.name === "claim") {
          const claimed = result["claimed"] as { tabId?: unknown; owner?: unknown } | undefined
          if (claimed !== undefined && typeof claimed.tabId === "string" && isHostOwner(claimed.owner)) {
            const existing = findTabByTabId(claimed.tabId)
            if (existing) {
              tabs.set(tabKey(existing.windowId, existing.tabId), { ...existing, owner: claimed.owner, lastActiveAt: Date.now() })
            }
          }
        }
        return response
      }
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
      // Mirror sync: stateChanged upserts the row; crashed / tab.closed remove it.
      if (event.type === "guest.stateChanged") {
        const existing = findTabByTabId(event.tab.tabId)
        const windowId = existing?.windowId ?? liveWindowId()
        if (windowId !== undefined) upsertTab(windowId, event.tab)
        return
      }
      if (event.type === "tab.closed" || event.type === "guest.crashed") {
        const existing = findTabByTabId(event.tabId)
        if (existing) tabs.delete(tabKey(existing.windowId, existing.tabId))
        return
      }
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

    /** The FULL shared-host tab list (D5) — every window's tabs with owner. */
    const listTabs = Effect.fn("BrowserHostBroker.listTabs")(function* () {
      return [...tabs.values()]
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map((record) => ({
          tabId: record.tabId,
          url: record.url,
          title: record.title,
          active: record.active,
          owner: record.owner,
          muted: record.muted,
        }))
    })

    /** Best-effort mint of a broker control op (set_tab_owner) to the host. */
    const forwardControl = (registration: HostRegistration, operation: BrokerOperation) =>
      HttpClientRequest.post(`${registration.callbackUrl}${BROKER_REQUEST_PATH}`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(registration.callbackToken),
        HttpClientRequest.bodyJson({
          requestId: crypto.randomUUID(),
          sessionId: "",
          windowId: registration.windowId,
          messageId: "",
          operation,
          timeoutMs: 5_000,
        } as BrokerRequest),
        Effect.flatMap((httpRequest) => http.execute(httpRequest)),
        Effect.timeoutOrElse({ duration: Duration.seconds(2), orElse: () => Effect.void }),
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      )

    /** User-initiated ownership change (D7): ANY owner the user picks. */
    const assign = Effect.fn("BrowserHostBroker.assign")(function* (tabId: string, owner: HostOwner) {
      const record = findTabByTabId(tabId)
      if (!record) return yield* new BrowserTabNotFoundError({ message: "This tab does not exist.", retryable: true })
      const connection = connections.get(record.windowId)
      if (connection && connection.status === "live") {
        yield* forwardControl(connection.registration, { name: "set_tab_owner", input: { tabId, owner } })
      }
      tabs.set(tabKey(record.windowId, record.tabId), { ...record, owner, lastActiveAt: Date.now() })
      return { tabId, owner }
    })

    /** Session-delete orphan (D10): flip every agent(sessionId) tab to user. */
    const orphanSession = Effect.fn("BrowserHostBroker.orphanSession")(function* (sessionId: string) {
      const owned = [...tabs.values()].filter((record) => record.owner.kind === "agent" && record.owner.sessionId === sessionId)
      for (const record of owned) {
        const owner: HostOwner = { kind: "user" }
        const connection = connections.get(record.windowId)
        if (connection && connection.status === "live") {
          yield* forwardControl(connection.registration, { name: "set_tab_owner", input: { tabId: record.tabId, owner } })
        }
        tabs.set(tabKey(record.windowId, record.tabId), { ...record, owner })
      }
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
        tabs.clear()
      }),
    )

    return Service.of({ register, dispatch, abort, pushEvent, list, listTabs, assign, orphanSession })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient] })
