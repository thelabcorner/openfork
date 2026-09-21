export type SwarmPanelInvalidation = "core" | "memory" | "history"

export function swarmPanelEventInvalidations(type: string): ReadonlySet<SwarmPanelInvalidation> {
  const result = new Set<SwarmPanelInvalidation>()
  if (
    type === "swarm.updated" ||
    type === "swarm.member.updated" ||
    type === "swarm.task.updated" ||
    type === "swarm.task.dependencies.updated" ||
    type === "swarm.task.lease.updated" ||
    type === "swarm.task.run.updated" ||
    type === "swarm.message.created" ||
    type === "swarm.delivery.updated"
  ) {
    result.add("core")
  }
  if (
    type === "swarm.blackboard.updated" ||
    type === "swarm.claim.updated" ||
    type === "swarm.deliverable.updated"
  ) {
    result.add("memory")
  }
  if (
    type === "swarm.message.created" ||
    type === "swarm.delivery.updated" ||
    type === "swarm.task.run.updated"
  ) {
    result.add("history")
  }
  return result
}
