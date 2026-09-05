import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Schema } from "effect"

const encode = Schema.encodeUnknownSync(OpenCodeEvent)
// Published payloads are immutable and shared by all subscribers. Weak keys let
// frames disappear with their events; there is no process-wide retained history
// or ID collision between different payload representations.
const frames = new WeakMap<object, string>()

export function serializeEvent(event: object): string {
  const cached = frames.get(event)
  if (cached !== undefined) return cached
  // `server.stream.gap` is a transport control frame emitted when a replay
  // cursor falls outside the bounded ring. It deliberately is not a domain
  // event in OpenCodeEvent, but it must still be serializable so recovery can
  // reach the client instead of failing inside the serializer.
  const type = (event as { type?: unknown }).type
  const frame = JSON.stringify(type === "server.stream.gap" ? event : encode(event))
  frames.set(event, frame)
  return frame
}
