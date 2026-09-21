import type { Swarm } from "@opencode-ai/schema/swarm"

const transitions = {
  pending: new Set<Swarm.TaskStatus>(["blocked", "ready", "cancelled"]),
  blocked: new Set<Swarm.TaskStatus>(["ready", "failed", "cancelled"]),
  ready: new Set<Swarm.TaskStatus>(["working", "blocked", "cancelled"]),
  working: new Set<Swarm.TaskStatus>(["ready", "review_pending", "completed", "failed", "cancelled"]),
  review_pending: new Set<Swarm.TaskStatus>(["changes_requested", "completed", "failed", "cancelled"]),
  changes_requested: new Set<Swarm.TaskStatus>(["ready", "working", "cancelled"]),
  completed: new Set<Swarm.TaskStatus>(),
  failed: new Set<Swarm.TaskStatus>(["ready"]),
  cancelled: new Set<Swarm.TaskStatus>(),
} satisfies Record<Swarm.TaskStatus, ReadonlySet<Swarm.TaskStatus>>

export function canTransitionTask(from: Swarm.TaskStatus, to: Swarm.TaskStatus) {
  return from === to || transitions[from].has(to)
}

export function isTaskTerminal(status: Swarm.TaskStatus) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/**
 * Only an explicit semantic task failure consumes the semantic retry budget.
 * Provider/session/permission/recovery churn is operational, not task failure.
 */
export function semanticRetryConsumesBudget(kind: Swarm.TaskFailureKind) {
  return kind === "semantic"
}
