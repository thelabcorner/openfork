// Typed runtime event/error contracts for the Claude Agent Runtime.
//
// TransportEvent mirrors the Agent SDK message stream (system/assistant/
// user/result/stream_event) with an explicit unknown passthrough so new SDK
// event kinds decode forward-compatibly. RuntimeEvent is the lifecycle
// envelope consumers subscribe to. Decoding never throws; unrecognized
// payloads are fenced with a redacted preview.

import { sanitizeDetail } from "./errors"

// ── Transport events (SDK message shapes, loosely validated) ──

export interface UsageBlock {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

export type ContentBlock =
  | { readonly type: "text"; readonly text?: string }
  | { readonly type: "thinking"; readonly thinking?: string }
  | { readonly type: "tool_use"; readonly id?: string; readonly name?: string; readonly input?: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id?: string; readonly content?: unknown; readonly is_error?: boolean }
  | { readonly type: string; readonly [key: string]: unknown }

export interface SystemInitEvent {
  readonly type: "system"
  readonly subtype: "init"
  readonly session_id?: string
  readonly model?: string
  readonly cwd?: string
  readonly tools?: readonly string[]
}

export interface AssistantEvent {
  readonly type: "assistant"
  readonly session_id?: string
  readonly message?: {
    readonly id?: string
    readonly model?: string
    readonly content?: readonly ContentBlock[]
    readonly usage?: UsageBlock
  }
}

export interface UserEvent {
  readonly type: "user"
  readonly session_id?: string
  readonly message?: {
    readonly content?: readonly ContentBlock[]
  }
}

export interface ResultEvent {
  readonly type: "result"
  readonly subtype?: string
  readonly session_id?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly duration_ms?: number
  readonly num_turns?: number
  readonly total_cost_usd?: number
  readonly usage?: UsageBlock
}

/** Partial streaming delta (includePartialMessages). Payload stays opaque. */
export interface StreamEvent {
  readonly type: "stream_event"
  readonly session_id?: string
  readonly event?: unknown
}

/** Forward-compatible passthrough for unrecognized SDK event kinds. */
export interface UnknownTransportEvent {
  readonly type: string
  /** Redacted, bounded preview of the unrecognized payload. */
  readonly preview?: string
}

export type TransportEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamEvent
  | UnknownTransportEvent

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Decode one raw SDK message into a typed TransportEvent. Never throws:
 * non-objects and unrecognized types become UnknownTransportEvent with a
 * sanitized preview.
 */
export function decodeTransportEvent(raw: unknown): TransportEvent {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return { type: "unknown", preview: sanitizeDetail(safeJson(raw), 200) }
  }
  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") {
        return {
          type: "system",
          subtype: "init",
          session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
          model: typeof raw.model === "string" ? raw.model : undefined,
          cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
          tools: Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === "string") : undefined,
        }
      }
      return { type: "unknown", preview: sanitizeDetail(`system/${String(raw.subtype ?? "?")}`, 200) }
    case "assistant":
      return {
        type: "assistant",
        session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
        message: readMessage(raw.message),
      }
    case "user":
      return {
        type: "user",
        session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
        message: readMessage(raw.message),
      }
    case "result":
      return {
        type: "result",
        subtype: typeof raw.subtype === "string" ? raw.subtype : undefined,
        session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
        is_error: typeof raw.is_error === "boolean" ? raw.is_error : undefined,
        result: typeof raw.result === "string" ? raw.result : undefined,
        duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
        num_turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
        total_cost_usd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
        usage: isRecord(raw.usage) ? readUsage(raw.usage) : undefined,
      }
    case "stream_event":
      return {
        type: "stream_event",
        session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
        event: raw.event,
      }
    default:
      return { type: raw.type, preview: sanitizeDetail(safeJson(raw), 200) }
  }
}

function readMessage(value: unknown): AssistantEvent["message"] | UserEvent["message"] {
  if (!isRecord(value)) return undefined
  const content = Array.isArray(value.content)
    ? value.content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string")
    : undefined
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    content,
    usage: isRecord(value.usage) ? readUsage(value.usage) : undefined,
  }
}

function readUsage(value: Record<string, unknown>): UsageBlock {
  return {
    input_tokens: typeof value.input_tokens === "number" ? value.input_tokens : undefined,
    output_tokens: typeof value.output_tokens === "number" ? value.output_tokens : undefined,
    cache_read_input_tokens: typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : undefined,
    cache_creation_input_tokens: typeof value.cache_creation_input_tokens === "number" ? value.cache_creation_input_tokens : undefined,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ── Runtime events (lifecycle envelope) ──

export type RuntimeEvent =
  | { readonly kind: "started"; readonly turnID: string }
  | { readonly kind: "transport"; readonly turnID: string; readonly event: TransportEvent }
  | { readonly kind: "stalled"; readonly turnID: string; readonly stallMs: number }
  | { readonly kind: "timedOut"; readonly turnID: string; readonly timeoutMs: number }
  | { readonly kind: "cancelled"; readonly turnID: string }
  | { readonly kind: "disposed"; readonly turnID: string }
  | { readonly kind: "completed"; readonly turnID: string }
  | { readonly kind: "failed"; readonly turnID: string; readonly category: string; readonly message: string }

export type RuntimeEventSink = (event: RuntimeEvent) => void

export * as ClaudeEvents from "./events"
