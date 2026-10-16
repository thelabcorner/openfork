export * as SwarmAX from "./ax-projection"

import type { SwarmCommand } from "./command"

/**
 * Provider-facing creation receipt, not a complete aggregate dump.
 * Call the scoped swarm.get action if the agent needs full durable details.
 */
export function creation(
  created: SwarmCommand.DelegateResult & {
    admission: {
      acceptedMembers: readonly string[]
      acceptedTasks: readonly string[]
      failures: readonly SwarmCommand.AdmissionFailure[]
      complete: boolean
    }
  },
) {
  return {
    outcome: created.admission.complete ? "applied" : "partial",
    durableSwarm: {
      id: created.swarm.id,
      name: created.swarm.name,
      status: created.swarm.status,
      coordinatorMemberId: created.coordinator.id,
    },
    admission: created.admission,
    members: created.members.map((member) => ({
      name: member.name, memberId: member.id, lifecycle: member.lifecycle,
    })),
    tasks: created.tasks.map((task, index) => ({
      key: created.admission.acceptedTasks[index],
      title: task.title, taskId: task.id, status: task.status,
    })),
    execution: "Swarm and members/tasks are persisted; worker Sessions and task execution have NOT been verified as running.",
    verification: {
      tool: "swarm", action: "get", swarmId: created.swarm.id,
      note: "Use summary for a bounded overview, get for member bindings/tasks, and task.runs to verify actual execution.",
    },
    next: {
      addWorkers: { tool: "swarm", action: "member.batch", swarmId: created.swarm.id },
      addTasks: { tool: "swarm", action: "task.batch", swarmId: created.swarm.id },
      retry: "Inspect the durable Swarm before repeating a call after an unknown outcome; retry only failed or missing entries.",
    },
  }
}
