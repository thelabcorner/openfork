import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

export const SwarmID = Schema.String.check(Schema.isStartsWith("swr_")).pipe(
  Schema.brand("SwarmID"),
  statics((schema) => {
    const create = () => schema.make("swr_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type SwarmID = typeof SwarmID.Type
