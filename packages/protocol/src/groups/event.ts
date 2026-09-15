import { Event } from "@opencode-ai/schema/event"
import { EventManifest } from "@opencode-ai/schema/event-manifest"
import { Location } from "@opencode-ai/schema/location"
import type { Definition } from "@opencode-ai/schema/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const fields = {
  id: Event.ID,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  durable: Schema.optional(Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
  location: Schema.optional(Location.Ref),
}

const transportControls = [
  {
    type: "server.connected",
    schema: Schema.Struct({
      ...fields,
      type: Schema.Literal("server.connected"),
      // Native SSE includes the replay epoch so a client can identify the cursor
      // generation even on a resumed connection whose control frame has no `id:`.
      // Keep it optional for compatibility with older servers that emitted `{}`.
      data: Schema.Struct({ epoch: Schema.optional(Schema.String) }),
    }).annotate({ identifier: "V2Event.server.connected" }),
  },
  {
    type: "server.heartbeat",
    schema: Schema.Struct({
      ...fields,
      type: Schema.Literal("server.heartbeat"),
      data: Schema.Struct({}),
    }).annotate({ identifier: "V2Event.server.heartbeat" }),
  },
  {
    type: "server.stream.gap",
    schema: Schema.Struct({
      ...fields,
      type: Schema.Literal("server.stream.gap"),
      data: Schema.Struct({
        requested: Schema.Int,
        oldest: Schema.optional(Schema.Int),
        latest: Schema.Int,
      }),
    }).annotate({ identifier: "V2Event.server.stream.gap" }),
  },
  {
    type: "server.stream.session-stale",
    schema: Schema.Struct({
      ...fields,
      type: Schema.Literal("server.stream.session-stale"),
      data: Schema.Struct({ sessionID: Schema.String }),
    }).annotate({ identifier: "V2Event.server.stream.session-stale" }),
  },
  {
    type: "server.stream.progress",
    schema: Schema.Struct({
      ...fields,
      type: Schema.Literal("server.stream.progress"),
      // This control frame is the intentional exception to the usual
      // sequence-free control rule: the SSE `id:` acknowledges reconstructible
      // content deliberately suppressed for this subscriber. `latest` mirrors
      // that cursor for diagnostics; it is not durable domain state.
      data: Schema.Struct({ latest: Schema.Int }),
    }).annotate({ identifier: "V2Event.server.stream.progress" }),
  },
] as const

const transportControlTypes = new Set(transportControls.map((control) => control.type as string))

const withoutTransportControls = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  definitions.filter((definition) => !transportControlTypes.has(definition.type)) as Array<Definitions[number]>

const schema = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  return Schema.Union([
    // Transport controls are wire contracts, not ordinary manifest domain
    // events. Prefer their explicit schemas when a manifest definition shares
    // the same type (notably server.connected, whose native control carries the
    // replay epoch). Otherwise codegen can silently erase transport-only fields.
    ...withoutTransportControls(definitions),
    ...transportControls.map((control) => control.schema),
  ]).annotate({ identifier: "V2Event" })
}

const make = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) => {
  const EventSchema = schema(definitions)
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.event.subscribe",
            summary: "Subscribe to events",
            description: "Subscribe to native event payloads for the server.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "events", description: "Experimental event stream route." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) =>
  make(definitions).group

const event = make(EventManifest.ServerDefinitions)
export const EventGroup = event.group
export const OpenCodeEvent = event.schema
export type OpenCodeEvent = typeof OpenCodeEvent.Type
export type OpenCodeEventEncoded = typeof OpenCodeEvent.Encoded
