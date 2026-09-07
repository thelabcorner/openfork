import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

export const GoalID = Schema.String.check(Schema.isStartsWith("gol_")).pipe(
  Schema.brand("GoalID"),
  statics((schema) => {
    const create = () => schema.make("gol_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type GoalID = typeof GoalID.Type
