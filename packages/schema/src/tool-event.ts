export * as ToolEvent from "./tool-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

export const Reloaded = Event.define({
  type: "tool.reloaded",
  schema: {
    added: Schema.Array(Schema.String),
    updated: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
    error: Schema.String.pipe(optional),
  },
})

export const Definitions = Event.inventory(Reloaded)
