export * as GoalSchema from "./schema"

import { Schema } from "effect"
import { Goal } from "@opencode-ai/schema/goal"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Goal.NotFoundError", {
  goalID: Goal.ID,
}) {
  override get message() {
    return `Goal not found: ${this.goalID}`
  }
}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()("Goal.StaleRevisionError", {
  goalID: Goal.ID,
  expectedRevision: Schema.Number,
  actualRevision: Schema.Number,
}) {
  override get message() {
    return `Goal ${this.goalID} changed concurrently (expected revision ${this.expectedRevision}, current revision ${this.actualRevision}).`
  }
}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "Goal.InvalidTransitionError",
  {
    goalID: Goal.ID,
    status: Goal.Status,
    action: Schema.String,
  },
) {
  override get message() {
    return `Goal ${this.goalID} cannot apply ${this.action} while ${this.status}.`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("Goal.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Goal operation rejected: ${this.reason}`
  }
}

export type Error = NotFoundError | StaleRevisionError | InvalidTransitionError | ValidationError
