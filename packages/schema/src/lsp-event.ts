export * as LspEvent from "./lsp-event"

import { Event } from "./event"
import { Schema } from "effect"

export const Updated = Event.define({
  type: "lsp.updated",
  schema: {
    servers: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        root: Schema.String,
        status: Schema.Literal("connected"),
      }),
    ),
  },
})

export const Definitions = Event.inventory(Updated)
