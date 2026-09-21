export * as OfxpInvocationSchema from "./schema"

import { Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OfxpInvocation.NotFoundError", {
  invocationID: Ofxp.InvocationID,
}) {
  override get message() {
    return `OFXP invocation receipt not found: ${this.invocationID}`
  }
}

export class CollisionError extends Schema.TaggedErrorClass<CollisionError>()("OfxpInvocation.CollisionError", {
  invocationID: Ofxp.InvocationID,
  reason: Schema.String,
}) {
  override get message() {
    return `OFXP invocation ${this.invocationID} conflicts with an existing receipt: ${this.reason}`
  }
}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "OfxpInvocation.InvalidTransitionError",
  {
    invocationID: Ofxp.InvocationID,
    from: Ofxp.ReceiptState,
    to: Ofxp.ReceiptState,
  },
) {
  override get message() {
    return `OFXP invocation ${this.invocationID} cannot transition from ${this.from} to ${this.to}`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("OfxpInvocation.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `OFXP invocation receipt rejected: ${this.reason}`
  }
}

export type Error = NotFoundError | CollisionError | InvalidTransitionError | ValidationError

