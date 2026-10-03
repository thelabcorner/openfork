import type { Swarm } from "@opencode-ai/schema/swarm"

const transitions = {
  pending: new Set<Swarm.TaskStatus>(["blocked", "ready", "cancelled"]),
  blocked: new Set<Swarm.TaskStatus>(["ready", "failed", "cancelled"]),
  ready: new Set<Swarm.TaskStatus>(["working", "blocked", "cancelled"]),
  working: new Set<Swarm.TaskStatus>(["ready", "review_pending", "completed", "failed", "cancelled"]),
  review_pending: new Set<Swarm.TaskStatus>(["ready", "changes_requested", "completed", "failed", "cancelled"]),
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

/**
 * Review loop contract (lifecycle-owned, enforced by `Swarm.reviewTask`).
 *
 * `working -> review_pending` is reachable through the host-observed
 * `unsettled` settlement: an execution ended without a semantic decision, so
 * neither success nor failure may be inferred. `review_pending` is
 * deliberately non-dispatchable.
 *
 * Exactly one operation may move a task out of it, and only a live Swarm
 * member may call it:
 *
 * - `accept`          -> `completed`          (terminal; promotes dependents)
 * - `request_changes` -> `changes_requested`  (non-dispatchable; awaits retry)
 * - `retry`           -> `ready`              (the deliberate redispatch decision)
 * - `fail`            -> `failed`
 * - `cancel`          -> `cancelled`
 *
 * `request_changes` and then `retry` is the two-step shape, so
 * `changes_requested` has exactly the single exit it already declared. A
 * reviewer cannot skip straight to `working` from either review state, so
 * already-produced work can never be replayed without one explicit decision.
 *
 * `failed -> ready` remains reachable only through `settleTask` with a
 * non-semantic failure kind. A semantic failure therefore still requires an
 * explicit operator retry; that path is recovery/operator-owned, not here.
 */
