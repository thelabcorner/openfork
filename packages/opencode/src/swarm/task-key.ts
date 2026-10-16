export * as SwarmTaskKey from "./task-key"

import { createHash } from "node:crypto"
import { Swarm } from "@opencode-ai/schema/swarm"

/**
 * Stable task identity scoped to one Swarm, independent of call/stage boundaries.
 * Domain separation prevents an unrelated SHA-256 use from aliasing these IDs.
 */
export function id(swarmID: Swarm.ID, key: string): Swarm.TaskID {
  const digest = createHash("sha256")
    .update("openfork.swarm.task.batch.v1\0")
    .update(swarmID)
    .update("\0")
    .update(key.trim())
    .digest("hex")
  return Swarm.TaskID.make("swt_b_" + digest.slice(0, 40))
}
