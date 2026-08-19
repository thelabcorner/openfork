export * as SessionGroup from "./session-group"

import { Schema } from "effect"
import { DateTimeUtcFromMillis } from "./schema"
import { SessionGroupID } from "./session-group-id"

export const ID = SessionGroupID
export type ID = SessionGroupID

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  position: Schema.Number,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SessionGroup.Info" })
