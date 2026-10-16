import type { SessionMessage } from "@opencode-ai/schema/session-message"

/**
 * Kept in the response contract for older clients. Timeline projections no
 * longer crop content, so new responses always return an empty list.
 */
export interface WindowedMessage {
  readonly messageID: SessionMessage.ID
  readonly omittedContentItems: number
  readonly truncatedStrings: number
}

export interface TimelineMessagePage {
  readonly data: SessionMessage.Message[]
  readonly windowed: WindowedMessage[]
  readonly bytes: number
}

/**
 * Compatibility projection for current API consumers. Message pagination is
 * performed by the owning Session service; this function must preserve every
 * message field and content item, even when a single page exceeds historical
 * transport targets. Transport limits may reject a response, but may never
 * silently rewrite session history.
 */
export function projectTimelineMessagePage(
  messages: readonly SessionMessage.Message[],
  _maxBytes?: number,
): TimelineMessagePage {
  const data = [...messages]
  return {
    data,
    windowed: [],
    bytes: Buffer.byteLength(JSON.stringify(data)),
  }
}
