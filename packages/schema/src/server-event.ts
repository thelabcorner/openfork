export * as ServerEvent from "./server-event"

import { Schema } from "effect"
import { Event } from "./event"

export const Connected = Event.define({ type: "server.connected", schema: {} })
export const Disposed = Event.define({ type: "global.disposed", schema: {} })
export const ProviderCatalogUpdated = Event.define({
  type: "provider.catalog.updated",
  schema: {
    directory: Schema.optional(Schema.String),
    revision: Schema.Int,
    status: Schema.Literals(["pending", "partial", "ready"]),
  },
})

/** A client should refresh its location-scoped pending Permission/Question snapshots. */
export const PendingResponseStateInvalidated = Event.define({
  type: "server.pending-response-state-invalidated",
  schema: { all: Schema.optional(Schema.Boolean) },
})

export const Definitions = Event.inventory(Connected, Disposed, ProviderCatalogUpdated, PendingResponseStateInvalidated)
