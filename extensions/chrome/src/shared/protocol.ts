// Shared protocol constants + types for extension <-> native host.
// Mirrors packages/desktop/src/main/browser/contracts.ts and research framing specs.

// ---------------------------------------------------------------------------
// Native messaging framing limits (chromium.googlesource.com native_message_process_host.cc)
// - host -> extension (native host stdout -> Chrome): 1 MiB max
// - extension -> host (Chrome stdin -> host): 64 MiB max (legacy doc says 4 GiB, newer cap 64 MiB)
export const NATIVE_HOST_NAME = "com.opencode.desktop"
export const NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES = 1 * 1024 * 1024 // 1 MiB
export const NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES = 64 * 1024 * 1024 // 64 MiB
export const NATIVE_MESSAGE_HEADER_BYTES = 4 // 32-bit LE length prefix
export const NATIVE_MESSAGE_READ_BUFFER_BYTES = 4096

// Browser protocol alignment — must stay byte-identical to contracts.ts
export const BROWSER_PROTOCOL_VERSION = 2
export const BROKER_REQUEST_PATH = "/v1/browser/request"
export const BROKER_ABORT_PATH = "/v1/browser/request/:requestId/abort"

// ---------------------------------------------------------------------------
// Broker envelope shapes (byte-identical to contracts.ts BrokerRequest/BrokerResponse)

export type BrokerOperationName =
  | "status"
  | "open"
  | "claim"
  | "set_tab_owner"
  | "navigate"
  | "resize"
  | "set_appearance"
  | "snapshot"
  | "screenshot"
  | "visual_capture"
  | "visual_diff"
  | "visual_record"
  | "visual_history"
  | "visual_artifact"
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "evaluate"
  | "wait_for"
  | "recording_start"
  | "recording_stop"
  | "close"
  | "highlight"
  | "annotate"
  | "query"
  | "profiler_start"
  | "profiler_stop"
  | "react_inspect"
  | "refresh"
  | "duplicate"
  | "set_muted"
  | "open_devtools"
  | "hard_reload"
  | "clear_cookies"
  | "clear_cache"
  | "extensions_list"
  | "extension_set_enabled"

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

export interface BrokerRequest {
  requestId: string
  sessionId: string
  windowId: string
  workspaceId?: string
  directory?: string
  messageId: string
  toolCallId?: string
  tabId?: string
  operation: { name: BrokerOperationName; input: unknown }
  timeoutMs: number
}

export interface BrokerResponseSuccess {
  ok: true
  requestId: string
  result: Record<string, unknown>
  elapsedMs: number
  snapshotAfter?: unknown
}

export interface BrokerResponseErrorBody {
  tag: BrowserErrorTag
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface BrokerResponseFailure {
  ok: false
  requestId: string
  error: BrokerResponseErrorBody
  elapsedMs: number
}

export type BrokerResponse = BrokerResponseSuccess | BrokerResponseFailure

// ---------------------------------------------------------------------------
// Native-messaging envelope (extension <-> host stdio framing).
// Each message is JSON UTF-8 with a 32-bit LE length prefix; the JSON payload
// itself is one of these discriminated unions. Small control frames only —
// large payloads (screenshots >1 MiB) must use the HTTP broker path.

export type NativeMessageDirection = "ext->host" | "host->ext"

// Extension -> host
export type ExtToHostMessage =
  | { type: "hello"; extensionId: string; version: string; capabilities: string[] }
  | { type: "request"; request: BrokerRequest }
  | { type: "abort"; requestId: string }
  | { type: "event"; event: unknown }
  | { type: "ping"; nonce: string }
  | { type: "artifact_rpc"; request: unknown }

// Host -> extension
export type HostToExtMessage =
  | { type: "hello_ack"; accepted: boolean; reason?: string; hostId?: string }
  | { type: "response"; response: BrokerResponse }
  | { type: "event_ack"; ok: boolean }
  | { type: "pong"; nonce: string }
  | { type: "error"; code: BrowserErrorTag; message: string; requestId?: string }
  | { type: "artifact_rpc_result"; response: unknown }

// ---------------------------------------------------------------------------
// WS fallback envelope (mirrors @vymalo/opencode-browser hello/ready/command/result/event/ping/pong)
// Transport: ws://127.0.0.1:<ephemeral>/extension  (ephemeral port from sidecar hello reply)
// Auth: Bearer <callbackToken> over WS subprotocol or first-frame hello token. Primary remains nativeMessaging.

export type WsFrame =
  | { type: "hello"; token: string; extensionId: string; version: string }
  | { type: "ready"; hostId: string; protocolVersion: number }
  | { type: "command"; request: BrokerRequest }
  | { type: "result"; response: BrokerResponse }
  | { type: "event"; event: unknown }
  | { type: "ping"; nonce: string }
  | { type: "pong"; nonce: string }

// ---------------------------------------------------------------------------
// Validation helpers (pure, unit-tested)

const OPERATION_NAMES: readonly BrokerOperationName[] = [
  "status",
  "open",
  "claim",
  "set_tab_owner",
  "navigate",
  "resize",
  "set_appearance",
  "snapshot",
  "screenshot",
  "visual_capture",
  "visual_diff",
  "visual_record",
  "visual_history",
  "visual_artifact",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "wait_for",
  "recording_start",
  "recording_stop",
  "close",
  "highlight",
  "annotate",
  "query",
  "profiler_start",
  "profiler_stop",
  "react_inspect",
  "refresh",
  "duplicate",
  "set_muted",
  "open_devtools",
  "hard_reload",
  "clear_cookies",
  "clear_cache",
  "extensions_list",
  "extension_set_enabled",
]

export const isBrokerOperationName = (value: unknown): value is BrokerOperationName =>
  typeof value === "string" && (OPERATION_NAMES as readonly string[]).includes(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isBrokerRequest = (value: unknown): value is BrokerRequest => {
  if (!isRecord(value)) return false
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return false
  if (typeof value.windowId !== "string" || value.windowId.length === 0) return false
  if (typeof value.messageId !== "string" || value.messageId.length === 0) return false
  if (value.workspaceId !== undefined && typeof value.workspaceId !== "string") return false
  if (value.directory !== undefined && typeof value.directory !== "string") return false
  if (value.toolCallId !== undefined && typeof value.toolCallId !== "string") return false
  if (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0) return false
  if (!isRecord(value.operation)) return false
  if (!isBrokerOperationName((value.operation as Record<string, unknown>).name)) return false
  if (!("input" in value.operation)) return false
  if (value.tabId !== undefined && typeof (value as Record<string, unknown>).tabId !== "string") return false
  return true
}
