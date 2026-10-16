export * as SwarmCreationKey from "./creation-key"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import type { DelegateInput } from "./command"

/** Reject malformed retry keys at the provider schema boundary, before grants or I/O. */
export const Input = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
)

/**
 * Idempotent *admission identity*, not a replay-success receipt.
 *
 * A repeated requestKey under the same trusted coordinator principal cannot
 * create a second Swarm, even after response loss or a process crash. The
 * second attempt raises Core ConflictError containing the exact Swarm ID;
 * callers must inspect durable state before inferring task completion.
 *
 * The key does not authorize reads or writes; those remain scoped by native
 * Session membership or OXP's connector-owned coordinator checks.
 */
export type Scope = Pick<DelegateInput, "requestKey" | "projectID" | "workspaceID" | "directory" | "coordinatorSessionID" | "coordinatorCapabilities">

export function id(input: Scope): SwarmModel.ID | undefined {
  if (input.requestKey === undefined) return undefined
  const principal = input.coordinatorSessionID
    ? "session:" + input.coordinatorSessionID
    : input.coordinatorCapabilities?.tags?.find((tag) => tag.startsWith("oxp:connector:"))
  if (!principal) throw new Error("requestKey requires a trusted coordinator Session or connector-owned principal")
  const digest = createHash("sha256")
    .update("openfork.swarm.creation.v1\u0000")
    .update(JSON.stringify([
      input.projectID,
      input.workspaceID ?? null,
      input.directory.replaceAll("\\", "/"),
      principal,
      input.requestKey,
    ]))
    .digest("hex")
    .slice(0, 40)
  return SwarmModel.ID.make("swr_k_" + digest)
}

/**
 * Read-only reconciliation after an ambiguous initial-creation result.
 *
 * Do not replay a multi-step creation simply because its tool reply was lost.
 * Return what is *durably observed* (including an abandoned "creating" row),
 * without manufacturing a success receipt or a second Swarm.
 *
 * The adapter MUST derive the caller identity, root/project/workspace, and
 * permission from its authenticated execution context, never agent arguments.
 */
export const lookup = Effect.fn("SwarmCreationKey.lookup")(function* (
  service: SwarmV2.Interface,
  input: Scope,
) {
  if (input.requestKey === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.requestKey))
    return yield* new SwarmV2.SwarmSchema.ValidationError({
      reason: "creation.lookup requires a valid requestKey (1-128 ASCII letters/digits/._:-).",
    })
  const swarmID = id(input)!
  const detail = yield* service.get(swarmID).pipe(
    Effect.catchTag("Swarm.NotFoundError", () => Effect.succeed(undefined)),
  )
  if (!detail) return {
    found: false as const,
    swarmId: swarmID,
    nextAction: "No Swarm exists under this scoped key. You may retry initial creation with the same requestKey; only the actual creation tool can write.",
  }
  // Defensive second-scope check in addition to the scoped identity hash.
  if (detail.swarm.projectID !== input.projectID ||
    detail.swarm.workspaceID !== input.workspaceID ||
    detail.swarm.directory.replaceAll("\\", "/") !== input.directory.replaceAll("\\", "/"))
    return yield* new SwarmV2.SwarmSchema.ConflictError({
      code: "swarm.creation_scope_mismatch",
      reason: "A creation key resolved outside this trusted project/workspace/directory scope.",
    })
  const status = detail.swarm.status
  return {
    found: true as const,
    swarmId: swarmID,
    name: detail.swarm.name,
    status,
    revision: detail.swarm.revision,
    coordinatorRecorded: !!detail.swarm.coordinatorMemberID,
    managedMembers: detail.members.filter((member) => member.kind === "managed_worker").length,
    taskCounts: {
      total: detail.tasks.length,
      ready: detail.tasks.filter((task) => task.status === "ready").length,
      blocked: detail.tasks.filter((task) => task.status === "blocked").length,
    },
    setup: status === "creating" ? "incomplete" as const : "durable" as const,
    execution: "Worker Sessions, task runs, success and acceptance are NOT verified by this lookup." as const,
    nextAction: status === "creating"
      ? "Creation is incomplete. Inspect this Swarm and run the existing abandoned-creating recovery path; do NOT create another Swarm with a different key."
      : "Use swarm.get or swarm.summary for current state, and task.runs to verify actual execution. Never infer original requested intent from these counts.",
  }
})
