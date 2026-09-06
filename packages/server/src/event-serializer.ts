import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import type { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"

const encode = Schema.encodeUnknownSync(OpenCodeEvent)
// Published payloads are immutable and shared by all subscribers. Weak keys let
// frames disappear with their events; there is no process-wide retained history
// or ID collision between different payload representations.
const frames = new WeakMap<object, string>()
const wire = new WeakMap<object, WireEvent>()

export type WireEvent = { id: string; type: string; data: unknown }

/**
 * Wire projection for one published payload, cached against its identity.
 *
 * Every subscriber used to build its own `{ id, type, data }` literal, so this
 * WeakMap keyed on object identity could never hit and each subscriber paid a
 * full `Schema.encodeUnknownSync` walk. Caching the projection against the
 * shared payload identity means the first subscriber encodes and the rest
 * reuse the frame -- the same treatment the legacy route gets from
 * `adaptLegacyEvent`.
 */
export function wireEvent(event: EventV2.Payload): WireEvent {
  const cached = wire.get(event)
  if (cached !== undefined) return cached
  const value = { id: event.id, type: event.type, data: event.data }
  wire.set(event, value)
  return value
}

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
