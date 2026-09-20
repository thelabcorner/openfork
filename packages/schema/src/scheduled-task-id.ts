import { Schema } from "effect"
import { descending } from "./identifier"
import { statics } from "./schema"

export const ScheduledTaskID = Schema.String.check(Schema.isStartsWith("stk_")).pipe(
  Schema.brand("ScheduledTaskID"),
  statics((schema) => {
    const create = () => schema.make("stk_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ScheduledTaskID = typeof ScheduledTaskID.Type

export const ScheduledTaskRunID = Schema.String.check(Schema.isStartsWith("str_")).pipe(
  Schema.brand("ScheduledTaskRunID"),
  statics((schema) => {
    const create = () => schema.make("str_" + descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ScheduledTaskRunID = typeof ScheduledTaskRunID.Type
