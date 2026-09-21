export * as SwarmSchema from "./schema"

import { Schema } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"

export const Entity = Schema.Literals([
  "swarm",
  "member",
  "task",
  "task_run",
  "message",
  "delivery",
  "blackboard",
  "claim",
  "deliverable",
]).annotate({ identifier: "SwarmCore.Entity" })
export type Entity = typeof Entity.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Swarm.NotFoundError", {
  entity: Entity,
  id: Schema.String,
}) {
  override get message() {
    return `Swarm ${this.entity} not found: ${this.id}`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("Swarm.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Swarm operation rejected: ${this.reason}`
  }
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Swarm.ConflictError", {
  code: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()("Swarm.StaleRevisionError", {
  swarmID: Swarm.ID,
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
}) {
  override get message() {
    return `Swarm ${this.swarmID} changed concurrently (expected revision ${this.expectedRevision}, current revision ${this.actualRevision}).`
  }
}

export const FenceKind = Schema.Literals(["member_binding", "task_lease", "delivery_claim", "claim"]).annotate({
  identifier: "SwarmCore.FenceKind",
})
export type FenceKind = typeof FenceKind.Type

export class StaleFenceError extends Schema.TaggedErrorClass<StaleFenceError>()("Swarm.StaleFenceError", {
  fence: FenceKind,
  id: Schema.String,
  expectedGeneration: Schema.Int,
  actualGeneration: Schema.Int,
}) {
  override get message() {
    return `Stale ${this.fence} fence for ${this.id}: expected generation ${this.expectedGeneration}, current generation ${this.actualGeneration}.`
  }
}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "Swarm.InvalidTransitionError",
  {
    entity: Schema.Literals(["swarm", "member", "task", "delivery"]),
    id: Schema.String,
    from: Schema.String,
    to: Schema.String,
  },
) {
  override get message() {
    return `${this.entity} ${this.id} cannot transition from ${this.from} to ${this.to}.`
  }
}

export type Error =
  | NotFoundError
  | ValidationError
  | ConflictError
  | StaleRevisionError
  | StaleFenceError
  | InvalidTransitionError
