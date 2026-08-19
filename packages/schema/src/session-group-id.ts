import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

export const SessionGroupID = Schema.String.check(Schema.isStartsWith("grp")).pipe(
  Schema.brand("SessionGroupID"),
  statics((schema) => {
    const create = () => schema.make("grp_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type SessionGroupID = typeof SessionGroupID.Type
