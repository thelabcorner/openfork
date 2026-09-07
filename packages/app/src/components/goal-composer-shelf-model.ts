export type GoalLifecycleStatus =
  | "draft"
  | "active"
  | "paused"
  | "blocked"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"

export type GoalLifecycleAction = "start" | "pause" | "resume"

export function isGoalTerminal(status: GoalLifecycleStatus | string) {
  return status === "completed" || status === "cancelled" || status === "failed"
}

export function goalLifecycleAction(status: GoalLifecycleStatus | string): GoalLifecycleAction | undefined {
  if (status === "draft") return "start"
  if (status === "active") return "pause"
  if (status === "paused" || status === "blocked") return "resume"
  return undefined
}

export function goalProgress(input: {
  criteria: ReadonlyArray<{ status: string }>
  steps: ReadonlyArray<{ status: string }>
}) {
  const criteriaDone = input.criteria.reduce((count, item) => count + (item.status === "passed" ? 1 : 0), 0)
  const stepsDone = input.steps.reduce((count, item) => count + (item.status === "completed" ? 1 : 0), 0)
  const total = input.criteria.length + input.steps.length
  const done = criteriaDone + stepsDone
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

export function formatGoalElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}
