import type { Swarm } from "@opencode-ai/schema/swarm"

export interface DependencyEdge {
  readonly taskID: Swarm.TaskID
  readonly dependsOnTaskID: Swarm.TaskID
  readonly requirement: Swarm.DependencyRequirement
}

export type GraphValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "self_dependency"; readonly taskID: Swarm.TaskID }
  | {
      readonly ok: false
      readonly reason: "missing_task"
      readonly taskID: Swarm.TaskID
      readonly missingTaskID: Swarm.TaskID
    }
  | { readonly ok: false; readonly reason: "cycle"; readonly cycle: readonly Swarm.TaskID[] }

/**
 * O(V + E), allocation-bounded cycle validation. The explicit frame stack
 * avoids recursive DFS stack overflow on generated/large DAGs.
 */
export function validateDependencyGraph(
  taskIDs: readonly Swarm.TaskID[],
  dependencies: readonly DependencyEdge[],
): GraphValidation {
  const known = new Set(taskIDs)
  const adjacency = new Map<Swarm.TaskID, Swarm.TaskID[]>()
  for (const taskID of taskIDs) adjacency.set(taskID, [])

  for (const dependency of dependencies) {
    if (dependency.taskID === dependency.dependsOnTaskID)
      return { ok: false, reason: "self_dependency", taskID: dependency.taskID }
    if (!known.has(dependency.taskID))
      return {
        ok: false,
        reason: "missing_task",
        taskID: dependency.taskID,
        missingTaskID: dependency.taskID,
      }
    if (!known.has(dependency.dependsOnTaskID))
      return {
        ok: false,
        reason: "missing_task",
        taskID: dependency.taskID,
        missingTaskID: dependency.dependsOnTaskID,
      }
    adjacency.get(dependency.taskID)!.push(dependency.dependsOnTaskID)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<Swarm.TaskID, 0 | 1 | 2>()
  const stackIndex = new Map<Swarm.TaskID, number>()
  type Frame = { node: Swarm.TaskID; next: number }

  for (const root of taskIDs) {
    if ((color.get(root) ?? WHITE) !== WHITE) continue
    const stack: Frame[] = [{ node: root, next: 0 }]
    color.set(root, GRAY)
    stackIndex.set(root, 0)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const neighbors = adjacency.get(frame.node)!
      if (frame.next >= neighbors.length) {
        color.set(frame.node, BLACK)
        stackIndex.delete(frame.node)
        stack.pop()
        continue
      }

      const next = neighbors[frame.next]!
      frame.next++
      const state = color.get(next) ?? WHITE
      if (state === GRAY) {
        const start = stackIndex.get(next)!
        return { ok: false, reason: "cycle", cycle: stack.slice(start).map((item) => item.node) }
      }
      if (state === BLACK) continue
      color.set(next, GRAY)
      stackIndex.set(next, stack.length)
      stack.push({ node: next, next: 0 })
    }
  }

  return { ok: true }
}

const TERMINAL = new Set<Swarm.TaskStatus>(["completed", "failed", "cancelled"])
const READINESS_OWNED = new Set<Swarm.TaskStatus>(["pending", "blocked", "ready"])

export function dependencySatisfied(requirement: Swarm.DependencyRequirement, prerequisite: Swarm.TaskStatus) {
  return requirement === "require_success" ? prerequisite === "completed" : TERMINAL.has(prerequisite)
}

/**
 * Recompute only the scheduler-owned readiness projection. Active/review/
 * terminal states are preserved verbatim.
 */
export function readinessStatus(
  current: Swarm.TaskStatus,
  prerequisites: readonly {
    readonly requirement: Swarm.DependencyRequirement
    readonly status: Swarm.TaskStatus
  }[],
): Swarm.TaskStatus {
  if (!READINESS_OWNED.has(current)) return current
  if (prerequisites.length === 0) return "ready"
  return prerequisites.every((item) => dependencySatisfied(item.requirement, item.status)) ? "ready" : "blocked"
}

const GENERIC_WORDS = new Set([
  "task",
  "the",
  "and",
  "swarm",
  "feature",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "work",
  "member",
  "role",
  "team",
  "using",
])

function tokens(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !GENERIC_WORDS.has(token))
}

function escapeRegExp(value: string) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

/**
 * Deterministic low-authority tie-break only. A verbatim member name is strong;
 * otherwise require >=2 significant shared tokens to avoid incidental matches.
 */
export function affinityScore(name: string, role: string, taskText: string) {
  const lower = taskText.toLowerCase()
  const phrase = name.toLowerCase().trim()
  if (phrase.length >= 3 && new RegExp("(^|[^a-z0-9])" + escapeRegExp(phrase) + "($|[^a-z0-9])").test(lower)) return 100

  const taskTokens = new Set(tokens(lower))
  const common = new Set<string>()
  let roleCommon = 0
  for (const token of tokens(name)) if (taskTokens.has(token)) common.add(token)
  for (const token of tokens(role)) {
    if (!taskTokens.has(token)) continue
    common.add(token)
    roleCommon++
  }
  if (common.size < 2) return 0
  return common.size * 4 + roleCommon * 2
}

export function rankCandidates(
  task: Pick<Swarm.Task, "title" | "description" | "reservedMemberID">,
  members: readonly Pick<Swarm.Member, "id" | "name" | "role" | "lifecycle">[],
) {
  const text = task.description ? task.title + "\n" + task.description : task.title
  return members
    .filter((member) => member.lifecycle === "active")
    .map((member) => ({
      member,
      reserved: member.id === task.reservedMemberID,
      affinity: affinityScore(member.name, member.role, text),
    }))
    .sort(
      (a, b) =>
        Number(b.reserved) - Number(a.reserved) ||
        b.affinity - a.affinity ||
        a.member.name.localeCompare(b.member.name) ||
        a.member.id.localeCompare(b.member.id),
    )
    .map((item) => item.member)
}
