/**
 * LACE v14.7 V1 provenance adapter for candidate (NOT active) shadow contexts.
 *
 * V1 owns message semantics. This adapter intentionally refuses to synthesize
 * System authority, summarize Goal STATE, or reinterpret tool-call causality.
 * The caller must provide already-rendered model-visible message text and an
 * independently authenticated revision. No history is mutated or removed.
 */
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  buildShadowProjection,
  type ProjectionChoice,
  type ShadowProjection,
} from "./lace-shadow-projection"

export type V1ShadowDisposition =
  | "candidate-assistant-text"
  | "protected-human-or-host-turn"
  | "reproject-authoritative-state"
  | "protected-tool-causality"
  | "protected-reasoning"
  | "protected-multimodal"
  | "protected-checkpoint"
  | "protected-unsettled"
  | "protected-provider-metadata"
  | "protected-unknown"

export interface V1ShadowClassification {
  readonly messageID: string
  readonly disposition: V1ShadowDisposition
  readonly mustStayRaw: boolean
  readonly reprojectFromOwner: boolean
}

/** Only text-only, non-summary assistant responses can be compression candidates. */
export function classifyV1ShadowMessage(message: SessionV1.WithParts): V1ShadowClassification {
  const messageID = message.info.id
  let disposition: V1ShadowDisposition
  if (SessionTurnProvenance.hasStateSemanticsTurn(message)) {
    disposition = "reproject-authoritative-state"
  } else if (message.info.role === "user") {
    // Provider role does not reveal owner; both human objectives and host
    // Synthetic/Shell/Compaction turns must remain exact by default.
    disposition = "protected-human-or-host-turn"
  } else if (message.info.summary || message.info.error) {
    disposition = "protected-checkpoint"
  } else if (message.parts.some((part) => part.type === "reasoning")) {
    disposition = "protected-reasoning"
  } else if (message.parts.some((part) => part.type === "tool")) {
    // Even completed tool calls may contain essential causal receipts or
    // provider-native tool call/result pairs. Do not compress them in v14.7.
    disposition = "protected-tool-causality"
  } else if (message.parts.some((part) => part.type !== "text")) {
    disposition = "protected-multimodal"
  } else if (message.info.role === "assistant" && message.info.finish !== "end_turn") {
    // Never project partial/errored/interrupted assistant messages into an
    // externally supplied abstraction, even if their current parts are text.
    disposition = "protected-unsettled"
  } else if (message.parts.some((part) => part.type === "text" && (
    part.synthetic === true || part.ignored === true ||
    (part.metadata !== undefined && Object.keys(part.metadata).length > 0) ||
    ("providerMetadata" in part && part.providerMetadata !== undefined) ||
    ("providerOptions" in part && part.providerOptions !== undefined)
  ))) {
    // Historical text parts can embed opaque provider continuation state or
    // host-only markers. Unknown metadata is not safe to abstract by default.
    disposition = "protected-provider-metadata"
  } else if (message.info.role === "assistant" && message.parts.length > 0 &&
    message.parts.every((part) => part.type === "text")) {
    disposition = "candidate-assistant-text"
  } else {
    disposition = "protected-unknown"
  }
  return {
    messageID,
    disposition,
    mustStayRaw: disposition !== "candidate-assistant-text",
    reprojectFromOwner: disposition === "reproject-authoritative-state",
  }
}

export interface V1ShadowInput {
  readonly messages: ReadonlyArray<SessionV1.WithParts>
  /** Exact render + revision are supplied by the existing V1 context owner. */
  readonly sources: ReadonlyArray<{ readonly messageID: string; readonly renderedText: string; readonly revision: string }>
  readonly choices: ReadonlyArray<ProjectionChoice>
  readonly maxCharacters: number
}

export function projectV1ShadowCandidate(input: V1ShadowInput): ShadowProjection {
  if (input.messages.length !== input.sources.length) {
    throw new Error("V1 shadow sources must provide one exact rendering per durable message")
  }
  const classified = input.messages.map(classifyV1ShadowMessage)
  const sources = classified.map((item, index) => {
    const source = input.sources[index]!
    if (item.messageID !== source.messageID) throw new Error("V1 shadow source/message order mismatch")
    if (!source.revision) throw new Error("V1 shadow requires an authoritative source revision")
    if (item.reprojectFromOwner) {
      throw new Error("STATE-shaped V1 context must be reprojected by its authoritative owner")
    }
    return {
      id: item.messageID,
      raw: source.renderedText,
      revision: source.revision,
      privileged: false,
      required: item.mustStayRaw,
    }
  })
  return buildShadowProjection(sources, input.choices, input.maxCharacters)
}

export * as LaceShadowV1 from "./lace-shadow-v1"
